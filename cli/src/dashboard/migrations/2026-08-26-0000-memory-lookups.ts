import { sqlMigration } from "./MigrationHelpers.js";

/**
 * `memory_lookups` — one row per lookup against this repo's memory, whoever served it.
 *
 * The generalisation of `recall_receipts` (entry 1, dropped by the next entry). Its
 * doctrine carries over verbatim and is the reason this table exists at all: **a
 * lookup exists only while it is being answered.** Every other projection in
 * `StatsWriter` restates something durable — a commit, a session file, a summary —
 * so losing it costs a rescan. A `search` or `recall` call cannot be recovered
 * afterwards, which is why both are observed at the ANSWERING EDGE (the MCP tools and
 * the `jolli search` / `jolli recall` commands, via `ProducerHooks`) rather than
 * mined out of a transcript. The transcript route was measured and could only ever
 * see a third of the calls: never a CLI run, never a non-Claude agent, and never a
 * session older than the 48 h `sessions.json` retention its re-projection depends on.
 *
 * It is still cheap to lose — it costs a figure on one card, never a memory — which
 * is what lets the producer keep the never-throw discipline every other dashboard
 * write has.
 *
 * ## Why one table with a `kind` rather than one table per feature
 *
 * `search` and `recall` are the same event with different arguments, and a third
 * (a timeline lookup) is plausible. `kind` keeps the next one from needing a table,
 * a manifest entry, a projector and a migration of its own.
 *
 * Three shapes were deliberately NOT taken:
 *
 *  - **No `detail_json`.** A `kind` column plus a blob is where a general table goes
 *    to die: it gives up `STRICT` typing, and it makes `SessionPushManifest`'s
 *    column-by-column privacy review meaningless — nobody can review what is inside
 *    an opaque string. `recall_receipts.commits_json` is not carried over for the
 *    same reason it was droppable: nothing ever read it.
 *  - **No per-kind CHECK constraints.** `context` expresses its per-kind shape that
 *    way (`CHECK ((source IS NOT NULL) = (kind = 'reference'))`), and it is right
 *    there — but SQLite cannot alter a CHECK without rebuilding the table, so
 *    encoding the shape here would cost a table rebuild every time a `kind` is added,
 *    cancelling the one benefit this table has. The shape lives in TypeScript
 *    instead, as `LookupObservedEvent`'s discriminated union, where the compiler
 *    enforces it and a new kind is a compile error rather than a migration.
 *  - **No generated `query_key`.** SQLite has no expression that folds runs of
 *    internal whitespace, and a migration must not derive business data. The producer
 *    computes it with `normalizeLookupQuery` and writes it.
 *
 * ## Column notes
 *
 * `query` / `query_key` are NULL for `recall` (it takes a branch, not a query);
 * `target` is NULL for `search`. Both are the normal case, not a defect.
 *
 * `target` holds what the CALLER ASKED FOR, which is a branch in the common case and
 * not only a branch: `jolli recall <branchOrKeyword>` accepts a keyword and the
 * receipt records that verbatim, because the row is a record of the REQUEST. The
 * in-table comment says "branch" and stays as written — a committed entry's bytes are
 * frozen — so read it as the common case rather than a guarantee, and do not join
 * this column against a ref list. It is NULL for a bare `jolli recall`, which
 * resolves the current branch inside `resolveRecall` where no caller can see it.
 *
 * `hit` and `result_count` look redundant and are not: a `recall` can resolve a
 * branch that has no commits, so "served something" is not derivable from a count.
 * On `search` rows `hit` IS exactly `result_count > 0` — kept only so one predicate
 * answers "did this lookup return anything" across both kinds.
 *
 * `session_id` is the AGENT's session id (the same value `sessions.session_id`
 * carries), taken from the host's environment when it exposes one and NULL
 * otherwise — a `jolli search` typed into a plain terminal belongs to no session and
 * must not be attributed to one. Note `COUNT(DISTINCT session_id)` therefore ignores
 * it, which is why the card counts "agent sessions" rather than "sessions".
 *
 * ## Indexes
 *
 * Two read indexes, and they are not duplicates. Every card query is
 * `kind = ? AND at_ms >= ? AND at_ms < ?`, but `scopeFilter` emits NO predicate at
 * all under an all-repos scope — so a `repo_id`-leading index has no usable leading
 * column there and only `(kind, at_ms)` can be used. Under a single-repo scope
 * `(repo_id, kind, at_ms)` is the tighter one. With one index only, half the scopes
 * degrade to a full scan.
 *
 * `(updated_at_ms, receipt_id)` is the sync channel's keyset cursor, built in advance
 * (this table is sync-ready but not yet on the wire — see `SessionPushManifest`).
 * A stamp alone cannot page a table: once more rows share one millisecond than a
 * batch holds, a stamp-only cursor can never step past it and the table stops syncing
 * for good. Measured elsewhere in this schema at 840 rows on one millisecond against
 * a limit of 500, stuck for five days.
 */
export const MEMORY_LOOKUPS_DDL = sqlMigration(
	"2026-08-26-0000-memory-lookups",
	`
CREATE TABLE IF NOT EXISTS memory_lookups (
  -- The producer's own idempotency key (statsEventId), so a re-drained event
  -- converges on one row instead of appending a duplicate lookup.
  receipt_id    TEXT PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repos(id),
  -- 'search' | 'recall'. Not a CHECK — see the docblock.
  kind          TEXT NOT NULL,
  -- 'mcp' | 'cli'. Kept because the two answer different questions about adoption,
  -- and because a surface that stops reporting is only visible here.
  surface       TEXT NOT NULL,
  session_id    TEXT,
  -- Business clock: the first sync's "only go back N days" window filters on this,
  -- never on updated_at_ms (a backfill rewrites every stamp to "just now").
  at_ms         INTEGER NOT NULL,
  -- Verbatim query text for 'search'; NULL for 'recall'.
  query         TEXT,
  -- Normalised bucket key for 'search' (lower + trim + collapsed whitespace);
  -- NULL for 'recall'. Written by the producer, never derived in SQL.
  query_key     TEXT,
  -- The branch a 'recall' asked for; NULL for 'search'.
  target        TEXT,
  result_count  INTEGER NOT NULL DEFAULT 0,
  -- Not derivable from result_count on a 'recall' — see the docblock.
  hit           INTEGER NOT NULL DEFAULT 0,
  -- Sync stamp. NOT NULL DEFAULT 0 is a hard requirement: NULL >= anything is NULL
  -- rather than false, so one nullable stamp is a row no cursor can ever select.
  updated_at_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS ix_memory_lookups_kind_at ON memory_lookups(kind, at_ms);
CREATE INDEX IF NOT EXISTS ix_memory_lookups_repo_at ON memory_lookups(repo_id, kind, at_ms);
CREATE INDEX IF NOT EXISTS ix_memory_lookups_keyset  ON memory_lookups(updated_at_ms, receipt_id);
`,
);
