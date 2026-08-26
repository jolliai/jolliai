/**
 * Hermes Agent Session Discoverer (+ colocated detection)
 *
 * Hermes Agent (NousResearch) keeps every conversation — CLI, TUI and each
 * messaging-gateway platform — in ONE global WAL-mode SQLite:
 *   POSIX (darwin/linux)  <HERMES_HOME|~/.hermes>/state.db
 *   win32                 <HERMES_HOME|%LOCALAPPDATA%\hermes>\state.db
 * verified against a live v0.20.5 install and against `hermes_constants.py`
 * (`_get_platform_default_hermes_home`). WAL is read through Node's native
 * `node:sqlite`, which reads the `-wal`/`-shm` siblings, so a live database
 * reads fine read-only.
 *
 * ## Scoping: two columns, and Hermes' own rule
 *
 * The `sessions` table carries BOTH a `cwd` and a `git_repo_root`, so unlike the
 * workspace-hash sources no indirection is needed. Hermes scopes its own
 * workspace queries with `git_repo_root = ? OR (git_repo_root IS EMPTY AND cwd
 * matches)` (`hermes_state.py`), and this discoverer reproduces that by CARRYING
 * both directories and letting {@link sessionsForRepo}'s "any recorded directory
 * matches" do the disjunction — the same shape Devin's primary
 * `working_directory` + attached `workspace_dirs` uses.
 *
 * Carrying both rather than preferring one is deliberate and slightly more
 * forgiving than Hermes' own rule: `--in DIR` / `--no-restore-cwd` can resume a
 * session in a directory other than the one its `git_repo_root` was derived
 * from, and `sessionsForRepo` FILTERS rather than partitions, so a session that
 * legitimately touched two repos is claimed by both instead of being lost by
 * one. On this install `git_repo_root` was NULL on every row (it is populated
 * lazily — note the `git_metadata_generation` column), which is exactly why the
 * `cwd` half cannot be dropped.
 *
 * ## Profiles are scanned, because reporting zero is worse than a readdir
 *
 * `hermes profile` gives a user several isolated instances, each with its OWN
 * home under `<home>/profiles/<name>/` — so a user who works in a named profile
 * has an empty `~/.hermes/state.db` and all their conversations one level down.
 * Reading only the default home would report "this agent found no sessions",
 * which every surface renders as a positive fact about the user's usage. The
 * cost of being right is one `readdir` of a directory that usually does not
 * exist.
 *
 * Synthetic transcript path: "<dbPath>#<sessionId>" (matches OpenCode / Cursor /
 * Devin), which also keeps two profiles' sessions addressable apart.
 *
 * @see file://./HermesTranscriptReader.ts for the conversation read.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { type DiskSession, sessionsForRepo } from "./DiskSessionScan.js";
import { hermesHomeDir } from "./HermesConfigPaths.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";
import { classifyScanError, hasNodeSqliteSupport, type SqliteScanError, withSqliteDb } from "./SqliteHelpers.js";

const log = createLogger("HermesDiscoverer");

/** Sessions older than 48 hours are considered stale (matches other sources). */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

/**
 * Hermes' home directory.
 *
 * Resolution mirrors `hermes_constants.get_hermes_home()`: the `HERMES_HOME`
 * env var wins, otherwise the platform-native default. Hermes' context-local
 * override is a per-task in-process thing with no on-disk trace, so it has no
 * equivalent here.
 *
 * `~` is resolved via node:os `homedir()`, not `process.env.HOME` — on native
 * Windows HOME is usually unset, and in the minimal env of a detached
 * post-commit hook it can be missing on POSIX too.
 */
export function getHermesHomeDir(home?: string): string {
	return hermesHomeDir(process.env, home ?? homedir(), process.platform);
}

/** Absolute path to Hermes' default-profile state database. */
export function getHermesStateDbPath(home?: string): string {
	return join(getHermesHomeDir(home), "state.db");
}

