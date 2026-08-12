/**
 * The whole schema — the single place every table is defined.
 *
 * Why this module exists: the DDL used to live inline in {@link
 * ../dashboard/DashboardDb.ts}'s `MIGRATIONS`, which meant the pages, the
 * producers and the recovery path could each grow their own idea of a table.
 * It is split in two exports because the halves have different natures, and
 * confusing them is how data gets lost: {@link ACTIVITY_DDL} is a projection of
 * git and each agent's storage and can be rescanned, while {@link
 * MEMORY_SOT_DDL} is the only copy there is.
 *
 * Three properties of the memory half are load-bearing and easy to undo by
 * accident:
 *
 * 1. **No triggers.** Constraints a foreign key can express are foreign keys;
 *    everything else is the write module's job plus the inspection queries in
 *    {@link SOT_INSPECTION_QUERIES}. The previous version carried nine triggers
 *    (revision monotonicity, pointer validation, two FTS mirrors, cascade
 *    emulation); each one hid a business rule in the schema, needed a migration
 *    to change, and had an execution order that had to be reasoned about. The
 *    one exception is documented on `repos_no_delete` in DashboardDb.
 * 2. **One row per commit.** There is no revision table and no current-revision
 *    pointer: `Regenerator` overwrites via `storeSummary(force=true)`, so disk
 *    has only ever held one summary per commit and nothing reads history.
 *    Regeneration is an UPDATE of `summary_json`; remounting is an UPDATE of the
 *    four topology columns.
 * 3. **STORED generated columns are TEXT only.** STRICT rejects a whole row when
 *    a STORED generated column's computed value has the wrong type, and a
 *    rejected row means a permanently lost summary (queue entries are deleted
 *    fire-and-forget). VIRTUAL columns are not type-checked at all, which is why
 *    the numeric ones wrap `json_extract` in a `json_type` gate: without it an
 *    INTEGER-declared column silently hands back REAL or TEXT.
 */

/**
 * Offset applied to `child_pos` in the first phase of a sibling reorder.
 *
 * `UNIQUE (repo_id, parent_hash, child_pos)` is checked row by row, so swapping
 * two positions in one UPDATE always collides; and `defer_foreign_keys` defers
 * foreign keys but NOT unique constraints. So a reorder shifts every sibling up
 * by this offset and then settles them, both inside one transaction.
 *
 * Three places must use this one constant — the reorder code, inspection query 2
 * (`child_pos >= ?`), and the settle-phase assertion that final positions stay
 * below it. A literal in any of them is a fourth copy, and moving the constant
 * without it makes the inspection stop finding offset-region residue.
 */
export const REORDER_OFFSET = 1_000_000;

/**
 * The dashboard activity layer: sessions, commits, worktree state and the
 * ingest log.
 *
 * This is not memory. Everything here is a projection of git plus each agent's
 * own storage, so the whole layer can be rescanned and rebuilt from scratch —
 * losing it costs time, never data.
 *
 * Every repo association is `repo_id`, and every composite key and index leads
 * with it. The one exception is `commit_branches`, which carries no repo column
 * at all — see the note on `branches`.
 */
