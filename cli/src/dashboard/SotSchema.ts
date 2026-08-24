/**
 * Historical design notes for the dashboard schema, plus the two exports every
 * migration still needs: {@link REORDER_OFFSET} and {@link SOT_INSPECTION_QUERIES}.
 *
 * This module used to hold every live `CREATE TABLE` in the product — "the whole
 * schema, the single place every table is defined" — and that claim is why it
 * existed at all: the DDL used to live inline in `../dashboard/DashboardDb.ts`'s
 * `MIGRATIONS`, which meant the pages, the producers and the recovery path could
 * each grow their own idea of a table. Collecting it here fixed that. It no longer
 * holds any of it: every table's DDL moved into the migration entry that FIRST
 * created it, under `migrations/`, so "what does this table look like" and "how did
 * it get that way" are answered by the same file instead of two. See
 * `migrations/index.ts` for the list and the per-entry files for the DDL and the
 * design rationale that used to live here.
 *
 * What is left is: `REORDER_OFFSET` and `SOT_INSPECTION_QUERIES`, which every
 * migration (and `jolli doctor`) still needs a shared home for; and a run of
 * historical notes under names that no longer back a live export — `EVENT_FAILED_KIND_DDL`,
 * `TOOL_CALL_TIME_DDL`, `SKILL_TOKEN_USAGE_DDL`, `SKILL_PLUGIN_DDL`, `SKILL_ORIGIN_ROOT_DDL`,
 * `SYNC_STAMP_DDL` and `STATS_DAILY_DDL` — kept as design notes for columns whose live definition is
 * now a code entry in `migrations/`, for the same reason the memory half of this
 * file was worth centralizing in the first place: the reasoning survives the
 * refactor that moved the SQL.
 *
 * Three properties that governed the (now-moved) memory tables are worth restating
 * here because they are still true of them and still easy to undo by accident:
 *
 * 1. **No triggers.** Constraints a foreign key can express are foreign keys;
 *    everything else is the write module's job plus the inspection queries in
 *    {@link SOT_INSPECTION_QUERIES}. The previous version carried nine triggers
 *    (revision monotonicity, pointer validation, two FTS mirrors, cascade
 *    emulation); each one hid a business rule in the schema, needed a migration
 *    to change, and had an execution order that had to be reasoned about. The
 *    one exception, `repos_no_delete`, has since been dropped by
 *    `REPOS_DELETE_ALLOWED_DDL` — so the rule now holds without exception.
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

/*
 * `ACTIVITY_DDL` — NO LONGER A CONSTANT. Its tables (schema_meta, repos, sessions,
 * session_model_usage, session_tool_use, commits, branches, commit_branches,
 * commit_files, worktree_status, events_raw, ingest_cursors, plus the parked
 * repo_graphs comment) and the `commit_branches` design note (what it holds today,
 * why the reachability union was removed, why both tables survive with a
 * degenerate use) now live in `migrations/2026-08-12-0000-baseline.ts`, inlined
 * into `BASELINE_DDL` alongside the memory tables that used to be `MEMORY_SOT_DDL`
 * — see that file, and see AGENTS.md for why the DDL moved out of this module.
 */

/*
 * `RECALL_RECEIPTS_DDL` and `SKILL_CONTEXT_KIND_DDL` — NO LONGER CONSTANTS. Each
 * moved into its own migration file with its full design note intact:
 * `migrations/2026-08-12-0001-recall-receipts.ts` (why a receipt is written where
 * the answer is produced rather than recovered from a transcript) and
 * `migrations/2026-08-12-0002-skill-context-kind.ts` (why `skill` is its own
 * append-only migration rather than an edit to `BASELINE_DDL`'s `INSERT`).
 */

/*
 * `EVENT_FAILED_KIND_DDL` — historical as a CONSTANT (see the end of this block),
 * current as the design notes for a live column.
 *
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
 *
 * ⚠ NO LONGER A CONSTANT. The entry of this name is a code entry calling
 * `addColumnIfMissing(db, "events_raw", "failed_kind", "TEXT")` — SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, and every entry has to survive being run twice. The
 * `ALTER` text was kept beside it for a while on the grounds that tests built "a
 * database at that point in history" from it. They do not, and had stopped before
 * this was written: a fixture is built by replaying `MIGRATIONS[0..slot]`, which
 * cannot drift from what production runs, where a hand-kept copy of the old bytes
 * can. So the string was dead code with a stale justification, and it now lives
 * only in this file's git history. What still matters is above — these notes must
 * keep describing the same column that `addColumnIfMissing` call creates.
 */

