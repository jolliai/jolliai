import type { DashboardDbHandle } from "../DashboardDb.js";
import { addColumnIfMissing, type DbMigration } from "./MigrationHelpers.js";

/**
 * One counted model response: what it cost and WHEN it happened.
 *
 * The record every usage and billing system keeps, and the reason it exists here
 * is that `sessions` cannot answer the question it looks like it answers. That
 * row holds a whole conversation's cumulative tokens under a single timestamp,
 * so a conversation spanning three days contributes its ENTIRE spend to whichever
 * day it was last active — the earlier days read as zero. No care in the query
 * layer fixes that: the time was discarded before the write.
 *
 * With one row per response, "how much did I spend on the 1st" is a plain GROUP
 * BY, and a session becomes what it always was — a grouping, not a quantity.
 * `sessions` and `session_model_usage` keep their totals as DERIVED caches so the
 * KPI stays a scalar scan; both are written from these rows in the same
 * transaction, so they cannot disagree with the detail.
 *
 * Keyed on the response's own identity (`message.id` for Claude), falling back to
 * `line:<n>` for a response the source cannot name.
 *
 * ⚠ That `<n>` is the response's POSITION among the counted responses of the read,
 * not a transcript line number — the name is historical. Uniqueness within one
 * read is all it has to provide, because `projectSession` replaces a session's
 * rows wholesale (DELETE then INSERT) rather than upserting them, and the producer
 * re-reads the whole transcript. Do not lean on it as a stable identity across
 * reads: an earlier draft of this comment claimed append-only line numbers made it
 * one, and if the wholesale replacement ever became an upsert that claim is what
 * would make the change look safe.
 *
 * ⚠ NOT every source can fill this. `parseUsageTokens` is optional on
 * `TranscriptParser` and only the Claude parser implements it today, so sessions
 * from other sources have no rows here and keep being placed by their
 * session-level timestamp. `token_coverage` is what tells the two apart; the
 * dashboard must not present them as the same precision.
 *
 * ⚠ Instants, never local days. Bucketing is a READ-time decision because the
 * timezone is a property of whoever is asking — storing a day would repeat the
 * mistake this table exists to fix, one level up.
 */
const SESSION_USAGE_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS session_usage_events (
  session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE,
  -- The response's identity, or 'line:<n>' when the source cannot name one.
  dedup_key        TEXT NOT NULL,
  -- THIS response's instant. The column the whole table exists for; named for
  -- what it IS rather than what reads do with it, because those bucket it by a
  -- timezone the table deliberately does not store.
  responded_at_ms  INTEGER NOT NULL,
  -- Empty string when the transcript recorded usage without naming a model,
  -- matching how the whole-slice aggregate buckets those.
  model            TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cached_tokens    INTEGER NOT NULL DEFAULT 0,
  est_cost_usd     REAL,
  -- Sync stamp, same rule as SYNC_STAMP_DDL's columns: bumped on every write,
  -- never a business time. See that constant for why the two cannot be one.
  updated_at_ms    INTEGER NOT NULL,
  PRIMARY KEY (session_event_id, dedup_key)
) STRICT, WITHOUT ROWID;
-- Every read is "this window", and the window is on the RESPONSE's own time
-- rather than its session's — which is the point of the table.
CREATE INDEX IF NOT EXISTS ix_sue_at ON session_usage_events(responded_at_ms);
CREATE INDEX IF NOT EXISTS ix_sue_sync ON session_usage_events(updated_at_ms);
`;

/**
 * The rollup's day-scoped DELETE paths (`buildDay`'s whole-day replacement and
 * `forgetRollupDays`) filter on `tz` + `day`, neither of which is a PK prefix —
 * the PK leads with `repo_id`, so both currently scan. Small today, but the
 * table is never pruned, so the scan grows with history.
 */
const STATS_DAILY_DAY_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS ix_stats_daily_day ON stats_daily(tz, day);
`;

