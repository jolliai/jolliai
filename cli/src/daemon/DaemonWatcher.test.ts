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

	// These drive the FSWatcher's listener directly instead of waiting on the
	// platform to deliver a real event, so nothing here touches async I/O and
	// fake timers are safe (the tests above deliberately keep real ones —
	// they DO depend on FSEvents/inotify delivery).
	describe("burst payload and filename gate", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("hands onTrigger the distinct filenames seen during the burst", () => {
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
			// Emitting on the FSWatcher directly drives the listener `fs.watch()`
			// installed, so the accumulate/reset logic is exercised without waiting
			// on platform event delivery.
			inner.emit("change", "rename", "a.md");
			inner.emit("change", "change", "a.md");
			inner.emit("change", "rename", "b.md");
			vi.advanceTimersByTime(DEBOUNCE_MS);

			expect(trigger).toHaveBeenCalledTimes(1);
			expect([...(trigger.mock.calls[0][0] as ReadonlySet<string>)].sort()).toEqual(["a.md", "b.md"]);

			// The next burst starts from empty rather than accumulating forever.
			inner.emit("change", "rename", "c.md");
			vi.advanceTimersByTime(DEBOUNCE_MS);
			expect([...(trigger.mock.calls[1][0] as ReadonlySet<string>)]).toEqual(["c.md"]);
			watcher.stop();
		});

		it("passes an empty set when the platform reports no filename", () => {
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
			inner.emit("change", "rename", null);
			vi.advanceTimersByTime(DEBOUNCE_MS);

			// Still fires — an ungated watcher must not go silent just because the
			// platform withheld the name.
			expect(trigger).toHaveBeenCalledTimes(1);
			expect((trigger.mock.calls[0][0] as ReadonlySet<string>).size).toBe(0);
			watcher.stop();
		});

		it("decodes a Buffer filename", () => {
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
			inner.emit("change", "rename", Buffer.from("plan.md", "utf-8"));
			vi.advanceTimersByTime(DEBOUNCE_MS);

			expect([...(trigger.mock.calls[0][0] as ReadonlySet<string>)]).toEqual(["plan.md"]);
			watcher.stop();
		});

		describe("filter", () => {
			const armFiltered = (
				target: string,
				trigger: (names: ReadonlySet<string>) => void,
			): { watcher: DaemonWatcher; inner: FSWatcher } => {
				const watcher = new DaemonWatcher({
					path: target,
					debounceMs: DEBOUNCE_MS,
					onTrigger: trigger,
					filter: (name) => name === "plans.json",
				});
				expect(watcher.start()).toBe(true);
				return { watcher, inner: (watcher as unknown as { watcher: FSWatcher }).watcher };
			};

			it("never arms the timer for a burst in which every event was filtered out", () => {
				const target = join(root, "state");
				mkdirSync(target);
				const trigger = vi.fn();
				const { watcher, inner } = armFiltered(target, trigger);

				inner.emit("change", "change", "debug.log");
				inner.emit("change", "change", "sessions.json");
				// No pending timer at all — a noisy neighbour must not even schedule
				// work, let alone fire.
				expect((watcher as unknown as { timer: unknown }).timer).toBeNull();
				vi.advanceTimersByTime(DEBOUNCE_MS * 3);
				expect(trigger).not.toHaveBeenCalled();
				watcher.stop();
			});

			it("fires with only the passing name when a burst mixes gated and ungated events", () => {
				const target = join(root, "state");
				mkdirSync(target);
				const trigger = vi.fn();
				const { watcher, inner } = armFiltered(target, trigger);

				inner.emit("change", "change", "debug.log");
				inner.emit("change", "change", "plans.json");
				inner.emit("change", "change", "cursors.json");
				vi.advanceTimersByTime(DEBOUNCE_MS);

				expect(trigger).toHaveBeenCalledTimes(1);
				expect([...(trigger.mock.calls[0][0] as ReadonlySet<string>)]).toEqual(["plans.json"]);
				watcher.stop();
			});

			it("drops a nameless event rather than firing blind", () => {
				const target = join(root, "state");
				mkdirSync(target);
				const trigger = vi.fn();
				const { watcher, inner } = armFiltered(target, trigger);

				// A gate cannot be honoured without a name, and this watcher only
				// exists on directories whose other writers are noisy — so silence is
				// the safer half of the trade.
				inner.emit("change", "rename", null);
				vi.advanceTimersByTime(DEBOUNCE_MS * 3);
				expect(trigger).not.toHaveBeenCalled();
				watcher.stop();
			});
		});
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
