import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVER_FLUSH_MS, startServerTelemetry } from "./ServerTelemetry.js";

describe("startServerTelemetry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("bootstraps telemetry once with the given cwd", async () => {
		const bootstrap = vi.fn(async () => {});
		const flush = vi.fn(async () => {});
		await startServerTelemetry({ cwd: "/work", bootstrap, flush });
		expect(bootstrap).toHaveBeenCalledTimes(1);
		expect(bootstrap).toHaveBeenCalledWith("/work");
	});

	it("flushes on the configured interval", async () => {
		const bootstrap = vi.fn(async () => {});
		const flush = vi.fn(async () => {});
		await startServerTelemetry({ cwd: "/work", bootstrap, flush, flushIntervalMs: 1000 });
		expect(flush).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(flush).toHaveBeenCalledWith("/work");
		await vi.advanceTimersByTimeAsync(1000);
		expect(flush).toHaveBeenCalledTimes(2);
	});

	it("stop() clears the timer and does one final flush, and is idempotent", async () => {
		const bootstrap = vi.fn(async () => {});
		const flush = vi.fn(async () => {});
		const { stop } = await startServerTelemetry({ cwd: "/work", bootstrap, flush, flushIntervalMs: 1000 });
		await stop();
		expect(flush).toHaveBeenCalledTimes(1); // the final flush
		// Timer was cleared — no further periodic flushes.
		await vi.advanceTimersByTimeAsync(5000);
		expect(flush).toHaveBeenCalledTimes(1);
		// Idempotent: a second stop() does nothing.
		await stop();
		expect(flush).toHaveBeenCalledTimes(1);
	});

	it("swallows a bootstrap failure and still arms the flush loop", async () => {
		const bootstrap = vi.fn(async () => {
			throw new Error("boom");
		});
		const flush = vi.fn(async () => {});
		const handle = await startServerTelemetry({ cwd: "/work", bootstrap, flush, flushIntervalMs: 1000 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(flush).toHaveBeenCalledWith("/work");
		await handle.stop();
	});

	it("swallows a periodic flush rejection without unhandled rejection", async () => {
		const bootstrap = vi.fn(async () => {});
		const flush = vi.fn(async () => {
			throw new Error("network down");
		});
		const { stop } = await startServerTelemetry({ cwd: "/work", bootstrap, flush, flushIntervalMs: 1000 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(flush).toHaveBeenCalled();
		// stop()'s final flush also rejects — must not throw.
		await expect(stop()).resolves.toBeUndefined();
	});

	it("exposes a sane default flush cadence", () => {
		expect(DEFAULT_SERVER_FLUSH_MS).toBeGreaterThanOrEqual(10_000);
	});
});
