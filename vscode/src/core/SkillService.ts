/**
 * SkillService — panel read path for captured skill usage.
 *
 * Reads `plans.json.skills` and projects the active rows into {@link SkillInfo}
 * for the Context list.
 *
 * **Unlike references, this MUST filter.** A reference row is deleted when its
 * commit lands, so every row in the registry is by definition uncommitted and
 * `detectReferences` can return all of them. A skill row is GUARDED instead —
 * archival leaves the row in place so a later re-entry can be detected. Returning
 * every row would put every skill ever used back on the panel as if it were fresh
 * working state.
 *
 * The predicate is {@link uncommittedDelta}, imported from the CLI rather than
 * restated here. It is NOT the plan/note guard check: a plan is archived once and
 * finished, while a skill can be entered again afterwards and its row keeps
 * accumulating, so "uncommitted" is the counters moving past the archived baseline.
 * A local copy of that rule drifted out of sync once already and hid every re-used
 * skill from this panel.
 *
 * The delta is also what gets PROJECTED, not just what decides visibility. This panel
 * previews what the next commit will carry, and `storeSkills` archives
 * `uncommittedDelta`'s figures — so showing the row's running total would overstate a
 * re-used skill by everything already frozen onto earlier commits.
 */

import { loadPlansRegistry } from "../../../cli/src/core/SessionTracker.js";
import { uncommittedDelta } from "../../../cli/src/core/skills/SkillDelta.js";
import type { SkillArchivedTotals, SkillEntry } from "../../../cli/src/Types.js";
import type { SkillInfo } from "../Types.js";
import { log } from "../util/Logger.js";

/** Active (usage no commit has claimed) skills, newest first. */
export async function detectSkills(cwd: string): Promise<ReadonlyArray<SkillInfo>> {
	const registry = await loadPlansRegistry(cwd);
	const skills = registry.skills ?? {};

	const result: SkillInfo[] = [];
	for (const [mapKey, entry] of Object.entries(skills)) {
		const delta = uncommittedDelta(entry);
		if (delta === undefined) continue;
		result.push(toSkillInfo(mapKey, entry, delta));
	}

	result.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
	log.info("skills", `detectSkills found ${result.length} active (${Object.keys(skills).length} in registry)`);
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
function toSkillInfo(mapKey: string, entry: SkillEntry, delta: SkillArchivedTotals): SkillInfo {
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
		sourcePath: entry.sourcePath,
		lastModified: entry.lastUsedAt,
	};
}