/**
 * Every Hermes state database on this machine: the default profile's, plus one
 * per named profile under `<home>/profiles/<name>/state.db`.
 *
 * The default home's database is ALWAYS first and is returned whether or not it
 * exists — the caller's stat pre-flight is what distinguishes "not installed"
 * from "unreadable", and short-circuiting here would collapse the two. Profile
 * entries are only returned when their database exists, since a profile
 * directory is created before its first conversation.
 *
 * An unreadable `profiles/` directory yields no profiles rather than throwing:
 * the default profile is by far the common case and must not be lost to a
 * permission error one level down.
 */
export async function listHermesStateDbPaths(home?: string): Promise<string[]> {
	const root = getHermesHomeDir(home);
	const paths = [join(root, "state.db")];
	let names: string[];
	try {
		const entries = await readdir(join(root, "profiles"), { withFileTypes: true });
		names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return paths;
	}
	for (const name of names) {
		const candidate = join(root, "profiles", name, "state.db");
		try {
			if ((await stat(candidate)).isFile()) paths.push(candidate);
		} catch {
			// A profile without a database has simply never been used.
		}
	}
	return paths;
}

/**
 * Hermes is "installed" when a state database exists AND this runtime can read
 * SQLite. Gated on hasNodeSqliteSupport() so a runtime below the Node floor
 * reports "not installed" rather than "detected but 0 sessions".
 *
 * Deliberately keyed on a DATABASE rather than the looser {@link isHermesPresent}:
 * this drives session discovery and the status tree, where a host with no
 * readable conversations has nothing to show.
 */
export async function isHermesInstalled(): Promise<boolean> {
	if (!hasNodeSqliteSupport()) {
		log.info(
			"Hermes support disabled: this runtime is Node %s, requires 22.13+ for built-in SQLite",
			process.versions.node,
		);
		return false;
	}
	return hasAnyHermesStateDb();
}

async function hasAnyHermesStateDb(): Promise<boolean> {
	for (const dbPath of await listHermesStateDbPaths()) {
		try {
			if ((await stat(dbPath)).isFile()) return true;
		} catch {
			// Missing is the common answer for the default path on a profile-only install.
		}
	}
	return false;
}

/**
 * Pure filesystem presence check for MCP / hook registration: is Hermes on this
 * machine at all, regardless of whether THIS runtime can read its database?
 *
 * Unlike {@link isHermesInstalled} this does NOT gate on `hasNodeSqliteSupport()`
 * — registration only writes a config file, so it must work on a VS Code host
 * below the Node floor, where the SQLite gate would otherwise suppress a host
 * the user genuinely has installed.
 *
 * Accepts the home DIRECTORY, not just `state.db`, for the reason Devin does:
 * registration runs only on an explicit `jolli enable` (the plugin-bootstrap
 * path short-circuits every detector to false and never self-heals), so keying
 * on the database alone would make the natural ordering — install Hermes,
 * `jolli enable`, then start using it — miss registration until the user
 * happened to enable a second time. The home directory exists from Hermes' first
 * run, before any conversation is stored.
 */
