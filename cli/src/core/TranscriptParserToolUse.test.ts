import { describe, expect, it } from "vitest";
import { getParserForSource, TOOL_RECORDING_SOURCES } from "./TranscriptParser.js";

/** Shorthand: run a parser's parseToolUse over pre-serialized events. */
function toolUse(source: "claude" | "codex" | "kimi", events: ReadonlyArray<unknown>) {
	const parser = getParserForSource(source);
	if (parser.parseToolUse === undefined) throw new Error(`${source} parser has no parseToolUse`);
	return parser.parseToolUse(events.map((e) => JSON.stringify(e)));
}

/** A Codex rollout row, in the real `{timestamp, type, payload}` envelope. */
function codexRow(payload: Record<string, unknown>) {
	return { timestamp: "2026-08-06T16:03:08.019Z", type: "response_item", payload };
}

/** A Kimi wire row, in the real `context.append_loop_event` envelope. */
function kimiRow(event: Record<string, unknown>) {
	return { type: "context.append_loop_event", event, time: 1786000000000 };
}

describe("CodexTranscriptParser.parseToolUse", () => {
	it("counts the builtin call shapes real rollouts contain", () => {
		// Shapes and names taken from ~/.codex/sessions (Jul–Aug 2026): a
		// `custom_tool_call` named `exec` and `function_call`s named `exec_command`
		// / `wait` are 1219 of the 1221 tool rows in that corpus.
		expect(
			toolUse("codex", [
				codexRow({ type: "custom_tool_call", call_id: "call_a", name: "exec", input: "…" }),
				codexRow({ type: "function_call", call_id: "call_b", name: "exec_command", arguments: "{}" }),
				codexRow({ type: "function_call", call_id: "call_c", name: "wait", arguments: "{}" }),
			]),
		).toEqual([
			{ name: "exec", kind: "builtin", calls: 1 },
			{ name: "exec_command", kind: "builtin", calls: 1 },
			{ name: "wait", kind: "builtin", calls: 1 },
		]);
	});

	it("does not count a call's result row twice", () => {
		// The `_output` sibling repeats the call_id; counting it would double every
		// call, and the corpus has one output row per call row (804/804, 415/415).
		expect(
			toolUse("codex", [
				codexRow({ type: "function_call", call_id: "call_a", name: "exec_command" }),
				codexRow({ type: "function_call_output", call_id: "call_a", output: "Wall time: 1s\nOutput:\nok" }),
			]),
		).toEqual([{ name: "exec_command", kind: "builtin", calls: 1 }]);
	});

	it("does not merge distinct calls to the same tool", () => {
		expect(
			toolUse("codex", [
				codexRow({ type: "function_call", call_id: "call_a", name: "exec_command" }),
				codexRow({ type: "function_call", call_id: "call_b", name: "exec_command" }),
			]),
		).toEqual([{ name: "exec_command", kind: "builtin", calls: 2 }]);
	});

	it("counts an mcp_tool_call_end by its invocation server and tool", () => {
		expect(
			toolUse("codex", [
				codexRow({
					type: "mcp_tool_call_end",
					call_id: "call_a",
					invocation: { server: "linear", tool: "list_issues" },
				}),
			]),
		).toEqual([{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 1 }]);
	});

	it("counts a connector function_call by its namespace's source", () => {
		expect(
			toolUse("codex", [
				codexRow({
					type: "function_call",
					call_id: "call_a",
					namespace: "mcp__codex_apps__linear",
					name: "list_issues",
				}),
			]),
		).toEqual([{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 1 }]);
	});

	it("lets a trailing mcp_tool_call_end upgrade the request row's builtin guess", () => {
		// Verbatim from a live 2026-08-10 rollout: the request row is
		// namespace-less and looks exactly like a builtin, and the server only
		// appears on the LATER event. First-write-wins loses the server entirely,
		// which is the silent mis-bucketing this parser exists to prevent.
		expect(
			toolUse("codex", [
				codexRow({ type: "function_call", call_id: "call_00_2Rw", name: "list_mcp_resources" }),
				codexRow({
					type: "mcp_tool_call_end",
					call_id: "call_00_2Rw",
					invocation: { server: "codex", tool: "list_mcp_resources", arguments: {} },
				}),
			]),
		).toEqual([{ name: "codex.list_mcp_resources", kind: "mcp", server: "codex", calls: 1 }]);
	});

	it("never downgrades a resolved MCP identity back to a builtin", () => {
		expect(
			toolUse("codex", [
				codexRow({
					type: "mcp_tool_call_end",
					call_id: "call_a",
					invocation: { server: "jollimemory", tool: "recall" },
				}),
				codexRow({ type: "function_call", call_id: "call_a", name: "recall" }),
			]),
		).toEqual([{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 1 }]);
	});

	it("counts a request and its mcp_tool_call_end as one call", () => {
		// Codex writes both for the same call_id — the request first, the event
		// after. The pair is still one call.
		expect(
			toolUse("codex", [
				codexRow({
					type: "function_call",
					call_id: "call_a",
					namespace: "mcp__codex_apps__linear",
					name: "list_issues",
				}),
				codexRow({
					type: "mcp_tool_call_end",
					call_id: "call_a",
					invocation: { server: "linear", tool: "list_issues" },
				}),
			]),
		).toEqual([{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 1 }]);
	});

	it("counts an mcp_tool_call_end with no server as a builtin rather than inventing one", () => {
		expect(
			toolUse("codex", [
				codexRow({ type: "mcp_tool_call_end", call_id: "call_a", invocation: { tool: "search" } }),
			]),
		).toEqual([{ name: "search", kind: "builtin", calls: 1 }]);
	});

	it("counts a call that carries no call_id rather than dropping it", () => {
		expect(
			toolUse("codex", [
				codexRow({ type: "function_call", name: "exec_command" }),
				codexRow({ type: "function_call", name: "exec_command" }),
			]),
		).toEqual([{ name: "exec_command", kind: "builtin", calls: 2 }]);
	});

	it("ignores conversation rows, malformed lines and payload-less lines", () => {
		const parser = getParserForSource("codex");
		expect(
			parser.parseToolUse?.([
				JSON.stringify(codexRow({ type: "reasoning", summary: [] })),
				JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hi" } }),
				JSON.stringify({ type: "session_meta" }),
				"{ not json",
				"",
			]),
		).toEqual([]);
	});

	it("reports an empty array for a tool-free slice, never undefined", () => {
		expect(toolUse("codex", [])).toEqual([]);
	});
});

