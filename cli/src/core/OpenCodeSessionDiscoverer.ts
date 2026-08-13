/**
 * OpenCode Session Discoverer
 *
 * On-demand scanner for OpenCode sessions. OpenCode stores all data in a
 * global SQLite database at ~/.local/share/opencode/opencode.db. Sessions
 * are scoped to a project via the `directory` column in the `session` table.
 *
 * Algorithm:
 *   1. Check if the global DB file exists at ~/.local/share/opencode/opencode.db
 *   2. Open the DB read-only using node:sqlite (built-in SQLite with WAL support)
 *   3. Query the session table for recent sessions (time cutoff in SQL), then keep
 *      those whose `directory` is inside projectDir via `sessionDirBelongsToRepo`
 *      (prefix/containment + nested-repo exclusion, shared with Devin/Copilot)
 *   4. Return matching sessions as SessionInfo[] with source="opencode"
 *
 * Cursor design: All sessions share one DB file. To give each session its own
 * cursor key, we use a synthetic transcriptPath: "<globalDbPath>#<sessionId>".
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { type DiskSession, sessionsForRepo } from "./DiskSessionScan.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";
import {
	classifyScanError as classifySqliteScanError,
	hasNodeSqliteSupport as hasNodeSqliteSupportFromHelpers,
	NODE_SQLITE_MIN_VERSION as NODE_SQLITE_MIN_VERSION_FROM_HELPERS,
	type SqliteDbHandle,
	type SqliteScanError,
	type SqliteScanErrorKind,
	withSqliteDb,
} from "./SqliteHelpers.js";

/** @deprecated Use SqliteDbHandle from ./SqliteHelpers.js */
export type OpenCodeDbHandle = SqliteDbHandle;

/** @deprecated Use withSqliteDb from ./SqliteHelpers.js */
export const withOpenCodeDb = withSqliteDb;

/** @deprecated Use SqliteScanErrorKind from ./SqliteHelpers.js */
export type OpenCodeScanErrorKind = SqliteScanErrorKind;

/** @deprecated Use SqliteScanError from ./SqliteHelpers.js */
export type OpenCodeScanError = SqliteScanError;

/** @deprecated Use classifyScanError from ./SqliteHelpers.js */
export const classifyScanError = classifySqliteScanError;

/** @deprecated Use hasNodeSqliteSupport from ./SqliteHelpers.js */
export const hasNodeSqliteSupport = hasNodeSqliteSupportFromHelpers;

/** @deprecated Use NODE_SQLITE_MIN_VERSION from ./SqliteHelpers.js */
export const NODE_SQLITE_MIN_VERSION = NODE_SQLITE_MIN_VERSION_FROM_HELPERS;

const log = createLogger("OpenCodeDiscoverer");

/** Sessions older than 48 hours are considered stale (matches other sources) */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

/**
 * Returns the XDG data home directory.
 * Respects the XDG_DATA_HOME environment variable, falling back to ~/.local/share.
 */
function getXdgDataHome(): string {
	return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/**
 * Returns the path to the global OpenCode database file.
 * Respects XDG_DATA_HOME (defaults to ~/.local/share/opencode/opencode.db).
 */
export function getOpenCodeDbPath(): string {
	return join(getXdgDataHome(), "opencode", "opencode.db");
}

/**
 * Checks whether the OpenCode database exists AND the current runtime can
 * actually read it. Returning `false` when the runtime lacks `node:sqlite`
 * prevents the UI from rendering "OpenCode detected & enabled (0 sessions)"
 * on a VS Code host whose Electron Node is too old — where a scan would fail
 * anyway. Keeps the same no-arg shape as `isCodexInstalled`.
 */
export async function isOpenCodeInstalled(): Promise<boolean> {
	if (!hasNodeSqliteSupportFromHelpers()) {
		// Expected "not applicable", not a failure — log at info so operators
		// can correlate "OpenCode absent from status" with the runtime version.
		log.info(
			"OpenCode support disabled: this runtime is Node %s, requires %d.%d+ for built-in SQLite",
			process.versions.node,
			NODE_SQLITE_MIN_VERSION_FROM_HELPERS.major,
			NODE_SQLITE_MIN_VERSION_FROM_HELPERS.minor,
		);
		return false;
	}
	return isOpenCodePresent();
}

/**
 * Pure filesystem presence check: is OpenCode's DB on disk, regardless of
 * whether THIS runtime can read it? Unlike `isOpenCodeInstalled`, this does NOT
 * gate on `hasNodeSqliteSupport()`. Used for MCP registration, which only writes
 * a config file and never reads the DB — so it must work on a VS Code host below
 * the Node floor, where the SQLite gate would otherwise suppress a host that is
 * genuinely installed.
 */
export async function isOpenCodePresent(): Promise<boolean> {
	const dbPath = getOpenCodeDbPath();
	try {
		const fileStat = await stat(dbPath);
		return fileStat.isFile();
	} catch {
		return false;
	}
}

export interface OpenCodeScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	/**
	 * Present only when the scan hit a genuine failure (not ENOENT). Callers
	 * should surface this to the UI rather than silently reporting "0 sessions".
	 */
	readonly error?: OpenCodeScanError;
}

