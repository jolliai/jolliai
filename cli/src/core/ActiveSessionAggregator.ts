/**
 * Aggregates active AI coding sessions across all supported transcript
 * sources (see `TRANSCRIPT_SOURCES` in Types.ts — currently fourteen:
 * claude / codex / gemini / opencode / cursor / cursor-cli / copilot /
 * copilot-chat / cline / cline-cli / devin / antigravity / kimi / hermes), filters by
 * recency window, resolves display titles, and returns a sorted list
 * ready for UI consumption.
 *
 * - Sessions older than `windowMs` (default 48h) are excluded.
 * - Sources fan out concurrently via Promise.allSettled — one failed
 *   source never blocks the others. The set of sources that did fail is
 *   returned alongside `items` so callers can surface a "partial result"
 *   indicator instead of silently rendering an incomplete list.
 * - Sort: updatedAt DESC, tie-break by sessionId ASC (stable order).
 * - No cache. No LLM. No background tasks.
 */

import { createLogger, errMsg } from "../Logger.js";
import type { JolliMemoryConfig, SessionInfo, TranscriptEntry, TranscriptSource } from "../Types.js";
import { conversationKey, readExclusions } from "./CommitSelectionStore.js";
import { hasOverlayChanges, loadOverlay } from "./ConversationOverlayStore.js";
import { isStillHidden, loadHiddenConversations } from "./HiddenConversationsStore.js";
import { resolveSessionTitle } from "./SessionTitleResolver.js";
import { isSourceEnabled, loadConfig } from "./SessionTracker.js";
import { loadMergedTranscript, loadUnreadMergedTranscript } from "./TranscriptMessageCounter.js";

// The AI-agent-toggle gate now lives in SessionTracker so the aggregator's
// per-source loaders and SessionTracker.filterSessionsByEnabledIntegrations
// (the post-hoc filter for install/status) share one switch statement. Re-
// exported here so pre-existing importers (VS Code ActiveSessionsProvider,
// aggregator tests, external plugin surfaces) keep resolving from this
// module's public API.
export { isSourceEnabled };

const log = createLogger("ActiveSessionAggregator");

export interface ActiveConversationItem {
	readonly sessionId: string;
	readonly source: TranscriptSource;
	readonly title: string;
	readonly messageCount: number;
	readonly updatedAt: string;
	readonly transcriptPath: string;
	/** True when the persisted overlay contains saved edits or deletions. */
	readonly isEdited: boolean;
	/**
	 * Per-commit-selection signal. `false` = user has unchecked this row;
	 * the QueueWorker will skip its transcript when generating the next
	 * summary. Default `true` for any row absent from
	 * `commit-selection.json`. Independent of `HiddenConversationsStore`
	 * (which hides the row entirely).
	 */
	readonly isSelected: boolean;
}

export interface ListActiveOptions {
	readonly cwd: string;
	readonly windowMs: number;
}

const DEFAULT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 48 hours

export async function listActiveConversations(opts: ListActiveOptions): Promise<readonly ActiveConversationItem[]> {
	return (await listActiveConversationsWithDiagnostics(opts)).items;
}

/**
 * Diagnostic envelope variant of `listActiveConversations`. Returns the same
 * items array plus a `failedSources` set covering loaders that threw or
 * reported a structured `error` field. Callers that surface partial-data
 * indicators in the UI should use this entry point; callers that only care
 * about the list itself stay on the simpler `listActiveConversations`.
 */
export interface ActiveConversationsResult {
	readonly items: readonly ActiveConversationItem[];
	readonly failedSources: readonly TranscriptSource[];
}

