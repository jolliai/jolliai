import { afterEach, describe, expect, it } from "vitest";
import { defaultConcurrency, ioBudget, mapWithConcurrency, withIoBudget } from "./Concurrency.js";

/** A promise plus the handles to settle it, so a test can hold an operation open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Lets every already-resolved continuation run, so pending state is observable. */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
	ioBudget.reset();
});

describe("mapWithConcurrency", () => {
	it("preserves input order regardless of completion order", async () => {
		// Load-bearing rather than cosmetic: callers pair the result with the input by
		// index, so a completion-ordered result would mis-pair every entry.
		const out = await mapWithConcurrency([30, 10, 20], async (ms) => {
			await new Promise((r) => setTimeout(r, ms));
			return ms;
		});
		expect(out).toEqual([30, 10, 20]);
	});

	it("never exceeds the requested width", async () => {
		let inFlight = 0;
		let peak = 0;
		await mapWithConcurrency(
			[1, 2, 3, 4, 5, 6, 7],
			async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, 1));
				inFlight--;
			},
			2,
		);
		expect(peak).toBe(2);
	});

	it("defaults its width to the shared budget, so a lone call site is not throttled below the pool", async () => {
		// The whole point of the default: on a real machine most stores are empty, so a
		// fan-out narrower than the pool would cap the one site that has work while the
		// pool sat idle.
		ioBudget.configure({ slots: 3 });
		expect(defaultConcurrency()).toBe(3);
		let peak = 0;
		let inFlight = 0;
		await mapWithConcurrency([1, 2, 3, 4, 5, 6], async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 1));
			inFlight--;
		});
		expect(peak).toBe(3);
	});

	it("handles an empty list without spawning a worker", async () => {
		// `width` is clamped to the item count, and Math.max(1, …) would otherwise
		// spawn one worker for zero items.
		expect(await mapWithConcurrency([], async () => 1)).toEqual([]);
	});

	it("propagates a rejection from fn", async () => {
		// Documented contract: a throw is treated as a programming error and abandons
		// the remaining items, which is why scanners catch per item and return a
		// sentinel instead.
		await expect(
			mapWithConcurrency([1], async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});
});

