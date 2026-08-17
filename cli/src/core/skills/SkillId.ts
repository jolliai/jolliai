/**
 * The `plugin:skill` grammar every host spells the same way, parsed in one place.
 *
 * Two scanners owned independent copies of this — `ClaudeSkillScanner.pluginPrefixOf` took
 * the prefix with a `colon > 0` boundary, `CodexSkillScanner.splitNamespaced` took the
 * suffix with the mirror-image `colon <= 0` — with nothing type-checking that they agreed.
 * They had already drifted: only the Codex copy handled a TRAILING colon, which is the one
 * degenerate input that matters, because an id like `foo:` would otherwise yield an empty
 * skill name and key a registry row on the source alone (rows are keyed `<source>:<skill>`).
 *
 * What the two scanners do with the result stays theirs, and that difference is real rather
 * than drift: Claude keeps the namespace inside `skill` and uses only the `plugin` label,
 * while Codex must strip it, because its shell heuristic can only ever see a bare directory
 * name (`…/skills/documents/SKILL.md`) and one skill must not become two rows. So this
 * parses; it does not decide what to project.
 *
 * A leaf module on purpose — it imports nothing, so either scanner can use it without a
 * cycle.
 */

/** One skill id, split into its optional namespace and its bare name. */
export interface SplitSkillId {
	/** The namespace, when the id carries one that names something. */
	readonly plugin?: string;
	/** The bare skill name, or the whole id when there is no usable namespace. */
	readonly skill: string;
}

/**
 * `documents:documents` → `{ plugin: "documents", skill: "documents" }`; an unnamespaced id
 * → `{ skill: id }`.
 *
 * A colon at position 0, or one with nothing after it, yields no plugin and the id whole:
 * neither names a namespace, and both would otherwise produce an empty half. (Adopting the
 * trailing-colon rule everywhere is a deliberate, tiny change on the Claude side, where
 * `foo:` used to report `plugin: "foo"` — a label for a namespace that names no skill.)
 */
export function splitSkillId(id: string): SplitSkillId {
	const colon = id.indexOf(":");
	if (colon <= 0) return { skill: id };
	const skill = id.slice(colon + 1);
	return skill === "" ? { skill: id } : { skill, plugin: id.slice(0, colon) };
}
