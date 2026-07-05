/**
 * McpServer — exposes JolliMemory's search + context tools to AI agents over an
 * stdio MCP transport (JOLLI-1226 P0). Pure glue: tool schemas + a dispatch
 * table over the McpTools handlers. `startMcpServer` is invoked by `jolli mcp`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../commands/CliUtils.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { createLogger } from "../Logger.js";
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

/** Start the stdio MCP server. Resolves when the transport closes. */
export async function startMcpServer(cwd: string): Promise<void> {
	// Establish the configured storage backend up front. The tool handlers read
	// through the store APIs without threading `storage`, so without this they'd
	// fall through resolveStorage to the orphan branch — wrong for folder-mode
	// users and a per-read WARN in this long-lived process.
	setActiveStorage(await createStorage(cwd, cwd));

	const server = new Server({ name: "jollimemory", version: VERSION }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		try {
			const result = await dispatchTool(cwd, name, args ?? {});
			// Unify the error contract across tools. `push_memory` reports failure
			// as a structured `{ type: "error" }` result (its CLI caller branches on
			// that) rather than throwing, so flag it `isError` here to match the
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

	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info("MCP server connected over stdio (cwd=%s)", cwd);
}
