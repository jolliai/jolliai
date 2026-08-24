import { type DbMigration, sqlMigration } from "./MigrationHelpers.js";

/**
 * Entry 2 — registers the `skill` context kind, for the same reason entry 1 is its
 * own migration: dev databases already existed with the three-kind shape by the
 * time this landed, and only an appended entry reaches those as well as fresh ones.
 *
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
export const SKILL_CONTEXT_KIND_DDL: DbMigration = sqlMigration(
	"SKILL_CONTEXT_KIND_DDL",
	`
INSERT OR IGNORE INTO context_kinds (kind) VALUES ('skill');
`,
);
