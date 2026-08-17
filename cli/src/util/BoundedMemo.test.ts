import { describe, expect, it, vi } from "vitest";
import { setBounded } from "./BoundedMemo.js";

describe("setBounded", () => {
	it("stores without evicting while under the limit", () => {
		const memo = new Map<string, number>();
		const onEvict = vi.fn();

		setBounded(memo, 3, "a", 1, onEvict);
		setBounded(memo, 3, "b", 2, onEvict);

		expect([...memo]).toEqual([
			["a", 1],
			["b", 2],
		]);
		expect(onEvict).not.toHaveBeenCalled();
	});

	it("clears the whole map when a NEW key would push it past the limit", () => {
		// Whole-map rather than LRU at every call site: the cost of a miss is re-doing work
		// that was already being done before the memo existed, so eviction accuracy buys
		// nothing. `onEvict` sees the pre-clear size so the caller can log it.
		const memo = new Map<string, number>([
			["a", 1],
			["b", 2],
		]);
		const onEvict = vi.fn();

		setBounded(memo, 2, "c", 3, onEvict);

		expect([...memo]).toEqual([["c", 3]]);
		expect(onEvict).toHaveBeenCalledExactlyOnceWith(2);
	});

	it("does NOT clear when re-remembering a key it already holds", () => {
		// The correctness half. A write that cannot grow the map must not throw away every
		// other entry: refreshing an existing key at exactly the limit is reachable (a
		// rollout whose mtime moved backwards is re-read and re-remembered), and the
		// observable result was the whole cache evaporating on what should have been a
		// no-op — followed by re-opening and re-parsing every file it had held.
		const memo = new Map<string, number>([
			["a", 1],
			["b", 2],
		]);
		const onEvict = vi.fn();

		setBounded(memo, 2, "b", 99, onEvict);

		expect([...memo]).toEqual([
			["a", 1],
			["b", 99],
		]);
		expect(onEvict).not.toHaveBeenCalled();
	});

	it("works without an onEvict callback", () => {
		const memo = new Map<string, number>([["a", 1]]);

		setBounded(memo, 1, "b", 2);

		expect([...memo]).toEqual([["b", 2]]);
	});

	it("treats a limit of zero as cache-nothing-but-the-latest", () => {
		const memo = new Map<string, number>();

		setBounded(memo, 0, "a", 1);
		setBounded(memo, 0, "b", 2);

		expect([...memo]).toEqual([["b", 2]]);
	});
});
