/**
 * WikiFreshness — how far the wiki/graph (topic KB) lags behind the summaries
 * already generated for this repo, plus how long since it was last rebuilt.
 *
 * The single source of truth for the "N updates behind · rebuilt X ago"
 * indicator both the local dashboard and the VS Code sidebar render. Product
 * rule → lives in `cli/src/core` (AGENTS.md: hosts are adapters).
 *
 * Cheap-ish but not free: it scans every source ref (summaries index + plan/note
 * + user files) to count what is pending, so callers treat it as a slow probe
 * (its own endpoint on the dashboard, off the first-paint path), never a hot loop.
 */

import { existsSync } from "node:fs";
import { graphJsonPath } from "../graph/GraphArtifactStore.js";
import type { JolliMemoryConfig } from "../Types.js";
import { INGEST_CODES } from "./IngestErrors.js";
import { readIngestRuns } from "./IngestRunStore.js";
import { discoverRepos } from "./MemoryBankRepoDiscovery.js";
import { readProcessedSet } from "./ProcessedSourceStore.js";
import { createReadStorage } from "./ReadStorageResolver.js";
import { listPendingSources } from "./SourceTimeline.js";
import { createFolderStorageAtRoot } from "./StorageFactory.js";
import type { StorageProvider } from "./StorageProvider.js";

/** Pending-source count is warn-worthy above this many un-ingested summaries. */
export const WIKI_BEHIND_WARN_COUNT = 10;
/** Pending changes older than this since the last rebuild are warn-worthy (3 days). */
export const WIKI_BEHIND_WARN_MS = 3 * 24 * 60 * 60 * 1000;

export type WikiFreshnessSeverity = "never" | "fresh" | "info" | "warn";

export interface WikiFreshness {
	/** Un-ingested sources by type. `summary` is the headline "N updates behind". */
	readonly pending: {
		readonly summary: number;
		readonly plan: number;
		readonly note: number;
		readonly userfile: number;
		readonly total: number;
	};
	/** ISO timestamp of the last successful rebuild, or null if never built. */
	readonly lastRebuiltAt: string | null;
	/** True once a wiki/graph has ever been produced (graph.json exists, or a clean ingest ran). */
	readonly everBuilt: boolean;
	readonly severity: WikiFreshnessSeverity;
}

/**
 * Computes the freshness snapshot for the repo rooted at `cwd`.
 *
 * `storage` scopes the source reads (defaults to the repo's read view). `nowMs`
 * is injectable for deterministic tests — production passes the wall clock.
 */
export async function getWikiFreshness(
	cwd: string,
	storage?: StorageProvider,
	nowMs: number = Date.now(),
): Promise<WikiFreshness> {
	const readStorage = storage ?? (await createReadStorage(cwd));

	const processed = await readProcessedSet(cwd, readStorage);
	const pendingRefs = await listPendingSources(cwd, processed, readStorage);
	const pending = {
		summary: pendingRefs.filter((r) => r.type === "summary").length,
		plan: pendingRefs.filter((r) => r.type === "plan").length,
		note: pendingRefs.filter((r) => r.type === "note").length,
		userfile: pendingRefs.filter((r) => r.type === "userfile").length,
		total: pendingRefs.length,
	};

	// Last successful rebuild = most recent OK drain (ring buffer is oldest→newest,
	// so scan from the end). An OK outcome means the drain completed and folded its
	// pending sources; benign/idle/error outcomes are not "rebuilt".
	const runs = await readIngestRuns(cwd);
	let lastRebuiltAt: string | null = null;
	for (let i = runs.length - 1; i >= 0; i--) {
		if (runs[i].outcome === INGEST_CODES.OK) {
			lastRebuiltAt = runs[i].startedAt;
			break;
		}
	}

	// The graph.json lives in the folder layer at kbRoot; orphan-only storage has
	// no folder (kbRoot falls back to cwd, where the file simply won't exist).
	const kbRoot = readStorage.kbRoot ?? cwd;
	const graphExists = existsSync(graphJsonPath(kbRoot));
	const everBuilt = graphExists || lastRebuiltAt !== null;

	const severity = deriveSeverity(everBuilt, pending.summary, pending.total, lastRebuiltAt, nowMs);
	return { pending, lastRebuiltAt, everBuilt, severity };
}

