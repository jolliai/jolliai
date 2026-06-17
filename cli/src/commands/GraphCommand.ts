/**
 * GraphCommand — `jolli graph --export <dir>`.
 *
 * Exports a repo's knowledge graph to a single self-contained HTML file that
 * opens directly in a browser (no server) and carries its own `_wiki` content.
 * Built on top of `jolli compile` output: the repo must have a graph already
 * (`<kbRoot>/.jolli/graph/graph.json`).
 */

import type { Command } from "commander";
import { exportGraphHtml } from "../graph/GraphExport.js";
import { createLogger } from "../Logger.js";

const log = createLogger("GraphCommand");

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type GraphOptions = { export?: string; cwd?: string; open?: boolean };

export async function executeGraph(options: GraphOptions): Promise<void> {
	if (!options.export) {
		console.error("\n  Error: jolli graph requires --export <dir> (the only action today).\n");
		process.exitCode = 1;
		return;
	}
	const cwd = options.cwd ?? process.cwd();
	try {
		const outFile = await exportGraphHtml({ cwd, out: options.export });
		console.log(`\n  Knowledge graph exported → ${outFile}`);
		console.log("  Open it directly in a browser — it is self-contained (no server needed).\n");
		if (options.open) {
			try {
				const open = (await import("open")).default;
				await open(outFile);
			} catch (err) {
				log.warn("Could not open the browser (non-fatal): %s", errMsg(err));
			}
		}
	} catch (err) {
		console.error(`\n  Error: ${errMsg(err)}\n`);
		process.exitCode = 1;
	}
}

export function registerGraphCommand(program: Command): void {
	program
		.command("graph")
		.description("Export this repo's knowledge graph to a self-contained, shareable HTML file")
		.option("--export <dir>", "Write a standalone HTML (a directory gets <repo>-graph.html, or pass a *.html path)")
		.option("--cwd <dir>", "Target repo directory (default: current directory)")
		.option("--open", "Open the exported HTML in the default browser")
		.action(executeGraph);
}
