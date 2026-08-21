/**
 * Cursor CLI (cursor-agent) Transcript Reader
 *
 * Reads one cursor-agent conversation from its plaintext JSONL
 * (~/.cursor/projects/<enc>/agent-transcripts/<uuid>/<uuid>.jsonl). Line shapes
 * (verified live — JOLLI-2023):
 *   { role: "user"|"assistant", message: { content: [{ type: "text"|"tool_use", text? }] } }
 *   { type, status }   ← control lines (turn_ended, …) — skipped
 * Role map: user→human, assistant→assistant. Only `text` parts contribute
 * content; `tool_use` parts are dropped (a pure tool-call turn yields no entry,
 * matching the empty-content skip in Devin/Codex readers).
 *
 * The stream is linear + append-only, so the cursor is a plain `lineNumber`
 * (no anchorId). JSONL lines carry no structured timestamp field, but every USER
 * turn embeds a `<timestamp>` tag (human-readable, minute-resolution). We parse it
 * to honor QueueWorker's per-commit `beforeTimestamp` cutoff: a user turn stamped
 * after the cutoff (and everything after it) is deferred to the next commit rather
 * than folded into this one. Assistant/control lines have no stamp and are
 * conservatively kept with the preceding user turn's window (mirrors TranscriptReader).
 *
 * The cursor advances only to the last line we actually consumed — never past a
 * deferred (post-cutoff) turn, and never past a trailing line that failed to parse
 * (a mid-write partial tail), so both are re-read on the next pass instead of being
 * silently dropped.
 */

import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { CURSOR_TIMESTAMP_STRIP_RE, cursorTurnTimestampMs } from "./CursorTurnTimestamp.js";
import { classifyCursorToolName, ToolUseTally } from "./ToolNameClassify.js";
import { mergeConsecutiveEntries, throwTranscriptReadError } from "./TranscriptReader.js";

const log = createLogger("CursorCliReader");

interface CursorCliPart {
	readonly type?: string;
	readonly text?: unknown;
	/**
	 * Anthropic-block `tool_use` fields — present only on `type:"tool_use"` parts.
	 *
	 * `id` is declared because the block format has the field, but Cursor does not
	 * write it: across 10 real transcripts every `tool_use` part's keys were exactly
	 * `['input','name','type']`. It is kept (rather than removed) so a build that
	 * starts emitting one is de-duplicated instead of double-counted — see the call
	 * site, which passes `undefined` today and must keep tolerating that.
	 */
	readonly id?: unknown;
	readonly name?: unknown;
	/** Tool arguments. Carries the MCP server/tool identity — see `classifyCursorToolName`. */
	readonly input?: unknown;
}
interface CursorCliLine {
	readonly role?: string;
	readonly message?: { readonly content?: ReadonlyArray<CursorCliPart> };
}

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

function unwrapUser(text: string): string {
	const stripped = text.replace(CURSOR_TIMESTAMP_STRIP_RE, "");
	const m = USER_QUERY_RE.exec(stripped);
	return (m ? m[1] : stripped).trim();
}

function extractText(line: CursorCliLine): string {
	const parts: string[] = [];
	for (const p of line.message?.content ?? []) {
		if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
	}
	return parts.join("\n").trim();
}

function mapRole(role: string | undefined): "human" | "assistant" | undefined {
	if (role === "user") return "human";
	if (role === "assistant") return "assistant";
	return undefined;
}

// The stamp parser moved to `CursorTurnTimestamp` when the skill scanner needed the
// same instant: a second copy would let a skill and the tool call beside it date
// from different times. `lineTimestampMs` is now a one-line adapter over it.
const lineTimestampMs = cursorTurnTimestampMs;

