/**
 * RecallCommand — Recall development context for a branch.
 *
 * Provides the `recall` (alias: `context`) CLI command that compiles and outputs
 * development context from Jolli Memory's orphan branch data.
 *
 * Output modes:
 *   - Default: short summary for terminal viewing
 *   - `--full`: full markdown context to stdout
 *   - `--output <path>`: full markdown written to file
 *   - `--format json`: full JSON for skill/agent consumption
 *   - `--catalog`: list all recorded branches
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Command, Option } from "commander";
import type { BranchCatalog, ContextOutput } from "../core/ContextCompiler.js";
import {
	compileTaskContext,
	DEFAULT_TOKEN_BUDGET,
	listBranchCatalog,
	renderContextMarkdown,
} from "../core/ContextCompiler.js";
import { collectAllTopics } from "../core/SummaryTree.js";
import { setLogDir } from "../Logger.js";
import type { CommitSummary } from "../Types.js";
import { formatShortDate, parsePositiveInt, resolveProjectDir, SAFE_ARGUMENT_PATTERN } from "./CliUtils.js";

/**
 * Maximum branches shown in terminal-friendly catalog output.
 * JSON output (`--format json`) is never truncated — AI agents need the full
 * catalog to perform semantic branch matching.
 */
const CATALOG_TEXT_LIMIT = 20;

/**
 * Renders a branch catalog as human-readable text for the terminal.
 * Used when the recall command cannot find an exact branch match.
 */
function renderCatalogText(catalog: BranchCatalog, query?: string): string {
	const lines: string[] = [];

	if (query) {
		lines.push(`No exact match for "${query}".`);
	} else {
		lines.push("No Jolli Memory records for the current branch.");
	}
	lines.push("");
	lines.push("Recorded branches (most recent first):");
	lines.push("");

	const shown = catalog.branches.slice(0, CATALOG_TEXT_LIMIT);
	for (const entry of shown) {
		const count = entry.commitCount === 1 ? "1 commit" : `${entry.commitCount} commits`;
		const start = formatShortDate(entry.period.start);
		const end = formatShortDate(entry.period.end);
		const period = start === end ? start : `${start} – ${end}`;
		lines.push(`  ${entry.branch}  ${count}  ${period}`);
	}

	const hidden = catalog.branches.length - shown.length;
	/* v8 ignore start -- defensive: requires > 20 branches in catalog to trigger */
	if (hidden > 0) {
		lines.push("");
		lines.push(`  ... and ${hidden} more (use --format json for the full list)`);
	}
	/* v8 ignore stop */

	lines.push("");
	lines.push("Run: jolli recall <branch-name>");
	return lines.join("\n");
}

/**
 * Renders a short, terminal-friendly summary of the compiled context.
 * Used as the default output when no --full, --output, or --format is specified.
 */
