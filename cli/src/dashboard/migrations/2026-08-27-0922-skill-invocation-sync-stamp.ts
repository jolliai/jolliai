import { addColumnIfMissing, type DbMigration } from "./MigrationHelpers.js";

/**
 * Gives per-invocation rows a write clock distinct from their event clock.
 *
 * `at_ms` is both identity and business time, but the writer may later upgrade
 * the outcome or metadata for that same invocation. A cursor on `at_ms` cannot
 * observe that rewrite once it has advanced past the event. Existing rows start
 * at zero so the next first-run/windowed sync delivers them once; every future
 * insert and conflict update stamps the current wall clock.
 *
 * Add-column-only, so this is a code entry with a companion test. The original
 * `SKILL_INVOCATIONS_DDL` is frozen and must not be edited.
 */
export const SKILL_INVOCATION_SYNC_STAMP_DDL: DbMigration = {
	name: "2026-08-27-0922-skill-invocation-sync-stamp",
	run: (db) => addColumnIfMissing(db, "skill_invocations", "updated_at_ms", "INTEGER NOT NULL DEFAULT 0"),
};
