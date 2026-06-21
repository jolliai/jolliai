/**
 * SearchCommand — `jolli search` CLI command.
 *
 * Single-phase BM25 search over distilled commit summaries. Emits `{ hits }`
 * JSON (or a compact text render) — the same result the MCP `search` tool
 * returns so the skill's CLI fallback is identical to the primary path.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Command, Option } from "commander";
import { searchHits } from "../core/SearchHits.js";
import type { SearchHitResult } from "../core/SearchIndex.js";
import { createStorage } from "../core/StorageFactory.js";
import { getActiveStorage, setActiveStorage } from "../core/SummaryStore.js";
import { setLogDir } from "../Logger.js";
import { isSafeQuery, parsePositiveInt, readStdin, resolveProjectDir } from "./CliUtils.js";

interface SearchOptions {
	limit?: number;
	branch?: string;
	type?: "topic" | "commit";
	format?: "json" | "text";
	output?: string;
	cwd?: string;
	argStdin?: boolean;
}

/**
 * Renders a list of SearchHitResult as a compact human-readable text block
 * (used when `--format text` is passed for terminal-friendly inspection).
 *
 * One line per hit: `hash  branch  date  title`
 */
function renderHitsText(hits: SearchHitResult[]): string {
	if (hits.length === 0) {
		return "(no hits matched the query)";
	}
	return hits
		.map((h) => {
			const date = h.commitDate.slice(0, 10);
			return `${h.hash}  ${h.branch}  ${date}  ${h.title}`;
		})
		.join("\n");
}

/**
 * Writes JSON or text output to stdout (or a file when `--output` is given).
 */
async function writeOutput(payload: unknown, options: SearchOptions, textFallback: () => string): Promise<void> {
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

function emitError(options: SearchOptions, message: string): void {
	const fmt = options.format as "json" | "text";
	if (fmt === "json") {
		console.log(JSON.stringify({ type: "error", message }));
	} else {
		console.error(`\n  Error: ${message}\n`);
	}
	process.exitCode = 1;
}

/**
 * Registers the `search` command on the given Commander program.
 */
export function registerSearchCommand(program: Command): void {
	program
		.command("search")
		.description("Search structured commit memories (BM25 over distilled summaries)")
		.argument("[words...]", "Query keyword(s)")
		.option("--limit <n>", "Max hits (default 20)", parsePositiveInt)
		.option("--branch <branch>", "Restrict to one branch")
		.addOption(new Option("--type <kind>", "Restrict result kind").choices(["topic", "commit"]))
		.addOption(new Option("--format <fmt>", "Output format").choices(["json", "text"]).default("json"))
		.option("--output <path>", "Write output to file instead of stdout")
		.option("--arg-stdin", "Read the query from stdin (used by SKILL.md here-doc bridge)")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (words: string[], options: SearchOptions) => {
			try {
				const projectDir = options.cwd as string;
				setLogDir(projectDir);
				// Establish the configured storage backend before any read — same as
				// the MCP server (McpServer.startMcpServer). Without this, searchHits
				// falls through resolveStorage to the orphan branch, so a folder-mode
				// user's `jolli search` (the skill's CLI fallback) would index a
				// different store than the MCP `search` tool and break the documented
				// "CLI fallback === MCP primary" parity.
				setActiveStorage(await createStorage(projectDir, projectDir));

				if (options.argStdin && words.length > 0) {
					emitError(
						options,
						"--arg-stdin and positional [words...] are mutually exclusive. Pass the query via stdin OR positional, not both.",
					);
					return;
				}

				const query = options.argStdin ? await readStdin() : words.join(" ");

				if (!query || !query.trim()) {
					emitError(options, "A query is required.");
					return;
				}

				// Injection defense is only meaningful on the here-doc bash bridge
				// (`--arg-stdin`, used by the skill template): that is the only path
				// where the query is interpolated into a shell. A direct argv query
				// — and the MCP `search` tool — never re-enters a shell and flows
				// solely into the in-process Orama index, so validating those would
				// reject characters (`$`, `` ` ``, …) the MCP path happily accepts and
				// break the documented "CLI fallback === MCP primary" parity. Gate the
				// check on `--arg-stdin` so the two surfaces return identical results.
				if (options.argStdin && !isSafeQuery(query)) {
					emitError(
						options,
						"Invalid characters in query. Backslash, backtick, dollar sign, double-quote, and control characters are not allowed.",
					);
					return;
				}

				const hits = await searchHits(
					projectDir,
					{
						query,
						...(options.branch !== undefined && { branch: options.branch }),
						...(options.type !== undefined && { type: options.type }),
						...(options.limit !== undefined && { limit: options.limit }),
					},
					getActiveStorage(),
				);

				await writeOutput({ hits }, options, () => renderHitsText(hits));
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				emitError(options, message);
			}
		});
}