export const ACTIVITY_DDL = `
-- ── Metadata ────────────────────────────────────────────────────────────────
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT) STRICT;

-- ── Repo registry ───────────────────────────────────────────────────────────
-- \`id\` is the surrogate key every other table references. repo_identity is a
-- normalized remote URL that legitimately CHANGES (a local-only repo gaining a
-- remote, a checkout moving), and it is 60-odd bytes that would otherwise ride
-- in every row and every composite index — measured, that one substitution took
-- commit_branches from 37.3 MiB to 30.2 MiB before any other change. It stays as
-- a UNIQUE natural key because that is what a worktree resolves to at startup.
--
-- Rows are NEVER deleted; disable is an UPDATE of \`disabled_at\`, so history
-- stays queryable and no single statement can wipe a repo's memories. The
-- trigger that enforces it is in DashboardDb, with the reasoning for why it is
-- the one trigger that survived.
-- Every column here is either read today or is a fact about the repo that only
-- this row records. \`bootstrap_cursor\` was neither — it was declared and never
-- written by anything — so it is the one that went.
CREATE TABLE repos (
  id                INTEGER PRIMARY KEY,
  repo_identity     TEXT NOT NULL UNIQUE,
  repo_name         TEXT NOT NULL,
  worktree_root     TEXT NOT NULL,
  remote_url        TEXT,
  enabled_at        TEXT NOT NULL,
  disabled_at       TEXT,
  last_ingested_at  TEXT,
  bootstrap_state   TEXT NOT NULL DEFAULT 'pending'
) STRICT;

-- ── Sessions ────────────────────────────────────────────────────────────────
-- event_id embeds repo_identity + source + sessionId, so the PK IS the natural
-- key and every write can be a plain idempotent UPSERT.
-- Instants are stored ONCE, as epoch ms. The ISO twins (\`started_at\`,
-- \`updated_at\`) held the same instant a second time and were read by nothing —
-- every query orders and filters on the \`_ms\` column. The instants themselves
-- stay: \`started_at_ms\` cannot be recovered from \`updated_at_ms\` and duration.
CREATE TABLE sessions (
  event_id        TEXT PRIMARY KEY,
  repo_id         INTEGER NOT NULL REFERENCES repos(id),
  source          TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  title           TEXT,
  started_at_ms   INTEGER,
  updated_at_ms   INTEGER NOT NULL,
  message_count   INTEGER,
  duration_ms     INTEGER,
  model           TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens   INTEGER NOT NULL DEFAULT 0,
  est_cost_usd    REAL,
  token_coverage  TEXT NOT NULL DEFAULT 'sessions-only',
  prices_as_of    TEXT,
  UNIQUE (repo_id, source, session_id)
) STRICT;
CREATE INDEX ix_sessions_repo_time ON sessions(repo_id, updated_at_ms);
CREATE INDEX ix_sessions_time ON sessions(updated_at_ms);
CREATE INDEX ix_sessions_source ON sessions(source);

-- Per-session, per-model split. A session can switch models mid-stream, so
-- sessions.model is a display convenience and THIS is authoritative.
--
-- Keyed on session_event_id rather than an integer: measured at 24 and 114 rows,
-- so the key-shape work that paid for itself on the commits chain would buy
-- nothing here while touching StopHook, the VS Code tick and two projections.
CREATE TABLE session_model_usage (
  session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE,
  model            TEXT NOT NULL,
  -- No \`provider\` column: it was recorded per row and selected by nothing.
  -- Pricing resolves the provider from the model id (see core/Pricing.ts), so a
  -- stored copy is a second answer to a question that already has one.
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cached_tokens    INTEGER NOT NULL DEFAULT 0,
  est_cost_usd     REAL,
  PRIMARY KEY (session_event_id, model)
) STRICT;
CREATE INDEX ix_smu_model ON session_model_usage(model);

CREATE TABLE session_tool_use (
  session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE,
  tool_name        TEXT NOT NULL,
  kind             TEXT NOT NULL,
  server           TEXT,
  calls            INTEGER NOT NULL DEFAULT 0,
  -- This table counts CALLS, nothing more. It used to carry a metadata_json
  -- column holding each recall call's own hit/miss and served commits, parsed
  -- back out of Claude's transcript; \`recall_receipts\` replaced that (see its
  -- DDL for why), so the column has no writer and no reader and is gone from
  -- the definition. Databases created before the change still have it — an
  -- unused nullable column, harmless, and cheaper to leave than to rewrite a
  -- STRICT table for.
  -- "kind" is part of the key, not just a column: a skill and a builtin can
  -- share a name, and the parser already groups on (kind, name). Keying on the
  -- name alone would silently merge two different things into one row.
  PRIMARY KEY (session_event_id, tool_name, kind)
) STRICT;
CREATE INDEX ix_stu_kind ON session_tool_use(kind);
CREATE INDEX ix_stu_server ON session_tool_use(server);

-- ── Commits ─────────────────────────────────────────────────────────────────
-- Child tables reference \`id\`, never \`event_id\`. event_id is the producer's
-- idempotency key — 'commit:<remote URL>:<40-hex sha>', measured at 80 bytes
-- average — and it is used only to dedupe at write time. Carrying it in the
-- children instead is what made commit_branches the largest object in the
-- database while holding no business data at all.
--
-- The memory projections that used to trail here (turns, tokens, est_cost_usd,
-- ticket_id, plus the commit_insights / commit_references / session_commit_link
-- child tables) are GONE (A3b): a copy falls behind whenever a memory is
-- regenerated, so the dashboard reads them from the memory tables instead —
-- generated columns on \`memories\`, json_each over summary_json for insights,
-- transcript_sessions x memory_transcripts for the session link — which
-- recordCommitsFromWorker refreshes live at the same moment it emits
-- commit.summary. Do not reintroduce a stored copy; dev databases created
-- before the drop may still carry the dead columns/tables harmlessly
-- (pre-release, nothing reads or writes them).
--
-- work_category is deliberately NOT among them: it never was a summary field but
-- a mode computed over the topics' categories, and category belongs to a TOPIC.
-- Pages that aggregate by category read \`memory_topics\`; pages that want a
-- commit-level LABEL derive the mode at query time, so there is no stored copy
-- to fall behind.
-- Same instant-stored-once rule as \`sessions\`: \`committed_at\` (ISO) rode beside
-- \`committed_at_ms\` and no query read it. The author columns stay — nothing
-- displays them today, but they are the commit's own facts and re-deriving them
-- means re-walking git.
CREATE TABLE commits (
  id              INTEGER PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,
  repo_id         INTEGER NOT NULL REFERENCES repos(id),
  hash            TEXT NOT NULL,
  branch          TEXT,
  message         TEXT,
  author_name     TEXT,
  author_email    TEXT,
  committed_at_ms INTEGER NOT NULL,
  files_changed   INTEGER,
  insertions      INTEGER,
  deletions       INTEGER,
  UNIQUE (repo_id, hash)
) STRICT;
CREATE INDEX ix_commits_repo_time ON commits(repo_id, committed_at_ms);
CREATE INDEX ix_commits_branch ON commits(branch);





-- Branch-name dictionary. Measured: 87 distinct names referenced by 102,767
-- rows, average name length 27.4 bytes, so the names were repeating tens of
-- thousands of times — one of them 2,098 times by itself.
CREATE TABLE branches (
  id      INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name    TEXT NOT NULL,
  UNIQUE (repo_id, name)
) STRICT;

-- Commit<->branch reachability. A commit is reachable from many branches, so
-- commits.branch cannot answer "group by branch" correctly — it is only a
-- heuristic "first seen on" label. Refreshed by unioning per-ref 'git rev-list',
-- never by 'git branch --contains' per commit.
--
-- The row count is correct and not worth optimizing: measured, 1,078 commits are
-- each reachable from 68 branches, because old branches all contain main's
-- history. O(commit x reachable branches) is the true answer to reachability.
-- What was wrong was 380 bytes per row for 3 bytes of information.
--
-- This is the ONE table with no repo_id: the boundary comes from
-- branches.repo_id, and "commits on branch X of repo Y" is two hops
-- (branches(repo_id,name) -> branch_id -> ix_cb_branch). One extra join, and the
-- table plus its indexes went from 30.19 MiB to 2.04 MiB on real data.
-- WITHOUT ROWID because a pure key table does not need a second rowid index.
CREATE TABLE commit_branches (
  commit_id INTEGER NOT NULL REFERENCES commits(id)  ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (commit_id, branch_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_cb_branch ON commit_branches(branch_id, commit_id);

CREATE TABLE commit_files (
  commit_id  INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  insertions INTEGER,
  deletions  INTEGER,
  PRIMARY KEY (commit_id, path)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_commit_files_path ON commit_files(path);

-- ── Workspace ───────────────────────────────────────────────────────────────
-- Transient, latest-wins. A detached HEAD has no branch name; branch_key holds
-- the '' sentinel so the PK stays usable (SQLite treats every NULL as distinct,
-- which would let detached-HEAD rows accumulate without bound).
CREATE TABLE worktree_status (
  repo_id        INTEGER NOT NULL REFERENCES repos(id),
  branch_key     TEXT NOT NULL DEFAULT '',
  branch         TEXT,
  files_changed  INTEGER,
  insertions     INTEGER,
  deletions      INTEGER,
  -- Instant stored once, as epoch ms — see \`sessions\`.
  observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (repo_id, branch_key)
) STRICT;

-- ── Write-ahead log / durable ingest queue ──────────────────────────────────
-- StatsWriter lands every event here as 'pending' and COMMITS before it
-- projects, so a crash mid-projection leaves something to drain. event_id is
-- deliberately NOT unique: the same event may be written repeatedly, and
-- idempotency lives in the projection tables.
--
-- This is the one table that keeps \`repo_identity\` instead of \`repo_id\`, and the
-- reason is the same one that makes it a separate transaction: the log's job is
-- to get the raw event onto disk before anything is interpreted. Resolving an id
-- would make that first commit depend on a repos row existing, which is exactly
-- the ordering assumption the log exists to avoid — producers write in any order,
-- and a session event can arrive before \`jolli enable\` has projected the
-- registry. Storing what the producer said keeps the log a log; the projection
-- resolves the id on the way out.
CREATE TABLE events_raw (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id          TEXT,
  repo_identity     TEXT,
  type              TEXT NOT NULL,
  schema_version    INTEGER NOT NULL,
  producer_kind     TEXT,
  producer_version  TEXT,
  occurred_at       TEXT,
  received_at       TEXT NOT NULL,
  data_json         TEXT NOT NULL,
  projection_status TEXT NOT NULL DEFAULT 'pending',
  claimed_at_ms     INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0
) STRICT;
-- Only ONE index, and it is the drain's: every events_raw query filters on
-- projection_status (+ seq, attempts, schema_version) or prunes on received_at.
-- The three that used to sit here (on type, on (repo_identity, occurred_at) and
-- on event_id) indexed columns no query has ever filtered on — they cost a write
-- per enqueue on the blocking commit path and bought nothing. Re-add one only
-- alongside the query that needs it.
CREATE INDEX ix_events_pending ON events_raw(projection_status, seq);

-- ── Gap-recovery cursors ────────────────────────────────────────────────────
-- A fast path for append-only history plus a rewrite detector — NOT the
-- correctness mechanism. Adds/changes are handled by idempotent UPSERT and
-- deletes by set reconciliation, because a high-water mark alone misses
-- out-of-order updates, history rewrites and deletions.
CREATE TABLE ingest_cursors (
  repo_id       INTEGER NOT NULL REFERENCES repos(id),
  source        TEXT NOT NULL,
  cursor        TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (repo_id, source)
) STRICT;

-- ── Aggregates ──────────────────────────────────────────────────────────────
-- There are none. agg_repo_totals lived here and was removed unused: every
-- reader that wants tokens, cost or activity spans computes them live from the
-- detail tables (see the ~20 such queries in DashboardQuery), so the aggregate
-- was maintained on the projection path and read by nothing but a single
-- session count — which the Repositories page now counts live, the same way it
-- already counted memories. Read-time aggregation over the indexed detail rows
-- is what this schema is shaped for; re-adding a stored aggregate needs a
-- measured query that is actually too slow without it, not the assumption that
-- one will be.
-- ── Provider usage / quota ──────────────────────────────────────────────────
-- There is none. \`usage_observations\` (and the Claude-shaped \`usage_samples\`
-- before it) recorded account-level limit pressure read out of Claude Code's own
-- local cache; the whole feature — reader, sampler, model, cards — was removed.
-- A database created before that still carries the table; it is simply unused,
-- and nothing here recreates it. Bringing quota tracking back means designing it
-- against whatever provider actually exposes it, not reviving this shape.

-- ── Code graph ──────────────────────────────────────────────────────────────
-- PARKED, not deleted. The graph page was removed (no view token, no route, no
-- reader), which left this table written by DbBackfill and read by nothing — a few
-- hundred KB of JSON per repo per import, for no query. The writer is commented
-- out in lockstep (StatsWriter.recordRepoGraph, DbBackfill's call site); uncomment
-- all three together if the page returns. Kept as commented DDL rather than
-- dropped from history because this is the exact shape it would come back to.
--
-- CREATE TABLE repo_graphs (
--   repo_id        INTEGER PRIMARY KEY REFERENCES repos(id),
--   generated_at   TEXT NOT NULL,
--   schema_version INTEGER NOT NULL,
--   categories     INTEGER NOT NULL DEFAULT 0,
--   topics         INTEGER NOT NULL DEFAULT 0,
--   units          INTEGER NOT NULL DEFAULT 0,
--   edges          INTEGER NOT NULL DEFAULT 0,
--   graph_json     TEXT NOT NULL
-- ) STRICT;
`;

