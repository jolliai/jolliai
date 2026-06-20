import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./McpTools.js", () => ({
	runSearch: vi.fn().mockResolvedValue({ hits: [] }),
	runRecall: vi.fn().mockResolvedValue({ type: "recall" }),
	runDecisionTimeline: vi.fn().mockResolvedValue({ timeline: [] }),
	runListBranches: vi.fn().mockResolvedValue({ branches: [] }),
	runGetPrDescription: vi.fn().mockResolvedValue({ type: "pr_description" }),
}));

const { mockStorage } = vi.hoisted(() => ({ mockStorage: { kind: "mock-storage" } }));
vi.mock("../core/StorageFactory.js", () => ({ createStorage: vi.fn().mockResolvedValue(mockStorage) }));
vi.mock("../core/SummaryStore.js", () => ({ setActiveStorage: vi.fn() }));

// Capture the request handlers the server registers so the test can invoke them directly.
type RequestHandler = (req: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<unknown>;
const capturedHandlers: RequestHandler[] = [];
const connectMock = vi.fn().mockResolvedValue(undefined);
// Capture the Server constructor's first arg so the test can assert name/version.
let serverInfo: { name: string; version: string } | undefined;

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
	Server: class {
		constructor(info: { name: string; version: string }) {
			serverInfo = info;
		}
		setRequestHandler(_schema: unknown, handler: RequestHandler) {
			capturedHandlers.push(handler);
		}
		connect = connectMock;
	},
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
	StdioServerTransport: class {},
}));

// The SDK request schemas are passed by reference to setRequestHandler; stub them as plain markers.
vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
	ListToolsRequestSchema: { kind: "list" },
	CallToolRequestSchema: { kind: "call" },
}));

import { VERSION } from "../commands/CliUtils.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { dispatchTool, startMcpServer, TOOL_DEFINITIONS } from "./McpServer.js";
import { runDecisionTimeline, runGetPrDescription, runListBranches, runRecall, runSearch } from "./McpTools.js";

describe("MCP tool registry", () => {
	it("declares exactly the five tools", () => {
		expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(
			["get_decision_timeline", "get_pr_description", "list_branches", "recall", "search"].sort(),
		);
	});

	it("each tool has an inputSchema object", () => {
		for (const t of TOOL_DEFINITIONS) {
			expect(t.inputSchema.type).toBe("object");
		}
	});
});

describe("dispatchTool", () => {
	it("routes search to runSearch with parsed args", async () => {
		await dispatchTool("/repo", "search", { query: "auth" });
		expect(runSearch).toHaveBeenCalledWith("/repo", { query: "auth" });
	});

	it("routes list_branches (no args) to runListBranches", async () => {
		await dispatchTool("/repo", "list_branches", {});
		expect(runListBranches).toHaveBeenCalledWith("/repo");
	});

	it("routes recall to runRecall with parsed args", async () => {
		await dispatchTool("/repo", "recall", { branch: "feat/x" });
		expect(runRecall).toHaveBeenCalledWith("/repo", { branch: "feat/x" });
	});

	it("routes get_decision_timeline to runDecisionTimeline with parsed args", async () => {
		await dispatchTool("/repo", "get_decision_timeline", { slug: "auth-flow" });
		expect(runDecisionTimeline).toHaveBeenCalledWith("/repo", { slug: "auth-flow" });
	});

	it("routes get_pr_description to runGetPrDescription with parsed args", async () => {
		await dispatchTool("/repo", "get_pr_description", {
			baseBranch: "main",
			includeMarkers: false,
		});
		expect(runGetPrDescription).toHaveBeenCalledWith("/repo", {
			baseBranch: "main",
			includeMarkers: false,
		});
	});

	it("throws on an unknown tool", async () => {
		await expect(dispatchTool("/repo", "nope", {})).rejects.toThrow(/unknown tool/i);
	});
});

describe("startMcpServer", () => {
	beforeEach(() => {
		capturedHandlers.length = 0;
		connectMock.mockClear();
	});

	it("connects the stdio transport and registers two request handlers", async () => {
		await startMcpServer("/repo");
		expect(connectMock).toHaveBeenCalledTimes(1);
		expect(capturedHandlers).toHaveLength(2);
	});

	it("ListTools handler returns the tool definitions", async () => {
		await startMcpServer("/repo");
		const listHandler = capturedHandlers[0];
		const result = (await listHandler({ params: { name: "" } })) as { tools: unknown[] };
		expect(result.tools).toBe(TOOL_DEFINITIONS);
	});

	it("CallTool handler dispatches a successful tool call to a text response", async () => {
		await startMcpServer("/repo");
		const callHandler = capturedHandlers[1];
		const result = (await callHandler({ params: { name: "search", arguments: { query: "x" } } })) as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(runSearch).toHaveBeenCalledWith("/repo", { query: "x" });
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0].text)).toEqual({ hits: [] });
	});

	it("CallTool handler returns an isError response when the handler throws", async () => {
		vi.mocked(runSearch).mockRejectedValueOnce(new Error("boom"));
		await startMcpServer("/repo");
		const callHandler = capturedHandlers[1];
		const result = (await callHandler({ params: { name: "search", arguments: { query: "x" } } })) as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text)).toEqual({ error: "boom" });
	});

	it("CallTool handler stringifies a non-Error throw into the error response", async () => {
		// A tool that rejects with a bare value (string / object) rather than an
		// Error — the `String(err)` fallback must still surface a message.
		// biome-ignore lint/suspicious/noExplicitAny: rejecting with a non-Error value is the point
		vi.mocked(runSearch).mockRejectedValueOnce("plain string failure" as any);
		await startMcpServer("/repo");
		const callHandler = capturedHandlers[1];
		const result = (await callHandler({ params: { name: "search", arguments: { query: "x" } } })) as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text)).toEqual({ error: "plain string failure" });
	});

	it("CallTool handler tolerates a missing arguments field", async () => {
		await startMcpServer("/repo");
		const callHandler = capturedHandlers[1];
		await callHandler({ params: { name: "list_branches" } });
		expect(runListBranches).toHaveBeenCalledWith("/repo");
	});

	it("establishes the configured storage backend before serving (so reads don't fall back to orphan)", async () => {
		// The long-lived server never set active storage, so every store read fell
		// through resolveStorage to the orphan branch — wrong for folder-mode users
		// and a per-call WARN in production. Wire the configured backend at startup.
		await startMcpServer("/repo");
		expect(createStorage).toHaveBeenCalledWith("/repo", "/repo");
		expect(setActiveStorage).toHaveBeenCalledWith(mockStorage);
	});

	it("names the server with the package version, not a hardcoded string", async () => {
		await startMcpServer("/repo");
		expect(serverInfo).toMatchObject({ name: "jollimemory", version: VERSION });
	});
});
