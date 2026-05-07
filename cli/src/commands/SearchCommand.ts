/**
 * SearchCommand — `jolli search` CLI command.
 *
 * Provides the catalog-driven two-phase search invoked by the `/jolli-search`
 * skill template:
 *
 *   Phase 1: `jolli search <query> [--since X] [--limit N] [--budget T]`
 *            → outputs SearchCatalog (root-commit catalog for LLM scanning).
 *
 *   Phase 2: `jolli search <query> --hashes h1,h2,h3`
 *            → outputs SearchResult (full distilled content for picked hashes:
 *              recap + topics with trigger/response/decisions/files/category/
 *              importance + diffStats). Skill template Step 5 documents the
 *              schema and lets the LLM pick the render shape.
 *
 * The CLI is a pure function: no LLM calls, deterministic JSON output for the
 * skill template to parse.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Command, Option } from "commander";
import { LocalSearchProvider } from "../core/LocalSearchProvider.js";
import { DEFAULT_CATALOG_LIMIT, DEFAULT_SEARCH_BUDGET, type SearchCatalog, type SearchResult } from "../core/Search.js";
import { setLogDir } from "../Logger.js";
import { isSafeQuery, parsePositiveInt, resolveProjectDir } from "./CliUtils.js";

/**
 * Pattern matching a comma-separated list of git-style hex hashes.
 * Allows 4-64 hex chars per hash; permissive to short hashes is intentional —
 * `getSummary` falls back to alias/treeHash lookup when needed.
 */
const HASH_LIST_PATTERN = /^[0-9a-f]{4,64}(,[0-9a-f]{4,64})*$/i;

interface SearchOptions {
	since?: string;
	hashes?: string;
	limit?: number;
	budget?: number;
	format?: "json" | "text";
	output?: string;
	cwd?: string;
}

/** Splits a `--hashes` value into a list of trimmed, lowercased hashes. */
export function parseHashList(value: string | undefined): ReadonlyArray<string> | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (!HASH_LIST_PATTERN.test(trimmed)) return null;
	return trimmed
		.split(",")
		.map((h) => h.trim().toLowerCase())
		.filter((h) => h.length > 0);
}

/**
 * Renders a SearchCatalog as a compact human-readable text block (used when
 * `--format text` is passed for terminal-friendly inspection).
 */
function renderCatalogText(catalog: SearchCatalog): string {
	const lines: string[] = [];
	lines.push(`Search catalog for "${catalog.query}"`);
	lines.push(
		`  ${catalog.entries.length} of ${catalog.totalCandidates} candidates${catalog.truncated ? " (truncated)" : ""}, ~${catalog.estimatedTokens} tokens`,
	);
	lines.push("");
	for (const entry of catalog.entries) {
		const ticket = entry.ticketId ? ` [${entry.ticketId}]` : "";
		lines.push(`  ${entry.hash}  ${entry.branch}${ticket}  ${entry.date}`);
		if (entry.recap) lines.push(`    ${entry.recap}`);
		for (const t of entry.topics ?? []) {
			const cat = t.category ? ` [${t.category}]` : "";
			const imp = t.importance === "major" ? " ★" : "";
			lines.push(`    - ${t.title}${cat}${imp}`);
		}
	}
	if (catalog.entries.length === 0) {
		lines.push("  (no commits matched the filter)");
	}
	return lines.join("\n");
}

/** Renders a SearchResult as compact text (Phase 2 fallback). */
function renderResultText(result: SearchResult): string {
	const lines: string[] = [];
	lines.push(`Search hits for "${result.query}" (${result.results.length} of ${result.hashes.length})`);
	lines.push("");
	for (const hit of result.results) {
		lines.push(`  ${hit.hash}  ${hit.branch}  ${hit.commitDate}`);
		lines.push(`    ${hit.commitMessage.split("\n")[0]}`);
		// Compact topic-title preview — one line per topic, no decisions/response
		// dump (text format is for quick inspection, not deep reading; users who
		// want full content go through `--format json` to a chat or `jolli view
		// --commit <hash>`).
		for (const t of hit.topics) {
			lines.push(`    • ${t.title}`);
		}
	}
	if (result.results.length === 0) {
		lines.push("  (none of the requested hashes resolved to summaries)");
	}
	return lines.join("\n");
}

/**
 * Writes JSON or text output to stdout (or a file when `--output` is given).
 */