/**
 * Recall receipts — one row per recall call, written by whoever served it.
 *
 * Part of the activity layer but NOT in {@link ACTIVITY_DDL}: it arrived after
 * schema v1 was already on disk in dev databases, so it ships as the second
 * append-only migration instead (see `MIGRATIONS` in DashboardDb). A fresh
 * database gets it by running that migration, exactly like an existing one.
 *
 * A receipt is written where the answer is produced — the MCP `recall` tool
 * and the `jolli recall` CLI, both via `ProducerHooks.recordRecallReceipt` —
 * rather than recovered afterwards from a transcript. The transcript route
 * (parse Claude's `tool_result` for each `mcp__jollimemory__recall` block)
 * could only ever see a third of the calls: never a CLI run, never a
 * non-Claude agent, and never a session older than the 48 h `sessions.json`
 * retention that its re-projection depends on. Measured on a real install
 * before the change: 40 of 661 sessions carried any tool row at all, and the
 * one repo-local session that provably called recall over MCP had none.
 *
 * Unlike the rest of this layer a receipt is NOT re-derivable — the call and
 * its result are gone the moment they are served. It is still cheap to lose
 * (it costs a figure on one card, never a memory), which is what lets the
 * producer keep the never-throw discipline every other dashboard write has.
 *
 * `session_id` is the AGENT's session id (the same value `sessions.session_id`
 * carries), taken from the host's environment when it exposes one, and NULL
 * otherwise — a `jolli recall` typed into a plain terminal belongs to no
 * session and must not be attributed to one.
 */
export const RECALL_RECEIPTS_DDL = `
CREATE TABLE recall_receipts (
  -- The producer's own idempotency key (statsEventId), so a re-drained event
  -- converges on one row instead of appending a duplicate call.
  receipt_id   TEXT PRIMARY KEY,
  repo_id      INTEGER NOT NULL REFERENCES repos(id),
  at_ms        INTEGER NOT NULL,
  -- 'mcp' | 'cli'. Kept because the two answer different questions about
  -- adoption, and because a surface that stops reporting is only visible here.
  surface      TEXT NOT NULL,
  session_id   TEXT,
  hit          INTEGER NOT NULL,
  commit_count INTEGER NOT NULL DEFAULT 0,
  -- JSON array of {hash, date} for a hit; NULL for a miss. Powers "distinct
  -- memories used" and the stale-memory count, neither of which a bare
  -- commit_count can answer.
  commits_json TEXT
) STRICT;
CREATE INDEX ix_recall_receipts_repo_at ON recall_receipts(repo_id, at_ms);
`;

/**
 * Registers `skill` as the fourth `context` kind.
 *
 * Archived skill markdown (`skills/<source>/<stem>-<hash8>.md`, written by
 * `SummaryStore.storeSkills`) is the same shape as a plan, note or reference:
 * one key, one complete file body. It was simply missed when the memory tables
 * were designed, and the omission was not benign — `SotWrite.classify` throws
 * on a path no table backs, so on a cut-over repo EVERY commit from a session
 * that used a skill aborted the whole write batch, and the containment compare
 * that gates the cutover never visited a skill path so it could not notice.
 *
 * Its own migration rather than an edit to entry 0's `INSERT`: dev databases
 * are already past that entry, and editing it would reach only databases
 * created afterwards. Nothing else changes — every `context` CHECK is already
 * one-way ("NULL unless reference/plan"), so a skill row satisfies them with
 * the reference-only columns left NULL. The `<source>` segment stays inside
 * `context_key`, exactly as it does for a reference, so the orphan path is
 * reconstructible from the row.
 */
