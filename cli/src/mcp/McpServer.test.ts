import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./McpTools.js", () => ({
	runSearch: vi.fn().mockResolvedValue({ hits: [] }),
	runRecall: vi.fn().mockResolvedValue({ type: "recall" }),
	runDecisionTimeline: vi.fn().mockResolvedValue({ timeline: [] }),
	runListBranches: vi.fn().mockResolvedValue({ branches: [] }),
	runGetPrDescription: vi.fn().mockResolvedValue({ type: "pr_description" }),
	runQueueStatus: vi.fn().mockResolvedValue({ active: 0, drained: true }),
	runStatus: vi.fn().mockResolvedValue({ version: "1.0.0", enabled: true }),
	runPushMemory: vi.fn().mockResolvedValue({ type: "pushed", pushed: 0, skipped: 0, urls: [] }),
	runListSpaces: vi.fn().mockResolvedValue({ spaces: [], defaultSpaceId: null }),
	runBindSpace: vi.fn().mockResolvedValue({ type: "bound", bindingId: 1, jmSpaceId: 1, repoName: "acme" }),
}));

// `startMcpServer` withholds every `requiresRepo` tool when the cwd is not inside a git
// worktree, so any test that expects the full tool set needs this to answer true.
// Mocked rather than given a real temp repo: these tests pass synthetic paths like
// "/repo", and spawning git per case would put this file in the slow tier for no added
// coverage.
const { probeWorktreeMock } = vi.hoisted(() => ({ probeWorktreeMock: vi.fn().mockResolvedValue("inside") }));
vi.mock("../core/GitOps.js", () => ({ probeWorktree: probeWorktreeMock }));

const { mockStorage } = vi.hoisted(() => ({ mockStorage: { kind: "mock-storage" } }));
vi.mock("../core/StorageFactory.js", () => ({ createStorage: vi.fn().mockResolvedValue(mockStorage) }));
vi.mock("../core/SummaryStore.js", () => ({ setActiveStorage: vi.fn() }));
// The CallTool handler re-checks the cutover state before a repo-scoped built-in;
// stub it so these tests don't need real storage, and so ordering can be asserted.
const { ensureHealMock, clearThrottleMock } = vi.hoisted(() => ({
	ensureHealMock: vi.fn().mockResolvedValue(undefined),
	clearThrottleMock: vi.fn(),
}));
vi.mock("../core/ActiveStorageHeal.js", () => ({
	ensureActiveStorageMatchesRoute: ensureHealMock,
	clearActiveStorageHealThrottle: clearThrottleMock,
}));
// The CallTool handler emits per-tool telemetry; spy on track().
vi.mock("../core/Telemetry.js", () => ({ track: vi.fn() }));

