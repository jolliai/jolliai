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
import { type DiskSession, sessionsForRepo } from "./DiskSessionScan.js";
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
 * Every directory a Devin session recorded: its primary `working_directory` first,
 * then each of its additional `workspace_dirs`.
 *
 * Both halves matter. A session started from an attached workspace/worktree surfaces
 * ONLY through `workspace_dirs`, so a caller that looked at `working_directory` alone
 * would silently drop it. Collecting them into one list is what lets the ordinary
 * "does any recorded directory belong to this repo" rule cover both — see
 * {@link devinSessionsForRepo} for the match itself.
 *
 * A null `working_directory` contributes nothing rather than a null entry: the
 * column is nullable (a session started outside any project), and every consumer
 * downstream expects real strings.
 */
function sessionDirs(workingDirectory: string | null, workspaceDirsRaw: string | null): string[] {
	const dirs = typeof workingDirectory === "string" ? [workingDirectory] : [];
	dirs.push(...parseWorkspaceDirs(workspaceDirsRaw));
	return dirs;
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
 * SQLite. Gated on hasNodeSqliteSupport() so a runtime below the Node floor
 * reports "not installed" rather than "detected but 0 sessions".
 *
 * Deliberately keyed on the DB rather than the looser {@link isDevinPresent}:
 * this drives session discovery and the status tree, where a host with no
 * readable conversations has nothing to show.
 */
export async function isDevinInstalled(): Promise<boolean> {
	if (!hasNodeSqliteSupport()) {
		log.info(
			"Devin support disabled: this runtime is Node %s, requires 22.13+ for built-in SQLite",
			process.versions.node,
		);
		return false;
	}
	return hasDevinSessionDb();
}

/** Does Devin CLI's global session DB exist on disk? */
async function hasDevinSessionDb(): Promise<boolean> {
	try {
		return (await stat(getDevinSessionsDbPath())).isFile();
	} catch {
		return false;
	}
}

/**
 * Pure filesystem presence check for MCP registration: is Devin on this machine
 * at all, regardless of whether THIS runtime can read its DB? Unlike
 * `isDevinInstalled`, this does NOT gate on `hasNodeSqliteSupport()` — MCP
 * registration only writes a config file, so it must work on a VS Code host
 * below the Node floor, where the SQLite gate would otherwise suppress a host
 * the user genuinely has installed.
 *
 * Accepts the CLI's data DIRECTORY, not just `sessions.db`, because MCP is
 * registered only on an explicit `jolli enable` (the SessionStart / plugin
 * bootstrap path runs with `repoHooksOnly`, which short-circuits every detector
 * to false and therefore never self-heals). Keying on the DB alone made the most
 * natural ordering — install Devin, `jolli enable`, then start using it — miss
 * MCP until the user happened to enable a second time. The directory exists from
 * Devin's first run, before any conversation is stored.
 */
export async function isDevinPresent(): Promise<boolean> {
	if (await hasDevinSessionDb()) return true;
	try {
		return (await stat(getDevinCliDir())).isDirectory();
	} catch {
		return false;
	}
}

export interface DevinScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	/** Present only on a genuine failure (not a missing DB). Surface to UI rather than reporting "0 sessions". */
	readonly error?: SqliteScanError;
}

/**
 * Discover Devin sessions for the given project directory (production entrypoint).
 *
 * @param windowMs Optional session-staleness window in milliseconds, defaulting to
 * the 48-hour {@link SESSION_STALE_MS}. Only the dashboard's history back-fill passes
 * a wider one (7 days); every caller that must NOT widen simply omits it — the
 * "Active Conversations" sidebar, `jolli status`, and above all the post-commit
 * summary generation in `hooks/QueueWorker.ts`, which uses this window to decide
 * which conversations belong to the commit being summarised. A wider window there
 * would pull unrelated week-old conversations into that commit's stored memory,
 * which is persisted to the git orphan branch and fails silently — no error, just
 * wrong content.
 */
export async function scanDevinSessions(projectDir: string, windowMs?: number): Promise<DevinScanResult> {
	return scanDevinSessionsAt(getDevinSessionsDbPath(), projectDir, windowMs);
}

/**
 * Discover Devin sessions from an explicit DB path. Split out so tests can point
 * at a fixture DB; production callers use `scanDevinSessions`.
 *
 * @param windowMs Optional staleness window in milliseconds; see
 * {@link scanDevinSessions} for the default and for who may widen it.
 */
