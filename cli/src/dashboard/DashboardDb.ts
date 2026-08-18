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
import { JOLLI_CLIENT_HEADER } from "../core/ClientHeader.js";
import { getGlobalConfigDir } from "../core/SessionTracker.js";
import { classifyScanError } from "../core/SqliteHelpers.js";
import { createLogger, errMsg, isEnoent } from "../Logger.js";
import {
	ACTIVITY_DDL,
	EVENT_FAILED_KIND_DDL,
	MEMORY_SOT_DDL,
	RECALL_RECEIPTS_DDL,
	REPOS_DELETE_ALLOWED_DDL,
	SCHEMA_MIGRATIONS_DDL,
	SESSION_USAGE_EVENTS_DDL,
	SKILL_CONTEXT_KIND_DDL,
	STATS_DAILY_DAY_INDEX_DDL,
	STATS_DAILY_DDL,
	SYNC_KEYSET_INDEX_DDL,
	SYNC_STAMP_DDL,
	SYNC_STAMP_INDEX_DDL,
	SYNC_STAMP_NULL_BACKFILL_DDL,
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
 * Equal to `MIGRATIONS.length`, one per entry. Entry 0 is the whole schema as
 * it first landed; entry 1 adds `recall_receipts`; entry 2 registers `skill` as
 * the fourth `context` kind; entry 3 adds `events_raw.failed_kind` so an event
 * parked by an older build that did not know its type can be un-parked by one
 * that does; entry 4 adds `session_tool_use.last_call_at_ms`; entry 5 adds the
 * `schema_migrations` log; entry 6 drops the `repos_no_delete` trigger;
 * entry 7 is the session-statistics sync, whose seven DDL constants are
 * concatenated into ONE entry rather than appended one per step: the per-row
 * sync stamps that let an outbound sync select what changed, the
 * `session_usage_events` table (one row per model response, because a session's
 * cumulative total under a single timestamp cannot be split across the days the
 * conversation actually spanned), the `stats_daily` rollup cache plus the
 * `commits.written_at_ms` that detects a stale day, the stamp and keyset indexes
 * those two need, and the backfill that gives every stamp a number.
 *
 * ONE entry because the intermediate versions those steps produced (8 through 13)
 * exist on no database anybody will ever ship or receive — they were this
 * branch's own development history, and a version the release cannot reach is
 * bookkeeping nobody can act on. That merge is only legal because the feature has
 * not shipped; once it has, the append-only rule below takes over and the next
 * feature's steps must each be their own entry. The cost of getting this wrong is
 * concrete and was measured here: `buildRollupQuietly` stops maintaining the
 * daily cache the moment the file's number exceeds the build's, so five of those
 * seven steps — three index entries, an ALTER and a backfill, none of which can
 * introduce a table an older build cannot see — would each have disabled that
 * cache on every older build for nothing.
 *
 * Bumping it is NOT a cross-surface event any more, and that is the one thing
 * worth knowing about it: nothing refuses a database over this number (see the
 * compatibility note below), so an appended entry costs an upgrade to nobody. It
 * is a hand-maintained literal that MUST equal `MIGRATIONS.length` — appending a
 * migration means bumping this by one, and `DashboardDb.test.ts` pins the two
 * together so two branches that each append one collide loudly in CI rather than
 * silently on disk. (It cannot be written as `= MIGRATIONS.length` in place: that
 * array is declared further down this file, so the reference would hit the
 * temporal dead zone at module load.)
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
export const DASHBOARD_SCHEMA_VERSION = 8;

/**
 * NOTE ON COMPATIBILITY, because its absence here is a decision.
 *
 * This module does NOT decide whether a database may be used: no compatibility
 * floor, no version gate, no "the file is newer than me" error. A writable open
 * succeeds whatever the file says. Three reasons, in the order they were learned:
 *
 *  - **The format number cannot answer the question.** It moves only with DDL, so
 *    it misses the change that actually corrupts data (a new required field inside
 *    `summary_json`, a re-encoded TEXT column) while faithfully blocking the
 *    additive upgrades that are harmless. Wrong in both directions.
 *  - **Refusing costs more than it protects.** Six kinds of process open this
 *    file, five of them long-lived (one `jolli mcp` per AI-host session,
 *    `ide-bridge-serve`, `jolli daemon`, the dashboard server, the VS Code
 *    extension host). A version gate stopped every one of them on every additive
 *    bump — measured here: 5 MCP servers + the dashboard + the extension host all
 *    reporting the same error, for a change that added two tables and five
 *    nullable columns.
 *  - **Compatibility is a relationship between the shipped artifacts.** The CLI
 *    and the four plugins are built from this source tree and released on one
 *    version line, and the backend already gates per surface on its product
 *    version. A hard incompatibility belongs there — stated in the numbers a user
 *    installed and can update — not in a number only this file knows.
 *
 * A compatibility-floor key (`min_compatible_version`, then
 * `min_compatible_release`) was implemented and removed; see the plan's revision
 * log. What remains is tolerance plus one log line: additive columns read back as
 * their defaults, unknown tables are never touched, and {@link withDashboardDb}
 * warns ONCE PER PROCESS when the file's format is ahead of this build, so that
 * "this surface could not see everything" is at least visible afterwards.
 */

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
 * One migration: a permanent name and the statements to run.
 *
 * There is deliberately no `breaking` flag. One existed while the database still
 * decided compatibility for itself; with that gate gone it had no consumer, and a
 * declaration nothing reads is worse than none — it reads as a guarantee. A change
 * that older builds cannot tolerate is handled where compatibility actually lives:
 * the release line shared by the CLI and the plugins. See the compatibility note
 * above `DASHBOARD_SCHEMA_VERSION`.
 */
export interface Migration {
	/**
	 * IDENTITY. The exported DDL constant's name, verbatim, and PERMANENT: it is
	 * what the log is keyed by, so renaming one makes it look like it never ran,
	 * which re-runs it into `duplicate column`. Positions may move; names may not.
	 */
	readonly name: string;
	readonly ddl: string;
}

/**
 * Append-only migration list. Index 0 takes an empty database to schema
 * version 1; each later entry takes version N to N+1. Never edit an entry that
 * has shipped — add a new one.
 *
 * Entries are identified by `name`, not by position: the loop applies whichever
 * names the file's log does not already carry. That is what makes two branches
 * appending a migration each a non-event after the merge — both entries are in
 * the array, so both get applied — where position-as-identity let the
 * second-merged one be skipped forever with the file stamped as complete.
 *
 * Order is still the execution order, and it is still only protected socially:
 * APPEND, never insert into the middle and never reorder. Inserting an entry
 * ahead of ones a database has already applied would run it out of order (a
 * column added before its table exists).
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
export const MIGRATIONS: ReadonlyArray<Migration> = [
	{
		name: "BASELINE_DDL",
		ddl:
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
	},
	{ name: "RECALL_RECEIPTS_DDL", ddl: RECALL_RECEIPTS_DDL },
	{ name: "SKILL_CONTEXT_KIND_DDL", ddl: SKILL_CONTEXT_KIND_DDL },
	{ name: "EVENT_FAILED_KIND_DDL", ddl: EVENT_FAILED_KIND_DDL },
	{ name: "TOOL_CALL_TIME_DDL", ddl: TOOL_CALL_TIME_DDL },
	{ name: "SCHEMA_MIGRATIONS_DDL", ddl: SCHEMA_MIGRATIONS_DDL },
	{ name: "REPOS_DELETE_ALLOWED_DDL", ddl: REPOS_DELETE_ALLOWED_DDL },
	{
		// The seven steps the session-statistics sync was developed in, in the order
		// they were written, concatenated verbatim. Concatenated rather than rewritten
		// so this entry is provably the same statement sequence a machine that took
		// the granular path already ran — see `DASHBOARD_SCHEMA_VERSION` for why they
		// are one entry, and note the redundancy that proves the point: `STATS_DAILY_DDL`
		// already creates the `(tz, day)` index inline, so the index constant after it
		// is a second `CREATE INDEX IF NOT EXISTS` over the same object. It stays,
		// because "identical to what already ran" is worth more here than tidiness.
		//
		// ⚠ Nothing here may be a DATA cleanup, and the reason is measured. A schema
		// step is idempotent or guarded, so a database that already ran this entry is
		// already in the target state; a DELETE has to EXECUTE to mean anything, and
		// the log is keyed by NAME — so a database with an `applied` row for this name
		// skips it in silence. Appending one was tried: on a real database it left
		// 10,631 junk rows and 550 stale cache rows untouched and the page bit-for-bit
		// unfixed, and there is no repair either, because forcing a re-run dies on
		// `duplicate column name: written_at_ms` at the first ALTER while
		// `--mark-migration` just re-establishes the skip. While this entry is
		// unreleased the affected databases are developers' own, so such data is
		// cleared by hand instead.
		name: "SESSION_STATS_SYNC_DDL",
		ddl:
			SYNC_STAMP_DDL +
			SESSION_USAGE_EVENTS_DDL +
			STATS_DAILY_DDL +
			STATS_DAILY_DAY_INDEX_DDL +
			SYNC_STAMP_INDEX_DDL +
			SYNC_KEYSET_INDEX_DDL +
			SYNC_STAMP_NULL_BACKFILL_DDL,
	},
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

/** What happened to one migration on one attempt. See `SCHEMA_MIGRATIONS_DDL`. */
export type MigrationOutcome = "applied" | "failed" | "skipped" | "baseline";

/** One row of the `schema_migrations` log, as stored. */
export interface MigrationLogRow {
	readonly seq: number;
	readonly slot: number;
	readonly name: string;
	readonly outcome: MigrationOutcome;
	readonly applied_by: string;
	readonly applied_at_ms: number;
	readonly duration_ms: number;
	readonly ddl: string;
}

/**
 * What a read of `schema_migrations` found. THREE answers, none interchangeable:
 *
 *  - `rows` — the log, in `seq` order. An EMPTY array is a real answer: "this
 *    database has been logging and recorded nothing".
 *  - `none` — no such table. The only state in which the version stamp may be
 *    believed about which entries ran.
 *  - `unreadable` — the read failed. Emphatically NOT `none`: collapsing the two
 *    makes a BROKEN log report as "this database predates the log", which is
 *    precisely the diagnosis this table exists to make possible. `tableConfirmed`
 *    splits the two shapes of broken, because they need different words: `true` is
 *    "the table is in the schema and this build cannot query it" (a renamed or
 *    missing column, one corrupt page), `false` is "the database could not answer
 *    even whether the table exists" — a corrupt or truncated file, which is the
 *    case that used to be reported as `none`.
 */
export type MigrationLogState =
	| { readonly kind: "rows"; readonly rows: ReadonlyArray<MigrationLogRow> }
	| { readonly kind: "none" }
	| { readonly kind: "unreadable"; readonly reason: string; readonly tableConfirmed: boolean };

/**
 * Whether `schema_migrations` is in the schema at all, regardless of its shape.
 *
 * THREE answers, and `unknown` is the load-bearing one. A garbage or truncated file
 * opens fine — SQLite reads no page until the first statement — so the failure lands
 * on this probe, and answering `false` for it made a corrupt database report as "no
 * log yet": the pre-log message, aimed at the one reader who cannot act on it.
 */
function migrationLogTableExists(db: DashboardDbHandle): "present" | "absent" | "unknown" {
	try {
		const row = db
			.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
			.get() as { n?: number } | undefined;
		return (row?.n ?? 0) > 0 ? "present" : "absent";
	} catch {
		return "unknown";
	}
}

/** See {@link MigrationLogState}. Distinguishes a missing table from a broken one. */
export function readMigrationLogState(db: DashboardDbHandle): MigrationLogState {
	try {
		const rows = db
			.prepare(
				// ORDER BY is load-bearing, not decoration: `rows` is documented as being in
				// `seq` order and doctor prints it under "oldest first". A bare SELECT happens
				// to come back in rowid order today, which is a planner accident and not part
				// of SQLite's contract.
				"SELECT seq, slot, name, outcome, applied_by, applied_at_ms, duration_ms, ddl FROM schema_migrations ORDER BY seq",
			)
			.all() as ReadonlyArray<MigrationLogRow>;
		return { kind: "rows", rows };
	} catch (err) {
		// `no such table: schema_migrations` — a database from before entry 5, or a
		// fresh file. Anything else is a broken log and must be reported as one: the read
		// is the ONLY statement that touches this table on a pass that migrates nothing,
		// so "it resurfaces later" is false for it. Only a probe that positively answers
		// "absent" may be read as the pre-log state; a probe that itself failed says the
		// database is unreadable, not that it is old.
		const present = migrationLogTableExists(db);
		if (present === "absent") return { kind: "none" };
		return { kind: "unreadable", reason: errMsg(err), tableConfirmed: present === "present" };
	}
}

/**
 * The whole log in `seq` order, or `undefined` when there is no log to read —
 * which lumps a missing table together with a broken one. Callers that ACT on the
 * difference (the migration pass, doctor's report) must use
 * {@link readMigrationLogState}; this wrapper is for the ones that only need
 * "are there rows to inspect".
 */
export function readMigrationLog(db: DashboardDbHandle): ReadonlyArray<MigrationLogRow> | undefined {
	const state = readMigrationLogState(db);
	return state.kind === "rows" ? state.rows : undefined;
}

interface LogRowInput {
	readonly slot: number;
	readonly name: string;
	readonly outcome: MigrationOutcome;
	readonly appliedBy: string;
	readonly atMs: number;
	readonly durationMs: number;
	readonly ddl: string;
}

/** Appends one log row. Never overwrites — the table is a log, not a flag set. */
function insertLogRow(db: DashboardDbHandle, row: LogRowInput): void {
	db.prepare(
		`INSERT INTO schema_migrations (slot, name, outcome, applied_by, applied_at_ms, duration_ms, ddl)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(row.slot, row.name, row.outcome, row.appliedBy, row.atMs, row.durationMs, row.ddl);
}

/** The newest row per name, whatever its outcome — "who touched this name last". */
function latestByName(rows: ReadonlyArray<MigrationLogRow>): Map<string, MigrationLogRow> {
	const latest = new Map<string, MigrationLogRow>();
	for (const row of rows) {
		const seen = latest.get(row.name);
		if (!seen || row.seq > seen.seq) latest.set(row.name, row);
	}
	return latest;
}

/**
 * The newest **`applied`** row per name — the only row that says what DDL this
 * file's schema was actually built from, and therefore the one a drift check must
 * compare against.
 *
 * Deliberately not `latestByName` filtered afterwards: a later non-applied row for
 * the same name HIDES the applied one, and that sequence is reachable rather than
 * theoretical. An older build applies drifted DDL (`applied`, DDL X); a later
 * writer that stale-reads the name as missing — or steps over it for any other
 * reason — appends `skipped` under DDL Y. Filtering the newest row would then find
 * a non-applied outcome, skip the name, and go quiet: from that point on neither
 * the runtime warning nor `jolli doctor --schema-log` mentions a schema that still
 * differs. The whole point of the log is that the newest row cannot erase an
 * earlier observation.
 *
 * `--mark-migration`'s repair is unaffected: it APPENDS an `applied` row carrying
 * this build's DDL, so it is the newest applied row and still clears the warning.
 */
function latestAppliedByName(rows: ReadonlyArray<MigrationLogRow>): Map<string, MigrationLogRow> {
	const latest = new Map<string, MigrationLogRow>();
	for (const row of rows) {
		if (row.outcome !== "applied") continue;
		const seen = latest.get(row.name);
		if (!seen || row.seq > seen.seq) latest.set(row.name, row);
	}
	return latest;
}

/** Names this build knows, in slot order. */
function slotOf(name: string): number {
	return MIGRATIONS.findIndex((m) => m.name === name);
}

/** Names already warned about this process, so a git hook does not spam the log. */
const warnedDriftedMigrations = new Set<string>();

/**
 * Sentinel key in {@link warnedDriftedMigrations} for the once-per-process
 * unreadable-log warning. Not a legal migration name (names are identifiers), so
 * it cannot collide with a real one.
 *
 * Written as the ESCAPE `\0`, never as a literal NUL byte in this file. A raw one
 * makes the whole module binary to `grep` / `rg`: a repo-wide search for anything in
 * here returns NOTHING, silently and with exit code 1, which is how a search for
 * `schema_migrations` in the file that defines it came back empty.
 */
const UNREADABLE_LOG_WARN_KEY = "\0unreadable-log";

/**
 * Reports every logged `applied` row whose stored DDL is not the DDL this build
 * carries under that name — content drift, which under a name key is the ONLY way
 * two builds can disagree about a slot (colliding on a position is no longer
 * possible).
 *
 * ⚠ It WARNS. It does not throw, and re-introducing a throw here would put back
 * the behaviour the version gate was removed for, in a shape that is if anything
 * sharper:
 *
 *  - **It is over-sensitive to harmless edits.** The comparison is byte-exact, and
 *    the DDL is mostly prose: 64% of the baseline entry is SQL comments (22,967 of
 *    35,673 characters — measured). Re-wrapping one comment would have made every
 *    database on earth refuse writes.
 *  - **CI already catches the real thing, earlier and better.**
 *    `MigrationFingerprints.test.ts` fails on an edit to a shipped entry's DDL on
 *    the author's machine, before it can ship. A runtime throw only repeats that
 *    finding on a USER's machine, where the only remaining moves were a doctor
 *    command or deleting the one copy of their session/recall history.
 *  - **It cannot see what actually breaks data.** A semantic change arrives as an
 *    APPENDED entry, which matches its own DDL perfectly and drifts nothing.
 *
 * So the value here is diagnostic: the log plus this line answer "this database
 * was built by a different build than the one reading it", which is the question
 * that used to take a dozen rounds of git archaeology. Acted on by
 * `jolli doctor --schema-log`, which lists the drifted names.
 *
 * Runs on EVERY writable open, including the ones that migrate nothing: drift is
 * precisely the state where the version stamp says "finished" and the content
 * disagrees. One SELECT, once per name per process.
 *
 * Three deliberate silences:
 *
 *  - No log table at all → nothing to check. Entry 5 CREATES that table, so the
 *    first run on any existing database reaches this before the table exists.
 *  - A name with no `applied` row → pass. Databases that predate the log have rows
 *    for nothing, so this check cannot reach backwards; only forwards. Seeded
 *    `baseline` rows are also skipped — they are a guess by construction, so
 *    comparing against them would report drift that was never observed. Note this
 *    is "no applied row ANYWHERE", not "the newest row is not applied" — a later
 *    `skipped` / `failed` row must not bury an earlier observation.
 *  - A logged name this build does not have → also a warn. It means another build
 *    (very likely from an unmerged branch) has touched this file, which is the most
 *    useful clue available, and the file may legitimately be shared by two builds
 *    in rotation.
 */
export function verifyMigrationLog(db: DashboardDbHandle): void {
	const state = readMigrationLogState(db);
	if (state.kind === "none") return;
	if (state.kind === "unreadable") {
		// Not a silence: the table is there and this build cannot read it, so every
		// drift check below is vacuous rather than passing. Once per process.
		if (!warnedDriftedMigrations.has(UNREADABLE_LOG_WARN_KEY)) {
			warnedDriftedMigrations.add(UNREADABLE_LOG_WARN_KEY);
			log.warn(
				state.tableConfirmed
					? "the schema_migrations table exists but could not be read (%s) — drift verification is skipped; run `jolli doctor --schema-log`"
					: "the database could not be queried for its migration log (%s) — drift verification is skipped; run `jolli doctor --schema-log`",
				state.reason,
			);
		}
		return;
	}
	const rows = state.rows;
	const known = new Set(MIGRATIONS.map((m) => m.name));
	// Unknown names key off the newest row of ANY outcome — the question there is
	// "has another build touched this file", which a `failed` or `skipped` row
	// answers just as well as an `applied` one.
	for (const [name, row] of latestByName(rows)) {
		if (known.has(name)) continue;
		if (warnedDriftedMigrations.has(name)) continue;
		warnedDriftedMigrations.add(name);
		log.warn(
			// "touched by", not "applied by": this branch keys off the newest row of ANY
			// outcome, so the row naming that surface may be a `failed`, `skipped` or
			// `baseline` one — none of which applied anything.
			"migration %s was touched by %s but is unknown to this build (%s) — the database has been opened by another build",
			name,
			row.applied_by,
			JOLLI_CLIENT_HEADER,
		);
	}
	// Drift keys off the newest APPLIED row — see `latestAppliedByName`.
	for (const [name, row] of latestAppliedByName(rows)) {
		if (!known.has(name)) continue;
		if (warnedDriftedMigrations.has(name)) continue;
		if (row.ddl === MIGRATIONS[slotOf(name)].ddl) continue;
		warnedDriftedMigrations.add(name);
		log.warn(
			"migration %s (slot %d) was applied by %s on %s with DIFFERENT DDL than this build (%s) carries — run `jolli doctor --schema-log` to see the log",
			name,
			row.slot,
			row.applied_by,
			new Date(row.applied_at_ms).toISOString().slice(0, 10),
			JOLLI_CLIENT_HEADER,
		);
	}
}

/** Injection seams for {@link migrateDashboardDb}. Production passes nothing. */
export interface MigrateOptions {
	/** Clock. Defaults to `Date.now`. */
	readonly now?: () => number;
	/** Log identity. Defaults to `JOLLI_CLIENT_HEADER` — never a literal. */
	readonly appliedBy?: string;
}

/**
 * Brings a writable handle up to date by applying every entry in
 * {@link MIGRATIONS} whose `name` the file's log does not already carry.
 * Idempotent: running it on an up-to-date database does nothing and takes no
 * write lock.
 *
 * NAME-driven, not version-driven, and that is the whole point: "has this run?" is
 * asked of the log, never of `schema_version`. Two branches that each appended an
 * entry therefore merge without incident, where the version-driven loop stepped
 * past the second one forever and left no trace of having done so.
 *
 * `schema_version` survives for two jobs, NEITHER of which is a compatibility
 * decision — there is no gate, no floor, and no version at which this function or
 * {@link withDashboardDb} refuses a file (see the note above
 * {@link DASHBOARD_SCHEMA_VERSION}). It is (1) the only evidence available about a
 * database that predates the log, so it seeds the `baseline` rows below, and (2) the
 * input to the format-ahead warn-once line.
 *
 * Each entry runs inside its own IMMEDIATE transaction **with its log row and the
 * version bump**, so a crash mid-entry rolls back cleanly — including the claim that
 * it ran — and the next open retries. A FAILED entry's row is written after the
 * rollback, outside the transaction, or it would roll back with the change it
 * describes; that trace is often the only evidence there is, since most
 * `withDashboardDb` callers deliberately swallow the exception rather than fail a
 * producer. (A busy timeout on `BEGIN IMMEDIATE` itself throws from OUTSIDE that
 * try, so a contended writer never records a `failed` row for an entry it did not
 * attempt.)
 *
 * The stamp is written as `MAX(stored, slot + 1)`, never as `slot + 1`: under a name
 * key an entry can legitimately be applied to a file already past it (the self-heal
 * case), and stamping downwards would re-run everything after it.
 *
 * `foreign_keys` is toggled OUTSIDE the transaction because inside one the
 * pragma is a silent no-op (measured). The current baseline does NOT need it —
 * it applies with 0 `foreign_key_check` violations at either setting (measured)
 * — so this is insurance for a future entry that rebuilds a table, where the
 * SQLite rename-and-copy dance does require FKs off. The `finally` restore is
 * load-bearing: a handle left with FKs off would let every ON DELETE CASCADE in
 * the caller's batch silently stop working.
 *
 * ACCEPTED COST of the additive-is-compatible rule: a build that predates a
 * column writes rows with that column at its default, so anything DERIVED from
 * it can go stale (a cache keyed on a timestamp column will not see the write).
 * Only derived data is affected — source rows are byte-correct, and any cache
 * here is safe to delete and recompute — whereas the behaviour this replaces
 * stopped every long-lived surface on every additive upgrade for no integrity
 * gain at all.
 */
export function migrateDashboardDb(db: DashboardDbHandle, opts: MigrateOptions = {}): void {
	const now = opts.now ?? Date.now;
	const appliedBy = opts.appliedBy ?? JOLLI_CLIENT_HEADER;
	const from = readSchemaVersion(db);
	const logState = readMigrationLogState(db);
	const done = new Set<string>();
	// Seed rows for a database that predates the log. The version stamp is the
	// only evidence of what ran, so the names come from THIS build's list at those
	// positions — which is a guess, and can be wrong exactly where the position
	// key was wrong. They are marked `baseline` rather than `applied` so the log
	// says which of its own rows are observations and which are inference.
	let pendingBaseline: ReadonlyArray<{ slot: number; name: string; ddl: string }> = [];
	if (logState.kind === "rows") {
		for (const row of logState.rows)
			if (row.outcome === "applied" || row.outcome === "baseline") done.add(row.name);
	} else {
		const known = Math.min(from, MIGRATIONS.length);
		const seeds = MIGRATIONS.slice(0, known).map((m, slot) => ({ slot, name: m.name, ddl: m.ddl }));
		for (const entry of seeds) done.add(entry.name);
		// An UNREADABLE log falls in with the pre-log case for control flow — the
		// version stamp is again the only usable evidence, and every insert below is
		// gated on the table reading back, so nothing here throws over it — but it
		// gets NO seed rows: writing inference into a table whose shape this build
		// cannot read is how a half-written log gets manufactured.
		if (logState.kind === "none") pendingBaseline = seeds;
		else
			log.warn(
				logState.tableConfirmed
					? "the schema_migrations table exists but could not be read (%s) — migrating from the version stamp and recording nothing"
					: "the database could not be queried for its migration log (%s) — migrating from the version stamp and recording nothing",
				logState.reason,
			);
	}
	const todo = MIGRATIONS.map((m, slot) => ({ m, slot })).filter(({ m }) => !done.has(m.name));
	if (todo.length === 0) return;
	/** Rows for entries applied before the log table existed. See the loop. */
	const deferredRows: LogRowInput[] = [];

	/**
	 * Write the rows this pass has been holding because the entries they record ran
	 * before the log table existed — version-stamp baselines first (inference), then
	 * this pass's own `applied` rows (observation) — and clear both. Must run the
	 * instant the log becomes writable, whether THIS pass created the table (the
	 * applied branch) or a racing writer did and this pass is now skipping over its
	 * entries. The skip that returned without flushing was the bug: a racer can apply
	 * and record EVERY remaining entry, so a skip may be the last time this pass ever
	 * holds a writable log — and the dropped `applied` rows then left those slots
	 * absent from the log, so the next open re-ran their DDL and died on a duplicate
	 * object, permanently. Idempotent when nothing is held.
	 */
	const flushHeldRows = (): void => {
		for (const seed of pendingBaseline) {
			insertLogRow(db, { ...seed, outcome: "baseline", appliedBy, atMs: now(), durationMs: 0 });
		}
		pendingBaseline = [];
		for (const held of deferredRows) insertLogRow(db, held);
		deferredRows.length = 0;
	};

	db.exec("PRAGMA foreign_keys = OFF");
	try {
		for (const { m, slot } of todo) {
			const startedAt = now();
			db.exec("BEGIN IMMEDIATE");
			try {
				// Re-read INSIDE the write lock: two writers opening around a version
				// bump (CLI hook + extension tick — a supported concurrency mode) both
				// decided what to run before either had run anything; the loser's BEGIN
				// IMMEDIATE parks it until the winner commits, and replaying the
				// winner's entry then dies on `duplicate column name` — an error the
				// busy retry loop correctly refuses to classify as `locked`. BEGIN
				// IMMEDIATE is the fence that makes this read authoritative.
				const locked = readMigrationLog(db);
				if (locked?.some((r) => r.name === m.name && (r.outcome === "applied" || r.outcome === "baseline"))) {
					// The log table is readable here (`locked` is non-null), so any rows this
					// pass is still holding — entries it applied before the table existed — MUST
					// be flushed now, ahead of the skip row. A racing writer can apply and
					// record every REMAINING entry, making this the last skip this pass reaches;
					// returning without flushing dropped those `applied` rows for good, and their
					// slots then re-ran on the next open and died on a duplicate object forever.
					flushHeldRows();
					// The row that used to be a bare `continue`. It is the single most
					// diagnostic line in the table: a skip is what the position-keyed
					// loop did to an entry it then never came back to.
					insertLogRow(db, {
						slot,
						name: m.name,
						outcome: "skipped",
						appliedBy,
						atMs: now(),
						durationMs: 0,
						ddl: m.ddl,
					});
					db.exec("COMMIT");
					continue;
				}
				if (!locked && readSchemaVersion(db) > slot) {
					// Same fence for a database whose log table does not exist yet — the
					// version stamp is all there is, and there is nowhere to record it.
					db.exec("COMMIT");
					continue;
				}
				db.exec(m.ddl);
				const row: LogRowInput = {
					slot,
					name: m.name,
					outcome: "applied",
					appliedBy,
					atMs: now(),
					durationMs: now() - startedAt,
					ddl: m.ddl,
				};
				// The table the log lives in is created by an entry IN this list, so on a
				// fresh database the first entries run before there is anywhere to record
				// them. Their rows are held and written by the entry that creates the
				// table — inside its transaction, ahead of its own row, so `seq` order
				// still reads as history. They stay `applied` (this pass watched them
				// run) while the version-stamp seeds stay `baseline` (inference).
				//
				// If the creating entry then FAILS, the held rows go with it — and that
				// is recoverable rather than lost: the file is left at a version with no
				// log table, which the next pass reads as a pre-log database and seeds
				// from the stamp. The only cost is that those rows come back as
				// inference, which is the honest description of what is then known.
				if (readMigrationLog(db)) {
					flushHeldRows();
					insertLogRow(db, row);
				} else {
					deferredRows.push(row);
				}
				// MAX, not `slot + 1`: under a name key an entry can be applied to a
				// file that is already past it (the self-heal case), and stamping the
				// version down would re-run everything after it.
				const stamped = Math.max(readSchemaVersion(db), slot + 1);
				writeSchemaMeta(db, "schema_version", String(stamped));
				db.exec("COMMIT");
			} catch (err) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// The engine already aborted the transaction; the original
					// error is the one worth surfacing.
				}
				try {
					// Keep only the MOST RECENT failed attempt per name. A persistently broken
					// database is re-opened on every git-hook commit, and an append-per-open
					// grew the log without bound — each `failed` row stores the entry's full
					// DDL verbatim (~35 KB), and `verifyMigrationLog` / `migrateDashboardDb`
					// re-read the whole table on every open. A failed row is diagnostic, not
					// evidence a later pass reads (drift keys off `applied` rows), so the newest
					// attempt is all that is useful; the delete bounds the table to one such row.
					db.prepare("DELETE FROM schema_migrations WHERE name = ? AND outcome = 'failed'").run(m.name);
					insertLogRow(db, {
						slot,
						name: m.name,
						outcome: "failed",
						appliedBy,
						atMs: now(),
						durationMs: now() - startedAt,
						ddl: m.ddl,
					});
				} catch (logErr) {
					// The log table may not exist yet (a failure at or before entry 5).
					// Losing the trace must never mask the failure itself.
					log.debug("could not record the failed migration %s: %s", m.name, errMsg(logErr));
				}
				throw err;
			}
		}
	} finally {
		db.exec("PRAGMA foreign_keys = ON");
	}
	log.info(
		"dashboard schema migrated %d → %d (%s)",
		from,
		readSchemaVersion(db),
		todo.map(({ m }) => m.name).join(", "),
	);
}

/** Upserts one `schema_meta` key. Parameterised — never string-interpolated. */
function writeSchemaMeta(db: DashboardDbHandle, key: string, value: string): void {
	db.prepare(
		`INSERT INTO schema_meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(key, value);
}

/**
 * Repair action behind `jolli doctor`: append an `applied` row carrying THIS
 * build's DDL for `name`, which is what clears a drift error or adopts a
 * migration applied by other means.
 *
 * An append rather than an UPDATE, because the log is the evidence: the row that
 * disagreed stays visible, and the newest APPLIED row is what the check reads
 * (see {@link latestAppliedByName} for why the qualifier matters). Without this
 * the only way out of a false positive would be deleting the database, and what
 * that costs — other processes may hold the file open, and the memory half is the
 * only copy there is — is why this escape hatch exists at all. Flyway's `repair`
 * and Liquibase's `clearCheckSums` are the same escape hatch.
 *
 * Returns false for a name this build does not carry — there is no DDL to accept.
 */
export function recordMigrationAsApplied(db: DashboardDbHandle, name: string, opts: MigrateOptions = {}): boolean {
	const slot = slotOf(name);
	if (slot < 0) return false;
	// No READABLE log means nothing to record INTO — a database that predates the
	// log, one this repair reached before the entry that creates it ran (the repair
	// open deliberately does not migrate), or a log whose shape this build cannot
	// read. Answering false beats letting a raw `no such table` / `no such column`
	// escape from a doctor command; the caller re-reads the state to say which.
	if (readMigrationLogState(db).kind !== "rows") return false;
	insertLogRow(db, {
		slot,
		name,
		outcome: "applied",
		appliedBy: opts.appliedBy ?? JOLLI_CLIENT_HEADER,
		atMs: (opts.now ?? Date.now)(),
		durationMs: 0,
		ddl: MIGRATIONS[slot].ddl,
	});
	return true;
}

/**
 * Every migration whose stored DDL disagrees with this build's — the drifted names
 * that `jolli doctor --schema-log` calls out at the end of its listing.
 *
 * Reported, never repaired: the blanket `--accept-schema-ddl` this used to feed was
 * removed with the version gate, because drift no longer blocks anything and an
 * "accept" would write a row that changes nothing.
 */
export function findDriftedMigrations(db: DashboardDbHandle): ReadonlyArray<MigrationLogRow> {
	const rows = readMigrationLog(db);
	if (!rows) return [];
	const drifted: MigrationLogRow[] = [];
	for (const [name, row] of latestAppliedByName(rows)) {
		const slot = slotOf(name);
		if (slot < 0) continue;
		if (row.ddl !== MIGRATIONS[slot].ddl) drifted.push(row);
	}
	return drifted;
}

/**
 * Format number this process has already warned about, so a git hook logs at most
 * one line no matter how many times it opens the file.
 */
let warnedAheadVersion = 0;

/**
 * The one thing left of the old version gate: a single log line when the file's
 * format is ahead of this build.
 *
 * NOT a user-facing prompt, and deliberately not an error. Reads were never
 * version-gated, so a stale surface has always been able to render a page off a
 * newer file — silently, with every table and column added since invisible to it.
 * This line is what makes that visible AFTERWARDS, to whoever is reading the log
 * while working out why a number looked wrong. Whether to update is a question for
 * the release channel, not for this warning to nag about.
 *
 * Once per process per version: `withDashboardDb` is on the git-hook path.
 */
function warnFormatAheadOnce(found: number): void {
	if (warnedAheadVersion === found) return;
	warnedAheadVersion = found;
	// Names the surface, because six kinds of process share one `debug.log` and the
	// format numbers alone cannot say which of them could not see the data. This is
	// the one thing the deleted staleness layer did that still earns its keep, and it
	// costs one interpolation of a constant already used for `applied_by`.
	log.warn(
		"database is at format v%d, this build (%s) reads v%d — data written by newer builds is not visible here",
		found,
		JOLLI_CLIENT_HEADER,
		DASHBOARD_SCHEMA_VERSION,
	);
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
		// A newer format is NOT a compatibility question and is never refused — see
		// the compatibility note above `DASHBOARD_SCHEMA_VERSION`. It only means this
		// build cannot see everything in the file, which is worth one log line.
		const found = readSchemaVersion(db);
		if (found > DASHBOARD_SCHEMA_VERSION) warnFormatAheadOnce(found);
		// Before migrating, and also when nothing needs migrating — see
		// `verifyMigrationLog`, and note it must tolerate the log table's absence
		// because the entry that creates it is itself in the list.
		verifyMigrationLog(db);
		migrateDashboardDb(db);
		// Await INSIDE the try: an async callback must finish with the handle
		// still open — returning the promise would close it in `finally` first.
		return await fn(db);
	} finally {
		db.close();
	}
}

/**
 * Writable open that does NOT migrate — for `jolli doctor`'s repair actions.
 *
 * The load-bearing half is the absence of the migration pass, not the absence of
 * the drift check (which only warns). `doctor --mark-migration` exists for the one
 * state a name key cannot fix by itself: the log has lost a row while the object
 * that entry created is still in the schema. A normal open would helpfully re-run
 * that entry and die on `duplicate column`, so the repair has to reach the log
 * without the pass running first.
 */
export async function withRepairDashboardDb<T>(
	fn: (db: DashboardDbHandle) => T | Promise<T>,
	opts: OpenDashboardDbOptions = {},
): Promise<T> {
	const db = await openDb(false, opts);
	try {
		return await fn(db);
	} finally {
		db.close();
	}
}

/**
 * True when this build has nothing left to migrate on `db` — the predicate a
 * READ-ONLY caller uses to decide it may skip a writable (migrating) open.
 *
 * Under the name key the version stamp alone is NOT that predicate: an entry can be
 * missing by NAME while the stamp is already at or past this build's version — a
 * migration that landed on another branch under a number this build also reached by
 * a different route. `found >= DASHBOARD_SCHEMA_VERSION` therefore answers "is the
 * stamp current", which is no longer the same question as "is everything applied".
 * So when the log is READABLE, ask the log: every migration name must carry an
 * `applied`/`baseline` row. Only when the log predates this feature (`none`) or
 * cannot be read does the version stamp stand in — no name-keyed merge could have
 * happened before the log existed, and an unreadable log is not a question a
 * read-only caller can answer, so it defers to the writable open, which then
 * migrates from the stamp (a no-op when the stamp is current) and surfaces any real
 * fault itself.
 */
export function isSchemaCurrent(db: DashboardDbHandle): boolean {
	const done = readAppliedMigrationNames(db);
	if (done) return MIGRATIONS.every((m) => done.has(m.name));
	return readSchemaVersion(db) >= DASHBOARD_SCHEMA_VERSION;
}

/**
 * The names `schema_migrations` records as run (`applied` or `baseline`), or
 * `undefined` when there is no log to believe.
 *
 * Its own SELECT rather than a projection over {@link readMigrationLogState},
 * and the reason is the `ddl` column: it stores each migration's entire source
 * text — the baseline entry alone is ~35 KB — while this answers a question
 * about NAMES. That read is on the dashboard's hot path, not a startup one:
 * `defaultModelBuilder` calls {@link ensureDashboardDbExists} on EVERY
 * `/api/model`, so once per page load and once per 30 s poll for as long as the
 * tab is open. Pulling every migration's DDL there moved tens of KB per request
 * to look at two columns.
 *
 * Collapses `none` and `unreadable` into one `undefined`, which the full read
 * deliberately does not: this caller answers BOTH by deferring to the version
 * stamp (see {@link isSchemaCurrent}), so it needs no `migrationLogTableExists`
 * probe to tell them apart — one query, not two. A caller that must report the
 * difference is exactly the caller that should use `readMigrationLogState`.
 */
function readAppliedMigrationNames(db: DashboardDbHandle): ReadonlySet<string> | undefined {
	try {
		// No ORDER BY: this collects into a set, so `seq` order buys nothing here —
		// unlike the full read, whose `rows` are documented as being in that order.
		const rows = db.prepare("SELECT name, outcome FROM schema_migrations").all() as ReadonlyArray<{
			name: string;
			outcome: string;
		}>;
		const done = new Set<string>();
		for (const row of rows) if (row.outcome === "applied" || row.outcome === "baseline") done.add(row.name);
		return done;
	} catch {
		// `no such table` (a database from before entry 5) and a genuinely broken log
		// alike. An EMPTY set is not this answer — it is "the log is readable and
		// records nothing run", which correctly reports the schema as not current.
		return undefined;
	}
}

/**
 * Creates the database file — and brings an EXISTING one's schema up to date —
 * then closes. Cheap on the common path: one read-only log/version read.
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
 * A schema NEWER than this build needs no writable open either: `isSchemaCurrent`
 * finds every name this build carries already applied and short-circuits. Nothing
 * refuses a newer file — `withDashboardDb` only WARNS once (see the compatibility
 * note on `DASHBOARD_SCHEMA_VERSION`); the old version-reject behaviour is gone.
 *
 * The short-circuit is `isSchemaCurrent`, NOT `found >= DASHBOARD_SCHEMA_VERSION`:
 * under the name key a file can sit at the current stamp with a named migration
 * still missing, and gating on the stamp would skip the one writable open that
 * would apply it — reopening the read-only 500 this function exists to prevent.
 */
export async function ensureDashboardDbExists(opts: OpenDashboardDbOptions = {}): Promise<void> {
	const dbPath = opts.dbPath ?? getDashboardDbPath();
	if (existsSync(dbPath)) {
		let current: boolean;
		try {
			current = await withReadonlyDashboardDb(isSchemaCurrent, opts);
		} catch {
			// Unreadable for any other reason (corrupt, permission, sidecars-only) —
			// not something a migration can fix, and not this function's job to
			// report. The caller's own open surfaces it with a real message.
			return;
		}
		if (current) return;
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