/*
 * `TOOL_CALL_TIME_DDL` — historical as a CONSTANT (see the end of this block),
 * current as the design notes for a live column.
 *
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
 *
 * ⚠ NO LONGER A CONSTANT — same as `EVENT_FAILED_KIND_DDL` above, including why the
 * fixture argument that used to keep the text here does not hold. The entry of this
 * name is a code entry calling
 * `addColumnIfMissing(db, "session_tool_use", "last_call_at_ms", "INTEGER")`.
 */

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
 * now opened and written normally, with `verifyMigrationLog`'s unknown-NAME
 * warning standing in for the old per-process warn-once line (see the
 * compatibility note at the top of `DashboardDb.ts`). The conclusion is
 * unchanged on the two reasons above, which never depended on it.
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

/*
 * `SESSION_USAGE_EVENTS_DDL` — NO LONGER A CONSTANT. Its table, its design note
 * (why `sessions` cannot answer "how much did I spend on the 1st", why it is keyed
 * on the response's own identity, why every column is an instant rather than a
 * local day) now lives in `migrations/2026-08-18-0000-session-stats-sync.ts`, as
 * one of the constants `applySessionStatsSchema` executes.
 */

/*
 * `SYNC_STAMP_DDL` — NO LONGER A CONSTANT, and nothing went with it.
 *
 * Every statement it held still has exactly one live definition: its four `ALTER`s
 * go through `addColumnIfMissing` in `applySessionStatsSchema` (SQLite has no
 * `ADD COLUMN IF NOT EXISTS`) and its `UPDATE`s live on verbatim as
 * `SYNC_STAMP_ZERO_BACKFILL_DDL`, whose docblock now also carries the `COALESCE`
 * rationale that used to be an inline comment here.
 *
 * The rule the dozen comments elsewhere cite this name for — a sync stamp is
 * bumped on every write and never means anything else — is the floating block
 * ABOVE, which is where those references actually want to land; the name is kept
 * here so a grep for it still arrives somewhere useful. The old bytes are in this
 * file's git history, and a database that applied them has them on record in its
 * own `schema_migrations.ddl` — readable with `sqlite3` when a real question
 * arises, though nothing compares it automatically any more (see the note at the
 * end of `verifyMigrationLog`). Nothing read the constant.
 */

/*
 * `SCHEMA_MIGRATIONS_DDL` and `REPOS_DELETE_ALLOWED_DDL` — NO LONGER CONSTANTS.
 * The migration-log table's own design note (why a LOG rather than a set of
 * booleans, what each column stops, why `ddl` stores full text over a hash) now
 * lives in `migrations/2026-08-12-0005-schema-migrations.ts`; the trigger-drop
 * entry and its "what still protects a repo's memories" note now live in
 * `migrations/2026-08-14-0000-repos-delete-allowed.ts`.
 */

/*
 * `SESSION_ACTIVITY_DDL` — NO LONGER A CONSTANT. Its table and its full design
 * note (why it is INSERT-ONLY unlike its siblings, why `recorded_at_ms` is a sync
 * cursor and not a business time) now live in
 * `migrations/2026-08-19-0000-session-activity.ts`.
 */

/*
 * `SKILL_TOKEN_USAGE_DDL` — historical as a CONSTANT (see the end of this block),
 * current as the design notes for four live columns.
 *
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
 *
 * ⚠ NO LONGER A CONSTANT — same as `EVENT_FAILED_KIND_DDL` above. The entry of this
 * name is a code entry adding `input_tokens`, `output_tokens`, `cached_tokens` and
 * `usage_confidence` through `addColumnIfMissing`; the four move together, so the
 * NULLABLE-with-no-DEFAULT rule above applies to all four or to none.
 */

/*
 * `SKILL_INVOCATIONS_DDL` — NO LONGER A CONSTANT. Its table and its full design
 * note (why the key is (session, skill, instant), why the foreign key points at
 * `sessions` and not `session_tool_use`, why rows are never deleted with the
 * aggregate) now live in `migrations/2026-08-19-0002-skill-invocations.ts`.
 */

/*
 * `SKILL_PLUGIN_DDL` — historical as a CONSTANT (see the end of this block), current
 * as the design notes for a live column.
 *
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
 *
 * ⚠ NO LONGER A CONSTANT — same as \`EVENT_FAILED_KIND_DDL\` above. The entry of this
 * name is a code entry calling
 * \`addColumnIfMissing(db, "session_tool_use", "plugin", "TEXT")\`.
 */

