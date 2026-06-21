/**
 * PrDescriptionCommand — Output a Jolli Memory PR title + body for the current
 * branch.
 *
 * This is the CLI fallback for the `jolli-pr` skill on hosts where the
 * `get_pr_description` MCP tool is unavailable. It wraps the same
 * `buildPrDescription` core that the MCP tool calls, so both surfaces emit the
 * identical `PrDescriptionResult` shape — the skill renders either one the same
 * way.
 *
 * Output modes:
 *   - `--format json` — the full `PrDescriptionResult` (for skill/agent consumption)
 *   - Default — a short human-readable summary for terminal viewing
 *
 * The optional base branch can be supplied two ways:
 *   - `--base <branch>` on argv (programmatic callers)
 *   - `--arg-stdin` reading the branch from stdin (the SKILL.md here-doc bridge,
 *     so a user-supplied base branch never passes through the shell's argv parser)
 * The two are mutually exclusive.
 */

import { type Command, Option } from "commander";
import { buildPrDescription } from "../core/PrDescription.js";
import { setLogDir } from "../Logger.js";
import { readStdin, resolveProjectDir, SAFE_ARGUMENT_PATTERN } from "./CliUtils.js";

interface PrDescriptionOptions {
	base?: string;
	argStdin?: boolean;
	markers?: boolean;
	format?: string;
	cwd: string;
}

/**
 * Renders a short, terminal-friendly summary. The full multi-line body is
 * deliberately withheld here — it is only emitted under `--format json` (the
 * machine path) so an interactive `jolli pr-description` does not flood the
 * terminal with the entire PR body.
 */
function renderHumanSummary(result: {
	title: string;
	baseBranch: string;
	commitCount: number;
	summaryCount: number;
	missingCount: number;
}): string {
	const lines: string[] = [];
	lines.push("");
	lines.push(`  ${result.title}`);
	lines.push("  ──────────────────────────────────────");
	lines.push(`  Base:    ${result.baseBranch}`);
	lines.push(
		`  Commits: ${result.commitCount} (${result.summaryCount} with memory${
			result.missingCount > 0 ? `, ${result.missingCount} without` : ""
		})`,
	);
	lines.push("");
	lines.push("  Run with --format json for the full PR body.");
	lines.push("  Run the jolli-pr skill (e.g. /jolli-pr in Claude Code) to open the PR.");
	lines.push("");
	return lines.join("\n");
}

/**
 * Registers the `pr-description` command on the given Commander program.
 */
export function registerPrDescriptionCommand(program: Command): void {
	program
		.command("pr-description")
		.description("Output a Jolli Memory PR title + body for the current branch (skill/agent consumption)")
		.option("--base <branch>", "Base branch to diff against (default: the repo's default branch)")
		.option("--arg-stdin", "Read the base branch from stdin instead of --base (used by SKILL.md here-doc bridge)")
		.option("--no-markers", "Omit the idempotent update markers wrapping the body")
		.addOption(new Option("--format <fmt>", "Output format").choices(["json"]))
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: PrDescriptionOptions) => {
			try {
				const projectDir = options.cwd;
				setLogDir(projectDir);

				// --arg-stdin and --base name the same value via two channels; mixing
				// them would silently favor one and undermine the here-doc contract
				// the skill relies on. Mirror recall/search's mutual-exclusion guard.
				if (options.argStdin && options.base !== undefined) {
					const message =
						"--arg-stdin and --base are mutually exclusive. Pass the base branch via stdin OR --base, not both.";
					if (options.format === "json") {
						console.log(JSON.stringify({ type: "error", message }));
					} else {
						console.error(`\n  Error: ${message}\n`);
					}
					process.exitCode = 1;
					return;
				}

				let baseBranch: string | undefined;
				if (options.argStdin) {
					const fromStdin = await readStdin();
					baseBranch = fromStdin.length > 0 ? fromStdin : undefined;
				} else {
					baseBranch = options.base;
				}

				// Defense in depth: the base branch has bypassed shell parsing via
				// here-doc/argv, but it still flows into git operations downstream.
				if (baseBranch && !SAFE_ARGUMENT_PATTERN.test(baseBranch)) {
					const message =
						"Invalid characters in base branch. Only letters, numbers, hyphens, underscores, slashes, and dots are allowed.";
					if (options.format === "json") {
						console.log(JSON.stringify({ type: "error", message }));
					} else {
						console.error(`\n  Error: ${message}\n`);
					}
					process.exitCode = 1;
					return;
				}

				const result = await buildPrDescription(projectDir, {
					baseBranch,
					// Commander defaults a `--no-markers` option to `markers: true`, and
					// sets it to `false` only when the flag is passed — so this carries
					// the marker toggle straight through to buildPrDescription.
					includeMarkers: options.markers,
				});

				if (options.format === "json") {
					console.log(JSON.stringify(result));
				} else {
					console.log(renderHumanSummary(result));
				}
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				if (options.format === "json") {
					console.log(JSON.stringify({ type: "error", message }));
				} else {
					console.error(`\n  Error: ${message}\n`);
				}
				// Always set a non-zero exit code so CI / shell pipelines detect the
				// failure regardless of which output format the caller asked for.
				process.exitCode = 1;
			}
		});
}
