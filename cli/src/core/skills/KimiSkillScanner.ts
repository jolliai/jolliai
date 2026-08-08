/**
 * KimiSkillScanner — extracts skill invocations from a Moonshot Kimi Code CLI
 * transcript (`agents/main/wire.jsonl`).
 *
 * Unlike Codex (which has no skill tool and can only infer usage from a shell
 * read of a `SKILL.md`), Kimi ships a REAL `Skill` tool, so every invocation here
 * is OBSERVED, not inferred — no `detection: "heuristic"` marker. The signal is a
 * `context.append_loop_event` envelope carrying a `tool.call` whose `name` is
 * exactly `"Skill"` and whose `args.skill` names the skill:
 *
 *   tool.call:   {"type":"context.append_loop_event",
 *                 "event":{"type":"tool.call","toolCallId":"<id>","name":"Skill","args":{"skill":"<name>"}},
 *                 "time":<ms-epoch>}
 *   tool.result: {"type":"context.append_loop_event",
 *                 "event":{"type":"tool.result","toolCallId":"<id>","result":{"output":"…","isError":true?}},
 *                 "time":<ms-epoch>}
 *
 * `toolCallId` correlates a call to its result; the result's `isError` marks a
 * failed invocation (absent on success). `time` is a millisecond epoch on the
 * OUTER envelope, converted to ISO with `new Date(time).toISOString()`.
 *
 * Only `name === "Skill"` calls matter — built-in tools (Read/Bash/Glob) and MCP
 * tools (`mcp__…`) are ignored. Kimi's events are cleaner than Claude's (no
 * three-record body triple, no slash-command entry path): one pending entry per
 * `tool.call`, its `ok` upgraded when the paired `tool.result` lands, then grouped
 * one {@link SkillUse} per skill. When the scan window closes on a call whose
 * result has not landed yet, the entry is still reported (optimistic `ok: true`)
 * but the cursor is rewound to just before it — exactly as `ClaudeSkillScanner`
 * and `KimiEnvelopeParser` do — so the next pass re-reads the pair and the store's
 * fold corrects `ok` if the result ultimately says `isError`.
 */

import { createLogger } from "../../Logger.js";
import type { SkillInvocation, SkillUse } from "../../Types.js";
import type { SkillScanResult } from "./ClaudeSkillScanner.js";

const log = createLogger("KimiSkillScanner");

const LOOP_EVENT_TYPE = "context.append_loop_event";
/** The host's tool name for entering a skill. */
const SKILL_TOOL_NAME = "Skill";

/** A pending skill entry, keyed by `toolCallId`; `ok` is upgraded when its result lands. */
interface PendingSkill {
	readonly skill: string;
	readonly at: string;
	/** 1-based line the tool.call was read from — the cursor rewinds here if the result never lands. */
	readonly line: number;
	/** Its paired tool.result has been seen. Until then a window-closing entry is a fragment
	 *  carrying an optimistic `ok: true`, so the cursor is held before it for re-scan. */
	sawResult: boolean;
	ok: boolean;
}

/**
 * Scan Kimi transcript lines for skill invocations.
 *
 * `fromLine` is the 0-based resume index; lines before it are skipped. Returns
 * one {@link SkillUse} per distinct skill (invocations newest-first) and the
 * 1-based highest line consumed for the caller's cursor.
 */
