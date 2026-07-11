import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./McpTools.js", () => ({
	runSearch: vi.fn().mockResolvedValue({ hits: [] }),
	runRecall: vi.fn().mockResolvedValue({ type: "recall" }),
	runDecisionTimeline: vi.fn().mockResolvedValue({ timeline: [] }),
	runListBranches: vi.fn().mockResolvedValue({ branches: [] }),
	runGetPrDescription: vi.fn().mockResolvedValue({ type: "pr_description" }),
	runQueueStatus: vi.fn().mockResolvedValue({ active: 0, drained: true }),
	runPushMemory: vi.fn().mockResolvedValue({ type: "pushed", pushed: 0, skipped: 0, urls: [] }),
	runListSpaces: vi.fn().mockResolvedValue({ spaces: [], defaultSpaceId: null }),
	runBindSpace: vi.fn().mockResolvedValue({ type: "bound", bindingId: 1, jmSpaceId: 1, repoName: "acme" }),
}));

const { mockStorage } = vi.hoisted(() => ({ mockStorage: { kind: "mock-storage" } }));
vi.mock("../core/StorageFactory.js", () => ({ createStorage: vi.fn().mockResolvedValue(mockStorage) }));
vi.mock("../core/SummaryStore.js", () => ({ setActiveStorage: vi.fn() }));

// Capture the request handlers the server registers so the test can invoke them directly.
type RequestHandler = (req: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<unknown>;
const capturedHandlers: RequestHandler[] = [];
// Parallel to capturedHandlers: the (mocked) schema marker each handler was registered with.
const capturedSchemas: Array<{ kind: string }> = [];
const connectMock = vi.fn().mockResolvedValue(undefined);
// Capture the Server constructor's args so the test can assert name/version + capabilities.
let serverInfo: { name: string; version: string } | undefined;
let serverCapabilities: { tools?: unknown; prompts?: unknown } | undefined;

// Find the handler registered for a given schema marker kind (e.g. "listPrompts").
function handlerForKind(kind: string): RequestHandler | undefined {
	const idx = capturedSchemas.findIndex((s) => s?.kind === kind);
	return idx >= 0 ? capturedHandlers[idx] : undefined;
}

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
	Server: class {
		constructor(info: { name: string; version: string }, options?: { capabilities?: typeof serverCapabilities }) {
			serverInfo = info;
			serverCapabilities = options?.capabilities;
		}
		setRequestHandler(schema: { kind: string }, handler: RequestHandler) {
			capturedSchemas.push(schema);
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
	ListPromptsRequestSchema: { kind: "listPrompts" },
	GetPromptRequestSchema: { kind: "getPrompt" },
}));

// Gate the platform-tool path deterministically: default to "disabled" so the
// pre-existing tests exercise the dormant (git-memory-only) path without reading
// a real config off disk. Preserve every other SessionTracker export.
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../core/SessionTracker.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/SessionTracker.js")>();
	return { ...actual, loadConfig: loadConfigMock };
});

// Stub the backend client so the default `new JolliMemoryPushClient()` factory
// used when no createPlatformClient dep is supplied never opens a real socket.
const { fetchManifestMock, invokePlatformToolMock } = vi.hoisted(() => ({
	fetchManifestMock: vi.fn(),
	invokePlatformToolMock: vi.fn(),
}));
vi.mock("../core/JolliMemoryPushClient.js", () => ({
	JolliMemoryPushClient: class {
		fetchManifest = fetchManifestMock;
		invokePlatformTool = invokePlatformToolMock;
	},
}));

import { VERSION } from "../commands/CliUtils.js";
import type { PlatformToolManifestEntry } from "../core/JolliMemoryPushClient.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { dispatchTool, type PlatformToolClient, startMcpServer, TOOL_DEFINITIONS } from "./McpServer.js";
import {
	runBindSpace,
	runDecisionTimeline,
	runGetPrDescription,
	runListBranches,
	runListSpaces,
	runPushMemory,
	runQueueStatus,
	runRecall,
	runSearch,
} from "./McpTools.js";

