/**
 * SummaryExporter
 *
 * Exports commit summaries from the git orphan branch as markdown files
 * to the agent-agnostic knowledge base at ~/Documents/jollimemory/<project>/.
 *
 * By default exports all summaries, skipping any that already have a file
 * in the output directory (matched by the 8-char commit hash prefix).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CommitSummary } from "../Types.js";
import { buildMarkdown } from "./SummaryMarkdownBuilder.js";
import { getSummary, listSummaries } from "./SummaryStore.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExportOptions {
	/** Export a single summary by commit hash. */
	readonly commit?: string;
	/** Override the project name (default: git repo basename). */
	readonly project?: string;
	/** Project directory (default: git repo root). */
	readonly cwd?: string;
}

export interface ExportResult {
	/** Absolute path to the output directory. */
	readonly outputDir: string;
	/** Number of new markdown files written (excluding index). */
	readonly filesWritten: number;
	/** Number of summaries skipped (already exported on disk — intentional, not a failure). */
	readonly filesSkipped: number;
	/** Number of summaries that failed to export (e.g. render or write errors). Non-zero signals partial/total failure to callers. */
	readonly filesErrored: number;
	/** Total summaries processed (written + skipped + errored). */
	readonly totalSummaries: number;
	/** Absolute path to the generated index file. */
	readonly indexPath: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolves the project name from the git repo root directory name. */
function resolveProjectName(cwd?: string): string {
	try {
		const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			cwd,
			windowsHide: true,
		}).trim();
		return basename(repoRoot);
	} catch {
		return basename(cwd ?? process.cwd());
	}
}

/**
 * Converts a commit message into a filesystem-safe slug.
 * Lowercase, non-alphanumeric chars become hyphens, collapsed, trimmed to 60 chars.
 */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.substring(0, 60);
}

/** Builds the markdown filename for a summary. */
export function buildFileName(summary: CommitSummary): string {
	const hashPrefix = summary.commitHash.substring(0, 8);
	const slug = slugify(summary.commitMessage);
	return `${hashPrefix}-${slug}.md`;
}

/**
 * Scans the output directory for existing exported files and returns
 * a set of 8-char commit hash prefixes that are already present.
 */
function getExistingHashes(outputDir: string): Set<string> {
	const hashes = new Set<string>();
	if (!existsSync(outputDir)) {
		return hashes;
	}
	for (const file of readdirSync(outputDir)) {
		// Files are named <8-char-hash>-<slug>.md
		const match = file.match(/^([a-f0-9]{8})-.*\.md$/);
		if (match) {
			hashes.add(match[1]);
		}
	}
	return hashes;
}

/** Builds a single markdown table row for the index. */
function buildIndexRow(summary: CommitSummary, hashPrefix: string, fileName: string): string {
	const date = summary.commitDate.substring(0, 10);
	const safeMessage = summary.commitMessage.replace(/\|/g, "\\|");
	return `| ${date} | \`${hashPrefix}\` | [${safeMessage}](./${fileName}) |`;
}

// ─── Main export function ─────────────────────────────────────────────────────

/**
 * Exports commit summaries as markdown files to the knowledge base.
 *
 * Output directory: ~/Documents/jollimemory/<project>/
 * Each summary becomes a markdown file named <hash>-<slug>.md.
 * Summaries that already have a file in the output directory are skipped.
 * index.md is rebuilt on every run from all processed summaries to stay in sync with disk.
 */
export async function exportSummaries(options: ExportOptions): Promise<ExportResult> {
	const projectName = basename(options.project ?? resolveProjectName(options.cwd));
	const outputDir = join(homedir(), "Documents", "jollimemory", projectName);

	// Collect summaries to export
	let summaries: ReadonlyArray<CommitSummary>;
	if (options.commit) {
		const summary = await getSummary(options.commit, options.cwd);
		summaries = summary ? [summary] : [];
	} else {
		summaries = await listSummaries(Number.MAX_SAFE_INTEGER, options.cwd);
	}

	// Ensure output directory exists
	mkdirSync(outputDir, { recursive: true });

	const indexPath = join(outputDir, "index.md");

	if (summaries.length === 0) {
		return { outputDir, filesWritten: 0, filesSkipped: 0, filesErrored: 0, totalSummaries: 0, indexPath };
	}

	// Check which summaries are already exported
	const existingHashes = getExistingHashes(outputDir);

	// Write new summaries and collect index rows for all summaries
	const indexRows: Array<string> = [];
	let filesWritten = 0;
	let filesSkipped = 0;
	let filesErrored = 0;

	for (const summary of summaries) {
		const fileName = buildFileName(summary);
		const hashPrefix = summary.commitHash.substring(0, 8);

		if (existingHashes.has(hashPrefix)) {
			filesSkipped++;
		} else {
			try {
				const markdown = buildMarkdown(summary);
				writeFileSync(join(outputDir, fileName), markdown, "utf-8");
				filesWritten++;
			} catch (err) {
				// Render or write failed (e.g. ENOSPC, EACCES). Surface as an error
				// count so the caller can distinguish a true skip from a failed write.
				console.error(`Failed to export ${hashPrefix}: ${err}`);
				filesErrored++;
			}
		}

		// Add every successfully-exported summary to the index (new or existing on disk)
		if (existsSync(join(outputDir, fileName))) {
			indexRows.push(buildIndexRow(summary, hashPrefix, fileName));
		}
	}

	// Rebuild index.md from all processed summaries to stay in sync with files on disk
	const indexLines = [
		`# Project Knowledge: ${projectName}`,
		"",
		"| Date | Commit | Summary |",
		"|------|--------|---------|",
		...indexRows,
		"",
	];
	writeFileSync(indexPath, indexLines.join("\n"), "utf-8");

	const totalSummaries = filesWritten + filesSkipped + filesErrored;
	return { outputDir, filesWritten, filesSkipped, filesErrored, totalSummaries, indexPath };
}
