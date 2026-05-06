/**
 * LocalSearchProvider — Local (orphan-branch) implementation of the search
 * catalog/hit pipeline.
 *
 * Phase 1 (`buildCatalog`): joins index.json metadata with catalog.json content
 * and applies `--since` / `--limit` / `--budget` constraints to produce a
 * scannable list for the LLM in the skill template.
 *
 * Phase 2 (`loadHits`): for each hash the LLM picked, loads the full summary
 * via `getSummary` (which reads the per-hash file directly, bypassing index)
 * and extracts snippets around query terms with `**bold**` highlighting.
 *
 * No LLM calls happen in this module — the chat LLM that drives `/jolli-search`
 * does all semantic work. Everything here is pure string / index manipulation.
 */

import { createLogger } from "../Logger.js";
import type { CommitSummary, SummaryIndexEntry, TopicSummary } from "../Types.js";
import type {
	BuildCatalogOptions,
	LoadHitsOptions,
	SearchCatalog,
	SearchCatalogEntry,
	SearchCatalogTopic,
	SearchHit,
	SearchMatch,
	SearchMatchField,
	SearchResult,
} from "./Search.js";
import { DEFAULT_CATALOG_LIMIT, DEFAULT_SEARCH_BUDGET } from "./Search.js";
import type { SearchProvider, SearchSource } from "./SearchProvider.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getCatalogWithLazyBuild, getIndex, getSummary } from "./SummaryStore.js";
import { collectDisplayTopics } from "./SummaryTree.js";
import { estimateTokens } from "./TokenEstimator.js";

const log = createLogger("LocalSearchProvider");

/** Number of characters of context on each side of a snippet's match position. */
const SNIPPET_HALF_WIDTH = 100;

/** Snippet falls back to this prefix length when no term hits. */
const FALLBACK_SNIPPET_LENGTH = 200;

