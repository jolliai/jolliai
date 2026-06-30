/**
 * BackfillCommand — `jolli backfill` CLI command.
 *
 * Generates jolli memory summaries for historical commits that lack one, by
 * attributing on-disk Claude transcripts to those commits offline. Fully
 * isolated from the live post-commit pipeline.
 *
 *   jolli backfill                  # last 20 commits, high-confidence only
 *   jolli backfill --last 50        # last 50 commits
 *   jolli backfill --all            # every commit reachable from HEAD
 *   jolli backfill --dry-run        # report attribution + confidence, no LLM call
 *   jolli backfill --include-medium # also accept time-window (medium) matches
 */

import type { Command } from "commander";
import {
	type BackfillOutcome,
	type BackfillReport,
	recentCommitHashes,
	runBackfill,
} from "../backfill/BackfillEngine.js";
import { setLogDir } from "../Logger.js";
import { parsePositiveInt, resolveProjectDir } from "./CliUtils.js";

interface BackfillCliOptions {
	cwd: string;
	last?: number;
	all?: boolean;
	dryRun?: boolean;
	includeMedium?: boolean;
	format?: "json" | "text";
}

const DEFAULT_LAST = 20;

/** Resolves the candidate commit hash list (newest-first) from the CLI options. */
async function resolveHashes(opts: BackfillCliOptions): Promise<ReadonlyArray<string>> {
	return recentCommitHashes(opts.cwd, opts.all ? undefined : (opts.last ?? DEFAULT_LAST));
}

const STATUS_LABEL: Record<BackfillOutcome["status"], string> = {
	generated: "✓ generated",
	"would-generate": "○ would generate",
	"skipped-has-summary": "· already summarized",
	error: "✗ error",
};

function renderText(report: BackfillReport, dryRun: boolean): string {
	const lines: string[] = [];
	for (const o of report.outcomes) {
		const short = o.commitHash.substring(0, 8);
		const conf = o.method ? ` [${o.confidence ? `${o.confidence}/` : ""}${o.method}]` : "";
		const topics = o.topics !== undefined ? ` (${o.topics} topics)` : "";
		const msg = o.message ? ` — ${o.message}` : "";
		lines.push(`  ${short}  ${STATUS_LABEL[o.status]}${conf}${topics}${msg}`);
	}
	const verb = dryRun ? "would generate" : "generated";
	lines.push("");
	lines.push(
		`  ${report.total} candidate(s): ${report.generated} ${verb}, ${report.skipped} skipped, ${report.errors} error(s).`,
	);
	return lines.join("\n");
}

/** Registers the `backfill` command on the given Commander program. */
export function registerBackfillCommand(program: Command): void {
	program
		.command("backfill")
		.description("Generate summaries for historical commits that lack one (Claude transcripts only)")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.option("--last <n>", "Number of most recent commits to consider", parsePositiveInt, DEFAULT_LAST)
		.option("--all", "Consider every commit reachable from HEAD")
		.option("--dry-run", "Report attribution and confidence without calling the LLM")
		.option("--include-medium", "Also accept medium-confidence (time-window) attributions")
		.option("--format <fmt>", "Output format: text | json", "text")
		.action(async (opts: BackfillCliOptions) => {
			setLogDir(opts.cwd);
			const hashes = await resolveHashes(opts);
			if (hashes.length === 0) {
				console.error("  No commits found to back-fill.");
				process.exitCode = 1;
				return;
			}
			const report = await runBackfill({
				cwd: opts.cwd,
				hashes,
				dryRun: opts.dryRun,
				includeMedium: opts.includeMedium,
			});
			if (opts.format === "json") {
				console.log(JSON.stringify(report, null, 2));
			} else {
				console.log(renderText(report, Boolean(opts.dryRun)));
			}
		});
}
