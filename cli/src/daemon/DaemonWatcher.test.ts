import type { FSWatcher } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonWatcher } from "./DaemonWatcher.js";

// Chosen well above macOS FSEvents' ~100ms coalescing window so that a burst
// of writeFileSync calls in the coalescing test reliably lands in a single
// debounce, without dragging out the "no pending timer after stop()" test.
const DEBOUNCE_MS = 200;

describe("DaemonWatcher", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "daemon-watcher-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns false and never fires when the target does not exist", async () => {
		const trigger = vi.fn();
		const watcher = new DaemonWatcher({
			path: join(root, "missing"),
			debounceMs: DEBOUNCE_MS,
			onTrigger: trigger,
		});

		expect(watcher.start()).toBe(false);
		await sleep(DEBOUNCE_MS * 2);
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

		// fs.watch setup is asynchronous under the hood (FSEvents registers a
		// stream, inotify installs a watch, ReadDirectoryChangesW arms an APC)
		// and returning from `start()` does NOT guarantee the underlying watch
		// is armed — under high concurrency (full vitest fork fleet) the first
		// writeFileSync can land BEFORE FSEvents starts delivering events,
		// silently dropping the whole burst. A short warm-up sleep lets the
		// platform layer finish registration before we start the test workload.
		await sleep(100);

		writeFileSync(join(target, "a"), "x");
		writeFileSync(join(target, "b"), "y");
		writeFileSync(join(target, "c"), "z");
		// fs.watch is real async I/O (FSEvents / inotify / ReadDirectoryChangesW)
		// and can lag under load — poll for the trigger with a generous timeout
		// rather than mixing fake timers with real I/O. 10 s > any reasonable
		// event-delivery latency on a saturated CI runner without dragging the
		// suite when the trigger fires within its usual ~50 ms.
		await vi.waitFor(() => expect(trigger).toHaveBeenCalled(), {
			timeout: 10_000,
			interval: 20,
		});
		// Wait past another debounce window to confirm the burst coalesced into
		// a single trigger rather than one call per fs.watch event.
		await sleep(DEBOUNCE_MS * 3);
		expect(trigger).toHaveBeenCalledTimes(1);
		watcher.stop();
	});

	it("stops cleanly with no pending timers", async () => {
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
		await sleep(DEBOUNCE_MS * 5);

		expect(trigger).not.toHaveBeenCalled();
	});

	it("start() is idempotent — a second call keeps the same FSWatcher and returns true", () => {
		const target = join(root, "queue");
		mkdirSync(target);
		const trigger = vi.fn();
		const watcher = new DaemonWatcher({
			path: target,
			debounceMs: DEBOUNCE_MS,
			onTrigger: trigger,
		});

		expect(watcher.start()).toBe(true);
		const inner = (watcher as unknown as { watcher: FSWatcher }).watcher;
		expect(inner).not.toBeNull();
		expect(watcher.start()).toBe(true);
		expect((watcher as unknown as { watcher: FSWatcher }).watcher).toBe(inner);
		watcher.stop();
	});

	it("tears the watcher down when its underlying 'error' event fires", () => {
		const target = join(root, "queue");
		mkdirSync(target);
		const trigger = vi.fn();
		const watcher = new DaemonWatcher({
			path: target,
			debounceMs: DEBOUNCE_MS,
			onTrigger: trigger,
		});

		expect(watcher.start()).toBe(true);
		const inner = (watcher as unknown as { watcher: FSWatcher }).watcher;
		expect(inner).not.toBeNull();
		inner.emit("error", new Error("simulated fs.watch failure"));
		expect((watcher as unknown as { watcher: FSWatcher | null }).watcher).toBeNull();
	});

	it("stop() clears a pending debounce timer that never fires afterwards", async () => {
		const target = join(root, "queue");
		mkdirSync(target);
		const trigger = vi.fn();
		const watcher = new DaemonWatcher({
			path: target,
			debounceMs: DEBOUNCE_MS,
			onTrigger: trigger,
		});

		expect(watcher.start()).toBe(true);
		const inner = (watcher as unknown as { watcher: FSWatcher }).watcher;
		// Emitting 'change' directly on the FSWatcher invokes the listener attached
		// by `fs.watch()`, so schedule() runs and arms the debounce timer without
		// depending on platform event delivery.
		inner.emit("change", "change", "a");
		expect((watcher as unknown as { timer: unknown }).timer).not.toBeNull();

		watcher.stop();
		expect((watcher as unknown as { timer: unknown }).timer).toBeNull();

		await sleep(DEBOUNCE_MS * 3);
		expect(trigger).not.toHaveBeenCalled();
	});
});
