/**
 * The shared shape of a machine-wide session scan, and the one step every source's
 * per-repo narrowing has in common.
 *
 * ## Why every hookless source has a scan/narrow pair
 *
 * None of these stores is keyed by repo. Kimi hashes the working directory into a
 * bucket name it does not document, Codex partitions by DATE, OpenCode / Copilot CLI
 * / Devin keep one global SQLite for every project, Cline keeps one
 * `taskHistory.json` per editor flavour, and the VS Code-family sources key on a
 * workspace hash that can only be resolved by reading every `workspace.json`. So
 * "which sessions belong to this repo" is never answerable from a path — only by
 * opening the records and reading the directory each one recorded.
 *
 * A repo-scoped scan therefore re-reads the SAME records once per registered repo.
 * That was measured on a machine with three repos where only two of these sources
 * were installed (Claude 36 ms + 464 ms per repo; Codex 68 ms per repo, 201 ms across
 * three) — and the measurement understated the problem, because the other nine
 * sources were absent from that machine and each returned on its first `readdir`. A
 * developer who actually runs Cursor, Copilot and Cline pays a full SQLite open, a
 * full-table scan and a JSON parse of every task history once per repo, on every
 * dashboard pass. "Absent on the profiling machine" is not evidence about the
 * machines this ships to.
 *
 * The fix is the same in every case: scan the store ONCE for the whole run, carrying
 * each session's directory evidence, then narrow per repo in memory.
 *
 * ## What this module deliberately does NOT own
 *
 * It does not own attribution. Each source keeps its own rule, spelled as a predicate
 * in its own file and passed to {@link sessionsForRepo} as a closure. That is the
 * whole design: the rules are genuinely different, and turning them into shared DATA
 * — a flag, a mode enum, a "match style" string — is the exact move this module's
 * history warns about. Three live examples of how little they have in common:
 *
 *  - Codex / Kimi / OpenCode / Copilot CLI / Devin match by prefix containment, so a
 *    session started in a SUBDIRECTORY counts (JOLLI-2015) and a nested git repo's
 *    own sessions are excluded.
 *  - Cursor CLI / Cline / Cline CLI match by exact path equality, so a subdirectory
 *    session does NOT count. That is the known, intentional limit of sources whose
 *    records carry a workspace root rather than a cwd.
 *  - Devin matches a primary `working_directory` OR any entry of an attached
 *    `workspace_dirs` array; Antigravity matches one recorded workspace against EVERY
 *    worktree root of the repo, which needs a `git worktree list` the scan cannot do.
 *
 * Keeping each predicate in its source's file means this change moved WHEN a rule
 * runs, never WHAT it says.
 *
 * ## Filtering, not partitioning
 *
 * {@link sessionsForRepo} filters. A session may legitimately be claimed by two
 * registered repos — two clones of one project, or two worktrees of it — and
 * assigning each session to exactly one would silently drop it from the other. Not
 * hypothetical: measured on real Claude transcripts, 27 of 64 carried more than one
 * working directory.
 */

import type { SessionInfo, TranscriptSource } from "../Types.js";

/**
 * "The database already holds this session at or past this instant" — asked by a
 * scanner BEFORE it pays for an expensive read, and by the collector before it pays
 * for a transcript parse.
 *
 * Declared here rather than in the dashboard because the scanners live in `core/`
 * and must not import from `dashboard/`. Only the ANSWER is dashboard-shaped; the
 * question is just "have I already got this?".
 *
 * A scanner that consults this must still return the session, with whatever facts it
 * could gather cheaply. Dropping it instead would make the run's own count of
 * discovered conversations shrink on every converged pass, so a repeat run would
 * report "0 conversations found" — which is the confusion the reported count exists
 * to prevent.
 */
export type AlreadyCurrent = (source: TranscriptSource, sessionId: string, updatedAtMs: number) => boolean;

/**
 * One session found by a machine-wide scan, plus the directory evidence that decides
 * which repo owns it.
 *
 * The session is carried FULLY BUILT rather than as loose fields. Every source has
 * its own rules for the id, the synthetic transcript path and the native title, and
 * those belong next to the store they read — re-deriving them at narrow time would be
 * a second place to get them wrong. What a machine-wide scan genuinely cannot decide
 * is repo ownership, and that is exactly what {@link dirs} carries.
 */
export interface DiskSession {
	readonly session: SessionInfo;
	/**
	 * Every directory this session recorded, in the source's own order.
	 *
	 * Plural because a session is not always one directory: Claude follows the user
	 * across `cd`, and Devin carries a primary `working_directory` plus an array of
	 * attached `workspace_dirs` — matching only the first silently drops every session
	 * started from an attached worktree.
	 *
	 * A source that records exactly one directory still uses a one-element array, so
	 * every narrowing reads the same shape.
	 *
	 * Empty means "this session recorded no usable directory". Such a session matches
	 * nothing, which is correct: it cannot be attributed, and the alternative — no
	 * directories therefore no objection therefore claimed by everyone — would attach
	 * it to every repo on the machine.
	 */
	readonly dirs: ReadonlyArray<string>;
}

/**
 * Narrows a machine-wide scan to the sessions whose directory evidence satisfies
 * `matches`.
 *
 * `matches` is the CALLER's attribution rule, passed as a closure so it stays in the
 * source's own file — see this module's header for why that is the point rather than
 * an omission. It is called per recorded directory and the session is kept on the
 * first one that answers true, which is what makes a multi-directory session (Claude
 * after a `cd`, Devin with attached workspaces) attach to the repo it touched.
 *
 * A predicate that throws is a programming error and propagates: every real rule here
 * is a pure path comparison, so a throw means the closure captured something it
 * should not have, and swallowing it would silently drop sessions.
 */
export function sessionsForRepo(
	scanned: ReadonlyArray<DiskSession>,
	matches: (dir: string) => boolean,
): ReadonlyArray<SessionInfo> {
	return scanned.filter((entry) => entry.dirs.some(matches)).map((entry) => entry.session);
}
