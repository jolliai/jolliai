/**
 * Reads the machine database and assembles one session-sync batch.
 *
 * Lives under `dashboard/` because it is a reader of the dashboard database, and
 * nothing under `core/` opens that file. It does the SQL and nothing else — no
 * network, no cursor persistence, no gating — so the whole "which rows would go
 * out" question can be tested against a real database without a server.
 *
 * Three rules from the format decide almost everything here:
 *
 *  1. **Values pass through untouched.** Millisecond integers stay integers,
 *     `hit` stays 0/1, `commits_json` stays the JSON string it is. Whether the
 *     sync is correct then becomes a field-by-field comparison rather than a
 *     question about two representations.
 *  2. **Three projections are explicit** — `repo_id` becomes the repo's identity
 *     and display name, while local `body_chars` becomes wire-safe
 *     `injected_chars`. See `SessionPushManifest.PROJECTED_COLUMNS`.
 *  3. **Selection walks the sync stamp**, never a business column, and uses
 *     `>=` rather than `>`.
 */

import type { TableCursor } from "../core/SessionPushCursor.js";
import { createLogger } from "../Logger.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import {
	BATCH_LIMITS,
	EXCLUDED_COLUMNS,
	PROJECTED_COLUMNS,
	SYNCED_COLUMNS,
	SYNCED_TABLES,
	type SyncedTable,
} from "./SessionPushManifest.js";
import { KEYSET_COLUMNS, syncStampColumn, WINDOW_SOURCES } from "./SyncColumns.js";

const log = createLogger("SessionPushReader");

/** How far back the FIRST run reaches when there is no cursor. */
export const FIRST_RUN_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** One table's slice of a batch. */
export interface TableSlice {
	readonly rows: ReadonlyArray<Record<string, unknown>>;
	/**
	 * Keyset of the LAST row in `rows` — where this table's cursor moves to.
	 *
	 * The last row rather than the largest stamp, and those are different answers:
	 * `ORDER BY` is the keyset itself, so the last row is the maximum of the tuple
	 * that actually pages the table. Taking the largest STAMP is what deadlocked —
	 * within a millisecond that is the cursor the read started from.
	 */
	readonly next?: TableCursor;
	/**
	 * Rows this table will never send because they fall outside the first-run
	 * window. The whole table's count, not this batch's: the window is part of
	 * the SELECT, so the rows it excludes never come back to be counted — and a
	 * per-batch figure understated the trade anyway, since it could only see as
	 * far as one `LIMIT` reached. 0 once a cursor exists.
	 */
	readonly skipped: number;
}

export type SessionBatch = Readonly<Record<SyncedTable, TableSlice>>;

export interface ReadBatchOptions {
	/** Per-table cursor. An absent entry means "first run for this table". */
	readonly cursors: Partial<Record<SyncedTable, TableCursor>>;
	/** Now, for the first-run window. */
	readonly nowMs: number;
	/**
	 * Repo identities whose rows must never leave this machine — the repos
	 * `jolli disable` is set on. Absent or empty leaves every statement here
	 * byte-identical to what it was before the exclusion existed, which is the
	 * normal case.
	 *
	 * ⚠ The identities come from `profile.json` (`isRepoDisabled`), never from
	 * `repos.disabled_at`: that column is a projection only `dbBackfillRepos`
	 * writes, so it stays set for a while after a re-enable — and a row skipped
	 * during that lag is skipped for ever, since the cursor pages over it.
	 */
	readonly excludedIdentities?: ReadonlySet<string>;
}

/**
 * The database's own identity, WITHOUT minting one.
 *
 * `Backup.ensureInstanceId` creates the id when it is missing, which is right
 * for a writer and wrong here: this whole path is read-only, and a sync must
 * never be the thing that first writes to the database. An absent id simply
 * means "cannot verify", and the caller treats that as "do not bind".
 */
export function readDbInstanceId(db: DashboardDbHandle): string | undefined {
	const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'instance-id'").get() as
		| { value?: string }
		| undefined;
	return typeof row?.value === "string" ? row.value : undefined;
}

/**
 * The SELECT for one table.
 *
 * `repo_id` is joined out to `repos.repo_identity` here rather than mapped in
 * TypeScript so the identity travels on the row, which is what makes a batch
 * able to carry several repos at once — the envelope has no repo field at all.
 *
 * ⚠ The identity is taken from `repos.repo_identity`, deliberately not from
 * `getCanonicalRepoUrl`. A repo with no remote is `local:<hash of path>` in this
 * column — a substitution the schema made on purpose, because the alternative
 * puts an absolute path and a home directory into every table. That fallback
 * still returns `file:///<path>` elsewhere, and it must never reach this wire.
 */