export const SKILL_CONTEXT_KIND_DDL = `
INSERT INTO context_kinds (kind) VALUES ('skill');
`;

/**
 * Records WHY a `failed` event was parked, so the one recoverable reason can be
 * un-parked later.
 *
 * `projectEvent`'s `default:` throw exists as the runtime backstop for an older
 * build draining a NEWER producer's event — `schema_version` gates payload
 * changes and cannot gate a new event TYPE. The comment there promises the row
 * "survives for a build that understands it", but the claim query selects
 * `pending` only and nothing ever reset `failed`, so upgrading did not recover
 * it: the event was lost permanently, which is the exact outcome the two-phase
 * WAL was built to prevent. A genuine defect must NOT be revived the same way
 * (it would burn the attempt budget on every drain forever), hence a reason
 * rather than a bare flag.
 *
 * Additive column with no default backfill: rows parked by an older build read
 * back NULL, which is treated as "unknown reason — leave parked", the same
 * conservative answer they get today.
 */
export const EVENT_FAILED_KIND_DDL = `
ALTER TABLE events_raw ADD COLUMN failed_kind TEXT;
`;

/**
 * When the last call in a `session_tool_use` bucket was made.
 *
 * A tool call is an event with its own instant, but this table had none — so
 * every query over it had to borrow a time from elsewhere, and both candidates
 * are wrong in a way that shows up on the Recall card:
 *
 *  - the SESSION's `updated_at_ms` (what the queries used) moves whenever the
 *    conversation is touched again, so a recall made three weeks ago counts as
 *    today's, while today's recall inside a long-running session counts as
 *    whenever that session started;
 *  - a COMMIT's date has no relationship to a tool call at all — an agent turn
 *    may precede its commit by hours, follow it, or never produce one. It is
 *    the right clock for `commits`, and a category error here.
 *
 * So: the call's own time, taken from the transcript line that recorded it
 * (`ToolCallCount.lastCallAtMs`).
 *
 * NULLABLE, and permanently so. A bucket is written by whichever parser read the
 * session, and not every source's transcript offers a per-call timestamp (see
 * `TOOL_CALL_TIME_SOURCES`); rows written before this column existed are NULL
 * too, and nothing can backfill them — the transcripts they came from may be
 * gone. Every consumer therefore reads it as `COALESCE(last_call_at_ms,
 * sessions.updated_at_ms)`: the old, coarse behaviour survives exactly where the
 * better answer is unavailable, instead of the row dropping out of a window
 * because its time is unknown.
 *
 * LAST rather than first, one instant per bucket: a bucket counts N calls of one
 * tool in one session, so a bucket straddling a window edge lands wholly in the
 * window of its last call. Per-call rows would be a different table; the error
 * here is bounded by one session's own span rather than by how long ago that
 * session was last touched.
 */
export const TOOL_CALL_TIME_DDL = `
ALTER TABLE session_tool_use ADD COLUMN last_call_at_ms INTEGER;
`;

/**
 * A per-row "when did WE last write this" stamp on the four activity tables, so
 * an outbound sync can select exactly the rows that changed since its cursor.
 *
 * It exists because **no business time column can answer that question**, and
 * the counter-example is not hypothetical: `projectCommitSummary`'s `sessions`
 * upsert updates the token columns, `token_coverage` and `prices_as_of` but
 * deliberately NOT `updated_at_ms` — enriching a `sessions-only` row into a
 * `full` one changes what the row says while leaving that column untouched. A
 * cursor over `updated_at_ms` never sees the enrichment, so the better token
 * split it just wrote would never leave this machine, and nothing would report
 * it. That omission is CORRECT on its own terms (`updated_at_ms` means "when
 * the session was last active", and the only clock that path has is the
 * commit's, which would also move the session's whole spend into another day) —
 * which is exactly why the two questions need two columns.
 *
 * So: business columns keep their meaning and are never bumped for bookkeeping;
 * these columns are bumped unconditionally on every write and mean nothing else.
 *
 * ⚠ THE NAME IS NOT UNIFORM, and that is a trap worth stating rather than
 * tidying: `sessions.updated_at_ms` is already taken by the business meaning, so
 * that table's stamp is `written_at_ms` (matching `memories.written_at_ms`,
 * which is the same concept) while the other three use `updated_at_ms`. A sync
 * that assumes one name and writes `WHERE updated_at_ms >= ?` against all four
 * compiles, runs, and silently reads the WRONG column on `sessions` — back to
 * the bug above. Readers must go through the per-table map in `SyncColumns.ts`.
 *
 * Backfilled from each table's best available approximation (its own business
 * time, or the parent session's for the two child tables). That is an
 * approximation, not the real write instant, which is unknowable for rows
 * already on disk — but it is the right one: it makes the first sync select the
 * same rows it would have selected by business time.
 *
 * ⚠ `NOT NULL DEFAULT 0`, never a bare nullable column, and the reason is the
 * same failure this whole mechanism exists to prevent. A cursor is spelled
 * `WHERE <stamp> >= ?`, and SQL's answer for NULL there is NULL — not true — so
 * a single NULL stamp makes its row invisible to EVERY sync, permanently and
 * with nothing to notice it. Nullable is not the safe default here: it is the
 * bug, one level down. 0 says "written before we tracked this", which no cursor
 * past 0 needs to revisit and which the backfill above then improves wherever a
 * business time exists. `commits.written_at_ms` is declared the same way for the
 * same reason.
 */
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
 * `line:<n>` for a source that cannot name one — the transcript is append-only,
 * so a line number is stable across re-reads and a re-read of the same slice
 * converges on the same rows instead of doubling them.
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
export const SESSION_USAGE_EVENTS_DDL = `
CREATE TABLE session_usage_events (
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
CREATE INDEX ix_sue_at ON session_usage_events(responded_at_ms);
CREATE INDEX ix_sue_sync ON session_usage_events(updated_at_ms);
`;

export const SYNC_STAMP_DDL = `
ALTER TABLE sessions            ADD COLUMN written_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_model_usage ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_tool_use    ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recall_receipts     ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

UPDATE sessions        SET written_at_ms = updated_at_ms WHERE written_at_ms = 0;
UPDATE recall_receipts SET updated_at_ms = at_ms         WHERE updated_at_ms = 0;
-- COALESCE is load-bearing twice over: the column is NOT NULL, so a child row
-- whose parent session is missing would abort the migration outright — and 0 is
-- the right value for it anyway, matching a row that predates the column.
UPDATE session_model_usage
   SET updated_at_ms = COALESCE((SELECT s.updated_at_ms FROM sessions s
                                  WHERE s.event_id = session_model_usage.session_event_id), 0)
 WHERE updated_at_ms = 0;
UPDATE session_tool_use
   SET updated_at_ms = COALESCE((SELECT s.updated_at_ms FROM sessions s
                                  WHERE s.event_id = session_tool_use.session_event_id), 0)
 WHERE updated_at_ms = 0;
`;