function renderShortSummary(ctx: {
	branch: string;
	period: { start: string; end: string };
	commitCount: number;
	totalFilesChanged: number;
	summaries: ReadonlyArray<CommitSummary>;
	keyDecisions: ReadonlyArray<{ text: string }>;
}): string {
	const lines: string[] = [];

	const period =
		ctx.period.start === ctx.period.end
			? formatShortDate(ctx.period.start)
			: `${formatShortDate(ctx.period.start)} – ${formatShortDate(ctx.period.end)}`;
	const commitLabel = ctx.commitCount === 1 ? "1 commit" : `${ctx.commitCount} commits`;

	lines.push("");
	lines.push(`  ${ctx.branch} (${commitLabel}, ${period})`);
	lines.push("  ──────────────────────────────────────");

	// Last commit message
	const lastSummary = ctx.summaries[ctx.summaries.length - 1];
	if (lastSummary) {
		lines.push(`  Last:          ${lastSummary.commitMessage.split("\n")[0]}`);
	}

	// Topic counts by category (aggregate across all summaries)
	const categoryCounts = new Map<string, number>();
	for (const summary of ctx.summaries) {
		for (const topic of collectAllTopics(summary)) {
			if (topic.category) {
				categoryCounts.set(topic.category, (categoryCounts.get(topic.category) ?? 0) + 1);
			}
		}
	}
	if (categoryCounts.size > 0) {
		const topicLine = [...categoryCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([cat, n]) => `${n} ${cat}`)
			.join(", ");
		lines.push(`  Topics:        ${topicLine}`);
	}

	// Key decisions (take first 3, full text on one line each — no truncation)
	if (ctx.keyDecisions.length > 0) {
		const MAX_DECISIONS = 3;
		const shown = ctx.keyDecisions.slice(0, MAX_DECISIONS);
		lines.push(`  Key decisions:`);
		for (const d of shown) {
			// Strip leading "- " or "* " markers from the decision text
			// (decisions may come in already formatted as markdown lists)
			const cleaned = d.text
				.split("\n")[0]
				.replace(/^[-*]\s*/, "")
				.trim();
			lines.push(`    - ${cleaned}`);
		}
		const hiddenCount = ctx.keyDecisions.length - shown.length;
		/* v8 ignore start -- defensive: requires > 3 key decisions to trigger */
		if (hiddenCount > 0) {
			lines.push(`    (and ${hiddenCount} more — use --full to see all)`);
		}
		/* v8 ignore stop */
	}

	lines.push(`  Files changed: ${ctx.totalFilesChanged}`);
	lines.push("");
	lines.push("  Run with --full or --output <path> for full context.");
	lines.push("  Run /jolli-recall in Claude Code for AI-assisted recall.");
	lines.push("");

	return lines.join("\n");
}

/**
 * Loads and outputs recalled development context for a branch.
 *
 * Output modes (in priority order):
 * 1. `--output <path>` — writes full markdown to file, prints confirmation line.
 * 2. `--format json` — outputs full JSON (for skill/agent consumption).
 * 3. `--full` — outputs full markdown to stdout.
 * 4. Default — outputs short summary to stdout (terminal-friendly).
 */
async function outputRecall(
	branch: string,
	options: {
		budget?: number;
		depth?: number;
		includeTranscripts?: boolean;
		plans?: boolean;
		format?: string;
		full?: boolean;
		output?: string;
	},
	projectDir: string,
): Promise<void> {
	const ctx = await compileTaskContext(
		{
			branch,
			depth: options.depth,
			tokenBudget: options.budget ?? DEFAULT_TOKEN_BUDGET,
			includeTranscripts: options.includeTranscripts,
			includePlans: options.plans !== false,
		},
		projectDir,
	);

	if (ctx.commitCount === 0) {
		if (options.format === "json") {
			console.log(
				JSON.stringify({ type: "error", message: `No Jolli Memory records found for branch "${branch}".` }),
			);
		} else {
			console.log(`No Jolli Memory records found for branch "${branch}".`);
		}
		return;
	}

	// Output path 1: --output <file> -> always writes full markdown to file
	if (options.output) {
		const markdown = renderContextMarkdown(ctx, options.budget ?? DEFAULT_TOKEN_BUDGET);
		// Ensure parent dir exists — writeFile itself does not create it, so
		// `--output some/nested/path.md` on a fresh repo would otherwise ENOENT.
		// Matches the `mkdir -p`-style ergonomic users expect from --output flags.
		const parent = dirname(options.output);
		if (parent && parent !== ".") {
			await mkdir(parent, { recursive: true });
		}
		await writeFile(options.output, markdown, "utf-8");
		console.log(
			`Context written to ${options.output} (${ctx.stats.totalTokens.toLocaleString()} tokens, ${ctx.commitCount} commit${ctx.commitCount === 1 ? "" : "s"})`,
		);
		return;
	}

	// Output path 2: --format json -> full JSON for skill/agent consumption
	if (options.format === "json") {
		const markdown = renderContextMarkdown(ctx, options.budget ?? DEFAULT_TOKEN_BUDGET);
		const output: ContextOutput = {
			type: "recall",
			stats: ctx.stats,
			renderedMarkdown: markdown,
		};
		console.log(JSON.stringify(output, null, 2));
		return;
	}

	// Output path 3: --full or --format md -> full markdown to stdout
	if (options.full || options.format === "md") {
		const markdown = renderContextMarkdown(ctx, options.budget ?? DEFAULT_TOKEN_BUDGET);
		console.log(markdown);
		return;
	}

	// Output path 4: default -> short summary for terminal viewing
	console.log(renderShortSummary(ctx));
}

