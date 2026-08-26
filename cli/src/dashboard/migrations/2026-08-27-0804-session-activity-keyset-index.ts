import { sqlMigration } from "./MigrationHelpers.js";

/**
 * Keyset index for `session_activity`'s session-sync paging.
 *
 * `session_activity` joined the session-sync channel (`SYNCED_TABLES`) but shipped
 * with only `ix_activity_recorded(recorded_at_ms)` — the stamp alone. The reader
 * pages with the row-value `(recorded_at_ms, session_event_id, bucket_ms) >= ?`
 * ORDER BY the same three columns (`SessionPushReader.selectFor`), which a
 * single-column index cannot drive: the planner seeks on `recorded_at_ms` and then
 * `USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY`. The backfill stamps a whole cohort
 * of sessions with one `recorded_at_ms`, so that temp sort re-scans every row sharing
 * the stamp on every 200-row page — quadratic in the size of the cohort.
 *
 * Every sibling synced table already carries the matching composite (`ix_smu_keyset`,
 * `ix_stu_keyset`, `ix_sessions_keyset` in `SESSION_STATS_SYNC_DDL`; `ix_sue_sync`
 * already IS `(updated_at_ms, session_event_id, dedup_key)`). This entry gives
 * `session_activity` the same shape, in a NEW migration rather than by editing the
 * frozen `SESSION_ACTIVITY_DDL`.
 *
 * `IF NOT EXISTS` so a hand-repaired database that already carries the index is a
 * no-op rather than an error — which is what keeps this a pure-SQL `sqlMigration`
 * (re-runnable, fingerprinted) rather than a code entry.
 */
export const SESSION_ACTIVITY_KEYSET_INDEX_DDL = sqlMigration(
	"2026-08-27-0804-session-activity-keyset-index",
	`
CREATE INDEX IF NOT EXISTS ix_activity_keyset
  ON session_activity(recorded_at_ms, session_event_id, bucket_ms);
`,
);
