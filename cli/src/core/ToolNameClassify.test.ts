import { describe, expect, it } from "vitest";
import {
	builtinTool,
	classifyCodexToolName,
	classifyCursorToolName,
	classifyToolName,
	mcpTool,
	skillTool,
	ToolUseTally,
} from "./ToolNameClassify.js";

describe("constructors", () => {
	it("marks a bare name as a builtin with no server", () => {
		expect(builtinTool("Bash")).toEqual({ name: "Bash", kind: "builtin", calls: 0 });
	});

	it("marks a skill by the skill's own name", () => {
		expect(skillTool("code-review")).toEqual({ name: "code-review", kind: "skill", calls: 0 });
	});

	it("folds the server into the display name and keeps it as a field", () => {
		expect(mcpTool("linear", "list_issues")).toEqual({
			name: "linear.list_issues",
			kind: "mcp",
			server: "linear",
			calls: 0,
		});
	});

	it("keeps a server-only MCP call attributed to the server", () => {
		expect(mcpTool("linear", "")).toEqual({ name: "linear", kind: "mcp", server: "linear", calls: 0 });
	});
});

describe("classifyToolName (mcp__server__tool dialect)", () => {
	it("classifies a bare name as a builtin", () => {
		expect(classifyToolName("Bash")).toEqual({ name: "Bash", kind: "builtin", calls: 0 });
	});

	it("splits server and tool on the first double underscore", () => {
		expect(classifyToolName("mcp__jollimemory__search")).toEqual({
			name: "jollimemory.search",
			kind: "mcp",
			server: "jollimemory",
			calls: 0,
		});
	});

	it("keeps single underscores inside both segments", () => {
		expect(classifyToolName("mcp__claude_ai_Linear__list_issues")).toEqual({
			name: "claude_ai_Linear.list_issues",
			kind: "mcp",
			server: "claude_ai_Linear",
			calls: 0,
		});
	});

	it("treats only the first two segments as structural", () => {
		// A tool name may itself contain `__`; it stays part of the tool.
		expect(classifyToolName("mcp__srv__a__b")).toEqual({
			name: "srv.a__b",
			kind: "mcp",
			server: "srv",
			calls: 0,
		});
	});

	it("attributes a malformed server-only name to the server rather than dropping it", () => {
		expect(classifyToolName("mcp__srv")).toEqual({ name: "srv", kind: "mcp", server: "srv", calls: 0 });
	});

	it("does not treat a single-underscore mcp_ prefix as MCP", () => {
		expect(classifyToolName("mcp_tool")).toEqual({ name: "mcp_tool", kind: "builtin", calls: 0 });
	});
});

describe("classifyCodexToolName (identity lives outside the name)", () => {
	it("classifies a namespace-less call as a builtin", () => {
		// Every name observed across 40 real ~/.codex/sessions rollouts is this shape.
		for (const name of ["exec_command", "wait", "write_stdin", "update_plan", "exec", "apply_patch"]) {
			expect(classifyCodexToolName(name)).toEqual({ name, kind: "builtin", calls: 0 });
		}
	});

	it("treats an empty namespace as absent", () => {
		expect(classifyCodexToolName("exec", "")).toEqual({ name: "exec", kind: "builtin", calls: 0 });
	});

	it("takes the connector source, not the gateway, as the server", () => {
		expect(classifyCodexToolName("list_issues", "mcp__codex_apps__linear")).toEqual({
			name: "linear.list_issues",
			kind: "mcp",
			server: "linear",
			calls: 0,
		});
	});

	it("falls back to the sole segment when the namespace names only a server", () => {
		expect(classifyCodexToolName("search", "mcp__linear")).toEqual({
			name: "linear.search",
			kind: "mcp",
			server: "linear",
			calls: 0,
		});
	});

	it("uses a non-mcp namespace verbatim as the server", () => {
		expect(classifyCodexToolName("search", "linear")).toEqual({
			name: "linear.search",
			kind: "mcp",
			server: "linear",
			calls: 0,
		});
	});

	it("does NOT read an mcp__ prefix out of the tool name itself", () => {
		// The Claude dialect would call this MCP. Codex never names tools that way,
		// and guessing here is what silently files real MCP calls as builtins.
		expect(classifyCodexToolName("mcp__srv__tool")).toEqual({
			name: "mcp__srv__tool",
			kind: "builtin",
			calls: 0,
		});
	});
});

