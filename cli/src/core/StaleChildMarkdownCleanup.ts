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
 *     drain any backlog accumulated before this code shipped (and to undo
 *     the inverted 0.99.2 leaf-only deletion that wrongly preserved children
 *     and deleted heads).
 *
 * Reads from index via getIndexEntryMap. Deletes via storage.deleteVisibleMarkdown
 * (optional method; no-op when the storage backend has no visible layer, e.g.
 * OrphanBranchStorage).
 */

import { createLogger } from "../Logger.js";
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
				err instanceof Error ? err.message : String(err),
			);
		}
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
				err instanceof Error ? err.message : String(err),
			);
		}
	}
	return { deleted, failed };
}