/*
 * A stored `0` in this column is handled at the READ site, and deliberately not
 * by a migration — do not add one back.
 *
 * 0 is the one value that breaks the fallback above: 0 is not NULL, so such a
 * row resolves to epoch 0 and silently drops out of every window instead of
 * keeping its session's placement. Both writers already wrap their
 * `MAX(COALESCE(…,0), COALESCE(…,0))` in `NULLIF`, so nothing produces one; the
 * remaining question is only what to do about a row that already holds one.
 *
 * A sweep entry was written for that and then removed, for two reasons that are
 * worth keeping written down:
 *
 *  - **It cannot do the job it was added for.** Its stated purpose was that "a
 *    third writer added later will not come with this reasoning attached" — but
 *    a migration entry runs ONCE, on the step that crosses its version, so it is
 *    long finished by the time that writer stores its first 0. Only the read can
 *    be permanent, which is why `TOOL_CALL_TIME_SQL` wraps the column in
 *    `NULLIF` rather than trusting what is on disk.
 *  - **It cost a cross-surface version bump for a provably empty set.** Every
 *    surface refuses a database stamped ahead of its own build, so a bump locks
 *    older CLI / VS Code / IntelliJ builds out of the machine-global file. What
 *    the sweep would have cleaned is 0 rows, and not merely by measurement:
 *    both write paths DELETE the session's rows before inserting, so `ON
 *    CONFLICT` can only fire on a duplicate `(tool_name, kind)` within one
 *    event, which `ToolUseTally` cannot emit — that pair is its bucket key.
 */

/**
 * The memory tables, `context`, plan progress and the topic KB.
 *
 * Applied as one statement batch inside the caller's transaction. Ordering
 * matters only for the foreign keys: `memories` before anything referencing it,
 * `context` before `plan_progress`, `topic_pages` before its refs.
 */
