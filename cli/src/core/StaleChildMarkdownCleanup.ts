/**
 * StaleChildMarkdownCleanup — shared helper for "delete visible .md files of
 * hoisted older versions" under the v4 Hoist storage model.
 *
 * Under v4 Hoist, every new commit / amend / squash writes a fresh head with
 * `parentCommitHash == null` and reassigns the prior version's index entry
 * to `parentCommitHash = <new head>` (see SummaryStore.flattenSummaryTree).
 * Visible Markdown should only be published for live heads; the entries with
 * non-null `parentCommitHash` are internal-history nodes hoisted into some
 * head's `children[]` and should not have a sibling .md surfaced to the user.
 *
 * Two entry points:
 *   - cleanupBranchStaleChildMarkdown(cwd, branch, storage): scoped to one
 *     branch of the active repo. Called by QueueWorker at the tail of every
 *     op so the disk invariant is restored after amend / rebase / squash.
 *   - cleanupAllBranchesStaleChildMarkdown(cwd, storage): walks every branch
 *     in the index. Called by MigrationEngine's one-shot step on activate to
 *     drain any backlog of hoisted children (`parentCommitHash != null`)
 *     accumulated before this code shipped. CANNOT restore heads that the
 *     0.99.2 inverted leaf-only deletion bug already removed from disk —
 *     that recovery path is `FolderStorage.healMissingVisibleMarkdown`,
 *     which re-emits visible Markdown from hidden `summaries/<hash>.json`.
 *
 * Reads from index via getIndexEntryMap. Deletes via storage.deleteVisibleMarkdown
 * (optional method; no-op when the storage backend has no visible layer, e.g.
 * OrphanBranchStorage).
 */

import { createLogger, errMsg } from "../Logger.js";
import type { SummaryIndexEntry } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getIndexEntryMap } from "./SummaryStore.js";

const log = createLogger("StaleChildMarkdownCleanup");

export interface CleanupResult {
	readonly deleted: number;
	readonly failed: number;
}

/** Delete visible .md files for hoisted older versions on a single branch. */
export async function cleanupBranchStaleChildMarkdown(
	cwd: string | undefined,
	branch: string,
	storage: StorageProvider,
): Promise<CleanupResult> {
	if (!storage.deleteVisibleMarkdown) {
		return { deleted: 0, failed: 0 };
	}
	const map = await getIndexEntryMap(cwd, storage);
	const branchStaleChildren = [...map.values()].filter((e) => e.branch === branch && e.parentCommitHash != null);

	let deleted = 0;
	let failed = 0;
	for (const entry of branchStaleChildren) {
		try {
			await storage.deleteVisibleMarkdown(entry);
			deleted++;
		} catch (err) {
			failed++;
			log.warn(
				"deleteVisibleMarkdown failed for %s on %s: %s",
				entry.commitHash.substring(0, 8),
				branch,
				errMsg(err),
			);
		}
	}

	// Ghost-branch sweep: if the op was a cross-branch hoist (cherry-pick /
	// rebase / amend across branches), the head landed on a different branch
	// and `branch` now has only hoisted children in the index — we just deleted
	// the last visible .md it had. Drop its `branches.json` mapping so the
	// sidebar's Folders tab does not list an empty directory. The check
	// requires the branch to appear in the index at all, so fresh-repo
	// mappings registered before any commit landed are NOT pruned.
	//
	// Guard on `failed === 0`: a delete failure (EACCES / EBUSY on a
	// user-edited or editor-locked .md) leaves the orphan file on disk while
	// the index snapshot still reads "no heads". Pruning the mapping anyway
	// would hide the branch from the sidebar but keep the orphan invisible-
	// but-present — the next cleanup pass (when the lock clears) can prune.
	if (failed === 0) {
		await pruneIfGhostBranch(branch, map, storage);
	}

	return { deleted, failed };
}

/** Delete visible .md files for hoisted older versions across every branch in the index. */
export async function cleanupAllBranchesStaleChildMarkdown(
	cwd: string | undefined,
	storage: StorageProvider,
): Promise<CleanupResult> {
	if (!storage.deleteVisibleMarkdown) {
		return { deleted: 0, failed: 0 };
	}
	const map = await getIndexEntryMap(cwd, storage);
	const staleChildren = [...map.values()].filter((e) => e.parentCommitHash != null);

	let deleted = 0;
	let failed = 0;
	for (const entry of staleChildren) {
		try {
			await storage.deleteVisibleMarkdown(entry);
			deleted++;
		} catch (err) {
			failed++;
			log.warn(
				"deleteVisibleMarkdown failed for %s on %s: %s",
				entry.commitHash.substring(0, 8),
				entry.branch,
				errMsg(err),
			);
		}
	}

	// Ghost-branch sweep (whole-index variant): drop branches.json mappings
	// for every branch that appears in the index but has zero head entries
	// (`parentCommitHash == null`). Migration runs this once on activate, so
	// pre-existing ghosts from a 0.99.x cross-branch hoist are cleaned up
	// without the user having to issue a fresh amend on the affected branch.
	await pruneAllGhostBranches(map, storage);

	return { deleted, failed };
}

/**
 * Drop `branch`'s `branches.json` mapping iff the index has at least one
 * entry on it AND none of those entries is a head (`parentCommitHash == null`).
 * No-op when the storage backend has no `pruneBranchMappings` (e.g. pure
 * OrphanBranchStorage — no `branches.json` exists there).
 *
 * Failures are logged at WARN but never propagated: the cleanup tail step
 * MUST NOT roll back the op that produced the hoist.
 */
async function pruneIfGhostBranch(
	branch: string,
	map: ReadonlyMap<string, SummaryIndexEntry>,
	storage: StorageProvider,
): Promise<void> {
	if (!storage.pruneBranchMappings) return;
	let hasEntry = false;
	let hasHead = false;
	for (const e of map.values()) {
		if (e.branch !== branch) continue;
		hasEntry = true;
		if (e.parentCommitHash == null) {
			hasHead = true;
			break;
		}
	}
	if (!hasEntry || hasHead) return;
	try {
		const pruned = await storage.pruneBranchMappings([branch]);
		if (pruned > 0) {
			log.info("Pruned ghost-branch mapping after hoist on %s", branch);
		}
	} catch (err) {
		log.warn("pruneBranchMappings failed for %s: %s", branch, errMsg(err));
	}
}

async function pruneAllGhostBranches(
	map: ReadonlyMap<string, SummaryIndexEntry>,
	storage: StorageProvider,
): Promise<void> {
	if (!storage.pruneBranchMappings) return;
	const branchesInIndex = new Set<string>();
	const branchesWithHead = new Set<string>();
	for (const e of map.values()) {
		branchesInIndex.add(e.branch);
		if (e.parentCommitHash == null) branchesWithHead.add(e.branch);
	}
	const ghosts = [...branchesInIndex].filter((b) => !branchesWithHead.has(b));
	if (ghosts.length === 0) return;
	try {
		const pruned = await storage.pruneBranchMappings(ghosts);
		if (pruned > 0) {
			log.info("Pruned %d ghost-branch mapping(s) across all branches", pruned);
		}
	} catch (err) {
		log.warn("pruneBranchMappings failed during all-branches sweep: %s", errMsg(err));
	}
}