/**
 * Pre-computed per-day spend, plus the one write stamp that makes a stale day
 * detectable.
 *
 * ⚠ DERIVED DATA. Every row here can be recomputed from the tables it
 * summarises, and the read path falls back to computing a day live whenever a
 * row is missing or out of date. `DELETE FROM stats_daily` is therefore always
 * safe: the dashboard shows the same numbers, more slowly. Nothing may treat
 * this table as a source of truth, and nothing may write a figure here that
 * cannot be re-derived — the moment one exists, deleting the table loses data
 * and the fallback silently starts lying.
 *
 * ⚠ `commits.written_at_ms` is NOT part of the cache; it is what the cache
 * needs from the commit side. Staleness is decided by asking "did any source
 * row change after this day was built", and three of the six axes read the
 * commit graph. `memories.written_at_ms` already answers for the memory rows,
 * and `memory_topics` is rewritten inside the same statement pair, so it is
 * covered too — but two things it cannot see: a commit row arriving late (the
 * `category` axis dates a memory by `commits.committed_at_ms` when it has one,
 * so a late arrival can move a memory to a different day) and a change of
 * branch membership. The second is why the stamp is here rather than on
 * `commit_branches`: that set is only ever rewritten per-commit, in the same
 * projection that upserts the commit row, so the commit's stamp already marks
 * every membership change — and `commit_branches` is fifty times the larger
 * table, deliberately shrunk once already (see its DDL in `BASELINE_DDL`).
 *
 * One thing NOTHING here can see, listed so the set above stays honest: a
 * `repos.repo_name` rename. The `project` axis stores that name as its
 * `series_key`, and `repos` carries no write stamp, so a settled day keeps
 * labelling its rows with the old name until some unrelated write to that day
 * rebuilds it. Deliberately left alone rather than given a fourth stamp — it is
 * a label on the right number, it is self-correcting, and a repo's display name
 * changes about as often as the repo is created.
 *
 * Backfilled to 0 rather than to `committed_at_ms`: 0 reads as "written before
 * we tracked this", which is exactly right for a row that has not changed
 * since, and never makes a settled day look stale. A business time here would
 * be the same category error the sync stamps exist to avoid.
 *
 * ⚠ `stats_daily.updated_at_ms` is NOT a sync stamp, whatever it looks like. The
 * shape and the bump rule really are the same as the sync-stamp columns below,
 * but this table is on `SessionPushManifest.NEVER_SYNCED_TABLES` — it is a cache
 * cut in ONE machine's timezone — so it has no `SYNC_STAMP_COLUMNS` entry and no
 * cursor ever reads this column. It is here for symmetry with every other
 * projected table, and because "when was this row written" is the first thing
 * wanted when the cache is being debugged. Do not read this as a licence to put
 * the table on the wire on the strength of the column.
 *
 * The `CREATE TABLE` is `IF NOT EXISTS` because an earlier, unreleased build of
 * this branch had already created the table on some machines (a developer's own
 * among them) under a migration name their log has no row for. Without the guard
 * such a database re-runs the entry, dies on "table stats_daily already exists",
 * and every open after that fails until `doctor --mark-migration` is run by hand.
 *
 * The columns:
 *
 *  - `repo_id` — 0 on the `built` sentinel, which speaks for the whole day rather
 *    than for one repo; a real `repos.id` on every data row. No foreign key, for
 *    that reason and because nothing here should cascade: this table is rebuilt,
 *    not maintained, and its delete path is explicit.
 *  - `tz` — the IANA zone the day was cut in. In the key because a day boundary is
 *    a property of the asker: a reader in another zone misses and builds its own
 *    rows rather than reading someone else's days as if they were its own.
 *  - `day` — the local calendar day, `YYYY-MM-DD`.
 *  - `kind` — one of the spend axes, or `tokens`, or the `built` sentinel. The
 *    sentinel is what separates "this day was computed and had no activity" from
 *    "this day was never computed". Without it every quiet day misses forever and
 *    is recomputed on every request — the days most likely to be quiet being
 *    exactly the ones a wide range is full of. It is stored ONCE per day rather
 *    than once per repo so a repo added later cannot leave old days permanently
 *    unavailable: a repo that did not exist contributed nothing, and when it does
 *    contribute, its own write stamp marks the day stale and the day is rebuilt.
 *  - `series_key` — the series within the kind: a model/branch/ticket name for an
 *    axis, `input|output|cached` for `tokens`, `''` for the sentinel.
 *  - `value` — REAL, not INTEGER: the category and branch axes apportion a commit's
 *    tokens across its topics or branches, so a day's contribution is fractional.
 *    The read path rounds at emission exactly as the live path does.
 *  - `built_at_ms` — when this day was computed. Staleness is "a source row was
 *    written after this", so it is compared against the sources' own write stamps
 *    and must never hold a business time.
 *  - `updated_at_ms` — see the ⚠ above.
 */
