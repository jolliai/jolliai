/**
 * RemoteSearchProvider — placeholder for the Jolli Space team-data backend.
 *
 * Currently a stub: throws a clear error message describing when team search
 * will be available. The exported symbol exists so the surrounding wiring
 * (CLI flags such as `--source remote`, future feature-flag plumbing) can
 * type-check today without speculative implementation work.
 */

import type { BuildCatalogOptions, LoadHitsOptions, SearchCatalog, SearchResult } from "./Search.js";
import type { SearchProvider } from "./SearchProvider.js";

const NOT_IMPLEMENTED_MESSAGE = "Team search will be available once Jolli Space integration ships.";

export class RemoteSearchProvider implements SearchProvider {
	readonly source = "remote" as const;

	async buildCatalog(_options: BuildCatalogOptions): Promise<SearchCatalog> {
		throw new Error(NOT_IMPLEMENTED_MESSAGE);
	}

	async loadHits(_options: LoadHitsOptions): Promise<SearchResult> {
		throw new Error(NOT_IMPLEMENTED_MESSAGE);
	}
}
