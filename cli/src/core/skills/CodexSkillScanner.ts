/**
 * CodexSkillScanner — infers skill usage from Codex shell calls.
 *
 * Codex has NO skill tool. Its only signal is a shell call whose command string
 * happens to read a `SKILL.md`, so unlike the Claude and OpenCode scanners this one
 * is heuristic and every entry it produces says so via `detection: "heuristic"`.
 *
 * ## Codex spells a shell call two ways, and they disagree on the field name
 *
 * `function_call` (`name: "exec_command"`) carries its parameters as a JSON string
 * in `arguments`. `custom_tool_call` (`name: "exec"`) carries a JavaScript snippet
 * in `input` instead — `const r = await tools.exec_command({ cmd: "…" })`. Both are
 * a shell command the model ran, so both are the same signal here.
 *
 * The second form is now the overwhelming majority: re-measured across 41 real
 * session files, 619 `custom_tool_call` against 110 `function_call`. Reading only
 * `arguments` therefore dropped 85% of the shell calls this scanner exists to see —
 * on one machine's 7-day window, 2 of 17 (session, skill) pairs survived, and one
 * skill was never recorded at all. `TranscriptParser` had already measured the same
 * split (804 vs 415) without that reaching this file.
 *
 * That gap outlived a test named for covering it, because the test built its
 * `custom_tool_call` by string-replacing the TYPE of a `function_call` fixture and
 * left the `arguments` field in place — a shape Codex never emits. Both forms are
 * verbatim captures now, which is the only version of this test that can fail.
 *
 * Measured over 1,503 real session files before any of this was written: 976 calls
 * touch a `SKILL.md`, across 594 distinct (session, skill) pairs. Three properties
 * of that data shape the implementation:
 *
 *   - **`sed` dominates.** 532 of 549 reads of the busiest skill were
 *     `sed -n '1,220p' <path>`, not `cat`. Matching on `cat` alone would have found
 *     almost nothing, so the verb is not matched at all — only the path is.
 *   - **6% are compound commands** (`cat … | sed …`, `pwd && rg … && cat …`), so
 *     the path can appear anywhere in the string.
 *   - **49% of pairs are read more than once** (up to 10×), because one use is
 *     routinely several paged reads. See {@link scanCodexSkillLines} on why the
 *     entry count is therefore capped at one per session.
 *
 * ## Two limits that cannot be fixed by better parsing
 *
 * A human running `cat …/SKILL.md` to read a skill produces an identical record to
 * an agent consulting it. And "read" is not "used": the agent may have looked and
 * moved on. Both are properties of the signal, not of this code, which is why the
 * capture is marked heuristic rather than presented as observed.
 */

import { createLogger } from "../../Logger.js";
import type { SkillUse } from "../../Types.js";

const log = createLogger("CodexSkillScanner");

/** Cheap pre-filter — no line without this can matter. */
const NEEDLE = "SKILL.md";

/**
 * A concrete skill file path: `…/skills/<name>/SKILL.md`.
 *
 * Requiring the `skills/<name>/` segment is what rejects the real false positive
 * `rg --files -g 'SKILL.md'` — a search FOR skill files, which carries the bare
 * filename with no path in front of it. A substring test on "SKILL.md" alone counts
 * that as using a skill.
 *
 * The `[^/\s"']+` name class stops at a quote or space so a path embedded in a
 * compound shell string terminates correctly.
 */