describe("withIoBudget", () => {
	it("holds operations past the slot count until one releases", async () => {
		ioBudget.configure({ slots: 2 });
		const gates = [deferred(), deferred(), deferred()];
		const started: number[] = [];
		const runs = gates.map((gate, i) =>
			withIoBudget(0, async () => {
				started.push(i);
				await gate.promise;
			}),
		);

		await settle();
		expect(started).toEqual([0, 1]);

		gates[0].resolve();
		await settle();
		expect(started).toEqual([0, 1, 2]);

		gates[1].resolve();
		gates[2].resolve();
		await Promise.all(runs);
	});

	it("counts bytes as a second, independent dimension", async () => {
		// A slot count treats every read as the same size. Two 6-byte reads fit two
		// slots but not a 10-byte allowance, so the second waits on bytes alone.
		ioBudget.configure({ slots: 4, bytesInFlight: 10 });
		const gates = [deferred(), deferred()];
		const started: number[] = [];
		const runs = gates.map((gate, i) =>
			withIoBudget(6, async () => {
				started.push(i);
				await gate.promise;
			}),
		);

		await settle();
		expect(started).toEqual([0]);

		gates[0].resolve();
		await settle();
		expect(started).toEqual([0, 1]);

		gates[1].resolve();
		await Promise.all(runs);
	});

	it("runs a claim larger than the whole byte cap alone rather than never", async () => {
		// The clamp is what makes an oversized read runnable at all: unclamped it could
		// never fit and would wait forever.
		ioBudget.configure({ slots: 4, bytesInFlight: 10 });
		const held = deferred();
		const started: string[] = [];
		const big = withIoBudget(999, async () => {
			started.push("big");
			await held.promise;
		});

		await settle();
		expect(started).toEqual(["big"]);

		const small = withIoBudget(1, async () => {
			started.push("small");
		});
		await settle();
		// The oversized claim took the entire allowance, so nothing overlaps it.
		expect(started).toEqual(["big"]);

		held.resolve();
		await Promise.all([big, small]);
		expect(started).toEqual(["big", "small"]);
	});

	it("grants in arrival order, so a large claim is not starved by later small ones", async () => {
		ioBudget.configure({ slots: 1, bytesInFlight: 100 });
		const held = deferred();
		const order: string[] = [];
		const first = withIoBudget(0, async () => {
			order.push("first");
			await held.promise;
		});
		const large = withIoBudget(100, async () => {
			order.push("large");
		});
		const smallA = withIoBudget(1, async () => {
			order.push("smallA");
		});
		const smallB = withIoBudget(1, async () => {
			order.push("smallB");
		});

		await settle();
		expect(order).toEqual(["first"]);

		held.resolve();
		await Promise.all([first, large, smallA, smallB]);
		expect(order).toEqual(["first", "large", "smallA", "smallB"]);
	});

	it("re-clamps a queued claim when the byte cap shrinks under it", async () => {
		// The whole-process stall this avoids: a waiter whose claim was fixed against the
		// old cap can never fit the new one, and it is the FIFO head, so nothing behind it
		// runs either — no error, no timeout, every scan in the process simply stops.
		ioBudget.configure({ slots: 1, bytesInFlight: 100 });
		const held = deferred();
		const order: string[] = [];
		const first = withIoBudget(0, async () => {
			order.push("first");
			await held.promise;
		});
		await settle();
		const queued = withIoBudget(80, async () => {
			order.push("queued");
		});

		ioBudget.configure({ bytesInFlight: 8 });
		held.resolve();
		await Promise.all([first, queued]);

		expect(order).toEqual(["first", "queued"]);
	});

	it("releases exactly what it took when the cap changes mid-operation", async () => {
		// Recomputing the clamp on release would return a different number than was
		// booked, so `bytesInUse` would drift and the budget would leak capacity (or
		// invent it) once per resize.
		ioBudget.configure({ slots: 4, bytesInFlight: 100 });
		const held = deferred();
		const running = withIoBudget(100, async () => {
			await held.promise;
		});
		await settle();

		ioBudget.configure({ bytesInFlight: 10 });
		held.resolve();
		await running;

		// Nothing left booked: a 10-byte claim is the whole new cap and must still fit.
		const after = withIoBudget(10, async () => "done");
		await expect(after).resolves.toBe("done");
	});

	it("queues behind an existing waiter even when the claim would fit", async () => {
		// Jumping the queue is the same starvation the FIFO rule exists to prevent, so
		// a fitting claim still goes to the back.
		ioBudget.configure({ slots: 1 });
		const held = deferred();
		const order: string[] = [];
		const first = withIoBudget(0, async () => {
			order.push("first");
			await held.promise;
		});
		await settle();
		const second = withIoBudget(0, async () => {
			order.push("second");
		});
		const third = withIoBudget(0, async () => {
			order.push("third");
		});

		held.resolve();
		await Promise.all([first, second, third]);
		expect(order).toEqual(["first", "second", "third"]);
	});

	it("releases the slot when fn throws", async () => {
		ioBudget.configure({ slots: 1 });
		await expect(
			withIoBudget(5, async () => {
				throw new Error("read failed");
			}),
		).rejects.toThrow("read failed");
		// A leaked slot would hang this second call forever.
		expect(await withIoBudget(5, async () => "ok")).toBe("ok");
	});

	it("wakes waiters when the limits are raised", async () => {
		// Raising must pump immediately; otherwise a caller already waiting sits until
		// some unrelated release happens to come along.
		ioBudget.configure({ slots: 1 });
		const held = deferred();
		const order: string[] = [];
		const first = withIoBudget(0, async () => {
			order.push("first");
			await held.promise;
		});
		await settle();
		const second = withIoBudget(0, async () => {
			order.push("second");
		});
		await settle();
		expect(order).toEqual(["first"]);

		ioBudget.configure({ slots: 2 });
		await settle();
		expect(order).toEqual(["first", "second"]);

		held.resolve();
		await Promise.all([first, second]);
	});

	it("clamps a configured slot count to at least one", async () => {
		ioBudget.configure({ slots: 0 });
		expect(defaultConcurrency()).toBe(1);
		expect(await withIoBudget(0, async () => "ran")).toBe("ran");
	});

	it("treats a zero byte cap as byte limiting switched off", async () => {
		// Every claim clamps to 0, so only the slot count binds.
		ioBudget.configure({ slots: 2, bytesInFlight: 0 });
		const gates = [deferred(), deferred()];
		const started: number[] = [];
		const runs = gates.map((gate, i) =>
			withIoBudget(1024, async () => {
				started.push(i);
				await gate.promise;
			}),
		);
		await settle();
		expect(started).toEqual([0, 1]);
		gates[0].resolve();
		gates[1].resolve();
		await Promise.all(runs);
	});

	it("reset restores the shipped defaults", () => {
		ioBudget.configure({ slots: 1 });
		expect(defaultConcurrency()).toBe(1);
		ioBudget.reset();
		expect(defaultConcurrency()).toBe(8);
	});
});