function selectFor(table: SyncedTable, windowSql: string | undefined, excludeSql: string | undefined): string {
	const stamp = syncStampColumn(table);
	const keys = KEYSET_COLUMNS[table];
	const columns = SYNCED_COLUMNS[table]
		.map((column) => {
			const local = PROJECTED_COLUMNS[table][column];
			if (local === undefined) return `t.${column}`;
			// `repo_id` projections read the related row; every other projection is
			// a wire-safe alias for a column on the table itself.
			return local === "repo_id" ? `r.${column} AS ${column}` : `t.${local} AS ${column}`;
		})
		.join(", ");
	const join = SYNCED_COLUMNS[table].some((column) => PROJECTED_COLUMNS[table][column] === "repo_id")
		? " JOIN repos r ON r.id = t.repo_id"
		: "";
	const window = windowSql === undefined ? "" : ` AND ${windowSql}`;
	const exclude = excludeSql === undefined ? "" : ` AND ${excludeSql}`;
	// A ROW VALUE comparison, which SQLite has supported since 3.15 — the tuple
	// `(stamp, ...pk)` is unique, so paging on it always advances. Comparing the
	// stamp alone cannot: more rows may share one millisecond than a batch holds,
	// and then every pass returns the same rows and the cursor stands still (see
	// `KEYSET_COLUMNS`).
	//
	// `>=`, not `>`, and the reason is unchanged from when the stamp stood alone:
	// a cursor that steps OVER a row never revisits it, and re-sending costs
	// nothing because the server upserts. With the key in the tuple that costs
	// exactly one duplicated row per batch — the boundary row — instead of a
	// whole millisecond.
	//
	// ORDER BY repeats the tuple exactly. A different order here does not fail,
	// it silently pages over rows.
	const tuple = `(t.${stamp}, ${keys.map((k) => `t.${k}`).join(", ")})`;
	const params = `(?, ${keys.map(() => "?").join(", ")})`;
	const order = [`t.${stamp} ASC`, ...keys.map((k) => `t.${k} ASC`)].join(", ");
	return `SELECT ${columns} FROM ${table} t${join} WHERE ${tuple} >= ${params}${window}${exclude} ORDER BY ${order} LIMIT ?`;
}

/**
 * The cursor's key sized to this build's `KEYSET_COLUMNS`.
 *
 * A stored cursor can disagree — a position adopted from a backend that echoed
 * only a stamp has no key at all, and a schema change could alter the key's
 * width. Padding with `""` puts
 * the read at the START of that millisecond, so the degradation is re-delivering
 * one millisecond into an upsert. Truncating is the same trade in the other
 * direction. Neither can skip a row, which is the only outcome that would lose
 * data.
 */
function keyValues(table: SyncedTable, cursor: TableCursor): ReadonlyArray<string> {
	const width = KEYSET_COLUMNS[table].length;
	return Array.from({ length: width }, (_, i) => cursor.key[i] ?? "");
}

/** Keyset of the last row of a page — the cursor the next page starts from. */
function nextCursor(table: SyncedTable, rows: ReadonlyArray<Record<string, unknown>>): TableCursor | undefined {
	const last = rows[rows.length - 1];
	if (last === undefined) return undefined;
	const stamp = last[syncStampColumn(table)];
	if (typeof stamp !== "number") return undefined;
	return { stamp, key: KEYSET_COLUMNS[table].map((c) => String(last[c] ?? "")) };
}

/**
 * The first-run window as a SQL predicate on alias `t`, with ONE `?` for the
 * floor.
 *
 * Two shapes — see `WINDOW_SOURCES`, whose union is what guarantees there is
 * always exactly one:
 *
 *  - A table with its own business clock is filtered on that column. A row whose
 *    clock is NULL has no date to be judged on, so it is KEPT — the same reading
 *    as the `typeof at !== "number"` this replaced.
 *  - A table with no clock is filtered through its parent SESSION, because that
 *    is where its date lives. `session_model_usage` used to get no window at all,
 *    so a first run shipped the whole table — including children of the very
 *    sessions the window had just withheld. `EXISTS` also drops a row whose
 *    parent session is missing outright, which is right for the same reason: it
 *    cannot be filed anywhere on arrival.
 *
 * A single predicate serves both the SELECT and the count below, so "what the
 * window admits" and "what the window cost" cannot drift apart.
 */
