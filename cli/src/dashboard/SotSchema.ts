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
 *    one exception, `repos_no_delete`, has since been dropped by
 *    REPOS_DELETE_ALLOWED_DDL — so the rule now holds without exception.
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
 *
 * ## `commit_branches` no longer stores reachability — read this before touching it
 *
 * Its in-DDL comment still describes the per-ref `git rev-list` union it was
 * built for, and that comment is FROZEN: this constant is `MIGRATIONS[0]`, whose
 * bytes every existing database has recorded and now byte-compares on every
 * writable open (see `DashboardDb`'s drift check and `MigrationFingerprints`).
 * Editing a character in there makes every database in the wild refuse to open.
 * So the current behaviour is documented here, outside the frozen text.
 *
 * **What it holds now: exactly ONE row per commit — the branch the commit was
 * committed on** (`CommitCreatedEvent.branches` as a one-element list, sourced
 * from the summary's recorded branch in `DashboardCollector`).
 *
 * **Why the union was removed.** It came from `for-each-ref --sort=-committerdate`
 * capped at 50, and that window reshuffles whenever any branch gains a commit —
 * while `DbBackfill`'s `unchangedCommitEvent` compares `branches` for exact set
 * equality. On a repo past the cap every commit the window reached was re-projected
 * on every pass and never converged: measured on a 350-branch repo, 11,953 commits
 * re-enqueued per shift and 24.6 MB of duplicate `events_raw` rows. Worse, the
 * field is replace-when-present, so a branch dropping out of the window DELETED its
 * rows — stored attribution was a moving target under the one query that reads it.
 * A recorded branch is a historical fact about one commit and cannot reshuffle.
 *
 * It is also the better answer for that query (per-PR cost): under reachability
 * every commit on `main` counted under every feature branch based off it, which is
 * the only reason the reader needed an apportioning division at all. What is lost
 * is "which branches can see this commit NOW", checked against what the dashboard
 * asks (cost per PR, cost per commit) and needed by neither.
 *
 * **Why both tables survive with a degenerate use — do NOT drop them.** Released
 * clients still JOIN them for the per-branch series, and the rule here is to keep
 * compatibility with shipped clients rather than delete tables or columns. An older
 * client reading a database this build wrote gets one row per commit, so its
 * `COUNT(*) OVER (PARTITION BY hash)` divisor becomes 1 and it stops apportioning —
 * fixed by this change, not degraded. Dropping them (or removing the CREATE, which
 * is the same thing for every database created afterwards) would make that client
 * fail with `no such table` instead.
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
 *  - **It would have cleaned a provably empty set**, and not merely by
 *    measurement: both write paths DELETE the session's rows before inserting,
 *    so `ON CONFLICT` can only fire on a duplicate `(tool_name, kind)` within
 *    one event, which `ToolUseTally` cannot emit — that pair is its bucket key.
 *    An entry that does nothing is not a cheap precaution: a shipped entry's
 *    name is permanent and its DDL is frozen, so it stays in `MIGRATIONS`, in
 *    the fingerprint test and in every database's log forever.
 *
 * The argument originally written here was the cross-surface cost of the
 * version bump — every surface refusing a file stamped ahead of its own build.
 * That premise is gone: the compatibility gate was removed, and a newer file is
 * now opened and written normally with one warn-once line (see
 * `DASHBOARD_SCHEMA_VERSION`). The conclusion is unchanged on the two reasons
 * above, which never depended on it.
 */

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

/**
 * The migration log — "who ran what, when, and how did it go".
 *
 * A LOG, not a set of booleans, which is what fixes the table shape: the primary
 * key is an autoincrementing sequence because one migration can be touched more
 * than once (skipped by a loser writer, later applied; re-applied after a
 * snapshot restore), and every touch is worth keeping. `schema_meta` is the
 * wrong home for exactly that reason — it is a whole-database singleton (one key,
 * one value) and both its columns are TEXT, so `seq`/`applied_at_ms` would
 * degrade to strings and `ORDER BY seq` to lexicographic order.
 *
 * NOT `WITHOUT ROWID`, unlike its neighbours: `AUTOINCREMENT` requires a rowid,
 * and the table would simply fail to create.
 *
 * The columns each stop a different failure, and none is decorative:
 *
 *  - `name` is the IDENTITY of a migration — the exported DDL constant's name,
 *    not its position in the array. Position as identity is what let two
 *    unmerged branches both claim index 5, so that the one merged second was
 *    silently never executed while the file was stamped as fully migrated. Under
 *    a name key that conflict does not exist: whichever entries are missing get
 *    applied. The cost is that a name is a PERMANENT identifier — renaming one
 *    reads as "never ran" and re-runs it into `duplicate column`.
 *  - `outcome = 'skipped'` records the concurrency skip that used to leave no
 *    trace at all. That is the row the bug above would have been diagnosed from.
 *  - `outcome = 'failed'` is written OUTSIDE the migration's transaction, after
 *    the rollback — inside it the row would roll back with the change it
 *    describes, which is precisely when a trace is most needed (most callers of
 *    `withDashboardDb` swallow the exception, so the user may see no log at all).
 *  - `outcome = 'baseline'` marks a SEEDED row: a database that predates this
 *    table has no log, so its first upgrade writes one row per already-applied
 *    entry. Those rows are a guess about which DDL actually ran (Flyway calls
 *    this taking over an existing database, and uses the same word), so they say
 *    so rather than claiming to be observations.
 *  - `ddl` stores the statement text VERBATIM, which no server-side migration
 *    tool does — they record a script name because the script is in the version
 *    control the operator is standing in. Here the DDL that ran may have come
 *    from a branch that was never merged, or has since been deleted, and the
 *    user's machine has no repository to consult. It doubles as the drift check:
 *    a byte compare against the current constant needs no checksum column (the
 *    DDL constants interpolate nothing at runtime, so the comparison is exact),
 *    and reading all of it measured 0.033 ms against 0.014 ms without.
 *  - `duration_ms` is operational: the baseline entry alone is ~37 KB and ~130
 *    objects, and a future entry that rebuilds a large table can take tens of
 *    seconds on a large database — which the user experiences as "startup hung".
 *
 * It is evidence, NOT a recovery source: it records what DID run, which cannot
 * be inverted into what SHOULD have. Do not build a "replay the log to repair"
 * tool on it.
 */
export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE schema_migrations (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Which array position it ran at. DIAGNOSTIC ONLY — nothing decides anything
  -- from it. Kept because "slot 5" is what a bug report says out loud.
  slot          INTEGER NOT NULL,
  name          TEXT    NOT NULL,
  outcome       TEXT    NOT NULL CHECK (outcome IN ('applied','failed','skipped','baseline')),
  -- \`JOLLI_CLIENT_HEADER\` — '<kind>/<version>', e.g. 'cli/0.99.11' or
  -- 'vscode-plugin/0.99.11'. The surface identity the user would go and upgrade.
  applied_by    TEXT    NOT NULL,
  applied_at_ms INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  ddl           TEXT    NOT NULL
) STRICT;
CREATE INDEX ix_schema_migrations_name ON schema_migrations(name, seq);
`;

/**
 * Drops `repos_no_delete`, the BEFORE DELETE trigger the baseline installed.
 *
 * Appended rather than edited out of `BASELINE_DDL`: a shipped entry's bytes are
 * frozen, and every database on earth has already applied that one. So the
 * baseline still creates the trigger and still carries its original comment
 * arguing for it — that comment is now historical, and this is the entry that
 * supersedes it.
 *
 * **What still protects a repo's memories, measured rather than assumed.** Every
 * child table references `repos(id)` with the default NO ACTION, and
 * `foreign_keys` is ON in both `WRITE_PRAGMAS` and `READ_PRAGMAS`, so deleting a
 * repo that owns ANY row still fails — `FOREIGN KEY constraint failed` instead of
 * the trigger's message. What the trigger added on top was the zero-data case:
 * with it, a repo row could not be removed even when nothing referenced it.
 *
 * The one place that backstop does not hold is `migrateDashboardDb`, which runs
 * with `PRAGMA foreign_keys = OFF` (see the comment there): a DELETE on `repos`
 * inside a migration would succeed and orphan every child row. No migration does
 * that today, and one that wants to must re-enable foreign keys around it.
 *
 * `IF EXISTS` because a database restored from a pre-baseline snapshot, or one
 * whose trigger was dropped by hand, must not fail the migration.
 */
export const REPOS_DELETE_ALLOWED_DDL = `
DROP TRIGGER IF EXISTS repos_no_delete;
`;

/**
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
export const SESSION_ACTIVITY_DDL = `
CREATE TABLE session_activity (
  session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE,
  bucket_ms        INTEGER NOT NULL,
  recorded_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (session_event_id, bucket_ms)
) STRICT;
CREATE INDEX ix_activity_bucket ON session_activity(bucket_ms);
CREATE INDEX ix_activity_recorded ON session_activity(recorded_at_ms);
`;

/**
 * Per-skill token spend, alongside the call count that was already there.
 *
 * The table's own comment says it "counts CALLS, nothing more", and that stays
 * true of every other bucket: a builtin or MCP call is one step inside a turn
 * whose spend belongs to the turn, and there is no principled way to split it.
 * A skill is different in kind — it owns a bounded stretch of the conversation
 * that attribution can delimit — so these columns are populated for
 * \`kind = 'skill'\` alone. See \`ToolCallCount.usage\`, which carries the same
 * restriction on the TS side.
 *
 * **NULLABLE with no DEFAULT, and that is the whole design.** Sources divide
 * three ways: Claude tags each response with the owning skill (exact), OpenCode
 * is delimited by interval (an estimate), and Codex / Kimi / Cursor report
 * nothing this runtime reads today. A \`DEFAULT 0\` would spell the third group
 * as "measured, and it was free" — which is the reading the markdown table
 * already refuses by printing an em dash rather than a zero. It is not a
 * hypothetical minority either: measured on one real machine, 100 of 112 skill
 * calls came from Codex, so the unmeasured group is the MAJORITY of rows and a
 * zero default would make the whole card read as near-free.
 *
 * \`usage_confidence\` is 'attributed' | 'estimated', mirroring
 * \`SkillUsage.confidence\`, and is what tells the two measured groups apart at
 * read time. It is NULL exactly when the three token columns are, so a reader
 * that has it has all four. Stored as TEXT rather than a CHECK-constrained
 * enum for the same reason \`SkillCommitRef.source\` is a plain string on the
 * Kotlin side: a value from a newer build must degrade to "unknown", never make
 * the row unwritable.
 *
 * Backfill is deliberately absent. Rows written before this existed stay NULL —
 * the slice they were read from is behind a cursor by now, and re-deriving the
 * figure would mean re-reading transcripts that may be gone. They become
 * populated the next time their session is re-scanned, which the 30-second pass
 * does on its own.
 */
export const SKILL_TOKEN_USAGE_DDL = `
ALTER TABLE session_tool_use ADD COLUMN input_tokens INTEGER;
ALTER TABLE session_tool_use ADD COLUMN output_tokens INTEGER;
ALTER TABLE session_tool_use ADD COLUMN cached_tokens INTEGER;
ALTER TABLE session_tool_use ADD COLUMN usage_confidence TEXT;
`;

/**
 * One row per skill INVOCATION, beside the per-session aggregate.
 *
 * \`session_tool_use\` says so itself — it "counts CALLS, nothing more" — so the
 * facts that differ between two entries into the same skill have nowhere to live
 * there: when each ran, whether it failed, what arguments it carried, and how much
 * text it injected. That last one is the clearest case against folding them: the
 * same skill entered twice in one session measured 3,619 and 69 characters on a
 * real machine, because a repeat entry injects an "already loaded above" stub
 * instead of the body. An average would report neither.
 *
 * **Tokens are deliberately NOT here, and that is not an omission.** Attribution is
 * per SESSION: the transcript marks each response with the owning skill, never with
 * the owning invocation, so three entries into one skill share one indivisible
 * figure. A per-invocation token column could only ever hold a split no record
 * supports. The four token columns stay on the aggregate, which is the grain they
 * exist at.
 *
 * **The key is (session, skill, instant), and the instant is what makes writes
 * idempotent.** The producing scan is whole-conversation, so every pass re-reads
 * every entry it already saw; keyed on time they land back on their own row instead
 * of accumulating duplicates, which a surrogate id would guarantee. That also
 * matches \`SkillStore.foldSkillUse\`, which dedupes invocations on \`at\` — one key
 * for one fact, so the markdown mirror and this table cannot disagree about what
 * counts as the same entry.
 *
 * **The foreign key points at \`sessions\`, NOT at \`session_tool_use\`.** The tuple
 * (session, skill, 'skill') is that table's primary key and would look like the
 * natural parent, but its writer DELETEs a session's rows and rebuilds them — so
 * for the duration of that transaction the parent row does not exist and every
 * child insert would fail the constraint. \`sessions\` is upserted in place.
 *
 * **Rows are only ever added or updated, never deleted with the aggregate.** An
 * agent prunes its own transcripts, and once a conversation is gone its entries can
 * never be re-derived; a delete-and-rebuild would discard history at the first scan
 * that could no longer see it. The visible cost is that a truncated conversation
 * (a compact) leaves rows the current transcript no longer mentions — kept on
 * purpose, since those invocations did happen.
 *
 * That is also why \`session_tool_use.calls\` must stay independent rather than
 * become \`COUNT(*)\` over this table: the aggregate survives a pruned transcript,
 * the detail does not, and deriving the count would silently rewrite every such
 * skill's history to zero. Codex CLI adds a second reason — it reports one entry
 * per session by design, regardless of how many paged reads produced it.
 *
 * **\`ok\` is NOT NULL and its meaning is qualified by a sibling column**, mirroring
 * how \`usage_confidence\` qualifies the token figures. Spelling "unknown" as a NULL
 * \`ok\` was the obvious alternative and loses information: the scanner did assert an
 * outcome, and \`ok_confidence = 'assumed'\` preserves that assertion while saying it
 * was defaulted rather than read. Three of the six mechanisms have no result record
 * at all — see \`skillOutcomeConfidence\`, which owns that verdict.
 *
 * Both values are CONSUMED, and separately: the skill detail counts \`observed\` rows
 * into a failure rate and \`assumed\` rows into a plainly-worded "ran, result unknown",
 * so a row is never dropped for having the second value. That is the payoff for
 * storing the qualifier instead of a NULL \`ok\` — a NULL would have been indistinguishable
 * from a row whose outcome was never asserted at all.
 *
 * \`entry_path\` reached a surface with the skill detail's "Entered by" row, and
 * \`detection\` now reaches two — the Skills list's \`†\` and the detail pane's caveat on
 * the run figures (\`ToolUsageRow.detection\`). Both were stored ahead of any reader
 * because they are only knowable at scan time and cost one column each: the transcript
 * that proves a Codex entry was inferred rather than observed is routinely deleted
 * within days, so a later decision to show it could not have been served
 * retroactively. \`detection\` is that decision, and it was served entirely from
 * already-recorded rows — no backfill, and none possible.
 *
 * A READER MUST AGGREGATE THIS COLUMN, NOT JOIN TO IT. It is per-entry while
 * \`session_tool_use\` is per (session, skill), so pulling it in with a join multiplies
 * that table's SUMs by the entry count while leaving its COUNT(DISTINCT)s correct —
 * measured at 5 calls reported as 7. See \`toolNameRowsPage\`, which uses a correlated
 * EXISTS for exactly this reason.
 */
export const SKILL_INVOCATIONS_DDL = `
CREATE TABLE skill_invocations (
  session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE,
  skill_name       TEXT NOT NULL,
  -- Epoch ms, matching every other instant in this schema. The invocation's own
  -- moment from the transcript, never the row's write time: it is the identity.
  at_ms            INTEGER NOT NULL,
  ok               INTEGER NOT NULL,
  -- 'observed' (read from a result record) | 'assumed' (defaulted, unknowable).
  ok_confidence    TEXT NOT NULL,
  -- NULL when the entry was observed; 'heuristic' when inferred from a file read.
  detection        TEXT,
  -- 'tool' (the agent decided) | 'command' (the user asked for it) | NULL unknown.
  entry_path       TEXT,
  args             TEXT,
  -- Characters injected by THIS entry. See the docblock on why it cannot be folded.
  body_chars       INTEGER,
  PRIMARY KEY (session_event_id, skill_name, at_ms)
) STRICT;
-- Every read is "this skill's entries, oldest first". The primary key already
-- serves the cascade delete, whose lookup is by session_event_id.
CREATE INDEX ix_si_skill_time ON skill_invocations(skill_name, at_ms);
`;

/**
 * Which plugin provides a skill, on the aggregate rather than the detail.
 *
 * A skill's namespace does not change between two entries into it, so a column on
 * \`skill_invocations\` would store the same string once per invocation. It belongs
 * with the other per-(session, skill) facts.
 *
 * NULL means an unprefixed skill, not an unknown one — most skills have no plugin.
 * The value is the host's own answer where there is one (Claude reports
 * \`attributionPlugin\` directly) and the namespace segment of the id otherwise; a
 * contested name is stored NULL rather than attributed to whichever plugin was seen
 * first, which \`observeSkillEntry\` decides.
 */
export const SKILL_PLUGIN_DDL = `
ALTER TABLE session_tool_use ADD COLUMN plugin TEXT;
`;

/**
 * Which skill ROOT the host loaded a skill from — a different question from
 * \`plugin\`, and the only one some hosts can answer.
 *
 * \`plugin\` names WHICH plugin provides a skill and is recoverable only where the id
 * carries a namespace (\`superpowers:brainstorming\`) or the host reports one
 * (Claude's \`attributionPlugin\`). Cursor does NEITHER — measured, it does not
 * namespace plugin skills at all, and its plugin, repo and global skills are
 * distinguished only by the path they were loaded from. So \`plugin\` is permanently
 * NULL there, and NULL is the right answer for most of those roots: a skill under
 * \`.agents/skills/\` genuinely has no plugin.
 *
 * What the path DOES say is which tree supplied it, which is what this records
 * (\`plugin-bundle\` | \`cursor-global\` | \`repo-agents\` | \`repo-cursor\` |
 * \`other-host\` | \`unknown\` — see \`SkillOriginRoot\`). That distinction is
 * load-bearing on this host for a reason peculiar to it: the SAME skill can be
 * supplied by a plugin bundle, by \`.agents/skills/\`, or by the per-repo
 * \`.cursor/skills/\` mirror \`reconcileCursorRepoSkills\` writes, and the three are
 * one flat pool with no namespacing to tell them apart.
 *
 * Stored ahead of a reader, on the same rule as \`entry_path\` and \`detection\`
 * before it: it is knowable only at scan time, the transcript that proves it is
 * routinely deleted within days, and a later decision to surface it could not be
 * served retroactively.
 *
 * Deliberately NOT a derived \`plugin\` value. \`plugin-bundle\` says a plugin supplied
 * the skill but not which one; the segment after \`plugins/\` has been captured for
 * exactly one marketplace layout (\`~/.cursor/plugins/local/<plugin>/\`), and guessing
 * the general shape is how this repo has previously shipped a parser whose fixtures
 * and code were both imagined and agreed with each other and with nothing real.
 */
export const SKILL_ORIGIN_ROOT_DDL = `
ALTER TABLE session_tool_use ADD COLUMN origin_root TEXT;
`;

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
 *
 * ⚠ `stats_daily.updated_at_ms` is NOT a sync stamp, whatever its inline comment
 * says. The DDL calls it one ("same rule as SYNC_STAMP_DDL's columns") and the
 * shape and the rule really are the same, but this table is on
 * `SessionPushManifest.NEVER_SYNCED_TABLES` — it is a cache cut in ONE machine's
 * timezone — so it has no `SYNC_STAMP_COLUMNS` entry and no cursor ever reads
 * this column. It is here for symmetry with every other projected table, and
 * because "when was this row written" is the first thing wanted when the cache is
 * being debugged. Do not read the inline wording as a licence to put the table on
 * the wire on the strength of the column.
 *
 * (The clarification lives HERE rather than in the DDL text for the reason
 * `SYNC_STAMP_NULL_BACKFILL_DDL` states about entry 7: these bytes have shipped,
 * `MIGRATIONS` is keyed by name so editing them re-runs nothing, and a comment
 * rewrap would cost every existing database a fingerprint-mismatch warning while
 * fixing the text only for machines that have not seen it yet. A TypeScript
 * docstring is not hashed.)
 */
/**
 * The rollup's day-scoped DELETE paths (`buildDay`'s whole-day replacement and
 * `forgetRollupDays`) filter on `tz` + `day`, neither of which is a PK prefix —
 * the PK leads with `repo_id`, so both currently scan. Small today, but the
 * table is never pruned, so the scan grows with history.
 *
 * Its own migration entry because a database that already applied
 * {@link STATS_DAILY_DDL} predates it; a fresh one gets the index inline from
 * that entry.
 *
 * Named rather than numbered on purpose. This used to read "entry (8) because
 * rows already on disk at schema 8 predate it", and both numbers were wrong by
 * then — entries had been inserted ahead of it, and the seven unreleased steps
 * were later merged into `SESSION_STATS_SYNC_DDL`, which moved every number again.
 * `MIGRATIONS` is keyed by NAME, so a name is the only identifier that cannot go
 * stale; leave the numbering to `DashboardDb`'s own enumeration, which is derived
 * from the array order.
 */
export const STATS_DAILY_DAY_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS ix_stats_daily_day ON stats_daily(tz, day);
`;

export const STATS_DAILY_DDL = `
ALTER TABLE commits ADD COLUMN written_at_ms INTEGER NOT NULL DEFAULT 0;

-- IF NOT EXISTS because an earlier, unreleased build of this branch already
-- created this table on some machines (a developer's own among them) under a
-- migration name this log has no row for. Without the guard, such a database
-- re-runs the entry, dies on "table stats_daily already exists", and every open
-- after that fails until 'doctor --mark-migration' is run by hand.
--
-- The ALTER above cannot be guarded the same way -- SQLite has no
-- ADD COLUMN IF NOT EXISTS -- so a database that also already has that column
-- still needs that repair, which is precisely the state 'doctor
-- --mark-migration' documents itself as existing for. The two statements are
-- deliberately NOT split into separate entries to make each independently
-- markable: the split would leave a machine that has ALREADY applied this entry
-- under this name re-running the ALTER from a new slot, turning a repair anyone
-- can do into a failure everyone gets.
CREATE TABLE IF NOT EXISTS stats_daily (
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

/**
 * An index on every sync stamp, for the two hot paths that were left scanning.
 *
 * `SYNC_STAMP_DDL` added the columns and `STATS_DAILY_DDL` added
 * `commits.written_at_ms`, but neither added an index — so both readers of these
 * columns walked whole tables, and both are on paths that run constantly:
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
 * `IF NOT EXISTS` throughout so a re-run is free, and its own entry rather than
 * an edit to the two entries above, which have already been applied.
 */
export const SYNC_STAMP_INDEX_DDL = `
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
 * PRIMARY KEY. The stamp-only indexes from `SYNC_STAMP_INDEX_DDL` remain a
 * PREFIX of these, so the rollup's staleness scans keep their plan either way.
 *
 * ⚠ Its own entry rather than an edit to `SYNC_STAMP_INDEX_DDL`, which databases
 * have already applied — including the author's. Editing it would be caught by
 * `MigrationFingerprints.test.ts`, and worse, its `CREATE INDEX IF NOT EXISTS`
 * would then find the stamp-only index already there under the same name and
 * silently skip the wider one.
 *
 * `session_usage_events` is deliberately ABSENT. It is `WITHOUT ROWID`, so
 * SQLite appends the PRIMARY KEY to every secondary index automatically — its
 * `ix_sue_sync(updated_at_ms)` already IS `(updated_at_ms, session_event_id,
 * dedup_key)`. The other four are rowid tables, where the appended column is the
 * rowid and the PK has to be spelled out.
 */
export const SYNC_KEYSET_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS ix_sessions_keyset ON sessions(written_at_ms, event_id);
CREATE INDEX IF NOT EXISTS ix_smu_keyset ON session_model_usage(updated_at_ms, session_event_id, model);
CREATE INDEX IF NOT EXISTS ix_stu_keyset ON session_tool_use(updated_at_ms, session_event_id, tool_name, kind);
CREATE INDEX IF NOT EXISTS ix_recall_receipts_keyset ON recall_receipts(updated_at_ms, receipt_id);
`;

/**
 * Gives every sync stamp a NUMBER, because on real databases some are NULL.
 *
 * ⚠ `SYNC_STAMP_DDL` declares these columns `NOT NULL DEFAULT 0` and backfills
 * them, and on a database that actually RAN it both are true. On one that was
 * handed those columns by a pre-log build, neither is: the log records that
 * entry as `baseline` — "this file already looks migrated" — so the declaration
 * never executed, the columns are nullable, and the backfill never ran. Measured
 * on the author's own database: `sessions.written_at_ms` is `notnull=0`, with 30
 * sessions, 201 tool-use rows and 56 model-usage rows holding NULL.
 *
 * A NULL there is not a small defect. Selection is `WHERE (<stamp>, …) >= (?, …)`
 * and SQL answers NULL — not true — for every comparison against NULL, so such a
 * row is invisible to EVERY cursor, for ever, with nothing anywhere reporting it.
 * That is exactly the failure `SyncColumns.ts` warns about; it simply arrived
 * through the migration log rather than through a hand-written column.
 *
 * The values mirror `SYNC_STAMP_DDL`'s own backfill, one clause wider: it looked
 * only for `= 0`, which is precisely the case that cannot occur when the column
 * was never given that default. 0 means "written before we tracked this", which
 * no cursor past 0 revisits and which the first sync sends once.
 *
 * This cannot restore the NOT NULL constraint — SQLite has no ALTER COLUMN — and
 * does not need to: every writer passes an explicit stamp, so nothing produces a
 * new NULL. `SyncColumns.test.ts` asserts the invariant on a freshly migrated
 * database.
 *
 * ⚠ `session_tool_use` prefers its OWN `last_call_at_ms` here, where
 * `SYNC_STAMP_DDL` goes straight to the parent session — a deliberate divergence,
 * not a copy that drifted. That column arrived in entry 4, so it is the better
 * approximation of "when this row was written", and this entry is the one being
 * added now. Entry 7 is not corrected to match: it has already been applied on
 * real databases, so editing its SQL changes nothing there (a name-keyed
 * migration never re-runs) while costing every one of them a fingerprint-mismatch
 * warning — a rewrite that only fixes the text and only for machines that have
 * not seen it yet.
 */
export const SYNC_STAMP_NULL_BACKFILL_DDL = `
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
