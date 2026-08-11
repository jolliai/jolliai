/**
 * DashboardDb — the machine-level SQLite store behind `jolli dashboard`.
 *
 * One database per machine at `~/.jolli/jollimemory/jollimemory.db` — the
 * name is deliberately not dashboard-scoped, because this file is on its way to
 * being the product's source of truth, not one page's read model. Two ways in:
 *
 *   - {@link withDashboardDb}     — writable handle. Only `StatsWriter` and the
 *                                   bootstrap/recovery paths use this.
 *   - {@link withReadonlyDashboardDb} — read-only handle. The HTTP service and
 *                                   every query path use this.
 *
 * The split is a hard boundary, not a convention: the read-only service must
 * never be able to write, so it opens with `readOnly: true` and SQLite enforces
 * it. WAL mode is what makes "one writer, N readers" work across processes —
 * the CLI hooks, the extension host and `jolli enable` all write the same file
 * concurrently and serialize on SQLite's own writer lock.
 *
 * `node:sqlite` is imported dynamically for the same reason `SqliteHelpers`
 * does it: the module emits an ExperimentalWarning on load, and a static import
 * would fire it in every hook process that merely reaches this file
 * transitively. Callers must gate on {@link canUseDashboardDb} first — this
 * module throws a clear error rather than letting `import("node:sqlite")` fail
 * with a bare MODULE_NOT_FOUND.
 */

import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getGlobalConfigDir } from "../core/SessionTracker.js";
import { classifyScanError } from "../core/SqliteHelpers.js";
import { createLogger, errMsg, isEnoent } from "../Logger.js";
import {
	ACTIVITY_DDL,
	EVENT_FAILED_KIND_DDL,
	MEMORY_SOT_DDL,
	RECALL_RECEIPTS_DDL,
	SKILL_CONTEXT_KIND_DDL,
	TOOL_CALL_TIME_DDL,
} from "./SotSchema.js";

const log = createLogger("DashboardDb");

/**
 * Current schema version. Migrations are **append-only**: bump this, add the
 * `ALTER TABLE` / `CREATE TABLE` in {@link MIGRATIONS}, and never rewrite or
 * drop an existing column. The CLI, the VS Code extension and the IntelliJ
 * plugin ship independently against this one file, so an older build must stay
 * able to `SELECT` the columns it knows about after a newer build has migrated
 * up.
 *
 * It is 5, one per entry in {@link MIGRATIONS}. Entry 0 is the whole schema as
 * it first landed; entry 1 adds `recall_receipts`; entry 2 registers `skill` as
 * the fourth `context` kind; entry 3 adds `events_raw.failed_kind` so an event
 * parked by an older build that did not know its type can be un-parked by one
 * that does; entry 4 adds `session_tool_use.last_call_at_ms`.
 *
 * Bumping this is a CROSS-SURFACE event, not a local edit — that is the reason
 * the number is worth stating here rather than left to be read off the array.
 * Every surface that opens this database refuses one stamped ahead of its own
 * build ({@link DashboardSchemaAheadError}, `CutoverRouter`'s `unavailable`, the
 * server's skipped registry projection), so the first surface to migrate locks
 * every older one out of the machine-global file until it is upgraded too. The
 * cost is paid per bump, not per entry: an entry that rides an already-planned
 * bump is free, and one that forces its own has to be worth a forced upgrade on
 * its own. A sixth entry — one `UPDATE` normalising a value the writers can no
 * longer produce — was added and then taken back out for exactly that test; see
 * the note where it used to live in `SotSchema.ts`, and prefer a defensive READ
 * over a migration whenever the choice exists (a read is permanent, a migration
 * runs once).
 *
 * Nothing has shipped yet, so entry 0 could in principle
 * have absorbed the new table — it deliberately does not, because dev
 * databases (including the one every developer on this repo is using) are
 * already at version 1, and editing entry 0 reaches only databases created
 * afterwards. A second entry reaches both. Earlier dev-only detours on the
 * recall storage — a standalone table, then a timestamp column on it, then
 * folding the detail into `session_tool_use.metadata_json` — predate any
 * on-disk version and stayed collapsed into entry 0 rather than carried as
 * dead upgrade steps. Once a release exists, the append-only rule becomes a
 * hard contract: a breaking change is handled by re-running bootstrap from the
 * sources of truth, never by rewriting an entry, and never by deleting the
 * user's database (other processes may hold the file open, and the memory half
 * is the only copy there is).
 */