function windowPredicate(table: SyncedTable): string {
	const source = WINDOW_SOURCES[table];
	return "own" in source
		? `(t.${source.own} IS NULL OR t.${source.own} >= ?)`
		: `EXISTS (SELECT 1 FROM sessions ws WHERE ws.event_id = t.${source.parent} AND ws.updated_at_ms >= ?)`;
}

/**
 * The `jolli disable` exclusion as a SQL predicate on alias `t`, with one `?`
 * per excluded identity — or `undefined` when nothing is excluded.
 *
 * ⚠ It has to be part of the SELECT, for the same reason the window does (see
 * {@link readTableSlice}): filtered after `LIMIT`, a table whose oldest page is
 * all excluded comes back empty, no stamp is learned, and that table stops
 * syncing permanently.
 *
 * The consequence of being inside the SELECT is the deliberate cost of this
 * feature: selection pages OVER an excluded row, so statistics written before a
 * repo was disabled are not uploaded and are NOT sent later if it is re-enabled.
 * The Settings copy says exactly that. Sending them on re-enable would need a
 * per-repo cursor; holding the cursor back instead would let one disabled repo's
 * single row block every other repo on the machine.
 *
 * Two shapes, because only `sessions` carries the repo:
 *
 *  - `sessions` already joins `repos` as `r` to put `repo_identity` on the wire,
 *    so it just tests that column.
 *  - The four child tables reach it through their parent session. Spelled as
 *    `NOT EXISTS (… IN (excluded))` rather than `EXISTS (… NOT IN (…))` on
 *    purpose: a row is withheld only when it can be PROVEN to belong to a
 *    disabled repo, so a child whose parent session is missing keeps the
 *    behaviour it had before — this predicate is not the place to start dropping
 *    rows for a second reason.
 *
 * A table with neither column is a privacy decision nobody has made, so it
 * throws rather than silently sending everything: the caller turns that into a
 * skipped run, which is the safe direction.
 */
function excludedRepoPredicate(table: SyncedTable, count: number): string | undefined {
	if (count === 0) return undefined;
	const list = Array.from({ length: count }, () => "?").join(", ");
	if (SYNCED_COLUMNS[table].includes("repo_identity")) return `r.repo_identity NOT IN (${list})`;
	if (SYNCED_COLUMNS[table].includes("session_event_id")) {
		return `NOT EXISTS (SELECT 1 FROM sessions ds JOIN repos dr ON dr.id = ds.repo_id
		      WHERE ds.event_id = t.session_event_id AND dr.repo_identity IN (${list}))`;
	}
	/* v8 ignore next 2 -- structural guard: every SYNCED_TABLE carries one of the two columns today, and `SessionPushManifest.test.ts` is what keeps it that way */
	throw new Error(`SessionPushReader: ${table} has no way to identify its repo — cannot honour jolli disable`);
}

/**
 * How many rows the first-run window will never send.
 *
 * A separate COUNT because the window is inside the SELECT: the rows it excludes
 * never reach JS to be counted. Deliberately blind to the `jolli disable`
 * exclusion: this number is the WINDOW's account of what it declined, and a repo
 * the user switched off is a different question with its own log line. `NOT (<the same predicate>)` rather than a
 * hand-written inverse — an inverse spelled twice is an inverse that can be
 * spelled wrong, and this one is only ever read as a log line, so a wrong number
 * here would never be contradicted by anything. Only run on a first run, which
 * is once per table per backend.
 */
