import type { SkillUsage, SkillUse, ToolCallCount } from "../../Types.js";

/**
 * Folds one scanned skill into the tool bucket consumed by session projection.
 *
 * `calls` is the invocation count the scanner measured, and `lastCallAtMs` comes
 * from the invocation list — NOT from the session's own clock. A session's
 * `updatedAt` moves every time the conversation is touched afterwards, so using it
 * would date a skill run from three weeks ago as today's and quietly shift it into
 * whatever window the dashboard is showing.
 *
 * Taken as the MAXIMUM over the list rather than as `invocations[0]`. Claude, Kimi
 * and OpenCode all sort newest-first, so for them the two are the same number —
 * this only stops the value depending on an ordering convention that lives in
 * three separate scanners and is not enforced anywhere.
 *
 * **The heuristic Codex path is a documented floor, not a last-call instant.**
 * `scanCodexSkillLines` records one invocation per skill at the FIRST `SKILL.md`
 * read it saw, deliberately: repeated paged reads of one use are common, so
 * counting each read would claim a skill was entered many times when it was
 * entered once. Reporting that first read is a lower bound; omitting it would
 * drop the skill out of every windowed view instead of placing it early in one.
 */
export function skillUseToToolCall(use: SkillUse, usage: SkillUsage | undefined): ToolCallCount {
	let lastCallAtMs = Number.NaN;
	for (const invocation of use.invocations) {
		const at = Date.parse(invocation.at);
		if (Number.isFinite(at) && (!Number.isFinite(lastCallAtMs) || at > lastCallAtMs)) lastCallAtMs = at;
	}
	return {
		// The skill's own name, matching what the `Skill` tool path reports, so the two
		// halves of one skill's usage fold together instead of appearing as two rows.
		name: use.skill,
		kind: "skill",
		calls: use.invocations.length,
		...(use.plugin !== undefined ? { plugin: use.plugin } : {}),
		...(use.originRoot !== undefined ? { originRoot: use.originRoot } : {}),
		...(Number.isFinite(lastCallAtMs) ? { lastCallAtMs } : {}),
		// Absent stays absent — see `ToolCallCount.usage`. A zeroed bucket would price
		// an unmeasured skill at nothing rather than reporting it as unmeasured.
		...(usage !== undefined ? { usage } : {}),
		// Forwarded rather than reduced to the count: the dashboard writes one row per
		// entry, including the mechanism and observed outcome.
		...(use.invocations.length > 0 ? { invocations: use.invocations } : {}),
		...(use.detection !== undefined ? { detection: use.detection } : {}),
	};
}
