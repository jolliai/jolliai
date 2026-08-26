/**
 * HermesSkillScanner — extracts skill invocations from Hermes `messages` rows.
 *
 * Hermes ships a REAL skill tool, so every invocation here is OBSERVED rather
 * than inferred — no `detection: "heuristic"` marker, the same standing Kimi and
 * OpenCode have and the opposite of Codex CLI's read-a-SKILL.md inference.
 *
 * The signal is an assistant row whose `tool_calls` array carries a function
 * named `skill_view`, whose `arguments` (a JSON *string*) names the skill:
 *
 *   call:    role="assistant", tool_calls=[{id, function:{name:"skill_view",
 *                                            arguments:"{\"name\":\"<skill>\"}"}}]
 *   result:  role="tool", tool_call_id=<id>, tool_name="skill_view",
 *            content="{\"success\": true, \"name\": "<skill>", …}"
 *
 * `tool_call_id` pairs the two, and the result's `success` field marks a failed
 * invocation. Both come off the same `messages` table ordered by its
 * AUTOINCREMENT `id`, so a call whose result has not landed yet is simply the
 * last row of the scan.
 *
 * ## Why the pending-call rule is `outcomeObserved`, not a cursor rewind
 *
 * The line-oriented scanners (`ClaudeSkillScanner`, `KimiSkillScanner`) rewind
 * their cursor to just before an unpaired call so the next pass re-reads the
 * pair. This scanner has no cursor to rewind: like OpenCode's it runs on the
 * polling tick over a whole 7-day window every time, so the next pass sees the
 * result whether or not anything was rewound. What it must NOT do is claim the
 * outcome was seen — hence the optimistic `ok: true` carrying
 * `outcomeObserved: false`, which is exactly what that field exists to say.
 *
 * `skill_search` and `skill_manage` are deliberately NOT counted: the first
 * lists names and the second authors a skill. Neither enters one, and counting
 * them would inflate every skill figure with calls that loaded no body.
 */

import type { SkillInvocation, SkillUse } from "../../Types.js";

/** Hermes' tool for entering a skill. Must match `HermesTranscriptReader`. */
export const HERMES_SKILL_TOOL = "skill_view";

/** One `messages` row, in the shape this scanner needs. */
export interface HermesSkillRow {
	readonly role: string;
	readonly content: string | null;
	readonly toolCallId: string | null;
	readonly toolName: string | null;
	readonly toolCalls: string | null;
	/** Epoch SECONDS (REAL), as Hermes stores it. */
	readonly timestamp: number;
}

interface Pending {
	readonly skill: string;
	readonly at: string;
	/** Always present: {@link parseSkillCall} rejects a call with no arguments string. */
	readonly args: string;
	ok: boolean;
	sawResult: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ISO of an epoch-SECONDS stamp; undefined when it is not a usable number. */
function isoFromSeconds(seconds: number): string | undefined {
	if (!Number.isFinite(seconds)) return undefined;
	return new Date(seconds * 1000).toISOString();
}

/**
 * The skill a `skill_view` call names, plus its raw arguments.
 *
 * `arguments` is a JSON STRING inside the function object. A call whose
 * arguments do not parse, or which names no skill, yields undefined and is
 * skipped — this scanner answers "which skills were entered", and a call that
 * cannot say which skill answers nothing.
 */
function parseSkillCall(raw: unknown): { skill: string; args: string; id?: string } | undefined {
	if (!isRecord(raw)) return undefined;
	const fn = isRecord(raw.function) ? raw.function : undefined;
	const name = typeof fn?.name === "string" ? fn.name : raw.name;
	if (name !== HERMES_SKILL_TOOL) return undefined;
	const rawArgs = fn?.arguments;
	if (typeof rawArgs !== "string" || rawArgs.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawArgs);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const skill = parsed.name;
	if (typeof skill !== "string" || skill.length === 0) return undefined;
	const id = typeof raw.id === "string" ? raw.id : typeof raw.call_id === "string" ? raw.call_id : undefined;
	return { skill, args: rawArgs, ...(id !== undefined ? { id } : {}) };
}

/**
 * Did this `skill_view` result report success?
 *
 * The tool returns a JSON object carrying `success`. Anything unparseable is
 * read as SUCCESS rather than failure: the pairing already proves the call ran,
 * and a parse failure is our own limitation, not evidence the skill errored.
 */
function resultOk(content: string | null): boolean {
	if (typeof content !== "string" || content.length === 0) return true;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return true;
	}
	if (!isRecord(parsed)) return true;
	return parsed.success !== false;
}

/**
 * Scan one conversation's rows for skill invocations.
 *
 * Rows must be in the table's own `id` order and belong to ONE session —
 * `tool_call_id` is unique per call, but interleaving two conversations would
 * put a result between a call and its own successor for no reason.
 *
 * Returns one {@link SkillUse} per distinct skill, invocations newest-first
 * (the order `upsertSkillEntry` stores).
 */
export function scanHermesSkillRows(rows: ReadonlyArray<HermesSkillRow>): SkillUse[] {
	/** tool_call_id → pending entry, so a result can upgrade its call's outcome. */
	const pending = new Map<string, Pending>();
	/** First-seen order; grouping happens at assemble time. */
	const entries: Array<{ skill: string; entry: Pending }> = [];

	for (const row of rows) {
		if (row.role === "assistant" && typeof row.toolCalls === "string" && row.toolCalls.length > 0) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.toolCalls);
			} catch {
				continue;
			}
			if (!Array.isArray(parsed)) continue;
			const at = isoFromSeconds(row.timestamp);
			// An undated call cannot be placed in the invocation history, which is
			// ordered by time and rendered as one — so it is skipped rather than
			// stamped with a fabricated instant.
			if (at === undefined) continue;
			for (const raw of parsed) {
				const call = parseSkillCall(raw);
				if (call === undefined) continue;
				const entry: Pending = { skill: call.skill, at, args: call.args, ok: true, sawResult: false };
				entries.push({ skill: call.skill, entry });
				// Only a call carrying an id can be paired with its result; without one
				// the entry stays optimistically ok and says so via `outcomeObserved`.
				if (call.id !== undefined) pending.set(call.id, entry);
			}
			continue;
		}

		if (row.role === "tool" && row.toolName === HERMES_SKILL_TOOL && typeof row.toolCallId === "string") {
			const entry = pending.get(row.toolCallId);
			if (entry === undefined) continue;
			entry.ok = resultOk(row.content);
			entry.sawResult = true;
		}
	}

	const bySkill = new Map<string, SkillInvocation[]>();
	for (const { skill, entry } of entries) {
		const invocations = bySkill.get(skill) ?? [];
		invocations.push({
			at: entry.at,
			args: entry.args,
			ok: entry.ok,
			outcomeObserved: entry.sawResult,
			entryPath: "tool",
		});
		bySkill.set(skill, invocations);
	}

	return [...bySkill].map(([skill, invocations]) => ({
		source: "hermes" as const,
		skill,
		// Newest-first, matching every other scanner's contract.
		invocations: [...invocations].sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1)),
		entryPaths: ["tool"] as const,
	}));
}
