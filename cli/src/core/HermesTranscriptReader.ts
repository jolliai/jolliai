/**
 * Hermes Agent Transcript Reader
 *
 * Reads one Hermes conversation (identified by a "<dbPath>#<sessionId>"
 * synthetic path) out of a global `state.db` and returns the canonical
 * conversation plus its tool calls.
 *
 * Hermes' `messages` table is LINEAR — one append-only row per turn, ordered by
 * an AUTOINCREMENT `id` — so there is no forest to walk (contrast Devin) and no
 * envelope to unwrap (contrast the JSONL sources). Each row is an OpenAI
 * chat-completions message: `role` / `content` / `tool_name` / `tool_call_id`,
 * with `tool_calls` holding the standard array
 * `[{id, call_id, type:"function", function:{name, arguments}}]` where
 * `arguments` is itself a JSON *string*. `timestamp` is epoch SECONDS as REAL,
 * present on EVERY row — which is what puts this source in
 * `TOOL_CALL_TIME_SOURCES`.
 *
 * ## Which rows are conversation, and the one that is not
 *
 * Two flags decide, and reading only `active` would be wrong in both directions
 * (`hermes_state.py`, `_soft_archive` / `compact`):
 *
 *   - `active = 1` — the live conversation.
 *   - `active = 0, compacted = 1` — turns a COMPACTION replaced. They are real
 *     history: Hermes archives rather than deletes them and inserts a summary
 *     row in their place. Dropping them would erase the first half of every
 *     long conversation the first time it is read.
 *   - `active = 0, compacted = 0` — turns the user REWOUND. The user explicitly
 *     undid them, which is the same claim Devin's alternate regeneration
 *     branches make, and its reader excludes those for the same reason.
 *
 * So the filter is `active = 1 OR compacted = 1`. Rows carrying
 * `_compressed_summary = 1` are the summary Hermes itself wrote and are kept —
 * they are what the model actually saw.
 *
 * `display_kind = "hidden"` needs no special case: it marks an EMPTY placeholder
 * (`conversation_loop.py` sets it on a content-less row), and the empty-content
 * skip below already drops those. Their `tool_calls` are still tallied, because
 * dropping a real call is worse than counting a placeholder.
 *
 * ## Resuming
 *
 * By content anchor (`messages.id` of the last consumed row), not by raw
 * position — a rewind removes rows from the middle of the filtered sequence, so
 * a positional resume would silently skip an equal number of later turns.
 * `lineNumber` remains as the fallback for a cursor written before an anchor
 * existed, and is clamped to the current length.
 *
 * @see file://./HermesSessionDiscoverer.ts for how a session is found and scoped.
 */

