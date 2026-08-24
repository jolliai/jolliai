import { type DbMigration, sqlMigration } from "./MigrationHelpers.js";

/**
 * Entry 5 — creates `schema_migrations` itself. Every entry before this one runs
 * before there is anywhere to record it; `migrateDashboardDb` holds their rows in
 * memory and flushes them inside THIS entry's own transaction, right after it
 * creates the table, so `seq` order still reads as history. See the docblock on
 * `migrateDashboardDb` in `DashboardDb.ts`.
 *
 * The migration log — "who ran what, when, and how did it go".
 *
 * A LOG, not a set of booleans, which is what fixes the table shape: the primary
 * key is an autoincrementing sequence because one migration can be touched more
 * than once (skipped by a loser writer, later applied; re-applied after a
 * snapshot restore), and every touch is worth keeping. `schema_meta` is the
 * wrong home for exactly that reason — it is a whole-database singleton (one key,
 * one value) and both its columns are TEXT, so `seq`/`applied_at_ms` would
 * degrade to strings and `ORDER BY seq` to lexicographic order.
 *
 * NOT `WITHOUT ROWID`, unlike its neighbours: `AUTOINCREMENT` requires a rowid,
 * and the table would simply fail to create.
 *
 * The columns each stop a different failure, and none is decorative:
 *
 *  - `name` is the IDENTITY of a migration — the exported DDL constant's name,
 *    not its position in the array. Position as identity is what let two
 *    unmerged branches both claim index 5, so that the one merged second was
 *    silently never executed while the file was stamped as fully migrated. Under
 *    a name key that conflict does not exist: whichever entries are missing get
 *    applied. The cost is that a name is a PERMANENT identifier — renaming one
 *    reads as "never ran" and re-runs it into `duplicate column`.
 *  - `outcome = 'skipped'` records the concurrency skip that used to leave no
 *    trace at all. That is the row the bug above would have been diagnosed from.
 *  - `outcome = 'failed'` is written OUTSIDE the migration's transaction, after
 *    the rollback — inside it the row would roll back with the change it
 *    describes, which is precisely when a trace is most needed (most callers of
 *    `withDashboardDb` swallow the exception, so the user may see no log at all).
 *  - `outcome = 'baseline'` marked a SEEDED row: on a database that predated this
 *    table, 0.99.12/0.99.13's first upgrade wrote one row per already-applied
 *    entry, inferred from the old `schema_version` stamp (Flyway calls this
 *    taking over an existing database, and uses the same word) — a guess about
 *    which DDL actually ran, so it said so rather than claiming to be an
 *    observation. Nothing writes this outcome any more: that inference was
 *    retired (see the compatibility note at the top of `DashboardDb.ts`), and a
 *    pre-log database now has every entry REPLAYED and recorded `applied`
 *    instead. The value is still READ as done — those old rows exist on real
 *    databases and demoting them would replay their entries on every open for
 *    ever — so `outcome` keeps `'baseline'` in its CHECK, but nothing produces
 *    a new one.
 *  - `ddl` stores the statement text VERBATIM, which no server-side migration
 *    tool does — they record a script name because the script is in the version
 *    control the operator is standing in. Here the DDL that ran may have come
 *    from a branch that was never merged, or has since been deleted, and the
 *    user's machine has no repository to consult. It USED TO double as a drift
 *    check: a runtime byte compare against the current constant, needing no
 *    checksum column because the DDL constants interpolate nothing at runtime (so
 *    the comparison was exact), reading all of it measured at 0.033 ms against
 *    0.014 ms without. That runtime compare is gone (see the note at the end of
 *    `verifyMigrationLog` in `DashboardDb.ts`), so nothing reads this column
 *    automatically any more — what is left is why full text over a hash is still
 *    the right call, below.
 *
 *    **Replacing it with a hash was proposed and rejected on measurement — do not
 *    re-propose it without new numbers.** On a real 61 MB database the whole column
 *    is 47.3 KB, or 0.079% of the file, and 81% of that sits in `baseline` rows the
 *    since-removed drift check never even compared. So the saving would have been
 *    ~0.019 ms per writable open and eight hundredths of one percent of disk,
 *    against a migration that alters the ledger table itself. What it would cost is
 *    the only route to the bytes an unmerged build actually applied, in precisely
 *    the case that route exists for. That route is MANUAL: `doctor --schema-log`
 *    prints outcomes, timings and the unrecognized NAMES, never the text, so reading
 *    it means opening the file with `sqlite3`. That is the accepted cost of a column
 *    nothing compares or displays automatically any more — not an argument for
 *    deleting the evidence.
 *  - `duration_ms` is operational: the baseline entry alone is ~37 KB and ~130
 *    objects, and a future entry that rebuilds a large table can take tens of
 *    seconds on a large database — which the user experiences as "startup hung".
 *
 * It is evidence, NOT a recovery source: it records what DID run, which cannot
 * be inverted into what SHOULD have. Do not build a "replay the log to repair"
 * tool on it.
 */
export const SCHEMA_MIGRATIONS_DDL: DbMigration = sqlMigration(
	"SCHEMA_MIGRATIONS_DDL",
	`
CREATE TABLE IF NOT EXISTS schema_migrations (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Which array position it ran at. DIAGNOSTIC ONLY — nothing decides anything
  -- from it. Kept because "slot 5" is what a bug report says out loud.
  slot          INTEGER NOT NULL,
  name          TEXT    NOT NULL,
  outcome       TEXT    NOT NULL CHECK (outcome IN ('applied','failed','skipped','baseline')),
  -- \`JOLLI_CLIENT_HEADER\` — '<kind>/<version>', e.g. 'cli/0.99.11' or
  -- 'vscode-plugin/0.99.11'. The surface identity the user would go and upgrade.
  applied_by    TEXT    NOT NULL,
  applied_at_ms INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  ddl           TEXT    NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_schema_migrations_name ON schema_migrations(name, seq);
`,
);
