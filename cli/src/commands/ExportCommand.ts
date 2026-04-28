/**
 * ExportCommand — Export summaries and prompt templates.
 *
 * Provides two CLI commands:
 *   - `export` — Export commit summaries as markdown files to ~/Documents/jollimemory/<project>/
 *   - `export-prompt` — Print prompt templates to stdout, or write to a folder
 *      with manifest.json (for backend DB seeding) plus per-prompt .md files
 *      (for human review). See plan 121 for the manifest schema.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { TEMPLATES } from "../core/PromptTemplates.js";
import { exportSummaries } from "../core/SummaryExporter.js";
import { createLogger, setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

const log = createLogger("ExportCommand");

/**
 * Extracts all `{{key}}` placeholder names from a template string.
 *
 * Uses the same regex as `fillTemplate` and `findUnfilledPlaceholders` so the
 * extracted set matches what the runtime engine will actually substitute.
 * Returns deduped, sorted names.
 */
function extractPlaceholders(template: string): ReadonlyArray<string> {
	const set = new Set<string>();
	for (const match of template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
		set.add(match[1]);
	}
	return [...set].sort();
}

/** Manifest entry for a single prompt template — see plan 121 for schema. */
interface ManifestEntry {
	readonly action: string;
	readonly version: number;
	readonly template: string;
	readonly placeholders: ReadonlyArray<string>;
}

interface Manifest {
	readonly exportedAt: string;
	readonly cliVersion: string;
	readonly prompts: ReadonlyArray<ManifestEntry>;
}

/**
 * Returns the @jolli.ai/cli package version for the manifest's `cliVersion`
 * field.
 *
 * Prefers the build-time injected `__CLI_PKG_VERSION__` constant — both vite
 * (CLI standalone) and esbuild (VSCode-bundled CLI) define it from
 * `cli/package.json`. The latter is critical: the bundled `Cli.js` ships
 * inside the VSCode plugin, where `import.meta.url` resolves to
 * `vscode/dist/Cli.js` and a relative `../../package.json` would silently
 * pick up the VSCode extension's version (currently aligned but free to
 * diverge).
 *
 * Falls back to filesystem read for tsx / unbundled test runs where no
 * define is injected. Final "unknown" fallback keeps the command usable in
 * non-standard installs without crashing.
 */
