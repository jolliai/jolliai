/**
 * McpServer — exposes JolliMemory's search + context tools to AI agents over an
 * stdio MCP transport (JOLLI-1226 P0). Pure glue: tool schemas + a dispatch
 * table over the McpTools handlers. `startMcpServer` is invoked by `jolli mcp`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListToolsRequestSchema,
	type Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../commands/CliUtils.js";
import { JolliMemoryPushClient, type PlatformToolManifestEntry } from "../core/JolliMemoryPushClient.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { createLogger } from "../Logger.js";
import type { JolliMemoryConfig } from "../Types.js";
import {
	buildJolliMenu,
	buildJolliPromptText,
	JOLLI_PROMPT_ARGUMENT,
	JOLLI_PROMPT_NAME,
	type JolliMenuItem,
} from "./JolliMenu.js";
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
import { isPlatformToolsEnabled } from "./PlatformTools.js";

const log = createLogger("McpServer");

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "bind_space",
		description:
			'Bind this repo to a Jolli Space so `push_memory` can push to it. Idempotent — binding an already-bound repo returns `{type:"already_bound"}` rather than erroring.',
		inputSchema: {
			type: "object",
			properties: {
				space: {
					type: "string",
					description: "Jolli Space id (numeric), slug, or exact name to bind this repo to.",
				},
			},
			required: ["space"],
		},
	},
	{
		name: "list_spaces",
		description:
			"List the Jolli Spaces this tenant can bind a repo to, plus the tenant's configured default space.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "push_memory",
		description:
			'Push this branch\'s JolliMemory commit summaries to the bound Jolli Space as articles. If the repo isn\'t bound yet, returns {"type":"binding_required"} with the available spaces — call again with `space` set (or use `bind_space` first) to bind and push.',
		inputSchema: {
			type: "object",
			properties: {
				baseBranch: {
					type: "string",
					description:
						"Base branch for the commit range (base..HEAD). Defaults to the repository's default branch.",
				},
				space: {
					type: "string",
					description:
						"Jolli Space id, slug, or name to bind this repo to before pushing, if not already bound.",
				},
			},
		},
	},
	{
		name: "search",
		description:
			"Full-text search over this repo's historical decisions and implementations (topics + commits). Use to check how a topic was handled before.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Natural-language or keyword query." },
				branch: { type: "string", description: "Optional: restrict to one branch." },
				type: { type: "string", enum: ["topic", "commit"], description: "Optional: restrict result kind." },
				limit: { type: "number", description: "Max hits (default 20)." },
			},
			required: ["query"],
		},
	},
	{
		name: "recall",
		description:
			"Recall the development context for a branch from raw commit summaries (decisions, plans, notes, commits) — the same data the jolli-recall skill uses, NOT the topic KB. Omit `branch` to recall the current branch.",
		inputSchema: {
			type: "object",
			properties: { branch: { type: "string", description: "Branch to recall; defaults to current." } },
		},
	},
	{
		name: "get_decision_timeline",
		description: "Chronological evolution of a topic — its source events ordered oldest-first.",
		inputSchema: {
			type: "object",
			properties: { slug: { type: "string", description: "Topic stableSlug." } },
			required: ["slug"],
		},
	},
	{
		name: "list_branches",
		description: "List all branches that have JolliMemory records, with their topic titles.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_pr_description",
		description:
			"Build a GitHub PR title + description from the CURRENT branch's JolliMemory commit summaries — the same memory-rich body the VS Code extension writes. Use before `gh pr create` so the PR embeds the curated memory instead of a diff-derived summary. Always describes the current branch (the commit range is base..HEAD).",
		inputSchema: {
			type: "object",
			properties: {
				baseBranch: {
					type: "string",
					description:
						"Base branch for the commit range. Defaults to the repository's default branch (origin/HEAD), falling back to main.",
				},
				includeMarkers: {
					type: "boolean",
					description: "Wrap body in update markers for idempotent PR edits (default true).",
				},
			},
		},
	},
	{
		name: "queue_status",
		description:
			'Report whether this repo\'s memory-summary generation is still in progress. Call before building a PR (get_pr_description) so freshly-committed summaries are included. Wiki/graph rendering is excluded from the verdict. Pass {"wait": true} to block until drained (default 120s, override with timeoutMs).',
		inputSchema: {
			type: "object",
			properties: {
				wait: { type: "boolean", description: "Block until the queue drains or the timeout elapses." },
				timeoutMs: { type: "number", description: "Max ms to wait when wait is true (default 120000)." },
			},
		},
	},
];

/** Route a validated tool call to its handler. Throws on unknown tool. */
export async function dispatchTool(cwd: string, name: string, args: Record<string, unknown>): Promise<unknown> {
	switch (name) {
		case "search":
			return runSearch(
				cwd,
				args as { query: string; branch?: string; type?: "topic" | "commit"; limit?: number },
			);
		case "recall":
			return runRecall(cwd, args as { branch?: string });
		case "get_decision_timeline":
			return runDecisionTimeline(cwd, args as { slug: string });
		case "list_branches":
			return runListBranches(cwd);
		case "get_pr_description":
			return runGetPrDescription(cwd, args as { baseBranch?: string; includeMarkers?: boolean });
		case "queue_status":
			return runQueueStatus(cwd, args as { wait?: boolean; timeoutMs?: number });
		case "push_memory":
			return runPushMemory(cwd, args as { baseBranch?: string; space?: string });
		case "list_spaces":
			return runListSpaces(cwd);
		case "bind_space":
			return runBindSpace(cwd, args as { space: string });
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

/**
 * The slice of the backend client the platform-tool path uses. Declared as an
 * interface so tests can inject a fake without constructing a live HTTP client.
 */
export interface PlatformToolClient {
	fetchManifest(): Promise<PlatformToolManifestEntry[]>;
	invokePlatformTool(tool: PlatformToolManifestEntry, args: Record<string, unknown>): Promise<unknown>;
}

/** Injectable dependencies for {@link startMcpServer}; the defaults wire the real implementations. */
export interface StartMcpServerDeps {
	/** Loads the config that gates platform-tool registration. Defaults to the machine-global config loader. */
	readonly loadConfig?: () => Promise<Pick<JolliMemoryConfig, "mcpPlatformToolsEnabled">>;
	/** Builds the backend client that fetches the manifest and relays tool calls. Defaults to a real client. */
	readonly createPlatformClient?: () => PlatformToolClient;
}

/** Start the stdio MCP server. Resolves when the transport closes. */
export async function startMcpServer(cwd: string, deps: StartMcpServerDeps = {}): Promise<void> {
	// Establish the configured storage backend up front. The tool handlers read
	// through the store APIs without threading `storage`, so without this they'd
	// fall through resolveStorage to the orphan branch — wrong for folder-mode
	// users and a per-read WARN in this long-lived process.
	setActiveStorage(await createStorage(cwd, cwd));

	// Optionally register the backend-defined platform tools alongside the
	// built-in git-memory tools. Opt-in and off by default: when the gate is
	// closed we never construct a client or touch the network, so the server
	// behaves exactly as a git-memory-only server.
	const config = await (deps.loadConfig ?? loadConfig)();
	let platformClient: PlatformToolClient | undefined;
	let platformTools: PlatformToolManifestEntry[] = [];
	// The curated `/jolli` menu is computed only inside the platform-tools gate, so
	// with the gate closed it stays empty and no prompt is ever registered.
	let menu: JolliMenuItem[] = [];
	if (isPlatformToolsEnabled(config)) {
		platformClient = (deps.createPlatformClient ?? (() => new JolliMemoryPushClient()))();
		const builtInNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
		const seenNames = new Set<string>();
		platformTools = (await platformClient.fetchManifest()).filter((tool) => {
			if (builtInNames.has(tool.name)) {
				// A built-in tool always wins a name collision: drop the backend tool
				// so the built-in handler stays reachable and its wire contract is
				// never shadowed by a same-named backend tool.
				log.warn("Ignoring platform tool whose name collides with a built-in tool: %s", tool.name);
				return false;
			}
			if (seenNames.has(tool.name)) {
				// Keep only the first entry per name so the advertised list and the
				// dispatch map agree — otherwise `tools/list` would show a duplicate a
				// client could select while `tools/call` always ran a different one.
				log.warn("Ignoring duplicate platform tool name from the manifest: %s", tool.name);
				return false;
			}
			seenNames.add(tool.name);
			return true;
		});
		// Menu = menu-flagged platform tools ∪ the local-tools inclusion list
		// (empty for now). Every item is one of the tools advertised below.
		menu = buildJolliMenu(platformTools, TOOL_DEFINITIONS);
	}
	const platformByName = new Map(platformTools.map((t) => [t.name, t] as const));
	// Advertise the built-ins plus any platform tools. Build the list locally and
	// leave the static built-in registry untouched; with no platform tools the
	// static array is returned directly. Project each platform tool down to the
	// public tool schema (name / description / inputSchema): a manifest entry also
	// carries `binding` (backend routing) and `menu` (curation) metadata that are
	// internal-only and must never reach a client's `tools/list`. Dispatch still
	// uses the full entries via `platformByName`, so routing is unaffected.
	const advertisedPlatformTools: ToolDefinition[] = platformTools.map(({ name, description, inputSchema }) => ({
		name,
		description,
		inputSchema,
	}));
	const toolDefinitions: ToolDefinition[] =
		advertisedPlatformTools.length > 0 ? [...TOOL_DEFINITIONS, ...advertisedPlatformTools] : TOOL_DEFINITIONS;

	// Advertise the `prompts` capability only when the menu is non-empty. With an
	// empty menu (gate off, empty manifest, or no menu-flagged tools) the server is
	// byte-identical to a tools-only server: no capability, no handlers, no prompt.
	const promptsEnabled = menu.length > 0;
	const server = new Server(
		{ name: "jollimemory", version: VERSION },
		{ capabilities: promptsEnabled ? { tools: {}, prompts: {} } : { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		try {
			// Route backend-defined tools through the generic executor; everything
			// else is a built-in handled by the local dispatch table.
			const platformTool = platformByName.get(name);
			const result =
				platformClient && platformTool
					? await platformClient.invokePlatformTool(platformTool, args ?? {})
					: await dispatchTool(cwd, name, args ?? {});
			// Unify the error contract across tools. `push_memory` (and any backend
			// platform tool) reports failure as a structured `{ type: "error" }`
			// result rather than throwing, so flag it `isError` here to match the
			// thrown-error path that `list_spaces` / `bind_space` take. A
			// `binding_required` result is a legitimate "needs input" outcome, not
			// an error, so it stays a normal result.
			const isError =
				typeof result === "object" && result !== null && (result as { type?: unknown }).type === "error";
			return { content: [{ type: "text", text: JSON.stringify(result) }], ...(isError ? { isError: true } : {}) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn("Tool %s failed: %s", name, message);
			return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
		}
	});

	if (promptsEnabled) {
		// One prompt, `jolli`, that steers the agent to the curated menu. `ListPrompts`
		// returns exactly this prompt; `GetPrompt` returns a steering message built
		// from the menu. The menu items are already-registered tools, so the prompt is
		// not a second execution path — it only tells the agent which tool to call.
		const jolliPrompt: Prompt = {
			name: JOLLI_PROMPT_NAME,
			description: "Browse and run Jolli actions from a curated menu.",
			arguments: [
				{
					name: JOLLI_PROMPT_ARGUMENT,
					description:
						"Optional free-text request; matched against a menu item so the agent can invoke it directly.",
					required: false,
				},
			],
		};
		server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [jolliPrompt] }));
		server.setRequestHandler(GetPromptRequestSchema, async (req) => {
			const { name, arguments: promptArgs } = req.params;
			if (name !== JOLLI_PROMPT_NAME) {
				throw new Error(`Unknown prompt: ${name}`);
			}
			const rawRequest = promptArgs?.[JOLLI_PROMPT_ARGUMENT];
			const request = typeof rawRequest === "string" ? rawRequest : undefined;
			return {
				description: "Curated Jolli action menu.",
				messages: [{ role: "user", content: { type: "text", text: buildJolliPromptText(menu, request) } }],
			};
		});
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info("MCP server connected over stdio (cwd=%s)", cwd);
}
