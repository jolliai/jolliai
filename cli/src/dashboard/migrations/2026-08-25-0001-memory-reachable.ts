import { addColumnIfMissing, type DbMigration } from "./MigrationHelpers.js";

/**
 * Materialised git-reachability for the memory feeds (coaching / memories).
 *
 * A memory row keyed by a commit that history was rewritten away from (rebase /
 * squash / reset / a force-fetched vendored repo) is deliberately KEPT — it is the
 * memory's content — but must not be presented as work a branch still carries. That
 * question ("is this commit reachable from any branch right now") only git can
 * answer, and asking it on every page load meant a `git rev-list --branches` per
 * repo on the read path (~280 ms on a 44k-commit repo, every load and every 30 s
 * poll). This column moves the answer OFF the read path: it is maintained
 * asynchronously (the dashboard backfill sweep and a global-daemon reconcile task run
 * `rev-list` and UPDATE it), and the feeds filter `WHERE reachable = 1` in SQL.
 *
 * DEFAULT 1 is the load-bearing choice: a brand-new commit IS its branch tip, so a
 * row is reachable until a sweep proves otherwise — an eventually-consistent column
 * must fail toward "visible", never hide a just-made memory before the first
 * reconcile runs. The accepted cost is symmetric: a just-orphaned commit stays
 * visible until the next sweep, which for the rare ref-only rewrites this guards is a
 * few minutes, not a correctness hole.
 *
 * Add-column-only (SQLite has no `ADD COLUMN IF NOT EXISTS`), so this is a code entry
 * rather than `sqlMigration`, exempt from the fingerprint check and guarded instead
 * by the companion test beside this file. `NOT NULL DEFAULT 1` fills every existing
 * row with 1 on the ALTER, so no null backfill is needed.
 */
export const MEMORY_REACHABLE_DDL: DbMigration = {
	name: "2026-08-25-0001-memory-reachable",
	run: (db) => addColumnIfMissing(db, "memories", "reachable", "INTEGER NOT NULL DEFAULT 1"),
};