// Capture the request handlers the server registers so the test can invoke them directly.
type RequestHandler = (req: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<unknown>;
const capturedHandlers: RequestHandler[] = [];
// Parallel to capturedHandlers: the (mocked) schema marker each handler was registered with.
const capturedSchemas: Array<{ kind: string }> = [];
const connectMock = vi.fn().mockResolvedValue(undefined);
// Capture the Server constructor's args so the test can assert name/version + capabilities.
let serverInfo: { name: string; version: string } | undefined;
let serverCapabilities: { tools?: unknown; prompts?: unknown } | undefined;
// The per-connection clientInfo the SDK exposes after `initialize`; tests set
// this to simulate what a host declared on this connection. Reset per test.
let mockClientInfo: { name: string; version: string } | undefined;
const capturedServers: Array<{ oninitialized?: () => void }> = [];

// Find the handler registered for a given schema marker kind (e.g. "listPrompts").
function handlerForKind(kind: string): RequestHandler | undefined {
	const idx = capturedSchemas.findIndex((s) => s?.kind === kind);
	return idx >= 0 ? capturedHandlers[idx] : undefined;
}

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
	Server: class {
		oninitialized?: () => void;
		getClientVersion() {
			return mockClientInfo;
		}
		constructor(info: { name: string; version: string }, options?: { capabilities?: typeof serverCapabilities }) {
			serverInfo = info;
			serverCapabilities = options?.capabilities;
			capturedServers.push(this);
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
import { OrphanBranchFrozenError } from "../core/OrphanBranchStorage.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { track } from "../core/Telemetry.js";
import { getLogDir, resetLogDir } from "../Logger.js";
import {
	dispatchTool,
	isPluginBundleCwd,
	type PlatformToolClient,
	prepareMcpRuntime,
	rebuildPlatformHalf,
	startMcpServer,
	TOOL_DEFINITIONS,
} from "./McpServer.js";
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
	runStatus,
} from "./McpTools.js";

describe("MCP tool registry", () => {
	it("declares exactly the ten tools", () => {
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
				"status",
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

	it("routes status (no args) to runStatus", async () => {
		await dispatchTool("/repo", "status", {});
		expect(runStatus).toHaveBeenCalledWith("/repo");
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
		capturedServers.length = 0;
		mockClientInfo = undefined;
		serverCapabilities = undefined;
		connectMock.mockClear();
		probeWorktreeMock.mockReset().mockResolvedValue("inside");
		// Platform tools are on by default, so pin these built-in-only tests to the
		// dormant (git-memory-only) path with an explicit opt-out; otherwise the
		// default-on gate would open and hit the unstubbed manifest fetch.
		loadConfigMock.mockReset().mockResolvedValue({ mcpPlatformToolsEnabled: false });
		fetchManifestMock.mockReset();
		invokePlatformToolMock.mockReset();
		vi.mocked(track).mockClear();
		ensureHealMock.mockClear();
		clearThrottleMock.mockClear();
		// Clean baseline for the log-dir anchoring assertions below.
		resetLogDir();
	});

	it("connects the stdio transport and registers two request handlers", async () => {
		await startMcpServer("/repo");
		expect(connectMock).toHaveBeenCalledTimes(1);
		expect(capturedHandlers).toHaveLength(2);
		// The server anchors the Logger's global dir to its (git-root) cwd so every
		// tool-call log line lands in the repo's `.jolli/`, not a stray store under a
		// subdirectory it was launched from.
		expect(getLogDir()).toBe("/repo");
	});

	it("advertises the tools capability only when no menu is active", async () => {
		await startMcpServer("/repo");
		expect(serverCapabilities).toEqual({ tools: {} });
	});

	/*
	 * The classification itself, pinned as an exact partition.
	 *
	 * `requiresRepo` is a required field, so TypeScript already stops a new tool from
	 * omitting it — but not from declaring it WRONG, and wrong in the `false` direction
	 * is silent: the tool stays advertised outside a repository and answers from
	 * `StorageFactory`'s orphan-only fallback, empty-but-successful, which is exactly
	 * the reading the withholding exists to prevent. Spelling both sides out makes
	 * flipping one a deliberate edit to this list rather than a one-character change
	 * nothing observes.
	 *
	 * `list_spaces` is the only built-in on the repo-independent side: it asks the
	 * backend what Spaces the TENANT has, taking nothing from cwd. `bind_space` and
	 * `push_memory` also talk to the backend but are repo-scoped — they bind *this*
	 * repository and push *this* branch.
	 */
	it("classifies every built-in tool as repo-scoped or not", () => {
		const partition = (requiresRepo: boolean) =>
			TOOL_DEFINITIONS.filter((t) => t.requiresRepo === requiresRepo)
				.map((t) => t.name)
				.sort();
		expect(partition(false)).toEqual(["list_spaces"]);
		expect(partition(true)).toEqual([
			"bind_space",
			"get_decision_timeline",
			"get_pr_description",
			"list_branches",
			"push_memory",
			"queue_status",
			"recall",
			"search",
			"status",
		]);
	});

	it("ListTools handler returns the tool definitions", async () => {
		await startMcpServer("/repo");
		const listHandler = capturedHandlers[0];
		const result = (await listHandler({ params: { name: "" } })) as { tools: { name: string }[] };
		expect(result.tools.map((t) => t.name)).toEqual(TOOL_DEFINITIONS.map((t) => t.name));
	});

	// `requiresRepo` decides what is advertised; it is not part of the advertisement.
	// The platform-tool path already projected its entries down to the public keys to
	// keep `binding` / `menu` off the wire, and the built-ins are now held to the same
	// rule — a client has no use for it and the MCP tool schema has no field for it.
	// `readOnly` is internal too: it reaches the wire only as `annotations.readOnlyHint`.
	it("ListTools never leaks the internal requiresRepo / readOnly flags onto the wire", async () => {
		await startMcpServer("/repo");
		const result = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: object[] };
		for (const tool of result.tools) {
			expect(Object.keys(tool).sort()).toEqual(["annotations", "description", "inputSchema", "name"]);
		}
	});

	/*
	 * The read-only classification, pinned as an exact partition — same reasoning as
	 * the repo-scoped one above, with the risk pointing the other way.
	 *
	 * A tool wrongly marked read-only is the dangerous direction: on a host gating an
	 * untrusted server it buys an exemption from the approval prompt the operator
	 * configured. Only the two tools that mutate anything are on the false side —
	 * `bind_space` writes this repo's Space binding, `push_memory` publishes its
	 * summaries. Everything else, including the backend-reading `list_spaces` and the
	 * possibly-blocking `queue_status`, only reads.
	 */
	it("classifies every built-in tool as read-only or write-capable", () => {
		const partition = (readOnly: boolean) =>
			TOOL_DEFINITIONS.filter((t) => t.readOnly === readOnly)
				.map((t) => t.name)
				.sort();
		expect(partition(false)).toEqual(["bind_space", "push_memory"]);
		expect(partition(true)).toEqual([
			"get_decision_timeline",
			"get_pr_description",
			"list_branches",
			"list_spaces",
			"queue_status",
			"recall",
			"search",
			"status",
		]);
	});

	// The hint a host actually consults. Hermes 0.21.0 treats anything without
	// `readOnlyHint === true` as write-capable and routes it through an approval
	// prompt, so an absent block gates all ten — including `recall`.
	it("ListTools advertises readOnlyHint on both sides of the classification", async () => {
		await startMcpServer("/repo");
		const result = (await capturedHandlers[0]({ params: { name: "" } })) as {
			tools: { name: string; annotations?: { readOnlyHint?: boolean } }[];
		};
		const hint = (name: string) => result.tools.find((t) => t.name === name)?.annotations?.readOnlyHint;
		expect(hint("recall")).toBe(true);
		expect(hint("list_branches")).toBe(true);
		expect(hint("push_memory")).toBe(false);
		expect(hint("bind_space")).toBe(false);
		// Every advertised built-in carries the block — absence is what fails closed.
		for (const tool of result.tools) {
			expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
		}
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

	it("CallTool re-checks the cutover state before a repo-scoped built-in, and before dispatch", async () => {
		let healedBeforeDispatch = false;
		vi.mocked(runSearch).mockImplementationOnce(async () => {
			healedBeforeDispatch = ensureHealMock.mock.calls.length > 0;
			return { hits: [] };
		});
		await startMcpServer("/repo");
		await capturedHandlers[1]({ params: { name: "search", arguments: { query: "x" } } });
		expect(ensureHealMock).toHaveBeenCalledWith("/repo");
		expect(healedBeforeDispatch).toBe(true);
	});

	it("CallTool does NOT re-check the cutover state for a built-in that needs no repo (list_spaces)", async () => {
		await startMcpServer("/repo");
		await capturedHandlers[1]({ params: { name: "list_spaces", arguments: {} } });
		expect(ensureHealMock).not.toHaveBeenCalled();
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

	it("CallTool self-heals and retries once when a repo-scoped tool hits the frozen branch", async () => {
		// A cutover that landed inside the heal's throttle window leaves the tool
		// dispatching against the frozen orphan branch. The typed error clears the
		// back-off, re-heals (now unthrottled), and retries so the caller sees success.
		vi.mocked(runSearch)
			.mockRejectedValueOnce(new OrphanBranchFrozenError("orphan branch is frozen"))
			.mockResolvedValueOnce({ hits: [] });
		await startMcpServer("/repo");
		const result = (await capturedHandlers[1]({ params: { name: "search", arguments: { query: "x" } } })) as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(clearThrottleMock).toHaveBeenCalledWith("/repo");
		// Healed once before the first attempt, once more before the retry.
		expect(ensureHealMock).toHaveBeenCalledTimes(2);
		expect(runSearch).toHaveBeenCalledTimes(2);
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0].text)).toEqual({ hits: [] });
	});

	it("CallTool surfaces the frozen error when the single retry also fails", async () => {
		// Two `Once`s, not a persistent reject: the retry consumes the second, and
		// nothing leaks into the next test's runSearch.
		vi.mocked(runSearch)
			.mockRejectedValueOnce(new OrphanBranchFrozenError("orphan branch is frozen"))
			.mockRejectedValueOnce(new OrphanBranchFrozenError("orphan branch is frozen"));
		await startMcpServer("/repo");
		const result = (await capturedHandlers[1]({ params: { name: "search", arguments: { query: "x" } } })) as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(clearThrottleMock).toHaveBeenCalledTimes(1);
		expect(runSearch).toHaveBeenCalledTimes(2); // one retry, then give up
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text)).toEqual({ error: "orphan branch is frozen" });
	});

	it("CallTool does NOT clear the throttle or retry for a non-frozen error", async () => {
		vi.mocked(runSearch).mockRejectedValueOnce(new Error("boom"));
		await startMcpServer("/repo");
		await capturedHandlers[1]({ params: { name: "search", arguments: { query: "x" } } });
		expect(clearThrottleMock).not.toHaveBeenCalled();
		expect(runSearch).toHaveBeenCalledTimes(1);
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

	it("CallTool emits per-tool telemetry (tool name + ok=true), never the arguments", async () => {
		await startMcpServer("/repo");
		await capturedHandlers[1]({ params: { name: "search", arguments: { query: "acme-secret/repo/path" } } });
		expect(track).toHaveBeenCalledWith(
			"command_invoked",
			expect.objectContaining({ command: "mcp", tool: "search", ok: true }),
		);
		const props = vi.mocked(track).mock.calls[0][1] as Record<string, unknown>;
		expect(typeof props.duration_ms).toBe("number");
		// The tool's arguments must never reach telemetry (they may carry user content).
		expect(props).not.toHaveProperty("arguments");
		expect(JSON.stringify(props)).not.toContain("acme-secret");
	});

	it("CallTool telemetry reports ok=false when the tool throws", async () => {
		vi.mocked(runSearch).mockRejectedValueOnce(new Error("boom"));
		await startMcpServer("/repo");
		await capturedHandlers[1]({ params: { name: "search", arguments: {} } });
		expect(track).toHaveBeenCalledWith(
			"command_invoked",
			expect.objectContaining({ command: "mcp", tool: "search", ok: false }),
		);
	});

	it("CallTool telemetry reports ok=false for a structured {type:'error'} result", async () => {
		vi.mocked(runPushMemory).mockResolvedValueOnce({ type: "error", message: "Not signed in" });
		await startMcpServer("/repo");
		await capturedHandlers[1]({ params: { name: "push_memory", arguments: {} } });
		expect(track).toHaveBeenCalledWith(
			"command_invoked",
			expect.objectContaining({ command: "mcp", tool: "push_memory", ok: false }),
		);
	});

	it("CallTool telemetry folds an unknown (client-controlled) tool name to 'unknown'", async () => {
		await startMcpServer("/repo");
		// `name` is free text chosen by the MCP client; an unknown tool throws
		// `Unknown tool: …` and hits the catch path. The raw name must never reach
		// telemetry — only our own fixed identifiers, or "unknown".
		await capturedHandlers[1]({ params: { name: "acme-secret-exfil-tool", arguments: {} } });
		expect(track).toHaveBeenCalledWith(
			"command_invoked",
			expect.objectContaining({ command: "mcp", tool: "unknown", ok: false }),
		);
		const props = vi.mocked(track).mock.calls[0][1] as Record<string, unknown>;
		expect(JSON.stringify(props)).not.toContain("acme-secret-exfil-tool");
	});

	it("attributes a tool call to the connection's self-declared client (clientInfo → agent)", async () => {
		// The only signal that survives the shared mcp-serve daemon, where several
		// hosts' sessions reach ONE process and env inference is off: the
		// initialize handshake is per-connection. `claude-code` is a measured
		// clientInfo string (claude 2.1.212), not a guess.
		mockClientInfo = { name: "claude-code", version: "2.1.212" };
		await startMcpServer("/repo");
		await capturedHandlers[1]({ params: { name: "search", arguments: { query: "x" } } });
		expect(track).toHaveBeenCalledWith(
			"command_invoked",
			expect.objectContaining({ command: "mcp", tool: "search", ok: true, agent: "claude" }),
		);
	});

	it("attributes the failure path too, with the same connection's agent", async () => {
		mockClientInfo = { name: "codex-mcp-client", version: "0.147.0" };
		vi.mocked(runSearch).mockRejectedValueOnce(new Error("boom"));
		await startMcpServer("/repo");
		await capturedHandlers[1]({ params: { name: "search", arguments: {} } });
		expect(track).toHaveBeenCalledWith(
			"command_invoked",
			expect.objectContaining({ command: "mcp", tool: "search", ok: false, agent: "codex" }),
		);
	});

	it("omits agent for an unmapped clientInfo name rather than passing it through", async () => {
		// clientInfo.name is a host-authored arbitrary string; only measured,
		// mapped names may reach the wire. "Cursor" is real (cursor-agent declares
		// it) and deliberately unmapped — see CLIENTINFO_AGENTS.
		mockClientInfo = { name: "Cursor", version: "1.0.0" };
		await startMcpServer("/repo");
		await capturedHandlers[1]({ params: { name: "search", arguments: {} } });
		const props = vi.mocked(track).mock.calls[0][1] as Record<string, unknown>;
		expect(props).not.toHaveProperty("agent");
		expect(JSON.stringify(props)).not.toContain("Cursor");
	});

	it("omits agent when the client sent no clientInfo at all", async () => {
		mockClientInfo = undefined;
		await startMcpServer("/repo");
		await capturedHandlers[1]({ params: { name: "search", arguments: {} } });
		expect(vi.mocked(track).mock.calls[0][1]).not.toHaveProperty("agent");
	});

	it("logs each connection's clientInfo on initialize (the capture instrument)", async () => {
		// The organic capture point for the NEXT host's exact string: hosts' own
		// logs record only the server's info, never their own clientInfo, so this
		// line is the only place an unmapped name surfaces. Must never throw —
		// with or without clientInfo present.
		await startMcpServer("/repo");
		const server = capturedServers[0];
		expect(server.oninitialized).toBeTypeOf("function");
		mockClientInfo = { name: "some-future-host", version: "9.9.9" };
		expect(() => server.oninitialized?.()).not.toThrow();
		mockClientInfo = undefined;
		expect(() => server.oninitialized?.()).not.toThrow();
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

	it("no-ops entirely when running as a local-agent child", async () => {
		// The local-agent backend spawns `claude` in a throwaway temp cwd marked
		// JOLLI_LOCAL_AGENT_CHILD=1; a globally-installed jolli plugin then spawns
		// `jolli mcp` there. Without this guard, createStorage roots a FolderStorage
		// at <localFolder>/<tempDirName>/, claiming a spurious Memory Bank "repo" per
		// summary call. The child denies all tools, so no MCP tool is ever invoked —
		// the whole server must no-op, mirroring the SessionStart/Stop/enable guards.
		vi.mocked(createStorage).mockClear();
		vi.mocked(setActiveStorage).mockClear();
		process.env.JOLLI_LOCAL_AGENT_CHILD = "1";
		try {
			await startMcpServer("/tmp/jolli-localagent-abc123");
		} finally {
			delete process.env.JOLLI_LOCAL_AGENT_CHILD;
		}
		expect(createStorage).not.toHaveBeenCalled();
		expect(setActiveStorage).not.toHaveBeenCalled();
		expect(connectMock).not.toHaveBeenCalled();
		// Order invariant: setLogDir(cwd) must run AFTER this early return, so the
		// throwaway temp cwd never becomes the global log dir.
		expect(getLogDir()).toBeUndefined();
	});

	/*
	 * Same failure mode as the guard above, reached from the other direction: an AI
	 * host launching this server from a plugin BUNDLE instead of the user's repo. Every
	 * memory tool derives its repository from `cwd`, so such a server answers `recall`
	 * / `search` / `status` for the plugin's cache directory — successfully, and empty
	 * — and roots a placeholder Memory Bank repo named after the bundle's version
	 * directory. Refusing is strictly better than answering for the wrong project.
	 *
	 * Measured on codex-cli 0.146.0: a plugin `.mcp.json` (which must pin `cwd: "."`
	 * for its relative command to resolve) gets the plugin root as cwd, and neither the
	 * `roots` capability nor the 7-variable env allowlist can recover the workspace. No
	 * shipped Jolli plugin has such a manifest — this makes reintroducing one fail loud.
	 */
	it("refuses to start when launched from an AI-host plugin bundle", async () => {
		vi.mocked(createStorage).mockClear();
		vi.mocked(setActiveStorage).mockClear();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		let written: string;
		try {
			await startMcpServer("/Users/dev/.codex/plugins/cache/jolli-marketplace/jolli/1.0.0");
			// Read the calls BEFORE restoring: mockRestore also resets the call log.
			written = stderr.mock.calls.map((call) => String(call[0])).join("");
		} finally {
			stderr.mockRestore();
		}
		expect(createStorage).not.toHaveBeenCalled();
		expect(setActiveStorage).not.toHaveBeenCalled();
		expect(connectMock).not.toHaveBeenCalled();
		// Same order invariant as above — the bundle path must never become the log dir.
		expect(getLogDir()).toBeUndefined();
		// The host surfaces a server that would not start; the reason has to reach the
		// developer somewhere, and stderr is the only channel a stdio server may use
		// (stdout is the JSON-RPC stream).
		expect(written).toContain("refusing to start");
		expect(written).toContain(".codex/plugins/cache");
	});

	/*
	 * The general form of the guard above, and a REAL production failure rather than a
	 * hypothetical one.
	 *
	 * Cursor imports Claude plugins wholesale under its `enable_cc_plugin_import` gate,
	 * `.mcp.json` included — and it spawns MCP servers from a shared process before any
	 * workspace folder is known, so the child inherits the host's own cwd. On a real
	 * install that was the user's HOME directory: the Claude plugin's server came up
	 * rooted at `/Users/<me>`, logged "Successfully connected", and answered every tool
	 * from `StorageFactory`'s orphan-only fallback — empty results indistinguishable
	 * from real ones. The bundle guard cannot catch it (HOME is not a bundle path), and
	 * nothing in that launch can recover the workspace.
	 *
	 * Unlike the two guards above this one FILTERS rather than refuses, and the
	 * difference is not cosmetic. A bundle cache and an agent temp dir are wrong about
	 * everything a tool could answer; "not a git repo" is wrong only about the
	 * repo-scoped tools. `list_spaces` and every platform tool are pure backend calls
	 * (`invokePlatformTool` takes nothing from cwd), and nine of the eleven MCP hosts
	 * register machine-globally — so refusing wholesale took the entire Space and
	 * workflow surface offline in any non-repo directory, to protect nine tools that
	 * withholding protects better.
	 */
	it("starts without the repo-scoped tools when the cwd is not inside a git worktree", async () => {
		probeWorktreeMock.mockResolvedValue("outside");
		vi.mocked(createStorage).mockClear();
		vi.mocked(setActiveStorage).mockClear();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		let written: string;
		try {
			await startMcpServer("/Users/dev");
			written = stderr.mock.calls.map((call) => String(call[0])).join("");
		} finally {
			stderr.mockRestore();
		}
		// The server DOES come up now — that is the whole change.
		expect(connectMock).toHaveBeenCalledTimes(1);
		const listed = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: { name: string }[] };
		const names = listed.tools.map((t) => t.name);
		expect(names).toEqual(["list_spaces"]);
		for (const withheld of TOOL_DEFINITIONS.filter((t) => t.requiresRepo)) {
			expect(names, `${withheld.name} must not be advertised`).not.toContain(withheld.name);
		}

		// Still skipped, and for reasons the filtering did not change: the log dir is
		// `<cwd>/.jolli/`, so a non-repo cwd would litter whatever directory the host
		// launched from (HOME, in the measured case), and nothing that reads through
		// storage is reachable when every storage-backed tool is withheld.
		expect(createStorage).not.toHaveBeenCalled();
		expect(setActiveStorage).not.toHaveBeenCalled();
		expect(getLogDir()).toBeUndefined();

		// The reason still has to reach the developer — stderr is the only channel a
		// stdio server may use, since stdout is the JSON-RPC stream.
		expect(written).toContain("not inside a git worktree");
		expect(written).toContain("WITHOUT its repository tools");
		expect(written).toContain("/Users/dev");
		expect(written).toContain("before it knew which workspace was open");
	});

	/*
	 * The third probe state, and the reason it is not folded into "outside".
	 *
	 * `execGit` reports a missing binary as exit 127 rather than throwing, and a daemon
	 * spawned by a GUI-launched IDE really does inherit a PATH with no `git` on it. The
	 * withholding is right either way — without git, storage cannot resolve a repository
	 * either — but reporting it as "this directory is not a repo" sends the user to
	 * check the one thing that is not wrong.
	 */
	it("names a missing git as the reason instead of blaming the directory", async () => {
		probeWorktreeMock.mockResolvedValue("git-unavailable");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		let written: string;
		try {
			await startMcpServer("/repo");
			written = stderr.mock.calls.map((call) => String(call[0])).join("");
		} finally {
			stderr.mockRestore();
		}
		// Same protection…
		const listed = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: { name: string }[] };
		expect(listed.tools.map((t) => t.name)).toEqual(["list_spaces"]);
		// …different explanation.
		expect(written).toContain("`git` could not be executed");
		expect(written).toContain("stripped PATH");
		expect(written).not.toContain("is not inside a git worktree");
	});

	/*
	 * The predicate is `--is-inside-work-tree`'s STDOUT, not `rev-parse --git-dir`'s exit
	 * code. Measured: in a bare repo and inside `.git/` itself the exit code is 0 while
	 * the answer is `false`, and both then fail `StorageFactory`'s stricter
	 * claimable-project check — so an exit-code gate would advertise the repo tools into
	 * exactly the empty-but-successful hole this guard closes. `probeWorktree` owns that
	 * distinction; this asserts the server acts on it rather than on "any git context".
	 */
	it("withholds in a git context that is not a working tree", async () => {
		probeWorktreeMock.mockResolvedValue("outside");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			await startMcpServer("/repo/.git");
		} finally {
			stderr.mockRestore();
		}
		const listed = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: { name: string }[] };
		expect(listed.tools.map((t) => t.name)).toEqual(["list_spaces"]);
	});

	// Backstop for a client working from a cached tools/list. Without it the call
	// reaches dispatchTool against a non-repo cwd and comes back empty-but-successful,
	// which is the exact reading the withholding exists to prevent.
	it("refuses a repo-scoped tool CALL outside a worktree instead of answering empty", async () => {
		probeWorktreeMock.mockResolvedValue("outside");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			await startMcpServer("/Users/dev");
		} finally {
			stderr.mockRestore();
		}
		const result = (await capturedHandlers[1]({ params: { name: "recall", arguments: {} } })) as {
			content: { text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("needs a git repository");
		expect(runRecall).not.toHaveBeenCalled();
	});

	// An unrecognised name must still be reported as unknown, not as a repo problem —
	// the backstop checks the real registry rather than assuming any unlisted name is
	// something it withheld.
	it("still reports an unknown tool as unknown outside a worktree", async () => {
		probeWorktreeMock.mockResolvedValue("outside");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			await startMcpServer("/Users/dev");
		} finally {
			stderr.mockRestore();
		}
		const result = (await capturedHandlers[1]({ params: { name: "no_such_tool", arguments: {} } })) as {
			content: { text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Unknown tool");
	});

	// The order matters: the bundle check is a pure string test and must not be masked
	// by a git spawn, and a bundle cache that IS a real checkout (a marketplace served
	// over git) would otherwise pass the worktree test and be served.
	it("reports the bundle reason, not the worktree reason, for a plugin cache that is a real checkout", async () => {
		probeWorktreeMock.mockResolvedValue("inside");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		let written: string;
		try {
			await startMcpServer("/Users/dev/.claude/plugins/cache/jolli-marketplace/jolli/1.0.2");
			written = stderr.mock.calls.map((call) => String(call[0])).join("");
		} finally {
			stderr.mockRestore();
		}
		expect(connectMock).not.toHaveBeenCalled();
		expect(written).toContain("plugin bundle");
		expect(written).not.toContain("WITHOUT its repository tools");
		// Refused before the git probe — the string test is cheaper and more specific.
		expect(probeWorktreeMock).not.toHaveBeenCalled();
	});
});

describe("isPluginBundleCwd", () => {
	it.each([
		["/Users/dev/.codex/plugins/cache/jolli-marketplace/jolli/1.0.0", true],
		["/Users/dev/.claude/plugins/cache/jolli/jolli/2.3.4", true],
		// Cursor's local plugin directory is the one a developer actually points at by
		// hand (`~/.cursor/plugins/local/<name>`), so it is the likeliest way to launch
		// a server from a bundle rather than a repository.
		["/Users/dev/.cursor/plugins/local/jolli", true],
		// Windows separators reach us verbatim from the host's spawn.
		["C:\\Users\\dev\\.codex\\plugins\\cache\\mp\\jolli\\1.0.0", true],
		["C:\\Users\\dev\\.cursor\\plugins\\local\\jolli", true],
		["/Users/dev/work/jolliai", false],
		// Near-misses: a repo that merely mentions plugins, and a host's config root
		// that is not its plugin cache.
		["/Users/dev/work/my-plugins/cache", false],
		["/Users/dev/.codex/sessions", false],
	])("%s → %s", (cwd, expected) => {
		expect(isPluginBundleCwd(cwd)).toBe(expected);
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
		probeWorktreeMock.mockReset().mockResolvedValue("inside");
		loadConfigMock.mockReset().mockResolvedValue({});
		fetchManifestMock.mockReset();
		invokePlatformToolMock.mockReset();
		vi.mocked(runSearch).mockClear();
	});

	it("explicit opt-out: advertises exactly 10 tools and never constructs a client", async () => {
		const createPlatformClient = vi.fn();
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: false }),
			createPlatformClient,
		});
		const list = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: { name: string }[] };
		expect(list.tools.map((t) => t.name)).toEqual(TOOL_DEFINITIONS.map((t) => t.name));
		expect(list.tools).toHaveLength(10);
		expect(createPlatformClient).not.toHaveBeenCalled();
		// A built-in still dispatches through the local table.
		await capturedHandlers[1]({ params: { name: "search", arguments: { query: "x" } } });
		expect(runSearch).toHaveBeenCalledWith("/repo", { query: "x" });
	});

	it("on by default: an unset config flag opens the gate and fetches the manifest", async () => {
		const createPlatformClient = vi.fn(() => stubClient([platA]));
		await startMcpServer("/repo", { loadConfig: async () => ({}), createPlatformClient });
		expect(createPlatformClient).toHaveBeenCalledTimes(1);
		const list = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: { name: string }[] };
		expect(list.tools).toHaveLength(11);
		expect(list.tools.map((t) => t.name)).toContain("create_ticket");
	});

	it("enabled: advertises the built-ins plus the manifest's platform tools", async () => {
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([platA, platB]),
		});
		const list = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: { name: string }[] };
		expect(list.tools).toHaveLength(12);
		expect(list.tools.map((t) => t.name)).toEqual(
			expect.arrayContaining(["create_ticket", "list_projects", "search"]),
		);
	});

	it("enabled: advertises only the public schema — never the internal binding/menu metadata", async () => {
		const withMeta: PlatformToolManifestEntry = {
			name: "create_ticket",
			description: "Create a ticket",
			inputSchema: { type: "object", properties: {} },
			binding: { method: "POST", path: "/api/mcp/tools/create_ticket" },
			menu: { label: "Create ticket", description: "Open a new ticket", order: 1 },
		};
		invokePlatformToolMock.mockResolvedValue({ ok: true });
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([withMeta]),
		});
		const list = (await capturedHandlers[0]({ params: { name: "" } })) as {
			tools: Record<string, unknown>[];
		};
		const advertised = list.tools.find((t) => t.name === "create_ticket");
		expect(advertised).toEqual({
			name: "create_ticket",
			description: "Create a ticket",
			inputSchema: { type: "object", properties: {} },
		});
		expect(advertised).not.toHaveProperty("binding");
		expect(advertised).not.toHaveProperty("menu");
		// Dispatch still uses the FULL entry (with binding) — routing is unaffected.
		await capturedHandlers[1]({ params: { name: "create_ticket", arguments: { title: "x" } } });
		expect(invokePlatformToolMock).toHaveBeenCalledWith(withMeta, { title: "x" });
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

	it("enabled but empty/failed manifest: falls back to exactly the 10 built-ins and still connects", async () => {
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: () => stubClient([]),
		});
		const list = (await capturedHandlers[0]({ params: { name: "" } })) as { tools: { name: string }[] };
		expect(list.tools.map((t) => t.name)).toEqual(TOOL_DEFINITIONS.map((t) => t.name));
		expect(list.tools).toHaveLength(10);
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
		expect(list.tools).toHaveLength(11);
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
		// Exactly one create_ticket advertised (10 built-ins + 1) — no duplicate in tools/list.
		expect(list.tools).toHaveLength(11);
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
		expect(list.tools).toHaveLength(11);
	});

	// --- /jolli menu prompt ---

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

	it("gate off (explicit opt-out): no prompts capability even if a manifest tool would be menu-flagged", async () => {
		const createPlatformClient = vi.fn();
		await startMcpServer("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: false }),
			createPlatformClient,
		});
		expect(serverCapabilities).toEqual({ tools: {} });
		expect(handlerForKind("getPrompt")).toBeUndefined();
	});
});

