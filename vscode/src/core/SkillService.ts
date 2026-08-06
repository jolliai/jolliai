/**
 * SkillService — panel read path for captured skill usage.
 *
 * A thin delegate: the projection itself lives in the CLI, as
 * {@link projectActiveSkills}. It moved there because the IntelliJ plugin needs the
 * same rows and reaches them over the `skills-active` ide-bridge operation, and a
 * second copy of the uncommitted-delta rule is exactly what drifted out of sync
 * once already and hid every re-used skill from this panel. Read that module's
 * header for why the rows are filtered and why the counters come from the delta
 * rather than the registry row.
 *
 * The file survives so the panel keeps importing `detectSkills` under the name the
 * rest of the extension already uses.
 */

import { projectActiveSkills } from "../../../cli/src/core/skills/SkillProjection.js";
import type { SkillInfo } from "../Types.js";

/** Active (usage no commit has claimed) skills, newest first. */
export function detectSkills(cwd: string): Promise<ReadonlyArray<SkillInfo>> {
	return projectActiveSkills(cwd);
}
