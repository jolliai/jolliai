import { sqlMigration } from "./MigrationHelpers.js";

/**
 * Covering index for the coaching session join.
 *
 * The baseline `ix_mt_transcript(repo_id, transcript_id)` is the exact join key for
 * `readSessionAggregates` (JourneysQuery.ts) but does NOT carry `commit_hash`, which
 * that query also selects. A non-covering index forces the planner to fetch
 * `commit_hash` from the table, so it falls back to a single-column `repo_id=?`
 * search and scans the whole repo's `memory_transcripts` rows for every
 * `transcript_sessions` row it joins — measured at ~2.1 s on a real database (12,917
 * mt rows), and it runs twice per coaching page load (current + prior window).
 * Widening the index to COVER `commit_hash` lets the join match on
 * `(repo_id=? AND transcript_id=?)` with no table fetch: ~2.1 s → ~0.03 s.
 *
 * The baseline `ix_mt_transcript` is left in place (frozen DDL), harmlessly
 * redundant. `IF NOT EXISTS` so a hand-repaired database that already carries the
 * index is a no-op rather than an error — which is what keeps this a pure-SQL
 * `sqlMigration` (re-runnable, fingerprinted) rather than a code entry.
 */
export const MEMORY_TRANSCRIPTS_COVERING_INDEX_DDL = sqlMigration(
	"2026-08-25-0000-memory-transcripts-covering-index",
	`
CREATE INDEX IF NOT EXISTS ix_mt_transcript_covering
  ON memory_transcripts(repo_id, transcript_id, commit_hash);
`,
);