/**
 * Severity ladder. Time-staleness only escalates when something is actually
 * pending: an old-but-empty wiki is up to date, not "behind". `lastRebuiltAt`
 * null (never built, or ring buffer aged out) skips the time clause rather than
 * feeding NaN into the comparison.
 */
function deriveSeverity(
	everBuilt: boolean,
	summaryBehind: number,
	total: number,
	lastRebuiltAt: string | null,
	nowMs: number,
): WikiFreshnessSeverity {
	if (!everBuilt) return "never";
	if (total === 0) return "fresh";
	const lastMs = lastRebuiltAt !== null ? Date.parse(lastRebuiltAt) : Number.NaN;
	const staleByTime = Number.isFinite(lastMs) && nowMs - lastMs > WIKI_BEHIND_WARN_MS;
	if (summaryBehind > WIKI_BEHIND_WARN_COUNT || staleByTime) return "warn";
	return "info";
}

/** Per-repo freshness plus the repo's Memory Bank folder name (the label). */
export interface RepoWikiFreshness extends WikiFreshness {
	readonly repoName: string;
}

/**
 * Freshness aggregated across EVERY repo in the Memory Bank folder — the single
 * shape both the dashboard banner and the VS Code sidebar banner render. The
 * rebuild both surfaces trigger is the whole-folder sweep (`compileAllRepos`),
 * so the indicator matches it: it reports how far the *folder* lags, not one repo.
 *
 * Each repo is scored with folder-only storage (no git worktree needed —
 * `compileAllRepos` sweeps the same way), so repos with no local checkout are
 * still counted and still rebuilt by the same button.
 */
export interface AggregateWikiFreshness {
	readonly repos: ReadonlyArray<RepoWikiFreshness>;
	/** Names of the repos that are not `fresh` (drives the banner's repo label). */
	readonly behindRepoNames: ReadonlyArray<string>;
	/** Pending sources summed over the behind repos. `summary` is the headline. */
	readonly pending: { readonly summary: number; readonly total: number };
	/** Most recent successful rebuild across all repos, or null. */
	readonly lastRebuiltAt: string | null;
	/** True if any repo has ever produced a wiki/graph. */
	readonly everBuilt: boolean;
	/** Worst state across repos: `fresh` when nothing is behind. */
	readonly severity: WikiFreshnessSeverity;
}

/**
 * Computes the folder-wide freshness snapshot. `nowMs` is injectable for tests.
 * A `localFolder` with no discovered repos yields an all-`fresh` (empty) result.
 */
export async function getAggregateWikiFreshness(
	localFolder: string,
	config: JolliMemoryConfig,
	nowMs: number = Date.now(),
): Promise<AggregateWikiFreshness> {
	const targets = await discoverRepos(localFolder, config.compileExcludeFolders ?? []);
	const repos: RepoWikiFreshness[] = [];
	for (const t of targets) {
		const storage = createFolderStorageAtRoot(t.kbRoot);
		const f = await getWikiFreshness(t.kbRoot, storage, nowMs);
		repos.push({ ...f, repoName: t.folder });
	}

	// "Behind" = has un-ingested sources to fold in. A repo with nothing pending is
	// NOT behind even if it never built a wiki (an empty/just-migrated repo scores
	// `never` with `total===0`): calling it behind would show "0 items pending" and
	// a Rebuild that can never clear it (an empty ingest leaves it `never` forever).
	const behind = repos.filter((r) => r.severity !== "fresh" && r.pending.total > 0);
	const pending = {
		summary: behind.reduce((n, r) => n + r.pending.summary, 0),
		total: behind.reduce((n, r) => n + r.pending.total, 0),
	};
	const lastRebuiltAt = repos.reduce<string | null>((acc, r) => {
		if (!r.lastRebuiltAt) return acc;
		if (!acc) return r.lastRebuiltAt;
		return Date.parse(r.lastRebuiltAt) > Date.parse(acc) ? r.lastRebuiltAt : acc;
	}, null);
	const everBuilt = repos.some((r) => r.everBuilt);

	// Worst-state ladder: warn if any repo is warn OR the folder-wide headline
	// crosses the same count threshold; otherwise info while anything is behind.
	let severity: WikiFreshnessSeverity = "fresh";
	if (behind.length > 0) {
		severity =
			repos.some((r) => r.severity === "warn") || pending.summary > WIKI_BEHIND_WARN_COUNT ? "warn" : "info";
	}

	return { repos, behindRepoNames: behind.map((r) => r.repoName), pending, lastRebuiltAt, everBuilt, severity };
}