export async function readCursorCliTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	let raw: string;
	try {
		raw = await readFile(transcriptPath, "utf8");
	} catch (error: unknown) {
		throwTranscriptReadError(log, `Cannot read Cursor CLI transcript: ${transcriptPath}`, error);
	}

	// Drop blank lines BEFORE indexing (mirrors TranscriptReader.ts). Append-only
	// JSONL always ends with a trailing "\n", so a raw split leaves a phantom ""
	// segment; if the cursor counted it, the first line appended after a resume
	// would land in that slot and be skipped (silent data loss — see the
	// "boundary line" regression test). Filtering keeps `lineNumber` equal to the
	// count of real lines, so appends only ever extend the array.
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	const startLine = cursor?.lineNumber ?? 0;
	const cutoffMs = beforeTimestamp ? Date.parse(beforeTimestamp) : Number.NaN;
	const hasCutoff = !Number.isNaN(cutoffMs);
	const rawEntries: TranscriptEntry[] = [];
	const tally = new ToolUseTally();
	// Advances only across lines we actually consumed — so the cursor never moves
	// past a deferred (post-cutoff) turn or a trailing partial line (see below).
	let lastConsumed = Math.min(startLine, lines.length);
	/**
	 * The instant of the most recent USER turn seen in this slice — the clock every
	 * tool call in the turns that answer it is stamped with.
	 *
	 * Carried forward rather than read per line, because the stamp is not a record
	 * field: it is embedded in the user turn's TEXT, and `tool_use` blocks live in
	 * ASSISTANT turns, which carry none. Measured across 10 real transcripts: 12 of 12
	 * user turns parse a `<timestamp>`, 0 of 35 assistant turns do, and 0 of the 24
	 * lines carrying a `tool_use` do. So the per-line read this replaces could never
	 * stamp a single tool bucket — while `TOOL_CALL_TIME_SOURCES` had already been told
	 * this source passes one through, whose own docstring requires that to be true.
	 *
	 * The stream is strictly ordered (a user turn, then the assistant turns answering
	 * it), so the last user instant is the right clock for those calls — minute
	 * resolution, the same as the skill scanner reading the same tag.
	 *
	 * Starts UNDEFINED and stays so until a user turn is seen: a slice resumed from a
	 * cursor can open on assistant turns whose user turn is behind the mark, and this
	 * read genuinely does not know when they happened. Absence is the honest answer —
	 * consumers fall back to the session's own instant.
	 */
	let turnMs: number | undefined;

	for (let i = startLine; i < lines.length; i++) {
		const line = lines[i];
		let parsed: CursorCliLine;
		try {
			parsed = JSON.parse(line) as CursorCliLine;
		} catch {
			// A mid-stream corrupt line is skipped, but `lastConsumed` is NOT advanced
			// over it: a valid line *after* it carries the cursor forward, while a
			// trailing partial (mid-write) line — with nothing valid after — leaves the
			// cursor behind so the completed line is re-read next pass (no silent drop).
			continue;
		}
		// Read unconditionally, not just under `hasCutoff`: it is also the instant
		// stamped on each tool bucket below, and a cutoff-less read (the common
		// one) would otherwise leave every bucket timeless.
		const ts = lineTimestampMs(parsed);
		// This turn (and everything after it) was written after the commit's cutoff:
		// stop here and leave the cursor before it so the next commit picks it up.
		if (hasCutoff && ts !== undefined && ts > cutoffMs) break;
		// AFTER the cutoff check, so a deferred turn cannot leave its instant behind
		// for the next slice to stamp calls with.
		if (ts !== undefined) turnMs = ts;
		const role = mapRole(parsed.role);
		if (role !== undefined) {
			const text = extractText(parsed);
			const content = role === "human" ? unwrapUser(text) : text;
			if (content.length > 0) rawEntries.push({ role, content });
		}
		// The `tool_use` parts this reader drops from the CONTENT are still counted
		// here — a pure tool-call turn yields no entry but is real agent activity.
		//
		// Cursor uses the Anthropic BLOCK shape but not its NAMING: MCP calls arrive
		// as a generic `CallMcpTool` whose `input` carries `{server, toolName}`, and
		// no block carries an `id` at all (both measured across 10 real transcripts).
		// This comment used to assert the opposite of each — `mcp__<server>__<tool>`
		// names and a `toolu_…` dedupe key — so every MCP call was filed as a builtin
		// with its server discarded. `classifyCursorToolName` reads the real shape;
		// the absent id means `addOnce` counts unconditionally, which is right here
		// because Cursor writes one block per call.
		for (const p of parsed.message?.content ?? []) {
			if (p.type !== "tool_use" || typeof p.name !== "string" || p.name.length === 0) continue;
			tally.addOnce(typeof p.id === "string" ? p.id : undefined, {
				...classifyCursorToolName(p.name, p.input),
				...(turnMs !== undefined && { lastCallAtMs: turnMs }),
			});
		}
		lastConsumed = i + 1;
	}

	const entries = mergeConsecutiveEntries(rawEntries);
	const newCursor: TranscriptCursor = {
		transcriptPath,
		lineNumber: lastConsumed,
		updatedAt: new Date().toISOString(),
	};
	// Always present, even when empty — see TOOL_RECORDING_SOURCES.
	return { entries, newCursor, totalLinesRead: lastConsumed - startLine, toolUse: tally.values() };
}
