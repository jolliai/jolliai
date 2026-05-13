/**
 * HeadEntryFilter — single source of truth for "which entries are v4 Hoist heads?".
 *
 * v4 Hoist write path (see `flattenSummaryTree` in SummaryStore.ts and
 * `mergeManyToOne` for squash): every new commit / amend / squash writes a
 * fresh root summary with `parentCommitHash = null`, and every prior version
 * it supersedes becomes a child stripped of functional metadata and reassigned
 * `parentCommitHash = <new root hash>`. So the index invariant is:
 *
 *   parentCommitHash == null  →  current live "head" entry (the version
 *                                git log / git show now references)
 *   parentCommitHash != null  →  older version that has been hoisted into
 *                                some head's children[] (no longer visible
 *                                in git log; preserved in the index purely
 *                                for hierarchical drill-down).
 *
 * The previous ChainLeafFilter judged heads as DAG leaves ("no other entry
 * names me as parent"). That reads natural under Git's parent direction but is
 * **opposite** to v4 Hoist's direction: under Hoist, the head is the root
 * (no parent), and the DAG leaves are precisely the discarded older versions.
 * Anything looking up "what should be displayed / kept on disk" must use the
 * Hoist-aligned reading, which is what this module provides.
 *
 * No `(repoName, branch)` scoping is needed: the head test reads one field on
 * one entry and ignores everything else. Cycles, dangling-parent rows, and
 * cross-branch / cross-repo parent pointers are all handled correctly by the
 * field-only check — any entry whose `parentCommitHash` is non-null is
 * categorically not a head, regardless of where that pointer resolves.
 */

import type { SummaryIndexEntry } from "../Types.js";

/** Returns the set of commitHashes that are v4 Hoist heads (parent == null). */
export function getBranchHeads(entries: Iterable<SummaryIndexEntry>): Set<string> {
	const heads = new Set<string>();
	for (const entry of entries) {
		if (entry.parentCommitHash == null) {
			heads.add(entry.commitHash);
		}
	}
	return heads;
}

/** Convenience: returns only the entries that are heads. Preserves input order. */
export function filterToBranchHeads<T extends SummaryIndexEntry>(entries: Iterable<T>): T[] {
	const result: T[] = [];
	for (const e of entries) {
		if (e.parentCommitHash == null) result.push(e);
	}
	return result;
}
