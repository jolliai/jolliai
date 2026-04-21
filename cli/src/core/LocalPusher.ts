/**
 * LocalPusher
 *
 * Writes a commit summary markdown file, its satellite plans/notes, and a
 * rebuilt index.md to a user-chosen local folder. Designed to be called from
 * the VSCode extension or CLI after a summary is generated.
 *
 * - Summary file: `<folder>/<hash8>-<slug>.md`
 * - Satellites:   `<folder>/Plans & Notes/<slug>.md`
 * - Index:        `<folder>/index.md` (rebuilt from on-disk files x SummaryStore)
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CommitSummary } from "../Types.js";
import { buildFileName } from "./SummaryExporter.js";
import { listSummaries } from "./SummaryStore.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** A satellite file (plan or note) to write alongside the summary. */
export interface SatelliteFile {
	readonly slug: string;
	readonly title: string;
	readonly content: string;
	/** If set, occurrences in summary markdown are rewritten to a relative path. */
	readonly jolliUrl?: string;
}

/** Options for {@link pushSummaryToLocal}. */
export interface LocalPushOptions {
	readonly folder: string;
	readonly summary: CommitSummary;
	readonly summaryMarkdown: string;
	readonly satellites: ReadonlyArray<SatelliteFile>;
	/** Working directory of the git repo (needed to read SummaryStore from the orphan branch). */
	readonly cwd?: string;
}

/** Result returned by {@link pushSummaryToLocal}. */
export interface LocalPushResult {
	readonly summaryPath: string;
	readonly satellitePaths: ReadonlyArray<string>;
	readonly indexPath: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SATELLITES_DIR = "Plans & Notes";
const INDEX_FILENAME = "index.md";

/**
 * Regex matching exported summary files on disk: `<8-hex-chars>-<slug>.md`.
 * Capture group 1 is the 8-char hash prefix.
 */
const SUMMARY_FILE_PATTERN = /^([a-f0-9]{8})-.*\.md$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Escapes special regex metacharacters in a string so it can be used as a
 * literal match inside a `new RegExp(...)` constructor.
 */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces Jolli URLs in the summary markdown with relative paths to the
 * corresponding satellite files in the "Plans & Notes" subfolder.
 */
function rewriteJolliUrls(markdown: string, satellites: ReadonlyArray<SatelliteFile>): string {
	let result = markdown;
	for (const sat of satellites) {
		if (!sat.jolliUrl) continue;
		const relativePath = `./${SATELLITES_DIR}/${sat.slug}.md`;
		const pattern = new RegExp(escapeRegExp(sat.jolliUrl), "g");
		result = result.replace(pattern, relativePath);
	}
	return result;
}

/**
 * Scans the folder for on-disk summary files and returns a Set of their
 * 8-char commit hash prefixes.
 */
function collectOnDiskHashes(folder: string): Set<string> {
	const hashes = new Set<string>();
	for (const file of readdirSync(folder)) {
		const match = file.match(SUMMARY_FILE_PATTERN);
		if (match) {
			hashes.add(match[1]);
		}
	}
	return hashes;
}

/** Builds a single markdown table row for the index. */
function buildIndexRow(summary: CommitSummary, fileName: string): string {
	const date = summary.commitDate.substring(0, 10);
	const hashPrefix = summary.commitHash.substring(0, 8);
	const safeMessage = summary.commitMessage.replace(/\|/g, "\\|");
	return `| ${date} | \`${hashPrefix}\` | [${safeMessage}](./${fileName}) |`;
}

/**
 * Rebuilds `<folder>/index.md` from on-disk summary files cross-referenced
 * with summaries from the SummaryStore. Only summaries whose file exists on
 * disk are included (intersection semantics).
 */
async function rebuildIndex(folder: string, cwd?: string): Promise<string> {
	const indexPath = join(folder, INDEX_FILENAME);

	// Collect 8-char hash prefixes for files already on disk
	const onDiskHashes = collectOnDiskHashes(folder);

	// Load all known summaries from the store (cwd is needed to locate the git repo)
	const allSummaries = await listSummaries(Number.MAX_SAFE_INTEGER, cwd);

	// Filter to summaries with a matching file on disk
	const present = allSummaries.filter((s) => onDiskHashes.has(s.commitHash.substring(0, 8)));

	// Sort by commitDate descending (newest first)
	const sorted = [...present].sort((a, b) => new Date(b.commitDate).getTime() - new Date(a.commitDate).getTime());

	// Build the index markdown
	const rows = sorted.map((s) => buildIndexRow(s, buildFileName(s)));
	const lines = ["# Memories Index", "", "| Date | Commit | Summary |", "|------|--------|---------|", ...rows, ""];
	writeFileSync(indexPath, lines.join("\n"), "utf-8");

	return indexPath;
}

// ─── Main function ───────────────────────────────────────────────────────────

/**
 * Pushes a commit summary and its satellite files to a local folder, then
 * rebuilds the index.md to reflect all on-disk summaries.
 */
export async function pushSummaryToLocal(options: LocalPushOptions): Promise<LocalPushResult> {
	const { folder, summary, summaryMarkdown, satellites, cwd } = options;

	// Ensure the output folder exists
	mkdirSync(folder, { recursive: true });

	// Rewrite Jolli URLs in the summary markdown before writing
	const rewrittenMarkdown = rewriteJolliUrls(summaryMarkdown, satellites);

	// Write the summary file
	const summaryFileName = buildFileName(summary);
	const summaryPath = join(folder, summaryFileName);
	writeFileSync(summaryPath, rewrittenMarkdown, "utf-8");

	// Write satellite files
	const satellitePaths: string[] = [];
	if (satellites.length > 0) {
		const satellitesDir = join(folder, SATELLITES_DIR);
		mkdirSync(satellitesDir, { recursive: true });
		for (const sat of satellites) {
			// Sanitize slug to prevent path traversal (e.g. "../" in slug)
			const satPath = join(satellitesDir, `${basename(sat.slug)}.md`);
			writeFileSync(satPath, sat.content, "utf-8");
			satellitePaths.push(satPath);
		}
	}

	// Rebuild the index from on-disk files x SummaryStore
	const indexPath = await rebuildIndex(folder, cwd);

	return { summaryPath, satellitePaths, indexPath };
}
