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
import { runDecisionTimeline, runGetPrDescription, runListBranches, runRecall, runSearch } from "./McpTools.js";

const log = createLogger("McpServer");

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
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
			return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
