/**
 * FilesDataService — pure file-list transforms.
 *
 * Zero VSCode imports, zero mutable state. Pure functions that can be unit
 * tested without any host mocks.
 */

import type { FileStatus } from "../../Types.js";

export interface ExcludePredicate {
	hasPatterns(): boolean;
	isExcluded(relativePath: string): boolean;
}

// biome-ignore lint/complexity/noStaticOnlyClass: namespace of pure helpers
export class FilesDataService {
	/**
	 * Overlay the in-memory selection set onto a fresh file list.
	 *
	 * Forces `isSelected` to match the selection set regardless of whatever
	 * value the bridge returned — selection is host-side UI state and the
	 * store is the authority. This preserves the GitHub-Desktop model where
	 * the git index is untouched until commit time.
	 */
	static mergeWithSelection(
		raw: ReadonlyArray<FileStatus>,
		selected: ReadonlySet<string>,
	): Array<FileStatus> {
		return raw.map((f) => {
			const shouldSelect = selected.has(f.relativePath);
			if (shouldSelect === f.isSelected) {
				return f;
			}
			return { ...f, isSelected: shouldSelect };
		});
	}

	/**
	 * Sort new files using a prior display-order map: known files keep their order,
	 * unknown files are appended at the end. Returns a new array.
	 */
	static stableSort(
		files: ReadonlyArray<FileStatus>,
		priorOrder: ReadonlyMap<string, number>,
	): Array<FileStatus> {
		const known: Array<FileStatus> = [];
		const added: Array<FileStatus> = [];
		for (const f of files) {
			if (priorOrder.has(f.relativePath)) {
				known.push(f);
			} else {
				added.push(f);
			}
		}
		known.sort(
			(a, b) =>
				(priorOrder.get(a.relativePath) ?? 0) -
				(priorOrder.get(b.relativePath) ?? 0),
		);
		return [...known, ...added];
	}

	/** Build a path → index map from the given list (used as `priorOrder` input). */
	static rebuildOrder(files: ReadonlyArray<FileStatus>): Map<string, number> {
		const map = new Map<string, number>();
		for (let i = 0; i < files.length; i++) {
			map.set(files[i].relativePath, i);
		}
		return map;
	}

	/**
	 * Split files into visible/excluded subsets using the given predicate.
	 * Returns `visible` preserving input order; `excludedCount` is the size of
	 * the hidden subset.
	 */
	static applyExcludeFilter(
		files: ReadonlyArray<FileStatus>,
		filter: ExcludePredicate,
	): { visible: Array<FileStatus>; excludedCount: number } {
		if (!filter.hasPatterns()) {
			return { visible: [...files], excludedCount: 0 };
		}
		const visible: Array<FileStatus> = [];
		let excludedCount = 0;
		for (const f of files) {
			if (filter.isExcluded(f.relativePath)) {
				excludedCount++;
			} else {
				visible.push(f);
			}
		}
		return { visible, excludedCount };
	}

	/**
	 * Intersection of selected + visible: used by CommitCommand to ensure an
	 * excluded file can never leak into a commit, even if it was pre-selected
	 * before the exclude pattern was added.
	 */
	static selectedAndVisible(
		files: ReadonlyArray<FileStatus>,
		filter: ExcludePredicate,
	): Array<FileStatus> {
		return files.filter(
			(f) => f.isSelected && !filter.isExcluded(f.relativePath),
		);
	}
}
