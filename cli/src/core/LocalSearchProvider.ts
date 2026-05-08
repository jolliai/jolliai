/**
 * LocalSearchProvider — Local (orphan-branch) implementation of the search
 * catalog/hit pipeline.
 *
 * Phase 1 (`buildCatalog`): joins `index.json` metadata with `catalog.json`
 * content and applies `--since` / `--limit` / `--budget` constraints to
 * produce a scannable list for the LLM in the skill template.
 *
 * Phase 2 (`loadHits`): for each hash the LLM picked, loads the full
 * `summaries/<hash>.json` via `getSummary` and projects it down to a
 * `SearchHit` — full distilled topics, recap, diff stats. The skill template
 * Step 5 hands that JSON to the LLM with detailed schema documentation and
 * lets it pick whatever output shape fits the user's query.
 *
 * No LLM calls happen in this module — the chat LLM that drives `/jolli-search`
 * does all semantic work. Everything here is pure data projection.
 */

import { createLogger } from "../Logger.js";
import type { CommitSummary, SummaryIndexEntry } from "../Types.js";
import type {
	BuildCatalogOptions,
	LoadHitsOptions,
	SearchCatalog,
	SearchCatalogEntry,
	SearchCatalogTopic,
	SearchHit,
	SearchHitTopic,
	SearchResult,
} from "./Search.js";
import { DEFAULT_CATALOG_LIMIT, DEFAULT_SEARCH_BUDGET } from "./Search.js";
import type { SearchProvider, SearchSource } from "./SearchProvider.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getCatalogWithLazyBuild, getIndex, getSummary } from "./SummaryStore.js";
import { collectDisplayTopics } from "./SummaryTree.js";
import { estimateTokens } from "./TokenEstimator.js";

const log = createLogger("LocalSearchProvider");

// ─── Public class ────────────────────────────────────────────────────────────

export class LocalSearchProvider implements SearchProvider {
	readonly source: SearchSource = "local";

	/**
	 * @param cwd     Project directory (git repo root). When omitted, the
	 *                underlying storage primitives default to detecting the
	 *                repo from `process.cwd()`.
	 * @param storage Optional StorageProvider override. When omitted, falls
	 *                back to the active provider via `resolveStorage`
	 *                (typically `OrphanBranchStorage`). Pass explicitly for
	 *                tests or alternate-backend scenarios.
	 */
	constructor(
		private readonly cwd?: string,
		private readonly storage?: StorageProvider,
	) {}

