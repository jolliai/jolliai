/**
 * VS Code Copilot Chat transcript reader.
 *
 * vscode persists each chat session as a JSONL document patch log:
 *   line 0:  {kind:0, v:<initial document>}
 *   line N:  {kind:1, k:[...path], v:<value>}   set at path
 *   line N:  {kind:2, k:[...path]}              delete at path
 *
 * To reconstruct the conversation we replay all patches in order, then read
 * `requests[]` from the final document. See spec
 * docs/superpowers/specs/2026-05-06-copilot-chat-support-design.md.
 */

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";

type PathSegment = string | number;

const log = createLogger("CopilotChatReader");

/**
 * Mutates `doc` in place by setting `value` at `path`. Creates intermediate
 * objects/arrays as needed (next-segment-type decides container shape).
 *
 * Exported with the `_` prefix as a unit-test seam — replayPatches and
 * readCopilotChatTranscript are the public contract; primitives are internal.
 */
export function _setAtPath(doc: unknown, path: PathSegment[], value: unknown): void {
	if (path.length === 0) {
		return; // Root replacement is replayPatches's responsibility (kind:0).
	}
	let cur = doc as Record<string | number, unknown>;
	for (let i = 0; i < path.length - 1; i++) {
		const seg = path[i];
		const next = path[i + 1];
		if (cur[seg] === undefined || cur[seg] === null) {
			cur[seg] = typeof next === "number" ? [] : {};
		}
		cur = cur[seg] as Record<string | number, unknown>;
	}
	cur[path[path.length - 1]] = value;
}

/**
 * Mutates `doc` in place by removing the value at `path`. No-op if the path
 * doesn't exist or is empty. For array elements, uses `splice` so the array
 * shifts (matching vscode's emitted semantics for `pendingRequests` cleanup).
 */
export function _deleteAtPath(doc: unknown, path: PathSegment[]): void {
	if (path.length === 0) return;
	let cur = doc as Record<string | number, unknown> | undefined;
	for (let i = 0; i < path.length - 1; i++) {
		if (cur === undefined || cur === null) return;
		cur = cur[path[i]] as Record<string | number, unknown> | undefined;
	}
	if (cur === undefined || cur === null) return;
	const last = path[path.length - 1];
	if (Array.isArray(cur) && typeof last === "number") {
		if (last >= 0 && last < cur.length) {
			cur.splice(last, 1);
		}
		return;
	}
	delete cur[last];
}

interface KindZeroEvent {
	kind: 0;
	v: unknown;
}
interface KindOneEvent {
	kind: 1;
	k: PathSegment[];
	v: unknown;
}
interface KindTwoEvent {
	kind: 2;
	k: PathSegment[];
}
type PatchEvent = KindZeroEvent | KindOneEvent | KindTwoEvent | { kind: number };

/**
 * Replays a JSONL patch log into a final document.
 *
 *   kind 0 → replace entire document with `v`
 *   kind 1 → set `v` at path `k`
 *   kind 2 → delete value at path `k`
 *
 * Unknown `kind` is logged and skipped (forward compatibility — vscode may add
 * new event types in future versions). JSON parse errors are propagated so the
 * caller can distinguish "mid-write" from "structurally broken file".
 */
export function _replayPatches(lines: ReadonlyArray<string>): unknown {
	let doc: unknown = {};
	for (const raw of lines) {
		const evt = JSON.parse(raw) as PatchEvent;
		switch (evt.kind) {
			case 0:
				doc = (evt as KindZeroEvent).v;
				break;
			case 1: {
				const e = evt as KindOneEvent;
				_setAtPath(doc, e.k, e.v);
				break;
			}
			case 2: {
				const e = evt as KindTwoEvent;
				_deleteAtPath(doc, e.k);
				break;
			}
			default:
				log.warn("Unknown patch kind %s — skipping", evt.kind);
				break;
		}
	}
	return doc;
}

/** Structured error thrown by the Copilot Chat reader. Surfaced via `error.cause.kind`. */
export interface CopilotChatScanError {
	readonly kind: "parse" | "fs" | "schema" | "unknown";
	readonly message: string;
}

/** Throws an Error with a `CopilotChatScanError` payload attached to .cause. */
function throwScanError(kind: CopilotChatScanError["kind"], message: string): never {
	const err = new Error(`Copilot Chat scan failed (${kind}): ${message}`);
	(err as Error & { cause: CopilotChatScanError }).cause = { kind, message };
	throw err;
}

interface ChatRequest {
	message?: { text?: string };
	response?: ReadonlyArray<{ value?: string }>;
}

interface EventsLineEvent {
	type?: string;
	timestamp?: string;
	data?: { content?: string };
}

/**
 * Reads `~/.copilot/session-state/<sid>/events.jsonl` line-by-line. Conversation
 * lives in `type:"user.message"` and non-empty `type:"assistant.message"`
 * events; everything else (session lifecycle, tool calls, assistant turn
 * boundaries, system prompts) is skipped. The cursor's `lineNumber` is the
 * standard "lines already consumed" semantics (first line is line 1).
 *
 * Per-line `JSON.parse` failures are skipped and the cursor still advances
 * past the bad line — matches the Claude / Codex / Gemini JSONL readers'
 * "one bad line never blocks the rest" policy.
 */
