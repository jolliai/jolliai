import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus } from "../Types.js";

const { createFileSystemWatcher, watchers, RelativePattern } = vi.hoisted(
	() => {
		const watchers: Array<{
			onDidChange: (cb: (uri: { fsPath: string }) => void) => void;
			onDidCreate: (cb: (uri: { fsPath: string }) => void) => void;
			onDidDelete: (cb: (uri: { fsPath: string }) => void) => void;
			fireChange: (uri: { fsPath: string }) => void;
			fireCreate: (uri: { fsPath: string }) => void;
			fireDelete: (uri: { fsPath: string }) => void;
			dispose: ReturnType<typeof vi.fn>;
		}> = [];

		const createFileSystemWatcher = vi.fn(() => {
			const handlers: {
				change?: (uri: { fsPath: string }) => void;
				create?: (uri: { fsPath: string }) => void;
				delete?: (uri: { fsPath: string }) => void;
			} = {};
			const watcher = {
				onDidChange: (cb: (uri: { fsPath: string }) => void) => {
					handlers.change = cb;
				},
				onDidCreate: (cb: (uri: { fsPath: string }) => void) => {
					handlers.create = cb;
				},
				onDidDelete: (cb: (uri: { fsPath: string }) => void) => {
					handlers.delete = cb;
				},
				fireChange: (uri: { fsPath: string }) => handlers.change?.(uri),
				fireCreate: (uri: { fsPath: string }) => handlers.create?.(uri),
				fireDelete: (uri: { fsPath: string }) => handlers.delete?.(uri),
				dispose: vi.fn(),
			};
			watchers.push(watcher);
			return watcher;
		});

		class RelativePattern {
			constructor(
				readonly base: string,
				readonly pattern: string,
			) {}
		}

		return { createFileSystemWatcher, watchers, RelativePattern };
	},
);

vi.mock("vscode", () => ({
	workspace: { createFileSystemWatcher },
	RelativePattern,
}));

import { ExcludeFilterManager } from "../util/ExcludeFilterManager.js";
import { FilesStore } from "./FilesStore.js";

function makeFile(
	relativePath: string,
	isSelected = false,
	statusCode = "M",
): FileStatus {
	return {
		absolutePath: `/repo/${relativePath}`,
		relativePath,
		statusCode,
		indexStatus: statusCode === "?" ? "?" : statusCode,
		worktreeStatus: statusCode === "?" ? "?" : " ",
		isSelected,
	};
}

function makeBridge(files: Array<FileStatus>) {
	return {
		listFiles: vi.fn(async () => files),
	};
}

function makeFilter(patterns: Array<string> = []): ExcludeFilterManager {
	const filter = new ExcludeFilterManager();
	const field = (filter as unknown as { patterns: Array<string> }).patterns;
	field.length = 0;
	field.push(...patterns);
	return filter;
}

beforeEach(() => {
	watchers.length = 0;
	createFileSystemWatcher.mockClear();
});

describe("FilesStore — snapshot shape", () => {
	it("starts with an empty snapshot and init reason", () => {
		const store = new FilesStore(
			makeBridge([]) as never,
			"/repo",
			makeFilter(),
		);
		const snap = store.getSnapshot();
		expect(snap.files).toEqual([]);
		expect(snap.isEmpty).toBe(true);
		expect(snap.isEnabled).toBe(true);
		expect(snap.isMigrating).toBe(false);
		expect(snap.changeReason).toBe("init");
	});

	it("refresh populates snapshot with refresh reason", async () => {
		const bridge = makeBridge([makeFile("a.ts")]);
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		await store.refresh();
		expect(store.getSnapshot().files).toHaveLength(1);
		expect(store.getSnapshot().changeReason).toBe("refresh");
	});
});

