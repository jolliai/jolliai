import { describe, expect, it, vi } from "vitest";
import type { SummaryIndexEntry } from "../../../cli/src/Types.js";

vi.mock("../util/Logger.js", () => ({
	log: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
	initLogger: vi.fn(),
}));

import { MemoriesStore } from "./MemoriesStore.js";

function makeEntry(hash: string): SummaryIndexEntry {
	return {
		commitHash: hash,
		parentCommitHash: null,
		commitMessage: "msg",
		commitDate: "2026-01-01T00:00:00Z",
		branch: "main",
		topicCount: 0,
	} as unknown as SummaryIndexEntry;
}

function makeBridge(entries: Array<SummaryIndexEntry>, totalCount?: number) {
	return {
		listSummaryEntries: vi.fn(async () => ({
			entries,
			totalCount: totalCount ?? entries.length,
		})),
	};
}

describe("MemoriesStore — lazy load contract", () => {
	it("starts with firstLoadDone=false and hasFirstLoaded=false", () => {
		const store = new MemoriesStore(makeBridge([]) as never);
		expect(store.hasFirstLoaded()).toBe(false);
		expect(store.getSnapshot().firstLoadDone).toBe(false);
	});

	it("ensureFirstLoad queries the bridge exactly once", async () => {
		const bridge = makeBridge([makeEntry("a")]);
		const store = new MemoriesStore(bridge as never);
		await store.ensureFirstLoad();
		await store.ensureFirstLoad();
		await store.ensureFirstLoad();
		expect(bridge.listSummaryEntries).toHaveBeenCalledTimes(1);
		expect(store.hasFirstLoaded()).toBe(true);
	});

	it("refresh marks firstLoadDone=true", async () => {
		const bridge = makeBridge([makeEntry("a")]);
		const store = new MemoriesStore(bridge as never);
		await store.refresh();
		expect(store.hasFirstLoaded()).toBe(true);
	});
});

describe("MemoriesStore — filter, loadMore, enabled", () => {
	it("setFilter updates filter and re-queries", async () => {
		const bridge = makeBridge([makeEntry("a")], 1);
		const store = new MemoriesStore(bridge as never);
		await store.setFilter("auth");
		expect(store.getFilter()).toBe("auth");
		expect(bridge.listSummaryEntries).toHaveBeenCalledWith(500, 0, "auth");
		expect(store.getSnapshot().hasFilter).toBe(true);
	});

	it("setFilter trims whitespace", async () => {
		const bridge = makeBridge([], 0);
		const store = new MemoriesStore(bridge as never);
		await store.setFilter("   biome  ");
		expect(store.getFilter()).toBe("biome");
	});

	it("loadMore increments PAGE_SIZE and fetches with no filter", async () => {
		const bridge = makeBridge([makeEntry("a")], 100);
		const store = new MemoriesStore(bridge as never);
		await store.refresh();
		bridge.listSummaryEntries.mockClear();
		await store.loadMore();
		expect(bridge.listSummaryEntries).toHaveBeenCalledWith(20, 0, undefined);
	});

	it("setEnabled is idempotent when unchanged", () => {
		const store = new MemoriesStore(makeBridge([]) as never);
		const listener = vi.fn();
		store.onChange(listener);
		store.setEnabled(true);
		expect(listener).not.toHaveBeenCalled();
	});

	it("setEnabled emits enabled reason on transition", () => {
		const store = new MemoriesStore(makeBridge([]) as never);
		const listener = vi.fn();
		store.onChange(listener);
		store.setEnabled(false);
		expect(listener).toHaveBeenCalled();
		expect(store.getSnapshot().changeReason).toBe("enabled");
		expect(store.getSnapshot().isEnabled).toBe(false);
	});

	it("setEnabled(false) clears entries/filter so description cannot stick", async () => {
		const bridge = makeBridge([makeEntry("a"), makeEntry("b")], 42);
		const store = new MemoriesStore(bridge as never);
		await store.setFilter("auth");
		expect(store.getSnapshot().entriesCount).toBeGreaterThan(0);
		expect(store.getFilter()).toBe("auth");

		store.setEnabled(false);

		const snap = store.getSnapshot();
		expect(snap.entries).toEqual([]);
		expect(snap.entriesCount).toBe(0);
		expect(snap.totalCount).toBe(0);
		expect(snap.filter).toBe("");
		expect(snap.hasFilter).toBe(false);
		expect(snap.firstLoadDone).toBe(false);
		expect(snap.isEnabled).toBe(false);
	});

	it("setEnabled(false) resets loadedCount so Load More state does not cross disable/enable", async () => {
		const bridge = makeBridge([makeEntry("a")], 100);
		const store = new MemoriesStore(bridge as never);
		// Simulate initial load + two Load More presses: loadedCount 10 → 20 → 30.
		await store.refresh();
		await store.loadMore();
		await store.loadMore();
		expect(bridge.listSummaryEntries).toHaveBeenLastCalledWith(
			30,
			0,
			undefined,
		);

		// Disable → re-enable → the next refresh must ask for the default 10,
		// NOT carry the previous pagination cursor across the cycle.
		store.setEnabled(false);
		store.setEnabled(true);
		bridge.listSummaryEntries.mockClear();
		await store.refresh();
		expect(bridge.listSummaryEntries).toHaveBeenCalledWith(10, 0, undefined);
	});
});

describe("MemoriesStore — error handling", () => {
	it("swallows listSummaryEntries errors and resets to empty", async () => {
		const bridge = {
			listSummaryEntries: vi
				.fn()
				.mockRejectedValue(new Error("bridge failure")),
		};
		const store = new MemoriesStore(bridge as never);
		await store.refresh();
		expect(store.getSnapshot().entries).toEqual([]);
		expect(store.getSnapshot().totalCount).toBe(0);
		expect(store.hasFirstLoaded()).toBe(true);
	});
});

describe("MemoriesStore — snapshot exposes derived fields", () => {
	it("includes filter, entriesCount, totalCount, canLoadMore", async () => {
		const bridge = makeBridge([makeEntry("a"), makeEntry("b")], 50);
		const store = new MemoriesStore(bridge as never);
		await store.refresh();
		const snap = store.getSnapshot();
		expect(snap.entriesCount).toBe(2);
		expect(snap.totalCount).toBe(50);
		expect(snap.canLoadMore).toBe(true);
		expect(snap.hasFilter).toBe(false);
	});

	it("canLoadMore is false when filter is active", async () => {
		const bridge = makeBridge([makeEntry("a")], 100);
		const store = new MemoriesStore(bridge as never);
		await store.setFilter("x");
		expect(store.getSnapshot().canLoadMore).toBe(false);
	});
});