/**
 * Discovers OpenCode sessions relevant to the given project directory.
 * Queries the global ~/.local/share/opencode/opencode.db for recent top-level
 * sessions (within 48h) matching the given project directory.
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
 * @returns { sessions, error? } — sessions is always an array; if `error` is
 *   present and its kind is not "missing", callers should surface it to the user
 *   rather than silently reporting "0 sessions" (which is indistinguishable
 *   from a genuinely-empty scan).
 */
export async function scanOpenCodeSessions(projectDir: string, windowMs?: number): Promise<OpenCodeScanResult> {
	const { sessions, error } = await scanOpenCodeSessionsOnDisk(windowMs);
	const mine = openCodeSessionsForRepo(sessions, projectDir);
	return error ? { sessions: mine, error } : { sessions: mine };
}

/** A machine-wide OpenCode scan: every in-window session, plus a genuine failure. */
export interface OpenCodeDiskScanResult {
	readonly sessions: ReadonlyArray<DiskSession>;
	readonly error?: OpenCodeScanError;
}

/**
 * Scans OpenCode's global database once and returns every session inside the window,
 * each carrying the `directory` its row recorded.
 *
 * MACHINE-WIDE and repo-agnostic on purpose. `~/.local/share/opencode/opencode.db` is
 * ONE database holding every project's sessions, so a repo-scoped scan opens the same
 * file, runs the same query and re-parses the same rows once per registered repo.
 * Callers scan once and narrow with {@link openCodeSessionsForRepo}.
 *
 * The time cutoff stays in SQL — it is the filter that keeps the row set small, and
 * it is repo-independent, so hoisting the scan does not weaken it.
 */
