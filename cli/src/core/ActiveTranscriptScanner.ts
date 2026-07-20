/**
 * ActiveTranscriptScanner — lists the *recent, in-flight* AI coding sessions for
 * one or more repo worktrees, so a host (the desktop cockpit's Conversations
 * panel) can show "what am I working on right now" without the live
 * StopHook / sessions.json / QueueWorker-cursor machinery.
 *
 * It reuses the exact on-disk scan the historical back-fill already uses
 * (`scanClaudeTranscripts` + `cwdInRoots`), then projects each session down to
 * the conversational shape a summarizer consumes: merged human/assistant
 * entries, the branch the work happened on, and an activity window. This is the
 * same conversational-turn extraction the live pipeline uses (the raw scanner
 * runs `parseTranscriptLine`), so a memory generated from these entries matches
 * what a live commit would have captured.
 *
 * Claude Code only for now — it composes `RawTranscriptScanner`, which is
 * Claude-only (`source: "claude"`). The shape leaves room for other sources
 * later. (RawTranscriptScanner lives under `backfill/` today; if a future phase
 * wants strict layering it can be hoisted into `core/` and re-exported — there
 * is no cycle: the scanner depends only on `core/` primitives.)
 */

import { cwdInRoots, type RawEntry, scanClaudeTranscripts } from "../backfill/RawTranscriptScanner.js";
import type { TranscriptEntry, TranscriptSource } from "../Types.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

/** One recently-active session, projected for a session-list UI + summarizer input. */
export interface ActiveSession {
	readonly sessionId: string;
	/** Absolute path to the JSONL transcript this session was read from. */
	readonly transcriptPath: string;
	/** Source integration — fixed to `"claude"` today (see file header). */
	readonly source: TranscriptSource;
	/** Merged conversational turns (human/assistant), chronological — feeds the summarizer. */
	readonly entries: ReadonlyArray<TranscriptEntry>;
	/** The git branch the session was on (most recent non-empty value seen). */
	readonly gitBranch?: string;
	/** ISO timestamp of the earliest activity in the session, when known. */
	readonly firstActivity?: string;
	/** ISO timestamp of the latest activity in the session, when known. */
	readonly lastActivity?: string;
	/** Count of human-role turns — a rough "how much did the user drive this" signal. */
	readonly humanTurns: number;
}

export interface ActiveTranscriptScan {
	readonly sessions: ReadonlyArray<ActiveSession>;
}

export interface ScanActiveTranscriptsOptions {
	/**
	 * Keep only sessions whose latest activity falls within this window (ms)
	 * before the newest session's activity. Derived from the newest session (not
	 * wall-clock) so the window is stable and testable without a clock. Omitted →
	 * every scoped session.
	 */
	readonly sinceMs?: number;
	/** Cap to the N most-recently-active sessions (applied after `sinceMs`). */
	readonly limit?: number;
	/** Override `~/.claude/projects` (tests inject a temp dir). */
	readonly projectsRoot?: string;
	/**
	 * Optional pre-filter on the project DIRECTORY name (the encoded cwd Claude
	 * Code names each `~/.claude/projects/<dir>` after). Directories it rejects
	 * are skipped without being read — a pure performance narrowing for a caller
	 * scoped to a single repo/worktree that wants to avoid parsing every
	 * unrelated project's transcripts. `repoRoots`' `cwd` predicate still gates
	 * every entry, so an over-inclusive filter never changes results; omitting it
	 * keeps the whole-tree scan.
	 */
	readonly dirFilter?: (dirName: string) => boolean;
}

/**
 * Scan on-disk Claude transcripts for the given repo worktrees and return the
 * recently-active sessions, newest-active first. A session with only tool
 * activity (no human/assistant turns) is dropped — it isn't a "conversation".
 */
export async function scanActiveTranscripts(
	repoRoots: ReadonlyArray<string>,
	opts?: ScanActiveTranscriptsOptions,
): Promise<ActiveTranscriptScan> {
	if (repoRoots.length === 0) return { sessions: [] };

	const bySession = await scanClaudeTranscripts(cwdInRoots(repoRoots), opts?.projectsRoot, opts?.dirFilter);

	const sessions: ActiveSession[] = [];
	for (const [sessionId, raw] of bySession) {
		const built = buildSession(sessionId, raw);
		if (built) sessions.push(built);
	}

	// Newest-active first (empty lastActivity sorts last).
	sessions.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));

	let filtered: ActiveSession[] = sessions;
	if (opts?.sinceMs && opts.sinceMs > 0 && sessions.length > 0) {
		const newest = Date.parse(sessions[0].lastActivity ?? "");
		if (!Number.isNaN(newest)) {
			const cutoff = newest - opts.sinceMs;
			filtered = sessions.filter((s) => {
				const t = Date.parse(s.lastActivity ?? "");
				return Number.isNaN(t) ? false : t >= cutoff;
			});
		}
	}
	if (opts?.limit && opts.limit > 0) filtered = filtered.slice(0, opts.limit);

	return { sessions: filtered };
}

/**
 * Fold a session's raw scanned lines (chronological ascending) into an
 * {@link ActiveSession}. Returns null when the session has no conversational
 * content. `gitBranch` takes the last non-empty value (most recent, since raw is
 * ascending); the activity window spans the first/last timestamped line.
 */
function buildSession(sessionId: string, raw: ReadonlyArray<RawEntry>): ActiveSession | null {
	const convo: TranscriptEntry[] = [];
	let transcriptPath = "";
	let gitBranch: string | undefined;
	let firstActivity: string | undefined;
	let lastActivity: string | undefined;

	for (const e of raw) {
		if (e.transcriptPath) transcriptPath = e.transcriptPath;
		if (e.gitBranch) gitBranch = e.gitBranch;
		if (e.ts) {
			if (!firstActivity) firstActivity = e.ts;
			lastActivity = e.ts;
		}
		if (e.role && typeof e.content === "string" && e.content.length > 0) {
			convo.push({ role: e.role, content: e.content, timestamp: e.ts });
		}
	}

	if (convo.length === 0) return null;
	const entries = mergeConsecutiveEntries(convo);
	const humanTurns = entries.reduce((n, e) => (e.role === "human" ? n + 1 : n), 0);

	return { sessionId, transcriptPath, source: "claude", entries, gitBranch, firstActivity, lastActivity, humanTurns };
}