export async function listActiveConversationsWithDiagnostics(
	opts: ListActiveOptions,
): Promise<ActiveConversationsResult> {
	const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
	const cutoff = Date.now() - windowMs;

	// Load config first — every source loader below short-circuits when its
	// matching xxxEnabled flag is false, so a disabled source never touches
	// disk. Static import (SessionTracker is already loaded via the
	// `isSourceEnabled` re-export above); the per-source discoverers below
	// still lazy-load their own heavier modules (SQLite readers etc.) inside
	// their `loadXxx` bodies.
	const config = await loadConfig();
	const [collected, hidden, exclusions] = await Promise.all([
		collectFromAllSources(opts.cwd, config),
		loadHiddenConversations(opts.cwd),
		readExclusions(opts.cwd),
	]);
	const fresh = collected.sessions.filter((s) => Date.parse(s.updatedAt) >= cutoff);

	// Dedupe by (source, sessionId), keeping the most-recently-updated entry.
	// Same composite identity ConversationDetailsPanel and HiddenConversationsStore
	// already use — sessionId alone is not unique across sources (a Claude UUID
	// and a Cursor hash share the namespace), so a single-key map would silently
	// drop one row whenever two providers' IDs collide.
	const bySourceAndId = new Map<string, SessionInfo>();
	for (const s of fresh) {
		const key = `${s.source ?? "claude"}:${s.sessionId}`;
		const existing = bySourceAndId.get(key);
		if (!existing || Date.parse(s.updatedAt) > Date.parse(existing.updatedAt)) {
			bySourceAndId.set(key, s);
		}
	}

	// User-hidden sessions drop out before title resolution + message counting
	// — those reads can be expensive (SQLite open, JSONL scan) and the row will
	// never reach the UI anyway. Hidden state lives in
	// `<cwd>/.jolli/jollimemory/hidden-conversations.json`, written by the
	// detail panel when a save leaves the merged transcript empty.
	//
	// `isStillHidden` (not `isHidden`) so a session that has accumulated new
	// turns *since* the user hid it re-surfaces: "Mark All as Deleted" is a
	// dismiss-what-I've-seen action, not a permanent block. Without this,
	// long-running Cursor/Codex/Copilot Chat sessions stay invisible after
	// one dismiss even when new user activity arrives.
	const visible = [...bySourceAndId.values()].filter(
		(s) => !isStillHidden(hidden, s.source ?? "claude", s.sessionId, s.updatedAt),
	);

	// Per session, first load only the unread portion (cursor -> EOF). The
	// commit pipeline persists these cursors after each summary generation,
	// so the sidebar should only surface sessions with turns that have not
	// yet been consumed into a commit summary.
	const items: ActiveConversationItem[] = await Promise.all(
		visible.map(async (s) => {
			const source = s.source ?? "claude";
			const [unread, isEdited] = await Promise.all([
				safeLoadUnreadMerged(s, opts.cwd),
				safeHasOverlayChanges(source, s.sessionId, opts.cwd),
			]);
			// Preserve title quality for sources without a native title by
			// resolving against the full merged transcript when the session is
			// still visible. For sources that already carry a title, the extra
			// read is harmless and skipped by resolveSessionTitle immediately.
			const titleEntries = unread.length > 0 ? await safeLoadMerged(s, opts.cwd) : unread;
			return {
				sessionId: s.sessionId,
				source,
				title: await resolveSessionTitle(s, titleEntries),
				messageCount: unread.length,
				updatedAt: s.updatedAt,
				transcriptPath: s.transcriptPath,
				isEdited,
				isSelected: !exclusions.conversations.has(conversationKey(source, s.sessionId)),
			};
		}),
	);

	// Sessions whose post-overlay merged transcript is empty are dropped from
	// the list — they would open a panel that shows "No conversation entries
	// to display." The merge already accounts for user deletes/edits, so the
	// row count and the panel render stay consistent.
	const nonEmpty = items.filter((item) => item.messageCount > 0);

	nonEmpty.sort((a, b) => {
		const cmp = b.updatedAt.localeCompare(a.updatedAt);
		return cmp !== 0 ? cmp : a.sessionId.localeCompare(b.sessionId);
	});

	return { items: nonEmpty, failedSources: collected.failedSources };
}

async function safeLoadMerged(s: SessionInfo, projectDir: string): Promise<ReadonlyArray<TranscriptEntry>> {
	try {
		return await loadMergedTranscript(s, projectDir);
	} catch (err) {
		// An empty array makes the downstream `messageCount > 0` filter drop
		// the row, matching the previous safeCount behaviour. Log so triage
		// can tell a read failure apart from a truly empty session.
		log.warn(
			"loadMergedTranscript failed for %s/%s (transcript=%s): %s",
			s.source ?? "claude",
			s.sessionId,
			s.transcriptPath,
			errMsg(err),
		);
		return [];
	}
}

async function safeLoadUnreadMerged(s: SessionInfo, projectDir: string): Promise<ReadonlyArray<TranscriptEntry>> {
	try {
		return await loadUnreadMergedTranscript(s, projectDir);
	} catch (err) {
		log.warn(
			"loadUnreadMergedTranscript failed for %s/%s (transcript=%s): %s",
			s.source ?? "claude",
			s.sessionId,
			s.transcriptPath,
			errMsg(err),
		);
		return [];
	}
}

async function safeHasOverlayChanges(
	source: TranscriptSource,
	sessionId: string,
	projectDir: string,
): Promise<boolean> {
	try {
		return hasOverlayChanges(await loadOverlay({ projectDir, source, sessionId }));
	} catch (err) {
		log.warn("loadOverlay failed for %s/%s when computing edited badge: %s", source, sessionId, errMsg(err));
		return false;
	}
}