export async function scanOpenCodeSessionsOnDisk(windowMs?: number): Promise<OpenCodeDiskScanResult> {
	const dbPath = getOpenCodeDbPath();
	const staleMs = windowMs ?? SESSION_STALE_MS;
	const cutoffMs = Date.now() - staleMs;

	// Pre-flight: distinguish "DB missing" (silent) from "DB exists but unreadable"
	// (genuine failure) before calling DatabaseSync, which surfaces both as the same
	// "unable to open database file" message.
	try {
		await stat(dbPath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		/* v8 ignore start -- the ENOENT branch is exercised by the "DB is missing" test; the else-branch (EACCES, EPERM, EIO, …) is a rare TOCTOU path that requires a filesystem-level mock to reproduce. The classifier logic itself is fully covered by classifyScanError's unit tests. */
		if (code !== "ENOENT") {
			const scanError = classifyScanError(error);
			if (scanError) {
				log.error("OpenCode DB stat failed (%s): %s", scanError.kind, scanError.message);
				return { sessions: [], error: scanError };
			}
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.debug("OpenCode DB not present at %s — treating as not installed", dbPath);
		return { sessions: [] };
	}

	try {
		const sessions = await withSqliteDb(dbPath, (db) => {
			// OpenCode stores timestamps as unix milliseconds (INTEGER).
			// Include both top-level and continuation (compacted) sessions for this project.
			// Auto-compact creates child sessions (parent_id != NULL) that carry on the conversation,
			// so filtering to parent_id IS NULL would miss active sessions after compaction.
			//
			// The directory is CARRIED, not matched. `openCodeSessionsForRepo` does the
			// matching through `sessionDirBelongsToRepo` (shared with Devin/Copilot):
			// prefix/containment with separator + case folding (handling the "E:\\proj" vs
			// "e:\\proj" Windows drive-letter drift and case-sensitive Linux) plus the
			// nested-repo exclusion. That replaced the SQL `directory = :projectDir` (and
			// the win32/darwin LOWER() variant), which silently dropped every session run
			// from a subdirectory of the repo (JOLLI-2015). Rows are still narrowed by the
			// time cutoff in SQL, which is repo-independent and so stays here.
			const rows = db
				.prepare(
					// No ORDER BY: every row passing the SQL cutoff and the JS directory filter is
					// kept regardless of order, so sorting the result set would buy nothing.
					`SELECT id, title, time_created, time_updated, directory
					 FROM session
					 WHERE time_updated > :cutoff`,
				)
				.all({ cutoff: cutoffMs }) as ReadonlyArray<{
				id: string;
				title: string;
				time_created: number;
				time_updated: number;
				directory: string;
			}>;

			return rows.flatMap((row): DiskSession[] => {
				// Guard against schema drift: SQL's `time_updated > :cutoff` already
				// filters NULL, but a non-numeric value would make new Date().toISOString()
				// throw RangeError and bubble up as a spurious "unknown" scan error.
				if (!Number.isFinite(row.time_updated)) {
					log.warn("Skipping OpenCode session %s: non-finite time_updated", row.id);
					return [];
				}
				return [
					{
						session: {
							sessionId: String(row.id),
							// Synthetic path: DB path + session discriminator for unique cursor keying
							transcriptPath: `${dbPath}#${row.id}`,
							updatedAt: new Date(row.time_updated).toISOString(),
							source: "opencode",
							title: typeof row.title === "string" && row.title.trim().length > 0 ? row.title : undefined,
						},
						dirs: [row.directory],
					},
				];
			});
		});

		log.debug("OpenCode disk scan: %d session(s) inside the window", sessions.length);
		return { sessions };
	} catch (error: unknown) {
		const scanError = classifyScanError(error);
		/* v8 ignore start -- TOCTOU race: the DB passed stat() but vanished before DatabaseSync opened it. Requires a filesystem-level mock to reproduce; classifier behavior itself is fully covered by classifyScanError's unit tests. */
		if (scanError === null) {
			log.debug("OpenCode DB disappeared between detection and scan: %s", (error as Error).message);
			return { sessions: [] };
		}
		/* v8 ignore stop */
		// Real failure (corrupt DB, schema drift, permission denied, etc.) —
		// isOpenCodeInstalled() already confirmed the file exists, so this is
		// not a silent "no OpenCode". Surface to error log and let callers
		// bubble the classified error up to the UI.
		log.error("OpenCode scan failed (%s): %s", scanError.kind, scanError.message);
		return { sessions: [], error: scanError };
	}
}

/**
 * Narrows a machine-wide OpenCode scan to one repo.
 *
 * Attribution is `sessionDirBelongsToRepo`, verbatim from when it ran inside the
 * scan's `flatMap`: prefix/containment with separator and case folding plus the
 * nested-repo exclusion, so a session run from a SUBDIRECTORY still counts
 * (JOLLI-2015). The helper's own null guard is what keeps a row whose `directory`
 * column is NULL from throwing here — such a session simply matches no repo.
 */
export function openCodeSessionsForRepo(
	scanned: ReadonlyArray<DiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	const mine = sessionsForRepo(scanned, (dir) => sessionDirBelongsToRepo(dir, projectDir));
	log.debug("Discovered %d OpenCode session(s) for %s", mine.length, projectDir);
	return mine;
}

/**
 * Backwards-compatible wrapper around `scanOpenCodeSessions` that only returns
 * the session array. Callers that need to surface scan failures to the user
 * should call `scanOpenCodeSessions` directly.
 *
 * @param windowMs - Forwarded to {@link scanOpenCodeSessions}; see that function for why
 *   the post-commit caller leaves it unset.
 */
export async function discoverOpenCodeSessions(
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions } = await scanOpenCodeSessions(projectDir, windowMs);
	return sessions;
}
