import { type DbMigration, sqlMigration } from "./MigrationHelpers.js";

/**
 * Entry 6 — drops `repos_no_delete`, the BEFORE DELETE trigger the baseline
 * installed.
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
export const REPOS_DELETE_ALLOWED_DDL: DbMigration = sqlMigration(
	"REPOS_DELETE_ALLOWED_DDL",
	`
DROP TRIGGER IF EXISTS repos_no_delete;
`,
);
