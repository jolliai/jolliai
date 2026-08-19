/**
 * OpenCodeSkillScanner — extracts skill invocations from OpenCode's SQLite rows.
 *
 * OpenCode is the one non-Claude host with a FIRST-CLASS skill tool, so nothing
 * here is heuristic. A `part` row with `data.type === "tool"` and
 * `data.tool === "skill"` IS an invocation. Everything below was read off a real
 * `~/.local/share/opencode/opencode.db`, and four of the differences from Claude
 * are the kind a from-memory implementation gets wrong:
 *
 *   - **The body is INLINE**, in `state.output`, wrapped in `<skill_content
 *     name="…">`. Claude puts it in a separate record keyed by tool-use id. There
 *     is nothing to correlate here.
 *   - **Timestamps are epoch milliseconds** (`state.time.start`), not ISO strings.
 *   - **Skill names are FLAT.** No `plugin:name` id exists in the corpus — the
 *     namespace lives in `state.metadata.dir`, so splitting the id on a colon
 *     would invent a plugin that the host never reported.
 *   - **The top-level `metadata` key comes and goes** across versions (present on
 *     older rows, absent on newer), so nothing may depend on it.
 *
 * ## Tokens are always an estimate here
 *
 * OpenCode records NO per-skill attribution anywhere in its schema — verified by
 * scanning every message row, zero carry any such field. So unlike Claude, whose
 * host tags each response with the owning skill, the only option is a positional
 * interval, and the result is always `confidence: "estimated"`.
 *
 * The token shape also differs, and the difference is a trap: see
 * {@link openCodeTurnSpend}.
 */

import { createLogger } from "../../Logger.js";
import type { SkillInvocation, SkillUsage, SkillUse } from "../../Types.js";

const log = createLogger("OpenCodeSkillScanner");

/** OpenCode's tool name for loading a skill. */
const SKILL_TOOL = "skill";

/** A `part` or `message` row as the reader hands it over. */
export interface OpenCodeRow {
	readonly id: string;
	/** `time_created` column — epoch milliseconds, the ordering key. */
	readonly timeCreated: number;
	/** The raw `data` column (JSON text). */
	readonly data: string;
}

export interface OpenCodeSkillScanResult {
	readonly uses: ReadonlyArray<SkillUse>;
	/**
	 * Id of the newest `part` row consumed, for the caller's cursor.
	 *
	 * Tracks EVERY row seen, not only the skill ones: a scan whose newest rows were
	 * all non-skill would otherwise never advance and would re-read them forever.
	 */
	readonly lastRowId?: string;
}

/** One turn's genuine new spend. */
export interface OpenCodeTurnSpend {
	readonly input: number;
	readonly output: number;
	readonly cached: number;
}

/**
 * Genuine new spend for one assistant message, or undefined when it carries no
 * token block.
 *
 * **Two rules, both measured rather than assumed:**
 *
 * `cache.read` is EXCLUDED because it is cumulative. Across one real session it
 * ran 0 → 25344 → 25472 → 31488 → … → 63360, so summing it re-counts the cached
 * prefix on every turn. Same property as Claude's `cache_read_input_tokens`, but
 * reached by a differently-named field.
 *
 * **`tokens.total` is NEVER used.** It equals the sum of every component
 * *including* `cache.read` (31728 = 89 + 47 + 104 + 0 + 31488 in the pinned
 * fixture), so the obvious "just read the total" shortcut inherits the same
 * inflation while looking authoritative.
 *
 * `reasoning` folds into `output` because it bills at the output rate, and
 * `cache.write` maps to Claude's `cache_creation` — newly written cache IS new
 * work.
 */
export function openCodeTurnSpend(messageData: unknown): OpenCodeTurnSpend | undefined {
	if (!isRecord(messageData)) return undefined;
	const tokens = messageData.tokens;
	if (!isRecord(tokens)) return undefined;
	const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
	return {
		input: num(tokens.input),
		output: num(tokens.output) + num(tokens.reasoning),
		cached: num(cache?.write),
	};
}

/**
 * Scan `part` rows for skill invocations, attributing spend from `message` rows.
 *
 * Both lists must be ordered by `time_created` ascending — the interval
 * attribution is positional, and the caller's query is what establishes that
 * order.
 */
