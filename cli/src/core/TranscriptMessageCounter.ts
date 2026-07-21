/**
 * Count messages in a transcript as the user would see them in
 * `ConversationDetailsPanel`. Two-stage pipeline, identical to the panel:
 *
 *   1. Parse via `loadTranscript` (per-source parser; rejects entries the
 *      panel can't render — e.g. Claude lines that have `type: "user"` but
 *      no extractable text in `message.content`).
 *   2. Apply the per-session overlay (`ConversationOverlayStore`) so user
 *      deletes/edits affect the count exactly like the panel does.
 *
 * Returns 0 on any read failure. `projectDir` is optional: when omitted,
 * no overlay is applied (matches the panel's read-only mode where the
 * workspace is closed).
 *
 * Memory profile: this is a linear scan that materializes the full parsed
 * transcript into memory before counting — so RAM scales with transcript
 * size, NOT constant as an earlier docstring claimed. For the 48-hour
 * activity window the per-session footprint is typically a few MB and the
 * sidebar refresh path is gated by `messageCount > 0`, so the trade-off is
 * acceptable. If a future profile pins this as a bottleneck (e.g. a 200MB
 * Codex session), refactor `loadTranscript` to expose an entry-stream
 * callback so this function can run a `++count` loop without buffering.
 */

import { createLogger, errMsg } from "../Logger.js";
import type { SessionInfo, TranscriptEntry, TranscriptReadResult, TranscriptSource } from "../Types.js";
import { readAntigravityTranscript } from "./AntigravityTranscriptReader.js";
import { readClineCliTranscript } from "./ClineCliTranscriptReader.js";
import { readClineTranscript } from "./ClineTranscriptReader.js";
import { applyOverlay, loadOverlay } from "./ConversationOverlayStore.js";
import { readCopilotChatTranscript } from "./CopilotChatTranscriptReader.js";
import { readCopilotTranscript } from "./CopilotTranscriptReader.js";
import { readCursorCliTranscript } from "./CursorCliTranscriptReader.js";
import { readCursorTranscript } from "./CursorTranscriptReader.js";
import { readDevinTranscript } from "./DevinTranscriptReader.js";
import { readGeminiTranscript } from "./GeminiTranscriptReader.js";
import { readOpenCodeTranscript } from "./OpenCodeTranscriptReader.js";
import { loadCursorForTranscript } from "./SessionTracker.js";
import { loadTranscript } from "./TranscriptLoader.js";
import { getParserForSource } from "./TranscriptParser.js";
import { readTranscript } from "./TranscriptReader.js";

const log = createLogger("TranscriptMessageCounter");

/**
 * Loads the transcript, applies the session overlay, and returns the merged
 * entry array. Single source of truth for the (load → overlay) two-step,
 * exposed so callers that need BOTH the count and a derived title can
 * share one disk pass instead of scanning the transcript twice.
 */
export async function loadMergedTranscript(
	s: SessionInfo,
	projectDir?: string,
): Promise<ReadonlyArray<TranscriptEntry>> {
	const source = s.source ?? "claude";
	const entries = await loadTranscript({ source, transcriptPath: s.transcriptPath });
	const overlay = projectDir ? await loadOverlay({ projectDir, source, sessionId: s.sessionId }) : null;
	return applyOverlay(entries, overlay);
}

/**
 * Loads only the unread portion of a transcript, starting from the cursor
 * last saved by the commit pipeline for this transcript path.
 *
 * Used by the active-conversations list so sessions that have already been
 * consumed into a commit summary disappear until genuinely new turns arrive.
 * When `projectDir` is omitted we cannot locate `cursors.json`, so this
 * falls back to the full merged transcript.
 */
export async function loadUnreadMergedTranscript(
	s: SessionInfo,
	projectDir?: string,
): Promise<ReadonlyArray<TranscriptEntry>> {
	if (!projectDir) return loadMergedTranscript(s);

	const source = s.source ?? "claude";
	const cursor = await loadCursorForTranscript(s.transcriptPath, projectDir);
	const result = await readUnreadTranscript(source, s.transcriptPath, cursor);
	const overlay = await loadOverlay({ projectDir, source, sessionId: s.sessionId });
	return applyOverlay(result.entries, overlay);
}

export async function countTranscriptMessages(s: SessionInfo, projectDir?: string): Promise<number> {
	return (await loadMergedTranscript(s, projectDir)).length;
}

/**
 * Loads the cursor-trimmed *raw* entries for a transcript — i.e. the same
 * unread slice the active-conversations list counts against, but **without**
 * overlay applied. Callers needing both the displayed view and a stable
 * identity-aligned `rawByIndex` (e.g. `ConversationDetailsPanel`) build both
 * out of this so the two arrays stay positionally aligned.
 *
 * When `projectDir` is omitted we cannot resolve `cursors.json`, so this
 * falls back to the full transcript via `loadTranscript`. That matches the
 * sidebar's no-workspace fallback in `loadUnreadMergedTranscript` and keeps
 * the detail panel functional in read-only mode.
 *
 * Errors from the per-source reader (locked SQLite, malformed JSONL, missing
 * file other than ENOENT-on-cursors) degrade to an empty array. The panel
 * renders "no entries" in that case, identical to `loadTranscript`'s
 * graceful-failure contract.
 */
export async function loadUnreadTranscript(
	source: TranscriptSource,
	transcriptPath: string,
	projectDir?: string,
): Promise<ReadonlyArray<TranscriptEntry>> {
	if (!projectDir) {
		return loadTranscript({ source, transcriptPath });
	}
	try {
		const cursor = await loadCursorForTranscript(transcriptPath, projectDir);
		const result = await readUnreadTranscript(source, transcriptPath, cursor);
		return result.entries;
	} catch (err) {
		log.warn("loadUnreadTranscript failed for %s/%s: %s", source, transcriptPath, errMsg(err));
		return [];
	}
}

async function readUnreadTranscript(
	source: TranscriptSource,
	transcriptPath: string,
	cursor: Awaited<ReturnType<typeof loadCursorForTranscript>>,
): Promise<TranscriptReadResult> {
	switch (source) {
		case "gemini":
			return readGeminiTranscript(transcriptPath, cursor);
		case "opencode":
			return readOpenCodeTranscript(transcriptPath, cursor);
		case "cursor":
			return readCursorTranscript(transcriptPath, cursor);
		case "copilot":
			return readCopilotTranscript(transcriptPath, cursor);
		case "devin":
			return readDevinTranscript(transcriptPath, cursor);
		case "cursor-cli":
			return readCursorCliTranscript(transcriptPath, cursor);
		case "copilot-chat":
			return readCopilotChatTranscript(transcriptPath, cursor ?? undefined);
		case "cline":
			return readClineTranscript(transcriptPath, cursor);
		case "cline-cli":
			return readClineCliTranscript(transcriptPath, cursor);
		case "antigravity":
			return readAntigravityTranscript(transcriptPath, cursor ?? undefined);
		case "codex":
			return readTranscript(transcriptPath, cursor, getParserForSource("codex"));
		default:
			// Claude is the fallback parser; SessionInfo.source defaults to
			// "claude" for back-compat, so unknown values flow through here
			// too rather than throwing.
			return readTranscript(transcriptPath, cursor, getParserForSource("claude"));
	}
}
