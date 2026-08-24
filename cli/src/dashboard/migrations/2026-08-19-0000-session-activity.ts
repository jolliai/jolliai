import { type DbMigration, sqlMigration } from "./MigrationHelpers.js";

/**
 * Entry 8 — adds `session_activity`, with `recorded_at_ms` NOT NULL from the start.
 * Carrying the column in the CREATE rather than appending it later is the whole
 * reason it can be NOT NULL: SQLite's `ADD COLUMN` takes only a CONSTANT default,
 * and the value is a wall-clock instant. That is `TOOL_CALL_TIME_DDL`'s
 * `last_call_at_ms` shape, whose permanent `NULLIF` handling at every read site is
 * the price of having had no choice — here there was one, so it was taken.
 *
 * This entry (and `SKILL_INVOCATIONS_DDL` after it) arrived on `main` while the
 * idempotency pass documented in AGENTS.md was in flight on another branch, so they
 * are part of the SAME pre-idempotency population as the entries that pass edited —
 * written before it landed, merely on another branch. They are finished the same
 * way rather than by a second rule: this one is a pure `CREATE`, so `IF NOT EXISTS`
 * was added in place and it stays fingerprinted. Its add-column siblings
 * (`SKILL_TOKEN_USAGE_DDL`, `SKILL_PLUGIN_DDL`) could not be, so those are code
 * entries instead.
 *
 * A dev machine that ran an EARLIER draft of this entry has the table under the same
 * name, so the name key reads it as applied and does not replay it. If the draft's
 * shape differed, that is drift rather than a missing table — and nothing detects it
 * automatically any more (see the note at the end of `verifyMigrationLog` in
 * `DashboardDb.ts`): the row's stored `ddl` still holds the draft's bytes and can be
 * read with `sqlite3` when a real question arises, but the repair is the operator's
 * to notice and to make — `DROP TABLE session_activity`, then
 * `jolli doctor --mark-migration` or a stamp the entry can replay under. Nothing here
 * self-heals a column, and nothing should: replaying DDL over a table whose contents
 * this build cannot vouch for is how a half-migrated file is made.
 *
 * One row per (session, 15-minute bucket) in which that session produced a
 * message — the input to the concurrency figure.
 *
 * `bucket_ms` holds an ABSOLUTE epoch-ms bucket start, not a localised day or
 * hour key: time zone is a render-time concern that `localDayKey` / `localHour`
 * already handle in the query layer, and a stored localised copy would be a
 * second answer to a question that already has one.
 *
 * Buckets rather than a stored `(start, end)` interval because a resumed
 * session is common and its span is not its presence — measured, the longest
 * session on the author's machine spans 18 hours across 28 messages. A bucket
 * list occupies only the quarter-hours the session actually spoke in, with no
 * gap-threshold parameter to tune.
 *
 * `INTEGER` under STRICT is load-bearing twice: `node:sqlite` returns these as
 * JS numbers (epoch ms sits ~5000x below `Number.MAX_SAFE_INTEGER`), and STRICT
 * REJECTS a REAL here, so a missing `Math.floor` upstream fails at insert
 * instead of storing a fractional bucket that defeats the primary key.
 *
 * ## This table is INSERT-ONLY, unlike its two siblings
 *
 * `projectSession` replaces `session_model_usage` and `session_tool_use`
 * wholesale on every observed read, and this table deliberately does NOT follow
 * that contract. Those two restate a CURRENT TOTAL — a re-read that attributes
 * tokens to fewer models supersedes the old split, and leaving a stale row would
 * stop the split summing to the scalar columns. A bucket is not a total; it is a
 * MONOTONE HISTORICAL FACT. "This session produced a message in this
 * quarter-hour" cannot become false, so there is no read whose result should
 * remove one.
 *
 * The reads that would have removed one are all cases where the EVIDENCE went
 * away, not the fact:
 *
 *  - A host that rotates or truncates its own store (the SQLite-backed sources
 *    own their retention; nothing here does).
 *  - Devin, whose `message_nodes` is a forest: a regeneration moves
 *    `sessions.main_chain_id`, so a re-read walks a DIFFERENT chain, not a
 *    superset of the old one. The developer was still present in those buckets.
 *
 * Under the old wholesale replace, both of those deleted true presence and the
 * transcript could no longer prove it — an unrecoverable loss. The cost of
 * insert-only is the mirror image and is recoverable: a bucket computed from a
 * BAD read (a parser reading Devin's epoch SECONDS as ms, a local-time string
 * parsed as UTC) now persists instead of being corrected by the next re-read.
 * That is a deliberate trade — a wrong row can be repaired by an explicit
 * rebuild, a deleted row cannot be repaired at all — and it is why no repair
 * path ships with this: the failure it guards against needs a parser bug first.
 *
 * `ON DELETE CASCADE` stays, and is not a hole in the above: nothing deletes
 * from `sessions` today, and if something ever does, these rows reference a
 * parent that no longer exists. Insert-only is a rule about RE-OBSERVATION, not
 * about referential cleanup.
 *
 * ## `recorded_at_ms` is a sync cursor, not a business time
 *
 * The instant the row was first INSERTed locally — deliberately NOT anything
 * about the conversation. `bucket_ms` cannot serve as a cursor: a backfill over
 * old transcripts inserts old buckets today, and a `bucket_ms > lastSync` reader
 * would skip every one of them. This column answers only "what is new SINCE my
 * last upload", which is the one question a downstream sync has to ask without
 * knowing anything about what a bucket means.
 *
 * `INSERT OR IGNORE` is what makes it stable: a re-observed bucket keeps the
 * timestamp of its FIRST insert rather than being bumped, so re-reading a
 * session every 60 s does not re-present its whole history as new work.
 *
 * Two properties a consumer must not assume. The clock is `Date.now()`, so it is
 * not monotonic across an NTP correction — pair the cursor with an idempotent
 * upstream upsert and resume at `>= lastSync` rather than `>`, which also
 * absorbs the same-millisecond boundary. And it is a LOCAL time: two machines
 * belonging to one developer stamp independently.
 */
export const SESSION_ACTIVITY_DDL: DbMigration = sqlMigration(
	"SESSION_ACTIVITY_DDL",
	`
CREATE TABLE IF NOT EXISTS session_activity (
  session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE,
  bucket_ms        INTEGER NOT NULL,
  recorded_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (session_event_id, bucket_ms)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_activity_bucket ON session_activity(bucket_ms);
CREATE INDEX IF NOT EXISTS ix_activity_recorded ON session_activity(recorded_at_ms);
`,
);
