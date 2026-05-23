/**
 * Tests for the tiny `retry` helper. Sleeps are injected (no real time
 * elapses) so the tests stay fast and deterministic.
 */

import { describe, expect, it, vi } from "vitest";
import { computeDelay, retry } from "./Backoff.js";

function noSleep(): (ms: number) => Promise<void> {
	const fn = vi.fn(async (_ms: number) => {});
	return fn;
}

describe("retry", () => {
	it("returns the first success without retrying", async () => {
		const fn = vi.fn(async () => "ok");
		const result = await retry(fn, {
			attempts: 3,
			backoff: { baseMs: 10, maxMs: 100, factor: 2, jitter: false },
			shouldRetry: () => true,
			sleep: noSleep(),
		});
		expect(result).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries on transient failure and returns the eventual success", async () => {
		const fn = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error("network"))
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValueOnce("ok");
		const sleep = noSleep();
		const result = await retry(fn, {
			attempts: 5,
			backoff: { baseMs: 10, maxMs: 100, factor: 2, jitter: false },
			shouldRetry: () => true,
			sleep,
		});
		expect(result).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it("throws after exhausting attempts", async () => {
		const fn = vi.fn(async () => {
			throw new Error("boom");
		});
		await expect(
			retry(fn, {
				attempts: 3,
				backoff: { baseMs: 10, maxMs: 100, factor: 2, jitter: false },
				shouldRetry: () => true,
				sleep: noSleep(),
			}),
		).rejects.toThrow("boom");
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("respects shouldRetry — throws immediately when it returns false", async () => {
		const fn = vi.fn(async () => {
			throw new Error("permanent");
		});
		await expect(
			retry(fn, {
				attempts: 5,
				backoff: { baseMs: 10, maxMs: 100, factor: 2, jitter: false },
				shouldRetry: () => false,
				sleep: noSleep(),
			}),
		).rejects.toThrow("permanent");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("uses default real-time sleep when no sleep override is provided", async () => {
		// Force one retry with a 1 ms delay so the real default sleep fires.
		const fn = vi
			.fn<() => Promise<number>>()
			.mockRejectedValueOnce(new Error("transient"))
			.mockResolvedValueOnce(42);
		const result = await retry(fn, {
			attempts: 2,
			backoff: { baseMs: 1, maxMs: 1, factor: 2, jitter: false },
			shouldRetry: () => true,
		});
		expect(result).toBe(42);
		expect(fn).toHaveBeenCalledTimes(2);
	});
});

describe("computeDelay", () => {
	const opts = { baseMs: 100, maxMs: 1000, factor: 2, jitter: false };

	it("returns base for attempt 0", () => {
		expect(computeDelay(0, opts)).toBe(100);
	});

	it("doubles per attempt", () => {
		expect(computeDelay(1, opts)).toBe(200);
		expect(computeDelay(2, opts)).toBe(400);
		expect(computeDelay(3, opts)).toBe(800);
	});

	it("caps at maxMs", () => {
		expect(computeDelay(10, opts)).toBe(1000);
	});

	it("applies jitter in [0.5, 1.0) when enabled", () => {
		const jittered = { ...opts, jitter: true };
		for (let i = 0; i < 20; i++) {
			const d = computeDelay(2, jittered);
			expect(d).toBeGreaterThanOrEqual(400 * 0.5);
			expect(d).toBeLessThan(400 * 1.0);
		}
	});
});
