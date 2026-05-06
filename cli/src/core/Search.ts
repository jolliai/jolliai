/**
 * Search — Type definitions for the structured catalog-driven search pipeline.
 *
 * Two-phase design (mirrors recall's branch-catalog pattern):
 *   Phase 1: CLI emits a `SearchCatalog` (light, scannable) for an LLM to skim
 *            and pick relevant commit hashes from.
 *   Phase 2: CLI loads full content for the picked hashes and emits
 *            `SearchResult` with snippet highlighting.
 *
 * The CLI never invokes an LLM itself — the chat LLM in the skill template is
 * the one that performs semantic matching between catalog entries and the
 * user's query.
 */

import type { TopicCategory, TopicImportance } from "../Types.js";

/** Default catalog size when `--since` is not provided. */
export const DEFAULT_CATALOG_LIMIT = 500;

/**
 * Default token budget for SearchCatalog output.
 *
 * Sized to fit ~30 detailed root commits (each ~600 tokens with full recap +
 * 2-3 topics + decisions) without truncation. The earlier 8000 default forced
 * truncation on real corpora — even ~20 commits with rich content blew past
 * it. Modern context windows easily absorb 20K, so the prior conservatism
 * was producing worse results without saving meaningful cost.
 */
export const DEFAULT_SEARCH_BUDGET = 20000;

// ─── Catalog (Phase 1) ───────────────────────────────────────────────────────

/**
 * Single topic entry in a SearchCatalogEntry. Mirrors `CatalogTopic` from
 * `catalog.json` but is narrowed to fields useful for an LLM picking commits.
 */
export interface SearchCatalogTopic {
	readonly title: string;
	readonly decisions?: string;
	readonly category?: TopicCategory;
	readonly importance?: TopicImportance;
	readonly filesAffected?: ReadonlyArray<string>;
}

/**
 * One catalog entry per root commit in the candidate window. Joined from
 * `index.json` (branch / date) and `catalog.json` (recap / topics / ticketId).
 *
 * **Foreign-key contract**: `fullHash` matches both `CatalogEntry.commitHash`
 * (in `catalog.json`) and `SummaryIndexEntry.commitHash` (in `index.json`).
 * Use `fullHash` whenever passing the entry forward to other tools or to
 * Phase 2 — `hash` is purely a display abbreviation and may collide if used
 * for lookup.
 */
export interface SearchCatalogEntry {
	/** 8-char short hash (display-only — never use as a lookup key). */
	readonly hash: string;
	/** Full commit hash; the FK back to index.json / catalog.json. Pass via `--hashes` for Phase 2. */
	readonly fullHash: string;
	readonly branch: string;
	readonly date: string;
	readonly ticketId?: string;
	readonly recap?: string;
	readonly topics?: ReadonlyArray<SearchCatalogTopic>;
}

/**
 * `SearchCatalog` — Phase 1 output handed to the LLM via the skill template.
 *
 * `truncated` signals that not all candidates fit within `--limit` × `--budget`
 * constraints. The LLM should suggest narrowing `--since` if results are sparse.
 */
export interface SearchCatalog {
	readonly type: "search-catalog";
	readonly query: string;
	readonly totalCandidates: number;
	readonly truncated: boolean;
	readonly filter: {
		readonly since?: string;
		readonly limit: number;
	};
	readonly entries: ReadonlyArray<SearchCatalogEntry>;
	readonly estimatedTokens: number;
}

// ─── Result (Phase 2) ─────────────────────────────────────────────────────────

/** Which field a snippet's match came from. */
export type SearchMatchField = "title" | "decisions" | "trigger" | "response" | "recap" | "filesAffected";

/** Single field-level match within a SearchHit. */
export interface SearchMatch {
	readonly field: SearchMatchField;
	/** Title of the topic the match originated from (absent for commit-level fields like `recap`). */
	readonly topicTitle?: string;
	/**
	 * ~200-character excerpt around the matched term. The matched term is
	 * pre-highlighted with markdown `**bold**` so the LLM can render directly.
	 */
	readonly snippet: string;
}

/**
 * One hit returned by Phase 2. Each entry corresponds to one of the hashes
 * passed in `--hashes`, paired with snippets relevant to the query.
 */
export interface SearchHit {
	readonly hash: string;
	readonly fullHash: string;
	readonly branch: string;
	readonly date: string;
	readonly commitMessage: string;
	readonly ticketId?: string;
	readonly recap?: string;
	readonly matches: ReadonlyArray<SearchMatch>;
}

/**
 * Phase 2 output — the LLM uses this to render the final user-facing answer.
 *
 * Any input hash that did not resolve to a stored summary is reported in
 * `failedHashes`. Surfacing these (rather than silently dropping them) lets
 * the LLM tell the user "you picked 10, but 2 are missing — try Phase 1
 * again with a wider window".
 */
export interface SearchResult {
	readonly type: "search";
	readonly query: string;
	readonly hashes: ReadonlyArray<string>;
	readonly results: ReadonlyArray<SearchHit>;
	/** Hashes from `hashes` that could not be loaded (no `summaries/<h>.json`). */
	readonly failedHashes?: ReadonlyArray<string>;
	readonly estimatedTokens: number;
}

// ─── Provider options ────────────────────────────────────────────────────────

export interface BuildCatalogOptions {
	readonly query: string;
	readonly since?: string;
	readonly limit?: number;
	readonly budget?: number;
}

export interface LoadHitsOptions {
	readonly query: string;
	readonly hashes: ReadonlyArray<string>;
}