describe("ToolUseTally", () => {
	it("starts empty and reports an empty array, not undefined", () => {
		expect(new ToolUseTally().values()).toEqual([]);
	});

	it("sums repeated calls to the same tool", () => {
		const tally = new ToolUseTally();
		tally.add(builtinTool("Bash"));
		tally.add(builtinTool("Bash"));
		expect(tally.values()).toEqual([{ name: "Bash", kind: "builtin", calls: 2 }]);
	});

	it("adds a caller-supplied count", () => {
		const tally = new ToolUseTally();
		tally.add(builtinTool("Bash"), 3);
		tally.add(builtinTool("Bash"), 2);
		expect(tally.values()).toEqual([{ name: "Bash", kind: "builtin", calls: 5 }]);
	});

	it("keeps a builtin and an MCP tool of the same display name apart", () => {
		const tally = new ToolUseTally();
		tally.add(builtinTool("search"));
		tally.add({ name: "search", kind: "mcp", server: "srv", calls: 0 });
		expect(tally.values()).toEqual([
			{ name: "search", kind: "builtin", calls: 1 },
			{ name: "search", kind: "mcp", server: "srv", calls: 1 },
		]);
	});

	it("counts a repeated call id only once", () => {
		const tally = new ToolUseTally();
		tally.addOnce("toolu_1", builtinTool("Bash"));
		tally.addOnce("toolu_1", builtinTool("Bash"));
		expect(tally.values()).toEqual([{ name: "Bash", kind: "builtin", calls: 1 }]);
	});

	it("counts distinct call ids separately", () => {
		const tally = new ToolUseTally();
		tally.addOnce("toolu_1", builtinTool("Bash"));
		tally.addOnce("toolu_2", builtinTool("Bash"));
		expect(tally.values()).toEqual([{ name: "Bash", kind: "builtin", calls: 2 }]);
	});

	it("counts an id-less call unconditionally rather than dropping it", () => {
		const tally = new ToolUseTally();
		tally.addOnce(undefined, builtinTool("Bash"));
		tally.addOnce(undefined, builtinTool("Bash"));
		expect(tally.values()).toEqual([{ name: "Bash", kind: "builtin", calls: 2 }]);
	});

	it("reports whether an id was already counted", () => {
		const tally = new ToolUseTally();
		expect(tally.hasSeen("toolu_1")).toBe(false);
		tally.addOnce("toolu_1", builtinTool("Bash"));
		expect(tally.hasSeen("toolu_1")).toBe(true);
	});
});

describe("classifyCursorToolName (identity lives in `input`)", () => {
	it("classifies every observed bare name as a builtin", () => {
		// The complete builtin set across 10 real Cursor transcripts.
		for (const name of ["Shell", "Read", "WebSearch", "WebFetch"]) {
			expect(classifyCursorToolName(name, {})).toEqual({ name, kind: "builtin", calls: 0 });
		}
	});

	it("reads the server and tool out of a real CallMcpTool input", () => {
		expect(
			classifyCursorToolName("CallMcpTool", {
				server: "jollimemory",
				toolName: "search",
				description: "Search Jolli memories for this branch's work",
				arguments: { query: "cursor session rescan", limit: 10 },
			}),
		).toEqual({ name: "jollimemory.search", kind: "mcp", server: "jollimemory", calls: 0 });
	});

	it("does NOT classify by the presence of a server — GetMcpTools carries one too", () => {
		// A real discovery call: it names a server and invokes nothing. Keying on the
		// input rather than on the tool name would file every one of these (9 in the
		// corpus) as an MCP call and inflate every MCP figure on the dashboard.
		expect(classifyCursorToolName("GetMcpTools", { server: "jollimemory", toolName: "search" })).toEqual({
			name: "GetMcpTools",
			kind: "builtin",
			calls: 0,
		});
	});

	it("never invents a server", () => {
		// Each of these is a real call that must still be counted, but filing it under
		// an empty server would put a nameless row in the group-by-server ranking.
		for (const input of [{}, undefined, null, "not an object", { server: "" }, { server: 42 }]) {
			expect(classifyCursorToolName("CallMcpTool", input)).toEqual({
				name: "CallMcpTool",
				kind: "builtin",
				calls: 0,
			});
		}
	});

	it("keeps the server when the tool half is missing or malformed", () => {
		// Mirrors classifyToolName's `mcp__server`-with-no-tool rule: attribute to the
		// server rather than dropping the call.
		for (const toolName of [undefined, "", 7]) {
			expect(classifyCursorToolName("CallMcpTool", { server: "jollimemory", toolName })).toEqual({
				name: "jollimemory",
				kind: "mcp",
				server: "jollimemory",
				calls: 0,
			});
		}
	});

	it("does not treat an mcp__-prefixed name as MCP — Cursor never writes one", () => {
		// The corpus has zero of these. Recognising one here would resurrect the
		// premise this classifier exists to replace.
		expect(classifyCursorToolName("mcp__jollimemory__search", {})).toEqual({
			name: "mcp__jollimemory__search",
			kind: "builtin",
			calls: 0,
		});
	});
});
