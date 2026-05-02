import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus } from "../Types.js";

const {
	watchers,
	showErrorMessage,
	createFileSystemWatcher,
	RelativePattern,
	Uri,
	TreeItem,
	ThemeIcon,
	EventEmitter,
} = vi.hoisted(() => {
	const watchers: Array<{
		onDidChange: (callback: (uri: { fsPath: string }) => void) => void;
		onDidCreate: (callback: (uri: { fsPath: string }) => void) => void;
		onDidDelete: (callback: (uri: { fsPath: string }) => void) => void;
		fireChange: (uri: { fsPath: string }) => void;
		fireCreate: (uri: { fsPath: string }) => void;
		fireDelete: (uri: { fsPath: string }) => void;
		dispose: ReturnType<typeof vi.fn>;
	}> = [];
	const showErrorMessage = vi.fn();
	const createFileSystemWatcher = vi.fn(() => {
		const handlers: {
			change?: (uri: { fsPath: string }) => void;
			create?: (uri: { fsPath: string }) => void;
			delete?: (uri: { fsPath: string }) => void;
		} = {};
		const watcher = {
			onDidChange: (callback: (uri: { fsPath: string }) => void) => {
				handlers.change = callback;
			},
			onDidCreate: (callback: (uri: { fsPath: string }) => void) => {
				handlers.create = callback;
			},
			onDidDelete: (callback: (uri: { fsPath: string }) => void) => {
				handlers.delete = callback;
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
		readonly base: string;
		readonly pattern: string;
		constructor(base: string, pattern: string) {
			this.base = base;
			this.pattern = pattern;
		}
	}
	const Uri = {
		file(fsPath: string) {
			return { fsPath };
		},
	};
	class TreeItem {
		label: string;
		collapsibleState: number;
		resourceUri?: { fsPath: string };
		description?: string;
		checkboxState?: number;
		contextValue?: string;
		tooltip?: unknown;
		command?: unknown;
		iconPath?: unknown;
		constructor(label: string, collapsibleState: number) {
			this.label = label;
			this.collapsibleState = collapsibleState;
		}
	}
	class ThemeIcon {
		readonly id: string;
		constructor(id: string) {
			this.id = id;
		}
	}
	class EventEmitter {
		event = vi.fn();
		fire = vi.fn();
		dispose = vi.fn();
	}

	return {
		watchers,
		showErrorMessage,
		createFileSystemWatcher,
		RelativePattern,
		Uri,
		TreeItem,
		ThemeIcon,
		EventEmitter,
	};
});

vi.mock("vscode", () => ({
	TreeItem,
	TreeItemCollapsibleState: { None: 0 },
	TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
	ThemeIcon,
	EventEmitter,
	Uri,
	RelativePattern,
	workspace: {
		createFileSystemWatcher,
	},
	window: {
		showErrorMessage,
	},
	// FilesTreeProvider's snap subscriber calls
	// `vscode.commands.executeCommand("setContext", ...)` to mirror the empty
	// state into a context key. Without a stub here the call throws inside
	// BaseStore.emit and downstream subscribers (including the
	// _onDidChangeTreeData fire) never run, which would break any assertion
	// that observes the fire.
	commands: {
		executeCommand: vi.fn(),
	},
}));

import { FilesStore } from "../stores/FilesStore.js";
import { ExcludeFilterManager } from "../util/ExcludeFilterManager.js";
import { FileItem, FilesTreeProvider } from "./FilesTreeProvider.js";

/**
 * Test helper: constructs a real FilesStore + FilesTreeProvider and returns
 * a facade with the pre-refactor shim surface (refresh / getFiles / etc.).
 * The provider itself no longer carries those methods — the facade forwards
 * to the store so legacy test assertions can keep working.
 */
function createProvider(
	bridge: unknown,
	workspaceRoot: string,
	filter: ExcludeFilterManager,
) {
	const store = new FilesStore(bridge as never, workspaceRoot, filter);
	const provider = new FilesTreeProvider(store);
	const emitter = (
		provider as unknown as {
			_onDidChangeTreeData: { fire: ReturnType<typeof vi.fn> };
		}
	)._onDidChangeTreeData;
	return {
		__store: store,
		_onDidChangeTreeData: emitter,
		getTreeItem: provider.getTreeItem.bind(provider),
		getChildren: provider.getChildren.bind(provider),
		onDidChangeTreeData: provider.onDidChangeTreeData,
		dispose: () => {
			provider.dispose();
			store.dispose();
		},
		// Shim surface (provider no longer has these — they now live on the store)
		refresh: (reorder?: boolean) => store.refresh(reorder),
		setMigrating: (m: boolean) => store.setMigrating(m),
		setEnabled: (e: boolean) => store.setEnabled(e),
		getFiles: () => store.getSnapshot().files,
		getSelectedFiles: () => store.getSnapshot().selectedFiles,
		getVisibleFileCount: () => store.getSnapshot().visibleCount,
		getExcludedCount: () => store.getSnapshot().excludedCount,
		deselectPaths: (paths: ReadonlyArray<string>) => store.deselectPaths(paths),
		toggleSelectAll: () => store.toggleSelectAll(),
		onCheckboxToggle: (item: FileItem, checked: boolean) =>
			store.applyCheckboxBatch([[item.fileStatus.relativePath, checked]]),
		onCheckboxToggleBatch: (
			items: ReadonlyArray<readonly [FileItem, boolean]>,
		) =>
			store.applyCheckboxBatch(
				items.map(
					([item, checked]) => [item.fileStatus.relativePath, checked] as const,
				),
			),
	};
}

function makeFile(
	relativePath: string,
	isSelected: boolean,
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
		stageFile: vi.fn().mockResolvedValue(undefined),
		unstageFile: vi.fn().mockResolvedValue(undefined),
		stageFiles: vi.fn().mockResolvedValue(undefined),
		unstageFiles: vi.fn().mockResolvedValue(undefined),
	} as const;
}

function makeExcludeFilter(patterns: Array<string> = []) {
	const filter = new ExcludeFilterManager();
	void (filter as unknown as { patterns: Array<string> }).patterns.splice(
		0,
		(filter as unknown as { patterns: Array<string> }).patterns.length,
		...patterns,
	);
	return filter;
}

describe("FileItem", () => {
	it("builds a tree item with file metadata and command", () => {
		const item = new FileItem(makeFile("src/App.ts", true));

		expect(item.label).toBe("App.ts");
		expect(item.description).toBe("src/App.ts");
		expect(item.checkboxState).toBe(1);
		expect(item.tooltip).toBe("src/App.ts");
		expect(item.resourceUri).toEqual({ fsPath: "/repo/src/App.ts" });
		expect(item.command).toEqual({
			command: "jollimemory.openFileChange",
			title: "Open Change",
			arguments: [item],
		});
	});
});

describe("FilesTreeProvider", () => {
	beforeEach(() => {
		watchers.length = 0;
		showErrorMessage.mockReset();
		createFileSystemWatcher.mockClear();
		vi.useRealTimers();
	});

	it("refreshes files, preserves stable order, and exposes staged/visible counts", async () => {
		const files = [
			makeFile("b.ts", false),
			makeFile("a.ts", true),
			makeFile("ignore.log", true),
		];
		const bridge = makeBridge(files);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(["*.log"]),
		);

		await provider.refresh(true);
		expect(provider.getFiles().map((file) => file.relativePath)).toEqual([
			"b.ts",
			"a.ts",
			"ignore.log",
		]);
		// ignore.log is selected but excluded by *.log — getSelectedFiles() must filter it out
		expect(
			provider.getSelectedFiles().map((file) => file.relativePath),
		).toEqual(["a.ts"]);
		expect(provider.getExcludedCount()).toBe(1);
		expect(provider.getVisibleFileCount()).toBe(2);
		expect(
			provider.getChildren().map((item) => item.fileStatus.relativePath),
		).toEqual(["b.ts", "a.ts"]);

		bridge.listFiles.mockResolvedValueOnce([
			makeFile("a.ts", true),
			makeFile("c.ts", false),
			makeFile("b.ts", true),
		]);
		await provider.refresh();
		expect(provider.getFiles().map((file) => file.relativePath)).toEqual([
			"b.ts",
			"a.ts",
			"c.ts",
		]);
	});

	it("discards stale refresh results when a newer refresh starts first", async () => {
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
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);

		const firstRefresh = provider.refresh();
		const secondRefresh = provider.refresh();

		resolveFirst?.([makeFile("stale.ts", false)]);
		await firstRefresh;
		expect(provider.getFiles()).toEqual([]);

		resolveSecond?.([makeFile("fresh.ts", false)]);
		await secondRefresh;
		expect(provider.getFiles().map((file) => file.relativePath)).toEqual([
			"fresh.ts",
		]);
	});

	it("hides children when disabled or migrating", async () => {
		const provider = createProvider(
			makeBridge([makeFile("a.ts", true)]) as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh();

		provider.setEnabled(false);
		expect(provider.getChildren()).toEqual([]);

		provider.setEnabled(true);
		provider.setMigrating(true);
		expect(provider.getChildren()).toEqual([]);
	});

	it("does not fire tree changes when enabled or migrating state is unchanged", () => {
		const provider = createProvider(
			makeBridge([makeFile("a.ts", true)]) as never,
			"/repo",
			makeExcludeFilter(),
		);
		const emitter = (
			provider as unknown as {
				_onDidChangeTreeData: { fire: ReturnType<typeof vi.fn> };
			}
		)._onDidChangeTreeData;

		provider.setEnabled(true);
		provider.setMigrating(false);

		expect(emitter.fire).not.toHaveBeenCalled();
	});

	it("fires onDidChangeTreeData on userCheckbox so the sidebar webview re-pushes changesData", async () => {
		// Regression: when the legacy native TreeView still existed, the provider
		// suppressed fire() on userCheckbox to avoid re-render flicker. The native
		// view is gone (commit e2aaf561) and the sidebar webview now derives its
		// toolbar disabled-state from the snapshot it last received — so the fire
		// MUST happen on userCheckbox or the Commit / Discard buttons stay
		// disabled forever after the user ticks the row.
		const bridge = makeBridge([makeFile("a.ts", false)]);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh();
		const emitter = (
			provider as unknown as {
				_onDidChangeTreeData: { fire: ReturnType<typeof vi.fn> };
			}
		)._onDidChangeTreeData;
		emitter.fire.mockClear();

		provider.onCheckboxToggle(provider.getChildren()[0], true);

		expect(emitter.fire).toHaveBeenCalledTimes(1);
	});

	it("updates selection in memory from checkbox toggles", async () => {
		const bridge = makeBridge([makeFile("a.ts", false)]);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh();
		const [item] = provider.getChildren();

		provider.onCheckboxToggle(item, true);
		expect(
			provider.getSelectedFiles().map((file) => file.relativePath),
		).toEqual(["a.ts"]);

		provider.onCheckboxToggle(item, false);
		expect(provider.getSelectedFiles()).toEqual([]);
		expect(bridge.stageFile).not.toHaveBeenCalled();
		expect(bridge.unstageFile).not.toHaveBeenCalled();
		expect(bridge.listFiles).toHaveBeenCalledTimes(1);
	});

	it("returns files.length for getVisibleFileCount when no exclude patterns are set", async () => {
		const files = [makeFile("a.ts", true), makeFile("b.ts", false)];
		const bridge = makeBridge(files);
		// Empty exclude filter — hasPatterns() returns false
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh();

		// Exercises the short-circuit return on line 163 (no patterns → return files.length)
		expect(provider.getVisibleFileCount()).toBe(2);
	});

	it("deselects a file in memory when checkbox is unchecked", async () => {
		const bridge = makeBridge([makeFile("a.ts", true)]);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh();

		provider.onCheckboxToggle(provider.getChildren()[0], false);

		// File should now be deselected in memory
		expect(provider.getSelectedFiles()).toHaveLength(0);
	});

	it("selects a file in memory when checkbox is checked", async () => {
		const bridge = makeBridge([makeFile("a.ts", false)]);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh();

		provider.onCheckboxToggle(provider.getChildren()[0], true);

		expect(provider.getSelectedFiles()).toHaveLength(1);
		expect(provider.getSelectedFiles()[0].relativePath).toBe("a.ts");
	});

	it("toggles all visible files in memory", async () => {
		const files = [
			makeFile("a.ts", false),
			makeFile("b.ts", false),
			makeFile("skip.log", false),
		];
		const bridge = makeBridge(files);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(["*.log"]),
		);
		await provider.refresh();

		// Select all visible (a.ts, b.ts — skip.log is excluded)
		provider.toggleSelectAll();
		const selected = provider.getSelectedFiles().map((f) => f.relativePath);
		expect(selected.sort()).toEqual(["a.ts", "b.ts"]);

		// Toggle again → deselect all visible
		provider.toggleSelectAll();
		expect(provider.getSelectedFiles()).toHaveLength(0);
	});

	it("keeps already-selected visible files selected when selecting the remaining files", async () => {
		const files = [makeFile("a.ts", true), makeFile("b.ts", false)];
		const bridge = makeBridge(files);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh();

		provider.toggleSelectAll();

		expect(
			provider
				.getSelectedFiles()
				.map((file) => file.relativePath)
				.sort(),
		).toEqual(["a.ts", "b.ts"]);
	});

	it("leaves selection empty when toggleSelectAll runs with no visible files", async () => {
		const files = [makeFile("skip.log", false)];
		const bridge = makeBridge(files);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(["*.log"]),
		);
		await provider.refresh();

		provider.toggleSelectAll();

		expect(provider.getSelectedFiles()).toEqual([]);
	});

	it("sorts known files by fileOrder, falling back to 0 for paths not in the order map", async () => {
		// On the first refresh the order map is built from ["a.ts", "b.ts"].
		// On the second refresh (no reorder), "c.ts" is added and "b.ts" is known.
		// The fallback ?? 0 in the sort comparator is exercised when a known file's
		// relativePath is not in fileOrder (should not happen normally, but the guard exists).
		const files = [makeFile("a.ts", true), makeFile("b.ts", false)];
		const bridge = makeBridge(files);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh(true); // builds fileOrder: a.ts → 0, b.ts → 1

		// Manually clear the fileOrder for "b.ts" to trigger the ?? 0 fallback
		// (fileOrder now lives on the store)
		const fileOrder = (
			provider.__store as unknown as { fileOrder: Map<string, number> }
		).fileOrder;
		fileOrder.delete("b.ts");

		// Now refresh without reorder — mergeFileOrder runs, b.ts is "known" but not in order map
		bridge.listFiles.mockResolvedValueOnce([
			makeFile("b.ts", false),
			makeFile("a.ts", true),
		]);
		await provider.refresh();

		// b.ts falls back to index 0, a.ts has index 0 → stable order, no crash
		const resultPaths = provider.getFiles().map((f) => f.relativePath);
		expect(resultPaths).toContain("a.ts");
		expect(resultPaths).toContain("b.ts");
	});

	it("leaves unrelated files unchanged during batch checkbox updates", async () => {
		const bridge = makeBridge([
			makeFile("a.ts", false),
			makeFile("b.ts", false),
		]);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh();
		const [itemA] = provider.getChildren();

		provider.onCheckboxToggleBatch([[itemA, true]]);

		expect(provider.getFiles()).toEqual([
			expect.objectContaining({ relativePath: "a.ts", isSelected: true }),
			expect.objectContaining({ relativePath: "b.ts", isSelected: false }),
		]);
	});

	it("debounces workspace watcher refreshes and ignores .git paths", () => {
		vi.useFakeTimers();
		const provider = createProvider(
			makeBridge([makeFile("a.ts", true)]) as never,
			"/repo",
			makeExcludeFilter(),
		);
		// Watchers now live on the Store — spy on its refresh path.
		const refreshSpy = vi
			.spyOn(provider.__store, "refresh")
			.mockResolvedValue();

		watchers[1].fireChange({ fsPath: "/repo/src/a.ts" });
		watchers[1].fireCreate({ fsPath: "/repo/src/b.ts" });
		watchers[1].fireDelete({ fsPath: "/repo/.git/index.lock" });

		expect(refreshSpy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(399);
		expect(refreshSpy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});

	it("swallows errors from debounced refreshes", async () => {
		vi.useFakeTimers();
		const provider = createProvider(
			makeBridge([makeFile("a.ts", true)]) as never,
			"/repo",
			makeExcludeFilter(),
		);
		const refreshSpy = vi
			.spyOn(provider.__store, "refresh")
			.mockRejectedValue(new Error("refresh failed"));

		watchers[0].fireChange({ fsPath: "/repo/.git/index" });
		vi.advanceTimersByTime(400);
		await vi.runAllTicks();

		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});

	it("debounces git index watcher refreshes and disposes resources", () => {
		vi.useFakeTimers();
		const provider = createProvider(
			makeBridge([makeFile("a.ts", true)]) as never,
			"/repo",
			makeExcludeFilter(),
		);
		const refreshSpy = vi
			.spyOn(provider.__store, "refresh")
			.mockResolvedValue();

		watchers[0].fireChange({ fsPath: "/repo/.git/index" });
		watchers[0].fireCreate({ fsPath: "/repo/.git/index" });
		expect(refreshSpy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(400);
		expect(refreshSpy).toHaveBeenCalledTimes(1);

		provider.dispose();
		provider.__store.dispose();
		expect(watchers[0].dispose).toHaveBeenCalled();
		expect(watchers[1].dispose).toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("getTreeItem returns the element directly", async () => {
		const provider = createProvider(
			makeBridge([makeFile("a.ts", true)]) as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh();
		const [item] = provider.getChildren();

		expect(provider.getTreeItem(item)).toBe(item);
	});
});

describe("FilesTreeProvider.serialize", () => {
	it("returns SerializedTreeItem[] mapped from getChildren", async () => {
		const bridge = makeBridge([
			makeFile("src/App.ts", true),
			makeFile("src/index.ts", false),
		]);
		const store = new FilesStore(bridge as never, "/repo", makeExcludeFilter());
		const provider = new FilesTreeProvider(store);
		await store.refresh();

		const serialized = provider.serialize();

		expect(Array.isArray(serialized)).toBe(true);
		expect(serialized.length).toBeGreaterThan(0);
		expect(serialized[0]).toMatchObject({
			id: expect.any(String),
			label: expect.any(String),
		});

		provider.dispose();
		store.dispose();
	});

	it("uses fsPath as id when resourceUri is present", async () => {
		const bridge = makeBridge([makeFile("src/App.ts", true)]);
		const store = new FilesStore(bridge as never, "/repo", makeExcludeFilter());
		const provider = new FilesTreeProvider(store);
		await store.refresh();

		const serialized = provider.serialize();

		const item = serialized[0];
		// id should look path-like (contain repo path)
		expect(item.id).toBe("/repo/src/App.ts");

		provider.dispose();
		store.dispose();
	});

	it("serialize emits gitStatus and isSelected on file rows", async () => {
		const bridge = makeBridge([
			{
				absolutePath: "/repo/src/foo.ts",
				relativePath: "src/foo.ts",
				statusCode: "M",
				indexStatus: "M",
				worktreeStatus: " ",
				isSelected: true,
			},
		]);
		const store = new FilesStore(bridge as never, "/repo", makeExcludeFilter());
		const provider = new FilesTreeProvider(store);
		await store.refresh();

		const items = provider.serialize();

		expect(items[0]).toMatchObject({
			label: "foo.ts",
			gitStatus: "M",
			isSelected: true,
		});

		provider.dispose();
		store.dispose();
	});

	it("dispose clears the debounce timer", () => {
		vi.useFakeTimers();
		const provider = createProvider(
			makeBridge([makeFile("a.ts", true)]) as never,
			"/repo",
			makeExcludeFilter(),
		);
		const refreshSpy = vi.spyOn(provider, "refresh").mockResolvedValue();

		// Trigger a debounced refresh via workspace watcher
		watchers[1].fireChange({ fsPath: "/repo/src/a.ts" });

		// Dispose before the debounce fires
		provider.dispose();

		// Advance past the debounce interval — refresh should NOT fire
		vi.advanceTimersByTime(500);
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	// fireChange() was a provider shim for callers that wanted to nudge
	// VSCode to re-render without re-fetching.  It is no longer part of the
	// provider surface; equivalent effect is achieved by the store's
	// onChange broadcast after any mutation.

	it("prunes stale selected paths and deselects explicit paths on refresh", async () => {
		const bridge = makeBridge([
			makeFile("a.ts", false),
			makeFile("b.ts", false),
		]);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh(true);

		const [itemA, itemB] = provider.getChildren();
		provider.onCheckboxToggleBatch([
			[itemA, true],
			[itemB, true],
		]);
		expect(
			provider
				.getSelectedFiles()
				.map((file) => file.relativePath)
				.sort(),
		).toEqual(["a.ts", "b.ts"]);

		provider.deselectPaths(["a.ts"]);
		expect(
			provider.getSelectedFiles().map((file) => file.relativePath),
		).toEqual(["b.ts"]);

		bridge.listFiles.mockResolvedValueOnce([makeFile("a.ts", false)]);
		await provider.refresh();

		expect(provider.getSelectedFiles()).toEqual([]);
		expect(provider.getFiles().map((file) => file.relativePath)).toEqual([
			"a.ts",
		]);
	});

	it("preserves selected files when they still exist after refresh", async () => {
		const bridge = makeBridge([
			makeFile("a.ts", false),
			makeFile("b.ts", false),
		]);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh(true);

		const [itemA] = provider.getChildren();
		provider.onCheckboxToggle(itemA, true);

		bridge.listFiles.mockResolvedValueOnce([
			makeFile("a.ts", false),
			makeFile("b.ts", false),
		]);
		await provider.refresh();

		expect(provider.getFiles()).toEqual([
			expect.objectContaining({ relativePath: "a.ts", isSelected: true }),
			expect.objectContaining({ relativePath: "b.ts", isSelected: false }),
		]);
	});

	it("uses the stable sort fallback when fileOrder entries are present but undefined", async () => {
		const files = [makeFile("a.ts", false), makeFile("b.ts", false)];
		const bridge = makeBridge(files);
		const provider = createProvider(
			bridge as never,
			"/repo",
			makeExcludeFilter(),
		);
		await provider.refresh(true);

		// fileOrder lives on the store now
		const fileOrder = (
			provider.__store as unknown as {
				fileOrder: Map<string, number | undefined>;
			}
		).fileOrder;
		fileOrder.set("a.ts", undefined);
		fileOrder.set("b.ts", undefined);

		bridge.listFiles.mockResolvedValueOnce([
			makeFile("b.ts", false),
			makeFile("a.ts", false),
		]);
		await provider.refresh();

		expect(
			provider
				.getFiles()
				.map((file) => file.relativePath)
				.sort(),
		).toEqual(["a.ts", "b.ts"]);
	});
});
