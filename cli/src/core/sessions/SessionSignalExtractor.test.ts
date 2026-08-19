import { describe, expect, it } from "vitest";
import type { ToolCallCount } from "../../Types.js";
import { mergeToolCalls } from "./SessionSignalExtractor.js";

/**
 * The merge key's separator, written as an ESCAPE.
 *
 * Never the byte itself: git decides a file is binary by looking for a NUL in the
 * first 8000 bytes, so one literal control character would turn this whole test file
 * into an unreviewable diff — the same trap `KEY_SEP` documents in the module under
 * test.
 */
const NUL = "\u0000";

/** One bucket, with only the fields a case is about spelled out. */
function bucket(over: Partial<ToolCallCount> & Pick<ToolCallCount, "name">): ToolCallCount {
	return { kind: "builtin", calls: 1, ...over };
}

describe("mergeToolCalls", () => {
	it("returns nothing for no groups at all", () => {
		expect(mergeToolCalls([])).toEqual([]);
	});

	it("returns nothing when every group is empty", () => {
		// Distinct from the case above: the loop runs, the map stays empty. An
		// extractor that answered `{ tools: [] }` is what produces this.
		expect(mergeToolCalls([[], []])).toEqual([]);
	});

	it("passes a single group through, preserving order", () => {
		const group = [bucket({ name: "Bash" }), bucket({ name: "Read" })];
		expect(mergeToolCalls([group])).toEqual(group);
	});

	it("takes the LARGER count for one bucket seen twice, never the sum", () => {
		// The whole reason this is a merge rather than a tally: the skill scanner and
		// the tool reader are two VIEWS of one set of records. Summing doubled every
		// tool-entered skill call.
		const merged = mergeToolCalls([
			[bucket({ name: "code-review", kind: "skill", calls: 1 })],
			[bucket({ name: "code-review", kind: "skill", calls: 3 })],
		]);
		expect(merged).toEqual([{ name: "code-review", kind: "skill", calls: 3 }]);
	});

	it("keeps the larger count when the BIGGER one arrives first", () => {
		// `Math.max` either way — the result must not depend on which extractor ran
		// first, since the registry's order is documented as carrying no meaning.
		const merged = mergeToolCalls([
			[bucket({ name: "code-review", kind: "skill", calls: 3 })],
			[bucket({ name: "code-review", kind: "skill", calls: 1 })],
		]);
		expect(merged).toEqual([{ name: "code-review", kind: "skill", calls: 3 }]);
	});

	it("does NOT fold two kinds that share a name", () => {
		// The key is `(kind, name)`, matching `session_tool_use`'s primary key: a
		// skill and a builtin called the same thing are two different things.
		const merged = mergeToolCalls([
			[bucket({ name: "code-review", kind: "skill", calls: 2 })],
			[bucket({ name: "code-review", kind: "builtin", calls: 5 })],
		]);
		expect(merged).toEqual([
			{ name: "code-review", kind: "skill", calls: 2 },
			{ name: "code-review", kind: "builtin", calls: 5 },
		]);
	});

	it("keeps a server the FIRST side carried", () => {
		const merged = mergeToolCalls([
			[bucket({ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 1 })],
			[bucket({ name: "linear.list_issues", kind: "mcp", calls: 2 })],
		]);
		expect(merged).toEqual([{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 2 }]);
	});

	it("adopts a server only the SECOND side carried", () => {
		// Two buckets with the same (kind, name) name the same server, so it rides
		// along from whichever side has it.
		const merged = mergeToolCalls([
			[bucket({ name: "linear.list_issues", kind: "mcp", calls: 2 })],
			[bucket({ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 1 })],
		]);
		expect(merged).toEqual([{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 2 }]);
	});

	it("omits `server` entirely when neither side has one", () => {
		const merged = mergeToolCalls([[bucket({ name: "Bash" })], [bucket({ name: "Bash", calls: 4 })]]);
		expect(merged).toEqual([{ name: "Bash", kind: "builtin", calls: 4 }]);
		expect(merged[0]).not.toHaveProperty("server");
	});

	it("adopts usage from whichever side attributed it", () => {
		// Only the skill extractor attributes tokens, so in practice exactly one side
		// carries a value — and which side depends on extractor registration order,
		// which is not something a bucket should depend on.
		const usage = { input: 1, cached: 4162, output: 797, confidence: "attributed" } as const;
		const fromSecond = mergeToolCalls([
			[bucket({ name: "code-review", kind: "skill", calls: 2 })],
			[bucket({ name: "code-review", kind: "skill", calls: 1, usage })],
		]);
		const fromFirst = mergeToolCalls([
			[bucket({ name: "code-review", kind: "skill", calls: 1, usage })],
			[bucket({ name: "code-review", kind: "skill", calls: 2 })],
		]);
		expect(fromSecond).toEqual([{ name: "code-review", kind: "skill", calls: 2, usage }]);
		expect(fromFirst).toEqual(fromSecond);
	});

	it("omits `usage` entirely when neither side attributed anything", () => {
		// A merged bucket with a zeroed usage would claim the skill was measured and
		// free. Most skill buckets on a real machine come from sources that attribute
		// nothing, so this is the common path, not the edge.
		const merged = mergeToolCalls([
			[bucket({ name: "jolli-search", kind: "skill" })],
			[bucket({ name: "jolli-search", kind: "skill", calls: 3 })],
		]);
		expect(merged[0]).not.toHaveProperty("usage");
	});

	it("takes the LATER instant when both sides have one", () => {
		const merged = mergeToolCalls([
			[bucket({ name: "Bash", lastCallAtMs: 1_000 })],
			[bucket({ name: "Bash", lastCallAtMs: 5_000 })],
		]);
		expect(merged).toEqual([{ name: "Bash", kind: "builtin", calls: 1, lastCallAtMs: 5_000 }]);
	});

	it("keeps a present instant when merged with an ABSENT one", () => {
		// Absence means "this source records no timestamp", so it must not discard a
		// real one the other side found.
		const merged = mergeToolCalls([
			[bucket({ name: "Bash", lastCallAtMs: 7_000 })],
			[bucket({ name: "Bash", calls: 2 })],
		]);
		expect(merged).toEqual([{ name: "Bash", kind: "builtin", calls: 2, lastCallAtMs: 7_000 }]);
	});

	it("omits the instant when NEITHER side has one, rather than writing 0", () => {
		// A zero is a real instant in 1970 and would sort as the oldest call ever made.
		const merged = mergeToolCalls([[bucket({ name: "Bash" })], [bucket({ name: "Bash", calls: 2 })]]);
		expect(merged[0]).not.toHaveProperty("lastCallAtMs");
	});

	it("folds three groups of the same bucket down to one", () => {
		const merged = mergeToolCalls([
			[bucket({ name: "Bash", calls: 1 })],
			[bucket({ name: "Bash", calls: 9 })],
			[bucket({ name: "Bash", calls: 4 })],
		]);
		expect(merged).toEqual([{ name: "Bash", kind: "builtin", calls: 9 }]);
	});

	it("does not let a NUL in a name collide two buckets", () => {
		// The merge key joins kind and name with a NUL, chosen because no real name
		// can contain one. This pins the property rather than the separator.
		const merged = mergeToolCalls([
			[bucket({ name: `a${NUL}b`, kind: "skill" }), bucket({ name: "a", kind: "skill" })],
		]);
		expect(merged).toHaveLength(2);
	});

	/**
	 * The per-entry list, and the ORDER these arrive in is the whole point.
	 *
	 * `SESSION_SIGNAL_EXTRACTORS` runs the tool extractor first, so its bucket is the
	 * one the merge starts from — and `parseToolUse` re-attributes a `Skill` call to
	 * `input.skill`, which means both extractors produce a bucket for any skill entered
	 * by that tool. Taking the first side's list therefore dropped every per-entry
	 * record of the one path that can report an outcome. Measured before the fix: 72
	 * detail rows in a real database and not one marked observed.
	 */
	it("keeps the LONGER invocation list, whichever side it arrived on", () => {
		const entry = (at: string) => ({ at, ok: true, entryPath: "tool" as const });
		// Tool side first and shorter, mirroring production: it cannot see the
		// slash-command path, so its list is a subset rather than a second opinion.
		const merged = mergeToolCalls([
			[bucket({ name: "review", kind: "skill", calls: 2, invocations: [entry("2026-08-01T10:00:00.000Z")] })],
			[
				bucket({
					name: "review",
					kind: "skill",
					calls: 3,
					invocations: [entry("2026-08-01T10:00:00.000Z"), entry("2026-08-01T11:00:00.000Z")],
				}),
			],
		]);
		expect(merged[0].invocations).toHaveLength(2);
	});

	it("keeps a first-side invocation list when the second carries none", () => {
		const merged = mergeToolCalls([
			[
				bucket({
					name: "review",
					kind: "skill",
					calls: 1,
					invocations: [{ at: "2026-08-01T10:00:00.000Z", ok: true }],
				}),
			],
			[bucket({ name: "review", kind: "skill", calls: 1 })],
		]);
		expect(merged[0].invocations).toHaveLength(1);
	});

	it("carries the heuristic mark and the plugin from whichever side resolved one", () => {
		// Only the skill extractor resolves either, so at most one side has a value —
		// but the side it lands on is not the one the merge starts from.
		const merged = mergeToolCalls([
			[bucket({ name: "jolli-search", kind: "skill" })],
			[bucket({ name: "jolli-search", kind: "skill", detection: "heuristic", plugin: "jolli" })],
		]);
		expect(merged[0]).toMatchObject({ detection: "heuristic", plugin: "jolli" });
	});

	it("leaves all three absent when neither side has them", () => {
		// Absent must stay absent: an empty invocation list would read as "it ran zero
		// times", and a null plugin as "namespace unknown" rather than "no namespace".
		const merged = mergeToolCalls([
			[bucket({ name: "Bash" })],
			[bucket({ name: "Bash", calls: 2, lastCallAtMs: 5 })],
		]);
		expect(merged[0]).not.toHaveProperty("invocations");
		expect(merged[0]).not.toHaveProperty("detection");
		expect(merged[0]).not.toHaveProperty("plugin");
	});
});
