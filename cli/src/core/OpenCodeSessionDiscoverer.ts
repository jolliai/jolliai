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
 * @returns { sessions, error? } — sessions is always an array; if `error` is
 *   present and its kind is not "missing", callers should surface it to the user
 *   rather than silently reporting "0 sessions" (which is indistinguishable
 *   from a genuinely-empty scan).
 */
export async function scanOpenCodeSessions(projectDir: string): Promise<OpenCodeScanResult> {
	const dbPath = getOpenCodeDbPath();
	const cutoffMs = Date.now() - SESSION_STALE_MS;

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
			// The directory match runs in JS via `sessionDirBelongsToRepo` (shared with
			// Devin/Copilot): prefix/containment with separator + case folding (handling
			// the "E:\\proj" vs "e:\\proj" Windows drive-letter drift and case-sensitive
			// Linux) plus the nested-repo exclusion. It replaced the SQL `directory =
			// :projectDir` (and the win32/darwin LOWER() variant), which silently dropped
			// every session run from a subdirectory of the repo (JOLLI-2015). Rows are
			// still narrowed by the time cutoff in SQL; the directory filter is JS-side.
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

			return rows.flatMap((row): SessionInfo[] => {
				if (!sessionDirBelongsToRepo(row.directory, projectDir)) {
					return [];
				}
				// Guard against schema drift: SQL's `time_updated > :cutoff` already
				// filters NULL, but a non-numeric value would make new Date().toISOString()
				// throw RangeError and bubble up as a spurious "unknown" scan error.
				if (!Number.isFinite(row.time_updated)) {
					log.warn("Skipping OpenCode session %s: non-finite time_updated", row.id);
					return [];
				}
				return [
					{
						sessionId: String(row.id),
						// Synthetic path: DB path + session discriminator for unique cursor keying
						transcriptPath: `${dbPath}#${row.id}`,
						updatedAt: new Date(row.time_updated).toISOString(),
						source: "opencode",
						title: typeof row.title === "string" && row.title.trim().length > 0 ? row.title : undefined,
					},
				];
			});
		});

		log.debug("Discovered %d OpenCode session(s) for %s", sessions.length, projectDir);
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
 * Backwards-compatible wrapper around `scanOpenCodeSessions` that only returns
 * the session array. Callers that need to surface scan failures to the user
 * should call `scanOpenCodeSessions` directly.
 */
export async function discoverOpenCodeSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions } = await scanOpenCodeSessions(projectDir);
	return sessions;
}
