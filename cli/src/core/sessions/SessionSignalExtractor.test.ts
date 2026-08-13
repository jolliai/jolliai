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
});
