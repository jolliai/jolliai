/**
 * MemoryBankModel.ts — read-only data layer for the Jolli TUI's committed-memory
 * list (the Memories tab's browse view).
 *
 * `listCommittedMemories` picks a branch's newest heads from the cheap index and
 * surfaces index-only fields (title / date / topicsCount) — it does NOT load a
 * full summary per row; the detail pane loads one on selection via
 * `getMemoryDetail`. Callers must have an active storage set (runInkTui does
 * `setActiveStorage(await createStorage)` once at startup) — these functions read
 * through the module-global provider.
 */

import type { CommitSummary } from "../Types.js";
import { filterToBranchHeads } from "./HeadEntryFilter.js";
import { getIndex, getSummary } from "./SummaryStore.js";

/** Sanity cap on the list size — high enough to never truncate a real branch's
 *  history in the browser, low enough to stay bounded. */
const MAX_LIST = 200;

/** One row in the committed-memory list. Index-only fields (no full summary is
 *  loaded for the list — the detail pane loads that on selection). */
export interface MemoryListItem {
	readonly hash: string;
	readonly title: string;
	readonly date: string;
	readonly branch: string;
	readonly topicsCount: number;
}

/**
 * Committed memories for a branch, newest first. Reads the cheap index only (the
 * browse row shows title / date / hash / topicsCount — all present on the index),
 * so no per-row `getSummary`; the Memories detail pane loads the full summary on
 * selection via {@link getMemoryDetail}. Capped at `limit` (default MAX_LIST) —
 * high enough to cover a real branch's history while staying bounded.
 */
export async function listCommittedMemories(
	cwd: string,
	opts: { branch?: string; limit?: number } = {},
): Promise<MemoryListItem[]> {
	const limit = opts.limit && opts.limit > 0 ? opts.limit : MAX_LIST;
	const index = await getIndex(cwd);
	if (!index || index.entries.length === 0) return [];

	let heads = filterToBranchHeads(index.entries);
	if (opts.branch) heads = heads.filter((e) => e.branch === opts.branch);
	heads.sort((a, b) => new Date(b.commitDate).getTime() - new Date(a.commitDate).getTime());

	return heads.slice(0, limit).map((entry) => ({
		hash: entry.commitHash,
		title: entry.commitMessage,
		date: entry.commitDate,
		branch: entry.branch,
		topicsCount: entry.topicCount ?? 0,
	}));
}

/** Full summary for the Memories detail pane. */
export async function getMemoryDetail(cwd: string, commitHash: string): Promise<CommitSummary | null> {
	return getSummary(commitHash, cwd);
}