async function writeOutput(payload: unknown, options: SearchOptions, textFallback: () => string): Promise<void> {
	// `--format` always carries commander's default ("json"), so `options.format`
	// is non-undefined in practice. We still narrow with the cast for the type.
	const fmt = options.format as "json" | "text";
	const body = fmt === "json" ? JSON.stringify(payload, null, 2) : textFallback();

	if (options.output) {
		const parent = dirname(options.output);
		if (parent && parent !== ".") {
			await mkdir(parent, { recursive: true });
		}
		await writeFile(options.output, body, "utf-8");
		console.log(`Search output written to ${options.output}`);
		return;
	}

	console.log(body);
}

/**
 * Registers the `search` command on the given Commander program.
 */
export function registerSearchCommand(program: Command): void {
	program
		.command("search")
		.description("Search structured commit memories (Phase 1: catalog; Phase 2: --hashes detail load)")
		.argument("[words...]", "Query keyword(s). Multi-word queries are matched as a single intent.")
		.option("--since <date>", "Cutoff date — ISO (YYYY-MM-DD) or relative (7d/2w/1m/3y)")
		.option("--hashes <list>", "Comma-separated list of commit hashes to load full content for (Phase 2)")
		.option("--limit <n>", `Catalog entry hard cap (default: ${DEFAULT_CATALOG_LIMIT})`, parsePositiveInt)
		.option(
			"--budget <tokens>",
			`Token budget for catalog output (default: ${DEFAULT_SEARCH_BUDGET})`,
			parsePositiveInt,
		)
		.addOption(new Option("--format <fmt>", "Output format").choices(["json", "text"]).default("json"))
		.option("--output <path>", "Write output to file instead of stdout")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (words: string[], options: SearchOptions) => {
			try {
				// `--cwd` carries commander's default (resolveProjectDir() at
				// register time), so it's always defined when the action runs.
				const projectDir = options.cwd as string;
				setLogDir(projectDir);

				const query = words.length > 0 ? words.join(" ") : "";

				// Validate query characters when present (prevents shell injection).
				// Uses isSafeQuery — a deny-list of characters that escape a double-
				// quoted bash arg (`\` `` ` `` `$` `"` and control chars). Natural
				// punctuation (`?`, `#`, `(`, `:`, `,` …) is allowed so queries like
				// "why did we pick X over Y?" or "#789" are accepted.
				if (query.length > 0 && !isSafeQuery(query)) {
					emitError(
						options,
						"Invalid characters in query. Backslash, backtick, dollar sign, double-quote, and control characters are not allowed.",
					);
					return;
				}

				// --hashes implies Phase 2; require a query to anchor snippet
				// extraction (otherwise snippets fall back to field prefixes).
				if (options.hashes !== undefined) {
					const parsed = parseHashList(options.hashes);
					if (!parsed || parsed.length === 0) {
						emitError(
							options,
							"Invalid --hashes value. Expected comma-separated hex hashes (4-64 chars each).",
						);
						return;
					}
					if (query.length === 0) {
						emitError(options, "A query is required when using --hashes (used for snippet highlighting).");
						return;
					}

					const provider = new LocalSearchProvider(projectDir);
					const result = await provider.loadHits({ query, hashes: parsed });
					await writeOutput(result, options, () => renderResultText(result));
					return;
				}

				// Phase 1 — empty query is allowed (returns catalog of recent
				// commits the LLM can pick from based on the user's natural prompt).
				const provider = new LocalSearchProvider(projectDir);
				const catalog = await provider.buildCatalog({
					query,
					...(options.since !== undefined && { since: options.since }),
					...(options.limit !== undefined && { limit: options.limit }),
					...(options.budget !== undefined && { budget: options.budget }),
				});
				await writeOutput(catalog, options, () => renderCatalogText(catalog));
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				emitError(options, message);
			}
		});
}

function emitError(options: SearchOptions, message: string): void {
	// commander default fills `--format`; cast for the type, no fallback needed.
	const fmt = options.format as "json" | "text";
	if (fmt === "json") {
		console.log(JSON.stringify({ type: "error", message }));
	} else {
		console.error(`\n  Error: ${message}\n`);
	}
	// Always set a non-zero exit code so CI / shell pipelines can detect the
	// failure regardless of which output format the caller asked for.
	process.exitCode = 1;
}