	async buildCatalog(options: BuildCatalogOptions): Promise<SearchCatalog> {
		const limit = options.limit ?? DEFAULT_CATALOG_LIMIT;
		const budget = options.budget ?? DEFAULT_SEARCH_BUDGET;

		// Parse `--since` BEFORE any I/O — invalid values throw immediately so
		// the user gets a hard error instead of silently disabled filtering.
		// Earlier this path collapsed "unset" and "invalid" into the same null
		// (treated as no-filter), turning typos like `--since=lastweek` into
		// "wider results than expected with no warning".
		const sinceParsed = parseSince(options.since);
		if (sinceParsed.kind === "invalid") {
			throw new Error(
				`Invalid --since value "${sinceParsed.value}". Expected ISO date (e.g. 2026-01-01) or relative shorthand (7d / 2w / 1m / 3y).`,
			);
		}

		const index = await getIndex(this.cwd, this.storage);
		const catalog = await getCatalogWithLazyBuild(this.cwd, this.storage);

		// `filterEcho` only echoes the user's `--since` when it parsed successfully;
		// the "invalid" path threw above, so reaching here means it was either
		// unset or valid.
		const filterEcho = {
			...(sinceParsed.kind === "ok" && options.since !== undefined && { since: options.since }),
			limit,
		} satisfies SearchCatalog["filter"];

		// Build a lookup so catalog content (recap/topics/ticketId) can be joined
		// with index metadata (branch/date/commitMessage) by commitHash.
		const catalogByHash = new Map(catalog.entries.map((e) => [e.commitHash, e]));

		// Filter to root entries within the --since window; sort newest-first so
		// truncation prefers recent commits when budget runs out.
		const sinceTimestamp = sinceParsed.kind === "ok" ? sinceParsed.ts : null;
		const indexEntries = index?.entries ?? [];
		const candidates = indexEntries
			.filter(isRootEntry)
			.filter((e) => sinceTimestamp === null || new Date(e.commitDate).getTime() >= sinceTimestamp)
			.sort((a, b) => new Date(b.commitDate).getTime() - new Date(a.commitDate).getTime());

		const totalCandidates = candidates.length;
		const limited = candidates.slice(0, limit);

		// Build entries; track running token estimate and trim when over budget.
		// `candidates` is sorted newest-first, so truncation prefers recent commits
		// when budget runs out. When a single entry can't fit even after trim, we
		// `continue` past it (skipping just that one) rather than `break` the
		// whole loop — otherwise one verbose recent commit (long recap + many
		// topics + many filesAffected) would silently exclude every older
		// candidate, regardless of how small they would have been individually.
		const entries: SearchCatalogEntry[] = [];
		let runningTokens = 0;
		let truncated = totalCandidates > limit;
		for (const idx of limited) {
			const cat = catalogByHash.get(idx.commitHash);
			let entry = buildEntry(idx, cat);
			let entryTokens = estimateTokens(JSON.stringify(entry));

			// If adding this entry would blow the budget, try to trim it first —
			// many entries fit fine sans `decisions`.
			if (runningTokens + entryTokens > budget) {
				entry = trimEntry(entry);
				entryTokens = estimateTokens(JSON.stringify(entry));
				if (runningTokens + entryTokens > budget) {
					// This single entry is too big even trimmed. Skip it but keep
					// trying smaller candidates that come later in the list.
					truncated = true;
					continue;
				}
			}

			entries.push(entry);
			runningTokens += entryTokens;
		}

		log.debug(
			"buildCatalog: total=%d, limited=%d, returned=%d, tokens≈%d, truncated=%s",
			totalCandidates,
			limited.length,
			entries.length,
			runningTokens,
			truncated,
		);

		return {
			type: "search-catalog",
			query: options.query,
			totalCandidates,
			truncated,
			filter: filterEcho,
			entries,
			estimatedTokens: runningTokens,
		};
	}

