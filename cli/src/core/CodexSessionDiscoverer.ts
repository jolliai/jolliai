/**
 * Codex Session Discoverer
 *
 * On-demand scanner for OpenAI Codex sessions. Since Codex has no
 * lifecycle hook we can use (the Stop hook needs per-user manual trust and is
 * broken under git worktrees), sessions are discovered by scanning the
 * filesystem. This runs both at post-commit time (for summaries) and on the
 * VS Code sidebar's 60s Active Conversations tick — the latter also drives
 * Codex reference extraction (Linear/Jira/GitHub/Notion) via
 * `CodexDiscovery.discoverCodexConversations`, which reuses the shared
 * `discovery-cursors.json` incremental cursor.
 *
 * Algorithm:
 *   1. Scan ~/.codex/sessions/YYYY/MM/DD/ for recent JSONL files
 *   2. Read only line 1 of each file (session_meta) to extract cwd
 *   3. Match cwd against the project dir via sessionDirBelongsToRepo (prefix/
 *      containment + nested-repo exclusion, shared with Devin/OpenCode/Copilot)
 *   4. Also scan ~/.codex/archived_sessions/ for recently archived sessions
 *   5. Return matching sessions as SessionInfo[] with source="codex"
 *
 * Performance: Only date directories within the 48h staleness window are
 * scanned, avoiding traversal of old session files.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { mapWithConcurrency, withIoBudget } from "../util/Concurrency.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";

const log = createLogger("CodexDiscoverer");

/** Sessions older than 48 hours are considered stale (matches Claude session staleness) */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

/** Base directory for Codex data */
const CODEX_DIR_NAME = ".codex";

/**
 * Discovers Codex sessions relevant to the given project directory.
 * Scans ~/.codex/sessions/ for JSONL files whose session_meta.cwd matches
 * the project directory. Only returns sessions updated within the staleness
 * window (48 hours by default).
 *
 * @param projectDir - The git repository root to match sessions against
 * @param windowMs - Staleness window; defaults to {@link SESSION_STALE_MS}.
 *   The dashboard's history back-fill passes a wider one (7 days). Every caller
 *   that must keep the 48 h horizon simply omits it — the sidebar's Active
 *   Conversations, `jolli status`, and (the one that matters) `QueueWorker`'s
 *   post-commit summary, which decides which conversations belong to the commit
 *   being summarised. Widening THAT would write week-old unrelated conversations
 *   into a commit's stored memory, persistently and with no error anywhere, which
 *   is why the constant above stays a default and never becomes the knob.
 * @returns Array of matching sessions with source="codex"
 */
export async function discoverCodexSessions(
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	return codexSessionsForRepo(await scanCodexSessionsOnDisk(windowMs), projectDir);
}

/** One Codex rollout, as the machine-wide scan understands it. */
export interface CodexDiskSession {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly updatedAt: string;
	/**
	 * The working directory `session_meta` recorded. An array for symmetry with the
	 * other disk scans (Claude collects several per transcript, Devin has a primary
	 * plus an attached list); Codex records exactly one, so it always holds one entry.
	 */
	readonly dirs: ReadonlyArray<string>;
}

/**
 * Scans every Codex rollout on this machine and returns those inside the window,
 * each carrying the working directory it recorded.
 *
 * MACHINE-WIDE and repo-agnostic on purpose. `~/.codex/sessions/` is one global tree
 * keyed by DATE, not by project, so a repo-scoped scan re-reads the first line of
 * every rollout once per registered repo — measured on this machine, 68 ms per repo
 * and 201 ms across three, all of it pure repetition. Callers scan once and narrow
 * with {@link codexSessionsForRepo}.
 */
export async function scanCodexSessionsOnDisk(windowMs?: number): Promise<ReadonlyArray<CodexDiskSession>> {
	const codexBase = join(homedir(), CODEX_DIR_NAME);
	const staleMs = windowMs ?? SESSION_STALE_MS;
	const sessions: CodexDiskSession[] = [];

	// Scan active sessions in date-organized directories
	const sessionsDir = join(codexBase, "sessions");
	sessions.push(...(await scanSessionsDirectory(sessionsDir, staleMs)));

	// Scan archived sessions (flat directory). Unlike the active half this is not
	// date-partitioned, so it needs no directory-range change — only the staleness
	// window reaches it.
	const archivedDir = join(codexBase, "archived_sessions");
	sessions.push(...(await scanFlatDirectory(archivedDir, staleMs)));

	log.debug("Codex disk scan: %d rollout(s) inside the window", sessions.length);
	return sessions;
}

/**
 * Narrows a machine-wide Codex scan to one repo.
 *
 * Attribution is `sessionDirBelongsToRepo`, unchanged from when it ran inside the
 * scan: prefix/containment with case folding plus the nested-repo exclusion, so a
 * rollout started in a SUBDIRECTORY still counts (the exact-equality match this
 * replaced silently dropped every one of those — JOLLI-2015).
 *
 * FILTERS rather than partitions: nested-repo exclusion aside, the same rollout may
 * legitimately be claimed by two registered repos that are two checkouts of one
 * project.
 */
