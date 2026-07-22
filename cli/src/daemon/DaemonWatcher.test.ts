import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonWatcher } from "./DaemonWatcher.js";

const DEBOUNCE_MS = 40;

describe("DaemonWatcher", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "daemon-watcher-"));
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	it("returns false and never fires when the target does not exist", () => {
		const trigger = vi.fn();
		const watcher = new DaemonWatcher({
			path: join(root, "missing"),
			debounceMs: DEBOUNCE_MS,
			onTrigger: trigger,
		});

		expect(watcher.start()).toBe(false);
		expect(trigger).not.toHaveBeenCalled();
		watcher.stop();
	});

	it("auto-creates the directory when ensureDir is true", () => {
		const target = join(root, "queue");
		const trigger = vi.fn();
		const watcher = new DaemonWatcher({
			path: target,
			debounceMs: DEBOUNCE_MS,
			onTrigger: trigger,
			ensureDir: true,
		});

		expect(watcher.start()).toBe(true);
		expect(existsSync(target)).toBe(true);
		watcher.stop();
	});

	it("coalesces a burst of events into one trigger after the debounce window", async () => {
		const target = join(root, "queue");
		mkdirSync(target);
		const trigger = vi.fn();
		const watcher = new DaemonWatcher({
			path: target,
			debounceMs: DEBOUNCE_MS,
			onTrigger: trigger,
		});
		expect(watcher.start()).toBe(true);

		writeFileSync(join(target, "a"), "x");
		writeFileSync(join(target, "b"), "y");
		writeFileSync(join(target, "c"), "z");
		await vi.waitFor(() => {
			// Give the platform's fs.watch a chance to enqueue events before we
			// advance timers — otherwise the first schedule() has not run yet.
			vi.advanceTimersByTime(DEBOUNCE_MS + 10);
			expect(trigger).toHaveBeenCalled();
		});
		expect(trigger).toHaveBeenCalledTimes(1);
		watcher.stop();
	});

	it("stops cleanly with no pending timers", () => {
		const target = join(root, "queue");
		mkdirSync(target);
		const trigger = vi.fn();
		const watcher = new DaemonWatcher({
			path: target,
			debounceMs: DEBOUNCE_MS,
			onTrigger: trigger,
		});
		expect(watcher.start()).toBe(true);

		writeFileSync(join(target, "a"), "x");
		watcher.stop();
		vi.advanceTimersByTime(DEBOUNCE_MS * 5);

		expect(trigger).not.toHaveBeenCalled();
	});
});
