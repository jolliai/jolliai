import { describe, expect, it } from "vitest";
import { withCompileLock } from "./CompileMutex.js";

/** A deferred promise so a test can control exactly when a locked section finishes. */
function defer(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("withCompileLock", () => {
	it("returns the callback's resolved value", async () => {
		await expect(withCompileLock(async () => 42)).resolves.toBe(42);
	});

	it("serializes concurrent callbacks — the second starts only after the first settles", async () => {
		const order: string[] = [];
		const first = defer();

		const p1 = withCompileLock(async () => {
			order.push("1:start");
			await first.promise;
			order.push("1:end");
		});
		const p2 = withCompileLock(async () => {
			order.push("2:start");
		});

		// Let microtasks flush: the first section has entered but is parked on
		// `first.promise`; the second must NOT have started yet.
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["1:start"]);

		first.resolve();
		await Promise.all([p1, p2]);
		expect(order).toEqual(["1:start", "1:end", "2:start"]);
	});

	it("propagates a callback rejection to its caller without poisoning the next", async () => {
		const p1 = withCompileLock(async () => {
			throw new Error("boom");
		});
		// Queue the next before the first settles so it chains off the rejected tail.
		const p2 = withCompileLock(async () => "ok");

		await expect(p1).rejects.toThrow("boom");
		await expect(p2).resolves.toBe("ok");
	});
});
