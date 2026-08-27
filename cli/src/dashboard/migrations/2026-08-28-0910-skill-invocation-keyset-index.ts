import { sqlMigration } from "./MigrationHelpers.js";

/**
 * Keyset index for `skill_invocations` session-sync paging.
 *
 * The reader orders by `(updated_at_ms, session_event_id, skill_name, at_ms)`.
 * The table's primary key starts at `session_event_id`, while
 * `ix_si_skill_time` starts at `skill_name`, so neither can seek or satisfy that
 * order. Without the exact composite SQLite scans and temp-sorts the whole table
 * for every 500-row page. This entry is separate from the already-pushed add-
 * column migration: migration identity is permanent once it has left a machine.
 */
export const SKILL_INVOCATION_KEYSET_INDEX_DDL = sqlMigration(
	"2026-08-28-0910-skill-invocation-keyset-index",
	`
CREATE INDEX IF NOT EXISTS ix_si_keyset
  ON skill_invocations(updated_at_ms, session_event_id, skill_name, at_ms);
`,
);
