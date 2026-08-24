import { addColumnIfMissing, type DbMigration } from "./MigrationHelpers.js";

/**
 * Entry 12 — arrived on `main` from a different branch ("Capture Cursor
 * conversations from its stop hook") while this PR was restructuring the
 * migration list into one file per entry. Its name is frozen exactly like the
 * first twelve (see `migrations/index.ts`'s `LEGACY_MIGRATION_NAMES`): it does
 * not follow the `YYYY-MM-DD-HHMM-<subject>` convention because it was written
 * without knowledge of it, and it had already reached `main` — and therefore
 * other developers' databases — before this branch could rebase onto it. Add
 * a NEW timestamped entry for any future delta; never rename this one.
 *
 * Which skill ROOT the host loaded a skill from — a different question from
 * `plugin`, and the only one some hosts can answer.
 *
 * `plugin` names WHICH plugin provides a skill and is recoverable only where the id
 * carries a namespace (`superpowers:brainstorming`) or the host reports one
 * (Claude's `attributionPlugin`). Cursor does NEITHER — measured, it does not
 * namespace plugin skills at all, and its plugin, repo and global skills are
 * distinguished only by the path they were loaded from. So `plugin` is permanently
 * NULL there, and NULL is the right answer for most of those roots: a skill under
 * `.agents/skills/` genuinely has no plugin.
 *
 * What the path DOES say is which tree supplied it, which is what this records
 * (`plugin-bundle` | `cursor-global` | `repo-agents` | `repo-cursor` |
 * `other-host` | `unknown` — see `SkillOriginRoot`). That distinction is
 * load-bearing on this host for a reason peculiar to it: the SAME skill can be
 * supplied by a plugin bundle, by `.agents/skills/`, or by the per-repo
 * `.cursor/skills/` mirror `reconcileCursorRepoSkills` writes, and the three are
 * one flat pool with no namespacing to tell them apart.
 *
 * Stored ahead of a reader, on the same rule as `entry_path` and `detection`
 * before it: it is knowable only at scan time, the transcript that proves it is
 * routinely deleted within days, and a later decision to surface it could not be
 * served retroactively.
 *
 * Deliberately NOT a derived `plugin` value. `plugin-bundle` says a plugin supplied
 * the skill but not which one; the segment after `plugins/` has been captured for
 * exactly one marketplace layout (`~/.cursor/plugins/local/<plugin>/`), and guessing
 * the general shape is how this repo has previously shipped a parser whose fixtures
 * and code were both imagined and agreed with each other and with nothing real.
 *
 * Add-column-only (SQLite has no `ADD COLUMN IF NOT EXISTS`), so — same as
 * `SKILL_PLUGIN_DDL` before it — this is a code entry rather than `sqlMigration`,
 * exempt from the fingerprint check and guarded instead by the companion test
 * beside this file.
 */
export const SKILL_ORIGIN_ROOT_DDL: DbMigration = {
	name: "SKILL_ORIGIN_ROOT_DDL",
	run: (db) => addColumnIfMissing(db, "session_tool_use", "origin_root", "TEXT"),
};
