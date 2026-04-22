/**
 * CommitsDataService — pure commit-list transforms.
 *
 * Zero VSCode imports, zero mutable state.
 */

import type { BranchCommit } from "../../Types.js";

// biome-ignore lint/complexity/noStaticOnlyClass: namespace of pure helpers
export class CommitsDataService {
	/** Returns true if the commit hash sequence changed between two snapshots. */
	static didSequenceChange(
		previousHashes: ReadonlyArray<string>,
		nextHashes: ReadonlyArray<string>,
	): boolean {
		if (previousHashes.length !== nextHashes.length) {
			return true;
		}
		return previousHashes.some((h, i) => h !== nextHashes[i]);
	}

	/**
	 * Compute the selection that results from checking the commit at `index`.
	 * Range semantics: checking commit N → also check all commits from 0..N
	 * (HEAD is index 0, so this selects the newer commits too).
	 */
	static applyRangeCheck(
		commits: ReadonlyArray<BranchCommit>,
		currentSelection: ReadonlySet<string>,
		index: number,
		checked: boolean,
	): Set<string> {
		const next = new Set(currentSelection);
		if (index < 0 || index >= commits.length) {
			return next;
		}
		if (checked) {
			for (let i = 0; i <= index; i++) {
				next.add(commits[i].hash);
			}
		} else {
			for (let i = index; i < commits.length; i++) {
				next.delete(commits[i].hash);
			}
		}
		return next;
	}

	/** Returns the commits whose hashes are in the selection set. */
	static selectedCommits(
		commits: ReadonlyArray<BranchCommit>,
		selection: ReadonlySet<string>,
	): Array<BranchCommit> {
		return commits.filter((c) => selection.has(c.hash));
	}

	/** Returns hashes in the selection that no longer correspond to loaded commits. */
	static staleSelection(
		commits: ReadonlyArray<BranchCommit>,
		selection: ReadonlySet<string>,
	): Array<string> {
		const valid = new Set(commits.map((c) => c.hash));
		return [...selection].filter((h) => !valid.has(h));
	}

	/** Truncate to the first 8 chars of a hash (or undefined passthrough). */
	static shortHash(hash: string | undefined): string | undefined {
		return hash ? hash.substring(0, 8) : undefined;
	}
}
