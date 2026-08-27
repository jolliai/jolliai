import { sqlMigration } from "./MigrationHelpers.js";

/**
 * Keyset index for `session_turns`' session-sync paging — the `session_turns`
 * sibling of `2026-08-27-0804-session-activity-keyset-index`, and needed for the
 * identical reason.
 *
 * `session_turns` joined the session-sync channel (`SYNCED_TABLES`) with only its
 * `PRIMARY KEY (session_event_id, slice_id, seq)`. The reader pages with the
 * row-value `(recorded_at_ms, session_event_id, slice_id, seq) >= ?` ORDER BY the
 * same four columns (`SessionPushReader.selectFor`, `KEYSET_COLUMNS.session_turns`
 * prefixed by `SYNC_STAMP_COLUMNS.session_turns`), which the primary key cannot
 * drive: it does not lead with `recorded_at_ms`, so the planner full-scans and
 * `USE TEMP B-TREE FOR ORDER BY` on every 200-row page — quadratic in table size.
 * `backfillStoredSessionTurns`' `SELECT MAX(recorded_at_ms)` full-scans for the
 * same missing-index reason.
 *
 * The backfill stamps a whole cohort with one `recorded_at_ms`, so that temp sort
 * re-scans every row sharing the stamp on every page — the same cohort-quadratic
 * shape the `session_activity` entry documents. This gives `session_turns` the
 * matching composite, in a NEW migration rather than by editing the frozen
 * `SESSION_TURNS_DDL`.
 *
 * `IF NOT EXISTS` so a hand-repaired database that already carries the index is a
 * no-op rather than an error — which keeps this a pure-SQL `sqlMigration`
 * (re-runnable, fingerprinted) rather than a code entry.
 */
export const SESSION_TURNS_KEYSET_INDEX_DDL = sqlMigration(
	"2026-08-28-0516-session-turns-keyset-index",
	`
CREATE INDEX IF NOT EXISTS ix_turns_keyset
  ON session_turns(recorded_at_ms, session_event_id, slice_id, seq);
`,
);
