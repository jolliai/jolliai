/**
 * SkillProjection — the read path that turns `plans.json.skills` into the rows an
 * IDE Context surface shows.
 *
 * It lives here rather than inside one editor's extension because BOTH IDE
 * surfaces consume it: the VS Code extension imports it directly (it bundles
 * `cli/src/**`), and the IntelliJ plugin reaches it over the `skills-active`
 * ide-bridge operation. Neither host reimplements the rule below — that is the
 * whole point of the module, and the reason it is not a private helper of
 * {@link SkillArchive}.
 *
 * **Unlike references, this MUST filter.** A reference row is deleted when its
 * commit lands, so every row in that registry is by definition uncommitted and
 * `detectReferences` can return all of them. A skill row is GUARDED instead —
 * archival leaves the row in place so a later re-entry can be detected. Returning
 * every row would put every skill ever used back on the panel as if it were fresh
 * working state.
 *
 * The predicate is {@link uncommittedDelta}, imported rather than restated. It is
 * NOT the plan/note guard check: a plan is archived once and finished, while a
 * skill can be entered again afterwards and its row keeps accumulating, so
 * "uncommitted" is the counters moving past the archived baseline. A hand-copied
 * version of that rule drifted out of sync once already and hid every re-used
 * skill from the panel.
 *
 * The delta is also what gets PROJECTED, not just what decides visibility. These
 * rows preview what the next commit will carry, and `storeSkills` archives
 * `uncommittedDelta`'s figures — so reporting the row's running total would
 * overstate a re-used skill by everything already frozen onto earlier commits.
 */

import { createLogger } from "../../Logger.js";
import type {
	SkillArchivedTotals,
	SkillEntry,
	SkillEntryPath,
	SkillOriginRoot,
	SkillSource,
	SkillUsage,
} from "../../Types.js";
import { loadPlansRegistry } from "../SessionTracker.js";
import { uncommittedDelta } from "./SkillDelta.js";

const log = createLogger("SkillProjection");

/**
 * One captured skill, projected for display.
 *
 * Structurally assignable to {@link SkillTableRow}, so the same aggregate table
 * renders live and archived rows — see that interface for why it is deliberately
 * narrower than either concrete type.
 *
 * `lastModified` mirrors `lastUsedAt` so a skill sorts against plans / notes /
 * references in one list, the same way a reference row mirrors `updatedAt`.
 */
export interface ActiveSkill {
	readonly kind: "skill";
	/** plans.json.skills map key — `<source>:<skill>`. */
	readonly mapKey: string;
	readonly source: SkillSource;
	/** Fully-qualified skill id, e.g. `superpowers:brainstorming`. */
	readonly skill: string;
	readonly plugin?: string;
	readonly entryPaths: ReadonlyArray<SkillEntryPath>;
	readonly invocationCount: number;
	readonly firstUsedAt: string;
	readonly lastUsedAt: string;
	/** Absent when the source could not attribute tokens — never rendered as a zero. */
	readonly usage?: SkillUsage;
	/** Which skill root the host loaded it from — see {@link SkillEntry.originRoot}. */
	readonly originRoot?: SkillOriginRoot;
	readonly sourcePath: string;
	/** Present when the invocation was inferred rather than observed (Codex). */
	readonly detection?: "heuristic";
	/** ISO 8601 — same as lastUsedAt, for sort consistency with the other kinds. */
	readonly lastModified: string;
}

/** Active (usage no commit has claimed) skills, newest first. */
export async function projectActiveSkills(cwd: string): Promise<ReadonlyArray<ActiveSkill>> {
	const registry = await loadPlansRegistry(cwd);
	const skills = registry.skills ?? {};

	const result: ActiveSkill[] = [];
	for (const [mapKey, entry] of Object.entries(skills)) {
		const delta = uncommittedDelta(entry);
		if (delta === undefined) continue;
		result.push(toActiveSkill(mapKey, entry, delta));
	}

	result.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
	log.info("projectActiveSkills: %d active (%d in registry)", result.length, Object.keys(skills).length);
	return result;
}

/**
 * Project one row, with the COUNTERS taken from `delta` rather than the row.
 *
 * The row accumulates for the skill's whole life; `delta` is the part no commit has
 * claimed. Those agree only until a skill is entered a second time, after which the
 * row reports work that is already committed — so the figures here would disagree
 * with the ones `storeSkills` is about to archive, and the memory preview would
 * overstate the pending commit.
 *
 * The timestamps deliberately still come from the row. `SkillArchivedTotals` carries
 * no time fields, and `storeSkills` likewise stamps its ref from `entry.firstUsedAt`
 * / `entry.lastUsedAt` — so reading them from the row is what keeps this in parity
 * with the committed record, not a leak of the same kind.
 */
function toActiveSkill(mapKey: string, entry: SkillEntry, delta: SkillArchivedTotals): ActiveSkill {
	return {
		kind: "skill",
		mapKey,
		source: entry.source,
		skill: entry.skill,
		...(entry.plugin !== undefined ? { plugin: entry.plugin } : {}),
		entryPaths: entry.entryPaths,
		invocationCount: delta.invocationCount,
		firstUsedAt: entry.firstUsedAt,
		lastUsedAt: entry.lastUsedAt,
		// Absent stays absent: a source that cannot attribute tokens must not be
		// rendered as having spent zero.
		...(delta.usage !== undefined ? { usage: delta.usage } : {}),
		...(entry.detection !== undefined ? { detection: entry.detection } : {}),
		...(entry.originRoot !== undefined ? { originRoot: entry.originRoot } : {}),
		sourcePath: entry.sourcePath,
		lastModified: entry.lastUsedAt,
	};
}
