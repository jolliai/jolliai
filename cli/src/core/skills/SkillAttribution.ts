/**
 * SkillAttribution — how many tokens were spent under each skill.
 *
 * Two paths, and which one runs is decided by the data rather than configured:
 *
 *   **Attributed (preferred).** Assistant records carry `attributionSkill` and
 *   `attributionPlugin` at the TOP LEVEL of the record — the host has already
 *   done the attribution for us. Grouping deduped usage by that field is *more*
 *   accurate than any positional window, because it correctly excludes turns
 *   that fall between skills. Measured on a real session: 14 unattributed
 *   messages were interleaved throughout, not bunched before the first skill, so
 *   a "first Skill call → next Skill call" window would have swallowed them.
 *
 *   **Estimated (fallback).** Hosts below ~2.1.181 emit no attribution fields.
 *   There, spend is summed from the record AFTER a `Skill` tool_use up to the
 *   next skill entry or the next user turn, whichever comes first. Without this
 *   every skill on an older transcript would silently report zero.
 *
 * The fallback is chosen only when the transcript carries NO attribution
 * anywhere. A single attributed turn switches the whole scan to the attributed
 * path: mixing the two would put two different confidence levels inside one
 * number, and `SkillUsage.confidence` is user-visible precisely so that never
 * has to be guessed at.
 *
 * ## Two counting rules, both load-bearing — and both defined elsewhere
 *
 * **Dedupe on `message.id`.** One API response is written as several JSONL lines,
 * each repeating the entire `usage` object byte-identically while carrying its own
 * timestamp. Measured inflation across 1,966 real transcripts: median 2.13x, up
 * to 6.92x. A line with no `message.id` always counts — it cannot be deduped, so
 * dropping it would lose real spend.
 *
 * **Never sum `cache_read_input_tokens`.** It is a per-turn CUMULATIVE running
 * total, so adding it across a slice re-counts the cached prefix on every turn and
 * inflates the result by an order of magnitude. Genuine new spend is
 * `input_tokens + cache_creation_input_tokens + output_tokens`.
 *
 * Neither rule is implemented here. Both come from
 * {@link extractClaudeUsageFromRecord}, which is also what the commit-level reader
 * and the per-model split use — so a per-skill total cannot drift from the commit
 * total for the same transcript. `SkillAttribution.test.ts` pins that agreement
 * directly rather than trusting the two to stay in step by inspection.
 *
 * ## Two limitations that are documented, not fixed
 *
 * Both are properties of the transcript, not of this code:
 *
 *   - **Nested skills flatten.** `attributionSkill` is a scalar that is REPLACED,
 *     never pushed. When an outer skill invokes an inner one, records after the
 *     inner call read the inner id and the outer frame is never restored, so the
 *     outer skill's remaining tokens are billed to the inner one. There is no
 *     stack in the data to recover.
 *   - **Attribution is turn-scoped.** It clears on the next user prompt, so a
 *     skill's segment ends at a user turn rather than at skill completion.
 */

import { createLogger } from "../../Logger.js";
import type { SkillUsage } from "../../Types.js";
import { extractClaudeUsageFromRecord } from "../TranscriptParser.js";

const log = createLogger("SkillAttribution");

const SKILL_TOOL_NAME = "Skill";

/** Cheap pre-filter — every line this module cares about carries one of these. */
const LINE_NEEDLES = ['"usage"', '"name":"Skill"', '"role":"user"', '"type":"user"'];

/** One response's spend, plus the identity used to collapse its repeated lines. */
interface TurnUsage {
	readonly dedupKey?: string;
	readonly skill?: string;
	readonly input: number;
	readonly cached: number;
	readonly output: number;
}

/**
 * Tokens spent under each skill, keyed by skill id.
 *
 * `sessionLines` is the main transcript; `subagentLineGroups` are its
 * `agent-*.jsonl` files. Subagent spend is billed to the skill named in the
 * subagent's own records — that field is inherited from the parent and never
 * updated, which is exactly the right answer here: a subagent dispatched under a
 * skill is part of that skill's cost. Measured on real data, including subagent
 * files moved one skill's cache_creation from 21k to 199k, so omitting them does
 * not make the number conservative — it makes it wrong.
 *
 * Only the main transcript feeds the interval fallback: subagent files are a
 * separate line sequence, so a positional window across the concatenation would
 * be meaningless. Older hosts predate the subagent layout anyway.
 */
export function attributeSkillUsage(
	sessionLines: ReadonlyArray<string>,
	subagentLineGroups: ReadonlyArray<ReadonlyArray<string>> = [],
): ReadonlyMap<string, SkillUsage> {
	const sessionTurns = parseTurns(sessionLines);
	const subagentTurns = subagentLineGroups.flatMap((lines) => parseTurns(lines));
	const allTurns = [...sessionTurns, ...subagentTurns];

	const anyAttributed = allTurns.some((turn) => turn.skill !== undefined);
	if (anyAttributed) return groupByAttribution(allTurns);

	// No attribution anywhere — an older host. Intervals are all we have.
	const estimated = estimateByInterval(sessionLines);
	if (estimated.size > 0) log.debug("Attribution absent; estimated usage for %d skill(s)", estimated.size);
	return estimated;
}

/**
 * Parse every usage-bearing line into a {@link TurnUsage}.
 *
 * Deduplication happens later, not here: a caller needs to know whether ANY line
 * was attributed before it can choose a path, and that question is asked over all
 * lines.
 */