export async function isHermesPresent(): Promise<boolean> {
	if (await hasAnyHermesStateDb()) return true;
	try {
		return (await stat(getHermesHomeDir())).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Every directory a Hermes session recorded: its `git_repo_root` first (the
 * authoritative one when Hermes has filled it in), then its `cwd`.
 *
 * Both matter — see this module's header. Null / blank columns contribute
 * nothing rather than a null entry (a session started outside any project), and
 * an identical pair is de-duplicated so the narrowing does not test one
 * directory twice.
 */
function sessionDirs(gitRepoRoot: string | null, cwd: string | null): string[] {
	const dirs: string[] = [];
	for (const raw of [gitRepoRoot, cwd]) {
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim();
		if (trimmed.length === 0 || dirs.includes(trimmed)) continue;
		dirs.push(trimmed);
	}
	return dirs;
}

/** A machine-wide Hermes scan: every in-window session, plus a genuine failure. */
export interface HermesDiskScanResult {
	readonly sessions: ReadonlyArray<DiskSession>;
	/** Present only on a genuine failure (not a missing DB). Surface to UI rather than reporting "0 sessions". */
	readonly error?: SqliteScanError;
}

export interface HermesScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: SqliteScanError;
}

/**
 * Scans every Hermes state database once and returns each in-window session with
 * the directories its row recorded.
 *
 * MACHINE-WIDE and repo-agnostic on purpose: `state.db` is ONE database for
 * every project — the `cwd` / `git_repo_root` columns are what scope a row, not
 * the file's location — so a repo-scoped scan would open and re-query it once
 * per registered repo. Callers scan once and narrow with
 * {@link hermesSessionsForRepo}.
 */
export async function scanHermesSessionsOnDisk(windowMs?: number): Promise<HermesDiskScanResult> {
	return scanHermesSessionsOnDiskAt(await listHermesStateDbPaths(), windowMs);
}

/**
 * {@link scanHermesSessionsOnDisk} against explicit database paths, so tests can
 * point at fixture databases.
 *
 * Each database is scanned independently and a failure in one is PARTIAL, not
 * total: the sessions read from the others are kept and the first genuine error
 * is reported alongside them. That is the same rule Cline's per-editor-flavour
 * scan follows, and it matters here because a broken profile database must not
 * erase the default profile's conversations.
 */
export async function scanHermesSessionsOnDiskAt(
	dbPaths: ReadonlyArray<string>,
	windowMs?: number,
): Promise<HermesDiskScanResult> {
	// A runtime below the Node floor cannot load `node:sqlite`. Return a silent
	// empty result — "not supported" is not a scan failure, so callers must not
	// surface a partial-data / failed-source indicator.
	if (!hasNodeSqliteSupport()) {
		log.debug("Hermes scan skipped: runtime Node %s lacks node:sqlite (requires 22.13+)", process.versions.node);
		return { sessions: [] };
	}

	const cutoffMs = Date.now() - (windowMs ?? SESSION_STALE_MS);
	const sessions: DiskSession[] = [];
	let firstError: SqliteScanError | undefined;

	for (const dbPath of dbPaths) {
		const result = await scanOneHermesDb(dbPath, cutoffMs);
		sessions.push(...result.sessions);
		if (result.error && firstError === undefined) firstError = result.error;
	}

	log.debug("Hermes disk scan: %d session(s) inside the window across %d db(s)", sessions.length, dbPaths.length);
	return firstError ? { sessions, error: firstError } : { sessions };
}

async function scanOneHermesDb(dbPath: string, cutoffMs: number): Promise<HermesDiskScanResult> {
	// Pre-flight: "DB missing" (silent) vs "DB unreadable" (genuine failure).
	try {
		await stat(dbPath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		/* v8 ignore start -- ENOENT covered by the "DB missing" test; other codes (EACCES/EPERM/EIO) need a filesystem mock. classifyScanError is unit-tested separately. */
		if (code !== "ENOENT") {
			const scanError = classifyScanError(error);
			if (scanError) {
				log.error("Hermes DB stat failed (%s): %s", scanError.kind, scanError.message);
				return { sessions: [], error: scanError };
			}
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.debug("Hermes DB not present at %s — treating as not installed", dbPath);
		return { sessions: [] };
	}

	try {
		const sessions = await withSqliteDb(dbPath, (db) => {
			// Timestamps are epoch SECONDS stored as REAL, so the cutoff is compared
			// as a float rather than floored — the column has sub-second precision and
			// truncating it would widen the window by up to a second for no reason.
			//
			// `hidden = 0` only. `archived` is deliberately NOT filtered: archiving is
			// a user's own filing action, and the conversation still happened — the
			// dashboard counts work, not what the user chose to tidy away.
			//
			// COALESCE because `last_activity_at` is nullable while `started_at` is
			// NOT NULL: a session that has produced no turn yet would otherwise be
			// dropped by the window comparison against NULL, which is neither true
			// nor false.
			const rows = db
				.prepare(
					// No ORDER BY: every row passing the window and the JS directory match
					// is kept regardless of order, so sorting would buy nothing.
					`SELECT id, title, cwd, git_repo_root,
					        COALESCE(last_activity_at, started_at) AS activity_at
					 FROM sessions
					 WHERE hidden = 0
					   AND COALESCE(last_activity_at, started_at) > :cutoff`,
				)
				.all({ cutoff: cutoffMs / 1000 }) as ReadonlyArray<{
				id: string;
				title: string | null;
				cwd: string | null;
				git_repo_root: string | null;
				activity_at: number;
			}>;

			return rows.flatMap((row): DiskSession[] => {
				if (!Number.isFinite(row.activity_at)) {
					log.warn("Skipping Hermes session %s: non-finite activity timestamp", row.id);
					return [];
				}
				const title = typeof row.title === "string" && row.title.trim().length > 0 ? row.title : undefined;
				return [
					{
						session: {
							sessionId: String(row.id),
							transcriptPath: `${dbPath}#${row.id}`,
							updatedAt: new Date(row.activity_at * 1000).toISOString(),
							source: "hermes",
							...(title !== undefined ? { title } : {}),
						},
						dirs: sessionDirs(row.git_repo_root, row.cwd),
					},
				];
			});
		});
		return { sessions };
	} catch (error: unknown) {
		const scanError = classifyScanError(error);
		/* v8 ignore start -- TOCTOU: DB passed stat() but vanished before open. classifyScanError covered by its own unit tests. */
		if (scanError === null) {
			log.debug("Hermes DB disappeared between detection and scan: %s", (error as Error).message);
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.error("Hermes scan failed (%s): %s", scanError.kind, scanError.message);
		return { sessions: [], error: scanError };
	}
}

/**
 * Narrows a machine-wide Hermes scan to one repo.
 *
 * A session belongs to `projectDir` when its `git_repo_root` OR its `cwd` is
 * inside the worktree — the disjunction Hermes itself uses, expressed as "any
 * recorded directory matches" because {@link sessionDirs} collected both into
 * one list.
 *
 * Matching is via {@link sessionDirBelongsToRepo}, shared with the other
 * directory-scoped sources: a session started from a SUBDIRECTORY of the repo —
 * common in a monorepo — IS attributed to the repo, every worktree of one
 * repository resolves to the same repository, and a nested clone / submodule is
 * excluded so it is not double-captured.
 */
export function hermesSessionsForRepo(
	scanned: ReadonlyArray<DiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	const mine = sessionsForRepo(scanned, (dir) => sessionDirBelongsToRepo(dir, projectDir));
	log.debug("Discovered %d Hermes session(s) for %s", mine.length, projectDir);
	return mine;
}

/**
 * Discover Hermes sessions for the given project directory (production entrypoint).
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
export async function scanHermesSessions(projectDir: string, windowMs?: number): Promise<HermesScanResult> {
	return scanHermesSessionsAt(await listHermesStateDbPaths(), projectDir, windowMs);
}

/**
 * {@link scanHermesSessions} against explicit database paths, so tests can point
 * at fixture databases.
 */
export async function scanHermesSessionsAt(
	dbPaths: ReadonlyArray<string>,
	projectDir: string,
	windowMs?: number,
): Promise<HermesScanResult> {
	const { sessions, error } = await scanHermesSessionsOnDiskAt(dbPaths, windowMs);
	const mine = hermesSessionsForRepo(sessions, projectDir);
	return error ? { sessions: mine, error } : { sessions: mine };
}

/**
 * Backwards-compatible wrapper returning only the session array.
 *
 * @param windowMs Optional staleness window in milliseconds, forwarded verbatim; see
 * {@link scanHermesSessions} for the default and for who may widen it.
 */
export async function discoverHermesSessions(
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions } = await scanHermesSessions(projectDir, windowMs);
	return sessions;
}
