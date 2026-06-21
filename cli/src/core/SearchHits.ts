/**
 * BM25 search hits — the single implementation behind both the MCP `search`
 * tool and the CLI `search` command, so primary and fallback return identical
 * results. Wraps the Orama-backed SearchIndex.
 */
import { type SearchHitResult, SearchIndex } from "./SearchIndex.js";
import type { StorageProvider } from "./StorageProvider.js";

export interface SearchHitsArgs {
	query: string;
	branch?: string;
	type?: "topic" | "commit";
	limit?: number;
}

export async function searchHits(
	cwd: string,
	args: SearchHitsArgs,
	storage?: StorageProvider,
): Promise<SearchHitResult[]> {
	if (!args.query || !args.query.trim()) {
		throw new Error("`query` is required and must be non-empty");
	}
	const index = await SearchIndex.openCached(cwd, storage);
	return index.search({ query: args.query, branch: args.branch, type: args.type, limit: args.limit });
}
