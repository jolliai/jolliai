/**
 * ViewCommand — Displays commit summaries in a human-readable terminal format.
 *
 * Default mode shows a compact commit list from the index (fast, no full summary load).
 * Use `--commit <ref>` to view a specific summary in full detail.
 * Supports numeric indexing (`--commit 1` = latest) and SHA lookup.
 * Use `--output <path>` to write a summary to a file.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Command, Option } from "commander";
import { getDisplayDate } from "../core/SummaryFormat.js";
import { buildMarkdown } from "../core/SummaryMarkdownBuilder.js";
import { getIndex, getSummary } from "../core/SummaryStore.js";
import { aggregateStats, aggregateTurns, collectAllTopics, formatDurationLabel } from "../core/SummaryTree.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { CommitSummary, SummaryIndexEntry, TopicSummary } from "../Types.js";
import { formatShortDate, parsePositiveInt, resolveProjectDir } from "./CliUtils.js";

const log = createLogger("view");

/** Maximum numeric index accepted (to distinguish from short SHAs). */
const MAX_NUMERIC_INDEX = 9999;

// ─── Compact list rendering ─────────────────────────────────────────────────

/** Formats diff stats as a compact string (e.g. "8 files +120"). */
function formatChanges(entry: SummaryIndexEntry): string {
	if (!entry.diffStats) return "";
	const { filesChanged, insertions } = entry.diffStats;
	return `${filesChanged} files +${insertions}`;
}

/** Returns a commit type badge (e.g. "[squash]") or empty string. */
function formatTypeBadge(entry: SummaryIndexEntry): string {
	if (!entry.commitType || entry.commitType === "commit") return "";
	return `  [${entry.commitType}]`;
}

