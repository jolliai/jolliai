/**
 * Devin CLI Session Discoverer (+ colocated detection)
 *
 * Devin stores every CLI session in a global WAL-mode SQLite at
 *   POSIX (darwin/linux)  <XDG_DATA_HOME|~/.local/share>/devin/cli/sessions.db
 *   win32                 %APPDATA%\devin\cli\sessions.db  (Roaming)
 * WAL is read via Node's native `node:sqlite` (not sql.js), which reads the
 * `-wal`/`-shm` siblings, so a live, un-checkpointed DB reads fine read-only.
 * The `sessions` table carries a direct `working_directory` column, so sessions
 * are scoped to a project the same way OpenCode's `directory` column is —
 * no workspace-hash indirection. `last_activity_at` is epoch SECONDS.
 *
 * Synthetic transcript path: "<dbPath>#<sessionId>" (matches OpenCode/Cursor).
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";
import { classifyScanError, hasNodeSqliteSupport, type SqliteScanError, withSqliteDb } from "./SqliteHelpers.js";

const log = createLogger("DevinDiscoverer");

/** Sessions older than 48 hours are considered stale (matches other sources). */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

/**
 * Parse Devin's `workspace_dirs` column — a JSON array of additional work-dir
 * path strings — into usable paths. Tolerant of null/empty, malformed JSON, a
 * non-array payload, and non-string entries (schema drift): anything unexpected
 * yields no extra dirs rather than throwing, so one bad value never sinks the
 * whole scan.
 */
function parseWorkspaceDirs(raw: string | null): string[] {
	if (typeof raw !== "string" || raw.length === 0) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.filter((d): d is string => typeof d === "string");
}

/**
 * A Devin session belongs to `repoRoot` when its primary `working_directory` OR
 * any of its additional `workspace_dirs` is inside the repo worktree. Sessions
 * started from an attached workspace/worktree surface only through
 * `workspace_dirs`, so matching on `working_directory` alone silently drops them.
 *
 * Matching is prefix/containment via {@link sessionDirBelongsToRepo}, shared with
 * the other hookless directory-scoped sources (OpenCode, Copilot): a session
 * started from a *subdirectory* of the repo — common in a monorepo, e.g.
 * `cd packages/foo && devin …` — IS attributed to the repo (JOLLI-2015).
 * Sessions living in a nested git repo / submodule inside the worktree are
 * excluded so they aren't double-captured by both repos — the helper's docstring
 * has the full rationale.
 */
function sessionMatchesDir(
	workingDirectory: string | null,
	workspaceDirsRaw: string | null,
	repoRoot: string,
): boolean {
	if (typeof workingDirectory === "string" && sessionDirBelongsToRepo(workingDirectory, repoRoot)) {
		return true;
	}
	return parseWorkspaceDirs(workspaceDirsRaw).some((dir) => sessionDirBelongsToRepo(dir, repoRoot));
}

function getDevinCliDir(home?: string): string {
	// Mirror the other SQLite-backed discoverers (OpenCode/Cursor/…): resolve `~`
	// via node:os `homedir()`, not `process.env.HOME`. On native Windows HOME is
	// usually unset and homedir() is the only reliable source; in the minimal env
	// of a detached post-commit hook HOME can be missing on POSIX too.
	const base = home ?? homedir();
	// Devin's per-OS data dir (verified against a real install on each OS):
	//   win32           %APPDATA%\devin\cli   (Roaming; fallback ~/AppData/Roaming)
	//   darwin / linux  $XDG_DATA_HOME/devin/cli   or   ~/.local/share/devin/cli
	// darwin uses the XDG layout too (~/.local/share/devin/cli), NOT
	// ~/Library/Application Support — so it shares the POSIX branch, unlike the
	// VS Code-family resolver. Windows Devin does not consult XDG_DATA_HOME, so
	// neither do we there; without this branch isDevinInstalled() is always false
	// on Windows and the source silently never appears in the status tree.
	if (process.platform === "win32") {
		return join(process.env.APPDATA ?? join(base, "AppData", "Roaming"), "devin", "cli");
	}
	const xdg = process.env.XDG_DATA_HOME;
	const posixBase = xdg && xdg.length > 0 ? xdg : join(base, ".local", "share");
	return join(posixBase, "devin", "cli");
}

/** Absolute path to Devin CLI's global session database. */
export function getDevinSessionsDbPath(home?: string): string {
	return join(getDevinCliDir(home), "sessions.db");
}

/**
 * Devin is "installed" when its session DB exists AND the runtime can read
 * SQLite. Gated on hasNodeSqliteSupport() so Node 18 VS Code hosts report
 * "not installed" rather than "detected but 0 sessions".
 */