export const DASHBOARD_SCHEMA_VERSION = 5;

/**
 * Minimum Node that ships `node:sqlite` **without** `--experimental-sqlite`.
 *
 * Equal to `SqliteHelpers.NODE_SQLITE_MIN_VERSION` (the same 22.13 floor, kept
 * in lockstep): the module first *exists* in 22.5 but needs the flag there,
 * and the dashboard's writers include the VS Code extension host, which
 * Electron launches and which therefore cannot be given a Node flag. 22.13 is
 * the first release where the module loads unflagged, so it is the only floor
 * that works for every surface.
 */
export const DASHBOARD_SQLITE_MIN_VERSION = { major: 22, minor: 13 } as const;

/** A prepared statement, structurally typed against node:sqlite's StatementSync. */
export interface DashboardStatement {
	all(...params: ReadonlyArray<unknown>): Array<unknown>;
	get(...params: ReadonlyArray<unknown>): unknown;
	run(...params: ReadonlyArray<unknown>): unknown;
}

/**
 * Database handle, structurally typed against node:sqlite's `DatabaseSync`
 * rather than importing the type — importing it would load the module and
 * defeat the lazy-import that keeps the ExperimentalWarning out of hooks.
 */
export interface DashboardDbHandle {
	exec(sql: string): void;
	prepare(sql: string): DashboardStatement;
	close(): void;
}

/** Absolute path of the machine-level database. */
export function getDashboardDbPath(): string {
	return join(getGlobalConfigDir(), "jollimemory.db");
}

/**
 * True when this runtime can open the dashboard DB unflagged. Compares
 * `process.versions.node` rather than probing, so calling it does not itself
 * emit the ExperimentalWarning.
 *
 * Callers that write (hooks, the extension tick) must treat `false` as "skip
 * the write" — never as an error worth surfacing, and never as a reason to
 * block git. The data still lives in the git/summary source of truth and the
 * next qualifying runtime picks it up during gap recovery.
 */
export function canUseDashboardDb(nodeVersion: string = process.versions.node): boolean {
	const match = /^(\d+)\.(\d+)/.exec(nodeVersion);
	/* v8 ignore start -- process.versions.node is well-formed semver on any supported runtime */
	if (!match) return false;
	/* v8 ignore stop */
	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	if (major > DASHBOARD_SQLITE_MIN_VERSION.major) return true;
	if (major < DASHBOARD_SQLITE_MIN_VERSION.major) return false;
	return minor >= DASHBOARD_SQLITE_MIN_VERSION.minor;
}

/** Thrown when the runtime cannot load `node:sqlite` unflagged. */
export class DashboardRuntimeError extends Error {
	constructor(nodeVersion: string) {
		super(
			`The Jolli dashboard needs Node >= ${DASHBOARD_SQLITE_MIN_VERSION.major}.${DASHBOARD_SQLITE_MIN_VERSION.minor} ` +
				`for built-in SQLite (running ${nodeVersion}). Upgrade Node, or run the CLI with --experimental-sqlite.`,
		);
		this.name = "DashboardRuntimeError";
	}
}

export interface OpenDashboardDbOptions {
	/** Override the database path. Tests point this at a temp file. */
	readonly dbPath?: string;
	/** How long to wait for the write lock. See {@link BUSY_TIMEOUT_BY_ROLE}. */
	readonly busyTimeoutMs?: number;
	/** Retry budget for `SQLITE_BUSY` on open. */
	readonly maxAttempts?: number;
	/** First backoff step in ms; doubles per attempt. */
	readonly baseDelayMs?: number;
}

