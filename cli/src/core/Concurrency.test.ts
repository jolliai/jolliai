import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./Concurrency.js";

const defer = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

describe("mapWithConcurrency", () => {
	it("never exceeds the concurrency limit", async () => {
		let active = 0;
		let peak = 0;
		const gates = Array.from({ length: 10 }, () => defer());
		const task = async (i: number) => {
			active++;
			peak = Math.max(peak, active);
			await gates[i].promise;
			active--;
			return i * 2;
		};
		const items = Array.from({ length: 10 }, (_, i) => i);
		const run = mapWithConcurrency(items, 3, task);
		// release all gates on the next tick so up to 3 can be in-flight at once
		await Promise.resolve();
		for (const g of gates) g.resolve();
		const out = await run;
		expect(peak).toBeLessThanOrEqual(3);
		expect(out).toEqual(items.map((i) => i * 2));
	});

	it("preserves input order regardless of completion order", async () => {
		const task = async (i: number) => {
			await new Promise((r) => setTimeout(r, i === 0 ? 20 : 0));
			return i;
		};
		const out = await mapWithConcurrency([0, 1, 2], 3, task);
		expect(out).toEqual([0, 1, 2]);
	});

	it("degrades a throwing task via the onError mapper instead of rejecting", async () => {
		const out = await mapWithConcurrency(
			[1, 2, 3],
			2,
			async (i) => {
				if (i === 2) throw new Error("boom");
				return `ok:${i}`;
			},
			(item, err) => `err:${item}:${(err as Error).message}`,
		);
		expect(out).toEqual(["ok:1", "err:2:boom", "ok:3"]);
	});

	it("re-throws when no onError mapper is supplied", async () => {
		await expect(
			mapWithConcurrency([1], 1, async () => {
				throw new Error("nope");
			}),
		).rejects.toThrow("nope");
	});

	it("stops pulling new items after the first un-mapped error", async () => {
		const attempted: number[] = [];
		const gate = defer();
		// Two workers start on items 0 and 1. Worker A throws immediately; worker B
		// parks on item 1. Once released, B must NOT pick up 2 or 3 — the batch is
		// already rejecting, so those tasks would be wasted work.
		const run = mapWithConcurrency([0, 1, 2, 3], 2, async (i) => {
			attempted.push(i);
			if (i === 0) throw new Error("boom");
			await gate.promise;
			return i;
		});
		const settled = run.then(
			() => {
				throw new Error("should have rejected");
			},
			(e: unknown) => e,
		);
		// Let worker A throw (sets the abort flag) before releasing worker B.
		await Promise.resolve();
		await Promise.resolve();
		gate.resolve();
		const err = await settled;
		expect((err as Error).message).toBe("boom");
		expect([...attempted].sort()).toEqual([0, 1]);
	});

	it("returns empty array for empty input", async () => {
		expect(await mapWithConcurrency([], 4, async (i) => i)).toEqual([]);
	});
});
