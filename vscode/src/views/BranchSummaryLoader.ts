/**
 * BranchSummaryLoader
 *
 * Enumerates `CommitSummary` objects for `base..HEAD` in chronological
 * (oldest-first) order via `bridge.getSummary(hash)`, so the lookup passes
 * through the bridge's lazy `StorageProvider` instead of the CLI's
 * standalone `getSummary` (which would bypass storage-backend selection).
 */

import type { CommitSummary } from "../../../cli/src/Types.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { log } from "../util/Logger.js";

const TAG = "BranchSummaryLoader";

export interface BranchSummariesResult {
	/** Summaries on `base..HEAD`, ordered chronologically (oldest first; HEAD last). */
	readonly summaries: ReadonlyArray<CommitSummary>;
	/** Number of commits on the branch with no recorded summary (skipped). */
	readonly missingCount: number;
}

/**
 * `Promise.allSettled` so a transient `bridge.getSummary` failure (corrupt
 * orphan ref, `git show` flake) degrades to a "missing" entry with a warn
 * log instead of rejecting the whole load and freezing the WebView's
 * "Loading..." button.
 */
export async function loadBranchSummaries(
	bridge: JolliMemoryBridge,
	mainBranch: string,
): Promise<BranchSummariesResult> {
	const { commits } = await bridge.listBranchCommits(mainBranch);
	if (commits.length === 0) {
		return { summaries: [], missingCount: 0 };
	}

	// listBranchCommits returns newest-first; reverse for chronological order
	// so the body reads as a story (first commit at the top).
	const chronological = commits.slice().reverse();
	const settled = await Promise.allSettled(
		chronological.map((c) => bridge.getSummary(c.hash)),
	);

	const summaries: Array<CommitSummary> = [];
	let missingCount = 0;
	for (let i = 0; i < settled.length; i++) {
		const r = settled[i];
		if (r.status === "fulfilled" && r.value) {
			summaries.push(r.value);
			continue;
		}
		if (r.status === "rejected") {
			const reason =
				r.reason instanceof Error ? r.reason.message : String(r.reason);
			log.warn(
				TAG,
				`getSummary failed for ${chronological[i].hash.substring(0, 7)}: ${reason}`,
			);
		}
		missingCount++;
	}

	return { summaries, missingCount };
}