export function scanKimiSkillLines(lines: ReadonlyArray<string>, fromLine: number): SkillScanResult {
	/** toolCallId → pending entry. */
	const pending = new Map<string, PendingSkill>();
	/** Preserves first-seen order of skill entries; grouping happens at assemble time. */
	const entries: PendingSkill[] = [];
	let lastLine = fromLine;
	// 1-based line of the last Skill result that paired with a pending call. The
	// cursor rewind below is scoped to unpaired calls AFTER this line, so an earlier
	// call that never gets a result (cancelled tool, killed session) cannot pin the
	// cursor forever — same scoping (and same past bug) as ClaudeEnvelopeParser.
	let lastResultLine = fromLine;

	for (let i = fromLine; i < lines.length; i++) {
		lastLine = i + 1;
		const raw = lines[i];
		if (raw.length === 0) continue;
		// Cheap pre-filter: only the loop-event envelope carries tool activity.
		if (!raw.includes(LOOP_EVENT_TYPE)) continue;

		let record: unknown;
		try {
			record = JSON.parse(raw);
		} catch {
			// A truncated last line is normal while a session is live.
			continue;
		}
		if (!isRecord(record) || record.type !== LOOP_EVENT_TYPE) continue;
		const event = record.event;
		if (!isRecord(event)) continue;

		if (event.type === "tool.call") {
			if (event.name !== SKILL_TOOL_NAME) continue;
			const args = isRecord(event.args) ? event.args : undefined;
			const skill = typeof args?.skill === "string" && args.skill.length > 0 ? args.skill : undefined;
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
			if (skill === undefined) continue;
			const entry: PendingSkill = {
				skill,
				at: isoFromTime(record.time),
				line: i + 1,
				sawResult: false,
				ok: true,
			};
			entries.push(entry);
			// Only a call carrying a toolCallId can be paired with its result; without
			// one the entry stays optimistically ok (no way to learn otherwise) and never
			// holds the cursor.
			if (toolCallId !== undefined) pending.set(toolCallId, entry);
			continue;
		}

		if (event.type === "tool.result") {
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
			if (toolCallId === undefined) continue;
			const entry = pending.get(toolCallId);
			if (entry === undefined) continue;
			const result = isRecord(event.result) ? event.result : undefined;
			entry.ok = result?.isError !== true;
			entry.sawResult = true;
			lastResultLine = i + 1; // tail boundary: a result paired at this line
		}
	}

	// Window closed mid-pair: a Skill call whose tool.result has not landed yet carries an
	// optimistic `ok: true` (failure is only knowable from the result). Hold the cursor just
	// before the earliest such call so the next pass re-reads the whole pair and the store's
	// fold upgrades the invocation in place — mirrors ClaudeSkillScanner and the safeCursor in
	// KimiEnvelopeParser. Entries with no toolCallId can never be paired, so they never pin it.
	let firstUnresolvedLine = Number.POSITIVE_INFINITY;
	for (const entry of pending.values()) {
		// Only unpaired calls in the TRAILING suffix (after the last paired result) hold
		// the cursor; an earlier abandoned call sits before `lastResultLine` and must not
		// drag it back, or it pins the cursor forever and the tail re-scans every tick.
		if (!entry.sawResult && entry.line > lastResultLine && entry.line < firstUnresolvedLine) {
			firstUnresolvedLine = entry.line;
		}
	}
	const cursorLine = firstUnresolvedLine === Number.POSITIVE_INFINITY ? lastLine : firstUnresolvedLine - 1;

	const uses = assemble(entries);
	if (uses.length > 0) log.debug("Scanned %d Kimi skill(s) from lines %d..%d", uses.length, fromLine + 1, cursorLine);
	return { uses, lastLine: Math.max(fromLine, cursorLine) };
}

/** Group entries by skill id into one {@link SkillUse} each, invocations newest-first. */
function assemble(entries: ReadonlyArray<PendingSkill>): ReadonlyArray<SkillUse> {
	const bySkill = new Map<string, SkillInvocation[]>();
	for (const entry of entries) {
		let invocations = bySkill.get(entry.skill);
		if (invocations === undefined) {
			invocations = [];
			bySkill.set(entry.skill, invocations);
		}
		invocations.push({ at: entry.at, ok: entry.ok });
	}

	const uses: SkillUse[] = [];
	for (const [skill, invocations] of bySkill) {
		// Newest-first, matching ClaudeSkillScanner.assemble.
		invocations.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
		uses.push({ source: "kimi", skill, entryPaths: ["tool"], invocations });
	}
	return uses;
}

/** Convert a millisecond-epoch `time` field to an ISO string, or "" when absent/out-of-range. */
function isoFromTime(time: unknown): string {
	if (typeof time !== "number") return "";
	const d = new Date(time);
	// A finite-but-absurd epoch (|t| > 8.64e15 ms) makes `getTime()` NaN; guarding it
	// here keeps `toISOString()` from throwing RangeError on malformed wire data.
	if (Number.isNaN(d.getTime())) return "";
	return d.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