export function scanOpenCodeSkillRows(
	partRows: ReadonlyArray<OpenCodeRow>,
	messageRows: ReadonlyArray<OpenCodeRow>,
): OpenCodeSkillScanResult {
	/**
	 * Entry events in row order, each opening an attribution interval.
	 *
	 * `orderAt` and the invocation's own `at` come from DIFFERENT clocks on purpose.
	 * `orderAt` is the row's `time_created`, which is what `message` rows also carry,
	 * so interval comparison stays within one clock. The invocation timestamp is
	 * `state.time.start` — the actual event moment, and the value the store dedupes
	 * on. Measured on real rows the two differ by tens of milliseconds, which is
	 * enough to put a turn on the wrong side of a boundary if they are mixed.
	 */
	const entries: Array<{ skill: string; orderAt: number; invocation: SkillInvocation }> = [];
	let lastRowId: string | undefined;

	for (const row of partRows) {
		lastRowId = row.id;
		let data: unknown;
		try {
			data = JSON.parse(row.data);
		} catch {
			continue;
		}
		if (!isRecord(data) || data.type !== "tool" || data.tool !== SKILL_TOOL) continue;

		const state = isRecord(data.state) ? data.state : undefined;
		const status = typeof state?.status === "string" ? state.status : "";
		// A call still in flight has no output yet; recording it would report a body
		// size of zero for a skill that may still be loading.
		if (status !== "completed" && status !== "error") continue;

		const name = skillNameOf(state);
		if (name === undefined) continue;

		const output = typeof state?.output === "string" ? state.output : undefined;
		// `state.time.start` is the authoritative moment. The row's own `time_created`
		// differs by tens of milliseconds and is a storage timestamp, not an event one.
		const time = isRecord(state?.time) ? state.time : undefined;
		const at = typeof time?.start === "number" ? time.start : row.timeCreated;

		entries.push({
			skill: name,
			orderAt: row.timeCreated,
			invocation: {
				at: new Date(at).toISOString(),
				...(output !== undefined ? { bodyChars: output.length } : {}),
				// A reading, not a default: `state.status` distinguishes `completed` from
				// `error`, which is why the `tool` stamp below resolves to observed.
				ok: status === "completed",
				entryPath: "tool",
			},
		});
	}

	// Resolved once: `lastRowId` is unset only when there were no part rows at all, so
	// re-testing it at the second return would be a branch that arm can never take.
	const cursor = lastRowId !== undefined ? { lastRowId } : {};

	if (entries.length === 0) return { uses: [], ...cursor };

	const spendBySkill = attributeByInterval(entries, messageRows);

	const bySkill = new Map<string, SkillInvocation[]>();
	for (const entry of entries) {
		const list = bySkill.get(entry.skill);
		if (list === undefined) bySkill.set(entry.skill, [entry.invocation]);
		else list.push(entry.invocation);
	}

	const uses: SkillUse[] = [];
	for (const [skill, invocations] of bySkill) {
		invocations.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
		const spend = spendBySkill.get(skill);
		uses.push({
			source: "opencode",
			skill,
			// No plugin: OpenCode ids are flat. See the header.
			entryPaths: ["tool"],
			invocations,
			...(spend !== undefined ? { usage: spend } : {}),
		});
	}

	log.debug("Scanned %d OpenCode skill(s) from %d part row(s)", uses.length, partRows.length);
	return { uses, ...cursor };
}

/**
 * Sum each skill's following turns, bounded by the next skill entry or the next
 * user turn.
 *
 * The user-turn bound matters for the same reason it does on Claude's fallback
 * path: nothing marks a skill as finished, so an unbounded interval would
 * attribute the remainder of the session to whichever skill ran last.
 */
function attributeByInterval(
	entries: ReadonlyArray<{ skill: string; orderAt: number }>,
	messageRows: ReadonlyArray<OpenCodeRow>,
): Map<string, SkillUsage> {
	const totals = new Map<string, { input: number; output: number; cached: number }>();

	for (const [index, entry] of entries.entries()) {
		const nextEntryAt = entries[index + 1]?.orderAt ?? Number.POSITIVE_INFINITY;
		let bound = nextEntryAt;

		// First user turn after this entry also closes the interval.
		for (const row of messageRows) {
			if (row.timeCreated <= entry.orderAt || row.timeCreated >= bound) continue;
			let data: unknown;
			try {
				data = JSON.parse(row.data);
			} catch {
				continue;
			}
			if (isRecord(data) && data.role === "user") bound = row.timeCreated;
		}

		for (const row of messageRows) {
			if (row.timeCreated <= entry.orderAt || row.timeCreated >= bound) continue;
			let data: unknown;
			try {
				data = JSON.parse(row.data);
			} catch {
				continue;
			}
			const spend = openCodeTurnSpend(data);
			if (spend === undefined) continue;
			const total = totals.get(entry.skill) ?? { input: 0, output: 0, cached: 0 };
			total.input += spend.input;
			total.output += spend.output;
			total.cached += spend.cached;
			totals.set(entry.skill, total);
		}
	}

	const out = new Map<string, SkillUsage>();
	// Always "estimated": OpenCode records no per-skill attribution at all, so this
	// can never be upgraded to "attributed" by better parsing.
	for (const [skill, total] of totals) out.set(skill, { ...total, confidence: "estimated" });
	return out;
}

/** Resolved skill name: `state.metadata.name` is authoritative, `state.input.name` is the request. */
function skillNameOf(state: Record<string, unknown> | undefined): string | undefined {
	const metadata = isRecord(state?.metadata) ? state.metadata : undefined;
	if (typeof metadata?.name === "string" && metadata.name !== "") return metadata.name;
	const input = isRecord(state?.input) ? state.input : undefined;
	return typeof input?.name === "string" && input.name !== "" ? input.name : undefined;
}

function num(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
