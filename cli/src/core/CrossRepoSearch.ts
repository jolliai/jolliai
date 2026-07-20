/**
 * CrossRepoSearch — union of {@link SearchIndex} queries over every repo under
 * a Memory Bank parent. Exists so out-of-process hosts (desktop cockpit's
 * ⌘K palette, `jolli search` future flag) can search "everything" without
 * knowing about the per-repo layout.
 *
 * The MCP server searches ONE repo at a time (the cwd of the AI agent). This
 * function is the multi-repo sibling: it enumerates repos via `discoverRepos`,
 * opens each search index (via {@link SearchIndex.openCached} so warm hits are
 * cheap), and merges the hits by score.
 */

import { createLogger } from "../Logger.js";
import { mapWithConcurrency } from "./Concurrency.js";
import { discoverRepos, type RepoTarget } from "./MemoryBankRepoDiscovery.js";
import { type SearchHitResult, SearchIndex, type SearchQuery } from "./SearchIndex.js";
import { createFolderStorageAtRoot } from "./StorageFactory.js";

const log = createLogger("CrossRepoSearch");

/**
 * How many repo indexes to open/search at once. Each `openCached` restores an
 * in-memory Orama index on a cold cache, so an unbounded fan-out over a large
 * Memory Bank would spike memory + fd usage. Matches the compile sweep's
 * `SWEEP_ESTIMATE_CONCURRENCY` cap.
 */
const CROSS_REPO_SEARCH_CONCURRENCY = 8;

export interface CrossRepoSearchHit extends SearchHitResult {
	/** The Memory Bank folder name this hit came from. */
	readonly repo: string;
	/** Absolute path to `<localFolder>/<repo>/`. */
	readonly kbRoot: string;
}

export interface CrossRepoSearchOptions extends Omit<SearchQuery, "query"> {
	/**
	 * Folder-name globs to skip — same dialect `discoverRepos` uses. Typically
	 * the caller passes `config.compileExcludeFolders` unchanged so search and
	 * compile agree on which repos count as active.
	 */
	readonly excludeFolders?: readonly string[];
	/** Overall cap on returned hits after cross-repo merge. Default 50. */
	readonly limit?: number;
	/** Per-repo cap before merge. Default `limit` (so a single hot repo can
	 * fill the whole result window if the others are quiet). */
	readonly perRepoLimit?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * Search every repo under `kbParent` and return the merged hits ordered by
 * BM25 score. A repo whose search index fails to open (missing / corrupt /
 * @orama not installed) is logged and skipped — the search never fails because
 * one repo is unhealthy.
 */
export async function searchAll(
	kbParent: string,
	query: string,
	opts?: CrossRepoSearchOptions,
): Promise<CrossRepoSearchHit[]> {
	if (typeof query !== "string" || query.trim().length === 0) return [];
	const limit = opts?.limit ?? DEFAULT_LIMIT;
	const perRepoLimit = opts?.perRepoLimit ?? limit;

	const targets = await discoverRepos(kbParent, opts?.excludeFolders ?? []);
	if (targets.length === 0) return [];

	// Fan the per-repo searches out with a bounded worker pool — Orama.search is
	// CPU-bound but fast; the wall-clock is dominated by the index restore on a
	// cold cache, and each restore holds an index in memory, so an unbounded
	// fan-out over a big Memory Bank would spike memory + fds. `onError` degrades
	// a bad repo to an empty hit list (logged + skipped) so one unhealthy repo
	// can't sink the whole search.
	const perRepo = await mapWithConcurrency<RepoTarget, CrossRepoSearchHit[]>(
		targets,
		CROSS_REPO_SEARCH_CONCURRENCY,
		async (t) => {
			const storage = createFolderStorageAtRoot(t.kbRoot);
			const idx = await SearchIndex.openCached(t.kbRoot, storage);
			const hits = await idx.search({
				query,
				limit: perRepoLimit,
				...(opts?.branch ? { branch: opts.branch } : {}),
				...(opts?.type ? { type: opts.type } : {}),
			});
			return hits.map((h): CrossRepoSearchHit => ({ ...h, repo: t.folder, kbRoot: t.kbRoot }));
		},
		(t, err) => {
			log.warn(
				"Search failed for repo %s (skipped): %s",
				t.folder,
				err instanceof Error ? err.message : String(err),
			);
			return [];
		},
	);

	const merged: CrossRepoSearchHit[] = perRepo.flat();

	// Score-descending merge so hot cross-repo hits float. Orama returns
	// higher = better; ties are broken by insertion order (per-repo order),
	// which is fine — the user is scanning a ranked list, not comparing.
	merged.sort((a, b) => b.score - a.score);
	return merged.slice(0, limit);
}
