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
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

const log = createLogger("CursorCliReader");

interface CursorCliPart {
	readonly type?: string;
	readonly text?: unknown;
}
interface CursorCliLine {
	readonly role?: string;
	readonly message?: { readonly content?: ReadonlyArray<CursorCliPart> };
}

const TIMESTAMP_RE = /<timestamp>[\s\S]*?<\/timestamp>\s*/gi;
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

function unwrapUser(text: string): string {
	const stripped = text.replace(TIMESTAMP_RE, "");
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

const MONTHS: Record<string, number> = {
	Jan: 0,
	Feb: 1,
	Mar: 2,
	Apr: 3,
	May: 4,
	Jun: 5,
	Jul: 6,
	Aug: 7,
	Sep: 8,
	Oct: 9,
	Nov: 10,
	Dec: 11,
};
const TIMESTAMP_CAPTURE_RE = /<timestamp>([\s\S]*?)<\/timestamp>/i;
// cursor-agent stamps user turns like "Tuesday, Jul 21, 2026, 6:57 PM (UTC+8)":
// English 3-letter month, minute resolution, explicit UTC offset. Parsed with an
// explicit regex (not `new Date`, whose non-ISO parsing is implementation-defined)
// so a non-matching/localized stamp cleanly falls back to "no timestamp" rather
// than a wrong-but-valid date.
const TS_PARSE_RE = /([A-Za-z]{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2})\s*(AM|PM) \(UTC([+-]\d{1,2})(?::?(\d{2}))?\)/i;

/** Parse a cursor-agent `<timestamp>` tag body to epoch ms, or undefined if it doesn't match. */
function parseCursorCliTimestamp(raw: string): number | undefined {
	const m = TS_PARSE_RE.exec(raw);
	if (!m) return undefined;
	const month = MONTHS[m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()];
	if (month === undefined) return undefined;
	let hour = Number(m[4]) % 12;
	if (/pm/i.test(m[6])) hour += 12;
	const offsetHours = Number(m[7]);
	const offsetMinutes = m[8] ? Number(m[8]) : 0;
	const offsetTotal = offsetHours >= 0 ? offsetHours * 60 + offsetMinutes : offsetHours * 60 - offsetMinutes;
	return Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offsetTotal * 60000;
}

/** Epoch ms of a line's embedded timestamp, if any — only user turns carry one. */
function lineTimestampMs(line: CursorCliLine): number | undefined {
	if (line.role !== "user") return undefined;
	for (const p of line.message?.content ?? []) {
		if (p.type === "text" && typeof p.text === "string") {
			const m = TIMESTAMP_CAPTURE_RE.exec(p.text);
			if (m) return parseCursorCliTimestamp(m[1]);
		}
	}
	return undefined;
}

export async function readCursorCliTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	let raw: string;
	try {
		raw = await readFile(transcriptPath, "utf8");
	} catch (error: unknown) {
		log.error("Failed to read Cursor CLI transcript %s: %s", transcriptPath, (error as Error).message);
		const wrapped = new Error(`Cannot read Cursor CLI transcript: ${transcriptPath}`) as NodeJS.ErrnoException;
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code !== undefined) wrapped.code = code;
		throw wrapped;
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
	// Advances only across lines we actually consumed — so the cursor never moves
	// past a deferred (post-cutoff) turn or a trailing partial line (see below).
	let lastConsumed = Math.min(startLine, lines.length);

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
		if (hasCutoff) {
			const ts = lineTimestampMs(parsed);
			// This turn (and everything after it) was written after the commit's cutoff:
			// stop here and leave the cursor before it so the next commit picks it up.
			if (ts !== undefined && ts > cutoffMs) break;
		}
		const role = mapRole(parsed.role);
		if (role !== undefined) {
			const text = extractText(parsed);
			const content = role === "human" ? unwrapUser(text) : text;
			if (content.length > 0) rawEntries.push({ role, content });
		}
		lastConsumed = i + 1;
	}

	const entries = mergeConsecutiveEntries(rawEntries);
	const newCursor: TranscriptCursor = {
		transcriptPath,
		lineNumber: lastConsumed,
		updatedAt: new Date().toISOString(),
	};
	return { entries, newCursor, totalLinesRead: lastConsumed - startLine };
}
