import { type DbMigration, sqlMigration } from "./MigrationHelpers.js";

/**
 * Entry 1 — `recall_receipts` as a real migration rather than folded into entry 0:
 * by the time it landed, dev databases already existed with entry 0's shape, and
 * only an appended entry reaches those as well as fresh ones.
 *
 * Recall receipts — one row per recall call, written by whoever served it.
 *
 * Part of the activity layer but NOT in `BASELINE_DDL`: it arrived after schema v1
 * was already on disk in dev databases, so it ships as the second append-only
 * migration instead. A fresh database gets it by running that migration, exactly
 * like an existing one.
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
 *
 * ## Nothing in this build writes it, and it must NOT be dropped
 *
 * `recall` is now observed as a `memory_lookups` row of `kind = 'recall'`
 * (`MEMORY_LOOKUPS_DDL`), and `projectRecallObserved` survives only as a rewriting
 * adapter onto that table. This one is therefore write-dead HERE — and retained on
 * purpose, because "here" is one dist among several on the same machine.
 *
 * A `2026-08-26-0001-drop-recall-receipts` entry existed on a branch and was removed
 * before it merged. Two measurements killed it, both about an OLDER dist that
 * `run-hook`'s version race still lets win:
 *
 *  - **Reads.** 0.99.10-0.99.12 carry the standalone Recall card, whose
 *    `buildRecallUsage` SELECTs this table UNCONDITIONALLY from inside the single
 *    model build, and `DashboardServer`'s request handler turns the throw into a
 *    plain-text 500. So the table's absence takes that dist's WHOLE dashboard
 *    offline — every page and every JSON model route — not one blank card. The card
 *    was removed in 0.99.13, so 0.99.13-0.99.15 only write.
 *  - **Writes.** Those are survivable but NOT self-healing. `drainPending` parks the
 *    event instead of failing the recall the user is waiting on, and
 *    `ProducerHooks.recordLookupReceipt` never throws — but `no such table`
 *    classifies as `failed_kind = 'error'`, which `REVIVABLE_PREDICATE` deliberately
 *    excludes, so a row that spends its five attempts is reachable only by
 *    `jolli doctor --fix` (`unparkStuckEvents`), which is deliberately manual.
 *
 * It was REMOVED rather than compensated with a re-`CREATE` entry, and that choice is
 * the `2026-08-19-0000-session-stats-heal` shape from `migrations/index.ts`: the drop
 * had never been in a release, so no user database ever carried the name, and a
 * compensating entry would have shipped to everyone for ever for the sole benefit of a
 * developer machine that had pulled the branch. Such a machine keeps a log row this
 * build does not know, which makes `dbHasUnknownMigrations` true and switches the
 * `stats_daily` rollup off (`StatsRollup.ts`) — a one-off hand repair of one machine's
 * derived state, never a product entry.
 */
export const RECALL_RECEIPTS_DDL: DbMigration = sqlMigration(
	"RECALL_RECEIPTS_DDL",
	`
CREATE TABLE IF NOT EXISTS recall_receipts (
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
CREATE INDEX IF NOT EXISTS ix_recall_receipts_repo_at ON recall_receipts(repo_id, at_ms);
`,
);