import { createLogger } from "../Logger.js";
import type { ToolCallCount, TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { withSqliteDb } from "./SqliteHelpers.js";
import { builtinTool, classifyHermesToolName, skillTool, ToolUseTally } from "./ToolNameClassify.js";
import { mergeConsecutiveEntries, throwTranscriptReadError } from "./TranscriptReader.js";

const log = createLogger("HermesReader");

/** Hermes' tool for entering a skill: `skill_view(name=…)`. */
const SKILL_TOOL_NAME = "skill_view";

interface MessageRow {
	readonly id: number;
	readonly role: string;
	readonly content: string | null;
	readonly tool_calls: string | null;
	readonly timestamp: number;
}

const ROLE_MAP: Readonly<Record<string, "human" | "assistant">> = {
	user: "human",
	assistant: "assistant",
};

/** Split "<dbPath>#<sessionId>" into its parts. */
function parseSyntheticPath(transcriptPath: string): { dbPath: string; sessionId: string } {
	const hash = transcriptPath.lastIndexOf("#");
	if (hash === -1) {
		throw new Error(`Invalid Hermes transcript path (expected "<dbPath>#<sessionId>"): ${transcriptPath}`);
	}
	return { dbPath: transcriptPath.slice(0, hash), sessionId: transcriptPath.slice(hash + 1) };
}

/**
 * One `tool_calls` entry's identity.
 *
 * Hermes names MCP tools `mcp__<server>__<tool>`, but the model never CALLS them
 * by that name: progressive tool disclosure routes every MCP / non-core plugin
 * tool through a `tool_call` bridge whose JSON-string arguments carry the real
 * one. {@link classifyHermesToolName} owns that unwrap — reading `function.name`
 * alone files every MCP call as `builtin:tool_call`, which reads as "this person
 * uses no MCP servers". Core tools are never deferred and arrive by their own
 * names, which the same helper passes straight through.
 *
 * `skill_view` is re-attributed to the SKILL it opened, matching the OpenCode
 * and Kimi readers: "which skills does this person use" is the question being
 * asked, and counting every invocation as one builtin named `skill_view`
 * answers nothing. The name lives in `function.arguments`, which is a JSON
 * STRING rather than an object — a call whose arguments do not parse, or which
 * names no skill, stays a builtin rather than being dropped.
 *
 * A bare `{name}` (no `function` wrapper) is accepted so a schema that flattens
 * the envelope still counts instead of silently reporting zero.
 */
function hermesToolCall(raw: unknown): { call: ToolCallCount; id: string | undefined } | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const tc = raw as {
		id?: unknown;
		call_id?: unknown;
		name?: unknown;
		function?: { name?: unknown; arguments?: unknown };
	};
	const name = typeof tc.function?.name === "string" ? tc.function.name : tc.name;
	if (typeof name !== "string" || name.length === 0) return undefined;
	const id = typeof tc.id === "string" ? tc.id : typeof tc.call_id === "string" ? tc.call_id : undefined;
	if (name !== SKILL_TOOL_NAME) return { call: classifyHermesToolName(name, tc.function?.arguments), id };
	const skill = parseSkillName(tc.function?.arguments);
	return { call: skill !== undefined ? skillTool(skill) : builtinTool(name), id };
}

/** The `name` argument of a `skill_view` call, from its JSON-string `arguments`. */
function parseSkillName(rawArgs: unknown): string | undefined {
	if (typeof rawArgs !== "string" || rawArgs.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawArgs);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const name = (parsed as { name?: unknown }).name;
	return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** Counts one row's `tool_calls` into `tally`, stamped with the row's own instant. */
function tallyRowToolCalls(tally: ToolUseTally, row: MessageRow): void {
	if (typeof row.tool_calls !== "string" || row.tool_calls.length === 0) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.tool_calls);
	} catch {
		log.debug("Skipping Hermes message %d: invalid tool_calls JSON", row.id);
		return;
	}
	if (!Array.isArray(parsed)) return;
	// Hermes' `messages.timestamp` is a REAL (float epoch SECONDS), so `* 1000`
	// gives a fractional millisecond. The pipeline's `lastCallAtMs` contract is
	// integer ms — the dashboard column is INTEGER, and `Math.max(a, b)` between
	// a stored integer and an incoming float carries the float — so a bare
	// multiplication reaches SQLite as "cannot store REAL value in INTEGER" and
	// `StatsWriter` fails its whole projection under a retry loop. No consumer
	// wants sub-ms precision (Kimi/Cursor/Claude all round similarly), so round
	// to the nearest ms here where the shape is known, rather than at each sink.
	const atMs = Number.isFinite(row.timestamp) ? Math.round(row.timestamp * 1000) : undefined;
	for (const entry of parsed) {
		const resolved = hermesToolCall(entry);
		if (resolved === undefined) continue;
		tally.addOnce(resolved.id, { ...resolved.call, ...(atMs !== undefined && { lastCallAtMs: atMs }) });
	}
}

/**
 * Where to resume, as an index into the freshly-read sequence.
 *
 * The anchor wins: it is the `messages.id` of the last row consumed, so it
 * survives a rewind that shortened the sequence. An anchor that is no longer
 * present has itself been rewound away, so the positional fallback is used —
 * clamped, because a shrunken sequence can be shorter than the recorded
 * position.
 */
