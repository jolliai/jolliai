/**
 * SkillExtractor — skill invocations the tool reader structurally cannot see.
 *
 * ## Why this is a separate extractor and not a column of the tool one
 *
 * A skill is entered two ways, and only one of them is a tool call:
 *
 *   - **Skill tool** — a `tool_use` block named `Skill`. The tool extractor
 *     already reports these, re-attributed to the skill they launched.
 *   - **Slash command** — a user-typed `/plugin:skill`. There is no
 *     `SlashCommand` tool anywhere in the corpus; it appears as a
 *     `<command-name>` tag plus a following meta record. **No tool-call reader
 *     can see it, at any source.**
 *
 * That second path is not an edge case. Measured on one real machine: across 36
 * Claude sessions in a 7-day window there were ZERO `Skill` tool blocks and 15
 * slash-command invocations — so the tool-shaped route found none of that user's
 * skill usage, and the dashboard's Skills card was fed entirely by rows merged
 * back from already-archived commits.
 *
 * ## Overlap with the tool extractor is expected and harmless
 *
 * Both report the tool-path invocations, and `mergeToolCalls` folds them on
 * `(kind, name)`. The counts are the same measurement of the same records, so
 * folding is a merge rather than a sum of two independent tallies — see the note
 * on `calls` below, which is why this extractor reports the scanner's own
 * invocation count and not a second one derived some other way.
 *
 * ## Which agents this answers for
 *
 * Whatever `getSkillScanner` has a scanner for — claude, codex (heuristic, from
 * shell commands that read a `SKILL.md`) and kimi today. Asking the table rather
 * than restating it is what makes a new scanner reach the back-fill for free.
 *
 * OpenCode is deliberately absent even though it HAS skill discovery: its
 * implementation reads SQLite rows and persists them itself, so it is a
 * scan-and-write pipeline rather than a line scanner, and there is nothing here
 * to hand lines to. Wiring it in means giving it a pure-extraction entry point,
 * which is its own change.
 */

import { errMsg } from "../../Logger.js";
import type { TranscriptSource } from "../../Types.js";
import { attributeSkillUsage } from "../skills/SkillAttribution.js";
import { skillUseToToolCall } from "../skills/SkillToolCall.js";
import { getSkillScanner } from "../skills/SkillTranscriptScanner.js";
import { readSubagentLineGroups } from "../skills/TranscriptSkillDiscovery.js";
import type { SessionSignalExtractor, SessionSignalInput, SessionSignals } from "./SessionSignalExtractor.js";

export const skillExtractor: SessionSignalExtractor = {
	id: "skills",
	supports: (source: TranscriptSource) => getSkillScanner(source) !== undefined,
	extract: async (input: SessionSignalInput): Promise<SessionSignals> => {
		const scanner = getSkillScanner(input.source);
		if (!scanner) return {};
		const lines = await input.content.lines();
		// A source with a scanner but no line-oriented transcript reports nothing at
		// all — not an empty list. `{}` leaves the tool extractor's answer untouched;
		// `{ tools: [] }` would be a claim about a store this never opened.
		if (!lines) return {};
		try {
			// From line 0: this is a whole-conversation read, not an incremental one. The
			// back-fill has no cursor of its own here and must not touch the live
			// `discovery-cursors.json` marks — those are monotonic and owned by the hooks,
			// so advancing one from here would permanently strand the lines between the
			// old mark and the new one for the StopHook that was going to read them.
			const result = scanner.scan(lines, 0);
			if (result.uses.length === 0) return {};

			// Attribution reads the subagent files too, matching `scanSkillsFrom` exactly.
			// It is the same function over the same input on purpose: the dashboard's
			// per-skill figures and the ones the IDE panel reads out of `plans.json` have
			// to be one measurement, not two implementations that agree until they don't.
			//
			// A subagent's `attributionSkill` is inherited from its parent and never
			// updated, so a subagent's spend is invisible to attribution run over the
			// session file alone — which is why the groups are read here rather than left
			// to the caller's `content.lines()`.
			//
			// Read only once a skill was actually found: a session with no skills owes no
			// `readdir`, and most sessions have none.
			const usageBySkill = attributeSkillUsage(lines, await readSubagentLineGroups(input.transcriptPath));
			return { tools: result.uses.map((use) => skillUseToToolCall(use, usageBySkill.get(use.skill))) };
		} catch (err) {
			throw new Error(`skill extraction failed for ${input.source}/${input.sessionId}: ${errMsg(err)}`);
		}
	},
};