	async loadHits(options: LoadHitsOptions): Promise<SearchResult> {
		const hits: SearchHit[] = [];
		const failed: string[] = [];
		let totalTokens = 0;

		for (const hash of options.hashes) {
			const summary = await getSummary(hash, this.cwd, this.storage);
			if (!summary) {
				log.debug("loadHits: no summary for %s — recording as failed", hash.substring(0, 8));
				failed.push(hash);
				continue;
			}
			const hit = buildHit(summary);
			hits.push(hit);
			totalTokens += estimateTokens(JSON.stringify(hit));
		}

		return {
			type: "search",
			query: options.query,
			hashes: options.hashes,
			results: hits,
			...(failed.length > 0 && { failedHashes: failed }),
			estimatedTokens: totalTokens,
		};
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRootEntry(e: SummaryIndexEntry): boolean {
	return e.parentCommitHash == null;
}

/**
 * Result of parsing a `--since` value.
 *
 * Three outcomes, deliberately distinguished:
 *   - `{ kind: "unset" }`     — caller passed nothing (no filter, expected)
 *   - `{ kind: "ok", ts }`    — successfully parsed timestamp
 *   - `{ kind: "invalid", value }` — caller passed something that didn't parse
 *
 * The earlier signature (`number | null`) collapsed "unset" and "invalid" into
 * the same `null`, so a typo like `--since=lastweek` silently disabled the
 * filter (returning more results, not fewer) — the opposite of what the user
 * intended, with no error feedback. The CLI now checks for `kind === "invalid"`
 * and emits a hard error instead.
 */
export type SinceParseResult =
	| { readonly kind: "unset" }
	| { readonly kind: "ok"; readonly ts: number }
	| { readonly kind: "invalid"; readonly value: string };

/**
 * Parses `--since` accepting either ISO date strings (e.g. `2026-01-01`) or
 * relative shorthand (`7d`, `2w`, `1m`, `3y`).
 */
export function parseSince(since: string | undefined): SinceParseResult {
	if (since === undefined) return { kind: "unset" };
	const trimmed = since.trim();
	if (trimmed.length === 0) return { kind: "unset" };

	const relative = trimmed.match(/^(\d+)([dwmy])$/i);
	if (relative) {
		const n = Number.parseInt(relative[1], 10);
		const unit = relative[2].toLowerCase();
		const now = Date.now();
		const dayMs = 86_400_000;
		switch (unit) {
			case "d":
				return { kind: "ok", ts: now - n * dayMs };
			case "w":
				return { kind: "ok", ts: now - n * 7 * dayMs };
			case "m":
				return { kind: "ok", ts: now - n * 30 * dayMs };
			case "y":
				return { kind: "ok", ts: now - n * 365 * dayMs };
		}
	}

	const ms = new Date(trimmed).getTime();
	if (Number.isFinite(ms)) return { kind: "ok", ts: ms };
	return { kind: "invalid", value: trimmed };
}

function buildEntry(
	idx: SummaryIndexEntry,
	cat: { recap?: string; ticketId?: string; topics?: ReadonlyArray<SearchCatalogTopic> } | undefined,
): SearchCatalogEntry {
	const topics = (cat?.topics ?? []).map(
		(t) =>
			({
				title: t.title,
				...(t.decisions !== undefined && { decisions: t.decisions }),
				...(t.category !== undefined && { category: t.category }),
				...(t.importance !== undefined && { importance: t.importance }),
				...(t.filesAffected && t.filesAffected.length > 0 && { filesAffected: t.filesAffected }),
			}) satisfies SearchCatalogTopic,
	);

	return {
		hash: idx.commitHash.substring(0, 8),
		fullHash: idx.commitHash,
		branch: idx.branch,
		date: idx.commitDate,
		...(cat?.ticketId && { ticketId: cat.ticketId }),
		...(cat?.recap && { recap: cat.recap }),
		...(topics.length > 0 && { topics }),
	};
}

/**
 * Drops `decisions` from each topic — the cheapest way to bring an oversized
 * entry under budget without losing the title (which is the highest-signal
 * field for picking).
 */
function trimEntry(entry: SearchCatalogEntry): SearchCatalogEntry {
	if (!entry.topics || entry.topics.length === 0) return entry;
	return {
		...entry,
		topics: entry.topics.map((t) => {
			const { decisions: _decisions, ...rest } = t;
			return rest;
		}),
	};
}

/**
 * Projects a full `CommitSummary` down to a `SearchHit`. Walks the v3 tree via
 * `collectDisplayTopics` so embedded children (legacy squash nests) are
 * resolved before being copied into the hit's `topics[]`.
 *
 * Drops internal metadata (`generatedAt` / `commitSource` / `transcriptEntries`
 * / `conversationTurns` / `llm` / `treeHash` / `jolliDocId/Url` /
 * `orphanedDocIds`) and large payloads with no search value
 * (`e2eTestGuide` / `plans` / `notes`). See SearchHit doc for the rationale.
 */
function buildHit(summary: CommitSummary): SearchHit {
	const topics = collectDisplayTopics(summary).map(
		(t) =>
			({
				title: t.title,
				trigger: t.trigger,
				response: t.response,
				decisions: t.decisions,
				...(t.todo !== undefined && { todo: t.todo }),
				...(t.filesAffected && t.filesAffected.length > 0 && { filesAffected: t.filesAffected }),
				...(t.category !== undefined && { category: t.category }),
				...(t.importance !== undefined && { importance: t.importance }),
			}) satisfies SearchHitTopic,
	);

	return {
		hash: summary.commitHash.substring(0, 8),
		fullHash: summary.commitHash,
		commitMessage: summary.commitMessage,
		commitAuthor: summary.commitAuthor,
		commitDate: summary.commitDate,
		branch: summary.branch,
		...(summary.commitType !== undefined && { commitType: summary.commitType }),
		...(summary.ticketId && { ticketId: summary.ticketId }),
		...(summary.diffStats !== undefined && { diffStats: summary.diffStats }),
		...(summary.recap && { recap: summary.recap }),
		topics,
	};
}