/** Truncates a string to fit within maxLen, adding "..." if truncated. */
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.substring(0, maxLen - 3)}...`;
}

/**
 * Filters root entries from the index and returns them sorted newest-first.
 */
function getRootEntries(entries: ReadonlyArray<SummaryIndexEntry>): Array<SummaryIndexEntry> {
	return entries
		.filter((e) => e.parentCommitHash == null)
		.sort((a, b) => new Date(getDisplayDate(b)).getTime() - new Date(getDisplayDate(a)).getTime());
}

/**
 * Prints a compact commit list table to the console.
 */
function printCompactList(entries: ReadonlyArray<SummaryIndexEntry>, total: number): void {
	const termWidth = process.stdout.columns ?? 100;
	// Fixed columns: "#(4) Hash(10) Date(10) Topics(8) Changes(16)" = ~48 chars + padding
	const fixedWidth = 55;
	const msgWidth = Math.max(20, termWidth - fixedWidth);

	console.log(`\n  Recent Memories (${entries.length} of ${total})\n`);
	console.log("  #     Hash      Date      Summaries  Changes          Message");
	console.log(`  ${"\u2500".repeat(Math.min(termWidth - 4, 90))}`);

	for (const [i, entry] of entries.entries()) {
		const idx = String(i + 1).padStart(2);
		const hash = entry.commitHash.substring(0, 8);
		const date = formatShortDate(getDisplayDate(entry)).padEnd(10);
		const topics = String(entry.topicCount ?? 0).padStart(3);
		const changes = formatChanges(entry).padEnd(15);
		const badge = formatTypeBadge(entry);
		const msg = truncate(entry.commitMessage, msgWidth - badge.length) + badge;

		console.log(`  ${idx}   ${hash}  ${date}  ${topics}    ${changes}  ${msg}`);
	}

	console.log(`\n  View details: jolli view --commit 1`);
	console.log(`  Export to file: jolli view --commit 1 --output summary.md\n`);
}

/** Escapes a value for safe inclusion in a GFM table cell: `|` must be escaped and newlines collapsed. */
function escapeCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Builds a GFM-compatible markdown table from compact-list entries. */
function buildMarkdownTable(entries: ReadonlyArray<SummaryIndexEntry>): string {
	const rows = [
		"| # | Hash | Date | Summaries | Changes | Message |",
		"|---|---|---|---|---|---|",
		...entries.map(
			(e, i) =>
				`| ${i + 1} | ${e.commitHash.substring(0, 8)} | ${formatShortDate(getDisplayDate(e))} | ${e.topicCount ?? 0} | ${formatChanges(e)} | ${escapeCell(e.commitMessage)} |`,
		),
	];
	return rows.join("\n");
}

// ─── Detail rendering ───────────────────────────────────────────────────────

/**
 * Formats commitType + commitSource for CLI display.
 * Returns null when both are default values (commit/cli).
 */
function formatCommitType(commitType?: string, commitSource?: string): string | null {
	const isDefaultType = !commitType || commitType === "commit";
	const isDefaultSource = !commitSource || commitSource === "cli";
	if (isDefaultType && isDefaultSource) return null;

	const typeLabel = commitType ?? "commit";
	const sourceSuffix = !isDefaultSource ? ` via ${commitSource}` : "";
	return `${typeLabel}${sourceSuffix}`;
}

/** Prints a formatted full summary to the console. */
function printSummary(summary: CommitSummary): void {
	console.log(`  ${"─".repeat(38)}`);
	console.log(`  Commit:  ${summary.commitHash.substring(0, 8)} \u2014 ${summary.commitMessage}`);
	console.log(`  Branch:  ${summary.branch}`);

	const typeInfo = formatCommitType(summary.commitType, summary.commitSource);
	if (typeInfo) console.log(`  Commit Type: ${typeInfo}`);

	console.log(`  Date:    ${getDisplayDate(summary)}`);
	console.log(`  Duration: ${formatDurationLabel(summary)}`);

	const stats = aggregateStats(summary);
	const statsStr = `${stats.filesChanged} files, +${stats.insertions} -${stats.deletions}`;
	console.log(`  Changes: ${statsStr}`);

	const totalTurns = aggregateTurns(summary);
	if (totalTurns > 0) {
		console.log(`  Conversations: ${totalTurns} turns`);
	}

	if (summary.llm) {
		const llmStr = `${summary.llm.model}  |  Tokens: ${summary.llm.inputTokens}\u2191 ${summary.llm.outputTokens}\u2193  |  Latency: ${summary.llm.apiLatencyMs}ms`;
		console.log(`  Model:   ${llmStr}`);
	}

	console.log("");
	const allTopics = collectAllTopics(summary);
	if (allTopics.length === 0) {
		console.log("  Summaries: (none \u2014 LLM did not generate any for this commit)\n");
	} else {
		printTopics(allTopics);
	}
}

/** Prints a list of topics to the console. */
function printTopics(topics: ReadonlyArray<TopicSummary>, indent = ""): void {
	/* v8 ignore start -- defensive: caller already checks for empty topics */
	if (topics.length === 0) {
		return;
	}
	/* v8 ignore stop */
	const sorted = [...topics].sort((a, b) => {
		const impA = a.importance === "minor" ? 1 : 0;
		const impB = b.importance === "minor" ? 1 : 0;
		return impA - impB;
	});
	const label = topics.length === 1 ? "Summary" : "Summaries";
	console.log(`${indent}  ${label}:\n`);
	const pad = `${indent}     `;
	for (const [i, topic] of sorted.entries()) {
		const catStr = topic.category ? ` [${topic.category}]` : "";
		const impStr = topic.importance === "minor" ? " (minor)" : "";
		console.log(`${indent}  ${i + 1}. ${topic.title}${catStr}${impStr}\n`);
		console.log(`${pad}Why this change`);
		printWrapped(topic.trigger, pad);
		console.log(`${pad}Decisions behind the code`);
		printWrapped(topic.decisions, pad);
		console.log(`${pad}What was implemented`);
		printWrapped(topic.response, pad);
		if (topic.todo && !/^none\.?$/i.test(topic.todo.trim())) {
			console.log(`${pad}Todo`);
			printWrapped(topic.todo, pad);
		}
		if (topic.filesAffected && topic.filesAffected.length > 0) {
			console.log(`${pad}Files: ${topic.filesAffected.join(", ")}`);
		}
		console.log("");
	}
}

/** Prints multi-line text with consistent indentation. */
function printWrapped(text: string, pad: string): void {
	for (const line of text.split("\n")) {
		console.log(`${pad}${line}`);
	}
	console.log("");
}

// ─── Commit resolution ──────────────────────────────────────────────────────

/**
 * Resolves a --commit reference to a CommitSummary.
 * Supports numeric index (1 = latest, 2 = second latest) or SHA prefix.
 */
async function resolveCommit(ref: string, cwd: string): Promise<CommitSummary | null> {
	const num = /^\d+$/.test(ref) ? Number.parseInt(ref, 10) : Number.NaN;
	if (Number.isFinite(num) && num > 0 && num <= MAX_NUMERIC_INDEX) {
		// Numeric index: look up Nth most recent root entry
		const index = await getIndex(cwd);
		if (!index) {
			console.log("\n  No summaries found. Start coding with your AI agent and commit!\n");
			return null;
		}
		const roots = getRootEntries(index.entries);
		const target = roots[num - 1];
		if (!target) {
			console.log(`\n  No summary at index #${num} (${roots.length} total)\n`);
			return null;
		}
		return getSummary(target.commitHash, cwd);
	}
	// SHA lookup
	return getSummary(ref, cwd);
}