export function codexSessionsForRepo(
	scanned: ReadonlyArray<CodexDiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	const resolvedProject = resolve(projectDir);
	const mine: SessionInfo[] = [];
	for (const session of scanned) {
		if (!session.dirs.some((dir) => sessionDirBelongsToRepo(resolve(dir), resolvedProject))) continue;
		mine.push({
			sessionId: session.sessionId,
			transcriptPath: session.transcriptPath,
			updatedAt: session.updatedAt,
			source: "codex",
		});
	}
	log.debug("Discovered %d Codex session(s) for %s", mine.length, projectDir);
	return mine;
}

/**
 * Checks whether the Codex data directory exists.
 * Used by the Installer to detect Codex presence.
 */
export async function isCodexInstalled(): Promise<boolean> {
	const sessionsDir = join(homedir(), CODEX_DIR_NAME);
	try {
		const dirStat = await stat(sessionsDir);
		return dirStat.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Scans the date-organized ~/.codex/sessions/YYYY/MM/DD/ directory structure.
 * Only traverses date directories within the 48h staleness window.
 */
async function scanSessionsDirectory(sessionsDir: string, staleMs: number): Promise<CodexDiskSession[]> {
	const results: CodexDiskSession[] = [];
	const recentDates = getRecentDateDirs(staleMs);

	let yearDirs: string[];
	try {
		yearDirs = await readdir(sessionsDir);
	} catch {
		log.debug("Codex sessions directory not found: %s", sessionsDir);
		return results;
	}

	for (const year of yearDirs) {
		// Quick filter: only process years that could contain recent sessions
		if (!recentDates.some((d) => d.startsWith(year))) {
			continue;
		}

		const yearPath = join(sessionsDir, year);
		let monthDirs: string[];
		try {
			monthDirs = await readdir(yearPath);
		} catch {
			continue;
		}

		for (const month of monthDirs) {
			const monthKey = `${year}/${month}`;
			if (!recentDates.some((d) => d.startsWith(monthKey))) {
				continue;
			}

			const monthPath = join(yearPath, month);
			let dayDirs: string[];
			try {
				dayDirs = await readdir(monthPath);
			} catch {
				continue;
			}

			for (const day of dayDirs) {
				const dateKey = `${year}/${month}/${day}`;
				if (!recentDates.includes(dateKey)) {
					continue;
				}

				const dayPath = join(monthPath, day);
				const daySessions = await scanFlatDirectory(dayPath, staleMs);
				results.push(...daySessions);
			}
		}
	}

	return results;
}

/**
 * Scans a flat directory for .jsonl files and checks each for cwd match.
 * Used for both day directories (active sessions) and archived_sessions.
 */
async function scanFlatDirectory(dirPath: string, staleMs: number): Promise<CodexDiskSession[]> {
	let files: string[];
	try {
		files = await readdir(dirPath);
	} catch {
		return [];
	}

	// One rollout per file, so the cost of this scan is the number of rollouts a user
	// has — which on a heavy Codex machine is thousands. Fanned out rather than looped
	// because each file is an independent first-line read. Each one takes a slot from
	// the shared budget (see `withIoBudget` inside `tryParseSessionMeta`), so this
	// running alongside eleven other scans still cannot exceed the process-wide total.
	const scanned = await mapWithConcurrency(
		files.filter((file) => file.endsWith(".jsonl")),
		(file) => tryParseSessionMeta(join(dirPath, file), staleMs),
	);
	return scanned.filter((session): session is CodexDiskSession => session !== null);
}

/**
 * Reads only the first line of a Codex JSONL file to extract session_meta.
 * Returns the rollout's facts when it is within the staleness window, or null.
 *
 * Repo attribution is deliberately NOT done here: it belongs to
 * {@link codexSessionsForRepo}, so one scan of this global tree can serve every
 * registered repo instead of being re-run per repo.
 */
async function tryParseSessionMeta(filePath: string, staleMs: number): Promise<CodexDiskSession | null> {
	let firstLine: string;
	try {
		firstLine = await readFirstLine(filePath);
	} catch {
		log.debug("Cannot read Codex session file: %s", filePath);
		return null;
	}

	if (!firstLine) {
		return null;
	}

	try {
		const data = JSON.parse(firstLine) as Record<string, unknown>;

		if (data.type !== "session_meta") {
			log.debug("First line is not session_meta in %s", filePath);
			return null;
		}

		const payload = data.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object") {
			return null;
		}

		const cwd = payload.cwd;
		const id = payload.id;
		const timestamp = typeof data.timestamp === "string" ? data.timestamp : undefined;

		if (typeof cwd !== "string" || typeof id !== "string") {
			return null;
		}

		// Determine session freshness from timestamp or file mtime
		const updatedAt = timestamp ?? (await getFileMtime(filePath));
		if (!updatedAt) {
			return null;
		}

		// Check parseability before staleness. `NaN > staleMs` is false, so an invalid
		// timestamp otherwise looks fresh and escapes the scan with an undateable
		// `SessionInfo`; downstream then counts it as discovered but cannot project it.
		const updatedAtMs = Date.parse(updatedAt);
		if (!Number.isFinite(updatedAtMs)) return null;
		const age = Date.now() - updatedAtMs;
		if (age > staleMs) {
			log.debug("Stale Codex session %s (age: %dh)", id, Math.round(age / 3600000));
			return null;
		}

		// The cwd is carried, not matched. `codexSessionsForRepo` does the matching
		// through `sessionDirBelongsToRepo` (shared with Devin/OpenCode/Copilot):
		// prefix/containment with separator + case folding (handling the Windows
		// "e:\foo" vs "E:\foo" drive-letter drift) plus the nested-repo exclusion. That
		// replaced an exact `resolvedCwd === resolvedProject` match, which silently
		// dropped every session run from a subdirectory of the repo (JOLLI-2015).
		return {
			sessionId: id,
			transcriptPath: filePath,
			updatedAt,
			dirs: [cwd],
		};
	} catch (error: unknown) {
		log.debug("Failed to parse session_meta from %s: %s", filePath, (error as Error).message);
		return null;
	}
}

/**
 * Reads only the first line of a file using a stream (efficient for large files).
 * Closes the stream immediately after reading one line.
 */
function readFirstLine(filePath: string): Promise<string> {
	// Zero bytes claimed: this reads one line, not the file, so it needs a slot (to
	// bound how many rollouts are open at once) and none of the byte allowance.
	return withIoBudget(0, () => readFirstLineUnbudgeted(filePath));
}

function readFirstLineUnbudgeted(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const stream = createReadStream(filePath, { encoding: "utf-8" });
		const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		let resolved = false;

		rl.on("line", (line: string) => {
			resolved = true;
			rl.close();
			stream.destroy();
			resolve(line);
		});

		rl.on("close", () => {
			if (!resolved) {
				resolve("");
			}
		});

		/* v8 ignore start - stream read errors are rare filesystem issues */
		stream.on("error", (err: Error) => {
			if (!resolved) {
				reject(err);
			}
		});
		/* v8 ignore stop */
	});
}

