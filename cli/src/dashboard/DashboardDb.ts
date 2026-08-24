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
import { MIGRATIONS } from "./migrations/index.js";
import type { DbMigration } from "./migrations/MigrationHelpers.js";

const log = createLogger("DashboardDb");

/**
 * NOTE ON VERSIONS, because their absence here is a decision.
 *
 * **This database has no schema version number, and adding one back is a review
 * blocker.** Whether a migration has run is asked of the `schema_migrations` log, by
 * NAME, and of nothing else. `DASHBOARD_SCHEMA_VERSION` existed until it was removed
 * along with the `schema_version` write, the format-ahead warning, and
 * `isSchemaCurrent`'s version fallback.
 *
 * Two things went wrong while it existed, and both are structural rather than bad
 * luck. A hand-maintained integer that had to equal `MIGRATIONS.length` made two
 * branches appending one migration each collide on a number neither of them cared
 * about. And it invited comparisons that look like compatibility checks but are not:
 * the number moves only with DDL, so it misses the change that actually corrupts
 * data (a new required field inside `summary_json`, a re-encoded TEXT column) while
 * faithfully blocking additive upgrades that are harmless. Wrong in both directions.
 *
 * This module also does NOT decide whether a database may be used: no compatibility
 * floor, no gate, no "the file is newer than me" error. A writable open succeeds
 * whatever the file contains. Refusing costs more than it protects — six kinds of
 * process open this file, five of them long-lived (one `jolli mcp` per AI-host
 * session, `ide-bridge-serve`, `jolli daemon`, the dashboard server, the VS Code
 * extension host) — and compatibility is a relationship between the shipped
 * artifacts anyway: the CLI and the four plugins are built from this tree and
 * released on one version line, and the backend already gates per surface.
 *
 * What replaced the number, where something was genuinely needed:
 *
 *  - "has a newer build touched this file?" → {@link verifyMigrationLog}'s
 *    unknown-name warning, which answers it from the log itself.
 *  - "should the rollup cache be maintained?" → {@link dbHasUnknownMigrations}.
 *  - "is the schema current?" → {@link isSchemaCurrent}, from the log alone.
 *
 * **Nothing reads the `schema_version` key any more either, and `readSchemaVersion`
 * is gone.** It survived for one job — a database predating the log table has nothing
 * else to say what ran, so its leftover stamp seeded `baseline` rows for entries
 * `0..stamp-1`, which were then skipped. That job was retired because the inference
 * behind it was false: the named entries and the log table shipped in the SAME release
 * (0.99.12), so any database carrying a stamp was built by the earlier NUMBERED list,
 * whose position N is not this list's entry N. The mapping could only be a guess, and
 * a wrong guess SKIPS an entry — the one failure mode this whole file is shaped to
 * prevent, arriving as `no such table` on a machine nobody can inspect.
 *
 * {@link migrateDashboardDb} now replays every entry on such a database. That is safe
 * for the reason the skipping was not: re-runnability is enforced, twice, in
 * `DashboardDb.test.ts`. The `baseline` outcome remains in {@link MigrationOutcome}
 * and is still READ as "done" — 0.99.12 and 0.99.13 wrote those rows, and demoting
 * them would replay their entries on every open for ever — but nothing writes it.
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

export { LEGACY_MIGRATION_NAMES, MIGRATIONS } from "./migrations/index.js";
/**
 * `DbMigration`, {@link sqlMigration} and {@link addColumnIfMissing} now live in
 * `migrations/MigrationHelpers.ts`, and {@link MIGRATIONS} / {@link
 * LEGACY_MIGRATION_NAMES} in `migrations/index.ts` — one file per entry, each named
 * after its own permanent `name`. Re-exported here so every existing import of
 * `from "./DashboardDb.js"` keeps working unchanged. See `migrations/index.ts`'s
 * docblock for the list-wide rules (append-only, name is identity, never edit a
 * committed entry) and each entry's own file for why it exists.
 */
export type { DbMigration } from "./migrations/MigrationHelpers.js";
export { addColumnIfMissing, sqlMigration } from "./migrations/MigrationHelpers.js";