function parseTurns(lines: ReadonlyArray<string>): TurnUsage[] {
	const turns: TurnUsage[] = [];
	for (const line of lines) {
		if (line.length === 0 || !line.includes('"usage"')) continue;
		const turn = parseTurnUsage(line);
		if (turn !== undefined) turns.push(turn);
	}
	return turns;
}

/** One line's usage, or undefined when the line carries none. */
function parseTurnUsage(line: string): TurnUsage | undefined {
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(record)) return undefined;

	// Counters AND dedupe identity both come from the shared extractor, so per-skill
	// numbers cannot drift from the commit total. The record-level overload exists
	// precisely so this path does not have to re-parse the line.
	const usage = extractClaudeUsageFromRecord(record);
	if (usage === null) return undefined;

	// The only skills-specific field. `attributionSkill` sits at the TOP level of the
	// record, not inside `message` — that is what makes the host's own attribution
	// reusable here at all.
	const skill = typeof record.attributionSkill === "string" ? record.attributionSkill : undefined;

	return {
		// An empty id means the line carries no response identity, so it must always
		// count; representing that as `undefined` keeps the check at the use site
		// honest rather than deduping every such line onto one another.
		...(usage.id !== "" ? { dedupKey: usage.id } : {}),
		...(skill !== undefined ? { skill } : {}),
		input: usage.input,
		cached: usage.cached,
		output: usage.output,
	};
}

/** Sum deduped turns per `attributionSkill`, dropping unattributed spend. */
function groupByAttribution(turns: ReadonlyArray<TurnUsage>): ReadonlyMap<string, SkillUsage> {
	const totals = new Map<string, { input: number; cached: number; output: number }>();
	for (const turn of dedupe(turns)) {
		// Unattributed spend belongs to no skill. Folding it into a neighbour is the
		// error the attributed path exists to avoid.
		if (turn.skill === undefined) continue;
		const total = totals.get(turn.skill) ?? { input: 0, cached: 0, output: 0 };
		total.input += turn.input;
		total.cached += turn.cached;
		total.output += turn.output;
		totals.set(turn.skill, total);
	}
	return finalize(totals, "attributed");
}

/**
 * Sum spend positionally: from the record AFTER a `Skill` tool_use up to the next
 * skill entry or the next user turn.
 *
 * The calling response is excluded deliberately. A skill body's injection cost
 * lands as `cache_creation_input_tokens` on the NEXT response, not on the one that
 * called it — and 7% of Skill calls share their response with other tools, so
 * including it would bill unrelated work to the skill.
 */
function estimateByInterval(lines: ReadonlyArray<string>): ReadonlyMap<string, SkillUsage> {
	const totals = new Map<string, { input: number; cached: number; output: number }>();
	const counted = new Set<string>();
	let openSkill: string | undefined;

	for (const line of lines) {
		if (line.length === 0 || !LINE_NEEDLES.some((needle) => line.includes(needle))) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(record)) continue;

		const entered = skillEntryOf(record);
		if (entered !== undefined) {
			// A new entry closes the previous interval — nested or sequential alike.
			openSkill = entered;
			continue;
		}

		const turn = parseTurnUsage(line);
		if (turn !== undefined) {
			if (openSkill !== undefined && !(turn.dedupKey !== undefined && counted.has(turn.dedupKey))) {
				if (turn.dedupKey !== undefined) counted.add(turn.dedupKey);
				const total = totals.get(openSkill) ?? { input: 0, cached: 0, output: 0 };
				total.input += turn.input;
				total.cached += turn.cached;
				total.output += turn.output;
				totals.set(openSkill, total);
			}
			continue;
		}

		// A user turn clears attribution on the host side, so it bounds the interval.
		// Without this bound an interval would run to the end of the transcript.
		if (isUserTurn(record)) openSkill = undefined;
	}

	return finalize(totals, "estimated");
}

/** The skill id a record enters via the `Skill` tool, or undefined. */
function skillEntryOf(record: Record<string, unknown>): string | undefined {
	const message = isRecord(record.message) ? record.message : undefined;
	const content = message?.content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (!isRecord(block) || block.type !== "tool_use" || block.name !== SKILL_TOOL_NAME) continue;
		const input = isRecord(block.input) ? block.input : undefined;
		if (typeof input?.skill === "string") return input.skill;
	}
	return undefined;
}

function isUserTurn(record: Record<string, unknown>): boolean {
	if (record.type !== "user") return false;
	// Tool results and injected bodies are `type: "user"` too but are not prompts;
	// treating them as interval bounds would cut every interval at its own body.
	if (record.isMeta === true) return false;
	const content = isRecord(record.message) ? record.message.content : undefined;
	if (Array.isArray(content)) return !content.some((b) => isRecord(b) && b.type === "tool_result");
	return true;
}

/** Collapse lines that repeat one response's usage. A turn with no id always counts. */
function dedupe(turns: ReadonlyArray<TurnUsage>): TurnUsage[] {
	const seen = new Set<string>();
	const out: TurnUsage[] = [];
	for (const turn of turns) {
		if (turn.dedupKey !== undefined) {
			if (seen.has(turn.dedupKey)) continue;
			seen.add(turn.dedupKey);
		}
		out.push(turn);
	}
	return out;
}

function finalize(
	totals: ReadonlyMap<string, { input: number; cached: number; output: number }>,
	confidence: SkillUsage["confidence"],
): ReadonlyMap<string, SkillUsage> {
	const out = new Map<string, SkillUsage>();
	for (const [skill, total] of totals) out.set(skill, { ...total, confidence });
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