/**
 * The `PRAGMA`s applied to every connection.
 *
 * `foreign_keys` is per-connection in SQLite — it is OFF by default and does
 * NOT persist in the file, so every open must set it or the `ON DELETE
 * CASCADE` clauses in the schema silently do nothing and pruning a repo leaves
 * orphaned rows behind.
 *
 * `busy_timeout` is NOT here: it is per-writer rather than per-database, so it is
 * applied from {@link OpenDashboardDbOptions} after these — see
 * {@link BUSY_TIMEOUT_BY_ROLE}.
 */
const WRITE_PRAGMAS = ["PRAGMA journal_mode = WAL", "PRAGMA foreign_keys = ON"] as const;

/** Read-only connections cannot set `journal_mode`; the writer already did. */
const READ_PRAGMAS = ["PRAGMA foreign_keys = ON"] as const;

/**
 * Default wait for the write lock. `busy_timeout` covers `BEGIN IMMEDIATE`
 * acquisition (measured), so this — not a retry loop — is how a writer decides
 * how long to tolerate another process holding the lock.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 2_000;

/**
 * Per-role waits. The right value is a property of *who is writing*, not of the
 * database:
 *
 * - A detached background writer (post-commit worker, bootstrap) has nothing else
 *   to do and no user waiting on it, so it should wait generously rather than drop
 *   the write and rely on a later recovery pass.
 * - The editor-host writer runs on the thread that draws the UI with a synchronous
 *   API, so waiting is visible as a freeze. It should give up quickly and let its
 *   next 60 s tick try again — the data is re-derivable, a stuttering editor is
 *   not acceptable.
 */
export const BUSY_TIMEOUT_BY_ROLE: Readonly<Record<string, number>> = {
	"queue-worker": 15_000,
	bootstrap: 15_000,
	recovery: 15_000,
	"stop-hook": 5_000,
	cli: 5_000,
	vscode: 400,
};

/**
 * Append-only migration list. Index 0 takes an empty database to schema
 * version 1; each later entry takes version N to N+1. Never edit an entry that
 * has shipped — add a new one.
 *
 * Entry 0 is the schema as it first landed — the intermediate shapes it went
 * through (including a couple of dev-only detours on the Recall card's storage
 * — see `DASHBOARD_SCHEMA_VERSION`'s doc comment) were this branch's own
 * development history, not a compatibility contract with anyone's installed
 * database, and were collapsed into it rather than carried as dead upgrade
 * steps. Entry 1 adds `recall_receipts` as a real migration: by then dev
 * databases existed at version 1, and only an appended entry reaches those as
 * well as fresh ones. Entry 2 registers the `skill` context kind for the same
 * reason. Entry 4 gives `session_tool_use` the call's own timestamp — an
 * additive NULLABLE column precisely because the rows already on disk cannot be
 * backfilled (the transcripts they were read from may be gone), so they keep
 * being read under the old session-time fallback rather than dropping out of
 * every window for want of a value.
 *
 * There is no entry normalising a stored `0` in that column, and that absence is
 * a decision: the writers cannot produce one, and the reader treats one as
 * absent (`TOOL_CALL_TIME_SQL`'s `NULLIF`), which is both permanent and free
 * where a sixth entry would have been neither. See the note in `SotSchema.ts`
 * where that entry used to be.
 *
 * Exported for tests: they execute entries directly to build a database at a
 * chosen version rather than hand-rolling copies of the DDL, which would drift.
 */
export const MIGRATIONS: ReadonlyArray<string> = [
	ACTIVITY_DDL +
		`
-- Policy: repo rows are NEVER deleted — disable = set disabled_at. Every table
-- references repos(id) with default NO ACTION (not CASCADE), so a stray DELETE
-- errors instead of silently wiping a repo's memories; this trigger catches even
-- the zero-data case.
--
-- This is the ONE trigger the no-triggers rule keeps, and the reasons it does
-- not fall under that rule are worth stating: it encodes no business rule that
-- could change (repo rows stay forever by design), it has no ordering
-- relationship with any other trigger, and what it prevents is not a wrong value
-- but the irreversible loss of every memory belonging to a repo. Replacing it
-- with "the code does not write DELETE, and a test pins that" would trade an
-- engine-enforced guarantee for a convention.
CREATE TRIGGER repos_no_delete BEFORE DELETE ON repos
BEGIN SELECT RAISE(ABORT, 'repos are never deleted: set disabled_at instead'); END;
` +
		MEMORY_SOT_DDL,
	RECALL_RECEIPTS_DDL,
	SKILL_CONTEXT_KIND_DDL,
	EVENT_FAILED_KIND_DDL,
	TOOL_CALL_TIME_DDL,
];

