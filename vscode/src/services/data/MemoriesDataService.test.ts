import { describe, expect, it } from "vitest";
import type { SummaryIndexEntry } from "../../../../cli/src/Types.js";
import { MemoriesDataService } from "./MemoriesDataService.js";

describe("MemoriesDataService.buildDescription", () => {
	it("returns singular 'result' when filter matches exactly 1", () => {
		expect(
			MemoriesDataService.buildDescription({
				filter: "foo",
				entriesCount: 1,
				totalCount: 100,
			}),
		).toBe('"foo" — 1 result');
	});

	it("returns plural 'results' when filter matches > 1", () => {
		expect(
			MemoriesDataService.buildDescription({
				filter: "foo",
				entriesCount: 3,
				totalCount: 100,
			}),
		).toBe('"foo" — 3 results');
	});

	it("returns plural 'results' when filter matches 0", () => {
		expect(
			MemoriesDataService.buildDescription({
				filter: "nothing",
				entriesCount: 0,
				totalCount: 100,
			}),
		).toBe('"nothing" — 0 results');
	});

	it("returns total count when no filter", () => {
		expect(
			MemoriesDataService.buildDescription({
				filter: "",
				entriesCount: 5,
				totalCount: 42,
			}),
		).toBe("42 memories");
	});

	it("returns undefined when no filter and totalCount is 0", () => {
		expect(
			MemoriesDataService.buildDescription({
				filter: "",
				entriesCount: 0,
				totalCount: 0,
			}),
		).toBeUndefined();
	});
});

describe("MemoriesDataService.canLoadMore", () => {
	it("returns true when loaded < total and no filter", () => {
		expect(
			MemoriesDataService.canLoadMore({
				filter: "",
				loadedCount: 10,
				totalCount: 25,
			}),
		).toBe(true);
	});

	it("returns false when loaded >= total", () => {
		expect(
			MemoriesDataService.canLoadMore({
				filter: "",
				loadedCount: 25,
				totalCount: 25,
			}),
		).toBe(false);
	});

	it("returns false when filter is active (Load More is hidden during search)", () => {
		expect(
			MemoriesDataService.canLoadMore({
				filter: "foo",
				loadedCount: 10,
				totalCount: 100,
			}),
		).toBe(false);
	});
});

describe("MemoriesDataService.isEmpty", () => {
	it("returns true for empty list", () => {
		expect(MemoriesDataService.isEmpty([])).toBe(true);
	});

	it("returns false when entries exist", () => {
		const entry = { commitHash: "abc" } as unknown as SummaryIndexEntry;
		expect(MemoriesDataService.isEmpty([entry])).toBe(false);
	});
});
