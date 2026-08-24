import { addColumnIfMissing, type DbMigration } from "./MigrationHelpers.js";

/**
 * Entry 3 — add-column-only, so it cannot be SQL and stay re-runnable — hence a
 * `run` rather than a `sql`. The `EVENT_FAILED_KIND_DDL` constant of the same name
 * in `SotSchema.ts` used to hold the original `ALTER` text and is now a historical
 * NOTE under that name: the text was read by nothing (fixtures replay the assembled
 * `MIGRATIONS` list, never a hand-kept copy of the old bytes), while the column
 * reasoning it carried is current and stayed there.
 */
export const EVENT_FAILED_KIND_DDL: DbMigration = {
	name: "EVENT_FAILED_KIND_DDL",
	run: (db) => addColumnIfMissing(db, "events_raw", "failed_kind", "TEXT"),
};