describe("platformDegraded / rebuildPlatformHalf", () => {
	/** The FAILURE sentinel — the fetch could not be made or could not be read. */
	const failedClient = (): PlatformToolClient => ({
		fetchManifest: async () => undefined,
		invokePlatformTool: vi.fn(),
	});
	/** A healthy fetch answering that this tenant has no platform tools. */
	const emptyClient = (): PlatformToolClient => ({
		fetchManifest: async () => [],
		invokePlatformTool: vi.fn(),
	});
	const oneToolClient = (): PlatformToolClient => ({
		fetchManifest: async () =>
			[
				{ name: "plat_one", description: "d", inputSchema: { type: "object", properties: {} } },
			] as PlatformToolManifestEntry[],
		invokePlatformTool: vi.fn(),
	});

	it("flags a runtime whose manifest fetch FAILED with the gate OPEN", async () => {
		// Under a shared daemon this is the difference between one flaky request
		// and every session on the worktree silently losing its platform tools.
		const runtime = await prepareMcpRuntime("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: failedClient,
		});
		expect(runtime?.platformDegraded).toBe(true);
	});

	it("does NOT flag a healthy fetch that returned an EMPTY manifest", async () => {
		// A tenant with no platform tools is a normal, permanent state. Reading it
		// as degraded — which the first version did, having only the list length to
		// go on — makes the daemon's bounded retry unbounded: a manifest fetch on
		// every connection, awaited in front of that client's server construction,
		// for the daemon's whole lifetime.
		const runtime = await prepareMcpRuntime("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: emptyClient,
		});
		expect(runtime?.platformDegraded).toBe(false);
	});

	it("does NOT flag a CLOSED gate — that is a configured choice, not a failure", async () => {
		const runtime = await prepareMcpRuntime("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: false }),
			createPlatformClient: vi.fn(),
		});
		expect(runtime?.platformDegraded).toBe(false);
	});

	it("does not flag a runtime that got its tools", async () => {
		const runtime = await prepareMcpRuntime("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: oneToolClient,
		});
		expect(runtime?.platformDegraded).toBe(false);
	});

	it("rebuilds only the platform half, keeping the same cwd and re-advertising the tools", async () => {
		const degraded = await prepareMcpRuntime("/repo", {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: failedClient,
		});
		vi.mocked(createStorage).mockClear();

		const recovered = await rebuildPlatformHalf(degraded as NonNullable<typeof degraded>, {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: oneToolClient,
		});

		expect(recovered.cwd).toBe("/repo");
		expect(recovered.platformDegraded).toBe(false);
		expect(recovered.toolDefinitions.map((t) => t.name)).toContain("plat_one");
		// The storage half is a process-global side effect that is already correct;
		// re-running it per connection would undo the sharing the daemon exists for.
		expect(createStorage).not.toHaveBeenCalled();
	});

	/*
	 * The trap in rebuilding: `buildRuntime` decides the built-in half too, so a
	 * refresh that does not carry `insideRepo` forward silently re-advertises the nine
	 * repo-scoped tools this runtime was created to withhold — and a daemon refreshes
	 * on a later connection, long after the cwd was probed. The next client would then
	 * get exactly the empty-but-successful answers the withholding exists to prevent,
	 * with nothing in the logs to say the set had changed.
	 */
	it("keeps the repo-scoped tools withheld across a platform-half rebuild", async () => {
		probeWorktreeMock.mockResolvedValue("outside");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		let degraded: Awaited<ReturnType<typeof prepareMcpRuntime>>;
		try {
			degraded = await prepareMcpRuntime("/not/a/repo", {
				loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
				createPlatformClient: failedClient,
			});
		} finally {
			stderr.mockRestore();
		}
		expect(degraded?.insideRepo).toBe(false);
		expect(degraded?.toolDefinitions.map((t) => t.name)).toEqual(["list_spaces"]);

		const recovered = await rebuildPlatformHalf(degraded as NonNullable<typeof degraded>, {
			loadConfig: async () => ({ mcpPlatformToolsEnabled: true }),
			createPlatformClient: oneToolClient,
		});

		// The platform half recovered…
		expect(recovered.toolDefinitions.map((t) => t.name)).toContain("plat_one");
		// …and the built-in half is still filtered. `probeWorktree` is NOT re-run: the
		// answer rides on the runtime, so a rebuild costs no extra git subprocess.
		expect(recovered.insideRepo).toBe(false);
		for (const withheld of TOOL_DEFINITIONS.filter((t) => t.requiresRepo)) {
			expect(recovered.toolDefinitions.map((t) => t.name)).not.toContain(withheld.name);
		}
	});
});
