/**
 * Resolve the display title for a single session.
 *
 * Priority:
 *   1. SessionInfo.title (already populated by discoverers for opencode/cursor/copilot)
 *   2. Source-specific native reader (currently only Claude's ai-title)
 *   3. First user message truncated to 60 code points
 *   4. "(untitled session)"
 *
 * Per-source parseLine functions live in this file (single source of truth
 * for transcript schemas — keeps the aggregator agnostic).
 */

import { createLogger, errMsg } from "../Logger.js";
import type { SessionInfo, TranscriptEntry, TranscriptSource } from "../Types.js";
import { readClaudeAiTitle } from "./ClaudeAiTitleReader.js";
import {
	readFirstUserMessageTitle,
	TITLE_MAX_CODE_POINTS,
	truncateToCodePoints,
	UNTITLED_SESSION,
} from "./FallbackTitle.js";

const log = createLogger("SessionTitleResolver");

/** Per-source line parser. Returns the user-message body, or undefined. */
const PARSE_LINE: Record<TranscriptSource, (line: string) => string | undefined> = {
	claude: parseClaudeUserLine,
	codex: parseCodexUserLine,
	gemini: parseGeminiUserLine,
	opencode: parseOpenCodeUserLine,
	cursor: parseCursorUserLine,
	copilot: parseCopilotUserLine,
	"copilot-chat": parseCopilotChatUserLine,
	cline: parseClineUserLine,
	"cline-cli": parseClineCliUserLine,
	devin: parseDevinUserLine,
	"cursor-cli": parseCursorCliUserLine,
	antigravity: parseAntigravityUserLine,
	kimi: parseKimiUserLine,
};

/**
 * Optional pre-loaded transcript entries. When the caller has already paid
 * to load + overlay-apply the transcript (sidebar aggregator does this for
 * message-count), pass them in and the resolver skips its own redundant
 * `readFirstUserMessageTitle` stream — extracting the first human turn
 * directly from the array. Saves one full transcript scan per session.
 */
export async function resolveSessionTitle(
	session: SessionInfo,
	mergedEntries?: ReadonlyArray<TranscriptEntry>,
): Promise<string> {
	// 1. Pre-populated native title (cheap path for opencode/cursor/copilot).
	if (typeof session.title === "string" && session.title.trim().length > 0) {
		return truncateToCodePoints(session.title, TITLE_MAX_CODE_POINTS);
	}

	const source: TranscriptSource = session.source ?? "claude";

	// 2. Source-specific native reader (Claude only for now). `ai-title`
	// rows are stripped by `parseClaude` in `loadTranscript`, so `mergedEntries`
	// never contains them — we must keep this independent stream for Claude.
	// Skipped when the session carries no transcript path (archived sessions
	// whose live transcript is gone): opening a read stream on "" is a real
	// fs round-trip that always ENOENTs — pure waste, and it made callers'
	// evidence pipelines timing-sensitive for nothing.
	if (source === "claude" && session.transcriptPath) {
		try {
			const ai = await readClaudeAiTitle(session.transcriptPath);
			if (ai && ai.length > 0) {
				return truncateToCodePoints(ai, TITLE_MAX_CODE_POINTS);
			}
		} catch (err) {
			// readClaudeAiTitle is supposed to swallow IO errors itself, so
			// reaching this branch means an unexpected programming error —
			// log it instead of silently falling back so triage has a thread.
			log.debug("readClaudeAiTitle threw for %s: %s", session.transcriptPath, errMsg(err));
		}
	}

	// 3. Fallback: first user message, truncated.
	if (mergedEntries !== undefined) {
		return firstUserMessageTitleFromEntries(mergedEntries);
	}
	try {
		return await readFirstUserMessageTitle({
			transcriptPath: session.transcriptPath,
			parseLine: PARSE_LINE[source],
		});
	} catch (err) {
		log.debug("readFirstUserMessageTitle threw for %s/%s: %s", source, session.transcriptPath, errMsg(err));
		return UNTITLED_SESSION;
	}
}

/**
 * Pure helper: produces the same string the streaming fallback would
 * (truncated first human-turn body, or UNTITLED_SESSION when none) from
 * an already-materialised entry array. Exposed so callers that have the
 * merged transcript in hand can skip the disk pass.
 */
