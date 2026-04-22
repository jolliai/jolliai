#!/usr/bin/env node
/**
 * SessionStartHook — Claude Code SessionStart Event Handler
 *
 * This script is invoked by Claude Code's hook system when a new session starts.
 * It outputs a mini-briefing as additionalContext, giving the LLM basic awareness
 * of the current branch's development history.
 *
 * The hook:
 *   1. Detects the current git branch
 *   2. Checks Jolli Memory index for recorded commits on this branch
 *   3. Loads the last commit's summary for topic titles and key decisions
 *   4. Reads local plans.json for associated plan names
 *   5. Outputs a concise briefing (~300-500 tokens) as plain text to stdout
 *
 * Performance target: <200ms with 500ms hard timeout.
 * Uses briefing cache to avoid redundant git calls when branch/commit unchanged.
 *
 * Data sources (~3 git calls + 1 fs read):
 *   - git branch --show-current → current branch name
 *   - orphan branch index.json → commit count, dates, diffStats
 *   - orphan branch summaries/{hash}.json → last topic title, decisions
 *   - .jolli/jollimemory/plans.json → associated plan names
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFileFromBranch } from "../core/GitOps.js";
import { getDisplayDate } from "../core/SummaryFormat.js";
import { getIndex } from "../core/SummaryStore.js";
import { collectAllTopics } from "../core/SummaryTree.js";
import { createLogger, ORPHAN_BRANCH, setLogDir } from "../Logger.js";
import type { CommitSummary, DiffStats, PlansRegistry, SummaryIndexEntry } from "../Types.js";
import { readStdin } from "./HookUtils.js";

const log = createLogger("SessionStartHook");

/** Branches that should be skipped (not feature branches) */
const SKIP_BRANCHES = new Set(["main", "master", "develop", "development", "staging", "production"]);

const HARD_TIMEOUT_MS = 500;

interface BriefingCache {
	readonly branch: string;
	readonly lastCommitHash: string;
	readonly briefingText: string;
	readonly generatedAt: string;
}

/**
 * Main entry point — called when this script is executed by Claude Code SessionStart hook.
 */
export async function main(): Promise<void> {
	try {
		const input = await readStdin();
		const { cwd } = JSON.parse(input) as { cwd?: string };
		const projectDir = cwd ?? process.cwd();
		setLogDir(projectDir);

		log.info("SessionStartHook invoked (cwd=%s)", projectDir);

		const result = await Promise.race([generateBriefing(projectDir), timeout(HARD_TIMEOUT_MS)]);

		if (result) {
			log.info("Briefing generated (%d chars)", result.length);
			// Output plain text — Claude Code displays it to the user AND
			// injects it into Claude's context. JSON hookSpecificOutput is
			// invisible to users, so we use plain text for visibility.
			process.stdout.write(result);
		} else {
			log.info("No briefing generated (skipped or timed out)");
		}
	} catch (error: unknown) {
		/* v8 ignore next 2 - defensive: main() catches unexpected errors to never block session startup */
		log.info("SessionStartHook failed: %s", (error as Error).message);
	}
}

/**
 * Generates a briefing for the current branch, or returns null to skip.
 */
async function generateBriefing(projectDir: string): Promise<string | null> {
	// Step 1: Get current branch
	const branch = getCurrentBranch(projectDir);
	if (!branch || SKIP_BRANCHES.has(branch)) {
		return null;
	}

	// Step 2: Check briefing cache
	const cacheResult = checkBriefingCache(projectDir, branch);
	if (cacheResult) {
		return cacheResult;
	}

	// Step 3: Load index and filter for this branch
	const index = await getIndex(projectDir);
	if (!index) {
		return null;
	}

	const rootEntries = index.entries.filter(
		(e) => e.branch === branch && (e.parentCommitHash === null || e.parentCommitHash === undefined),
	);

	if (rootEntries.length === 0) {
		return null;
	}

	// Sort by activity date (newest first, to find "last worked on") — see getDisplayDate.
	const sorted = [...rootEntries].sort(
		(a, b) => new Date(getDisplayDate(b)).getTime() - new Date(getDisplayDate(a)).getTime(),
	);

	const lastEntry = sorted[0];
	const oldestEntry = sorted[sorted.length - 1];

	// Skip if only 1 commit made today
	if (sorted.length === 1 && isToday(getDisplayDate(lastEntry))) {
		return null;
	}

	// Step 4: Load last commit's summary for topic titles and decisions
	const lastSummary = await loadLastSummary(lastEntry.commitHash, projectDir);

	// Step 5: Load local plans.json for associated plan names
	const planNames = loadAssociatedPlanNames(projectDir, branch);

	// Step 6: Aggregate diffStats from index entries (cached since PROJ-597)
	const aggregatedDiffStats = aggregateIndexDiffStats(sorted);

	// Step 7: Build enriched briefing
	const briefing = buildBriefingText(
		branch,
		sorted,
		lastEntry,
		oldestEntry,
		lastSummary,
		planNames,
		aggregatedDiffStats,
	);

	// Step 8: Cache the result (use HEAD hash as cache key, not index commit hash,
	// because HEAD may be ahead of the last summarized commit during active development)
	const headHash = getCurrentHeadHash(projectDir);
	saveBriefingCache(projectDir, branch, headHash ?? lastEntry.commitHash, briefing);

	return briefing;
}