describe("FilesStore — watcher registration", () => {
	it("creates two FileSystemWatchers in its constructor", () => {
		new FilesStore(makeBridge([]) as never, "/repo", makeFilter());
		expect(createFileSystemWatcher).toHaveBeenCalledTimes(2);
	});

	it("disposes its watchers on dispose()", () => {
		const store = new FilesStore(
			makeBridge([]) as never,
			"/repo",
			makeFilter(),
		);
		store.dispose();
		expect(watchers[0].dispose).toHaveBeenCalled();
		expect(watchers[1].dispose).toHaveBeenCalled();
	});

	it("workspace watcher ignores .git/ paths", () => {
		vi.useFakeTimers();
		const bridge = makeBridge([makeFile("a.ts")]);
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		const refreshSpy = vi.spyOn(store, "refresh").mockResolvedValue();

		watchers[1].fireChange({ fsPath: "/repo/.git/HEAD" });
		vi.advanceTimersByTime(500);
		expect(refreshSpy).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("workspace watcher triggers refresh after debounce window", () => {
		vi.useFakeTimers();
		const bridge = makeBridge([makeFile("a.ts")]);
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		const refreshSpy = vi.spyOn(store, "refresh").mockResolvedValue();

		watchers[1].fireChange({ fsPath: "/repo/src/a.ts" });
		vi.advanceTimersByTime(399);
		expect(refreshSpy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});

describe("FilesStore — mutations", () => {
	it("applyCheckboxBatch updates selection with userCheckbox reason", async () => {
		const bridge = makeBridge([makeFile("a.ts"), makeFile("b.ts")]);
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		await store.refresh();

		const listener = vi.fn();
		store.onChange(listener);
		store.applyCheckboxBatch([
			["a.ts", true],
			["b.ts", true],
		]);

		expect(listener).toHaveBeenCalledTimes(1);
		const snap = store.getSnapshot();
		expect(snap.changeReason).toBe("userCheckbox");
		expect(snap.selectedFiles.map((f) => f.relativePath)).toEqual([
			"a.ts",
			"b.ts",
		]);
	});

	it("toggleSelectAll selects all then deselects all with selectAll reason", async () => {
		const bridge = makeBridge([makeFile("a.ts"), makeFile("b.ts")]);
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		await store.refresh();

		store.toggleSelectAll();
		let snap = store.getSnapshot();
		expect(snap.changeReason).toBe("selectAll");
		expect(snap.selectedFiles).toHaveLength(2);

		store.toggleSelectAll();
		snap = store.getSnapshot();
		expect(snap.selectedFiles).toHaveLength(0);
	});

	it("applyExcludeFilterChange recomputes visibility without re-querying bridge", async () => {
		const filter = makeFilter();
		const bridge = makeBridge([makeFile("a.ts"), makeFile("b.log")]);
		const store = new FilesStore(bridge as never, "/repo", filter);
		await store.refresh();
		expect(bridge.listFiles).toHaveBeenCalledTimes(1);

		// Simulate settings adding an exclude pattern
		const field = (filter as unknown as { patterns: Array<string> }).patterns;
		field.push("*.log");

		store.applyExcludeFilterChange();
		expect(bridge.listFiles).toHaveBeenCalledTimes(1); // NOT re-queried
		expect(store.getSnapshot().visibleFiles.map((f) => f.relativePath)).toEqual(
			["a.ts"],
		);
		expect(store.getSnapshot().changeReason).toBe("excludeFilter");
	});

	it("applyExcludeFilterChange deselects newly excluded files", async () => {
		const filter = makeFilter();
		const bridge = makeBridge([makeFile("a.ts"), makeFile("b.log")]);
		const store = new FilesStore(bridge as never, "/repo", filter);
		await store.refresh();
		store.applyCheckboxBatch([
			["a.ts", true],
			["b.log", true],
		]);
		expect(store.getSnapshot().selectedFiles).toHaveLength(2);

		const field = (filter as unknown as { patterns: Array<string> }).patterns;
		field.push("*.log");
		store.applyExcludeFilterChange();

		// b.log is now excluded → selectedFiles should only contain a.ts
		expect(
			store.getSnapshot().selectedFiles.map((f) => f.relativePath),
		).toEqual(["a.ts"]);
	});

	it("deselectPaths is a no-op if nothing changes", async () => {
		const bridge = makeBridge([makeFile("a.ts")]);
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		await store.refresh();

		const listener = vi.fn();
		store.onChange(listener);
		store.deselectPaths(["nonexistent.ts"]);
		expect(listener).not.toHaveBeenCalled();
	});

	it("deselectPaths emits deselect reason when selection changes", async () => {
		const bridge = makeBridge([makeFile("a.ts")]);
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		await store.refresh();
		store.applyCheckboxBatch([["a.ts", true]]);

		const listener = vi.fn();
		store.onChange(listener);
		store.deselectPaths(["a.ts"]);
		expect(listener).toHaveBeenCalled();
		expect(store.getSnapshot().changeReason).toBe("deselect");
		expect(store.getSnapshot().selectedFiles).toHaveLength(0);
	});

	it("setMigrating is idempotent when value unchanged", () => {
		const store = new FilesStore(
			makeBridge([]) as never,
			"/repo",
			makeFilter(),
		);
		const listener = vi.fn();
		store.onChange(listener);
		store.setMigrating(false); // already false
		expect(listener).not.toHaveBeenCalled();
	});

	it("setMigrating broadcasts migrating reason on transition", () => {
		const store = new FilesStore(
			makeBridge([]) as never,
			"/repo",
			makeFilter(),
		);
		const listener = vi.fn();
		store.onChange(listener);
		store.setMigrating(true);
		expect(listener).toHaveBeenCalled();
		expect(store.getSnapshot().isMigrating).toBe(true);
		expect(store.getSnapshot().changeReason).toBe("migrating");
	});

	it("setEnabled broadcasts enabled reason on transition", () => {
		const store = new FilesStore(
			makeBridge([]) as never,
			"/repo",
			makeFilter(),
		);
		const listener = vi.fn();
		store.onChange(listener);
		store.setEnabled(false);
		expect(listener).toHaveBeenCalled();
		expect(store.getSnapshot().isEnabled).toBe(false);
		expect(store.getSnapshot().changeReason).toBe("enabled");
	});

	it("setEnabled(false) clears cached data so badge/description cannot stick", async () => {
		const filter = makeFilter();
		const bridge = makeBridge([makeFile("a.ts"), makeFile("ignore.log")]);
		const store = new FilesStore(bridge as never, "/repo", filter);
		await store.refresh();
		store.applyCheckboxBatch([["a.ts", true]]);
		expect(store.getSnapshot().visibleCount).toBeGreaterThan(0);
		expect(store.getSnapshot().selectedFiles.length).toBe(1);

		store.setEnabled(false);

		const snap = store.getSnapshot();
		expect(snap.files).toEqual([]);
		expect(snap.visibleFiles).toEqual([]);
		expect(snap.selectedFiles).toEqual([]);
		expect(snap.visibleCount).toBe(0);
		expect(snap.excludedCount).toBe(0);
		expect(snap.isEnabled).toBe(false);
	});
});

describe("FilesStore — misc coverage", () => {
	it("getSelectedPaths exposes the in-memory set", async () => {
		const bridge = makeBridge([makeFile("a.ts"), makeFile("b.ts")]);
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		await store.refresh();
		store.applyCheckboxBatch([["a.ts", true]]);
		expect([...store.getSelectedPaths()]).toEqual(["a.ts"]);
	});

	it("applyCheckboxBatch is a no-op for an empty batch", async () => {
		const bridge = makeBridge([makeFile("a.ts")]);
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		await store.refresh();
		const listener = vi.fn();
		store.onChange(listener);
		store.applyCheckboxBatch([]);
		expect(listener).not.toHaveBeenCalled();
	});

	it("dispose clears an in-flight debounce timer", () => {
		vi.useFakeTimers();
		const bridge = makeBridge([makeFile("a.ts")]);
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		const refreshSpy = vi.spyOn(store, "refresh").mockResolvedValue();

		watchers[0].fireChange({ fsPath: "/repo/.git/index" });
		store.dispose();
		vi.advanceTimersByTime(1000);
		expect(refreshSpy).not.toHaveBeenCalled();
		vi.useRealTimers();
	});
});

describe("FilesStore — concurrency", () => {
	it("discards stale refresh results when a newer refresh runs first", async () => {
		let resolveFirst: ((files: Array<FileStatus>) => void) | undefined;
		let resolveSecond: ((files: Array<FileStatus>) => void) | undefined;
		const bridge = {
			listFiles: vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise<Array<FileStatus>>((resolve) => {
							resolveFirst = resolve;
						}),
				)
				.mockImplementationOnce(
					() =>
						new Promise<Array<FileStatus>>((resolve) => {
							resolveSecond = resolve;
						}),
				),
		};
		const store = new FilesStore(bridge as never, "/repo", makeFilter());

		const first = store.refresh();
		const second = store.refresh();

		resolveFirst?.([makeFile("stale.ts")]);
		await first;
		expect(store.getSnapshot().files).toEqual([]); // stale result discarded

		resolveSecond?.([makeFile("fresh.ts")]);
		await second;
		expect(store.getSnapshot().files.map((f) => f.relativePath)).toEqual([
			"fresh.ts",
		]);
	});

	it("refresh prunes selections for files that vanished", async () => {
		const bridge = {
			listFiles: vi
				.fn()
				.mockResolvedValueOnce([makeFile("a.ts"), makeFile("b.ts")])
				.mockResolvedValueOnce([makeFile("a.ts")]),
		};
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		await store.refresh();
		store.applyCheckboxBatch([
			["a.ts", true],
			["b.ts", true],
		]);
		expect(store.getSnapshot().selectedFiles).toHaveLength(2);

		await store.refresh();
		expect(
			store.getSnapshot().selectedFiles.map((f) => f.relativePath),
		).toEqual(["a.ts"]);
	});

	it("seeds selection from any `isSelected: true` entries returned by the bridge", async () => {
		const bridge = makeBridge([makeFile("a.ts", true)]);
		const store = new FilesStore(bridge as never, "/repo", makeFilter());
		await store.refresh();
		expect(
			store.getSnapshot().selectedFiles.map((f) => f.relativePath),
		).toEqual(["a.ts"]);
	});
});
