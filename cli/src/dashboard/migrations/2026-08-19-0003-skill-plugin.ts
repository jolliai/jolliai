import { addColumnIfMissing, type DbMigration } from "./MigrationHelpers.js";

/**
 * Entry 11 — the other add-column entry from the same pre-idempotency window as
 * `SKILL_TOKEN_USAGE_DDL` (see its docblock for the full context). Which plugin
 * provides a skill, on the aggregate rather than the detail — see the
 * `SKILL_PLUGIN_DDL` note in `SotSchema.ts`.
 */
export const SKILL_PLUGIN_DDL: DbMigration = {
	name: "SKILL_PLUGIN_DDL",
	run: (db) => addColumnIfMissing(db, "session_tool_use", "plugin", "TEXT"),
};
