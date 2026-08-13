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
import type { SkillUse, ToolCallCount, TranscriptSource } from "../../Types.js";
import { getSkillScanner } from "../skills/SkillTranscriptScanner.js";
import type { SessionSignalExtractor, SessionSignalInput, SessionSignals } from "./SessionSignalExtractor.js";

/**
 * Folds one scanned skill into a tool bucket.
 *
 * `calls` is the invocation count the scanner measured, and `lastCallAtMs` comes
 * from the invocation list — NOT from the session's own clock. A session's
 * `updatedAt` moves every time the conversation is touched afterwards, so using it
 * would date a skill run from three weeks ago as today's and quietly shift it into
 * whatever window the dashboard is showing.
 *
 * Taken as the MAXIMUM over the list rather than as `invocations[0]`. Claude, Kimi
 * and OpenCode all sort newest-first, so for them the two are the same number —
 * this only stops the value depending on an ordering convention that lives in three
 * separate scanners and is not enforced anywhere.
 *
 * **The heuristic Codex path is a documented floor, not a last-call instant.**
 * `scanCodexSkillLines` records one invocation per skill at the FIRST `SKILL.md`
 * read it saw, deliberately: 49% of real (session, skill) pairs are several paged
 * reads of one use, so counting each read would claim a skill was entered ten times
 * when it was entered once. That leaves no last-use instant in the data to recover,
 * so a Codex bucket dates from when the skill entered the picture. Reporting the
 * first read is a lower bound on a real use; the alternative — no timestamp — would
 * drop the skill out of every windowed view instead of placing it early in one.
 *
 * Invocations with an unparseable instant contribute no timestamp rather than a
 * zero: absence means "no timestamp recorded", which readers fall back on, while
 * a zero is a real instant in 1970 and would sort as the oldest call ever made.
 */
function toToolCall(use: SkillUse): ToolCallCount {
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
		...(Number.isFinite(lastCallAtMs) ? { lastCallAtMs } : {}),
	};
}

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
			return result.uses.length > 0 ? { tools: result.uses.map(toToolCall) } : {};
		} catch (err) {
			throw new Error(`skill extraction failed for ${input.source}/${input.sessionId}: ${errMsg(err)}`);
		}
	},
};
