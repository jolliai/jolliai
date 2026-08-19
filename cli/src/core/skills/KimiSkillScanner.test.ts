import { describe, expect, it } from "vitest";
import { scanKimiSkillLines } from "./KimiSkillScanner.js";

/** ISO conversion mirrors the scanner's own `new Date(time).toISOString()`. */
const iso = (ms: number) => new Date(ms).toISOString();

/** A `context.append_loop_event` wrapping a `tool.call`. */
function toolCall(toolCallId: string, name: string, args: Record<string, unknown>, time: number): string {
	return JSON.stringify({
		type: "context.append_loop_event",
		event: { type: "tool.call", toolCallId, name, args },
		time,
	});
}

/** A `context.append_loop_event` wrapping a `tool.result`. */
function toolResult(toolCallId: string, result: Record<string, unknown>, time: number): string {
	return JSON.stringify({
		type: "context.append_loop_event",
		event: { type: "tool.result", toolCallId, result },
		time,
	});
}

describe("scanKimiSkillLines", () => {
	it("emits one observed SkillUse for a Skill tool.call + successful tool.result", () => {
		const lines = [
			toolCall("c1", "Skill", { skill: "hello-capture" }, 1_700_000_000_000),
			toolResult(
				"c1",
				{ output: 'Skill "hello-capture" loaded inline. Follow its instructions.' },
				1_700_000_000_500,
			),
		];
		const { uses, lastLine } = scanKimiSkillLines(lines, 0);
		expect(uses).toHaveLength(1);
		expect(uses[0]).toEqual({
			source: "kimi",
			skill: "hello-capture",
			entryPaths: ["tool"],
			invocations: [{ at: iso(1_700_000_000_000), ok: true, entryPath: "tool", outcomeObserved: true }],
		});
		// No heuristic marker — Kimi's skill tool is observed.
		expect(uses[0]).not.toHaveProperty("detection");
		expect(lastLine).toBe(2);
	});

	it("ignores non-Skill tool.calls (built-in and MCP tools)", () => {
		const lines = [
			toolCall("r1", "Read", { path: "/x" }, 1_700_000_000_000),
			toolCall("m1", "mcp__github__get_issue", { number: 1 }, 1_700_000_000_100),
			toolResult("r1", { output: "file contents" }, 1_700_000_000_200),
		];
		expect(scanKimiSkillLines(lines, 0).uses).toEqual([]);
	});

	it("marks an invocation failed when its tool.result carries isError:true", () => {
		const lines = [
			toolCall("c1", "Skill", { skill: "broken-skill" }, 1_700_000_000_000),
			toolResult("c1", { output: "boom", isError: true }, 1_700_000_000_500),
		];
		const { uses } = scanKimiSkillLines(lines, 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations).toEqual([
			{ at: iso(1_700_000_000_000), ok: false, entryPath: "tool", outcomeObserved: true },
		]);
	});

	it("groups repeat invocations of one skill, newest-first", () => {
		const lines = [
			toolCall("c1", "Skill", { skill: "planner" }, 1_700_000_000_000),
			toolResult("c1", { output: "ok" }, 1_700_000_000_100),
			toolCall("c2", "Skill", { skill: "planner" }, 1_700_000_009_000),
			toolResult("c2", { output: "ok" }, 1_700_000_009_100),
		];
		const { uses } = scanKimiSkillLines(lines, 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations).toEqual([
			{ at: iso(1_700_000_009_000), ok: true, entryPath: "tool", outcomeObserved: true }, // newest first
			{ at: iso(1_700_000_000_000), ok: true, entryPath: "tool", outcomeObserved: true },
		]);
	});

	it("orders invocations newest-first, keeping equal-timestamp entries stable", () => {
		// Three entries with times [100, 200, 100] exercise all three comparator
		// outcomes (a<b, a>b, a===b) in the newest-first sort.
		const lines = [
			toolCall("c1", "Skill", { skill: "s" }, 1_700_000_000_100),
			toolResult("c1", { output: "ok" }, 1_700_000_000_150),
			toolCall("c2", "Skill", { skill: "s" }, 1_700_000_000_200),
			toolResult("c2", { output: "ok" }, 1_700_000_000_250),
			toolCall("c3", "Skill", { skill: "s" }, 1_700_000_000_100),
			toolResult("c3", { output: "ok" }, 1_700_000_000_150),
		];
		const { uses } = scanKimiSkillLines(lines, 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations.map((v) => v.at)).toEqual([
			iso(1_700_000_000_200),
			iso(1_700_000_000_100),
			iso(1_700_000_000_100),
		]);
	});

	it("skips a Skill tool.call with an empty or missing skill arg", () => {
		const lines = [
			toolCall("c1", "Skill", { skill: "" }, 1_700_000_000_000),
			toolCall("c2", "Skill", {}, 1_700_000_000_100),
		];
		expect(scanKimiSkillLines(lines, 0).uses).toEqual([]);
	});

	it("honours fromLine and tolerates malformed / non-event lines", () => {
		const lines = [
			toolCall("c0", "Skill", { skill: "before-cursor" }, 1_700_000_000_000), // skipped by fromLine
			'{"type":"context.append_loop_event" broken json', // matches needle, fails JSON.parse → skipped
			JSON.stringify({ type: "some.other.event" }),
			toolCall("c1", "Skill", { skill: "after-cursor" }, 1_700_000_001_000),
			toolResult("c1", { output: "ok" }, 1_700_000_001_100),
		];
		const { uses, lastLine } = scanKimiSkillLines(lines, 1);
		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("after-cursor");
		expect(lastLine).toBe(5);
	});

	it("emits nothing (and holds the mark) for a window before the cursor", () => {
		const lines = [toolCall("c1", "Skill", { skill: "x" }, 1_700_000_000_000)];
		const { uses, lastLine } = scanKimiSkillLines(lines, 5);
		expect(uses).toEqual([]);
		expect(lastLine).toBe(5);
	});

	it("still emits an optimistic (ok) invocation for a Skill call carrying no toolCallId", () => {
		// Without a toolCallId the entry can never be paired with a result, so it stays
		// ok:true — a call that reached the transcript is still a real entry.
		const call = JSON.stringify({
			type: "context.append_loop_event",
			event: { type: "tool.call", name: "Skill", args: { skill: "unpaired" } },
			time: 1_700_000_000_000,
		});
		const { uses } = scanKimiSkillLines([call], 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations).toEqual([
			{ at: iso(1_700_000_000_000), ok: true, entryPath: "tool", outcomeObserved: false },
		]);
	});

	it("holds the cursor before an in-flight Skill call (toolCallId, result not yet landed)", () => {
		// A Skill call whose tool.result has not appeared yet is reported optimistically
		// (ok:true) BUT the cursor is rewound to before it, so the next pass re-reads the
		// pair and the store's fold can correct `ok` if the result later says isError.
		const lines = [toolCall("c1", "Skill", { skill: "in-flight" }, 1_700_000_000_100)];
		const { uses, lastLine } = scanKimiSkillLines(lines, 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations[0].ok).toBe(true);
		expect(uses[0].invocations[0].outcomeObserved).toBe(false);
		expect(lastLine).toBe(0); // held before the call (0-based line 0), not advanced to EOF (1)
	});

	it("does not rewind once a later call in the window is fully paired", () => {
		// Only genuinely unpaired calls hold the cursor; a paired call advances normally.
		const lines = [
			toolCall("c1", "Skill", { skill: "done" }, 1_700_000_000_000),
			toolResult("c1", { output: "ok" }, 1_700_000_000_100),
		];
		expect(scanKimiSkillLines(lines, 0).lastLine).toBe(2);
	});

	it("does not let an earlier abandoned Skill call pin the cursor once a later one is paired", () => {
		const lines = [
			toolCall("c1", "Skill", { skill: "abandoned" }, 1_700_000_000_000), // line 0: no result
			toolCall("c2", "Skill", { skill: "done" }, 1_700_000_000_100), // line 1
			toolResult("c2", { output: "ok" }, 1_700_000_000_200), // line 2: pairs c2 → tail boundary
		];
		// c1 (1-based line 1) precedes the paired result → not in the trailing suffix, so it
		// must NOT pin the cursor; it advances to EOF (3) rather than rewinding to 0.
		expect(scanKimiSkillLines(lines, 0).lastLine).toBe(3);
	});

	it("uses an empty `at` when the Skill call carries no numeric time", () => {
		const noTime = JSON.stringify({
			type: "context.append_loop_event",
			event: { type: "tool.call", toolCallId: "c1", name: "Skill", args: { skill: "no-time" } },
		});
		const outOfRange = JSON.stringify({
			type: "context.append_loop_event",
			event: { type: "tool.call", toolCallId: "c2", name: "Skill", args: { skill: "absurd-time" } },
			time: 1e21, // finite but far past the max Date range → NaN getTime()
		});
		const uses = scanKimiSkillLines([noTime, outOfRange], 0).uses;
		expect(uses.every((u) => u.invocations[0].at === "")).toBe(true);
	});

	it("ignores malformed loop events (empty line, non-object json, bad args/result shapes)", () => {
		const lines = [
			"", // empty line
			JSON.stringify("context.append_loop_event"), // valid JSON, not an object
			JSON.stringify({ type: "context.append_loop_event" }), // no event object
			JSON.stringify({ type: "context.append_loop_event", event: { type: "message" } }), // unknown event type
			// Skill call whose args is not an object → no skill → skipped.
			JSON.stringify({
				type: "context.append_loop_event",
				event: { type: "tool.call", toolCallId: "c1", name: "Skill", args: "oops" },
			}),
			// tool.result with no toolCallId, and a result for an unknown id — neither pairs.
			JSON.stringify({ type: "context.append_loop_event", event: { type: "tool.result", result: {} } }),
			JSON.stringify({
				type: "context.append_loop_event",
				event: { type: "tool.result", toolCallId: "unknown", result: {} },
			}),
		];
		expect(scanKimiSkillLines(lines, 0).uses).toEqual([]);
	});

	it("treats a paired Skill result with a non-object result envelope as success", () => {
		const lines = [
			toolCall("c1", "Skill", { skill: "weird-result" }, 1_700_000_000_000),
			JSON.stringify({
				type: "context.append_loop_event",
				event: { type: "tool.result", toolCallId: "c1", result: "not-an-object" },
				time: 1_700_000_000_100,
			}),
		];
		const { uses } = scanKimiSkillLines(lines, 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations[0].ok).toBe(true);
		expect(uses[0].invocations[0].outcomeObserved).toBe(true);
	});
});