function resolveStartIndex(rows: ReadonlyArray<MessageRow>, cursor?: TranscriptCursor | null): number {
	if (!cursor) return 0;
	if (cursor.anchorId !== undefined) {
		const anchor = Number.parseInt(cursor.anchorId, 10);
		if (Number.isFinite(anchor)) {
			const index = rows.findIndex((row) => row.id === anchor);
			if (index !== -1) return index + 1;
		}
	}
	return Math.min(cursor.lineNumber ?? 0, rows.length);
}

export async function readHermesTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const { dbPath, sessionId } = parseSyntheticPath(transcriptPath);
	const cutoffTime = beforeTimestamp ? Date.parse(beforeTimestamp) : undefined;
	const tally = new ToolUseTally();

	try {
		const { rawEntries, totalRows, startIndex, lastConsumedIndex, anchorId } = await withSqliteDb(dbPath, (db) => {
			const rows = db
				.prepare(
					// `active = 1 OR compacted = 1` — see the header for why reading
					// `active` alone loses a compacted conversation's first half.
					// Ordered by the AUTOINCREMENT id, which is insertion order and is
					// also the resume anchor.
					`SELECT id, role, content, tool_calls, timestamp
					 FROM messages
					 WHERE session_id = :sessionId
					   AND (active = 1 OR compacted = 1)
					 ORDER BY id`,
				)
				.all({ sessionId }) as ReadonlyArray<MessageRow>;

			const startIndex = resolveStartIndex(rows, cursor);
			const rawEntries: TranscriptEntry[] = [];
			let lastConsumedIndex = startIndex;

			for (let i = startIndex; i < rows.length; i++) {
				const row = rows[i];
				const timestamp = Number.isFinite(row.timestamp)
					? new Date(row.timestamp * 1000).toISOString()
					: undefined;
				// A row we can prove is after the cutoff stops the walk. An UNTIMED row
				// is kept (favour completeness over truncation for anomalous rows) —
				// `timestamp` is NOT NULL in Hermes' schema, so this only guards a
				// non-finite value.
				if (cutoffTime !== undefined && timestamp !== undefined && Date.parse(timestamp) > cutoffTime) {
					break;
				}

				const role = ROLE_MAP[row.role];
				const content = typeof row.content === "string" ? row.content.trim() : "";
				if (role !== undefined && content.length > 0) {
					rawEntries.push({ role, content, ...(timestamp !== undefined && { timestamp }) });
				}
				// Tallied for every row, including the `role: "tool"` results and the
				// empty placeholders dropped above — an assistant turn that is PURE tool
				// calls carries `content: ""`, so these counts are the only record left
				// of that activity.
				tallyRowToolCalls(tally, row);
				lastConsumedIndex = i + 1;
			}

			// Anchor on the last row actually consumed; when nothing new was consumed,
			// carry the incoming anchor forward rather than clearing it.
			const anchorId =
				lastConsumedIndex > 0 ? String(rows[lastConsumedIndex - 1].id) : (cursor?.anchorId ?? undefined);

			return { rawEntries, totalRows: rows.length, startIndex, lastConsumedIndex, anchorId };
		});

		const entries = mergeConsecutiveEntries(rawEntries);
		const newCursor: TranscriptCursor = {
			transcriptPath,
			lineNumber: beforeTimestamp ? lastConsumedIndex : totalRows,
			updatedAt: new Date().toISOString(),
			...(anchorId !== undefined ? { anchorId } : {}),
		};
		const totalLinesRead = lastConsumedIndex - startIndex;
		log.info(
			"Read Hermes session %s: %d new row(s), %d entries (index %d→%d)",
			sessionId,
			totalLinesRead,
			entries.length,
			startIndex,
			newCursor.lineNumber,
		);
		// Always present, even when empty — see TOOL_RECORDING_SOURCES.
		return { entries, newCursor, totalLinesRead, toolUse: tally.values() };
	} catch (error: unknown) {
		throwTranscriptReadError(log, `Cannot read Hermes session: ${sessionId}`, error);
	}
}
