import { describe, expect, it } from "vitest";
import type { FileStatus } from "../../Types.js";
import { FilesDataService } from "./FilesDataService.js";

function makeFile(
	relativePath: string,
	isSelected = false,
	statusCode = "M",
): FileStatus {
	return {
		absolutePath: `/repo/${relativePath}`,
		relativePath,
		statusCode,
		indexStatus: statusCode === "?" ? "?" : statusCode,
		worktreeStatus: statusCode === "?" ? "?" : " ",
		isSelected,
	};
}

describe("FilesDataService.mergeWithSelection", () => {
	it("returns the same shape when selection is empty and all files unselected", () => {
		const raw = [makeFile("a.ts"), makeFile("b.ts")];
		const merged = FilesDataService.mergeWithSelection(raw, new Set());
		expect(merged.map((f) => f.isSelected)).toEqual([false, false]);
	});

	it("forces isSelected=true for paths in the selection set", () => {
		const raw = [makeFile("a.ts"), makeFile("b.ts")];
		const merged = FilesDataService.mergeWithSelection(raw, new Set(["a.ts"]));
		expect(merged[0].isSelected).toBe(true);
		expect(merged[1].isSelected).toBe(false);
	});

	it("forces isSelected=false for paths NOT in the selection set, even if raw had true", () => {
		const raw = [makeFile("a.ts", true), makeFile("b.ts", true)];
		const merged = FilesDataService.mergeWithSelection(raw, new Set());
		expect(merged.map((f) => f.isSelected)).toEqual([false, false]);
	});

	it("preserves object identity when the flag is unchanged (optimization)", () => {
		const raw = [makeFile("a.ts")];
		const merged = FilesDataService.mergeWithSelection(raw, new Set());
		expect(merged[0]).toBe(raw[0]);
	});

	it("produces a new object when the flag flips", () => {
		const raw = [makeFile("a.ts")];
		const merged = FilesDataService.mergeWithSelection(raw, new Set(["a.ts"]));
		expect(merged[0]).not.toBe(raw[0]);
		expect(merged[0].relativePath).toBe("a.ts");
	});
});

describe("FilesDataService.stableSort", () => {
	it("keeps the input order when priorOrder is empty (unknown files appended)", () => {
		const files = [makeFile("a.ts"), makeFile("b.ts")];
		const sorted = FilesDataService.stableSort(files, new Map());
		expect(sorted.map((f) => f.relativePath)).toEqual(["a.ts", "b.ts"]);
	});

	it("sorts known files by priorOrder and appends new files at the end", () => {
		const files = [makeFile("c.ts"), makeFile("a.ts"), makeFile("b.ts")];
		const priorOrder = new Map([
			["a.ts", 0],
			["b.ts", 1],
		]);
		const sorted = FilesDataService.stableSort(files, priorOrder);
		expect(sorted.map((f) => f.relativePath)).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("handles all-known files correctly", () => {
		const files = [makeFile("b.ts"), makeFile("a.ts")];
		const priorOrder = new Map([
			["a.ts", 0],
			["b.ts", 1],
		]);
		const sorted = FilesDataService.stableSort(files, priorOrder);
		expect(sorted.map((f) => f.relativePath)).toEqual(["a.ts", "b.ts"]);
	});

	it("falls back to 0 for files whose priorOrder entry is undefined", () => {
		const files = [makeFile("a.ts"), makeFile("b.ts")];
		const priorOrder = new Map<string, number>();
		priorOrder.set("a.ts", 0);
		// b.ts is absent from priorOrder → treated as "new" and appended
		const sorted = FilesDataService.stableSort(files, priorOrder);
		expect(sorted.map((f) => f.relativePath)).toEqual(["a.ts", "b.ts"]);
	});
});

describe("FilesDataService.rebuildOrder", () => {
	it("returns an empty map for an empty list", () => {
		expect(FilesDataService.rebuildOrder([])).toEqual(new Map());
	});

	it("maps each path to its zero-based index", () => {
		const files = [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")];
		const order = FilesDataService.rebuildOrder(files);
		expect(order.get("a.ts")).toBe(0);
		expect(order.get("b.ts")).toBe(1);
		expect(order.get("c.ts")).toBe(2);
	});
});

describe("FilesDataService.applyExcludeFilter", () => {
	const alwaysAllow = { hasPatterns: () => false, isExcluded: () => false };
	const excludeLogs = {
		hasPatterns: () => true,
		isExcluded: (p: string) => p.endsWith(".log"),
	};

	it("shortcuts with excludedCount=0 when filter has no patterns", () => {
		const files = [makeFile("a.ts"), makeFile("ignore.log")];
		const { visible, excludedCount } = FilesDataService.applyExcludeFilter(
			files,
			alwaysAllow,
		);
		expect(visible).toHaveLength(2);
		expect(excludedCount).toBe(0);
	});

	it("splits files into visible and excluded subsets", () => {
		const files = [makeFile("a.ts"), makeFile("ignore.log"), makeFile("b.ts")];
		const { visible, excludedCount } = FilesDataService.applyExcludeFilter(
			files,
			excludeLogs,
		);
		expect(visible.map((f) => f.relativePath)).toEqual(["a.ts", "b.ts"]);
		expect(excludedCount).toBe(1);
	});

	it("returns a new array even when filter is a no-op (defensive copy)", () => {
		const files = [makeFile("a.ts")];
		const { visible } = FilesDataService.applyExcludeFilter(files, alwaysAllow);
		expect(visible).not.toBe(files);
	});
});

describe("FilesDataService.selectedAndVisible", () => {
	const excludeLogs = {
		hasPatterns: () => true,
		isExcluded: (p: string) => p.endsWith(".log"),
	};

	it("returns only files that are both selected AND visible", () => {
		const files = [
			makeFile("a.ts", true),
			makeFile("b.ts", false),
			makeFile("secret.log", true),
		];
		const result = FilesDataService.selectedAndVisible(files, excludeLogs);
		expect(result.map((f) => f.relativePath)).toEqual(["a.ts"]);
	});

	it("returns empty when nothing is selected", () => {
		const files = [makeFile("a.ts"), makeFile("b.ts")];
		expect(FilesDataService.selectedAndVisible(files, excludeLogs)).toEqual([]);
	});
});