export function firstUserMessageTitleFromEntries(entries: ReadonlyArray<TranscriptEntry>): string {
	for (const entry of entries) {
		if (entry.role !== "human") continue;
		if (entry.content.trim().length === 0) continue;
		return truncateToCodePoints(entry.content, TITLE_MAX_CODE_POINTS);
	}
	return UNTITLED_SESSION;
}

/**
 * The title to ARCHIVE with a session, resolved at the moment the memory is
 * written — the answer, not a pointer to where the answer could be recomputed.
 *
 * Every reader used to re-derive this, and each derived it differently: the
 * editor ran the full ladder against the live file, the dashboard joined its
 * `sessions` table and then re-read the file again, and the collector wrote a
 * third answer into that table. Those agree only as long as someone keeps them
 * agreeing. Archiving the string makes them agree by construction.
 *
 * Commit time is the only moment where this is both cheap and correct: the live
 * transcript was just read (its entries are the argument below), so step 2 has
 * the file it needs and step 3 needs no second pass. Every later moment is worse
 * — the file is pruned on the agent's own schedule, the `sessions` row is pruned
 * with `sessions.json`, and on a teammate's machine neither ever existed. The
 * archive is the only artifact that travels, and it carried a machine-local
 * absolute path where it should have carried this.
 *
 * `mergedEntries` is the ARCHIVED slice on purpose: step 3 then describes the
 * turns this memory actually owns, rather than the live file's first turn, which
 * for an amend chain belongs to a different commit.
 *
 * Structural parameter rather than `SessionTranscript` so this module does not
 * import the transcript reader (both archive writers pass one).
 *
 * Returns undefined for {@link UNTITLED_SESSION} so the field stays absent
 * rather than storing a sentinel: "no title" is a fact each surface renders its
 * own way, and an absent field is what lets an older archive fall back.
 */
export async function resolveArchivedTitle(session: {
	readonly sessionId: string;
	readonly source?: TranscriptSource;
	readonly transcriptPath?: string;
	readonly entries: ReadonlyArray<TranscriptEntry>;
}): Promise<string | undefined> {
	try {
		const title = await resolveSessionTitle(
			{
				sessionId: session.sessionId,
				transcriptPath: session.transcriptPath ?? "",
				updatedAt: "",
				...(session.source ? { source: session.source } : {}),
			},
			session.entries,
		);
		return title && title !== UNTITLED_SESSION ? title : undefined;
	} catch (err) {
		// A title is never worth failing an archive write for — the memory itself
		// is what must land. Readers fall back exactly as they do for an archive
		// written before this field existed.
		log.debug("resolveArchivedTitle failed for %s: %s", session.sessionId, errMsg(err));
		return undefined;
	}
}

// --- per-source line parsers ---

function parseClaudeUserLine(line: string): string | undefined {
	const obj = safeParse(line);
	if (!obj) return undefined;
	if (obj.type !== "user") return undefined;
	const message = (obj as { message?: { content?: unknown } }).message;
	const content = message?.content ?? (obj as { content?: unknown }).content;
	return stringifyContent(content);
}

function parseCodexUserLine(line: string): string | undefined {
	const obj = safeParse(line);
	if (!obj) return undefined;
	if (obj.role !== "user") return undefined;
	return stringifyContent((obj as { content?: unknown }).content);
}

function parseGeminiUserLine(line: string): string | undefined {
	const obj = safeParse(line);
	if (!obj) return undefined;
	// Gemini transcripts mark user turns with `type: "user"` (NOT `role`).
	// The content field is either a string or a `[{ text: "..." }, ...]`
	// Part array — see GeminiTranscriptReader for the canonical schema.
	// Earlier this function checked `obj.role !== "user"` which never
	// matched, leaving every Gemini session falling through to
	// `(untitled session)` even when the transcript clearly had user
	// turns. The `text` field is read defensively as a final fallback
	// for any future schema variant that promotes a top-level text key.
	if (obj.type !== "user") return undefined;
	const direct = stringifyContent((obj as { content?: unknown }).content);
	if (direct !== undefined) return direct;
	const text = (obj as { text?: unknown }).text;
	if (typeof text === "string") return text;
	return undefined;
}

