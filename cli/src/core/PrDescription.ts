/**
 * PR description assembly — the CLI source of truth for the title + body the
 * VS Code extension and the `get_pr_description` MCP tool both produce.
 *
 * `buildPrDescription` mirrors the extension step-for-step:
 *   list branch commits → load summaries (track missing) → pick title →
 *   build body → optionally wrap in idempotent update markers.
 */

import type { CommitSummary } from "../Types.js";
import { listBranchCommitHashes } from "./BranchCommitLister.js";
import { getCurrentBranch, getDefaultBranch } from "./GitOps.js";
import { getQueueStatus } from "./QueueStatus.js";
import { buildAggregatedPrMarkdown } from "./SummaryPrAggregateMarkdownBuilder.js";
import { buildPrMarkdown } from "./SummaryPrMarkdownBuilder.js";
import { getSummary } from "./SummaryStore.js";

export const MARKER_START = "<!-- jollimemory-summary-start -->";
export const MARKER_END = "<!-- jollimemory-summary-end -->";

/** Wraps markdown content with start/end markers (idempotent PR updates). */
export function wrapWithMarkers(markdown: string): string {
	return `${MARKER_START}\n${markdown}\n${MARKER_END}`;
}

/**
 * Picks the commit message to use as the PR title, mirroring
 * `buildPrBodyMarkdown`'s three-tier selection so title and body share a source.
 */
export function pickPrTitle(currentSummary: CommitSummary, summaries: ReadonlyArray<CommitSummary>): string {
	if (summaries.length >= 2) return summaries[summaries.length - 1].commitMessage;
	if (summaries.length === 1) return summaries[0].commitMessage;
	return currentSummary.commitMessage;
}

export function buildPrBodyMarkdown(
	currentSummary: CommitSummary,
	summaries: ReadonlyArray<CommitSummary>,
	missingCount: number,
): string {
	if (summaries.length >= 2) return buildAggregatedPrMarkdown(summaries, missingCount);
	const source = summaries.length === 1 ? summaries[0] : currentSummary;
	const base = buildPrMarkdown(source);
	if (missingCount <= 0 || summaries.length === 0) return base;
	return `${base}\n\n> Note: ${missingCount} commit(s) without summary were skipped.`;
}

/**
 * Loads `CommitSummary` objects for `base..HEAD` in chronological order
 * (oldest first), tracking commits with no recorded summary. CLI analogue of
 * the vscode `BranchSummaryLoader` — reads through `getSummary` (active storage)
 * instead of the vscode bridge.
 */
export async function loadBranchSummaries(
	cwd: string,
	mainBranch: string,
): Promise<{ summaries: ReadonlyArray<CommitSummary>; missingCount: number }> {
	const { hashes } = await listBranchCommitHashes(cwd, mainBranch);
	if (hashes.length === 0) return { summaries: [], missingCount: 0 };

	// listBranchCommitHashes returns newest-first; reverse for chronological order.
	const chronological = hashes.slice().reverse();
	const settled = await Promise.allSettled(chronological.map((h) => getSummary(h, cwd)));

	const summaries: Array<CommitSummary> = [];
	let missingCount = 0;
	for (const r of settled) {
		if (r.status === "fulfilled" && r.value) {
			summaries.push(r.value);
		} else {
			missingCount++;
		}
	}
	return { summaries, missingCount };
}

export interface PrDescriptionResult {
	type: "pr_description";
	branch: string;
	baseBranch: string;
	title: string;
	body: string;
	commitCount: number;
	summaryCount: number;
	missingCount: number;
	/**
	 * Non-ingest queue entries still pending — backstop so a single call reveals
	 * in-progress generation. This result has no `drained` field (unlike
	 * `queue_status`), so a consumer relying only on these two backstop fields
	 * derives "generation in progress" as `queueActive > 0 || workerBlocking`.
	 */
	queueActive: number;
	/** True when a summary is still being written (worker blocking-busy). */
	workerBlocking: boolean;
}

export interface BuildPrDescriptionOpts {
	baseBranch?: string;
	includeMarkers?: boolean;
}

/**
 * Orchestrates a full PR description for the CURRENT branch. The commit range is
 * always `base..HEAD` (`listBranchCommitHashes` reads HEAD), so there is no
 * `branch` option — describing an arbitrary branch would require checking it out.
 * Throws when the branch has no recorded summaries (the caller surfaces it).
 */
export async function buildPrDescription(cwd: string, opts: BuildPrDescriptionOpts): Promise<PrDescriptionResult> {
	const branch = await getCurrentBranch(cwd);
	// Default the commit-range base to the repo's real default branch (origin/HEAD)
	// rather than a hardcoded "main" — a master/develop/trunk repo would otherwise
	// have an empty merge-base and spuriously report "no JolliMemory summaries".
	const baseBranch = opts.baseBranch ?? (await getDefaultBranch(cwd));
	const includeMarkers = opts.includeMarkers ?? true;

	const { summaries, missingCount } = await loadBranchSummaries(cwd, baseBranch);
	if (summaries.length === 0) {
		throw new Error(
			`No JolliMemory summaries found on branch "${branch}" (base "${baseBranch}"). Commit memory before creating a PR.`,
		);
	}

	// summaries are chronological (oldest first); HEAD is last → currentSummary.
	const currentSummary = summaries[summaries.length - 1];
	const title = pickPrTitle(currentSummary, summaries);
	const rawBody = buildPrBodyMarkdown(currentSummary, summaries, missingCount);
	const body = includeMarkers ? wrapWithMarkers(rawBody) : rawBody;

	const queue = await getQueueStatus(cwd);

	return {
		type: "pr_description",
		branch,
		baseBranch,
		title,
		body,
		commitCount: summaries.length + missingCount,
		summaryCount: summaries.length,
		missingCount,
		queueActive: queue.active,
		workerBlocking: queue.workerBlocking,
	};
}
