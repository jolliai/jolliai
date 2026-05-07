/**
 * Search — Type definitions for the structured catalog-driven search pipeline.
 *
 * Two-phase design (mirrors recall's branch-catalog pattern):
 *   Phase 1: CLI emits a `SearchCatalog` (light, scannable) for an LLM to skim
 *            and pick relevant commit hashes from.
 *   Phase 2: CLI loads each picked summary from `summaries/<hash>.json` and
 *            emits a `SearchResult` containing rich `SearchHit` entries — full
 *            distilled topic content, recap, diff stats — so the LLM can
 *            synthesize the final answer in whatever shape best fits the user's
 *            query.
 *
 * The CLI never invokes an LLM itself — the chat LLM in the skill template is
 * the one that performs semantic matching between catalog entries and the
 * user's query, and the one that decides Phase 2's render shape.
 */

import type { CommitType, DiffStats, TopicCategory, TopicImportance } from "../Types.js";

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

/**
 * A topic inside a Phase 2 hit. Carries the full distilled content needed for
 * the LLM to synthesize "why" / "what" / "how" answers. Mirrors `TopicSummary`
 * from `Types.ts` but excludes only fields that have no LLM value (none in
 * this schema today; if `TopicSummary` grows, deliberately decide each new
 * field's value to a search consumer).
 *
 * `decisions` is the highest-signal field — it captures architectural choices
 * AND the reasoning behind them, which the diff alone never shows. Skill
 * template Step 5 calls this out as the "★ star field".
 */
export interface SearchHitTopic {
	readonly title: string;
	/** 1-2 sentences describing what prompted the work. */
	readonly trigger: string;
	/** Implementation summary; may include code references. Verbose. */
	readonly response: string;
	/** ★ Design choices + the reasoning behind each. Multi-line markdown bullets. */
	readonly decisions: string;
	/** Residual work the LLM noticed during summarization (rare but valuable). */
	readonly todo?: string;
	/** Files this specific topic touched. Source of truth for file grounding. */
	readonly filesAffected?: ReadonlyArray<string>;
	readonly category?: TopicCategory;
	readonly importance?: TopicImportance;
}

/**
 * One hit returned by Phase 2.
 *
 * The shape is deliberately rich — the skill template Step 5 hands this JSON
 * to the LLM with detailed schema documentation and tells it to pick whatever
 * output shape fits the user's query (definition prose / comparison table /
 * timeline / grouped list / etc.). Earlier iterations exposed only `matches[]`
 * snippets and forced a rigid "table + bullets" template, which produced the
 * same shape regardless of query intent.
 *
 * Notable absences:
 *   - No `matches[]` / snippets: the LLM has the full topics so per-field
 *     literal-match excerpts are redundant, and the old "snippet dump" failure
 *     mode was driven by their presence.
 *   - No commit-level aggregated `filesAffected`: derive it from
 *     `topics.flatMap(t => t.filesAffected ?? [])` if needed. Per-topic
 *     `filesAffected` is strictly stronger because it preserves the
 *     decision-to-file mapping.
 *   - No `children` / tree: `collectDisplayTopics` walks the tree before
 *     building this hit, so `topics[]` already contains the resolved
 *     leaf-level distillation.
 *   - No internal metadata (`generatedAt`, `commitSource`, `transcriptEntries`,
 *     `conversationTurns`, `llm`, `treeHash`, `jolliDocId/Url`,
 *     `orphanedDocIds`, `e2eTestGuide`, `plans`, `notes`).
 */
export interface SearchHit {
	// Identity + provenance
	readonly hash: string;
	readonly fullHash: string;
	readonly commitMessage: string;
	readonly commitAuthor: string;
	readonly commitDate: string;
	readonly branch: string;
	readonly commitType?: CommitType;
	readonly ticketId?: string;

	// Change scale
	readonly diffStats?: DiffStats;

	// Narrative
	readonly recap?: string;

	// Structured body — the meaty field
	readonly topics: ReadonlyArray<SearchHitTopic>;
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
