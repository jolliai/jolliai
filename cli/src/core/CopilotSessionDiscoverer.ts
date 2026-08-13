/**
 * GitHub Copilot CLI session discoverer.
 *
 * Copilot stores every session in ~/.copilot/session-store.db. Each session row
 * carries its own `cwd`; attribution is prefix/containment via
 * `sessionDirBelongsToRepo` (shared with Devin/OpenCode), so a session run from a
 * subdirectory of the repo is still captured (JOLLI-2015). Sessions older than
 * 48 hours are excluded — matches the OpenCode / Cursor / Codex convention so a
 * user enabling Copilot for the first time doesn't pull months of history into
 * the next commit summary. Synthetic transcript path: "<dbPath>#<sessionId>".
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getCopilotDbPath } from "./CopilotDetector.js";
import { type DiskSession, sessionsForRepo } from "./DiskSessionScan.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";
import { classifyScanError, type SqliteScanError, withSqliteDb } from "./SqliteHelpers.js";

const log = createLogger("CopilotDiscoverer");

/** Sessions older than 48 hours are considered stale (matches other sources) */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export interface CopilotScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: SqliteScanError;
}

function normalizeCwd(p: string): string {
	return resolve(p);
}

/**
 * Discovers Copilot CLI sessions belonging to the given project directory.
 *
 * @param projectDir - The git repository root to filter sessions by
 * @param windowMs - Optional staleness window in milliseconds. Defaults to
 *   {@link SESSION_STALE_MS} (48 h). The dashboard's history back-fill passes a wider
 *   window (7 d) to recover conversations the database never recorded. Callers that
 *   must NOT widen it omit the argument entirely: the "Active Conversations" sidebar,
 *   `jolli status`, and — the one that matters — the post-commit summary in
 *   `QueueWorker`, which uses this window to decide which conversations belong to the
 *   commit being summarised. That summary is written to the git orphan branch and
 *   kept, so a wider window there quietly attaches week-old unrelated conversations
 *   to a commit's stored memory with no error anywhere.
 */
export async function scanCopilotSessions(projectDir: string, windowMs?: number): Promise<CopilotScanResult> {
	const { sessions, error } = await scanCopilotSessionsOnDisk(windowMs);
	const mine = copilotSessionsForRepo(sessions, projectDir);
	return error ? { sessions: mine, error } : { sessions: mine };
}

/** A machine-wide Copilot CLI scan: every in-window session, plus a genuine failure. */
export interface CopilotDiskScanResult {
	readonly sessions: ReadonlyArray<DiskSession>;
	readonly error?: SqliteScanError;
}

/**
 * Scans Copilot CLI's global session store once and returns every session inside the
 * window, each carrying the `cwd` its row recorded.
 *
 * MACHINE-WIDE and repo-agnostic on purpose. `~/.copilot/session-store.db` is ONE
 * database for every project, and its `updated_at` is TEXT with no usable SQL cutoff
 * — so the query is already a full-table scan. Running that once per registered repo
 * re-reads and re-parses every session row N times over. Callers scan once and narrow
 * with {@link copilotSessionsForRepo}.
 */
export async function scanCopilotSessionsOnDisk(windowMs?: number): Promise<CopilotDiskScanResult> {
	const dbPath = getCopilotDbPath();
	const staleMs = windowMs ?? SESSION_STALE_MS;
	const cutoffMs = Date.now() - staleMs;

	try {
		await stat(dbPath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		/* v8 ignore start -- TOCTOU branch covered by classifier tests */
		if (code !== "ENOENT") {
			const scanError = classifyScanError(error);
			if (scanError) {
				log.error("Copilot DB stat failed (%s): %s", scanError.kind, scanError.message);
				return { sessions: [], error: scanError };
			}
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.debug("Copilot DB not present at %s — treating as not installed", dbPath);
		return { sessions: [] };
	}

	try {
		const sessions = await withSqliteDb(dbPath, (db) => {
			// The cwd is CARRIED, not matched — `copilotSessionsForRepo` does that through
			// `sessionDirBelongsToRepo` (shared with Devin/OpenCode): prefix/containment
			// with separator + case folding plus the nested-repo exclusion. That replaced
			// the SQL `cwd = :cwd` (and its win32/darwin LOWER() variant), which silently
			// dropped every session run from a subdirectory of the repo (JOLLI-2015).
			// updated_at is TEXT with no clean SQL cutoff, so the staleness filter stays
			// JS-side below; it is repo-independent, so it belongs in this scan.
			const rows = db
				.prepare(
					// No ORDER BY: every row passing the directory + staleness filters below is
					// kept regardless of order, so sorting would only add a full-table sort on
					// top of an already-unavoidable full scan (updated_at is TEXT — see above).
					`SELECT id, cwd, repository, branch, host_type, summary, created_at, updated_at
					 FROM sessions`,
				)
				.all() as ReadonlyArray<{ id: string; cwd: string; updated_at: string; summary: unknown }>;
			return rows.flatMap((row): DiskSession[] => {
				const ms = Date.parse(row.updated_at);
				if (!Number.isFinite(ms)) {
					log.warn("Skipping Copilot session %s: non-finite updated_at", row.id);
					return [];
				}
				// JS post-filter rather than SQL `WHERE updated_at > :cutoff` because
				// updated_at is TEXT and SQL `>` would do lexicographic comparison —
				// only valid if every row uses canonical UTC ISO-8601. Filtering after
				// Date.parse tolerates any format Date.parse accepts.
				if (ms < cutoffMs) return [];
				return [
					{
						session: {
							sessionId: String(row.id),
							transcriptPath: `${dbPath}#${row.id}`,
							updatedAt: new Date(ms).toISOString(),
							source: "copilot",
							title:
								typeof row.summary === "string" && row.summary.trim().length > 0
									? row.summary
									: undefined,
						},
						dirs: [row.cwd],
					},
				];
			});
		});
		log.debug("Copilot disk scan: %d session(s) inside the window", sessions.length);
		return { sessions };
	} catch (error: unknown) {
		const scanError = classifyScanError(error);
		/* v8 ignore start -- TOCTOU branch covered by classifier tests */
		if (scanError === null) {
			log.debug("Copilot DB disappeared between detection and scan: %s", (error as Error).message);
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.error("Copilot scan failed (%s): %s", scanError.kind, scanError.message);
		return { sessions: [], error: scanError };
	}
}

/**
 * Narrows a machine-wide Copilot CLI scan to one repo.
 *
 * Attribution is `sessionDirBelongsToRepo` against the RESOLVED project dir — the
 * `normalizeCwd` call is kept on this side because that is exactly where it ran
 * before, on the project argument only and never on the row's own cwd.
 */
export function copilotSessionsForRepo(
	scanned: ReadonlyArray<DiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	const normalized = normalizeCwd(projectDir);
	const mine = sessionsForRepo(scanned, (dir) => sessionDirBelongsToRepo(dir, normalized));
	log.debug("Discovered %d Copilot session(s) for %s", mine.length, normalized);
	return mine;
}

/**
 * Convenience wrapper without the error channel — used by QueueWorker.
 *
 * @param windowMs - Forwarded to {@link scanCopilotSessions}; see that function for why
 *   the post-commit caller leaves it unset.
 */
export async function discoverCopilotSessions(
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanCopilotSessions(projectDir, windowMs);
	if (error) {
		log.warn("Copilot scan error (%s) — sessions excluded from this run: %s", error.kind, error.message);
	}
	return sessions;
}
