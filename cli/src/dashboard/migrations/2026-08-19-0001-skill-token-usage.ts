import { addColumnIfMissing, type DbMigration } from "./MigrationHelpers.js";

/**
 * Entry 9 — one of the two add-column entries that arrived on `main` while the
 * idempotency pass was in flight on another branch (see `SESSION_ACTIVITY_DDL`'s
 * docblock for the full context). Unlike its `CREATE`-only siblings, an add-column
 * step cannot be re-runnable SQL at all, so this one is a code entry rather than an
 * `IF NOT EXISTS` edit.
 *
 * NULLABLE with no DEFAULT, deliberately: a 0 would spell "measured, and it was
 * free" for the hosts that report nothing. See the `SKILL_TOKEN_USAGE_DDL` note in
 * `SotSchema.ts`.
 */
export const SKILL_TOKEN_USAGE_DDL: DbMigration = {
	name: "SKILL_TOKEN_USAGE_DDL",
	run: (db) => {
		addColumnIfMissing(db, "session_tool_use", "input_tokens", "INTEGER");
		addColumnIfMissing(db, "session_tool_use", "output_tokens", "INTEGER");
		addColumnIfMissing(db, "session_tool_use", "cached_tokens", "INTEGER");
		addColumnIfMissing(db, "session_tool_use", "usage_confidence", "TEXT");
	},
};
