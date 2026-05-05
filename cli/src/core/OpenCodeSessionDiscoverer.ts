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
 *   3. Query the session table for recent top-level sessions matching projectDir
 *   4. Return matching sessions as SessionInfo[] with source="opencode"
 *
 * Cursor design: All sessions share one DB file. To give each session its own
 * cursor key, we use a synthetic transcriptPath: "<globalDbPath>#<sessionId>".
 */

import { stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import {
	classifyScanError as classifySqliteError,
	hasNodeSqliteSupport,
	NODE_SQLITE_MIN_VERSION,
	type SqliteDbHandle,
	type SqliteScanError,
	type SqliteScanErrorKind,
	withSqliteDb,
} from "./SqliteHelpers.js";

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

/** @deprecated use SqliteDbHandle from SqliteHelpers.js */
export type OpenCodeDbHandle = SqliteDbHandle;
/** @deprecated use withSqliteDb from SqliteHelpers.js */
export const withOpenCodeDb = withSqliteDb;
export { NODE_SQLITE_MIN_VERSION, hasNodeSqliteSupport };
/** @deprecated use SqliteScanErrorKind */
export type OpenCodeScanErrorKind = SqliteScanErrorKind;
/** @deprecated use SqliteScanError */
export type OpenCodeScanError = SqliteScanError;
export const classifyScanError = classifySqliteError;

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
	if (!hasNodeSqliteSupport()) {
		// Expected "not applicable", not a failure — log at info so operators
		// can correlate "OpenCode absent from status" with the runtime version.
		log.info(
			"OpenCode support disabled: this runtime is Node %s, requires %d.%d+ for built-in SQLite",
			process.versions.node,
			NODE_SQLITE_MIN_VERSION.major,
			NODE_SQLITE_MIN_VERSION.minor,
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
			// Windows and macOS have case-insensitive filesystems: OpenCode may store
			// directory as "E:\\proj" while Jolli's projectDir arrives lowercased
			// (e.g. VS Code URIs lowercase the drive letter). Compare case-insensitively
			// on those platforms. Linux filesystems are case-sensitive, so exact match
			// is correct there.
			const os = platform();
			const caseInsensitive = os === "win32" || os === "darwin";
			const directoryMatch = caseInsensitive
				? "LOWER(directory) = LOWER(:projectDir)"
				: "directory = :projectDir";

			const rows = db
				.prepare(
					`SELECT id, title, time_created, time_updated
					 FROM session
					 WHERE ${directoryMatch}
					   AND time_updated > :cutoff
					 ORDER BY time_updated DESC`,
				)
				.all({ projectDir, cutoff: cutoffMs }) as ReadonlyArray<{
				id: string;
				title: string;
				time_created: number;
				time_updated: number;
			}>;

			return rows.flatMap((row): SessionInfo[] => {
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
					},
				];
			});
		});

		log.info("Discovered %d OpenCode session(s) for %s", sessions.length, projectDir);
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