/** Reads the stored schema version, treating a fresh DB as 0. */
export function readSchemaVersion(db: DashboardDbHandle): number {
	try {
		const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
			| { value?: string }
			| undefined;
		const parsed = Number.parseInt(row?.value ?? "", 10);
		return Number.isFinite(parsed) ? parsed : 0;
	} catch {
		// `no such table: schema_meta` — an empty database. Every other failure
		// mode here (corrupt, permission) resurfaces on the first migration
		// statement with a far better message than we could produce.
		return 0;
	}
}

/**
 * Brings a writable handle up to {@link DASHBOARD_SCHEMA_VERSION}, applying
 * only the migrations it is missing. Idempotent: running it on an up-to-date
 * database does nothing.
 *
 * Each entry runs inside its own IMMEDIATE transaction **with the version
 * bump**, so a crash mid-entry rolls back cleanly and the next open retries.
 * That matters even with a single entry: the baseline builds ~130 objects, and
 * without the wrapper a crash partway could leave a half-built schema with the
 * version already stamped — which every later open would then skip.
 *
 * `foreign_keys` is toggled OUTSIDE the transaction because inside one the
 * pragma is a silent no-op (measured). The current baseline does NOT need it —
 * it applies with 0 `foreign_key_check` violations at either setting (measured)
 * — so this is insurance for a future entry that rebuilds a table, where the
 * SQLite rename-and-copy dance does require FKs off. The `finally` restore is
 * load-bearing: a handle left with FKs off would let every ON DELETE CASCADE in
 * the caller's batch silently stop working.
 */