export const MEMORY_SOT_DDL = `
-- Per-repo control state (JSON values): 'orphan-import', 'cutover',
-- 'v5-migration' (the raw bytes of the orphan's schema-v5-migration.json — a
-- completed-marker whose absence would make the v5 migration re-run), ...
-- Kept out of schema_meta, which is a whole-database singleton. A key-value
-- table rather than columns on \`repos\` because \`cutover\` has to be written in
-- the same transaction as the data it certifies, and because adding a column
-- after release is a cross-surface release event while adding a marker is an
-- INSERT.
CREATE TABLE repo_state (
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (repo_id, key)
) STRICT;

-- ── memories: identity, topology and content in one row ─────────────────────
-- \`children[]\` is stored as edges + array position rather than nested copies of
-- the child files (measured: the nesting is 31.3% of the bytes). The key stays
-- present in \`summary_json\` with its value emptied to \`[]\` — removing it and
-- appending it back during reassembly would reorder the JSON keys, and the
-- byte-for-byte equivalence check does not allow that difference.
--
-- root_hash and depth are denormalizations the write module maintains: the tree
-- measures 17 levels deep, so without them every root read is a recursive query.
-- depth doubles as cycle detection — a cycle makes inspection query 1 return
-- rows.
CREATE TABLE memories (
  repo_id       INTEGER NOT NULL REFERENCES repos(id),
  commit_hash   TEXT NOT NULL,

  parent_hash   TEXT,
  child_pos     INTEGER,
  root_hash     TEXT NOT NULL,
  depth         INTEGER NOT NULL DEFAULT 0,

  summary_json   TEXT NOT NULL,
  -- A REAL column, not a generated one: measured 313/313, summary files carry
  -- no \`treeHash\` — it exists only in index.json entries, computed from git at
  -- index-build time. It is load-bearing for alias scanning (tree-hash matching
  -- finds "same content, new sha"), so the importer copies it off the index
  -- entry and the write module stamps it via getTreeHash, exactly as
  -- flattenSummaryTree does today. NULL when git could not answer.
  tree_hash      TEXT,
  -- Same story as \`tree_hash\`, and a REAL column for the same reason: legacy
  -- (pre-v4) summaries carry their root diff stats ONLY on the index entry,
  -- never in the body. \`synthIndex\` rebuilds index.json from these rows and
  -- reads \`diffStats\` off the body, so without this the badge \`jolli view\`,
  -- the sidebar and the SessionStart briefing render is lost for every legacy
  -- root, and the rebuilt entry stops matching the file the branch carried.
  -- Not folded into \`summary_json\`: that blob has to reproduce the source file
  -- byte-for-byte for the cutover compare. NULL means the body is the only
  -- source, which is every v4-and-later memory.
  index_diff_stats_json TEXT,
  first_seen_ms  INTEGER NOT NULL,
  written_at_ms  INTEGER NOT NULL,
  -- Hand-written, not generated: date functions are barred from generated
  -- columns. It must be derived from the same field as \`commit_date\`, and no
  -- constraint can enforce that. NOT NULL plus an optional source field means a
  -- missing \`commitDate\` fails the whole row, so the write module falls back
  -- commitDate -> git commit time -> first_seen_ms before giving up.
  commit_date_ms INTEGER NOT NULL,

  -- STORED only for columns that feed an index or get read as a whole column.
  -- STORED is also restricted to TEXT (see this module's header): all three are.
  branch          TEXT    GENERATED ALWAYS AS (json_extract(summary_json,'$.branch'))            STORED,
  commit_message  TEXT    GENERATED ALWAYS AS (json_extract(summary_json,'$.commitMessage'))     STORED,
  commit_type     TEXT    GENERATED ALWAYS AS (json_extract(summary_json,'$.commitType'))        STORED,

  commit_date     TEXT    GENERATED ALWAYS AS (json_extract(summary_json,'$.commitDate'))        VIRTUAL,
  commit_author   TEXT    GENERATED ALWAYS AS (json_extract(summary_json,'$.commitAuthor'))      VIRTUAL,
  generated_at    TEXT    GENERATED ALWAYS AS (json_extract(summary_json,'$.generatedAt'))       VIRTUAL,
  recap           TEXT    GENERATED ALWAYS AS (json_extract(summary_json,'$.recap'))             VIRTUAL,
  ticket_id       TEXT    GENERATED ALWAYS AS (json_extract(summary_json,'$.ticketId'))          VIRTUAL,
  jolli_doc_id    TEXT    GENERATED ALWAYS AS (json_extract(summary_json,'$.jolliDocId'))        VIRTUAL,
  -- No topics_json column: the topics are projected into \`memory_topics\` instead,
  -- for the reason spelled out on that table.
  -- Numeric columns pass through a json_type gate so an off-type value degrades
  -- to NULL — the case the pages already handle for a missing field — instead of
  -- handing a REAL back from an INTEGER column. VIRTUAL escapes STRICT's type
  -- check entirely, so nothing else would notice.
  turns           INTEGER GENERATED ALWAYS AS (CASE WHEN json_type(summary_json,'$.conversationTurns')='integer'  THEN json_extract(summary_json,'$.conversationTurns')  END) VIRTUAL,
  tokens          INTEGER GENERATED ALWAYS AS (CASE WHEN json_type(summary_json,'$.conversationTokens')='integer' THEN json_extract(summary_json,'$.conversationTokens') END) VIRTUAL,
  est_cost_usd    REAL    GENERATED ALWAYS AS (CASE WHEN json_type(summary_json,'$.estimatedCostUsd') IN ('integer','real') THEN json_extract(summary_json,'$.estimatedCostUsd') END) VIRTUAL,
  files_changed   INTEGER GENERATED ALWAYS AS (CASE WHEN json_type(summary_json,'$.diffStats.filesChanged')='integer' THEN json_extract(summary_json,'$.diffStats.filesChanged') END) VIRTUAL,
  insertions      INTEGER GENERATED ALWAYS AS (CASE WHEN json_type(summary_json,'$.diffStats.insertions')='integer'   THEN json_extract(summary_json,'$.diffStats.insertions')   END) VIRTUAL,
  deletions       INTEGER GENERATED ALWAYS AS (CASE WHEN json_type(summary_json,'$.diffStats.deletions')='integer'    THEN json_extract(summary_json,'$.diffStats.deletions')    END) VIRTUAL,

  PRIMARY KEY (repo_id, commit_hash),
  UNIQUE (repo_id, parent_hash, child_pos),
  -- Shape handed to the engine: a root has no position, a child must have one.
  -- Blocks "root with a position" and "child without one" in a single check.
  CHECK ((parent_hash IS NULL) = (child_pos IS NULL)),
  -- Non-negative, so a reorder's temporaries have to offset upward. A negative
  -- scheme would need this check relaxed for the duration of every reorder.
  CHECK (child_pos IS NULL OR child_pos >= 0),
  -- Deliberately as loose as 2x REORDER_OFFSET: it must admit the reorder's own
  -- temporaries, so it cannot be the tight bound. What it catches is a retried
  -- reorder offsetting crash residue a second time. The tight bound
  -- (final positions < REORDER_OFFSET) is an assertion in the write module,
  -- because as a CHECK it would reject the temporaries.
  CHECK (child_pos IS NULL OR child_pos < 2000000),
  -- Self-reference: deleting a root deletes the whole tree. Pruning is therefore
  -- a whole-tree decision by root_hash, never a row-by-row one by date.
  FOREIGN KEY (repo_id, parent_hash)
    REFERENCES memories(repo_id, commit_hash) ON DELETE CASCADE
) STRICT;
CREATE INDEX ix_mem_root   ON memories(repo_id, root_hash);
CREATE INDEX ix_mem_branch ON memories(repo_id, branch, commit_date_ms);
CREATE INDEX ix_mem_date   ON memories(repo_id, commit_date_ms);
CREATE INDEX ix_mem_ticket ON memories(repo_id, ticket_id);

-- ── memory_topics: the summary's topics[], one row per topic ────────────────
-- A topic is "one independent problem/goal within a commit" (TopicSummary), and
-- \`category\` / \`importance\` belong to IT, not to the commit — the model is asked
-- for one category per topic, not one per commit. Measured on this repo: 727
-- memories carry 5,159 topics, 7.6 on average and up to 43.
--
-- The old read model collapsed them with a mode ("the commit's dominant
-- category") and stored one value per commit. That loses information the data
-- plainly has: by topic the split is bugfix 2,050 / feature 1,292, while by
-- commit-mode it is 39 / 36 — and \`security\` (211 topics) and \`docs\` (30) vanish
-- entirely, because neither ever wins a commit's vote. 15% of commits had a TIE
-- at the top, where "dominant" silently meant "whichever topic came first".
--
-- Why a table rather than reading them out of summary_json, all four measured on
-- the real 727 rows:
--   GROUP BY commits.work_category   0.87 ms  — fast, wrong shape
--   parse topics in JS               37 ms    — wrong shape, and ships 11.2 MiB
--   json_each over summary_json      303 ms   — right shape, unusable
--   this table                       4.88 ms  — right shape, fast
-- Same reason \`transcript_sessions\` exists: a queryable field sitting inside a
-- payload SQL has to parse per row is not queryable. summary_json stays the
-- source of truth and keeps the full topics for byte-faithful reassembly; this is
-- a projection of it, replaced as a whole group on every write.
--
-- Only the queryable fields are projected. decisions / trigger / response are
-- long prose that only ever gets displayed, and the pages already read those
-- from summary_json — a second copy would be bytes with no query behind them.
CREATE TABLE memory_topics (
  repo_id     INTEGER NOT NULL,
  commit_hash TEXT NOT NULL,
  pos         INTEGER NOT NULL,          -- topics[] index; ordering is restored from it
  category    TEXT,                      -- TopicCategory; NULL when the model omitted it
  importance  TEXT,                      -- 'major' | 'minor'
  title       TEXT NOT NULL,
  PRIMARY KEY (repo_id, commit_hash, pos),
  CHECK (pos >= 0),
  FOREIGN KEY (repo_id, commit_hash)
    REFERENCES memories(repo_id, commit_hash) ON DELETE CASCADE
) STRICT;
-- Leads with repo_id because every page query is repo-scoped; category second
-- because "group by category" is the whole point of the table.
CREATE INDEX ix_mtopic_category ON memory_topics(repo_id, category);

-- ── commit aliases (index.json's third top-level key) ──────────────────────
-- A rewritten SHA -> the live memory with the same tree hash. Step 2 of
-- getSummary()'s four-step lookup. Tree-hash matching costs a git subprocess
-- per candidate, so a computed alias is kept forever; in index.json every
-- rebuild path had to remember to copy them across (one of five did not), and a
-- table has no rebuild to forget.
CREATE TABLE commit_aliases (
  repo_id     INTEGER NOT NULL,
  old_hash    TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  created_ms  INTEGER NOT NULL,
  PRIMARY KEY (repo_id, old_hash),
  FOREIGN KEY (repo_id, target_hash)
    REFERENCES memories(repo_id, commit_hash) ON DELETE CASCADE
) STRICT;

-- ── transcripts (keyed by TranscriptId — UUID or legacy commit hash) ────────
-- sessions_blob is zlib-compressed JSON: no generated columns, not indexed,
-- stored and fetched whole. It is the only compressible block in the database
-- (everywhere else has a query dependency on the text) and the second largest.
CREATE TABLE transcripts (
  repo_id       INTEGER NOT NULL REFERENCES repos(id),
  transcript_id TEXT NOT NULL,
  sessions_blob BLOB NOT NULL,
  written_at_ms INTEGER NOT NULL,
  PRIMARY KEY (repo_id, transcript_id)
) STRICT;

-- Many-to-many: one transcript is shared by several nodes of an amend chain,
-- and one memory can reference several. No array index is stored —
-- \`summary.transcripts\` carries the order in summary_json and that is what
-- reassembly uses, so this table only answers queries and owes no fidelity.
CREATE TABLE memory_transcripts (
  repo_id       INTEGER NOT NULL,
  commit_hash   TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  PRIMARY KEY (repo_id, commit_hash, transcript_id),
  FOREIGN KEY (repo_id, commit_hash)
    REFERENCES memories(repo_id, commit_hash) ON DELETE CASCADE,
  FOREIGN KEY (repo_id, transcript_id)
    REFERENCES transcripts(repo_id, transcript_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX ix_mt_transcript ON memory_transcripts(repo_id, transcript_id);

-- Compression makes the sessions invisible to SQL, so the queryable fields are
-- projected out. Uncompressed it would still need this: one session lookup
-- would otherwise parse megabytes of transcript JSON.
CREATE TABLE transcript_sessions (
  repo_id       INTEGER NOT NULL,
  transcript_id TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  source        TEXT,
  PRIMARY KEY (repo_id, transcript_id, session_id),
  FOREIGN KEY (repo_id, transcript_id)
    REFERENCES transcripts(repo_id, transcript_id) ON DELETE CASCADE
) STRICT;
-- session_id leads, not source: the only reason this table exists is "which
-- commits is this session tied to", and source is legitimately NULL on older
-- data and not always known by the caller. Leading with source degrades that
-- lookup to a repo_id prefix plus a scan.
CREATE INDEX ix_ts_session ON transcript_sessions(repo_id, session_id, source);

-- ── context: plans / notes / references / skills unified ────────────────────
-- All four are the same shape: one key, one complete file body, one version.
-- body_md is exactly what readFile() returns today (frontmatter included for a
-- reference or a skill), so the round trip is byte-faithful by construction.
-- native_id is stored separately because path escaping is irreversible —
-- GitHub's \`owner/repo#number\` cannot be recovered from context_key.
--
-- A kind registry table rather than a closed CHECK: adding a kind is an INSERT.
-- 'skill' is NOT inserted here — it arrived after this entry was already on
-- disk in dev databases, so it ships as its own append-only migration (see
-- {@link SKILL_CONTEXT_KIND_DDL}); a fresh database gets it by running that
-- migration, exactly like an existing one.
CREATE TABLE context_kinds (kind TEXT PRIMARY KEY) STRICT;
INSERT INTO context_kinds (kind) VALUES ('plan'), ('note'), ('reference');
CREATE TABLE context (
  id            INTEGER PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repos(id),
  kind          TEXT NOT NULL REFERENCES context_kinds(kind),
  context_key   TEXT NOT NULL,
  source        TEXT,
  native_id     TEXT,
  tool_name     TEXT,
  referenced_at TEXT,
  original_slug TEXT,
  branch        TEXT,
  title         TEXT,
  url           TEXT,
  body_md       TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER,
  -- Non-NULL for plans only. This is plan_progress's foreign-key target, which
  -- is what replaced the three triggers that used to police that relation.
  plan_key TEXT GENERATED ALWAYS AS (CASE WHEN kind = 'plan' THEN context_key END) STORED,
  UNIQUE (repo_id, kind, context_key),
  UNIQUE (repo_id, plan_key),
  -- These three are stricter than file storage, which is a deliberate open
  -- question rather than a settled constraint: a historical reference file on
  -- orphan that lacks \`referencedAt\` is legal as a file but a CHECK violation
  -- here, and the importer's failure set has to be EMPTY before a repo may cut
  -- over. So the import phase counts how many real reference files are missing
  -- each field; if any are, the affected check degrades to the one-way form
  -- below (NULL unless reference) and the missing side is stored as NULL and
  -- logged. Until that measurement exists, keep them — do not relax them on
  -- the theory that looser is safer, because a silent NULL where the field was
  -- expected is its own class of bug.
  CHECK ((source        IS NOT NULL) = (kind = 'reference')),
  CHECK ((native_id     IS NOT NULL) = (kind = 'reference')),
  CHECK ((referenced_at IS NOT NULL) = (kind = 'reference')),
  CHECK (tool_name     IS NULL OR kind = 'reference'),
  CHECK (url           IS NULL OR kind = 'reference'),
  CHECK (original_slug IS NULL OR kind = 'plan'),
  CHECK (branch        IS NULL OR kind IN ('plan','note'))
) STRICT;
-- No indexes. Every context read is by (repo_id, kind, context_key) or
-- (repo_id, kind), both served by the UNIQUE constraint above. The three partial
-- indexes that used to sit here (on source, on (source, native_id), on branch)
-- were built for a queryable-metadata story no query ever arrived for; the
-- columns stay, the indexes do not.

-- ── plan progress ──────────────────────────────────────────────────────────
-- One artifact per (plan, commit), keyed on the plan: a later commit for the
-- same plan overwrites the row. It has to be a table rather than a query
-- because rebuilding it is one LLM call per plan and the output is not
-- reproducible — the same criterion that keeps topic_pages a table.
--
-- ON UPDATE CASCADE is not optional. Plan slugs get normalized and rewritten
-- (which is why context.original_slug exists), and without the cascade an
-- in-place rename is rejected by the foreign key while a DELETE+INSERT rename
-- silently takes the progress with it.
CREATE TABLE plan_progress (
  repo_id       INTEGER NOT NULL,
  plan_slug     TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  -- No generated columns. \`artifact_json\` is written and read whole (see
  -- SqliteStorage), so the eight projections that used to sit here — originalSlug,
  -- commitHash, commitMessage, commitDate, summary, steps, llm.model and a CAST
  -- payload_version — answered no query. Project a field out again when something
  -- needs to filter or sort on it, not on the theory that it might.
  PRIMARY KEY (repo_id, plan_slug),
  FOREIGN KEY (repo_id, plan_slug) REFERENCES context(repo_id, plan_key)
    ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;

-- ── topic KB ───────────────────────────────────────────────────────────────
-- Not the same thing as summary_json's \`topics\`, which are groupings inside one
-- commit. A topic page is what accumulated about one topic across commits, so
-- it is derived but not cheap: one LLM call per topic, output not reproducible.
-- topic_pages.summary existed only inside topics/index.json; storing it here is
-- what lets that index become a view.
CREATE TABLE topic_pages (
  repo_id         INTEGER NOT NULL REFERENCES repos(id),
  stable_slug     TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT,
  content_md      TEXT NOT NULL,
  related_branches_json TEXT NOT NULL DEFAULT '[]',
  last_updated_at TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (repo_id, stable_slug)
) STRICT;

-- pos preserves the page's sourceRefs[] array order. The UNIQUE on it is the
-- same hazard as memories.child_pos, with a cheaper fix: this table has no
-- self-referencing foreign key, so the write module replaces a page's refs as a
-- whole group (DELETE then re-INSERT in one transaction) rather than updating
-- positions row by row. Never UPDATE pos in place.
CREATE TABLE topic_source_refs (
  repo_id     INTEGER NOT NULL,
  stable_slug TEXT NOT NULL,
  pos         INTEGER NOT NULL,
  ref_type    TEXT NOT NULL CHECK (ref_type IN ('summary','plan','note','userfile')),
  ref_id      TEXT NOT NULL,
  ts          TEXT NOT NULL,
  branch      TEXT,
  PRIMARY KEY (repo_id, stable_slug, ref_type, ref_id),
  UNIQUE (repo_id, stable_slug, pos),
  CHECK (pos >= 0),
  FOREIGN KEY (repo_id, stable_slug)
    REFERENCES topic_pages(repo_id, stable_slug) ON DELETE CASCADE
) STRICT;
CREATE INDEX ix_tsr_ref ON topic_source_refs(repo_id, ref_type, ref_id);

CREATE TABLE topic_processed_sources (
  repo_id     INTEGER NOT NULL REFERENCES repos(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('summary','plan','note','userfile')),
  source_id   TEXT NOT NULL,
  PRIMARY KEY (repo_id, source_type, source_id)
) STRICT;

-- No views. \`v_topic_index\` used to live here, assembling topics/index.json's
-- array-ordered projection with ORDER BY inside json_group_array — but
-- SqliteStorage rebuilds that index directly from topic_pages + topic_source_refs
-- and never queried the view, so it was maintained by the engine on every write
-- and read by nothing.
`;