async function readCliVersion(): Promise<string> {
	/* v8 ignore start -- compile-time ternary: __CLI_PKG_VERSION__ is always defined in bundled builds */
	if (typeof __CLI_PKG_VERSION__ !== "undefined") {
		return __CLI_PKG_VERSION__;
	}
	/* v8 ignore stop */
	try {
		// __dirname equivalent for ESM; resolves to src/commands/ in tsx / tests.
		// package.json sits at the cli package root, two levels up.
		const here = dirname(fileURLToPath(import.meta.url));
		const pkgPath = resolve(here, "..", "..", "package.json");
		const raw = await readFile(pkgPath, "utf-8");
		const parsed = JSON.parse(raw) as { version?: string };
		return parsed.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** Builds the manifest object from the in-memory TEMPLATES map. */
function buildManifest(cliVersion: string): Manifest {
	const prompts: ManifestEntry[] = [];
	for (const [, entry] of TEMPLATES) {
		prompts.push({
			action: entry.action,
			version: entry.version,
			template: entry.template,
			placeholders: extractPlaceholders(entry.template),
		});
	}
	// Stable ordering by action name for deterministic diffs across runs
	prompts.sort((a, b) => a.action.localeCompare(b.action));
	return {
		exportedAt: new Date().toISOString(),
		cliVersion,
		prompts,
	};
}

/**
 * Formats per-prompt markdown with YAML frontmatter (action, version, placeholders)
 * followed by the raw template body. Used for git-friendly per-prompt review files.
 *
 * `action` is quoted so future keys with YAML-significant characters (colons,
 * special quotes) parse correctly; the quote escaping treats the action as a
 * pure string regardless of content.
 */
function formatPromptMarkdown(entry: ManifestEntry): string {
	// Empty placeholder list collapses to flow style on a single line for clarity:
	// `placeholders: []` rather than a dangling block-style key with `  []` underneath.
	const placeholdersYaml =
		entry.placeholders.length > 0
			? `placeholders:\n${entry.placeholders.map((p) => `  - ${p}`).join("\n")}`
			: "placeholders: []";
	const escapedAction = entry.action.replace(/"/g, '\\"');
	return `---
action: "${escapedAction}"
version: ${entry.version}
${placeholdersYaml}
---

${entry.template}
`;
}

/** Sanitises an action name for use as a filename — replaces non-alphanumerics with `-`. */
function actionToFilename(action: string): string {
	return action.replace(/[^a-zA-Z0-9]+/g, "-");
}

/**
 * Writes the manifest and per-prompt .md files into the output directory.
 * Creates the directory recursively if it does not exist.
 */
async function writeExportToDir(outputDir: string, manifest: Manifest): Promise<void> {
	const absDir = resolve(outputDir);
	await mkdir(absDir, { recursive: true });

	// 1. Write manifest.json (the structured artifact backend runbook consumes)
	const manifestPath = join(absDir, "manifest.json");
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`, "utf-8");

	// 2. Write one .md per prompt (the human-readable artifact for review/diff)
	for (const entry of manifest.prompts) {
		const filePath = join(absDir, `${actionToFilename(entry.action)}.md`);
		await writeFile(filePath, formatPromptMarkdown(entry), "utf-8");
	}

	log.info("Exported %d prompt(s) to %s", manifest.prompts.length, absDir);
}

/**
 * Registers the `export-prompt` command on the given Commander program.
 */
export function registerExportPromptCommand(program: Command): void {
	program
		.command("export-prompt")
		.description(
			"Print prompt templates to stdout, or export to a folder with --output. Templates use {{placeholder}} syntax.",
		)
		.option("--action <key>", "Print a single template (e.g. summarize, commit-message, translate)")
		.option(
			"--output <dir>",
			"Write manifest.json + per-prompt .md files to <dir> (creates dir if missing). Combine with --action to write only one prompt.",
		)
		.action(async (opts: { action?: string; output?: string }) => {
			// Branch 1: --output → write files (manifest + per-prompt .md)
			if (opts.output) {
				const cliVersion = await readCliVersion();
				let manifest = buildManifest(cliVersion);
				if (opts.action) {
					const filtered = manifest.prompts.filter((p) => p.action === opts.action);
					if (filtered.length === 0) {
						const available = [...TEMPLATES.keys()].join(", ");
						console.error(`\n  Error: unknown action "${opts.action}"\n  Available: ${available}\n`);
						process.exitCode = 1;
						return;
					}
					manifest = { ...manifest, prompts: filtered };
				}
				await writeExportToDir(opts.output, manifest);
				console.log(
					`\n  Exported ${manifest.prompts.length} prompt(s) to ${resolve(opts.output)}\n  Manifest: ${join(resolve(opts.output), "manifest.json")}\n`,
				);
				return;
			}

			// Branch 2: stdout for a single template via --action.
			if (opts.action) {
				const entry = TEMPLATES.get(opts.action);
				if (!entry) {
					const available = [...TEMPLATES.keys()].join(", ");
					console.error(`\n  Error: unknown action "${opts.action}"\n  Available: ${available}\n`);
					process.exitCode = 1;
					return;
				}
				process.stdout.write(`${entry.template}\n`);
				return;
			}

			// Branch 3: no flags → guidance, not a wall of text.
			// Dumping all templates to stdout produces thousands of lines that overwhelm
			// terminal scrollback and rarely matches what the user actually wants.
			// Direct them to either pick one (--action) or write a folder (--output).
			const available = [...TEMPLATES.keys()].join(", ");
			console.log(
				[
					"",
					"  jolli export-prompt: prompt templates are large; choose how to export.",
					"",
					"  Pick a single template:",
					"    jolli export-prompt --action <key>",
					"",
					"  Or write all templates to a folder (manifest.json + per-prompt .md files):",
					"    jolli export-prompt --output <dir>",
					"",
					`  Available actions: ${available}`,
					"",
				].join("\n"),
			);
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
