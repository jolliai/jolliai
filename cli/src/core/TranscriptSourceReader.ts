/**
 * TranscriptSourceReader — read one conversation, whichever agent wrote it.
 *
 * The per-source dispatch used to live privately inside `TranscriptMessageCounter`,
 * where exactly one caller could reach it. That is why the dashboard back-fill,
 * needing the same thing, instead grew `if (source !== "claude") return base` and
 * silently gave up on tool calls for the other twelve sources — the capability was
 * present, addressable only from a module about counting messages.
 *
 * Two dispatch styles, and the split is the sources' own:
 *
 *   - **JSONL** (claude / codex / kimi) — line-streamed through the matching
 *     {@link TranscriptParser}. New agents in this family need no entry here, only
 *     a parser.
 *   - **Dedicated readers** (gemini's JSON file; the SQLite-backed opencode,
 *     cursor, copilot, copilot-chat, cline, cline-cli, devin, cursor-cli and
 *     antigravity stores) — each owns its own format, and several take the cursor
 *     in a slightly different shape.
 *
 * **Every import is dynamic**, which is not a style choice: most of the readers
 * below reach for `node:sqlite`, and a static import would emit its
 * ExperimentalWarning in every process that merely loads this module — including
 * the git hooks, which must stay silent on stdout. The previous home of this
 * dispatch imported all of them eagerly, so moving it here also removes that.
 */

import { readFile } from "node:fs/promises";
import { createLogger, errMsg, isEnoent } from "../Logger.js";
import type { TranscriptCursor, TranscriptReadResult, TranscriptSource } from "../Types.js";
import { getParserForSource } from "./TranscriptParser.js";
import { readTranscript, splitTranscriptLines } from "./TranscriptReader.js";

/**
 * Sources whose transcript is a JSONL FILE, so raw lines are a thing it has.
 *
 * Exactly the sources the dispatch below sends to `readTranscript`; everything
 * else is answered by a dedicated reader over a JSON file or a SQLite database,
 * where a `transcriptPath` is a synthetic `<dbPath>#<sessionId>` handle rather
 * than something that can be opened and split.
 *
 * Kept next to that dispatch because the two must agree: a source added to one
 * and not the other either loses its lines silently, or gets handed the bytes of
 * a SQLite file to parse as JSONL.
 */
const LINE_ORIENTED_SOURCES: ReadonlySet<string> = new Set(["claude", "codex", "kimi"]);

const log = createLogger("TranscriptSourceReader");

/**
 * The transcript's raw non-blank lines, or `undefined` when this source has none.
 *
 * `undefined` rather than `[]` throughout — including for an unreadable file —
 * because a line scanner reads `[]` as "the conversation is empty" and would
 * report a confident "no skills used" about a file it never got to see.
 */
export async function readTranscriptLinesForSource(
	source: TranscriptSource,
	transcriptPath: string,
): Promise<ReadonlyArray<string> | undefined> {
	if (!LINE_ORIENTED_SOURCES.has(source)) return undefined;
	try {
		return splitTranscriptLines(await readFile(transcriptPath, "utf-8"));
	} catch (err) {
		// A transcript can be rotated or deleted between the scan and this read, which
		// is routine rather than exceptional — ENOENT stays silent, as everywhere else.
		if (!isEnoent(err))
			log.warn("cannot read %s transcript lines from %s: %s", source, transcriptPath, errMsg(err));
		return undefined;
	}
}

/**
 * Reads `transcriptPath` as `source` wrote it, from `cursor` forward.
 *
 * Throws whatever the underlying reader throws — a locked database, a malformed
 * file, a missing one. Callers decide what a failure means: the message counter
 * degrades to an empty transcript because a panel must still render, while the
 * back-fill logs and keeps the session row it already has. Swallowing errors here
 * would take that choice away from both.
 */
export async function readTranscriptForSource(
	source: TranscriptSource,
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
): Promise<TranscriptReadResult> {
	switch (source) {
		case "gemini":
			return (await import("./GeminiTranscriptReader.js")).readGeminiTranscript(transcriptPath, cursor);
		case "opencode":
			return (await import("./OpenCodeTranscriptReader.js")).readOpenCodeTranscript(transcriptPath, cursor);
		case "cursor":
			return (await import("./CursorTranscriptReader.js")).readCursorTranscript(transcriptPath, cursor);
		case "copilot":
			return (await import("./CopilotTranscriptReader.js")).readCopilotTranscript(transcriptPath, cursor);
		case "devin":
			return (await import("./DevinTranscriptReader.js")).readDevinTranscript(transcriptPath, cursor);
		case "cursor-cli":
			return (await import("./CursorCliTranscriptReader.js")).readCursorCliTranscript(transcriptPath, cursor);
		case "copilot-chat":
			return (await import("./CopilotChatTranscriptReader.js")).readCopilotChatTranscript(
				transcriptPath,
				cursor ?? undefined,
			);
		case "cline":
			return (await import("./ClineTranscriptReader.js")).readClineTranscript(transcriptPath, cursor);
		case "cline-cli":
			return (await import("./ClineCliTranscriptReader.js")).readClineCliTranscript(transcriptPath, cursor);
		case "antigravity":
			return (await import("./AntigravityTranscriptReader.js")).readAntigravityTranscript(
				transcriptPath,
				cursor ?? undefined,
			);
		case "codex":
			return readTranscript(transcriptPath, cursor, getParserForSource("codex"));
		case "kimi":
			return readTranscript(transcriptPath, cursor, getParserForSource("kimi"));
		default:
			// Claude is the fallback parser; `SessionInfo.source` defaults to "claude"
			// for back-compat, so unknown values flow through here too rather than
			// throwing. A source with no reader of its own gets Claude's, whose
			// pre-filters simply match nothing on a foreign transcript.
			return readTranscript(transcriptPath, cursor, getParserForSource("claude"));
	}
}