describe("KimiTranscriptParser.parseToolUse", () => {
	it("counts a builtin tool.call", () => {
		expect(
			toolUse("kimi", [kimiRow({ type: "tool.call", toolCallId: "t1", name: "Read", args: { path: "a.ts" } })]),
		).toEqual([{ name: "Read", kind: "builtin", calls: 1 }]);
	});

	it("counts an MCP tool.call by its Claude-shaped name", () => {
		expect(
			toolUse("kimi", [kimiRow({ type: "tool.call", toolCallId: "t1", name: "mcp__jollimemory__search" })]),
		).toEqual([{ name: "jollimemory.search", kind: "mcp", server: "jollimemory", calls: 1 }]);
	});

	it("re-attributes a Skill call to the skill it ran", () => {
		expect(
			toolUse("kimi", [
				kimiRow({ type: "tool.call", toolCallId: "t1", name: "Skill", args: { skill: "jolli-pr" } }),
			]),
		).toEqual([{ name: "jolli-pr", kind: "skill", calls: 1 }]);
	});

	it("keeps a Skill call with no skill argument as a builtin rather than dropping it", () => {
		expect(toolUse("kimi", [kimiRow({ type: "tool.call", toolCallId: "t1", name: "Skill", args: {} })])).toEqual([
			{ name: "Skill", kind: "builtin", calls: 1 },
		]);
	});

	it("does not count the paired tool.result", () => {
		expect(
			toolUse("kimi", [
				kimiRow({ type: "tool.call", toolCallId: "t1", name: "Read" }),
				kimiRow({ type: "tool.result", toolCallId: "t1", result: { output: "…" } }),
			]),
		).toEqual([{ name: "Read", kind: "builtin", calls: 1 }]);
	});

	it("counts a repeated toolCallId once and distinct ids separately", () => {
		expect(
			toolUse("kimi", [
				kimiRow({ type: "tool.call", toolCallId: "t1", name: "Read" }),
				kimiRow({ type: "tool.call", toolCallId: "t1", name: "Read" }),
				kimiRow({ type: "tool.call", toolCallId: "t2", name: "Read" }),
			]),
		).toEqual([{ name: "Read", kind: "builtin", calls: 2 }]);
	});

	it("ignores conversation events, unwrapped events and malformed lines", () => {
		const parser = getParserForSource("kimi");
		expect(
			parser.parseToolUse?.([
				JSON.stringify(kimiRow({ type: "content.part", part: { type: "text", text: "hi" } })),
				JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: "hi" }], time: 1 }),
				JSON.stringify({ type: "context.append_loop_event" }),
				"{ not json",
			]),
		).toEqual([]);
	});

	it("reports an empty array for a tool-free slice, never undefined", () => {
		expect(toolUse("kimi", [])).toEqual([]);
	});
});

describe("TOOL_RECORDING_SOURCES", () => {
	it("includes every parser that implements parseToolUse", () => {
		for (const source of ["claude", "codex", "kimi"] as const) {
			expect(getParserForSource(source).parseToolUse).toBeTypeOf("function");
			expect(TOOL_RECORDING_SOURCES.has(source)).toBe(true);
		}
	});

	it("includes the reader-backed sources whose readers populate toolUse", () => {
		// Each of these is pinned behaviourally in its own reader's test file.
		for (const source of ["gemini", "opencode", "antigravity", "cursor-cli", "cline-cli", "devin"]) {
			expect(TOOL_RECORDING_SOURCES.has(source)).toBe(true);
		}
	});

	it("excludes the sources whose tool records are still unproven", () => {
		// Not a wish-list: a source here reports `toolUse: []`, which downstream
		// reads as the positive claim "called no tools". Omission degrades to
		// "unavailable" instead. Move an entry up only with a real capture.
		for (const source of ["cursor", "copilot", "copilot-chat", "cline"]) {
			expect(TOOL_RECORDING_SOURCES.has(source)).toBe(false);
		}
	});
});