// ─── Output helpers ─────────────────────────────────────────────────────────

/** Writes content to a file, creating parent directories as needed. Returns the absolute path. */
async function writeOutputFile(filePath: string, content: string): Promise<string> {
	const absPath = resolve(filePath);
	await mkdir(dirname(absPath), { recursive: true });
	await writeFile(absPath, content, "utf-8");
	return absPath;
}

/** Formats a file path as a clickable terminal link (file:// URI). */
function fileLink(absPath: string): string {
	return pathToFileURL(absPath).href;
}

// ─── Command registration ───────────────────────────────────────────────────

/** Registers the `view` sub-command on the given Commander program. */
export function registerViewCommand(program: Command): void {
	program
		.command("view")
		.description("View commit summaries (compact list by default, or full detail with --commit)")
		.option("--count <n>", "Number of entries to show in compact list (default: 10)", parsePositiveInt)
		.option("--commit <ref>", "View full summary by commit SHA or numeric index (1 = latest)")
		.option("--output <path>", "Write summary to file instead of stdout")
		.addOption(new Option("--format <fmt>", "Output format").choices(["md", "json"]))
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { count?: number; commit?: string; output?: string; format?: string; cwd: string }) => {
			setLogDir(options.cwd);
			log.info("Running 'view' command");

			if (options.commit) {
				// View specific commit (by index or SHA)
				const summary = await resolveCommit(options.commit, options.cwd);
				if (!summary) {
					if (!/^\d+$/.test(options.commit)) {
						console.log(`\n  No summary found for commit ${options.commit}\n`);
					}
					return;
				}

				// Output to file
				if (options.output) {
					const format = options.format ?? "md";
					const content = format === "json" ? JSON.stringify(summary, null, 2) : buildMarkdown(summary);
					const absPath = await writeOutputFile(options.output, content);
					console.log(`\n  Summary written to ${fileLink(absPath)}\n`);
					return;
				}

				// JSON to stdout
				if (options.format === "json") {
					process.stdout.write(JSON.stringify(summary, null, 2));
					return;
				}

				// Full detail to console
				printSummary(summary);
				return;
			}

			// Default: compact commit list
			const index = await getIndex(options.cwd);
			const roots = index ? getRootEntries(index.entries) : [];
			const total = roots.length;

			if (total === 0) {
				console.log("\n  No summaries found. Start coding with your AI agent and commit!\n");
				return;
			}

			const count = options.count ?? 10;
			const displayed = roots.slice(0, count);

			// Output to file
			if (options.output) {
				const format = options.format ?? "json";
				const content = format === "json" ? JSON.stringify(displayed, null, 2) : buildMarkdownTable(displayed);
				const absPath = await writeOutputFile(options.output, content);
				console.log(`\n  Commit list written to ${fileLink(absPath)}\n`);
				return;
			}

			// JSON to stdout
			if (options.format === "json") {
				process.stdout.write(JSON.stringify(displayed, null, 2));
				return;
			}

			// Compact table to console
			printCompactList(displayed, total);
		});
}
