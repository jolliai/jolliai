import { describe, expect, it } from "vitest";
import type { FileStatus } from "../core/Bridge.js";
import type { FilesSnapshot } from "../stores/FilesStore.js";
import { computeChangesBadge } from "./ChangesBadge.js";

function snap(overrides: Partial<FilesSnapshot> = {}): FilesSnapshot {
	return {
		files: [],
		visibleFiles: [],
		selectedFiles: [],
		excludedCount: 0,
		visibleCount: 0,
		isEmpty: true,
		isMigrating: false,
		isEnabled: true,
		changeReason: "init",
		...overrides,
	};
}

const stubFile = {} as unknown as FileStatus;

describe("computeChangesBadge", () => {
	it("returns undefined when there are no visible files", () => {
		expect(computeChangesBadge(snap())).toBeUndefined();
	});

	it("returns the visible count and selected-aware tooltip when files are present", () => {
		expect(
			computeChangesBadge(
				snap({ visibleCount: 3, selectedFiles: [stubFile, stubFile] }),
			),
		).toEqual({ value: 3, tooltip: "3 changed, 2 selected" });
	});

	// Tooltip uses an unpluralized "changed" for parity with the trailing
	// "selected" — both stay the same shape regardless of count, so the badge
	// reads consistently at any size.
	it("keeps tooltip shape for visibleCount === 1", () => {
		expect(computeChangesBadge(snap({ visibleCount: 1 }))).toEqual({
			value: 1,
			tooltip: "1 changed, 0 selected",
		});
	});

	// Pins the bug where the badge showed "8" while the panel rendered
	// "No changes." because Memory Bank migration leaves visibleCount stale
	// while FilesTreeProvider.getChildren returns an empty list.
	it("returns undefined when isMigrating, even with non-zero visibleCount", () => {
		expect(
			computeChangesBadge(snap({ visibleCount: 8, isMigrating: true })),
		).toBeUndefined();
	});

	it("returns undefined when isEnabled is false, even with non-zero visibleCount", () => {
		expect(
			computeChangesBadge(snap({ visibleCount: 8, isEnabled: false })),
		).toBeUndefined();
	});
});