function parseOpenCodeUserLine(_line: string): string | undefined {
	// OpenCode transcripts are sqlite-backed; this parser is never invoked
	// because OpenCode sessions always carry a SessionInfo.title from the
	// discoverer (Task 2.2). Defined for completeness.
	return undefined;
}

function parseCursorUserLine(_line: string): string | undefined {
	// Same as OpenCode: Cursor sessions carry SessionInfo.title (Task 2.3).
	return undefined;
}

function parseCopilotUserLine(_line: string): string | undefined {
	// Same as OpenCode: Copilot CLI sessions carry SessionInfo.title (Task 2.4).
	return undefined;
}
function parseAntigravityUserLine(_line: string): string | undefined {
	// Antigravity sessions carry SessionInfo.title (populated by the discoverer
	// from the first USER_INPUT row), so no per-line parsing is needed here.
	return undefined;
}

function parseDevinUserLine(_line: string): string | undefined {
	// Same as OpenCode: Devin sessions carry SessionInfo.title from the discoverer.
	return undefined;
}

function parseCursorCliUserLine(_line: string): string | undefined {
	// Cursor CLI sessions carry SessionInfo.title from the discoverer (meta.json.title).
	return undefined;
}

function parseCopilotChatUserLine(line: string): string | undefined {
	// Copilot Chat transcripts come in two on-disk shapes; the title resolver
	// must handle both because the TranscriptLoader does, and the design
	// promises a "first user message" fallback uniformly. See
	// `TranscriptLoader.parseCopilotChat` for the canonical schema docs.
	//
	// Shape A — VS Code workspaceStorage `chatSessions/<sid>.jsonl`: JSONL
	// patch documents of the form `{ value: { message: { text, role } } }`.
	// Shape B — `~/.copilot/session-state/<sid>/events.jsonl`: event envelopes
	// of the form `{ type: "user.message", data: { content: "..." } }`. The
	// previous version only handled Shape A, which left every events.jsonl-
	// backed session showing `(untitled session)` in the sidebar even though
	// the detail panel rendered the conversation correctly — a "details work,
	// title is wrong" split that the design doc explicitly rules out.
	const obj = safeParse(line);
	if (!obj) return undefined;

	const val = (obj as { value?: unknown }).value;
	if (val && typeof val === "object") {
		const message = (val as { message?: { text?: unknown } }).message;
		if (message && typeof message.text === "string") return message.text;
		const content = (val as { content?: unknown }).content;
		const text = stringifyContent(content);
		if (text) return text;
	}

	if ((obj as { type?: unknown }).type === "user.message") {
		const data = (obj as { data?: unknown }).data;
		if (data && typeof data === "object") {
			const text = stringifyContent((data as { content?: unknown }).content);
			if (text) return text;
		}
	}

	return undefined;
}

function parseClineUserLine(_line: string): string | undefined {
	// Cline extension sessions carry SessionInfo.title from taskHistory.task.
	return undefined;
}

function parseKimiUserLine(line: string): string | undefined {
	// Kimi Code CLI wire.jsonl is Kimi's own JSON-lines wire protocol. A user turn
	// is a `turn.prompt` event whose `input` is an array of content blocks
	// (`{ type: "text", text }`) or a bare string. Only used as a fallback when
	// state.json carried no title. See KimiTranscriptParser for the full schema.
	const obj = safeParse(line);
	if (!obj) return undefined;
	if ((obj as { type?: unknown }).type !== "turn.prompt") return undefined;
	return stringifyContent((obj as { input?: unknown }).input);
}

function parseClineCliUserLine(_line: string): string | undefined {
	// Cline CLI sessions carry SessionInfo.title from sidecar metadata.title.
	return undefined;
}

function safeParse(line: string): Record<string, unknown> | undefined {
	try {
		const v = JSON.parse(line) as unknown;
		return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function stringifyContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (typeof block === "string") parts.push(block);
			else if (block && typeof block === "object") {
				const text = (block as { text?: unknown }).text;
				if (typeof text === "string") parts.push(text);
			}
		}
		return parts.length > 0 ? parts.join(" ") : undefined;
	}
	return undefined;
}