/**
 * Returns the file modification time as an ISO 8601 string.
 * Used as fallback when session_meta lacks a timestamp.
 */
async function getFileMtime(filePath: string): Promise<string | null> {
	try {
		const fileStat = await stat(filePath);
		return fileStat.mtime.toISOString();
	} catch {
		return null;
	}
}

/** One calendar day in ms — the step between Codex's `YYYY/MM/DD` directories. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many `YYYY/MM/DD` directories a staleness window can reach into.
 *
 * `+1` because a window almost never ends at midnight: 48 h measured from noon
 * today reaches back to noon two days ago, which is the THIRD calendar day
 * (today, yesterday, the day before). Dropping the `+1` silently truncates the
 * oldest day of every window.
 *
 * This is the second half of widening the window, and the half that is easy to
 * miss: the staleness check alone is not enough, because a session four days old
 * lives in a directory this traversal would never enter. Passing a 7-day window
 * without widening the range here leaves the parameter purely decorative — with no
 * error, no warning, and a plausible-looking empty result.
 */
function calendarDaySpan(staleMs: number): number {
	return Math.ceil(Math.max(0, staleMs) / ONE_DAY_MS) + 1;
}

/**
 * Returns date directory paths (YYYY/MM/DD format) covering `staleMs`.
 *
 * The parts come from the LOCAL date, which matches how Codex names these
 * directories: a real capture has `~/.codex/sessions/2026/08/11/` holding
 * `rollout-2026-08-11T10-52-15-…jsonl` whose `session_meta.timestamp` is
 * `2026-08-11T02:53:24.548Z` — 02:53 UTC is 10:53 in the machine's UTC+8, so the
 * name is stamped in local time. (Inferred from the filename rather than proven
 * directly: the machine that capture came from had no session spanning a date
 * boundary, so UTC and local dates agreed for every sample.)
 */
function getRecentDateDirs(staleMs: number): string[] {
	const dates: string[] = [];
	const now = new Date();
	const days = calendarDaySpan(staleMs);

	for (let i = 0; i < days; i++) {
		const d = new Date(now.getTime() - i * ONE_DAY_MS);
		const year = String(d.getFullYear());
		const month = String(d.getMonth() + 1).padStart(2, "0");
		const day = String(d.getDate()).padStart(2, "0");
		dates.push(`${year}/${month}/${day}`);
	}

	return dates;
}
