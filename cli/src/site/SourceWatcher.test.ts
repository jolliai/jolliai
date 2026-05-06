/**
 * Tests for SourceWatcher.
 *
 * The watcher is exercised against a stub `WatchFactory` that returns a
 * thin `FSWatcher`-shaped EventEmitter — no real filesystem is touched.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSourceWatcher, type WatchFactory } from "./SourceWatcher.js";

// ─── Stub factory ──────────────────────────────────────────────────────────

interface StubWatcher extends EventEmitter {
	close(): Promise<void>;
	closeMock: ReturnType<typeof vi.fn>;
	options?: { ignoreInitial: boolean; ignored: string[] };
	path?: string;
}

function makeStubFactory(): { factory: WatchFactory; getWatcher: () => StubWatcher } {
	let captured: StubWatcher | null = null;

	const factory: WatchFactory = (path, options) => {
		const emitter = new EventEmitter() as StubWatcher;
		emitter.path = path;
		emitter.options = options;
		const closeMock = vi.fn().mockResolvedValue(undefined);
		emitter.closeMock = closeMock;
		emitter.close = closeMock;
		captured = emitter;
		// Return as the chokidar FSWatcher type — the watcher only uses
		// `on(name, cb)` and `close()`, both of which the stub provides.
		// biome-ignore lint/suspicious/noExplicitAny: stub typed dynamically for the test surface
		return emitter as any;
	};

	return {
		factory,
		getWatcher: () => {
			if (!captured) {
				throw new Error("watcher was never created");
			}
			return captured;
		},
	};
}

/** Yields control to the microtask queue once. */
function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("startSourceWatcher", () => {
	beforeEach(() => {
		// Only fake setTimeout / clearTimeout — leave setImmediate alone so
		// our `tick()` microtask flush actually resolves.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("passes ignoreInitial=true and the built-in ignore globs to chokidar", () => {
		const { factory, getWatcher } = makeStubFactory();
		const onChange = vi.fn().mockResolvedValue(undefined);
		const watcher = startSourceWatcher("/src", { onChange, watchFactory: factory });
		const stub = getWatcher();

		expect(stub.path).toBe("/src");
		expect(stub.options?.ignoreInitial).toBe(true);
		expect(stub.options?.ignored).toContain("**/.git/**");
		expect(stub.options?.ignored).toContain("**/node_modules/**");
		expect(stub.options?.ignored).toContain("**/.jolli-site/**");
		expect(stub.options?.ignored).toContain("**/.next/**");

		void watcher.close();
	});

	it("appends user-supplied ignore patterns after the built-ins", () => {
		const { factory, getWatcher } = makeStubFactory();
		const onChange = vi.fn().mockResolvedValue(undefined);
		startSourceWatcher("/src", {
			onChange,
			watchFactory: factory,
			ignored: ["**/secret/**"],
		});
		expect(getWatcher().options?.ignored).toContain("**/secret/**");
	});

	it("debounces a burst of events into a single onChange call", async () => {
		const { factory, getWatcher } = makeStubFactory();
		const onChange = vi.fn().mockResolvedValue(undefined);
		startSourceWatcher("/src", { onChange, debounceMs: 50, watchFactory: factory });
		const stub = getWatcher();

		stub.emit("change", "/src/a.md");
		stub.emit("change", "/src/b.md");
		stub.emit("add", "/src/c.md");

		expect(onChange).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(50);
		await tick();

		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("listens for add / change / unlink events", async () => {
		const { factory, getWatcher } = makeStubFactory();
		const onChange = vi.fn().mockResolvedValue(undefined);
		startSourceWatcher("/src", { onChange, debounceMs: 10, watchFactory: factory });
		const stub = getWatcher();

		stub.emit("unlink", "/src/old.md");
		await vi.advanceTimersByTimeAsync(10);
		await tick();

		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("coalesces events that arrive while onChange is in flight into a single follow-up sync", async () => {
		const { factory, getWatcher } = makeStubFactory();
		let resolveFirst: () => void = () => {};
		const onChange = vi.fn();
		onChange.mockImplementationOnce(
			() =>
				new Promise<void>((r) => {
					resolveFirst = r;
				}),
		);
		onChange.mockImplementation(() => Promise.resolve());
		startSourceWatcher("/src", { onChange, debounceMs: 10, watchFactory: factory });
		const stub = getWatcher();

		stub.emit("change", "/src/a.md");
		await vi.advanceTimersByTimeAsync(10);
		await tick();

		// First onChange is in flight (still pending). Fire two more events;
		// they should coalesce into a single follow-up sync once the first
		// one resolves.
		stub.emit("change", "/src/b.md");
		stub.emit("change", "/src/c.md");
		await vi.advanceTimersByTimeAsync(10);
		await tick();

		// Still only one onChange running.
		expect(onChange).toHaveBeenCalledTimes(1);

		resolveFirst();
		await tick();
		await tick();

		expect(onChange).toHaveBeenCalledTimes(2);
	});

	it("logs and continues when onChange throws", async () => {
		const { factory, getWatcher } = makeStubFactory();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const onChange = vi.fn().mockRejectedValueOnce(new Error("kaboom")).mockResolvedValueOnce(undefined);

		startSourceWatcher("/src", { onChange, debounceMs: 10, watchFactory: factory });
		const stub = getWatcher();

		stub.emit("change", "/src/a.md");
		await vi.advanceTimersByTimeAsync(10);
		await tick();
		await tick();

		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("kaboom"));

		// A subsequent sync still runs — the watcher didn't unwind.
		stub.emit("change", "/src/b.md");
		await vi.advanceTimersByTimeAsync(10);
		await tick();
		await tick();

		expect(onChange).toHaveBeenCalledTimes(2);
		errorSpy.mockRestore();
	});

	it("formats non-Error throw values via String() in the log line", async () => {
		const { factory, getWatcher } = makeStubFactory();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const onChange = vi.fn().mockRejectedValueOnce("string-error").mockResolvedValue(undefined);

		startSourceWatcher("/src", { onChange, debounceMs: 10, watchFactory: factory });
		const stub = getWatcher();

		stub.emit("change", "/src/a.md");
		await vi.advanceTimersByTimeAsync(10);
		await tick();
		await tick();

		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("string-error"));
		errorSpy.mockRestore();
	});

	it("close() awaits in-flight sync and shuts down chokidar", async () => {
		const { factory, getWatcher } = makeStubFactory();
		let resolveSync: () => void = () => {};
		const onChange = vi.fn().mockImplementation(
			() =>
				new Promise<void>((r) => {
					resolveSync = r;
				}),
		);

		const watcher = startSourceWatcher("/src", { onChange, debounceMs: 10, watchFactory: factory });
		const stub = getWatcher();

		stub.emit("change", "/src/a.md");
		await vi.advanceTimersByTimeAsync(10);
		await tick();

		// onChange is in flight; trigger close() — it should NOT resolve until
		// the in-flight sync settles.
		const closePromise = watcher.close();
		let closed = false;
		void closePromise.then(() => {
			closed = true;
		});
		await tick();
		expect(closed).toBe(false);

		resolveSync();
		await closePromise;

		expect(stub.closeMock).toHaveBeenCalled();
	});

	it("close() also clears a pending debounce timer so no late sync fires", async () => {
		const { factory, getWatcher } = makeStubFactory();
		const onChange = vi.fn().mockResolvedValue(undefined);
		const watcher = startSourceWatcher("/src", { onChange, debounceMs: 50, watchFactory: factory });
		const stub = getWatcher();

		stub.emit("change", "/src/a.md");
		// Don't advance the timer — close() should clear it.
		await watcher.close();
		await vi.advanceTimersByTimeAsync(100);
		await tick();

		expect(onChange).not.toHaveBeenCalled();
		expect(stub.closeMock).toHaveBeenCalled();
	});

	it("ignores events that fire after close()", async () => {
		const { factory, getWatcher } = makeStubFactory();
		const onChange = vi.fn().mockResolvedValue(undefined);
		const watcher = startSourceWatcher("/src", { onChange, debounceMs: 10, watchFactory: factory });
		const stub = getWatcher();

		await watcher.close();

		// Even if some belated emitter fires, no sync runs.
		stub.emit("change", "/src/a.md");
		await vi.advanceTimersByTimeAsync(50);
		await tick();

		expect(onChange).not.toHaveBeenCalled();
	});
});