// ─── Summary and plan data loading ──────────────────────────────────────────

/** Extracted data from the last commit's summary */
interface LastSummaryData {
	readonly lastTopicTitle: string | null;
	readonly keyDecisions: ReadonlyArray<string>;
}

/**
 * Loads the last commit's summary file directly (one git call).
 * Extracts topic title and key decisions without loading the full tree.
 */
async function loadLastSummary(commitHash: string, cwd: string): Promise<LastSummaryData> {
	try {
		const raw = await readFileFromBranch(ORPHAN_BRANCH, `summaries/${commitHash}.json`, cwd);
		if (!raw) {
			return { lastTopicTitle: null, keyDecisions: [] };
		}
		const summary = JSON.parse(raw) as CommitSummary;
		const topics = collectAllTopics(summary);

		// Get the most recent topic's title (topics are chronological, last = newest)
		const lastTopicTitle = topics.length > 0 ? topics[topics.length - 1].title : null;

		// Collect all non-empty decisions
		const keyDecisions: string[] = [];
		for (const topic of topics) {
			if (topic.decisions && topic.decisions.trim().length > 0) {
				keyDecisions.push(topic.decisions);
			}
		}

		return { lastTopicTitle, keyDecisions };
	} catch (error: unknown) {
		/* v8 ignore next 3 - defensive: summary load failure degrades gracefully */
		log.info("Failed to load last summary: %s", (error as Error).message);
		return { lastTopicTitle: null, keyDecisions: [] };
	}
}

/**
 * Reads local plans.json to find active plan names for the current branch.
 * Pure filesystem read — no git calls.
 */
function loadAssociatedPlanNames(projectDir: string, branch: string): ReadonlyArray<string> {
	try {
		const plansPath = join(projectDir, ".jolli", "jollimemory", "plans.json");
		if (!existsSync(plansPath)) return [];

		const registry = JSON.parse(readFileSync(plansPath, "utf-8")) as PlansRegistry;
		const names: string[] = [];
		for (const entry of Object.values(registry.plans)) {
			// Include active plans for this branch (not archived, not ignored)
			if (!entry.commitHash && !entry.ignored && entry.title && entry.branch === branch) {
				names.push(entry.title);
			}
		}
		return names;
	} catch {
		/* v8 ignore next 2 - defensive: plans.json parse failure */
		return [];
	}
}

/**
 * Aggregates diffStats from index entries that have cached stats.
 * Entries without diffStats (legacy) are skipped — partial data is better than none.
 */
function aggregateIndexDiffStats(entries: ReadonlyArray<SummaryIndexEntry>): DiffStats | null {
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;
	let hasAny = false;

	for (const entry of entries) {
		if (entry.diffStats) {
			filesChanged += entry.diffStats.filesChanged;
			insertions += entry.diffStats.insertions;
			deletions += entry.diffStats.deletions;
			hasAny = true;
		}
	}

	return hasAny ? { filesChanged, insertions, deletions } : null;
}

// ─── Briefing text builder ──────────────────────────────────────────────────

/**
 * Builds the enriched briefing text from index + summary + plan data.
 *
 * Output format targets ~300-500 tokens for the LLM's context window.
 */
