import { describe, expect, it } from "vitest";
import { hermesToolCall } from "../../testUtils/hermesDbFixture.js";
import { type HermesSkillRow, scanHermesSkillRows } from "./HermesSkillScanner.js";

/** 2026-08-26T03:00:00Z onwards, in the epoch SECONDS Hermes stores. */
const T0 = Date.UTC(2026, 7, 26, 3, 0, 0) / 1000;
const at = (offsetSec: number): number => T0 + offsetSec;
const iso = (offsetSec: number): string => new Date(at(offsetSec) * 1000).toISOString();

function call(id: string, name: string, args: Record<string, unknown> | undefined, timestamp: number): HermesSkillRow {
	return {
		role: "assistant",
		content: "",
		toolCallId: null,
		toolName: null,
		toolCalls: JSON.stringify([hermesToolCall({ id, name, ...(args !== undefined ? { args } : {}) })]),
		timestamp,
	};
}

function result(id: string, name: string, content: string | null, timestamp: number): HermesSkillRow {
	return { role: "tool", content, toolCallId: id, toolName: name, toolCalls: null, timestamp };
}

describe("scanHermesSkillRows", () => {
	it("pairs a skill_view call with its result", () => {
		const uses = scanHermesSkillRows([
			call("c1", "skill_view", { name: "hermes-agent" }, at(0)),
			result("c1", "skill_view", '{"success": true, "name": "hermes-agent"}', at(1)),
		]);
		expect(uses).toHaveLength(1);
		expect(uses[0]).toMatchObject({ source: "hermes", skill: "hermes-agent", entryPaths: ["tool"] });
		expect(uses[0].invocations).toEqual([
			{ at: iso(0), args: '{"name":"hermes-agent"}', ok: true, outcomeObserved: true, entryPath: "tool" },
		]);
		// Observed, not inferred — Hermes ships a real skill tool.
		expect(uses[0].detection).toBeUndefined();
	});

	it("marks a failed invocation from the result's success field", () => {
		const uses = scanHermesSkillRows([
			call("c1", "skill_view", { name: "missing" }, at(0)),
			result("c1", "skill_view", '{"success": false, "error": "no such skill"}', at(1)),
		]);
		expect(uses[0].invocations[0]).toMatchObject({ ok: false, outcomeObserved: true });
	});

	it("reports an unpaired call optimistically but says the outcome was not seen", () => {
		// The window closed between the call and its result. `ok: true` is a guess;
		// `outcomeObserved: false` is what stops a consumer treating it as evidence.
		const uses = scanHermesSkillRows([call("c1", "skill_view", { name: "hermes-agent" }, at(0))]);
		expect(uses[0].invocations[0]).toMatchObject({ ok: true, outcomeObserved: false });
	});

	it("reads an unparseable or non-object result as success", () => {
		// The pairing already proves the call ran; a parse failure is our limitation,
		// not evidence the skill errored.
		const uses = scanHermesSkillRows([
			call("c1", "skill_view", { name: "a" }, at(0)),
			result("c1", "skill_view", "not json", at(1)),
			call("c2", "skill_view", { name: "b" }, at(2)),
			result("c2", "skill_view", "[1,2]", at(3)),
			call("c3", "skill_view", { name: "c" }, at(4)),
			result("c3", "skill_view", "", at(5)),
			call("c4", "skill_view", { name: "d" }, at(6)),
			result("c4", "skill_view", null, at(7)),
		]);
		expect(uses.map((u) => u.invocations[0].ok)).toEqual([true, true, true, true]);
	});

	it("groups repeat invocations under one skill, newest first", () => {
		const uses = scanHermesSkillRows([
			call("c1", "skill_view", { name: "devops" }, at(0)),
			result("c1", "skill_view", '{"success": true}', at(1)),
			call("c2", "skill_view", { name: "devops" }, at(100)),
			result("c2", "skill_view", '{"success": true}', at(101)),
		]);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations.map((i) => i.at)).toEqual([iso(100), iso(0)]);
	});

	it("ignores every tool that does not enter a skill", () => {
		// `skill_search` lists names and `skill_manage` authors one; counting either
		// would inflate skill figures with calls that loaded no body.
		const uses = scanHermesSkillRows([
			call("c1", "terminal", { command: "ls" }, at(0)),
			call("c2", "skill_search", { query: "git" }, at(1)),
			call("c3", "skill_manage", { action: "write_file" }, at(2)),
			call("c4", "mcp__jollimemory__search", { query: "x" }, at(3)),
		]);
		expect(uses).toEqual([]);
	});

	it("skips calls whose arguments cannot yield a skill name", () => {
		const uses = scanHermesSkillRows([
			{ ...call("c1", "skill_view", {}, at(0)) },
			{ ...call("c2", "skill_view", { name: "" }, at(1)) },
			{
				role: "assistant",
				content: "",
				toolCallId: null,
				toolName: null,
				toolCalls: '[{"id":"c3","function":{"name":"skill_view","arguments":"{bad"}}]',
				timestamp: at(2),
			},
			{
				role: "assistant",
				content: "",
				toolCallId: null,
				toolName: null,
				toolCalls: '[{"id":"c4","function":{"name":"skill_view","arguments":"[1]"}}]',
				timestamp: at(3),
			},
		]);
		expect(uses).toEqual([]);
	});

	it("tolerates malformed and irrelevant rows", () => {
		const uses = scanHermesSkillRows([
			{ role: "assistant", content: "hi", toolCallId: null, toolName: null, toolCalls: "{bad", timestamp: at(0) },
			{
				role: "assistant",
				content: "",
				toolCallId: null,
				toolName: null,
				toolCalls: '{"not":"array"}',
				timestamp: at(1),
			},
			{ role: "assistant", content: "", toolCallId: null, toolName: null, toolCalls: "[null]", timestamp: at(2) },
			{ role: "user", content: "hello", toolCallId: null, toolName: null, toolCalls: null, timestamp: at(3) },
			// A result with no pending call, and one for a different tool.
			result("nope", "skill_view", '{"success": true}', at(4)),
			result("c9", "terminal", "{}", at(5)),
			call("c9", "skill_view", { name: "ok" }, at(6)),
		]);
		expect(uses.map((u) => u.skill)).toEqual(["ok"]);
	});

	it("skips a call whose row carries no usable timestamp", () => {
		// An undated call cannot be placed in a time-ordered invocation history, so it
		// is dropped rather than stamped with a fabricated instant.
		const uses = scanHermesSkillRows([call("c1", "skill_view", { name: "x" }, Number.NaN)]);
		expect(uses).toEqual([]);
	});

	it("accepts a flattened call and a call_id-only call, and rejects empty arguments", () => {
		// Three envelope variants: `{name}` with no `function` wrapper (a schema that
		// flattens it must still count), `call_id` instead of `id` (Hermes writes
		// both, and only one is needed to pair), and an empty `arguments` string.
		const uses = scanHermesSkillRows([
			{
				role: "assistant",
				content: "",
				toolCallId: null,
				toolName: null,
				toolCalls: JSON.stringify([
					{ name: "skill_view", function: { arguments: '{"name":"flat"}' } },
					{ call_id: "c2", function: { name: "skill_view", arguments: '{"name":"paired"}' } },
					{ id: "c3", function: { name: "skill_view", arguments: "" } },
				]),
				timestamp: at(0),
			},
			result("c2", "skill_view", '{"success": false}', at(1)),
		]);
		expect(uses.map((u) => u.skill).sort()).toEqual(["flat", "paired"]);
		expect(uses.find((u) => u.skill === "paired")?.invocations[0]).toMatchObject({
			ok: false,
			outcomeObserved: true,
		});
	});

	it("keeps invocations that share an instant rather than dropping one", () => {
		const rows = [
			call("c1", "skill_view", { name: "same" }, at(0)),
			call("c2", "skill_view", { name: "same" }, at(0)),
		];
		expect(scanHermesSkillRows(rows)[0].invocations).toHaveLength(2);
	});

	it("keeps a call with no id, unpaired forever", () => {
		const uses = scanHermesSkillRows([
			{
				role: "assistant",
				content: "",
				toolCallId: null,
				toolName: null,
				toolCalls: '[{"function":{"name":"skill_view","arguments":"{\\"name\\":\\"anon\\"}"}}]',
				timestamp: at(0),
			},
			result("c1", "skill_view", '{"success": false}', at(1)),
		]);
		expect(uses[0].invocations[0]).toMatchObject({ ok: true, outcomeObserved: false });
	});
});
