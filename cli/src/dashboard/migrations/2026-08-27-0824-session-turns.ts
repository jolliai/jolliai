import { type DbMigration, sqlMigration } from "./MigrationHelpers.js";

/**
 * Adds `session_turns` — the text-free per-turn projection that feeds the web
 * coaching dashboard's per-user Activity/Turnaround signal.
 *
 * `session_activity` already answers "was this session active in this 15-minute
 * bucket"; this table answers a narrower question that bucket cannot: the exact
 * SEQUENCE and ROLE of what happened, without ever carrying what was said. It is
 * a sibling of `session_model_usage` / `session_tool_use` / `session_activity` in
 * every way that matters here — keyed off `sessions.event_id` with `ON DELETE
 * CASCADE`, `CREATE TABLE IF NOT EXISTS` so a re-run is a no-op — so it follows
 * the same additive-DDL shape rather than inventing a new one.
 *
 * `slice_id` is the owning transcript's id (`transcripts.transcript_id`), named
 * differently on purpose: this table is projected PER TRANSCRIPT SLICE, and a
 * session can span more than one slice over its life. `(session_event_id,
 * slice_id, seq)` is therefore the natural key — `seq` alone would collide across
 * slices of the same session, and `session_event_id` alone would collide across
 * sessions entirely.
 *
 * **Text-free by construction.** `role` and `kind` are the only columns that
 * carry anything human-readable, and both are closed vocabularies the writer
 * controls (`"human"|"assistant"` for `role`, `"turn"|"compaction"|"test-run"|
 * "turn-abort"` for `kind`) — never a copy of `TranscriptEntry.content`. See
 * `SessionTurnsProjection.ts`, the one place that writes this table.
 *
 * `seq` is per-(session, slice) and assigned by the projector in write order: one
 * `turn` row per transcript entry, in entry order, followed by one row per
 * instant in `compactions[]` / `testRuns[]` / `turnAborts[]`. It exists so the
 * cloud side can reconstruct ORDER without a timestamp — `ts_ms` is nullable
 * (an entry's `timestamp` may be absent or unparsable), so `seq` is the only
 * column this table guarantees is total and monotone.
 *
 * `recorded_at_ms NOT NULL` with no default, matching `session_activity`'s
 * `recorded_at_ms`: this table is new, so there is no pre-existing row that could
 * need a zero-sentinel backfill, and every row is stamped with its real
 * projection instant on the way in. It is a sync cursor, never a business time —
 * see `SYNC_STAMP_COLUMNS.session_turns` in `SyncColumns.ts`.
 *
 * Idempotent per `(session_event_id, slice_id)`, not insert-only like
 * `session_activity`: re-parsing a transcript (an amend, a re-import) can change
 * which turns it contains, so `projectSessionTurns` deletes that slice's rows
 * before re-inserting rather than accumulating history the way a 15-minute
 * activity bucket does. `ON DELETE CASCADE` still applies — nothing deletes from
 * `sessions` today, and if something ever does, these rows reference a parent
 * that no longer exists either way.
 */
export const SESSION_TURNS_DDL: DbMigration = sqlMigration(
	"2026-08-27-0824-session-turns",
	`
CREATE TABLE IF NOT EXISTS session_turns (
  session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE,
  slice_id         TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  role             TEXT,
  ts_ms            INTEGER,
  kind             TEXT NOT NULL,
  recorded_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (session_event_id, slice_id, seq)
) STRICT;
`,
);
