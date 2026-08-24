import { addColumnIfMissing, type DbMigration } from "./MigrationHelpers.js";

/**
 * Entry 4 — the sibling of `EVENT_FAILED_KIND_DDL`: add-column-only, so it is a code
 * entry for the same reason. See `SotSchema.ts`'s `TOOL_CALL_TIME_DDL` historical
 * note for what this column is for and why it is permanently NULLABLE.
 *
 * An additive NULLABLE column precisely because the rows already on disk cannot be
 * backfilled (the transcripts they were read from may be gone), so they keep being
 * read under the old session-time fallback rather than dropping out of every window
 * for want of a value.
 */
export const TOOL_CALL_TIME_DDL: DbMigration = {
	name: "TOOL_CALL_TIME_DDL",
	run: (db) => addColumnIfMissing(db, "session_tool_use", "last_call_at_ms", "INTEGER"),
};
