// Each import's file name is the REAL date this entry's array position was
// established on `main` (verified via `git log`/`git show` at specific commits, not
// a chosen or fabricated one) — see the docblock below for the one case where that
// is NOT the same date the entry's `name` first appeared anywhere in history.
// Same-day entries take 0000/0001/... in the SAME order they hold in the array
// below, which is why the file listing matches execution order throughout.
import { BASELINE_DDL } from "./2026-08-12-0000-baseline.js";
import { RECALL_RECEIPTS_DDL } from "./2026-08-12-0001-recall-receipts.js";
import { SKILL_CONTEXT_KIND_DDL } from "./2026-08-12-0002-skill-context-kind.js";
import { EVENT_FAILED_KIND_DDL } from "./2026-08-12-0003-event-failed-kind.js";
import { TOOL_CALL_TIME_DDL } from "./2026-08-12-0004-tool-call-time.js";
import { SCHEMA_MIGRATIONS_DDL } from "./2026-08-12-0005-schema-migrations.js";
import { REPOS_DELETE_ALLOWED_DDL } from "./2026-08-14-0000-repos-delete-allowed.js";
import { SESSION_STATS_SYNC_DDL } from "./2026-08-18-0000-session-stats-sync.js";
import { SESSION_ACTIVITY_DDL } from "./2026-08-19-0000-session-activity.js";
import { SKILL_TOKEN_USAGE_DDL } from "./2026-08-19-0001-skill-token-usage.js";
import { SKILL_INVOCATIONS_DDL } from "./2026-08-19-0002-skill-invocations.js";
import { SKILL_PLUGIN_DDL } from "./2026-08-19-0003-skill-plugin.js";
import { SKILL_ORIGIN_ROOT_DDL } from "./2026-08-20-0000-skill-origin-root.js";
import { MEMORY_TRANSCRIPTS_COVERING_INDEX_DDL } from "./2026-08-25-0000-memory-transcripts-covering-index.js";
import { MEMORY_REACHABLE_DDL } from "./2026-08-25-0001-memory-reachable.js";
import { COMMIT_REACHABLE_DDL } from "./2026-08-25-0002-commit-reachable.js";
import { MEMORY_LOOKUPS_DDL } from "./2026-08-26-0000-memory-lookups.js";
import type { DbMigration } from "./MigrationHelpers.js";

export type { DbMigration } from "./MigrationHelpers.js";
export { addColumnIfMissing, sqlMigration } from "./MigrationHelpers.js";

/**
 * Legacy entry names, frozen: everything appended after these is timestamped.
 *
 * `SKILL_ORIGIN_ROOT_DDL` joined this list, not the timestamped tail, even though it
 * arrived after this convention existed: it was written on a branch that had not yet
 * rebased onto this one, using the pre-refactor `<CONSTANT>_DDL` style, and reached
 * `main` — and other developers' databases — before the two could be reconciled. Its
 * name is exactly as frozen as the first twelve; see its own file for the full story.
 */
export const LEGACY_MIGRATION_NAMES: ReadonlyArray<string> = [
	"BASELINE_DDL",
	"RECALL_RECEIPTS_DDL",
	"SKILL_CONTEXT_KIND_DDL",
	"EVENT_FAILED_KIND_DDL",
	"TOOL_CALL_TIME_DDL",
	"SCHEMA_MIGRATIONS_DDL",
	"REPOS_DELETE_ALLOWED_DDL",
	"SESSION_STATS_SYNC_DDL",
	"SESSION_ACTIVITY_DDL",
	"SKILL_TOKEN_USAGE_DDL",
	"SKILL_INVOCATIONS_DDL",
	"SKILL_PLUGIN_DDL",
	"SKILL_ORIGIN_ROOT_DDL",
];