export async function isDevinInstalled(): Promise<boolean> {
	if (!hasNodeSqliteSupport()) {
		log.info(
			"Devin support disabled: this runtime is Node %s, requires 22.5+ for built-in SQLite",
			process.versions.node,
		);
		return false;
	}
	try {
		return (await stat(getDevinSessionsDbPath())).isFile();
	} catch {
		return false;
	}
}

export interface DevinScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	/** Present only on a genuine failure (not a missing DB). Surface to UI rather than reporting "0 sessions". */
	readonly error?: SqliteScanError;
}

/** Discover Devin sessions for the given project directory (production entrypoint). */
export async function scanDevinSessions(projectDir: string): Promise<DevinScanResult> {
	return scanDevinSessionsAt(getDevinSessionsDbPath(), projectDir);
}

/**
 * Discover Devin sessions from an explicit DB path. Split out so tests can point
 * at a fixture DB; production callers use `scanDevinSessions`.
 */
export async function scanDevinSessionsAt(dbPath: string, projectDir: string): Promise<DevinScanResult> {
	// Node 18 hosts (the VS Code extension bundle) lack `node:sqlite`. Return a
	// silent empty result — "not supported" is not a scan failure, so callers
	// must not surface a partial-data / failed-source indicator for it.
	if (!hasNodeSqliteSupport()) {
		log.debug("Devin scan skipped: runtime Node %s lacks node:sqlite (requires 22.5+)", process.versions.node);
		return { sessions: [] };
	}

	const cutoffMs = Date.now() - SESSION_STALE_MS;

	// Pre-flight: "DB missing" (silent) vs "DB unreadable" (genuine failure).
	try {
		await stat(dbPath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		/* v8 ignore start -- ENOENT covered by the "DB missing" test; other codes (EACCES/EPERM/EIO) need a filesystem mock. classifyScanError is unit-tested separately. */
		if (code !== "ENOENT") {
			const scanError = classifyScanError(error);
			if (scanError) {
				log.error("Devin DB stat failed (%s): %s", scanError.kind, scanError.message);
				return { sessions: [], error: scanError };
			}
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.debug("Devin DB not present at %s — treating as not installed", dbPath);
		return { sessions: [] };
	}

	try {
		const sessions = await withSqliteDb(dbPath, (db) => {
			// last_activity_at is epoch SECONDS → compare against cutoff in seconds.
			const cutoffSec = Math.floor(cutoffMs / 1000);

			// The directory match runs in JS (not SQL) via `sessionDirBelongsToRepo`,
			// which does prefix/containment matching with separator/case folding plus
			// the nested-repo exclusion. The old exact `working_directory = :projectDir`
			// both missed subdirectory sessions and mishandled trailing-slash / backslash
			// paths.
			const rows = db
				.prepare(
					// No ORDER BY: every row passing the SQL filters and the JS directory match is
					// kept regardless of order, so sorting the result set would buy nothing.
					`SELECT id, title, last_activity_at, working_directory, workspace_dirs
					 FROM sessions
					 WHERE hidden = 0
					   AND last_activity_at > :cutoff`,
				)
				.all({ cutoff: cutoffSec }) as ReadonlyArray<{
				id: string;
				title: string | null;
				last_activity_at: number;
				working_directory: string | null;
				workspace_dirs: string | null;
			}>;

			return rows.flatMap((row): SessionInfo[] => {
				if (!sessionMatchesDir(row.working_directory, row.workspace_dirs, projectDir)) {
					return [];
				}
				if (!Number.isFinite(row.last_activity_at)) {
					log.warn("Skipping Devin session %s: non-finite last_activity_at", row.id);
					return [];
				}
				return [
					{
						sessionId: String(row.id),
						transcriptPath: `${dbPath}#${row.id}`,
						updatedAt: new Date(row.last_activity_at * 1000).toISOString(),
						source: "devin",
						title: typeof row.title === "string" && row.title.trim().length > 0 ? row.title : undefined,
					},
				];
			});
		});

		log.debug("Discovered %d Devin session(s) for %s", sessions.length, projectDir);
		return { sessions };
	} catch (error: unknown) {
		const scanError = classifyScanError(error);
		/* v8 ignore start -- TOCTOU: DB passed stat() but vanished before open. classifyScanError covered by its own unit tests. */
		if (scanError === null) {
			log.debug("Devin DB disappeared between detection and scan: %s", (error as Error).message);
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.error("Devin scan failed (%s): %s", scanError.kind, scanError.message);
		return { sessions: [], error: scanError };
	}
}

/** Backwards-compatible wrapper returning only the session array. */
export async function discoverDevinSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions } = await scanDevinSessions(projectDir);
	return sessions;
}
