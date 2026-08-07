import { describe, expect, it } from "vitest";
import { kimiEnvelopeParser } from "./KimiEnvelopeParser.js";

/** ISO conversion mirrors the parser's own `new Date(time).toISOString()`. */
const iso = (ms: number) => new Date(ms).toISOString();

/** A `context.append_loop_event` wrapping a `tool.call`. */
function toolCall(toolCallId: string, name: string, args: Record<string, unknown>, time: number): string {
	return JSON.stringify({
		type: "context.append_loop_event",
		event: { type: "tool.call", toolCallId, name, args },
		time,
	});
}

/**
 * A `context.append_loop_event` wrapping a `tool.result`. `output` is a JSON
 * STRING (Kimi serialises the MCP payload as a string), matching the real wire.
 */
function toolResult(toolCallId: string, output: unknown, time: number, isError?: boolean): string {
	return JSON.stringify({
		type: "context.append_loop_event",
		event: {
			type: "tool.result",
			toolCallId,
			result: {
				output: typeof output === "string" ? output : JSON.stringify(output),
				...(isError ? { isError } : {}),
			},
		},
		time,
	});
}

describe("KimiEnvelopeParser MCP correlation", () => {
	it("correlates an mcp__github__ call with its result and parses the JSON-string output", () => {
		const payload = { number: 42, title: "Fix the bug", url: "https://github.com/o/r/issues/42" };
		const lines = [
			toolCall("c1", "mcp__github__get_issue", { owner: "o", repo: "r", number: 42 }, 1_700_000_000_000),
			toolResult("c1", payload, 1_700_000_000_500),
		];
		const { results, lastLineNumberScanned } = kimiEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("github");
		expect(results[0].toolName).toBe("mcp__github__get_issue");
		expect(results[0].payload).toEqual(payload); // identity normalize
		expect(results[0].lineNumber).toBe(2);
		expect(results[0].referencedAt).toBe(iso(1_700_000_000_500));
		expect(lastLineNumberScanned).toBe(2);
	});

	it("emits multiple results ordered by the result line number", () => {
		const a = { number: 1, title: "a", url: "https://github.com/o/r/issues/1" };
		const b = { number: 2, title: "b", url: "https://github.com/o/r/issues/2" };
		const lines = [
			toolCall("c1", "mcp__github__get_issue", { number: 1 }, 1_700_000_000_000),
			toolCall("c2", "mcp__github__get_issue", { number: 2 }, 1_700_000_000_100),
			toolResult("c2", b, 1_700_000_000_200), // result line 3
			toolResult("c1", a, 1_700_000_000_300), // result line 4
		];
		const { results } = kimiEnvelopeParser.parse(lines, {});
		// Sorted by lineNumber: c2's result (line 3) precedes c1's (line 4).
		expect(results.map((r) => (r.payload as { number: number }).number)).toEqual([2, 1]);
	});

	it("ignores built-in (non-mcp) tool.calls like Read", () => {
		const lines = [
			toolCall("r1", "Read", { path: "/x" }, 1_700_000_000_000),
			toolResult("r1", { content: "file" }, 1_700_000_000_100),
		];
		const { results } = kimiEnvelopeParser.parse(lines, {});
		expect(results).toEqual([]);
	});

	it("drops an mcp tool that no source definition matches", () => {
		const lines = [
			toolCall("c1", "mcp__unknown_server__frobnicate", {}, 1_700_000_000_000),
			toolResult("c1", { anything: true }, 1_700_000_000_100),
		];
		expect(kimiEnvelopeParser.parse(lines, {}).results).toEqual([]);
	});

	it("applies beforeTimestamp, dropping a call later than the cutoff", () => {
		const early = { number: 1, title: "early", url: "https://github.com/o/r/issues/1" };
		const late = { number: 2, title: "late", url: "https://github.com/o/r/issues/2" };
		const lines = [
			toolCall("c1", "mcp__github__get_issue", { number: 1 }, 1_700_000_000_000),
			toolResult("c1", early, 1_700_000_000_100),
			toolCall("c2", "mcp__github__get_issue", { number: 2 }, 1_700_000_100_000),
			toolResult("c2", late, 1_700_000_100_100),
		];
		// Cutoff between the two calls: c1 kept, c2's call dropped (so its result too).
		const cutoff = iso(1_700_000_050_000);
		const { results } = kimiEnvelopeParser.parse(lines, { beforeTimestamp: cutoff });
		expect(results).toHaveLength(1);
		expect(results[0].payload).toEqual(early);
	});

	it("runs the shared context-normalizer (jollimemory arguments-derived) and voids list_branches", () => {
		// jollimemory is context-normalized: `search` builds a reference from the ARGS,
		// while `list_branches` returns null (voided) — proving the empty-permalinks
		// shared normalizer path is exercised from Kimi.
		const search = [
			toolCall("j1", "mcp__jollimemory__search", { query: "how references work" }, 1_700_000_000_000),
			toolResult("j1", { hits: [] }, 1_700_000_000_100),
		];
		const { results } = kimiEnvelopeParser.parse(search, {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("jollimemory");
		expect(results[0].payload).toEqual({ tool: "search", title: "Search", query: "how references work" });

		const listed = [
			toolCall("j2", "mcp__jollimemory__list_branches", {}, 1_700_000_000_000),
			toolResult("j2", { branches: [] }, 1_700_000_000_100),
		];
		expect(kimiEnvelopeParser.parse(listed, {}).results).toEqual([]);
	});

	it("voids a result when the shared context-normalizer returns null (monday board browse)", () => {
		// A monday board browse (no itemIds) normalizes to null → the reference is voided,
		// exercising the `payload === null` drop after normalizeMcpBusiness.
		const lines = [
			toolCall("m1", "mcp__claude_ai_monday_com__get_board_items_page", { boardId: 1 }, 1_700_000_000_000),
			toolResult("m1", { board: {}, items: [] }, 1_700_000_000_100),
		];
		expect(kimiEnvelopeParser.parse(lines, {}).results).toEqual([]);
	});

	it("holds the cursor at the earliest of several unpaired in-flight calls", () => {
		const lines = [
			toolCall("c1", "mcp__github__get_issue", { number: 1 }, 1_700_000_000_000), // line index 0
			toolCall("c2", "mcp__github__get_issue", { number: 2 }, 1_700_000_000_100), // line index 1
		];
		const { results, lastLineNumberScanned } = kimiEnvelopeParser.parse(lines, {});
		expect(results).toEqual([]);
		expect(lastLineNumberScanned).toBe(0);
	});

	it("drops a result whose output string is not JSON", () => {
		const lines = [
			toolCall("c1", "mcp__github__get_issue", { number: 1 }, 1_700_000_000_000),
			toolResult("c1", "not json and no pointer", 1_700_000_000_100),
		];
		expect(kimiEnvelopeParser.parse(lines, {}).results).toEqual([]);
	});

	it("rewinds the cursor to an in-flight call whose result has not landed yet", () => {
		const lines = [
			toolCall("c1", "mcp__github__get_issue", { number: 1 }, 1_700_000_000_000), // line index 0, no result
		];
		const { results, lastLineNumberScanned } = kimiEnvelopeParser.parse(lines, {});
		expect(results).toEqual([]);
		// Held at the call's 0-based line index so the next pass re-reads it.
		expect(lastLineNumberScanned).toBe(0);
	});

	it("drops a result that arrives after the cutoff even when its call preceded it", () => {
		// call before cutoff (stashed), result after cutoff (dropped, pending cleared).
		const payload = { number: 3, title: "t", url: "https://github.com/o/r/issues/3" };
		const lines = [
			toolCall("c1", "mcp__github__get_issue", { number: 3 }, 1_700_000_000_000),
			toolResult("c1", payload, 1_700_000_100_000),
		];
		const { results, lastLineNumberScanned } = kimiEnvelopeParser.parse(lines, {
			beforeTimestamp: iso(1_700_000_050_000),
		});
		expect(results).toEqual([]);
		// The call was answered (result seen), so the cursor is NOT held on it.
		expect(lastLineNumberScanned).toBe(2);
	});

	it("uses an empty referencedAt when the call/result carry no numeric time, and tolerates an absurd epoch", () => {
		const payload = { number: 4, title: "t", url: "https://github.com/o/r/issues/4" };
		const call = JSON.stringify({
			type: "context.append_loop_event",
			event: { type: "tool.call", toolCallId: "c1", name: "mcp__github__get_issue", args: {} },
		});
		const result = JSON.stringify({
			type: "context.append_loop_event",
			event: { type: "tool.result", toolCallId: "c1", result: { output: JSON.stringify(payload) } },
			time: 1e21, // finite but past the max Date range → NaN getTime() → ""
		});
		const { results } = kimiEnvelopeParser.parse([call, result], {});
		expect(results).toHaveLength(1);
		expect(results[0].referencedAt).toBe("");
	});

	it("drops a paired result whose result envelope is malformed (non-object or missing output)", () => {
		const nonObj = [
			toolCall("c1", "mcp__github__get_issue", {}, 1_700_000_000_000),
			JSON.stringify({
				type: "context.append_loop_event",
				event: { type: "tool.result", toolCallId: "c1", result: "oops" },
				time: 1_700_000_000_100,
			}),
		];
		expect(kimiEnvelopeParser.parse(nonObj, {}).results).toEqual([]);

		const noOutput = [
			toolCall("c2", "mcp__github__get_issue", {}, 1_700_000_000_000),
			JSON.stringify({
				type: "context.append_loop_event",
				event: { type: "tool.result", toolCallId: "c2", result: {} },
				time: 1_700_000_000_100,
			}),
		];
		expect(kimiEnvelopeParser.parse(noOutput, {}).results).toEqual([]);
	});

	it("ignores loop events with a non-object body, unknown event type, or missing name/toolCallId", () => {
		const lines = [
			JSON.stringify("context.append_loop_event"), // valid JSON, not an object
			JSON.stringify({ type: "context.append_loop_event", time: 1 }), // no event object
			JSON.stringify({ type: "context.append_loop_event", event: { type: "message" }, time: 1 }), // unknown event type
			JSON.stringify({
				type: "context.append_loop_event",
				event: { type: "tool.call", toolCallId: "c1", args: {} }, // no name
				time: 1,
			}),
			JSON.stringify({
				type: "context.append_loop_event",
				event: { type: "tool.call", name: "mcp__github__get_issue", args: {} }, // no toolCallId
				time: 1,
			}),
			JSON.stringify({
				type: "context.append_loop_event",
				event: { type: "tool.result", result: { output: "{}" } }, // result missing toolCallId
				time: 1,
			}),
		];
		expect(kimiEnvelopeParser.parse(lines, {}).results).toEqual([]);
	});

	it("skips malformed and non-loop-event lines without throwing", () => {
		const payload = { number: 7, title: "ok", url: "https://github.com/o/r/issues/7" };
		const lines = [
			'{"type":"context.append_loop_event" broken', // matches needle, fails JSON.parse
			JSON.stringify({ type: "something.else" }), // not a loop event
			"", // empty
			toolCall("c1", "mcp__github__get_issue", { number: 7 }, 1_700_000_000_000),
			toolResult("c1", payload, 1_700_000_000_100),
		];
		const { results } = kimiEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(results[0].payload).toEqual(payload);
	});
});