/**
 * Registers the `recall` command (alias: `context`) on the given Commander program.
 */
export function registerRecallCommand(program: Command): void {
	program
		.command("recall")
		.alias("context")
		.description("Recall development context for a branch (default: short summary for humans)")
		.argument("[words...]", "Branch name or keyword(s), or omit for current branch")
		.option("--full", "Output full markdown context (suitable for feeding to an AI agent)")
		.option("--output <path>", "Write full context to a file (implies --full)")
		.option("--depth <n>", "Maximum number of summaries to include", parsePositiveInt)
		.option("--budget <tokens>", `Token budget (default: ${DEFAULT_TOKEN_BUDGET})`, parsePositiveInt)
		.option("--include-transcripts", "Include transcript excerpts")
		.option("--no-plans", "Exclude plan content")
		.option("--catalog", "List all recorded branches (lightweight)")
		.addOption(new Option("--format <fmt>", "Output format").choices(["md", "json"]))
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (words: string[], options) => {
			const branchOrKeyword = words.length > 0 ? words.join(" ") : undefined;
			try {
				const projectDir = options.cwd;
				setLogDir(projectDir);

				// Validate argument (prevent shell injection via $ARGUMENTS)
				if (branchOrKeyword && !SAFE_ARGUMENT_PATTERN.test(branchOrKeyword)) {
					const message =
						"Invalid characters in argument. Only letters, numbers, hyphens, underscores, slashes, and dots are allowed.";
					if (options.format === "json") {
						console.log(JSON.stringify({ type: "error", message }));
					} else {
						console.error(`\n  Error: ${message}\n`);
						process.exitCode = 1;
					}
					return;
				}

				// Catalog mode: explicit --catalog respects --format just like the
				// "no exact match" fallback path below. Default is human-readable
				// text (the flag is primarily used interactively); --format json
				// is for programmatic consumers.
				if (options.catalog) {
					const catalog = await listBranchCatalog(projectDir);
					if (options.format === "json") {
						console.log(JSON.stringify(catalog, null, 2));
					} else {
						console.log(renderCatalogText(catalog));
					}
					return;
				}

				// Resolve branch: explicit arg, or current git branch
				let branch = branchOrKeyword as string | undefined;
				if (!branch) {
					try {
						branch = execFileSync("git", ["branch", "--show-current"], {
							encoding: "utf-8",
							cwd: projectDir,
							windowsHide: true,
						}).trim();
					} catch {
						branch = undefined;
					}
				}

				// Load catalog once for all dispatch paths
				const catalog = await listBranchCatalog(projectDir);

				// Smart dispatch: check if branch exists in index
				if (branch) {
					const exactMatch = catalog.branches.find((b) => b.branch === branch);

					if (exactMatch) {
						// Exact match — load full context
						await outputRecall(branch, options, projectDir);
						return;
					}

					// No exact match — return catalog with query for LLM semantic matching
					if (options.format === "json") {
						console.log(JSON.stringify({ ...catalog, query: branch }, null, 2));
					} else {
						console.log(renderCatalogText(catalog, branch));
					}
					return;
				}

				// No branch at all — check current branch in catalog, else return catalog
				if (catalog.branches.length === 0) {
					if (options.format === "json") {
						console.log(
							JSON.stringify({
								type: "error",
								message: "No Jolli Memory records found in this repository.",
							}),
						);
					} else {
						console.log(
							'No Jolli Memory records found in this repository.\nRun "jolli enable" to start recording.',
						);
					}
					return;
				}

				// Fallback: return catalog
				if (options.format === "json") {
					console.log(JSON.stringify(catalog, null, 2));
				} else {
					console.log(renderCatalogText(catalog));
				}
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				if (options.format === "json") {
					console.log(JSON.stringify({ type: "error", message }));
				} else {
					console.error(`\n  Error: ${message}\n`);
					process.exitCode = 1;
				}
			}
		});
}