/**
 * Append-only migration list. Applied in array order, on any writable open.
 *
 * **One migration, one file, and the file listing matches execution order.** Each
 * entry above is its own module under `migrations/`, named `YYYY-MM-DD-NNNN-<subject>.ts`
 * where the date is the real day this entry took its place in the log-tracked array
 * on `main` (verified per-entry via `git log`/`git show`, never a chosen or
 * fabricated one) and `NNNN` disambiguates same-day entries, counting up in the SAME
 * order those entries hold in {@link MIGRATIONS} below. That file is where its
 * SQL/`run` logic and its own rationale live; a code entry's companion test lives
 * beside it too (same file name, `.test.ts`), never in `DashboardDb.test.ts`. This
 * module's job is only to import each in order and assemble the list below — nothing
 * here should need to change when a migration's own content changes.
 *
 * ⚠ The FILE name is not the migration's identity — `name` is (see
 * `MigrationHelpers.ts`'s `DbMigration.name` doc). Renaming a file changes nothing a
 * database can see; renaming the `name` string inside it breaks every install that
 * has already applied the entry. The two are independent, and `SESSION_ACTIVITY_DDL`
 * is the one entry here where that independence is worth stating explicitly:
 * `git log -S'"SESSION_ACTIVITY_DDL"'` finds the identifier on 2026-08-11, but that
 * commit predates the named-log system by a day (it built `session_activity` under
 * the OLD position-indexed `schema_version` scheme) and its entry was NOT carried
 * into the new log-tracked array when that system launched — `git show` at the
 * launch commit lists only six entries, `SESSION_ACTIVITY_DDL` absent. It stayed
 * unwired (the exported constant sitting unused) until 2026-08-19, when "Give skill
 * usage its own page in the dashboard" wired it in immediately ahead of the three
 * `SKILL_*` entries that commit also added — which is why its file is dated
 * 2026-08-19-0000, not 2026-08-11. Read the array below for order; the file date is
 * this array's own history, not the identifier's.
 *
 * **Never edit an entry that has been committed — not even an unreleased one.**
 * Ship a new entry (a new file) for any delta. That rule is the whole point of this
 * file's current shape, and it was learned the hard way: `SESSION_STATS_SYNC_DDL`
 * was unreleased, so it was edited in place across branches, and a database that had
 * logged the name under OLDER SQL skipped the newer SQL as "already done" — leaving
 * `no such table: stats_daily` and `commits has no column named written_at_ms` on
 * machines whose log said the migration had run. Same name, two different SQL
 * bodies. See §"How to add a dashboard migration" in AGENTS.md.
 *
 * Entries are identified by `name`, not by position: `migrateDashboardDb` (in
 * `DashboardDb.ts`) applies whichever names the file's log does not already carry.
 * That is what makes two branches appending a migration each a non-event after the
 * merge — both entries are in the array, so both get applied — where
 * position-as-identity let the second-merged one be skipped forever with the file
 * stamped as complete.
 *
 * **Array order is the execution order; the timestamps in new names are NOT a sort
 * key.** They buy uniqueness and a chronology a human can read. Sorting by them
 * would mean a back-dated entry executes in a different position on a fresh
 * database than it did on an existing one. So: APPEND, never insert into the middle
 * and never reorder — inserting ahead of entries a database has already applied
 * would run it out of order (a column added before its table exists).
 *
 * The first twelve entries keep their original `<CONSTANT>_DDL` names, frozen: a
 * name is what the log is keyed by, so those can never be renamed. Their FILE names
 * are not frozen the same way (see the ⚠ above) — `jolli doctor --schema-log` prints
 * the `name`, not a file path, so finding the file for a printed name means reading
 * the import list above, not grepping a path. Everything appended after these
 * twelve is named (and filed) `YYYY-MM-DD-HHMM-<subject>.ts` at the time it is
 * written, per AGENTS.md's naming convention — see {@link LEGACY_MIGRATION_NAMES}.
 *
 * See each entry's own file for why it exists and what it does; only the
 * cross-entry notes stay here.
 *
 * There is no entry normalising a stored `0` in `session_tool_use.last_call_at_ms`,
 * and that absence is a decision: the writers cannot produce one, and the reader
 * treats one as absent (`TOOL_CALL_TIME_SQL`'s `NULLIF`), which is permanent where a
 * migration entry runs once. See the note in `SotSchema.ts` where that entry used to
 * be.
 *
 * Exported for tests: they run entries directly to build a database at a chosen
 * point rather than hand-rolling copies of the DDL, which would drift.
 */
export const MIGRATIONS: ReadonlyArray<DbMigration> = [
	BASELINE_DDL,
	RECALL_RECEIPTS_DDL,
	SKILL_CONTEXT_KIND_DDL,
	EVENT_FAILED_KIND_DDL,
	TOOL_CALL_TIME_DDL,
	SCHEMA_MIGRATIONS_DDL,
	REPOS_DELETE_ALLOWED_DDL,
	SESSION_STATS_SYNC_DDL,
	SESSION_ACTIVITY_DDL,
	SKILL_TOKEN_USAGE_DDL,
	SKILL_INVOCATIONS_DDL,
	SKILL_PLUGIN_DDL,
	SKILL_ORIGIN_ROOT_DDL,
	MEMORY_TRANSCRIPTS_COVERING_INDEX_DDL,
	MEMORY_REACHABLE_DDL,
	COMMIT_REACHABLE_DDL,
	MEMORY_LOOKUPS_DDL,
];

/*
 * A `2026-08-19-0000-session-stats-heal` entry used to sit here, running
 * `applySessionStatsSchema` (see `SESSION_STATS_SYNC_DDL.ts`) a SECOND time under a
 * name no database had yet, so that machines which had logged `SESSION_STATS_SYNC_DDL`
 * under an older body would pick up what that body missed. It is gone, and re-adding
 * one for this schema is a review blocker.
 *
 * It cost every database a duplicate execution — measured: on a fresh install and on
 * a 0.99.13 upgrade alike it changed nothing, because the entry above had just done
 * the work. The only machines it could ever repair were ones that ran a body which
 * existed on a BRANCH and in no release: `SESSION_STATS_SYNC_DDL` reached `main` on
 * 2026-08-19 and no released build has ever carried it, so a 0.99.13 user has no row
 * for that name and runs the entry above from scratch.
 *
 * That makes it a repair for developer machines, and a developer's own dashboard
 * database is not the product's problem — it is one machine's derived state, fixed by
 * hand (delete the log row and reopen, or delete the file). Shipping a permanent
 * entry to every user to reconcile a laptop is the wrong layer, and it is what put
 * the same function in the list twice.
 */
