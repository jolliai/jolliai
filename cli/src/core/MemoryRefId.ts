/**
 * MemoryRefId — formats a memory's human-facing reference id (`JM-<n>`) from the
 * Jolli Space doc id the web backend mints on a successful push
 * (`CommitSummary.jolliDocId`). Deliberately a dependency-free leaf module: it is
 * consumed at display boundaries in both the CLI-bundled VS Code webview
 * (SummaryHtmlBuilder, HistoryTreeProvider) so it must not drag any heavier graph
 * along. The `JM-` prefix is defined here once for the whole TS side; the IntelliJ
 * (Kotlin) port mirrors it in `SummaryUtils.kt`.
 */

/** Display prefix for a memory reference id. Single source of truth on the TS side. */
export const MEMORY_REF_PREFIX = "JM-";

/**
 * Formats the reference id for a memory, or `undefined` when it has none.
 *
 * A memory only has a reference id once it has been pushed to a Jolli Space and
 * the backend has returned a positive integer doc id (persisted as
 * `jolliDocId`). Anything else — missing, non-integer, or non-positive — yields
 * `undefined` so callers render no prefix for unsynced memories.
 */
export function formatMemoryRefId(jolliDocId?: number): string | undefined {
	if (typeof jolliDocId !== "number" || !Number.isInteger(jolliDocId) || jolliDocId <= 0) {
		return undefined;
	}
	return `${MEMORY_REF_PREFIX}${jolliDocId}`;
}

/**
 * Like {@link formatMemoryRefId} but always returns a value: when the memory has
 * no backend doc id yet (not synced to a Space), it falls back to the first 8
 * chars of the commit hash — e.g. `JM-f159924c`. Used where the surface wants to
 * always show a reference (the detail panel title), rather than hide it for
 * unsynced memories. The two forms are distinguishable (numeric vs hex), and the
 * value becomes the stable `JM-<docId>` once the memory syncs.
 */
export function formatMemoryRefIdWithHashFallback(jolliDocId: number | undefined, commitHash: string): string {
	return formatMemoryRefId(jolliDocId) ?? `${MEMORY_REF_PREFIX}${commitHash.slice(0, 8)}`;
}