export async function scanDevinSessionsAt(
	dbPath: string,
	projectDir: string,
	windowMs?: number,
): Promise<DevinScanResult> {
	const { sessions, error } = await scanDevinSessionsOnDiskAt(dbPath, windowMs);
	const mine = devinSessionsForRepo(sessions, projectDir);
	return error ? { sessions: mine, error } : { sessions: mine };
}

/** A machine-wide Devin scan: every in-window session, plus a genuine failure. */
export interface DevinDiskScanResult {
	readonly sessions: ReadonlyArray<DiskSession>;
	readonly error?: SqliteScanError;
}

/**
 * Scans Devin's global session database once and returns every in-window session,
 * each carrying the directories its row recorded.
 *
 * MACHINE-WIDE and repo-agnostic on purpose. `sessions.db` is ONE database for every
 * project — the `working_directory` column is what scopes a row, not the file's
 * location — so a repo-scoped scan opens it, queries it and re-parses every
 * `workspace_dirs` JSON blob once per registered repo. Callers scan once and narrow
 * with {@link devinSessionsForRepo}.
 */
export async function scanDevinSessionsOnDisk(windowMs?: number): Promise<DevinDiskScanResult> {
	return scanDevinSessionsOnDiskAt(getDevinSessionsDbPath(), windowMs);
}

/**
 * {@link scanDevinSessionsOnDisk} against an explicit DB path, so tests can point at
 * a fixture database.
 */
export async function scanDevinSessionsOnDiskAt(dbPath: string, windowMs?: number): Promise<DevinDiskScanResult> {
	// A runtime below the Node floor cannot load `node:sqlite`. Return a silent
	// empty result — "not supported" is not a scan failure, so callers must not
	// surface a partial-data / failed-source indicator.
	if (!hasNodeSqliteSupport()) {
		log.debug("Devin scan skipped: runtime Node %s lacks node:sqlite (requires 22.13+)", process.versions.node);
		return { sessions: [] };
	}

	const staleMs = windowMs ?? SESSION_STALE_MS;
	const cutoffMs = Date.now() - staleMs;

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

			// The directories are CARRIED, not matched — `devinSessionsForRepo` does that
			// via `sessionDirBelongsToRepo`, which does prefix/containment matching with
			// separator/case folding plus the nested-repo exclusion. The old exact
			// `working_directory = :projectDir` both missed subdirectory sessions and
			// mishandled trailing-slash / backslash paths.
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

			return rows.flatMap((row): DiskSession[] => {
				if (!Number.isFinite(row.last_activity_at)) {
					log.warn("Skipping Devin session %s: non-finite last_activity_at", row.id);
					return [];
				}
				return [
					{
						session: {
							sessionId: String(row.id),
							transcriptPath: `${dbPath}#${row.id}`,
							updatedAt: new Date(row.last_activity_at * 1000).toISOString(),
							source: "devin",
							title: typeof row.title === "string" && row.title.trim().length > 0 ? row.title : undefined,
						},
						dirs: sessionDirs(row.working_directory, row.workspace_dirs),
					},
				];
			});
		});

		log.debug("Devin disk scan: %d session(s) inside the window", sessions.length);
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

/**
 * Narrows a machine-wide Devin scan to one repo.
 *
 * A session belongs to `projectDir` when its primary `working_directory` OR any of
 * its attached `workspace_dirs` is inside the worktree — the same disjunction that
 * ran inside the scan, now expressed as "any recorded directory matches" because
 * {@link sessionDirs} collected both into one list.
 *
 * Matching is prefix/containment via {@link sessionDirBelongsToRepo}, shared with the
 * other hookless directory-scoped sources (OpenCode, Copilot): a session started from
 * a *subdirectory* of the repo — common in a monorepo, e.g. `cd packages/foo && devin
 * …` — IS attributed to the repo (JOLLI-2015). Sessions living in a nested git repo /
 * submodule inside the worktree are excluded so they aren't double-captured by both
 * repos; the helper's docstring has the full rationale.
 */
export function devinSessionsForRepo(
	scanned: ReadonlyArray<DiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	const mine = sessionsForRepo(scanned, (dir) => sessionDirBelongsToRepo(dir, projectDir));
	log.debug("Discovered %d Devin session(s) for %s", mine.length, projectDir);
	return mine;
}

/**
 * Backwards-compatible wrapper returning only the session array.
 *
 * @param windowMs Optional staleness window in milliseconds, forwarded verbatim; see
 * {@link scanDevinSessions} for the default and for who may widen it.
 */
export async function discoverDevinSessions(
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions } = await scanDevinSessions(projectDir, windowMs);
	return sessions;
}