/*
 * `readSchemaVersion` used to sit here — the last reader of the `schema_version` key.
 * It is deleted rather than deprecated; see the note at the top of this file for why
 * its one caller (seeding `baseline` rows on a pre-log database) was retired, and do
 * not re-add it. The key itself may still be present in old databases' `schema_meta`,
 * unread by anything.
 */

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
 *  - `none` — no such table: a database from before entry 5, or a fresh file. It is
 *    NOT a licence to consult the version stamp instead — nothing does any more, and
 *    `migrateDashboardDb` answers this state by replaying every entry.
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

/*
 * `latestAppliedByName` used to sit here — the newest `applied` row per name, which
 * was the row the content drift check compared against. It went with that check; the
 * unknown-name warning keys off `latestByName` instead, because "has another build
 * touched this file" is answered just as well by a `failed`, `skipped` or `baseline`
 * row as by an `applied` one.
 */

/** Names this build knows, in slot order. */
function slotOf(name: string): number {
	return MIGRATIONS.findIndex((m) => m.name === name);
}

/**
 * What the log's `ddl` column holds for an entry: its SQL, or `""` when it has none.
 *
 * The empty string is load-bearing rather than a placeholder. It is what makes a
 * code entry invisible to the drift check (it always equals itself) instead of
 * making every code entry report drift against a body that was never SQL. The cost
 * — those entries have no fingerprint — is paid by the companion-test rule in
 * `MigrationFingerprints.test.ts`.
 */
