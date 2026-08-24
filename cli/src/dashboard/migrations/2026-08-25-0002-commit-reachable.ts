import { addColumnIfMissing, type DbMigration } from "./MigrationHelpers.js";

/**
 * The commit-tier twin of `2026-08-25-0001-memory-reachable`, for the stats and
 * standup feeds.
 *
 * Those filter COMMIT hashes (a standup line's own hash, and a memory feed's
 * `live_hash` alias), not `memories.reachable` — a rewritten memory is filed under an
 * unreachable hash while its live alias is reachable, so the two tiers ask different
 * questions and need their own flags. `pruneUnreachableCommits` still DELETES rows
 * during a full sweep; this flag is what the between-sweep daemon reconcile sets so a
 * commit orphaned since the last prune is filtered in SQL without a per-read
 * `git rev-list`. Same DEFAULT 1 fail-toward-visible rule as the memory column.
 *
 * Add-column-only, so a code entry rather than `sqlMigration` — guarded by the
 * companion test beside this file. `NOT NULL DEFAULT 1` fills every existing row on
 * the ALTER, so no null backfill is needed.
 */
export const COMMIT_REACHABLE_DDL: DbMigration = {
	name: "2026-08-25-0002-commit-reachable",
	run: (db) => addColumnIfMissing(db, "commits", "reachable", "INTEGER NOT NULL DEFAULT 1"),
};
