import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DaemonTask, startScheduler } from "./TaskScheduler.js";

/** Lets the microtask queue drain so an awaited `run()` settles. */
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("startScheduler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("ticks each task once immediately, so downtime catch-up needs no code", async () => {
		const run = vi.fn(async () => "did the thing");
		const task: DaemonTask = { name: "backup", tickIntervalMs: 60_000, run };

		const handle = startScheduler([task]);
		await flush();

		expect(run).toHaveBeenCalledTimes(1);
		handle.stop();
	});

	it("ticks again once the interval elapses", async () => {
		const run = vi.fn(async () => "ok");
		const handle = startScheduler([{ name: "backup", tickIntervalMs: 60_000, run }]);
		await flush();

		await vi.advanceTimersByTimeAsync(60_000);

		expect(run).toHaveBeenCalledTimes(2);
		handle.stop();
	});

	it("keeps ticking after a task throws", async () => {
		const run = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error("backup drive unplugged"))
			.mockResolvedValue("ok");
		const onTaskError = vi.fn();
		const handle = startScheduler([{ name: "backup", tickIntervalMs: 60_000, run }], { onTaskError });
		await flush();

		expect(onTaskError).toHaveBeenCalledWith("backup", expect.any(Error));

		await vi.advanceTimersByTimeAsync(60_000);
		expect(run).toHaveBeenCalledTimes(2);
		handle.stop();
	});

	it("does not overlap a task with itself when a run outlives its interval", async () => {
		let release: (() => void) | undefined;
		const run = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = () => resolve("slow");
				}),
		);
		const handle = startScheduler([{ name: "backup", tickIntervalMs: 1_000, run }]);
		await flush();
		expect(run).toHaveBeenCalledTimes(1);

		// Three intervals pass while the first run is still in flight.
		await vi.advanceTimersByTimeAsync(3_000);
		expect(run).toHaveBeenCalledTimes(1);

		release?.();
		await flush();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(run).toHaveBeenCalledTimes(2);
		handle.stop();
	});

	it("stops ticking after stop()", async () => {
		const run = vi.fn(async () => "ok");
		const handle = startScheduler([{ name: "backup", tickIntervalMs: 60_000, run }]);
		await flush();
		handle.stop();

		await vi.advanceTimersByTimeAsync(180_000);

		expect(run).toHaveBeenCalledTimes(1);
	});

	it("reports each task's result string for logging", async () => {
		const onTaskResult = vi.fn();
		const handle = startScheduler([{ name: "backup", tickIntervalMs: 60_000, run: async () => "created" }], {
			onTaskResult,
		});
		await flush();

		expect(onTaskResult).toHaveBeenCalledWith("backup", "created");
		handle.stop();
	});

	it("runs independent tasks on their own intervals", async () => {
		const fast = vi.fn(async () => "fast");
		const slow = vi.fn(async () => "slow");
		const handle = startScheduler([
			{ name: "fast", tickIntervalMs: 1_000, run: fast },
			{ name: "slow", tickIntervalMs: 10_000, run: slow },
		]);
		await flush();

		await vi.advanceTimersByTimeAsync(1_000);

		expect(fast).toHaveBeenCalledTimes(2);
		expect(slow).toHaveBeenCalledTimes(1);
		handle.stop();
	});
});
