/**
 * MemoriesDataService — pure derivations for the Memories panel.
 *
 * Zero VSCode imports, zero mutable state. Filtering lives bridge-side, so
 * this service focuses on display derivations (description string, flags).
 */

import type { SummaryIndexEntry } from "../../../../cli/src/Types.js";

// biome-ignore lint/complexity/noStaticOnlyClass: namespace of pure helpers
export class MemoriesDataService {
	/**
	 * Compute the view description string shown under the panel title.
	 * Matches the format that was previously baked into the provider:
	 *  - filter active → `"<query>" — N result(s)`
	 *  - no filter + total>0 → `N memories`
	 *  - otherwise → undefined (VSCode clears the description)
	 */
	static buildDescription(args: {
		filter: string;
		entriesCount: number;
		totalCount: number;
	}): string | undefined {
		if (args.filter) {
			const n = args.entriesCount;
			return `"${args.filter}" — ${n} result${n !== 1 ? "s" : ""}`;
		}
		return args.totalCount > 0 ? `${args.totalCount} memories` : undefined;
	}

	/**
	 * Decide whether the "Load More" affordance should be rendered.
	 * Filter active disables Load More (bridge returns matched set in one call).
	 */
	static canLoadMore(args: {
		filter: string;
		loadedCount: number;
		totalCount: number;
	}): boolean {
		return !args.filter && args.loadedCount < args.totalCount;
	}

	/** Returns true when no entries are present (used to drive empty-state context key). */
	static isEmpty(entries: ReadonlyArray<SummaryIndexEntry>): boolean {
		return entries.length === 0;
	}
}