function loggedSqlOf(m: DbMigration): string {
	return m.sql ?? "";
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
 * Warns when the log records a migration this build does not recognize by NAME —
 * the one drift signal that survives now that the byte-level content check is
 * gone (see the note at the end of this function for why it was removed).
 *
 * ⚠ It WARNS. It does not throw, and re-introducing a throw here would put back
 * the behaviour the version gate was removed for: this file is opened by six
 * kinds of process across independently-released surfaces, and refusing one
 * because another build's name is unfamiliar stops it doing anything at all.
 *
 * So the value here is diagnostic: the log plus this line answer "has a build I
 * do not know written here?", which is the question that used to take a dozen
 * rounds of git archaeology. Acted on by `jolli doctor --schema-log`, which lists
 * the unrecognized names.
 *
 * Runs on EVERY writable open, including the ones that migrate nothing — an
 * unfamiliar name can show up on a database this build otherwise has nothing
 * left to migrate. One SELECT, once per name per process
 * (`warnedDriftedMigrations` de-dupes across opens).
 *
 * Two deliberate silences:
 *
 *  - No log table at all → nothing to check. The entry that CREATES that table is
 *    itself in the list, so the first run on any existing database reaches this
 *    before the table exists.
 *  - Log present but unreadable → warned ONCE (`UNREADABLE_LOG_WARN_KEY`), not
 *    silently skipped: the table is there and this build cannot read it, which is
 *    a fault worth surfacing even though every check below it is then vacuous.
 *
 * The unknown-name check itself keys off the newest row of ANY outcome, not just
 * `applied` — a `failed` or `skipped` row answers "has another build touched this
 * file" just as well, and a later non-applied row must not bury an earlier one's
 * evidence.
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
	// A CONTENT check used to follow: byte-compare each logged `ddl` against this
	// build's, and warn on a difference. It is gone, and re-adding one is a review
	// blocker.
	//
	// It answered the same question as the loop above — "has a build I do not know
	// written here?" — and the loop above answers it from NAMES, which cannot be wrong
	// about our own edits. The byte compare could: making every entry re-runnable
	// rewrote six shipped entries (`IF NOT EXISTS`, `OR IGNORE`) and turned two more
	// into code entries. Semantically identical on an empty database, and yet measured
	// against 0.99.13, six of its seven entries would have reported drift on first
	// upgrade — on every machine, for a change that altered nothing. A warning that
	// fires for everyone is not a signal, and the alternative was a hand-kept ledger of
	// historical hashes, which cannot exist for a body that has not shipped yet.
	//
	// What the content check added over the name check was one case: the same name
	// carrying different bytes. Inside this repo CI already makes that impossible
	// (`MigrationFingerprints.test.ts` SHA-pins every `sql` entry). Across branches it
	// is a developer's own machine, which is repaired by hand — the product does not
	// carry that repair. `ddl` is still STORED, so the bytes another build applied can
	// be read out with `sqlite3` when a real question arises; nothing compares them
	// automatically.
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
 * **`schema_version` is not read here at all any more, and a database that predates
 * the log simply has every entry replayed.** It used to seed `baseline` rows: the
 * stamp was treated as evidence of what ran, so entries `0..stamp-1` were marked done
 * and SKIPPED. That was a guess in the one direction that cannot be checked, and it
 * was wrong about its own premise — the named entries and this log table arrived in
 * the SAME release (0.99.12), so a database carrying a stamp was built by the earlier
 * NUMBERED migration list, whose contents at position N are not this list's entry N.
 * Skipping on that mapping is how an object goes missing on exactly the machines that
 * cannot be inspected, and the failure looks like `no such table` months later.
 *
 * Replaying instead is safe because every entry is re-runnable — enforced two ways in
 * `DashboardDb.test.ts`: each entry run twice on a fresh database, and the whole list
 * replayed over seeded rows with every row compared by value. So the entries a legacy
 * database already satisfies are no-ops, and the ones its stamp would have wrongly
 * skipped are applied. There is no gate, no floor and no version at which this
 * function or {@link withDashboardDb} refuses a file — see the note at the top of this
 * file.
 *
 * The cost is one extra pass of guarded DDL, once, on a pre-0.99.12 database. What it
 * buys is the removal of the last place a version number decided anything.
 *
 * Each entry runs inside its own IMMEDIATE transaction **with its log row**, so a
 * crash mid-entry rolls back cleanly — including the claim that it ran — and the next
 * open retries. A FAILED entry's row is written after the rollback, outside the
 * transaction, or it would roll back with the change it describes; that trace is
 * often the only evidence there is, since most `withDashboardDb` callers deliberately
 * swallow the exception rather than fail a producer. (A busy timeout on
 * `BEGIN IMMEDIATE` itself throws from OUTSIDE that try, so a contended writer never
 * records a `failed` row for an entry it did not attempt.)
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
	const logState = readMigrationLogState(db);
	const done = new Set<string>();
	if (logState.kind === "rows") {
		// The log is the ONLY evidence consulted. `baseline` still counts as done: this
		// function no longer WRITES that outcome, but 0.99.12/0.99.13 did, and treating
		// those rows as anything else would replay their entries on every open for ever.
		for (const row of logState.rows)
			if (row.outcome === "applied" || row.outcome === "baseline") done.add(row.name);
	} else if (logState.kind === "none") {
		// A database from before the log table existed. Nothing is skipped — see the
		// docblock for why the version stamp cannot be believed about which entries ran.
		// Every entry is re-runnable, so the ones it already satisfies cost a no-op.
		log.info("no migration log in this database — replaying every entry (all are re-runnable)");
	} else {
		// UNREADABLE is not the same as absent, and neither is a reason to skip: with no
		// usable log this pass cannot know what ran, so it replays too. Every insert
		// below is gated on the table reading back, so nothing here throws over it — but
		// nothing gets RECORDED either, which is the honest outcome for a log this build
		// cannot read.
		log.warn(
			logState.tableConfirmed
				? "the schema_migrations table exists but could not be read (%s) — replaying every entry and recording nothing"
				: "the database could not be queried for its migration log (%s) — replaying every entry and recording nothing",
			logState.reason,
		);
	}
	const todo = MIGRATIONS.map((m, slot) => ({ m, slot })).filter(({ m }) => !done.has(m.name));
	if (todo.length === 0) return;
	/** Rows for entries applied before the log table existed. See the loop. */
	const deferredRows: LogRowInput[] = [];

	/**
	 * Write the `applied` rows this pass has been holding because the entries they
	 * record ran before the log table existed, and clear them. Must run the instant the
	 * log becomes writable, whether THIS pass created the table (the applied branch) or
	 * a racing writer did and this pass is now skipping over its entries. The skip that
	 * returned without flushing was the bug: a racer can apply and record EVERY
	 * remaining entry, so a skip may be the last time this pass ever holds a writable
	 * log — and the dropped `applied` rows then left those slots absent from the log, so
	 * the next open re-ran their DDL and died on a duplicate object, permanently.
	 * Idempotent when nothing is held.
	 *
	 * It used to flush a second, earlier group: `baseline` rows inferred from the
	 * version stamp. Those are gone with the inference — every row this function writes
	 * is now an observation of an entry this pass watched run.
	 */
	const flushHeldRows = (): void => {
		for (const held of deferredRows) insertLogRow(db, held);
		deferredRows.length = 0;
	};

	db.exec("PRAGMA foreign_keys = OFF");
	try {
		for (const { m, slot } of todo) {
			const startedAt = now();
			db.exec("BEGIN IMMEDIATE");
			try {
				// Re-read INSIDE the write lock: two writers opening at the same moment
				// (CLI hook + extension tick — a supported concurrency mode) both
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
						ddl: loggedSqlOf(m),
					});
					db.exec("COMMIT");
					continue;
				}
				// There used to be a second fence here for a database whose log table does
				// not exist yet — `!locked && readSchemaVersion(db) > slot`. It is gone,
				// and what removed it is every entry now being re-runnable: the failure it
				// prevented was a racing writer REPLAYING an entry into `table already
				// exists`, and a replay is now a sequence of statements that do nothing.
				// Its own log line was also indistinguishable from a real fault, since an
				// unreadable log reached it as "nothing to consult, skip".
				m.run(db);
				const row: LogRowInput = {
					slot,
					name: m.name,
					outcome: "applied",
					appliedBy,
					atMs: now(),
					durationMs: now() - startedAt,
					ddl: loggedSqlOf(m),
				};
				// The table the log lives in is created by an entry IN this list, so on a
				// fresh database the first entries run before there is anywhere to record
				// them. Their rows are held and written by the entry that creates the
				// table — inside its transaction, ahead of its own row, so `seq` order
				// still reads as history. They stay `applied` (this pass watched them run).
				//
				// If the creating entry then FAILS, the held rows go with it — and that is
				// recoverable rather than lost: the file is left with no log table, which
				// the next pass reads as `kind: "none"` and replays every entry from
				// scratch (see the top of this function) rather than seeding anything from
				// a version stamp — there is no stamp left to read. The only cost is one
				// extra pass of guarded DDL over the entries this attempt already applied,
				// which rule ② makes a no-op.
				if (readMigrationLog(db)) {
					flushHeldRows();
					insertLogRow(db, row);
				} else {
					deferredRows.push(row);
				}
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
					// re-read the whole table on every open. Collapsing repeats to the newest
					// loses nothing the unknown-name check needs: it reads the newest row per
					// name whatever its outcome, and this name still has exactly one row after
					// the delete — only the DUPLICATES are gone, not the name's only evidence.
					db.prepare("DELETE FROM schema_migrations WHERE name = ? AND outcome = 'failed'").run(m.name);
					insertLogRow(db, {
						slot,
						name: m.name,
						outcome: "failed",
						appliedBy,
						atMs: now(),
						durationMs: now() - startedAt,
						ddl: loggedSqlOf(m),
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
	// Names, not numbers: there is no version to report any more, and the names are
	// what `doctor --schema-log` and every bug report speak in.
	log.info("dashboard schema migrated: %s", todo.map(({ m }) => m.name).join(", "));
}

/**
 * Repair action behind `jolli doctor --mark-migration`: append an `applied` row
 * carrying THIS build's SQL for `name`, so the migration pass and
 * {@link isSchemaCurrent} see it as done.
 *
 * For the one state a name key cannot fix alone: the log lost its row for an
 * entry whose objects are already there (a wiped `schema_migrations` table, a
 * hand-restored backup). It is NOT a way to silence a name this build does not
 * know — {@link slotOf} rejects those — and it does nothing about drift: the
 * runtime byte-compare that this repair once cleared a warning for was removed
 * (see the note at the end of `verifyMigrationLog`), so there is no drift error
 * left to clear.
 *
 * An append rather than an UPDATE, because the log is a log: any earlier row for
 * this name — `failed`, `skipped`, whatever bytes it carried — stays visible in
 * `seq` order rather than being erased. Without this escape hatch the only way
 * out of a lost row would be deleting the database, and what that costs — other
 * processes may hold the file open, and the memory half is the only copy there is
 * — is why it exists at all. Flyway's `repair` and Liquibase's `clearCheckSums`
 * are the same escape hatch.
 *
 * Returns false for a name this build does not carry — there is nothing to accept.
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
		ddl: loggedSqlOf(MIGRATIONS[slot]),
	});
	return true;
}

/*
 * `findDriftedMigrations` used to sit here, feeding `jolli doctor --schema-log`'s
 * "applied by a different build" listing. It is gone with the content check that
 * produced it — see the note at the end of `verifyMigrationLog` for why comparing
 * bytes could not tell our own equivalent rewrite from another build's work.
 */

/**
 * Whether the log records a migration this build has never heard of.
 *
 * The honest form of the question "has a newer build written to this file?", and the
 * replacement for comparing a version number — which could only ever answer it by
 * proxy, and answered it wrongly in both directions (see the note at the top of this
 * file). A name is evidence; a number was a guess.
 *
 * `false` when the log cannot be read at all. That is deliberate: the callers use
 * this to decline OPTIONAL work (maintaining a derived cache), so an unreadable log
 * must not make them skip work they can perfectly well do — and a database with a
 * broken log has louder problems being reported elsewhere.
 */
export function dbHasUnknownMigrations(db: DashboardDbHandle): boolean {
	const done = readAppliedMigrationNames(db);
	if (!done) return false;
	const known = new Set(MIGRATIONS.map((m) => m.name));
	for (const name of done) if (!known.has(name)) return true;
	return false;
}

/*
 * `warnFormatAheadOnce` / `warnedAheadVersion` used to live here: one log line when
 * the file's format number was ahead of this build's. Both are gone with the number.
 *
 * The question they answered — "did a newer build write data this surface cannot
 * see?" — is now answered from the log instead, by `verifyMigrationLog`'s
 * unknown-name warning, which says WHICH migration and WHICH surface applied it
 * rather than comparing two integers. `dbHasUnknownMigrations` is the same fact in
 * predicate form, for callers that act on it.
 */

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
		// Before migrating, and also when nothing needs migrating — see
		// `verifyMigrationLog`, and note it must tolerate the log table's absence
		// because the entry that creates it is itself in the list. It is also what
		// reports "a newer build has written here", which a version comparison used
		// to do less precisely.
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
 * Asked of the log and nothing else: every migration name must carry an
 * `applied`/`baseline` row. There used to be a fallback comparing the version stamp,
 * and it answered a DIFFERENT question — "is the stamp current" rather than "is
 * everything applied" — which under a name key can disagree: an entry may be missing
 * by name while the stamp is already past its position, because the stamp was reached
 * by a different route on another branch.
 *
 * No log to read → `false`, deferring to the writable open. That is the safe
 * direction: the writable open migrates (a no-op when there is nothing to do) and
 * surfaces any real fault itself, whereas guessing `true` here would leave a database
 * unmigrated with nothing reporting it.
 *
 * ⚠ Deliberately does NOT read the `ddl` column. `defaultModelBuilder` calls
 * `ensureDashboardDbExists` on EVERY `/api/model` — once per page load and once per
 * 30 s poll for as long as the tab is open — and the first entry's SQL alone is
 * ~35 KB. `readAppliedMigrationNames` exists to keep this to two columns.
 */
export function isSchemaCurrent(db: DashboardDbHandle): boolean {
	const done = readAppliedMigrationNames(db);
	if (!done) return false;
	return MIGRATIONS.every((m) => done.has(m.name));
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
 * deliberately does not: this caller answers BOTH the same way — {@link
 * isSchemaCurrent} just returns `false` and defers to the writable open, there is
 * no version stamp left to fall back on — so it needs no `migrationLogTableExists`
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
 * A schema written by a NEWER build needs no writable open either: `isSchemaCurrent`
 * finds every name this build carries already applied and short-circuits. Nothing
 * refuses such a file — `verifyMigrationLog` names the unknown migrations in the log
 * and the open proceeds.
 *
 * The short-circuit asks the log by name. It used to be able to fall back to a
 * version stamp, which answers a different question: a file can sit at the current
 * stamp with a named migration still missing, and gating on the stamp would skip the
 * one writable open that would apply it — reopening the read-only 500 this function
 * exists to prevent.
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
