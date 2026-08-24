/**
 * Leaf module for the migration engine's building blocks — {@link DbMigration},
 * {@link sqlMigration} and {@link addColumnIfMissing}.
 *
 * Kept separate from `DashboardDb.ts` on purpose. Every migration now lives in its
 * own file under `migrations/` (see `migrations/index.ts`), and every one of those
 * files needs these three names. If they stayed defined in `DashboardDb.ts` itself,
 * every migration file would import FROM `DashboardDb.ts` while `DashboardDb.ts`
 * imports the migration files (via `migrations/index.ts`) to build the list —
 * closing an import cycle. This module only needs the `DashboardDbHandle` TYPE from
 * `DashboardDb.ts`, which TypeScript erases at compile time (a type-only import
 * produces no runtime `require`/`import`), so no cycle actually forms.
 */

import type { DashboardDbHandle } from "../DashboardDb.js";

/**
 * One migration: a permanent name and something to run.
 *
 * Named `DbMigration`, not `Migration`, on purpose. This repo already spends the
 * bare word on five unrelated things — `core/MigrationEngine.ts` (the Memory Bank
 * migration), `KBTypes.ts`'s `MigrationState`, `core/SchemaV5Migration.ts`,
 * `core/SummaryMigration.ts`'s `MigrationMeta` and `sync/LegacyMigration.ts` — and
 * the narrowest of them should not hold the most general name.
 *
 * There is deliberately no `breaking` flag. One existed while the database still
 * decided compatibility for itself; with that gate gone it had no consumer, and a
 * declaration nothing reads is worse than none — it reads as a guarantee.
 */
export interface DbMigration {
	/**
	 * IDENTITY, and PERMANENT: the log is keyed by it, so renaming one makes it
	 * look like it never ran, which re-runs it into `duplicate column`. Positions
	 * may move; names may not.
	 *
	 * ⚠ The twelve `<CONSTANT>_DDL` names are RETROFITS, not chosen identifiers. Until
	 * 0.99.11 `MIGRATIONS` was a `ReadonlyArray<string>` applied by POSITION against a
	 * `schema_version` stamp; 0.99.12 introduced the log and promoted the TypeScript
	 * constant names that happened to build the array into permanent database keys.
	 * That promotion is the origin of every awkwardness here — a variable name became
	 * immutable — and it is why new entries are timestamped `YYYY-MM-DD-HHMM-<subject>`
	 * (UTC) instead. The timestamp buys uniqueness and a readable chronology; it is NOT
	 * a sort key, array order stays the execution order.
	 */
	readonly name: string;
	/**
	 * What to do. May exec SQL, may inspect the schema and branch (that is what
	 * `sql`-less entries are for).
	 *
	 * ⚠ MUST NOT derive business data — reading other tables, computing values in
	 * TypeScript and writing them back. Schema-shape work is what belongs here:
	 * `CREATE … IF NOT EXISTS`, {@link addColumnIfMissing}, and null-backfilling
	 * `UPDATE … WHERE … IS NULL`.
	 */
	readonly run: (db: DashboardDbHandle) => void;
	/**
	 * Present only on pure-SQL entries, and the reason it is optional is the whole
	 * enforcement story: the log's `ddl` column stores `sql ?? ""`, so a `sql`-less
	 * entry compares equal to itself for ever and is invisible to the drift check.
	 * `MigrationFingerprints.test.ts` therefore fingerprints the entries that carry
	 * it, and requires a companion test for every entry that does not.
	 */
	readonly sql?: string;
}

/**
 * A pure-SQL migration. Carries `sql` so CI can fingerprint it.
 *
 * This is the form every legacy entry takes, and the form to reach for by default:
 * an entry that can be expressed as SQL should be, because that is the only form
 * `MigrationFingerprints.test.ts` can hold to its bytes.
 */
export const sqlMigration = (name: string, sql: string): DbMigration => ({
	name,
	sql,
	run: (db) => db.exec(sql),
});

/** Identifiers are interpolated into DDL, so they are validated rather than quoted. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `decl` is a column type + constraint clause ("TEXT", "INTEGER NOT NULL DEFAULT 0"),
 * not a bare identifier, so it cannot be checked against {@link SAFE_IDENTIFIER} — a
 * real declaration needs keywords, spaces and the odd numeric or quoted default.
 * Deliberately narrow rather than permissive: letters, digits, underscore, spaces,
 * a single quote (a quoted default) and `.`/`-` (a fractional or negative default).
 * No `;` (a second statement), no `(` `)` (a subquery default) and no `--`/`/*`
 * (a comment that could swallow the trailing `;` this function appends) — none of
 * which any real declaration in this file needs.
 */
const SAFE_COLUMN_DECL = /^[A-Za-z0-9_ '.-]+$/;

/**
 * Adds a column only if the table does not already have it.
 *
 * Exists because SQLite has no `ALTER TABLE … ADD COLUMN IF NOT EXISTS` and no
 * conditional in DDL, so "add this column, and be a no-op the second time" cannot
 * be written as SQL at all. Every re-runnable add-column step therefore goes
 * through a `sql`-less {@link DbMigration} calling this.
 *
 * ⚠ It cannot restore a `NOT NULL` that was lost — SQLite has no `ALTER COLUMN`.
 * A database handed these columns by a pre-log build has them NULLABLE and unfilled
 * (see `SYNC_STAMP_NULL_BACKFILL_DDL`'s comment), and this function correctly does
 * nothing there. Pair it with the null backfill, never with it alone.
 *
 * `table`, `column` and `decl` are all interpolated, so all three are validated
 * first: they are source constants today, but an unvalidated interpolation here is
 * what CodeQL flags as SQL injection, and rightly.
 */
export function addColumnIfMissing(db: DashboardDbHandle, table: string, column: string, decl: string): void {
	if (!SAFE_IDENTIFIER.test(table)) throw new Error(`unsafe table name in migration: ${table}`);
	if (!SAFE_IDENTIFIER.test(column)) throw new Error(`unsafe column name in migration: ${column}`);
	if (!SAFE_COLUMN_DECL.test(decl)) throw new Error(`unsafe column declaration in migration: ${decl}`);
	const rows = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as ReadonlyArray<{ name?: string }>;
	if (rows.some((row) => row.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
}