export function migrateDashboardDb(db: DashboardDbHandle): void {
	const from = readSchemaVersion(db);
	if (from >= DASHBOARD_SCHEMA_VERSION) return;
	db.exec("PRAGMA foreign_keys = OFF");
	try {
		for (let version = from; version < DASHBOARD_SCHEMA_VERSION; version++) {
			db.exec("BEGIN IMMEDIATE");
			try {
				// Re-read INSIDE the write lock: two writers opening around a shipped
				// version bump (CLI hook + extension tick — a supported concurrency
				// mode) both read `from` before either migrated; the loser's BEGIN
				// IMMEDIATE parks it until the winner commits, and replaying the
				// winner's entry then dies on `duplicate column name` (or `table
				// schema_meta already exists` on a fresh file) — an error the busy
				// retry loop correctly refuses to classify as `locked`. BEGIN
				// IMMEDIATE is the fence that makes this read authoritative.
				const stored = readSchemaVersion(db);
				if (stored > version) {
					db.exec("COMMIT");
					continue;
				}
				db.exec(MIGRATIONS[version]);
				db.exec(
					`INSERT INTO schema_meta (key, value) VALUES ('schema_version', '${version + 1}')
					 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				);
				db.exec("COMMIT");
			} catch (err) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// The engine already aborted the transaction; the original
					// error is the one worth surfacing.
				}
				throw err;
			}
		}
	} finally {
		db.exec("PRAGMA foreign_keys = ON");
	}
	log.info("dashboard schema migrated %d → %d", from, DASHBOARD_SCHEMA_VERSION);
}

/**
 * Thrown when the file was written by a NEWER build than this one. Reading it
 * would be guesswork, so the caller is told what to do instead.
 *
 * On an unreleased branch this is also what a stale development database looks
 * like after the schema was reset — deleting it is the answer there, and safe,
 * because the read model rebuilds from git and the orphan branch on the next
 * `jolli dashboard`.
 */
export class DashboardSchemaAheadError extends Error {
	constructor(found: number, dbPath: string) {
		super(
			`${dbPath} uses dashboard schema v${found}, newer than this build's v${DASHBOARD_SCHEMA_VERSION}. ` +
				`Upgrade Jolli, or delete that file to rebuild the dashboard from scratch.`,
		);
		this.name = "DashboardSchemaAheadError";
	}
}

/**
 * Creates the config directory owner-only.
 *
 * This is the load-bearing half of the permission fix. SQLite creates the `-wal`
 * and `-shm` sidecars itself, under the process umask, on every write session —
 * so no amount of chmod-ing the main file keeps their contents private. A 0700
 * directory is what actually stops another local user from reading any of it,
 * which matters because the HTTP layer no longer requires a token: file
 * permissions are the remaining boundary.
 */
export function ensureOwnerOnlyDir(dbPath: string): void {
	const dir = dirname(dbPath);
	try {
		// `mode` applies only when mkdir creates the directory, so an existing one
		// keeps whatever it had — hence the explicit chmod for upgrades.
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
		/* v8 ignore start -- needs a filesystem that rejects mkdir/chmod (root-owned parent, non-POSIX mount) */
	} catch (err) {
		log.warn("could not restrict %s to owner-only: %s", dir, errMsg(err));
	}
	/* v8 ignore stop */
}

/**
 * Restricts the database file (and any present sidecars) to the owner.
 *
 * Must run **after** the connection is opened: `node:sqlite` creates the file at
 * the process umask, so before the open there is nothing to chmod — the first
 * version of this ran too early and left the file at 0644, which the tests now
 * pin. Re-asserted on every open so a database created by an older build gets
 * tightened the first time a current build touches it.
 *
 * Never fatal: some filesystems ignore POSIX modes, and an optional dashboard
 * must not fail to open over that.
 */
function restrictDbFilesToOwner(dbPath: string): void {
	for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
		try {
			if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
		} catch (err) {
			// A missing sidecar is the normal case — they exist only while a writer
			// holds the file, and the 0700 directory covers them regardless.
			/* v8 ignore next -- the non-ENOENT branch needs a chmod-rejecting filesystem */
			if (!isEnoent(err)) log.warn("could not restrict %s to 0600: %s", path, errMsg(err));
		}
	}
}

/** Opens a connection, applying pragmas. Retries `SQLITE_BUSY` with backoff. */
async function openDb(readOnly: boolean, opts: OpenDashboardDbOptions): Promise<DashboardDbHandle> {
	if (!canUseDashboardDb()) throw new DashboardRuntimeError(process.versions.node);
	const dbPath = opts.dbPath ?? getDashboardDbPath();
	const maxAttempts = opts.maxAttempts ?? 4;
	const baseDelayMs = opts.baseDelayMs ?? 50;
	if (!readOnly) ensureOwnerOnlyDir(dbPath);
	const { DatabaseSync } = await import("node:sqlite");
	for (let attempt = 1; ; attempt++) {
		let db: DashboardDbHandle | undefined;
		try {
			db = new DatabaseSync(dbPath, { readOnly }) as unknown as DashboardDbHandle;
			for (const pragma of readOnly ? READ_PRAGMAS : WRITE_PRAGMAS) db.exec(pragma);
			db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
			// After the open: the file exists only now (see restrictDbFilesToOwner).
			if (!readOnly) restrictDbFilesToOwner(dbPath);
			return db;
		} catch (err) {
			// Close the half-open handle before retrying, or each attempt leaks a
			// file descriptor and (on Windows) keeps the file locked against the
			// very retry that is meant to clear the contention.
			try {
				db?.close();
			} catch {
				/* already closed or never opened */
			}
			if (classifyScanError(err)?.kind !== "locked" || attempt >= maxAttempts) throw err;
			await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
		}
	}
}

/**
 * Runs `fn` against a **writable** handle, migrating the schema first and
 * always closing afterwards.
 *
 * Keep `fn` short. It holds a connection that may take SQLite's single writer
 * lock, and every other producer on the machine — hooks, the extension host,
 * `jolli enable` — is contending for it. DbBackfill opens one handle per repo
 * and runs many short transactions inside it (see `DbBackfill.applyBatches`) —
 * the lock is held per-transaction, not for the whole callback.
 */
export async function withDashboardDb<T>(
	fn: (db: DashboardDbHandle) => T | Promise<T>,
	opts: OpenDashboardDbOptions = {},
): Promise<T> {
	const db = await openDb(false, opts);
	try {
		const found = readSchemaVersion(db);
		if (found > DASHBOARD_SCHEMA_VERSION) {
			throw new DashboardSchemaAheadError(found, opts.dbPath ?? getDashboardDbPath());
		}
		migrateDashboardDb(db);
		// Await INSIDE the try: an async callback must finish with the handle
		// still open — returning the promise would close it in `finally` first.
		return await fn(db);
	} finally {
		db.close();
	}
}

/**
 * Creates the database file — and brings an EXISTING one's schema up to date —
 * then closes. Cheap on the common path: one read-only version read.
 *
 * Exists because "no writer has run yet" is a REACHABLE first-run state, not a
 * theoretical one: a `jolli dashboard` in a directory with nothing registered
 * never opens a writable handle anywhere (`dbBackfillRepos([])` returns without
 * touching the file), so every read-only open below fails and the whole
 * dashboard answers 500. A reader cannot fix that for itself — `readOnly:
 * true` is exactly the mode that must not create a schema — so the one caller
 * that owns the lifecycle calls this first instead.
 *
 * Guarding on file EXISTENCE alone reopened that same 500 one upgrade later: the
 * migration also only runs from a writable open, so a database left behind by an
 * older build, in a directory with nothing registered, is never migrated and the
 * first query for a table this build expects fails outright. Existence is the
 * wrong question — "is it current?" is the question.
 *
 * A schema NEWER than this build is left strictly alone: it has no downgrade, and
 * `openDb` refuses it with a message that names the version, which is the honest
 * answer for a surface that is simply behind.
 */
export async function ensureDashboardDbExists(opts: OpenDashboardDbOptions = {}): Promise<void> {
	const dbPath = opts.dbPath ?? getDashboardDbPath();
	if (existsSync(dbPath)) {
		let found: number;
		try {
			found = await withReadonlyDashboardDb(readSchemaVersion, opts);
		} catch {
			// Unreadable for any other reason (corrupt, permission, sidecars-only) —
			// not something a migration can fix, and not this function's job to
			// report. The caller's own open surfaces it with a real message.
			return;
		}
		if (found >= DASHBOARD_SCHEMA_VERSION) return;
	}
	await withDashboardDb(() => undefined, opts);
}

/**
 * Runs `fn` against a **read-only** handle. Never migrates — a reader that
 * arrives before any writer has created the file gets the open error, which
 * callers surface as "no data yet" rather than trying to create a schema from
 * a path that is not allowed to write.
 */
export async function withReadonlyDashboardDb<T>(
	fn: (db: DashboardDbHandle) => T | Promise<T>,
	opts: OpenDashboardDbOptions = {},
): Promise<T> {
	const db = await openDb(true, opts);
	try {
		return await fn(db);
	} finally {
		db.close();
	}
}

/**
 * Runs `fn` inside a transaction, rolling back if it throws.
 *
 * There is deliberately **no application-level retry around `BEGIN IMMEDIATE`**.
 * Measured: `PRAGMA busy_timeout` already covers write-lock acquisition — a
 * second writer blocked for the full 400 ms of a 400 ms timeout before raising
 * `database is locked`, and failed instantly at `busy_timeout = 0`. SQLite does
 * that waiting efficiently, so a retry loop on top would only add spinning (or a
 * blocked thread) to a wait that already happened. The knob that matters is
 * therefore the timeout per writer role — see `busyTimeoutMs` — not a loop here.
 *
 * Once `BEGIN` succeeds nothing is retried either: `fn` may have consumed state
 * that cannot be replayed, so a mid-transaction failure rolls back and
 * propagates. Retrying the *whole* unit of work belongs to the async caller
 * (`applyStatsEvents`), where a real `await` can wait without blocking a thread.
 */
export function inTransaction<T>(db: DashboardDbHandle, fn: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (err) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// A failed ROLLBACK means the transaction is already gone (the engine
			// aborted it). Surfacing it would mask the original error, which is
			// the one the caller needs.
		}
		throw err;
	}
}