/**
 * The four cross-row invariants no foreign key or CHECK can express.
 *
 * A healthy database returns 0 rows from all four. **Rows mean the write module
 * has a bug** — this is not data that drifts on its own. Run after amend, squash
 * and rebase, from `jolli doctor` and from the tests.
 *
 * Query 2 binds {@link REORDER_OFFSET} rather than embedding the number: a
 * literal here would be a fourth copy of the constant, and the check would
 * silently stop matching the reorder code that produces the residue.
 */
export const SOT_INSPECTION_QUERIES = {
	/** Children whose root_hash/depth disagree with their parent's (also catches cycles). */
	childTopology: `
		SELECT c.commit_hash FROM memories c JOIN memories p
		    ON p.repo_id = c.repo_id AND p.commit_hash = c.parent_hash
		 WHERE c.root_hash <> p.root_hash OR c.depth <> p.depth + 1`,
	/** Rows still parked in the reorder offset region — the trace of a crash mid-reorder. */
	reorderResidue: "SELECT commit_hash FROM memories WHERE child_pos >= ?",
	/** Roots whose root_hash/depth are wrong. Position invariants are CHECKs and need no query. */
	rootTopology: `
		SELECT commit_hash FROM memories WHERE parent_hash IS NULL
		   AND (root_hash <> commit_hash OR depth <> 0)`,
	/**
	 * Link set != "declared in the summary AND present in transcripts".
	 *
	 * Catches the post-squash state where the summary still declares transcripts
	 * but the link table is empty. Links do not affect file reassembly (order and
	 * ids live in summary_json), so the equivalence harness cannot see this.
	 */
	linkSet: `
		SELECT m.commit_hash FROM memories m
		WHERE COALESCE((SELECT group_concat(mt.transcript_id, ',' ORDER BY mt.transcript_id)
		                  FROM memory_transcripts mt
		                 WHERE mt.repo_id = m.repo_id AND mt.commit_hash = m.commit_hash), '')
		   IS NOT COALESCE((SELECT group_concat(j.value, ',' ORDER BY j.value)
		                      FROM json_each(m.summary_json, '$.transcripts') j
		                     WHERE EXISTS (SELECT 1 FROM transcripts t
		                                    WHERE t.repo_id = m.repo_id AND t.transcript_id = j.value)), '')`,
} as const;

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
 * table, deliberately shrunk once already (see its DDL).
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
 */