const STATS_DAILY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS stats_daily (
  repo_id       INTEGER NOT NULL,
  tz            TEXT NOT NULL,
  day           TEXT NOT NULL,
  kind          TEXT NOT NULL,
  series_key    TEXT NOT NULL,
  value         REAL NOT NULL,
  cost_usd      REAL NOT NULL DEFAULT 0,
  built_at_ms   INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (repo_id, tz, day, kind, series_key)
) STRICT, WITHOUT ROWID;
${STATS_DAILY_DAY_INDEX_SQL}
`;

/**
 * An index on every sync stamp, for the two hot paths that were left scanning.
 *
 * The sync-stamp columns added by `applySessionStatsSchema`'s `ALTER`s, plus
 * `commits.written_at_ms`, needed an index for two paths that run constantly:
 *
 *  - **The outbound sync** selects `WHERE <stamp> >= ? ORDER BY <stamp> ASC
 *    LIMIT ?` per table. Without an index that is a scan plus a sort of every
 *    row, to return at most 500 — every batch, every run.
 *  - **The rollup's staleness test** (`readSourcesWrittenSince`) asks `WHERE
 *    <stamp> > ?` of `sessions`, `commits` and `memories`. It runs inside the
 *    writer's lock on EVERY `applyToDb` and twice per dashboard render, and the
 *    predicate is unselective without an index however recent the cursor is.
 *
 * `session_usage_events` is absent because `SESSION_USAGE_EVENTS_DDL` already
 * ships `ix_sue_sync`; adding it again would be a second index on one column.
 *
 * `IF NOT EXISTS` throughout so a re-run is free.
 */
const SYNC_STAMP_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS ix_sessions_written ON sessions(written_at_ms);
CREATE INDEX IF NOT EXISTS ix_smu_sync ON session_model_usage(updated_at_ms);
CREATE INDEX IF NOT EXISTS ix_stu_sync ON session_tool_use(updated_at_ms);
CREATE INDEX IF NOT EXISTS ix_recall_receipts_sync ON recall_receipts(updated_at_ms);
CREATE INDEX IF NOT EXISTS ix_commits_written ON commits(written_at_ms);
CREATE INDEX IF NOT EXISTS ix_mem_written ON memories(written_at_ms);
`;

/**
 * The keyset index behind the outbound sync's paging.
 *
 * Selection is now `(stamp, ...pk) >= (?, …) ORDER BY stamp, …pk LIMIT n` — see
 * `SyncColumns.KEYSET_COLUMNS` for why a stamp alone deadlocks. A tuple compare
 * only stays cheap when an index carries the tuple's leading columns in the
 * tuple's order, so each index below is the stamp followed by that table's
 * PRIMARY KEY. The stamp-only indexes above remain a PREFIX of these, so the
 * rollup's staleness scans keep their plan either way.
 *
 * `session_usage_events` is deliberately ABSENT. It is `WITHOUT ROWID`, so
 * SQLite appends the PRIMARY KEY to every secondary index automatically — its
 * `ix_sue_sync(updated_at_ms)` already IS `(updated_at_ms, session_event_id,
 * dedup_key)`. The other four are rowid tables, where the appended column is the
 * rowid and the PK has to be spelled out.
 */