/**
 * Result envelope from `collectFromAllSources`. `failedSources` carries the
 * set of sources whose loader threw (vs. simply returning an empty array).
 * Used by `listActiveConversations` so callers can render a partial-data
 * indicator instead of silently presenting a complete-looking list when
 * some sources are unreadable (e.g. SQLite locked, schema drift).
 */
interface CollectResult {
	readonly sessions: readonly SessionInfo[];
	readonly failedSources: readonly TranscriptSource[];
}

async function collectFromAllSources(cwd: string, config: JolliMemoryConfig): Promise<CollectResult> {
	// Each loader catches its own errors and reports them via the `failed`
	// field on `LoaderResult`. We aggregate both the sessions and the failure
	// set so callers can render a partial-data hint instead of silently
	// presenting an incomplete list. A loader that returned `r.error` from
	// its discoverer counts as failed even when `sessions` is non-empty —
	// that's the "partial result" case (some rows came back before the
	// underlying scan tripped).
	//
	// Every loader also inspects `config` and short-circuits to an empty
	// result when its matching AI Agents toggle is off — no disk read, no
	// SQLite open, no JSONL walk. `failed` stays empty for disabled sources
	// so the UI does NOT flag them as "unavailable"; the user turned them
	// off, not the scan.
	const batches = await Promise.all([
		loadClaudeAndGemini(cwd, config),
		loadCursor(cwd, config),
		loadCodex(cwd, config),
		loadOpenCode(cwd, config),
		loadCopilot(cwd, config),
		loadCopilotChat(cwd, config),
		loadCline(cwd, config),
		loadClineCli(cwd, config),
		loadDevin(cwd, config),
		loadCursorCli(cwd, config),
		loadAntigravity(cwd, config),
		loadKimi(cwd, config),
		loadHermes(cwd, config),
	]);
	const sessions: SessionInfo[] = [];
	const failedSources: TranscriptSource[] = [];
	for (const batch of batches) {
		sessions.push(...batch.sessions);
		failedSources.push(...batch.failed);
	}
	return { sessions, failedSources };
}

/**
 * Per-loader result. `failed` is the list of TranscriptSource keys this
 * loader couldn't fully serve (either it threw, or its discoverer returned
 * a structured `r.error`). For most loaders that's 0 or 1 source; the
 * combined claude+gemini loader can fail both at once when the shared
 * sessions.json registry is unreadable.
 */
interface LoaderResult {
	readonly sessions: readonly SessionInfo[];
	readonly failed: readonly TranscriptSource[];
}

async function loadClaudeAndGemini(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	// Claude + Gemini both write their session metadata to the per-project
	// .jolli/jollimemory/sessions.json registry (StopHook / GeminiAfterAgentHook).
	// SessionTracker.loadAllSessions is the canonical reader — when it
	// throws, both sources are effectively unavailable, so flag both.
	//
	// Two independent toggles share one loader: both off → skip the read;
	// only one off → read then drop that half. A missing `source` field is
	// a legacy Claude session (predates the tag) and rides claudeEnabled —
	// isSourceEnabled(undefined, ...) falls back to "claude" for exactly this.
	const claudeOn = isSourceEnabled("claude", config);
	const geminiOn = isSourceEnabled("gemini", config);
	if (!claudeOn && !geminiOn) return { sessions: [], failed: [] };
	try {
		const { loadAllSessions } = await import("./SessionTracker.js");
		const all = await loadAllSessions(cwd);
		const sessions = claudeOn && geminiOn ? all : all.filter((s) => isSourceEnabled(s.source, config));
		return { sessions, failed: [] };
	} catch (err) {
		log.warn("loadAllSessions (claude+gemini) failed: %s", errMsg(err));
		return { sessions: [], failed: ["claude", "gemini"] };
	}
}

