import { type DbMigration, sqlMigration } from "./MigrationHelpers.js";

/**
 * Entry 10 — one row per skill invocation, beside the per-session aggregate in
 * `session_tool_use`. Arrived on `main` in the same pre-idempotency window as
 * `SESSION_ACTIVITY_DDL` — see that entry's docblock. A pure `CREATE`, so it
 * stayed a `sqlMigration` with `IF NOT EXISTS` added in place.
 *
 * One row per skill INVOCATION, beside the per-session aggregate.
 *
 * `session_tool_use` says so itself — it "counts CALLS, nothing more" — so the
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
 * matches `SkillStore.foldSkillUse`, which dedupes invocations on `at` — one key
 * for one fact, so the markdown mirror and this table cannot disagree about what
 * counts as the same entry.
 *
 * **The foreign key points at `sessions`, NOT at `session_tool_use`.** The tuple
 * (session, skill, 'skill') is that table's primary key and would look like the
 * natural parent, but its writer DELETEs a session's rows and rebuilds them — so
 * for the duration of that transaction the parent row does not exist and every
 * child insert would fail the constraint. `sessions` is upserted in place.
 *
 * **Rows are only ever added or updated, never deleted with the aggregate.** An
 * agent prunes its own transcripts, and once a conversation is gone its entries can
 * never be re-derived; a delete-and-rebuild would discard history at the first scan
 * that could no longer see it. The visible cost is that a truncated conversation
 * (a compact) leaves rows the current transcript no longer mentions — kept on
 * purpose, since those invocations did happen.
 *
 * That is also why `session_tool_use.calls` must stay independent rather than
 * become `COUNT(*)` over this table: the aggregate survives a pruned transcript,
 * the detail does not, and deriving the count would silently rewrite every such
 * skill's history to zero. Codex CLI adds a second reason — it reports one entry
 * per session by design, regardless of how many paged reads produced it.
 *
 * **`ok` is NOT NULL and its meaning is qualified by a sibling column**, mirroring
 * how `usage_confidence` qualifies the token figures. Spelling "unknown" as a NULL
 * `ok` was the obvious alternative and loses information: the scanner did assert an
 * outcome, and `ok_confidence = 'assumed'` preserves that assertion while saying it
 * was defaulted rather than read. Three of the six mechanisms have no result record
 * at all — see `skillOutcomeConfidence`, which owns that verdict.
 *
 * Both values are CONSUMED, and separately: the skill detail counts `observed` rows
 * into a failure rate and `assumed` rows into a plainly-worded "ran, result unknown",
 * so a row is never dropped for having the second value. That is the payoff for
 * storing the qualifier instead of a NULL `ok` — a NULL would have been indistinguishable
 * from a row whose outcome was never asserted at all.
 *
 * `entry_path` reached a surface with the skill detail's "Entered by" row, and
 * `detection` now reaches two — the Skills list's `†` and the detail pane's caveat on
 * the run figures (`ToolUsageRow.detection`). Both were stored ahead of any reader
 * because they are only knowable at scan time and cost one column each: the transcript
 * that proves a Codex entry was inferred rather than observed is routinely deleted
 * within days, so a later decision to show it could not have been served
 * retroactively. `detection` is that decision, and it was served entirely from
 * already-recorded rows — no backfill, and none possible.
 *
 * A READER MUST AGGREGATE THIS COLUMN, NOT JOIN TO IT. It is per-entry while
 * `session_tool_use` is per (session, skill), so pulling it in with a join multiplies
 * that table's SUMs by the entry count while leaving its COUNT(DISTINCT)s correct —
 * measured at 5 calls reported as 7. See `toolNameRowsPage`, which uses a correlated
 * EXISTS for exactly this reason.
 */
export const SKILL_INVOCATIONS_DDL: DbMigration = sqlMigration(
	"SKILL_INVOCATIONS_DDL",
	`
CREATE TABLE IF NOT EXISTS skill_invocations (
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
CREATE INDEX IF NOT EXISTS ix_si_skill_time ON skill_invocations(skill_name, at_ms);
`,
);