const SYNC_KEYSET_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS ix_sessions_keyset ON sessions(written_at_ms, event_id);
CREATE INDEX IF NOT EXISTS ix_smu_keyset ON session_model_usage(updated_at_ms, session_event_id, model);
CREATE INDEX IF NOT EXISTS ix_stu_keyset ON session_tool_use(updated_at_ms, session_event_id, tool_name, kind);
CREATE INDEX IF NOT EXISTS ix_recall_receipts_keyset ON recall_receipts(updated_at_ms, receipt_id);
`;

/**
 * Gives every sync stamp a NUMBER, because on real databases some are NULL.
 *
 * ⚠ The sync-stamp columns are declared `NOT NULL DEFAULT 0` and backfilled by
 * this migration, and on a database that actually RAN it both are true. On one
 * that was handed those columns by a pre-log build, neither is: the log records
 * that entry as `baseline` — "this file already looks migrated" — so the
 * declaration never executed, the columns are nullable, and the backfill never
 * ran. Measured on the author's own database: `sessions.written_at_ms` is
 * `notnull=0`, with 30 sessions, 201 tool-use rows and 56 model-usage rows
 * holding NULL.
 *
 * A NULL there is not a small defect. Selection is `WHERE (<stamp>, …) >= (?, …)`
 * and SQL answers NULL — not true — for every comparison against NULL, so such a
 * row is invisible to EVERY cursor, for ever, with nothing anywhere reporting it.
 * That is exactly the failure `SyncColumns.ts` warns about; it simply arrived
 * through the migration log rather than through a hand-written column.
 *
 * The values mirror the `= 0` backfill below, one clause wider: that one looks
 * only for `= 0`, which is precisely the case that cannot occur when the column
 * was never given that default. 0 means "written before we tracked this", which
 * no cursor past 0 revisits and which the first sync sends once.
 *
 * This cannot restore the NOT NULL constraint — SQLite has no ALTER COLUMN — and
 * does not need to: every writer passes an explicit stamp, so nothing produces a
 * new NULL. `SyncColumns.test.ts` asserts the invariant on a freshly migrated
 * database.
 *
 * ⚠ `session_tool_use` prefers its OWN `last_call_at_ms` here, where the `= 0`
 * backfill below goes straight to the parent session — a deliberate divergence,
 * not a copy that drifted. That column arrived in `TOOL_CALL_TIME_DDL`, so it is
 * the better approximation of "when this row was written", and this entry is the
 * one being added now. The `= 0` backfill is not corrected to match: it has
 * already been applied on real databases, so editing its SQL changes nothing
 * there (a name-keyed migration never re-runs) while costing every one of them a
 * fingerprint-mismatch warning — a rewrite that only fixes the text and only for
 * machines that have not seen it yet.
 */
const SYNC_STAMP_NULL_BACKFILL_SQL = `
UPDATE sessions        SET written_at_ms = COALESCE(updated_at_ms, 0) WHERE written_at_ms IS NULL;
UPDATE recall_receipts SET updated_at_ms = COALESCE(at_ms, 0)         WHERE updated_at_ms IS NULL;
UPDATE session_model_usage
   SET updated_at_ms = COALESCE((SELECT s.updated_at_ms FROM sessions s
                                  WHERE s.event_id = session_model_usage.session_event_id), 0)
 WHERE updated_at_ms IS NULL;
UPDATE session_tool_use
   SET updated_at_ms = COALESCE(last_call_at_ms,
                                (SELECT s.updated_at_ms FROM sessions s
                                  WHERE s.event_id = session_tool_use.session_event_id), 0)
 WHERE updated_at_ms IS NULL;
`;

/**
 * The `= 0` backfills for the four sync-stamp `ALTER TABLE`s in
 * `applySessionStatsSchema`.
 *
 * Needed alongside `SYNC_STAMP_NULL_BACKFILL_SQL`, not instead of it. This one
 * fills columns that were just added with a `DEFAULT 0`; that one fills columns a
 * pre-log build left nullable and never filled. The two predicates (`= 0` and
 * `IS NULL`) cannot both match a row, so order is irrelevant and neither
 * subsumes the other.
 *
 * Re-running this on a healthy database has no effect: a remaining `0` means
 * "written before we tracked this", and 0 is what it gets set to again.
 *
 * The two `COALESCE`s are load-bearing twice over: the columns are `NOT NULL`,
 * so a child row whose parent session is missing would abort the statement
 * outright — and 0 is the right value for it anyway, matching a row that
 * predates the column.
 */
const SYNC_STAMP_ZERO_BACKFILL_SQL = `
UPDATE sessions        SET written_at_ms = updated_at_ms WHERE written_at_ms = 0;
UPDATE recall_receipts SET updated_at_ms = at_ms         WHERE updated_at_ms = 0;
UPDATE session_model_usage
   SET updated_at_ms = COALESCE((SELECT s.updated_at_ms FROM sessions s
                                  WHERE s.event_id = session_model_usage.session_event_id), 0)
 WHERE updated_at_ms = 0;