function countOutsideWindow(db: DashboardDbHandle, table: SyncedTable, windowSql: string, floorMs: number): number {
	const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} t WHERE NOT (${windowSql})`).get(floorMs) as
		| { n?: number }
		| undefined;
	return row?.n ?? 0;
}

/**
 * Reads one table's next slice.
 *
 * On a first run (no cursor) the window is applied to the table's BUSINESS time,
 * not to the stamp — the two are different columns and confusing them here is
 * quietly wrong in a specific way: a backfill rewrites every old row's stamp to
 * "just now", so a stamp-based window would admit sessions from years ago as
 * though they were recent. A table with no business clock of its own
 * (`session_model_usage`) is windowed through its parent session instead — see
 * {@link windowPredicate}.
 *
 * ⚠ The window is part of the SELECT, and putting it back on the RESULT is the
 * bug it was moved out of. Filtered afterwards it sits on the wrong side of
 * `LIMIT`: a table whose oldest `LIMIT` rows are all outside the window comes
 * back with nothing kept, so no stamp is learned, so the cursor never moves —
 * and the next run reads and drops exactly the same rows. That table stops
 * syncing PERMANENTLY, with only a "skipped N rows" line to show for it. It is
 * not a corner case either: the migration backfills `sessions.written_at_ms`
 * from `updated_at_ms`, so stamp order tracks business order, and any machine
 * with more than one batch of sessions older than the window starts there.
 * Inside the SELECT, `LIMIT` counts only rows that will actually be sent.
 */
export function readTableSlice(db: DashboardDbHandle, table: SyncedTable, opts: ReadBatchOptions): TableSlice {
	const cursor = opts.cursors[table];
	const limit = BATCH_LIMITS[table];
	// Non-undefined only when the window applies: a first run, on a table the
	// window can be expressed on.
	const windowSql = cursor === undefined ? windowPredicate(table) : undefined;
	const floorMs = opts.nowMs - FIRST_RUN_WINDOW_MS;
	const from = keyValues(table, cursor ?? { stamp: 0, key: [] });
	// One statement for both cases: the window arm's stamp was written as a
	// literal 0 before, which is the same value — `windowSql` is non-undefined
	// only when there is no cursor. Parameter order follows the SQL exactly:
	// keyset, then the window floor, then the excluded identities, then LIMIT.
	const excluded = [...(opts.excludedIdentities ?? [])];
	const excludeSql = excludedRepoPredicate(table, excluded.length);
	const rows = db
		.prepare(selectFor(table, windowSql, excludeSql))
		.all(cursor?.stamp ?? 0, ...from, ...(windowSql === undefined ? [] : [floorMs]), ...excluded, limit) as Array<
		Record<string, unknown>
	>;

	const next = nextCursor(table, rows);
	const skipped = windowSql === undefined ? 0 : countOutsideWindow(db, table, windowSql, floorMs);
	return { rows, ...(next !== undefined ? { next } : {}), skipped };
}

/** Reads every table's next slice. */
export function readSessionBatch(db: DashboardDbHandle, opts: ReadBatchOptions): SessionBatch {
	const batch = {} as Record<SyncedTable, TableSlice>;
	let skipped = 0;
	for (const table of SYNCED_TABLES) {
		batch[table] = readTableSlice(db, table, opts);
		skipped += batch[table].skipped;
	}
	// The first-run window is a trade, not an optimisation, so what it cost has to
	// be visible somewhere rather than inferred from a number that looks low. This
	// is the whole backlog it declines, counted once on the run that declines it.
	if (skipped > 0) log.info("session sync: skipping %d row(s) older than the 90-day first-run window", skipped);
	return batch;
}

/**
 * True when some table filled its batch limit, so there is certainly more.
 *
 * This — not the cursor — is what ends the loop. Selection is `>=`, so the row
 * sitting exactly on the cursor is deliberately re-read on the next pass; a loop
 * that stopped only when a batch came back empty would therefore re-send that
 * boundary row until it hit the per-run ceiling. Asking "was anything
 * truncated?" answers the real question directly.
 *
 * Safe to loop on only because the cursor is a keyset: it advances by at least
 * one row per pass, so "truncated" cannot mean "the same rows again". Against a
 * stamp-only cursor this same `true` drove a spin — see `KEYSET_COLUMNS`.
 */
export function isBatchTruncated(batch: SessionBatch): boolean {
	return SYNCED_TABLES.some((table) => batch[table].rows.length >= BATCH_LIMITS[table]);
}

/** True when no table has anything to send. */
export function isBatchEmpty(batch: SessionBatch): boolean {
	return SYNCED_TABLES.every((table) => batch[table].rows.length === 0);
}

/** Total rows across every table — for logging and the batch-loop's progress check. */
export function batchSize(batch: SessionBatch): number {
	return SYNCED_TABLES.reduce((sum, table) => sum + batch[table].rows.length, 0);
}

/** The wire payload's `tables` object: only the tables that have rows. */
export function batchTables(batch: SessionBatch): Record<string, ReadonlyArray<Record<string, unknown>>> {
	const tables: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
	for (const table of SYNCED_TABLES) {
		if (batch[table].rows.length > 0) tables[table] = batch[table].rows;
	}
	return tables;
}

/** Every local column of `table` this build knows about — the manifest's view. */
export function declaredLocalColumns(table: SyncedTable): ReadonlyArray<string> {
	return [...SYNCED_COLUMNS[table].map((c) => PROJECTED_COLUMNS[table][c] ?? c), ...EXCLUDED_COLUMNS[table]];
}
