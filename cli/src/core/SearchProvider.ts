/**
 * SearchProvider — Abstraction over local vs remote (team-data) search backends.
 *
 * v1 ships with `LocalSearchProvider` only (orphan-branch / catalog.json).
 * `RemoteSearchProvider` is a stub that throws — it will be implemented when
 * Jolli Space integration ships and team-shared catalogs become queryable
 * over the Jolli API.
 *
 * The skill template (`/jolli-search`) talks to a single provider through
 * this interface so the LLM-facing JSON shape stays stable across backends.
 */

import type { BuildCatalogOptions, LoadHitsOptions, SearchCatalog, SearchResult } from "./Search.js";

/** Identifies where catalog/hits data comes from. */
export type SearchSource = "local" | "remote";

export interface SearchProvider {
	readonly source: SearchSource;
	/** Phase 1 — emit the catalog the LLM picks from. */
	buildCatalog(options: BuildCatalogOptions): Promise<SearchCatalog>;
	/** Phase 2 — load full content (with snippets) for hashes the LLM picked. */
	loadHits(options: LoadHitsOptions): Promise<SearchResult>;
}