UPDATE session_tool_use
   SET updated_at_ms = COALESCE((SELECT s.updated_at_ms FROM sessions s
                                  WHERE s.event_id = session_tool_use.session_event_id), 0)
 WHERE updated_at_ms = 0;
`;

/**
 * Applies the session-statistics schema. Safe to run any number of times.
 *
 * It is TypeScript rather than SQL for one reason: five of these steps add columns,
 * and SQLite has neither `ADD COLUMN IF NOT EXISTS` nor a conditional in DDL. That is
 * why its entry is `sql`-less and so exempt from the fingerprint check — the companion
 * test in `2026-08-18-0000-session-stats-sync.test.ts` is the only guard on this body.
 *
 * ONE caller, and it must stay that way. A second entry ran this same function under a
 * second name for a while (a "heal"); see the note under `MIGRATIONS` in
 * `migrations/index.ts` for why that was removed and why re-adding one is a review
 * blocker.
 */
function applySessionStatsSchema(db: DashboardDbHandle): void {
	// The five ALTERs: four for the sync-stamp columns, one for stats_daily.
	//
	// A database that got these columns from a pre-log build has them NULLABLE,
	// which is not repairable (SQLite has no ALTER COLUMN) and does not need to be:
	// the null backfill below gives every row a number and every writer passes an
	// explicit stamp. See SYNC_STAMP_NULL_BACKFILL_SQL's comment above.
	addColumnIfMissing(db, "sessions", "written_at_ms", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "session_model_usage", "updated_at_ms", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "session_tool_use", "updated_at_ms", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "recall_receipts", "updated_at_ms", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "commits", "written_at_ms", "INTEGER NOT NULL DEFAULT 0");
	// Everything else is already `IF NOT EXISTS` / self-excluding `WHERE`.
	db.exec(SESSION_USAGE_EVENTS_SQL);
	db.exec(STATS_DAILY_TABLE_SQL);
	db.exec(SYNC_STAMP_INDEX_SQL);
	db.exec(SYNC_KEYSET_INDEX_SQL);
	// Both backfills, and both are load-bearing: `= 0` for columns just added with a
	// DEFAULT, `IS NULL` for columns a pre-log build left unfilled. Mutually
	// exclusive predicates, so the order between them does not matter.
	db.exec(SYNC_STAMP_ZERO_BACKFILL_SQL);
	db.exec(SYNC_STAMP_NULL_BACKFILL_SQL);
}

/**
 * Entry 7 — the session-statistics sync, and the cautionary tale of this whole
 * migration engine: it was edited in place across branches while unreleased, so
 * machines that had logged this name under the older SQL skipped the newer SQL for
 * ever. What reaches those machines is `SESSION_ACTIVITY_DDL` onward — never an edit
 * here. See AGENTS.md's dashboard-migration rules.
 *
 * A code entry because five of its steps add columns, which SQL cannot do
 * re-runnably. `applySessionStatsSchema` is the same work the SQL constants above
 * describe.
 *
 * Note also that nothing in here may be a DATA cleanup: a schema step is guarded
 * or idempotent, so a database that already logged this name is already in the
 * target state, but a DELETE has to EXECUTE to mean anything. Appending one was
 * tried and left 10,631 junk rows untouched on a real database.
 */
export const SESSION_STATS_SYNC_DDL: DbMigration = { name: "SESSION_STATS_SYNC_DDL", run: applySessionStatsSchema };