/*
 * `SKILL_ORIGIN_ROOT_DDL` — historical as a CONSTANT (see the end of this block),
 * current as the design notes for a live column.
 *
 * Which skill ROOT the host loaded a skill from — a different question from
 * `plugin` (see the note above), and the only one some hosts can answer. Cursor
 * does not namespace plugin skills at all, so `plugin` is permanently NULL there
 * while the load path (plugin bundle, `.agents/skills/`, or the per-repo
 * `.cursor/skills/` mirror) still tells three otherwise-identical copies of the
 * same skill apart.
 *
 * ⚠ NO LONGER A CONSTANT — same as `EVENT_FAILED_KIND_DDL` above. The entry of this
 * name is a code entry calling
 * `addColumnIfMissing(db, "session_tool_use", "origin_root", "TEXT")`; see
 * `migrations/2026-08-20-0000-skill-origin-root.ts` for the full design note.
 */

/*
 * `MEMORY_SOT_DDL` — NO LONGER A CONSTANT. Its tables (repo_state, memories,
 * memory_topics, commit_aliases, transcripts, memory_transcripts,
 * transcript_sessions, context_kinds, context, plan_progress, topic_pages,
 * topic_source_refs, topic_processed_sources) and the design notes above them —
 * why there are no triggers, why STORED generated columns are TEXT only, why
 * `children[]` is edges plus position rather than nested copies — now live in
 * `migrations/2026-08-12-0000-baseline.ts`, inlined into `BASELINE_DDL` right
 * alongside the tables that used to be `ACTIVITY_DDL`.
 */

/*
 * `STATS_DAILY_DDL` — NO LONGER A CONSTANT.
 *
 * Its leading `ALTER` goes through `addColumnIfMissing` in `applySessionStatsSchema`
 * and the rest lives on as `STATS_DAILY_TABLE_DDL`, whose docblock now carries the
 * per-column reasoning this string used to be the only home for. Those notes
 * describe a LIVE table, so they belong on its live definition rather than under a
 * historical heading. (`STATS_DAILY_TABLE_DDL` has itself since moved out of this
 * file too — see the note below — but the pointer stands: wherever it lives, that
 * is where the per-column reasoning lives with it.)
 *
 * Two decisions it recorded, kept here because neither is re-derivable from the SQL:
 *
 *  - The `CREATE TABLE` is `IF NOT EXISTS` because an earlier, unreleased build of
 *    this branch had already created the table on some machines (a developer's own
 *    among them) under a migration name their log has no row for. Without the guard
 *    such a database re-runs the entry, dies on "table stats_daily already exists",
 *    and every open after that fails until `doctor --mark-migration` is run by hand.
 *  - The `ALTER` could not be guarded the same way — SQLite has no
 *    `ADD COLUMN IF NOT EXISTS` — so a database that also already had that column
 *    still needed that repair, which is precisely the state `doctor
 *    --mark-migration` documents itself as existing for. The two statements were
 *    deliberately NOT split into separate entries to make each independently
 *    markable: the split would leave a machine that had ALREADY applied this entry
 *    under this name re-running the `ALTER` from a new slot, turning a repair anyone
 *    can do into a failure everyone gets.
 *
 * The old bytes are in this file's git history, and any database that applied them
 * has them on record in its own `schema_migrations.ddl`.
 */

/*
 * `SYNC_STAMP_INDEX_DDL`, `SYNC_KEYSET_INDEX_DDL`, `SYNC_STAMP_NULL_BACKFILL_DDL`,
 * `STATS_DAILY_TABLE_DDL` and `STATS_DAILY_DAY_INDEX_DDL` — NO LONGER CONSTANTS.
 * All five, and their design notes (why each needed its own entry rather than an
 * edit to an already-applied one, why `stats_daily.updated_at_ms` is not a sync
 * stamp despite the name, why a NULL sync-stamp is a correctness bug and not a
 * style nit), now live in `migrations/2026-08-18-0000-session-stats-sync.ts`,
 * alongside `SYNC_STAMP_ZERO_BACKFILL_DDL` below and the `applySessionStatsSchema`
 * function that runs all of them. `STATS_DAILY_DDL`'s own historical note (just
 * above) still describes a real decision this build honors, so it stays — only
 * its "the rest lives on as `STATS_DAILY_TABLE_DDL`" pointer is now stale in
 * spirit: that live definition is not in this file any more either.
 *
 * The "Statement subsets" guidance that used to introduce this block — reach for
 * `sqlMigration` unless an `ALTER` forces a code entry, and never keep an
 * already-applied constant around just to dodge the fingerprint check — is now
 * `migrations/MigrationHelpers.ts`'s job to carry, since every entry (SQL or code)
 * lives beside that guidance instead of beside a constant only some of them used.
 */

/*
 * `SYNC_STAMP_ZERO_BACKFILL_DDL` — NO LONGER A CONSTANT. Its statements and design
 * note (paired with, never instead of, the NULL backfill above; why both
 * `COALESCE`s are load-bearing) now live alongside it in
 * `migrations/2026-08-18-0000-session-stats-sync.ts`.
 */

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