/**
 * The rollup's day-scoped DELETE paths (`buildDay`'s whole-day replacement and
 * `forgetRollupDays`) filter on `tz` + `day`, neither of which is a PK prefix —
 * the PK leads with `repo_id`, so both currently scan. Small today, but the
 * table is never pruned, so the scan grows with history. Its own migration entry
 * (8) because rows already on disk at schema 8 predate it; a fresh database gets
 * it inline from {@link STATS_DAILY_DDL} below.
 */
export const STATS_DAILY_DAY_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS ix_stats_daily_day ON stats_daily(tz, day);
`;

export const STATS_DAILY_DDL = `
ALTER TABLE commits ADD COLUMN written_at_ms INTEGER NOT NULL DEFAULT 0;

CREATE TABLE stats_daily (
  -- 0 on the 'built' sentinel, which speaks for the whole day rather than for
  -- one repo; a real repos.id on every data row. No foreign key, for that
  -- reason and because nothing here should cascade: this table is rebuilt, not
  -- maintained, and its delete path is explicit.
  repo_id       INTEGER NOT NULL,
  -- IANA zone the day was cut in. In the key because a day boundary is a
  -- property of the asker: a reader in another zone misses and builds its own
  -- rows rather than reading someone else's days as if they were its own.
  tz            TEXT NOT NULL,
  day           TEXT NOT NULL,           -- local calendar day, YYYY-MM-DD
  -- One of the spend axes, or 'tokens', or the 'built' sentinel.
  --
  -- The sentinel is what separates "this day was computed and had no activity"
  -- from "this day was never computed". Without it every quiet day misses
  -- forever and is recomputed on every request — the days most likely to be
  -- quiet being exactly the ones a wide range is full of. It is stored ONCE per
  -- day rather than once per repo so that a repo added later cannot leave old
  -- days permanently unavailable: a repo that did not exist contributed
  -- nothing, and when it does contribute, its own write stamp marks the day
  -- stale and the day is rebuilt.
  kind          TEXT NOT NULL,
  -- The series within the kind: a model/branch/ticket name for an axis,
  -- input|output|cached for 'tokens', '' for the sentinel.
  series_key    TEXT NOT NULL,
  -- REAL, not INTEGER: the category and branch axes apportion a commit's tokens
  -- across its topics or branches, so a day's contribution is fractional. The
  -- read path rounds at emission exactly as the live path does.
  value         REAL NOT NULL,
  cost_usd      REAL NOT NULL DEFAULT 0,
  -- When this day was computed. Staleness is "a source row was written after
  -- this", so it is compared against the sources' own write stamps and must
  -- never hold a business time.
  built_at_ms   INTEGER NOT NULL,
  -- Sync stamp, same rule as SYNC_STAMP_DDL's columns.
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (repo_id, tz, day, kind, series_key)
) STRICT, WITHOUT ROWID;
${STATS_DAILY_DAY_INDEX_DDL}
`;