describe("MCP tool registry", () => {
	it("declares exactly the nine tools", () => {
		expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(
			[
				"bind_space",
				"get_decision_timeline",
				"get_pr_description",
				"list_branches",
				"list_spaces",
				"push_memory",
				"queue_status",
				"recall",
				"search",
			].sort(),
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

	it("routes queue_status to runQueueStatus with parsed args", async () => {
		await dispatchTool("/repo", "queue_status", { wait: true, timeoutMs: 5000 });
		expect(runQueueStatus).toHaveBeenCalledWith("/repo", { wait: true, timeoutMs: 5000 });
	});

	it("routes push_memory to runPushMemory with parsed args", async () => {
		await dispatchTool("/repo", "push_memory", { baseBranch: "main", space: "acme" });
		expect(runPushMemory).toHaveBeenCalledWith("/repo", { baseBranch: "main", space: "acme" });
	});

	it("routes list_spaces (no args) to runListSpaces", async () => {
		await dispatchTool("/repo", "list_spaces", {});
		expect(runListSpaces).toHaveBeenCalledWith("/repo");
	});

	it("routes bind_space to runBindSpace with parsed args", async () => {
		await dispatchTool("/repo", "bind_space", { space: "acme" });
		expect(runBindSpace).toHaveBeenCalledWith("/repo", { space: "acme" });
	});

	it("throws on an unknown tool", async () => {
		await expect(dispatchTool("/repo", "nope", {})).rejects.toThrow(/unknown tool/i);
	});
});

describe("startMcpServer", () => {
	beforeEach(() => {
		capturedHandlers.length = 0;
		capturedSchemas.length = 0;
		serverCapabilities = undefined;
		connectMock.mockClear();
		loadConfigMock.mockReset().mockResolvedValue({});
		fetchManifestMock.mockReset();
		invokePlatformToolMock.mockReset();
	});

	it("connects the stdio transport and registers two request handlers", async () => {
		await startMcpServer("/repo");
		expect(connectMock).toHaveBeenCalledTimes(1);
		expect(capturedHandlers).toHaveLength(2);
	});

	it("advertises the tools capability only when no menu is active", async () => {
		await startMcpServer("/repo");
		expect(serverCapabilities).toEqual({ tools: {} });
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

	it("CallTool handler flags a structured {type:'error'} result as isError (push_memory contract parity)", async () => {
		// push_memory reports failure as a resolved { type: "error" } object rather
		// than throwing; the server must still mark it isError so its contract
		// matches the thrown-error path list_spaces/bind_space take.
		vi.mocked(runPushMemory).mockResolvedValueOnce({ type: "error", message: "Not signed in" });
		await startMcpServer("/repo");
		const callHandler = capturedHandlers[1];
		const result = (await callHandler({ params: { name: "push_memory", arguments: {} } })) as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text)).toEqual({ type: "error", message: "Not signed in" });
	});

	it("CallTool handler does NOT flag a binding_required result as isError (it's a needs-input outcome)", async () => {
		vi.mocked(runPushMemory).mockResolvedValueOnce({
			type: "binding_required",
			repoUrl: "https://github.com/o/r",
			spaces: [],
			defaultSpaceId: null,
		});
		await startMcpServer("/repo");
		const callHandler = capturedHandlers[1];
		const result = (await callHandler({ params: { name: "push_memory", arguments: {} } })) as { isError?: boolean };
		expect(result.isError).toBeUndefined();
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

describe("startMcpServer — platform tools", () => {
	const platA: PlatformToolManifestEntry = {
		name: "create_ticket",
		description: "Create a ticket",
		inputSchema: { type: "object", properties: {} },
	};
	const platB: PlatformToolManifestEntry = {
		name: "list_projects",
		description: "List projects",
		inputSchema: { type: "object", properties: {} },
	};

	function stubClient(tools: PlatformToolManifestEntry[]): PlatformToolClient {
		return { fetchManifest: async () => tools, invokePlatformTool: invokePlatformToolMock };
	}

	beforeEach(() => {
		capturedHandlers.length = 0;
		capturedSchemas.length = 0;
		serverCapabilities = undefined;
		connectMock.mockClear();
		loadConfigMock.mockReset().mockResolvedValue({});
		fetchManifestMock.mockReset();
		invokePlatformToolMock.mockReset();
		vi.mocked(runSearch).mockClear();
	});

	it("dormant by default: advertises exactly 9 tools and never constructs a client", async () => {
		const createPlatformClient = vi.fn();
		await startMcpServer("/repo", { loadConfig: async () => ({}), createPlatformClient });
		const list = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: unknown[] };
		expect(list.tools).toBe(TOOL_DEFINITIONS);
		expect(list.tools).toHaveLength(9);
		expect(createPlatformClient).not.toHaveBeenCalled();
		// A built-in still dispatches through the local table.
		await capturedHandlers[1]({ params: { name: "search", arguments: { query: "x" } } });
		expect(runSearch).toHaveBeenCalledWith("/repo", { query: "x" });
	});

	it("enabled: advertises the built-ins plus the manifest's platform tools", async () => {
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([platA, platB]),
		});
		const list = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: { name: string }[] };
		expect(list.tools).toHaveLength(11);
		expect(list.tools.map((t) => t.name)).toEqual(
			expect.arrayContaining(["create_ticket", "list_projects", "search"]),
		);
	});

	it("enabled: routes a platform tool call through the generic executor and wraps the result", async () => {
		invokePlatformToolMock.mockResolvedValue({ ok: true });
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([platA]),
		});
		const result = (await capturedHandlers[1]({
			params: { name: "create_ticket", arguments: { title: "x" } },
		})) as { content: { text: string }[]; isError?: boolean };
		expect(invokePlatformToolMock).toHaveBeenCalledWith(platA, { title: "x" });
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
	});

	it("enabled: a platform tool call with no arguments defaults to {}", async () => {
		invokePlatformToolMock.mockResolvedValue({ ok: true });
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([platA]),
		});
		await capturedHandlers[1]({ params: { name: "create_ticket" } });
		expect(invokePlatformToolMock).toHaveBeenCalledWith(platA, {});
	});

	it("enabled: flags a platform tool's {type:'error'} result as isError", async () => {
		invokePlatformToolMock.mockResolvedValue({ type: "error", message: "bad args" });
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([platA]),
		});
		const result = (await capturedHandlers[1]({ params: { name: "create_ticket", arguments: {} } })) as {
			content: { text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text)).toEqual({ type: "error", message: "bad args" });
	});

	it("enabled: wraps a thrown platform tool error as an isError response", async () => {
		invokePlatformToolMock.mockRejectedValue(new Error("relay failed"));
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([platA]),
		});
		const result = (await capturedHandlers[1]({ params: { name: "create_ticket", arguments: {} } })) as {
			content: { text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text)).toEqual({ error: "relay failed" });
	});

	it("enabled but empty/failed manifest: falls back to exactly the 9 built-ins and still connects", async () => {
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([]),
		});
		const list = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: unknown[] };
		expect(list.tools).toBe(TOOL_DEFINITIONS);
		expect(list.tools).toHaveLength(9);
		expect(connectMock).toHaveBeenCalledTimes(1);
	});

	it("enabled: drops a platform tool that collides with a built-in name; the built-in stays reachable", async () => {
		const collide: PlatformToolManifestEntry = {
			name: "search",
			description: "backend search",
			inputSchema: { type: "object", properties: {} },
		};
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([collide, platA]),
		});
		const list = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: { name: string }[] };
		expect(list.tools).toHaveLength(10);
		expect(list.tools.filter((t) => t.name === "search")).toHaveLength(1);
		// "search" hits the built-in handler, not the generic executor.
		await capturedHandlers[1]({ params: { name: "search", arguments: { query: "x" } } });
		expect(runSearch).toHaveBeenCalledWith("/repo", { query: "x" });
		expect(invokePlatformToolMock).not.toHaveBeenCalled();
	});

	it("enabled: dedupes duplicate platform tool names (first wins in both list and dispatch)", async () => {
		const first: PlatformToolManifestEntry = {
			name: "create_ticket",
			description: "first",
			inputSchema: { type: "object", properties: {} },
		};
		const second: PlatformToolManifestEntry = {
			name: "create_ticket",
			description: "second (duplicate)",
			inputSchema: { type: "object", properties: {} },
		};
		invokePlatformToolMock.mockResolvedValue({ ok: true });
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([first, second]),
		});
		const list = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: { name: string }[] };
		// Exactly one create_ticket advertised (9 built-ins + 1) — no duplicate in tools/list.
		expect(list.tools).toHaveLength(10);
		expect(list.tools.filter((t) => t.name === "create_ticket")).toHaveLength(1);
		// tools/call runs the FIRST entry, matching what a client sees in tools/list.
		await capturedHandlers[1]({ params: { name: "create_ticket", arguments: {} } });
		expect(invokePlatformToolMock).toHaveBeenCalledWith(first, {});
	});

	it("enabled without a client dep: uses the default real-client factory to fetch the manifest", async () => {
		fetchManifestMock.mockResolvedValue([platA]);
		await startMcpServer("/repo", { loadConfig: async () => ({ mcpPlatformToolsEnabled: true }) });
		const list = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: unknown[] };
		expect(fetchManifestMock).toHaveBeenCalled();
		expect(list.tools).toHaveLength(10);
	});

	// --- /jolli menu prompt (JOLLI-1925) ---

	const platMenu: PlatformToolManifestEntry = {
		name: "create_ticket",
		description: "Create a ticket",
		inputSchema: { type: "object", properties: {} },
		menu: { label: "Create ticket", description: "Open a new ticket" },
	};

	it("enabled + a menu-flagged tool: advertises the prompts capability and lists exactly [jolli]", async () => {
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([platMenu, platB]),
		});
		expect(serverCapabilities).toEqual({ tools: {}, prompts: {} });
		const listPrompts = handlerForKind("listPrompts");
		expect(listPrompts).toBeDefined();
		const result = (await listPrompts?.({ params: { name: "" } })) as {
			prompts: { name: string; arguments: { name: string; required?: boolean }[] }[];
		};
		expect(result.prompts).toHaveLength(1);
		expect(result.prompts[0].name).toBe("jolli");
		expect(result.prompts[0].arguments).toEqual([expect.objectContaining({ name: "request", required: false })]);
	});

	it("GetPrompt with no request: returns a picker steering message listing the menu", async () => {
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([platMenu]),
		});
		const getPrompt = handlerForKind("getPrompt");
		const result = (await getPrompt?.({ params: { name: "jolli" } })) as {
			messages: { role: string; content: { type: string; text: string } }[];
		};
		const text = result.messages[0].content.text;
		expect(result.messages[0].role).toBe("user");
		expect(text).toContain("without a specific request");
		expect(text).toContain("Create ticket — Open a new ticket (call tool `create_ticket`)");
	});

	it("GetPrompt with a request: returns a direct-invoke steering message", async () => {
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([platMenu]),
		});
		const getPrompt = handlerForKind("getPrompt");
		const result = (await getPrompt?.({
			params: { name: "jolli", arguments: { request: "make a ticket" } },
		})) as { messages: { content: { text: string } }[] };
		expect(result.messages[0].content.text).toContain('with this request: "make a ticket"');
		expect(result.messages[0].content.text).toContain("invoke its MCP tool directly");
	});

	it("GetPrompt rejects an unknown prompt name", async () => {
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([platMenu]),
		});
		const getPrompt = handlerForKind("getPrompt");
		await expect(getPrompt?.({ params: { name: "nope" } })).rejects.toThrow(/unknown prompt/i);
	});

	it("enabled but no menu-flagged tools: no prompts capability and no prompt handlers", async () => {
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([platA, platB]),
		});
		expect(serverCapabilities).toEqual({ tools: {} });
		expect(handlerForKind("listPrompts")).toBeUndefined();
		expect(handlerForKind("getPrompt")).toBeUndefined();
		expect(capturedHandlers).toHaveLength(2);
	});

	it("gate off: no prompts capability even if a manifest tool would be menu-flagged", async () => {
		const createPlatformClient = vi.fn();
		await startMcpServer("/repo", { loadConfig: async () => ({}), createPlatformClient });
		expect(serverCapabilities).toEqual({ tools: {} });
		expect(handlerForKind("getPrompt")).toBeUndefined();
	});
});