async function readEventsJsonl(
	transcriptPath: string,
	cursor?: TranscriptCursor,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const startLine = cursor?.lineNumber ?? 0;
	const stream = createReadStream(transcriptPath, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

	const entries: TranscriptEntry[] = [];
	let currentLine = 0;

	for await (const rawLine of rl) {
		currentLine++;
		if (currentLine <= startLine) continue;

		let evt: EventsLineEvent;
		try {
			evt = JSON.parse(rawLine) as EventsLineEvent;
		} catch {
			// skip malformed line, cursor still advances
			continue;
		}

		// beforeTimestamp gate: events with timestamp > cutoff are deferred to
		// the next commit. ISO 8601 timestamps are lex-sortable, so string
		// comparison is sufficient here. Stop without consuming this line so
		// the cursor reflects "last consumed" — the next read will re-encounter
		// this entry within a wider cutoff window.
		if (beforeTimestamp && typeof evt.timestamp === "string" && evt.timestamp > beforeTimestamp) {
			currentLine--; // do not consume this line
			break;
		}

		const content = evt.data?.content;
		if (typeof content !== "string" || content.length === 0) continue;

		if (evt.type === "user.message") {
			entries.push(
				evt.timestamp ? { role: "human", content, timestamp: evt.timestamp } : { role: "human", content },
			);
		} else if (evt.type === "assistant.message") {
			entries.push(
				evt.timestamp
					? { role: "assistant", content, timestamp: evt.timestamp }
					: { role: "assistant", content },
			);
		}
	}

	stream.close();
	const updatedAt = await stat(transcriptPath).then((s) => new Date(s.mtimeMs).toISOString());
	return {
		entries,
		newCursor: { transcriptPath, lineNumber: currentLine, updatedAt },
		totalLinesRead: Math.max(0, currentLine - startLine),
	};
}

/**
 * Reads a `<wsHash>/chatSessions/<sid>.jsonl` patch log: replay all patches
 * into a final document, then emit TranscriptEntry records for `requests[i]`
 * where `i >= cursor.lineNumber`. The cursor's `lineNumber` field is repurposed
 * here as "request count already consumed" — it never exceeds `requests.length`
 * and only advances on successful emit.
 */
async function readPatchLog(
	transcriptPath: string,
	cursor?: TranscriptCursor,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const fromIdx = cursor?.lineNumber ?? 0;

	let raw: string;
	try {
		raw = await readFile(transcriptPath, "utf8");
	} catch (error: unknown) {
		throwScanError("fs", (error as Error).message);
	}

	const lines = raw.split("\n").filter((l) => l.length > 0);
	if (lines.length === 0) {
		const updatedAt = await stat(transcriptPath).then((s) => new Date(s.mtimeMs).toISOString());
		return {
			entries: [],
			newCursor: { transcriptPath, lineNumber: 0, updatedAt },
			totalLinesRead: 0,
		};
	}

	let doc: unknown;
	try {
		doc = _replayPatches(lines);
	} catch (error: unknown) {
		throwScanError("parse", (error as Error).message);
	}

	const requests = (doc as { requests?: unknown }).requests;
	if (!Array.isArray(requests)) {
		throwScanError("schema", "requests is not an array");
	}

	// Patch-log timestamps are numeric (ms since epoch), so we compare against
	// the parsed cutoff in ms. A request without a numeric timestamp is treated
	// as before-cutoff (consistent with events.jsonl untimed-events behavior).
	const cutoffMs = beforeTimestamp ? Date.parse(beforeTimestamp) : Number.POSITIVE_INFINITY;
	const entries: TranscriptEntry[] = [];
	let lastEmittedIdx = fromIdx;

	for (let i = fromIdx; i < requests.length; i++) {
		const req = requests[i] as ChatRequest & { timestamp?: number };
		// beforeTimestamp gate: stop without advancing cursor past this request
		// so the next read picks it up within a wider cutoff window.
		if (typeof req?.timestamp === "number" && req.timestamp > cutoffMs) {
			break;
		}
		const userText = req?.message?.text;
		if (typeof userText === "string" && userText.length > 0) {
			entries.push({ role: "human", content: userText });
		}
		const responseList = Array.isArray(req?.response) ? req.response : [];
		const assistantText = responseList
			.map((chunk) => (typeof chunk?.value === "string" ? chunk.value : ""))
			.join("");
		if (assistantText.length > 0) {
			entries.push({ role: "assistant", content: assistantText });
		}
		lastEmittedIdx = i + 1;
	}

	const updatedAt = await stat(transcriptPath).then((s) => new Date(s.mtimeMs).toISOString());
	return {
		entries,
		newCursor: { transcriptPath, lineNumber: lastEmittedIdx, updatedAt },
		totalLinesRead: lines.length,
	};
}

/**
 * Front door for Copilot Chat transcript reading. Dispatches to one of two
 * sub-readers based on the trailing path segments of `transcriptPath`:
 *
 *   - `<...>/.copilot/session-state/<sid>/events.jsonl` → readEventsJsonl
 *   - `<...>/chatSessions/<sid>.jsonl`                 → readPatchLog
 *
 * Throws on an unrecognized path — the discoverer should never emit anything
 * else, so this is a defense-in-depth invariant.
 */
export async function readCopilotChatTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const norm = transcriptPath.replace(/\\/g, "/");
	if (/\/\.copilot\/session-state\/[^/]+\/events\.jsonl$/.test(norm)) {
		return readEventsJsonl(transcriptPath, cursor, beforeTimestamp);
	}
	if (/\/chatSessions\/[^/]+\.jsonl$/.test(norm)) {
		return readPatchLog(transcriptPath, cursor, beforeTimestamp);
	}
	throw new Error(`Copilot Chat reader: unrecognized transcriptPath pattern: ${transcriptPath}`);
}
