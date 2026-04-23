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
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";

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
 * Database handle shape passed to `withOpenCodeDb` callbacks.
 *
 * Structurally typed against node:sqlite's DatabaseSync rather than importing
 * the type directly, so the module is not loaded until the helper runs — this
 * keeps the ExperimentalWarning out of every PostCommitHook invocation that
 * only transitively imports this file.
 */
export interface OpenCodeDbHandle {
	prepare(sql: string): {
		all(params?: Record<string, unknown> | unknown, ...rest: unknown[]): unknown[];
		get(params?: Record<string, unknown> | unknown, ...rest: unknown[]): unknown;
		run(params?: Record<string, unknown> | unknown, ...rest: unknown[]): unknown;
	};
	close(): void;
}

/**
 * Opens the OpenCode SQLite database read-only, runs a callback, then closes it.
 *
 * Uses Node's built-in `node:sqlite` (statically-linked SQLite; full WAL support).
 * The module is imported dynamically so the ExperimentalWarning only appears
 * when this helper is actually invoked — not when PostCommitHook merely
 * transitively imports this file.
 */
export async function withOpenCodeDb<T>(dbPath: string, fn: (db: OpenCodeDbHandle) => T): Promise<T> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return fn(db as unknown as OpenCodeDbHandle);
	} finally {
		db.close();
	}
}

/**
 * Returns the path to the global OpenCode database file.
 * Respects XDG_DATA_HOME (defaults to ~/.local/share/opencode/opencode.db).
 */
export function getOpenCodeDbPath(): string {
	return join(getXdgDataHome(), "opencode", "opencode.db");
}

/**
 * Minimum Node version that ships `node:sqlite`. OpenCode support requires this
 * built-in module; older runtimes cannot load it even if the DB file is present.
 *
 * Exported for unit tests; callers should use `isOpenCodeInstalled()`.
 */
export const NODE_SQLITE_MIN_VERSION = { major: 22, minor: 5 } as const;

/**
 * Returns true when the current runtime can load `node:sqlite`. Compares the
 * major.minor of `process.versions.node` against NODE_SQLITE_MIN_VERSION
 * rather than doing a live probe, which would emit the ExperimentalWarning on
 * matching runtimes and defeat the lazy-import pattern used by `withOpenCodeDb`.
 */
export function hasNodeSqliteSupport(nodeVersion: string = process.versions.node): boolean {
	const match = /^(\d+)\.(\d+)/.exec(nodeVersion);
	/* v8 ignore start -- process.versions.node is always well-formed semver in supported runtimes; guard is purely defensive */
	if (!match) return false;
	/* v8 ignore stop */
	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	if (major > NODE_SQLITE_MIN_VERSION.major) return true;
	if (major < NODE_SQLITE_MIN_VERSION.major) return false;
	return minor >= NODE_SQLITE_MIN_VERSION.minor;
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

/**
 * Classifies a real OpenCode scan failure into a user-facing severity. Only
 * *genuine* failures are represented here — ENOENT is excluded because an
 * OpenCode DB that's absent between `isOpenCodeInstalled()` and our read
 * is indistinguishable from "not installed" and should stay silent.
 *
 * - `corrupt` — SQLite reports SQLITE_CORRUPT / SQLITE_NOTADB. The file exists
 *   but is unreadable. Users should know.
 * - `locked` — another process holds an exclusive lock (SQLITE_BUSY). Transient,
 *   but worth surfacing if it persists.
 * - `permission` — EACCES / EPERM / SQLITE_CANTOPEN opening the DB. Users
 *   should know.
 * - `schema` — the expected table or column is missing. Likely OpenCode version
 *   drift; users should know so we can support the new schema.
 * - `unknown` — anything else. Surface as a generic "OpenCode scan failed" warning.
 */
export type OpenCodeScanErrorKind = "corrupt" | "locked" | "permission" | "schema" | "unknown";

export interface OpenCodeScanError {
	readonly kind: OpenCodeScanErrorKind;
	readonly message: string;
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
 * Returns null if the error is ENOENT (treat as "not installed" — silent).
 * Exported for unit testing; callers should use `scanOpenCodeSessions`.
 */
export function classifyScanError(error: unknown): OpenCodeScanError | null {
	const err = error as (Error & { code?: string }) | undefined;
	const message = err?.message ?? String(error);
	const code = err?.code;
	if (code === "ENOENT") return null;
	if (code === "EACCES" || code === "EPERM") return { kind: "permission", message };
	// node:sqlite surfaces low-level SQLite error codes in the message
	// (e.g. "SQLITE_CORRUPT: database disk image is malformed").
	if (/SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database/i.test(message)) {
		return { kind: "corrupt", message };
	}
	if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message)) {
		return { kind: "locked", message };
	}
	if (/no such table|no such column/i.test(message)) {
		return { kind: "schema", message };
	}
	if (/SQLITE_CANTOPEN|unable to open/i.test(message)) {
		return { kind: "permission", message };
	}
	return { kind: "unknown", message };
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
		const sessions = await withOpenCodeDb(dbPath, (db) => {
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
			const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
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
