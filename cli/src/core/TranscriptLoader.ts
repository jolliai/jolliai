/**
 * Stream-load a transcript into an array of TranscriptEntry objects.
 * Dispatches to per-source parsers. Returns [] on any IO error.
 *
 * Only used by ConversationDetailsPanel — the aggregator never loads
 * the full transcript.
 *
 * Sources split into two dispatch styles:
 *   - JSONL (claude / codex / copilot-chat) — line-streamed through the
 *     per-source parser in `PARSERS` below.
 *   - Single-artifact readers (gemini JSON file; opencode / cursor / copilot
 *     SQLite databases) — delegated to the dedicated reader module, whose
 *     synthetic `<dbPath>#<sessionId>` `transcriptPath` is produced by the
 *     matching session discoverer.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createLogger, errMsg, isEnoent } from "../Logger.js";
import type { TranscriptEntry, TranscriptSource } from "../Types.js";
import { getParserForSource } from "./TranscriptParser.js";

const log = createLogger("TranscriptLoader");

export interface LoadOptions {
	readonly source: TranscriptSource;
	readonly transcriptPath: string;
}

export async function loadTranscript(opts: LoadOptions): Promise<TranscriptEntry[]> {
	// Single-artifact readers: each owns its own file/DB format and error
	// handling. Wrap the call so any reader throw (missing file, malformed
	// synthetic path, locked SQLite, schema drift, dynamic-import failure
	// from a missing or corrupted module bundle) degrades to an empty
	// transcript — the panel renders "no entries" instead of surfacing a
	// raw error to the user. Readers log their own internal IO failures,
	// but the catch below also covers the dynamic-import path and any
	// unexpected throw, so we still emit one warn here unless the cause is
	// a routine ENOENT (file genuinely missing) which is silent everywhere.
	if (opts.source === "gemini") {
		try {
			const { readGeminiTranscript } = await import("./GeminiTranscriptReader.js");
			const result = await readGeminiTranscript(opts.transcriptPath);
			return [...result.entries];
		} catch (err) {
			if (!isEnoent(err)) {
				log.warn("loadTranscript (gemini) failed for %s: %s", opts.transcriptPath, errMsg(err));
			}
			return [];
		}
	}
	if (opts.source === "opencode") {
		try {
			const { readOpenCodeTranscript } = await import("./OpenCodeTranscriptReader.js");
			const result = await readOpenCodeTranscript(opts.transcriptPath);
			return [...result.entries];
		} catch (err) {
			if (!isEnoent(err)) {
				log.warn("loadTranscript (opencode) failed for %s: %s", opts.transcriptPath, errMsg(err));
			}
			return [];
		}
	}
	if (opts.source === "cursor") {
		try {
			const { readCursorTranscript } = await import("./CursorTranscriptReader.js");
			const result = await readCursorTranscript(opts.transcriptPath);
			return [...result.entries];
		} catch (err) {
			if (!isEnoent(err)) {
				log.warn("loadTranscript (cursor) failed for %s: %s", opts.transcriptPath, errMsg(err));
			}
			return [];
		}
	}
	if (opts.source === "copilot") {
		try {
			const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
			const result = await readCopilotTranscript(opts.transcriptPath);
			return [...result.entries];
		} catch (err) {
			if (!isEnoent(err)) {
				log.warn("loadTranscript (copilot) failed for %s: %s", opts.transcriptPath, errMsg(err));
			}
			return [];
		}
	}
	const entries: TranscriptEntry[] = [];
	let parseSkipped = 0;
	try {
		const stream = createReadStream(opts.transcriptPath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		// `gemini` is handled above via `readGeminiTranscript` — so by the
		// time we reach the line-streaming path, the source is one of the
		// JSONL-backed parsers below.
		const parse = PARSERS[opts.source as JsonlSource];
		try {
			for await (const line of rl) {
				if (!line) continue;
				try {
					const entry = parse(line);
					if (entry) entries.push(entry);
				} catch {
					// Lines mid-write (source app appends while we read) and
					// schema-drift rows are expected; surface the running
					// total once at end-of-stream rather than per-line.
					parseSkipped++;
				}
			}
		} finally {
			rl.close();
			stream.destroy();
		}
		if (parseSkipped > 0) {
			log.debug(
				"loadTranscript skipped %d unparseable line(s) for %s/%s",
				parseSkipped,
				opts.source,
				opts.transcriptPath,
			);
		}
		return entries;
	} catch (err) {
		if (!isEnoent(err)) {
			log.warn("loadTranscript stream failed for %s/%s: %s", opts.source, opts.transcriptPath, errMsg(err));
		}
		return [];
	}
}

/**
 * Per-line JSONL parsers. Sources that own a dedicated single-artifact
 * reader (`gemini` JSON file; `opencode` / `cursor` / `copilot` SQLite DBs)
 * are intentionally absent — those are dispatched at the top of
 * `loadTranscript` before this table is consulted.
 */
type JsonlSource = Exclude<TranscriptSource, "gemini" | "opencode" | "cursor" | "copilot">;
const PARSERS: Record<JsonlSource, (line: string) => TranscriptEntry | undefined> = {
	claude: parseClaude,
	codex: parseCodex,
	"copilot-chat": parseCopilotChat,
};

// `claude` and `codex` delegate to the canonical TranscriptParser.ts
// strategies (used by the post-commit summary pipeline). Reusing the same
// parsers across the two consumers eliminates schema-drift bugs — Claude's
// `isCompactSummary` skip and Codex's `event_msg/user_message` +
// `event_msg/agent_message` event-type filtering both live in one place.
// The `lineNum` argument is only used for diagnostic logging inside the
// shared parsers; we pass 0 because the line-streaming caller above
// already tracks its own parseSkipped counter and emits one summary log
// at end-of-stream.
function parseClaude(line: string): TranscriptEntry | undefined {
	return getParserForSource("claude").parseLine(line, 0) ?? undefined;
}

function parseCodex(line: string): TranscriptEntry | undefined {
	return getParserForSource("codex").parseLine(line, 0) ?? undefined;
}

function parseCopilotChat(line: string): TranscriptEntry | undefined {
	const obj = JSON.parse(line) as {
		value?: { message?: { text?: unknown; role?: unknown } };
		type?: unknown;
		data?: { content?: unknown };
		timestamp?: unknown;
	};

	// Scan B — VS Code workspaceStorage `chatSessions/<sid>.jsonl`
	// (chat panel with non-copilotcli-backend models). One JSONL row per
	// chat patch document with shape `{ value: { message: { text, role } } }`.
	const message = obj.value?.message;
	if (message && typeof message.text === "string") {
		const role = message.role === "user" ? "human" : message.role === "assistant" ? "assistant" : undefined;
		return role ? { role, content: message.text } : undefined;
	}

	// Scan A — `~/.copilot/session-state/<sid>/events.jsonl` (Copilot CLI
	// runtime backing the chat panel's copilotcli-backend models). Event
	// envelope: `{ type, id, parentId, timestamp, data }`. Only
	// `user.message` / `assistant.message` carry rendered conversation
	// content (in `data.content`); the other event types — session.start,
	// session.shutdown, system.message, assistant.turn_start / turn_end,
	// tool.execution_start / tool.execution_complete — are skipped silently
	// the same way Claude's tool_use blocks are skipped.
	if (obj.type === "user.message" || obj.type === "assistant.message") {
		const content = obj.data?.content;
		if (typeof content !== "string") return undefined;
		const role = obj.type === "user.message" ? "human" : "assistant";
		const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
		return timestamp ? { role, content, timestamp } : { role, content };
	}

	return undefined;
}
