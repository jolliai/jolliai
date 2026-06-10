/**
 * `jolli mcp` — starts the stdio MCP server for AI agents (JOLLI-1226 P0).
 * `jolli mcp --reindex` forces a full rebuild of the local search index and exits.
 */

import type { Command } from "commander";
import { SearchIndex } from "../core/SearchIndex.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { startMcpServer } from "../mcp/McpServer.js";

export function registerMcpCommand(program: Command): void {
	program
		.command("mcp")
		.description("Start the JolliMemory MCP server (stdio) for AI agents")
		.option("--reindex", "Rebuild the local search index from source and exit")
		.action(async (options: { reindex?: boolean }) => {
			const cwd = process.cwd();
			if (options.reindex) {
				// Establish the configured backend before reading sources — mirrors
				// startMcpServer. Without it, rebuild's reads fall through to the
				// orphan-branch fallback, so a folder-mode user would reindex from the
				// wrong (possibly empty) store and see a misleading "0 document(s)".
				const storage = await createStorage(cwd, cwd);
				setActiveStorage(storage);
				// Pass `storage` so the index file lands in the SAME dir the MCP server
				// reads from (`<kbRoot>/.jolli/jollimemory/` in folder/dual-write mode).
				// Without it resolveIndexDir falls back to cwd and `--reindex` writes to
				// the checkout instead of the Memory Bank folder.
				const { docCount } = await SearchIndex.rebuild(cwd, storage);
				process.stdout.write(`Reindexed ${docCount} document(s).\n`);
				return;
			}
			await startMcpServer(cwd);
		});
}
