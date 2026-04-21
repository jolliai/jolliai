/**
 * ExportCommand — Export summaries and prompt templates.
 *
 * Provides two CLI commands:
 *   - `export` — Export commit summaries as markdown files to ~/Documents/jollimemory/<project>/
 *   - `export-prompt` — Print prompt templates to stdout
 */

import type { Command } from "commander";
import { TEMPLATES } from "../core/PromptTemplates.js";
import { exportSummaries } from "../core/SummaryExporter.js";
import { createLogger, setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

const log = createLogger("ExportCommand");

/**
 * Registers the `export-prompt` command on the given Commander program.
 */
export function registerExportPromptCommand(program: Command): void {
	program
		.command("export-prompt")
		.description("Print prompt templates to stdout. All templates use {{placeholder}} syntax for runtime fields.")
		.option("--action <key>", "Print a single template (e.g. summarize:small, commit-message, translate)")
		.action((opts: { action?: string }) => {
			if (opts.action) {
				const template = TEMPLATES.get(opts.action);
				if (!template) {
					const available = [...TEMPLATES.keys()].join(", ");
					console.error(`\n  Error: unknown action "${opts.action}"\n  Available: ${available}\n`);
					process.exitCode = 1;
					return;
				}
				process.stdout.write(`${template}\n`);
			} else {
				for (const [key, template] of TEMPLATES) {
					process.stdout.write(`=== ${key} ===\n${template}\n\n`);
				}
			}
		});
}

/**
 * Registers the `export` command on the given Commander program.
 */
export function registerExportCommand(program: Command): void {
	program
		.command("export")
		.description("Export commit summaries as markdown files to ~/Documents/jollimemory/<project>/")
		.option("--commit <sha>", "Export summary for a specific commit")
		.option("--project <name>", "Override project name (default: git repo basename)")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { commit?: string; project?: string; cwd: string }) => {
			setLogDir(options.cwd);
			log.info("Running 'export' command");

			const result = await exportSummaries({
				commit: options.commit,
				project: options.project,
				cwd: options.cwd,
			});

			if (result.totalSummaries === 0) {
				console.log("\n  No summaries found to export.\n");
				return;
			}

			// Total failure: every summary errored on write, nothing new on disk.
			// Surface as an error and set a non-zero exit code so scripts can detect it.
			// Partial failure (errored > 0 but written > 0) still uses the success path
			// since real files did land on disk — the "Errored:" segment flags the issue.
			if (result.filesErrored > 0 && result.filesWritten === 0) {
				console.error(
					`\n  Export failed — ${result.filesErrored} failed (${result.filesSkipped} already on disk).\n`,
				);
				process.exitCode = 1;
				return;
			}

			console.log(`\n  Exported to ${result.outputDir}`);
			const erroredSegment = result.filesErrored > 0 ? `  Errored: ${result.filesErrored}` : "";
			console.log(
				`  New: ${result.filesWritten}  Skipped: ${result.filesSkipped}${erroredSegment}  Total: ${result.totalSummaries}`,
			);
			console.log(`  Index: ${result.indexPath}\n`);
		});
}