async function loadCursor(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	if (!isSourceEnabled("cursor", config)) return { sessions: [], failed: [] };
	try {
		const { scanCursorSessions } = await import("./CursorSessionDiscoverer.js");
		const r = await scanCursorSessions(cwd);
		if (r.error) {
			log.warn("scanCursorSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["cursor"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanCursorSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["cursor"] };
	}
}

async function loadCodex(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	if (!isSourceEnabled("codex", config)) return { sessions: [], failed: [] };
	try {
		const { discoverCodexSessions } = await import("./CodexSessionDiscoverer.js");
		return { sessions: await discoverCodexSessions(cwd), failed: [] };
	} catch (err) {
		log.warn("discoverCodexSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["codex"] };
	}
}

async function loadKimi(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	if (!isSourceEnabled("kimi", config)) return { sessions: [], failed: [] };
	try {
		const { discoverKimiSessions } = await import("./KimiSessionDiscoverer.js");
		return { sessions: await discoverKimiSessions(cwd), failed: [] };
	} catch (err) {
		log.warn("discoverKimiSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["kimi"] };
	}
}

async function loadHermes(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	if (!isSourceEnabled("hermes", config)) return { sessions: [], failed: [] };
	try {
		const { scanHermesSessions } = await import("./HermesSessionDiscoverer.js");
		const r = await scanHermesSessions(cwd);
		if (r.error) {
			log.warn("scanHermesSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["hermes"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanHermesSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["hermes"] };
	}
}

async function loadOpenCode(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	if (!isSourceEnabled("opencode", config)) return { sessions: [], failed: [] };
	try {
		const { scanOpenCodeSessions } = await import("./OpenCodeSessionDiscoverer.js");
		const r = await scanOpenCodeSessions(cwd);
		if (r.error) {
			log.warn("scanOpenCodeSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["opencode"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanOpenCodeSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["opencode"] };
	}
}

async function loadCopilot(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	if (!isSourceEnabled("copilot", config)) return { sessions: [], failed: [] };
	try {
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const r = await scanCopilotSessions(cwd);
		if (r.error) {
			log.warn("scanCopilotSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["copilot"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanCopilotSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["copilot"] };
	}
}

async function loadCopilotChat(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	// Copilot Chat currently shares copilotEnabled with the Copilot CLI (one user-facing toggle for
	// "GitHub Copilot"). Both paths go through `isSourceEnabled`, so a future split that maps
	// "copilot-chat" to its own flag needs only one edit.
	if (!isSourceEnabled("copilot-chat", config)) return { sessions: [], failed: [] };
	try {
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const r = await scanCopilotChatSessions(cwd);
		if (r.error) {
			log.warn("scanCopilotChatSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["copilot-chat"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanCopilotChatSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["copilot-chat"] };
	}
}

async function loadCline(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	if (!isSourceEnabled("cline", config)) return { sessions: [], failed: [] };
	try {
		const { scanClineSessions } = await import("./ClineSessionDiscoverer.js");
		const r = await scanClineSessions(cwd);
		if (r.error) {
			log.warn("scanClineSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["cline"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanClineSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["cline"] };
	}
}

async function loadClineCli(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	// Cline CLI currently shares clineEnabled with the Cline VS Code extension. Both paths go
	// through `isSourceEnabled`, so a future split that maps "cline-cli" to its own flag needs
	// only one edit.
	if (!isSourceEnabled("cline-cli", config)) return { sessions: [], failed: [] };
	try {
		const { scanClineCliSessions } = await import("./ClineCliSessionDiscoverer.js");
		const r = await scanClineCliSessions(cwd);
		if (r.error) {
			log.warn("scanClineCliSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["cline-cli"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanClineCliSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["cline-cli"] };
	}
}

async function loadDevin(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	if (!isSourceEnabled("devin", config)) return { sessions: [], failed: [] };
	try {
		const { scanDevinSessions } = await import("./DevinSessionDiscoverer.js");
		const r = await scanDevinSessions(cwd);
		if (r.error) {
			log.warn("scanDevinSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["devin"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanDevinSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["devin"] };
	}
}

async function loadCursorCli(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	// cursor-agent CLI currently shares cursorEnabled with the Cursor IDE Composer source. Both
	// paths go through `isSourceEnabled`, so a future split that maps "cursor-cli" to its own flag
	// needs only one edit.
	if (!isSourceEnabled("cursor-cli", config)) return { sessions: [], failed: [] };
	try {
		const { scanCursorCliSessions } = await import("./CursorCliSessionDiscoverer.js");
		const r = await scanCursorCliSessions(cwd);
		if (r.error) {
			log.warn("scanCursorCliSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["cursor-cli"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanCursorCliSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["cursor-cli"] };
	}
}

async function loadAntigravity(cwd: string, config: JolliMemoryConfig): Promise<LoaderResult> {
	if (!isSourceEnabled("antigravity", config)) return { sessions: [], failed: [] };
	try {
		const { scanAntigravitySessions } = await import("./AntigravitySessionDiscoverer.js");
		const r = await scanAntigravitySessions(cwd);
		if (r.error) {
			log.warn("scanAntigravitySessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["antigravity"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanAntigravitySessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["antigravity"] };
	}
}