function buildBriefingText(
	branch: string,
	entries: ReadonlyArray<SummaryIndexEntry>,
	lastEntry: SummaryIndexEntry,
	oldestEntry: SummaryIndexEntry,
	summaryData: LastSummaryData,
	planNames: ReadonlyArray<string>,
	diffStats: DiffStats | null,
): string {
	const commitCount = entries.length;
	const periodStart = formatDate(getDisplayDate(oldestEntry));
	const periodEnd = formatDate(getDisplayDate(lastEntry));
	const daysSinceLastCommit = daysBetween(getDisplayDate(lastEntry), new Date().toISOString());

	const lines: string[] = [];

	// Line 1: Branch header
	lines.push(`[Jolli Memory — ${branch}]`);

	// Line 2: Commit stats + diffStats
	let statsLine = `${commitCount} commits (${periodStart} ~ ${periodEnd})`;
	if (diffStats) {
		statsLine += ` | ${diffStats.filesChanged} files, +${diffStats.insertions} -${diffStats.deletions}`;
	}
	lines.push(statsLine);

	// Line 3: Last topic (from summary) or fallback to commit message
	const lastLabel = summaryData.lastTopicTitle ?? lastEntry.commitMessage;
	lines.push(`Last: ${lastLabel} (${periodEnd})`);

	// Line 4: Key decisions (semicolon-separated, truncated to fit)
	if (summaryData.keyDecisions.length > 0) {
		const decisionsText = truncateDecisions(summaryData.keyDecisions);
		lines.push(`Decisions: ${decisionsText}`);
	}

	// Line 5: Associated plans
	if (planNames.length > 0) {
		lines.push(`Plans: ${planNames.join("; ")}`);
	}

	// Line 6: Recall suggestion based on time gap
	if (daysSinceLastCommit > 3) {
		lines.push(
			`Warning: ${daysSinceLastCommit} days since last commit. Suggest running /jolli-recall for full context.`,
		);
	} else if (daysSinceLastCommit > 0) {
		lines.push("Tip: /jolli-recall for full context");
	}

	return lines.join("\n");
}

/**
 * Truncates a list of decisions into a semicolon-separated string,
 * keeping it under ~200 characters to avoid bloating the briefing.
 */
function truncateDecisions(decisions: ReadonlyArray<string>): string {
	const MAX_LENGTH = 200;
	const joined: string[] = [];
	let totalLength = 0;

	for (const decision of decisions) {
		// Strip trailing period/semicolon for consistency
		let clean = decision.replace(/[.;]\s*$/, "").trim();
		// Hard-cap individual decisions that exceed the limit
		if (clean.length > MAX_LENGTH) {
			clean = `${clean.slice(0, MAX_LENGTH - 1)}…`;
		}
		if (totalLength + clean.length > MAX_LENGTH && joined.length > 0) {
			break;
		}
		joined.push(clean);
		// +2 for the "; " separator
		totalLength += clean.length + 2;
	}

	return joined.join("; ");
}

// ─── Briefing cache ─────────────────────────────────────────────────────────

function getBriefingCachePath(projectDir: string): string {
	return join(projectDir, ".jolli", "jollimemory", "briefing-cache.json");
}

function checkBriefingCache(projectDir: string, branch: string): string | null {
	const cachePath = getBriefingCachePath(projectDir);
	if (!existsSync(cachePath)) return null;

	try {
		const cache = JSON.parse(readFileSync(cachePath, "utf-8")) as BriefingCache;
		if (cache.branch !== branch) return null;

		// Validate that HEAD hasn't moved since we cached the briefing
		const currentHead = getCurrentHeadHash(projectDir);
		if (!currentHead || cache.lastCommitHash !== currentHead) return null;

		return cache.briefingText;
	} catch {
		return null;
	}
}

function saveBriefingCache(projectDir: string, branch: string, lastCommitHash: string, briefingText: string): void {
	const cachePath = getBriefingCachePath(projectDir);
	const cache: BriefingCache = {
		branch,
		lastCommitHash,
		briefingText,
		generatedAt: new Date().toISOString(),
	};

	try {
		const dir = dirname(cachePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(cachePath, JSON.stringify(cache, null, "\t"), "utf-8");
	} catch {
		// Non-critical — cache write failure is fine
	}
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function getCurrentHeadHash(projectDir: string): string | null {
	try {
		return (
			execFileSync("git", ["rev-parse", "HEAD"], {
				encoding: "utf-8",
				cwd: projectDir,
				windowsHide: true,
			}).trim() || null
		);
	} catch {
		/* v8 ignore next */ return null;
	}
}

function getCurrentBranch(projectDir: string): string | null {
	try {
		return (
			execFileSync("git", ["branch", "--show-current"], {
				encoding: "utf-8",
				cwd: projectDir,
				windowsHide: true,
			}).trim() || null
		);
	} catch {
		/* v8 ignore next */ return null;
	}
}

/* v8 ignore next 6 - timeout is used internally by Promise.race; not directly testable */
function timeout(ms: number): Promise<null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		timer.unref();
	});
}

function isToday(isoDate: string): boolean {
	const date = new Date(isoDate);
	const today = new Date();
	return (
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate()
	);
}

function daysBetween(isoA: string, isoB: string): number {
	const a = new Date(isoA).getTime();
	const b = new Date(isoB).getTime();
	return Math.floor(Math.abs(b - a) / (1000 * 60 * 60 * 24));
}

function formatDate(iso: string): string {
	/* v8 ignore next */
	if (!iso) return "unknown";
	return iso.split("T")[0];
}

/* v8 ignore next 3 - script entry point */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	main();
}