/** Tokens-per-character estimate for incremental budget arithmetic. */
const ASCII_TOKENS_PER_CHAR = 0.25;

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

		const index = await getIndex(this.cwd, this.storage);
		const catalog = await getCatalogWithLazyBuild(this.cwd, this.storage);

		const filterEcho = {
			...(options.since !== undefined && { since: options.since }),
			limit,
		} satisfies SearchCatalog["filter"];

		// Build a lookup so catalog content (recap/topics/ticketId) can be joined
		// with index metadata (branch/date/commitMessage) by commitHash.
		const catalogByHash = new Map(catalog.entries.map((e) => [e.commitHash, e]));

		// Filter to root entries within the --since window; sort newest-first so
		// truncation prefers recent commits when budget runs out.
		const sinceTimestamp = parseSince(options.since);
		const indexEntries = index?.entries ?? [];
		const candidates = indexEntries
			.filter(isRootEntry)
			.filter((e) => sinceTimestamp === null || new Date(e.commitDate).getTime() >= sinceTimestamp)
			.sort((a, b) => new Date(b.commitDate).getTime() - new Date(a.commitDate).getTime());

		const totalCandidates = candidates.length;
		const limited = candidates.slice(0, limit);

		// Build entries; track running token estimate and trim when over budget.
		const entries: SearchCatalogEntry[] = [];
		let runningTokens = 0;
		let truncated = totalCandidates > limit;
		for (const idx of limited) {
			const cat = catalogByHash.get(idx.commitHash);
			let entry = buildEntry(idx, cat);
			let entryTokens = estimateTokens(JSON.stringify(entry));

			// If adding this entry would blow the budget, try to trim it instead
			// of stopping outright — many entries fit fine sans `decisions`.
			if (runningTokens + entryTokens > budget) {
				entry = trimEntry(entry);
				entryTokens = estimateTokens(JSON.stringify(entry));
				if (runningTokens + entryTokens > budget) {
					truncated = true;
					break;
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
		const tokens = tokenizeQuery(options.query);
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
			const hit = buildHit(summary, tokens);
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
 * Parses `--since` accepting either ISO date strings (e.g. `2026-01-01`) or
 * relative shorthand (`7d`, `2w`, `1m`, `3y`). Returns the millisecond
 * timestamp (epoch) of the resulting cutoff, or `null` when no filter applies.
 */
export function parseSince(since: string | undefined): number | null {
	if (!since) return null;
	const trimmed = since.trim();
	if (trimmed.length === 0) return null;

	const relative = trimmed.match(/^(\d+)([dwmy])$/i);
	if (relative) {
		const n = Number.parseInt(relative[1], 10);
		const unit = relative[2].toLowerCase();
		const now = Date.now();
		const dayMs = 86_400_000;
		switch (unit) {
			case "d":
				return now - n * dayMs;
			case "w":
				return now - n * 7 * dayMs;
			case "m":
				return now - n * 30 * dayMs;
			case "y":
				return now - n * 365 * dayMs;
		}
	}

	const ms = new Date(trimmed).getTime();
	return Number.isFinite(ms) ? ms : null;
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

// ─── Snippet extraction ──────────────────────────────────────────────────────

/**
 * Splits the query into normalized lowercase tokens; preserves quoted phrases
 * as single tokens (e.g. `"rate limiting"` → `rate limiting`).
 *
 * Quoted phrases are trimmed and lower-cased; empty phrases are dropped. When
 * a token captured via the unquoted alternative still contains stray double
 * quotes (e.g. unbalanced quote in user input like `"foo`), they are stripped
 * so subsequent substring matching does not silently fail looking for a
 * literal `"`.
 */
export function tokenizeQuery(query: string): ReadonlyArray<string> {
	const tokens: string[] = [];
	const phrasePattern = /"([^"]+)"|(\S+)/g;
	for (const m of query.matchAll(phrasePattern)) {
		const raw = m[1] ?? m[2] ?? "";
		const stripped = raw.replace(/"/g, "");
		const norm = stripped.trim().toLowerCase();
		if (norm.length > 0) tokens.push(norm);
	}
	return tokens;
}

/**
 * Returns the lowest 0-based offset where any token appears in `text`, or -1
 * when no token matches. Comparison is case-insensitive.
 */
export function findFirstMatchOffset(text: string, tokens: ReadonlyArray<string>): number {
	if (tokens.length === 0) return -1;
	const lower = text.toLowerCase();
	let best = -1;
	for (const t of tokens) {
		if (t.length === 0) continue;
		const idx = lower.indexOf(t);
		if (idx === -1) continue;
		if (best === -1 || idx < best) best = idx;
	}
	return best;
}

/**
 * Extracts a ~200-character snippet around the first matched token. Bolds all
 * matches inside the window with markdown `**...**`. When no token matches,
 * returns a short prefix as a fallback (callers may use this to show "no
 * direct hit, here's how this field starts").
 */
export function extractSnippet(text: string, tokens: ReadonlyArray<string>): string {
	if (text.length === 0) return "";
	const matchOffset = findFirstMatchOffset(text, tokens);
	if (matchOffset === -1) {
		const prefix = text.slice(0, FALLBACK_SNIPPET_LENGTH);
		// ASCII "..." rather than Unicode "…" (U+2026) — the latter renders as
		// `??` / mojibake on Windows terminals running non-UTF-8 codepages
		// (CP936/GBK in CN locale), which is exactly where many users live.
		return text.length > FALLBACK_SNIPPET_LENGTH ? `${prefix}...` : prefix;
	}

	const start = Math.max(0, matchOffset - SNIPPET_HALF_WIDTH);
	const end = Math.min(text.length, matchOffset + SNIPPET_HALF_WIDTH);
	const slice = text.slice(start, end);
	const prefixEllipsis = start > 0 ? "..." : "";
	const suffixEllipsis = end < text.length ? "..." : "";
	const highlighted = highlightTerms(slice, tokens);
	return `${prefixEllipsis}${highlighted}${suffixEllipsis}`;
}

/**
 * Surrounds each token occurrence in `text` with `**...**`. Case-insensitive
 * but preserves the original casing of the matched substring.
 */
export function highlightTerms(text: string, tokens: ReadonlyArray<string>): string {
	if (tokens.length === 0) return text;
	// Collect all match ranges, sorted by start so we can splice in order.
	type Range = { start: number; end: number };
	const ranges: Range[] = [];
	const lower = text.toLowerCase();
	for (const token of tokens) {
		if (token.length === 0) continue;
		let from = 0;
		while (from <= lower.length) {
			const idx = lower.indexOf(token, from);
			if (idx === -1) break;
			ranges.push({ start: idx, end: idx + token.length });
			from = idx + token.length;
		}
	}
	if (ranges.length === 0) return text;

	// Merge overlapping ranges so we never produce nested `**...**`.
	ranges.sort((a, b) => a.start - b.start);
	const merged: Range[] = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r.start <= last.end) {
			last.end = Math.max(last.end, r.end);
		} else {
			merged.push({ ...r });
		}
	}

	let out = "";
	let cursor = 0;
	for (const r of merged) {
		out += text.slice(cursor, r.start);
		out += `**${text.slice(r.start, r.end)}**`;
		cursor = r.end;
	}
	out += text.slice(cursor);
	return out;
}

function buildHit(summary: CommitSummary, tokens: ReadonlyArray<string>): SearchHit {
	const matches: SearchMatch[] = [];

	if (summary.recap) {
		const offset = findFirstMatchOffset(summary.recap, tokens);
		if (offset !== -1) {
			matches.push({
				field: "recap",
				snippet: extractSnippet(summary.recap, tokens),
			});
		}
	}

	for (const topic of collectDisplayTopics(summary)) {
		matches.push(...topicMatches(topic, tokens));
	}

	return {
		hash: summary.commitHash.substring(0, 8),
		fullHash: summary.commitHash,
		branch: summary.branch,
		date: summary.commitDate,
		commitMessage: summary.commitMessage,
		...(summary.ticketId && { ticketId: summary.ticketId }),
		...(summary.recap && { recap: summary.recap }),
		matches,
	};
}

function topicMatches(topic: TopicSummary, tokens: ReadonlyArray<string>): SearchMatch[] {
	const out: SearchMatch[] = [];

	const fieldChecks: Array<{ field: SearchMatchField; value: string | undefined }> = [
		{ field: "title", value: topic.title },
		{ field: "decisions", value: topic.decisions },
		{ field: "trigger", value: topic.trigger },
		{ field: "response", value: topic.response },
	];
	for (const { field, value } of fieldChecks) {
		if (!value) continue;
		if (findFirstMatchOffset(value, tokens) === -1) continue;
		out.push({
			field,
			topicTitle: topic.title,
			snippet: extractSnippet(value, tokens),
		});
	}

	if (topic.filesAffected && topic.filesAffected.length > 0) {
		const joined = topic.filesAffected.join(" ");
		if (findFirstMatchOffset(joined, tokens) !== -1) {
			out.push({
				field: "filesAffected",
				topicTitle: topic.title,
				snippet: highlightTerms(joined, tokens),
			});
		}
	}

	return out;
}

// Re-export estimateTokens-related constant for tests that need to compute
// expected budgets without re-deriving the constant.
export const _BUDGET_TOKENS_PER_CHAR = ASCII_TOKENS_PER_CHAR;