const SKILL_PATH = /[^\s"']*\/skills(?:-[a-z]+)?\/([^/\s"']+)\/SKILL\.md/g;

/** Shell glob metacharacters. A name containing one is a pattern, not a skill id. */
const GLOB_CHARS = /[*?[\]{}]/;

export interface CodexSkillScanResult {
	readonly uses: ReadonlyArray<SkillUse>;
	/** Highest line number consumed, for the caller's cursor. 1-based. */
	readonly lastLine: number;
}

/**
 * Scan Codex transcript lines for inferred skill usage.
 *
 * **One entry per skill, regardless of how many times its file was read.** This is
 * the load-bearing modelling decision here. Codex has no entry event — only reads —
 * and a single use is routinely several paged reads: 49% of real (session, skill)
 * pairs were read more than once, up to 10 times. Counting reads would report a
 * skill "entered 10 times" when it was entered once, which is worse than not
 * counting at all. The count is capped at the only claim the data supports: this
 * session used this skill. The timestamp is the FIRST read, when the skill entered
 * the picture.
 */
export function scanCodexSkillLines(lines: ReadonlyArray<string>, fromLine: number): CodexSkillScanResult {
	/** skill → earliest timestamp seen. */
	const firstSeen = new Map<string, string>();
	let lastLine = fromLine;

	for (let i = fromLine; i < lines.length; i++) {
		lastLine = i + 1;
		const raw = lines[i];
		if (raw === undefined || !raw.includes(NEEDLE)) continue;

		let record: unknown;
		try {
			record = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!isRecord(record)) continue;

		// Codex wraps most records in a `payload`; some lines (turn_context,
		// world_state) are flat. Handle both rather than assuming the envelope.
		const payload = isRecord(record.payload) ? record.payload : record;
		if (payload.type !== "function_call" && payload.type !== "custom_tool_call") continue;

		const args = commandStringOf(payload);
		if (!args.includes(NEEDLE)) continue;

		const at = timestampOf(record, payload);
		if (at === undefined) continue;

		// The verb is deliberately not matched — `sed` outnumbers `cat` 14:1 in real
		// data, and any reader would do. The path is the whole signal.
		SKILL_PATH.lastIndex = 0;
		for (let m = SKILL_PATH.exec(args); m !== null; m = SKILL_PATH.exec(args)) {
			const name = m[1];
			if (name === "" || name === "." || name === "..") continue;
			// A glob in the name segment means the command is ENUMERATING skills, not
			// using one. Found only by running this scanner over the whole corpus:
			// `for f in .../skills/*/SKILL.md; do … done` matches the path shape
			// structurally and would otherwise be recorded as a skill literally named
			// "*". The fixtures alone did not surface it.
			if (GLOB_CHARS.test(name)) continue;
			const prior = firstSeen.get(name);
			if (prior === undefined || at < prior) firstSeen.set(name, at);
		}
	}

	const uses: SkillUse[] = [];
	for (const [skill, at] of firstSeen) {
		uses.push({
			source: "codex",
			skill,
			// No plugin: the namespace is the containing skills directory, not part of
			// the id. No usage: see the header. No bodyChars: a paged read tells us
			// nothing about what reached the model.
			entryPaths: ["tool"],
			invocations: [{ at, ok: true }],
			detection: "heuristic",
		});
	}
	if (uses.length > 0) log.debug("Inferred %d Codex skill(s) from shell reads", uses.length);
	return { uses, lastLine };
}

/**
 * The command string a shell call carries, whichever of its two field names holds it.
 *
 * `arguments` is preferred only because it is the older, JSON-shaped form; the two
 * never appear together on one record, so the order is not a precedence rule. A value
 * that is present but not a string yields `""` — the path only counts when it is in
 * the text the model actually ran, and a structured object still puts "SKILL.md" in
 * the raw line, so the needle pre-filter lets it through and this is what rejects it.
 *
 * Nothing here parses the JavaScript wrapper `custom_tool_call` uses. The path regex
 * runs over the whole string either way, and a real parse would buy nothing: the
 * signal is a substring, and a snippet this scanner cannot parse is a snippet whose
 * skill read it would rather still find.
 */
function commandStringOf(payload: Record<string, unknown>): string {
	if (typeof payload.arguments === "string") return payload.arguments;
	return typeof payload.input === "string" ? payload.input : "";
}

/** Codex timestamps live on the envelope, not the payload. */
function timestampOf(record: Record<string, unknown>, payload: Record<string, unknown>): string | undefined {
	if (typeof record.timestamp === "string") return record.timestamp;
	return typeof payload.timestamp === "string" ? payload.timestamp : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
