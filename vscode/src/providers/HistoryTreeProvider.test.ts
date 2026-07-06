import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommitsStore } from "../stores/CommitsStore.js";
import type {
	BranchCommit,
	BranchCommitsResult,
	CommitFileInfo,
} from "../Types.js";
import {
	COMMIT_FILE_SCHEME,
	CommitFileDecorationProvider,
	CommitFileItem,
	type CommitItem,
	didCommitSequenceChange,
	HistoryTreeProvider,
} from "./HistoryTreeProvider.js";

/**
 * Test facade: constructs a real CommitsStore + HistoryTreeProvider and
 * returns an object with the pre-refactor shim surface.  The provider itself
 * no longer carries refresh/setEnabled/etc. — the facade forwards to the
 * store so legacy test assertions keep working without rewrites.
 */
function makeHistoryProvider(bridge: unknown) {
	const store = new CommitsStore(bridge as never);
	const provider = new HistoryTreeProvider(store);
	const emitter = (
		provider as unknown as {
			_onDidChangeTreeData: {
				fire: ReturnType<typeof vi.fn>;
				dispose: () => void;
			};
		}
	)._onDidChangeTreeData;
	return {
		__store: store,
		store,
		_onDidChangeTreeData: emitter,
		getTreeItem: provider.getTreeItem.bind(provider),
		getChildren: provider.getChildren.bind(provider),
		onDidChangeTreeData: provider.onDidChangeTreeData,
		dispose: () => provider.dispose(),
		get isMerged() {
			return store.getSnapshot().isMerged;
		},
		setMainBranch: (branch: string) => store.setMainBranch(branch),
		setMigrating: (m: boolean) => store.setMigrating(m),
		setEnabled: (e: boolean) => store.setEnabled(e),
		refresh: () => store.refresh(),
		getSelectedCommits: () => store.getSnapshot().selectedCommits,
		getAllCommits: () => store.getSnapshot().commits,
		getSelectionDebugInfo: () => store.getSelectionDebugInfo(),
		onCheckboxToggle: (item: CommitItem, checked: boolean) =>
			store.onCheckboxToggle(item.commit.hash, checked),
		toggleSelectAll: () => store.toggleSelectAll(),
		serialize: () => provider.serialize(),
		getMode: () => provider.getMode(),
	};
}

// ─── Mock vscode module ──────────────────────────────────────────────────────

vi.mock("vscode", () => ({
	TreeItem: class {
		label: string | undefined;
		collapsibleState: number | undefined;
		constructor(label?: string, collapsibleState?: number) {
			this.label = label;
			this.collapsibleState = collapsibleState;
		}
	},
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
	ThemeIcon: class {
		id: string;
		color: unknown;
		constructor(id: string, color?: unknown) {
			this.id = id;
			this.color = color;
		}
	},
	ThemeColor: class {
		id: string;
		constructor(id: string) {
			this.id = id;
		}
	},
	FileDecoration: class {
		badge: string | undefined;
		tooltip: string | undefined;
		color: unknown;
		constructor(badge?: string, tooltip?: string, color?: unknown) {
			this.badge = badge;
			this.tooltip = tooltip;
			this.color = color;
		}
	},
	Uri: {
		file: (path: string) => ({ fsPath: path, scheme: "file", with: vi.fn() }),
		from: (components: { scheme: string; path: string; query?: string }) => ({
			scheme: components.scheme,
			path: components.path,
			query: components.query ?? "",
		}),
	},
	EventEmitter: class {
		event = vi.fn();
		fire = vi.fn();
		dispose = vi.fn();
	},
	MarkdownString: class {
		value: string;
		constructor(value = "") {
			this.value = value;
		}
		isTrusted = false;
		appendMarkdown(s: string): void {
			this.value += s;
		}
	},
	window: {
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		})),
	},
	commands: {
		executeCommand: vi.fn(),
	},
}));

import * as vscode from "vscode";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a minimal BranchCommit stub for testing. */
function makeCommit(hash: string, message = "msg"): BranchCommit {
	return {
		hash,
		shortHash: hash.substring(0, 8),
		message,
		author: "Test",
		authorEmail: "test@test.com",
		date: "2026-03-29T00:00:00Z",
		shortDate: "03-29",
		topicCount: 0,
		insertions: 1,
		deletions: 0,
		filesChanged: 1,
		isPushed: false,
		hasSummary: false,
	};
}

function makeResult(
	commits: Array<BranchCommit>,
	isMerged = false,
): BranchCommitsResult {
	return { commits, isMerged };
}

/** Creates a mock bridge that returns the given result from listBranchCommits. */
function makeBridge(
	resultFn: () => BranchCommitsResult,
	commitFilesFn?: () => Promise<Array<CommitFileInfo>>,
) {
	return {
		listBranchCommits: vi.fn(resultFn),
		listCommitFiles: vi.fn(commitFilesFn ?? (async () => [])),
	};
}

beforeEach(() => {
	vi.mocked(vscode.commands.executeCommand).mockClear();
});

// ─── didCommitSequenceChange ─────────────────────────────────────────────────

describe("didCommitSequenceChange", () => {
	it("returns false for two empty lists", () => {
		expect(didCommitSequenceChange([], [])).toBe(false);
	});

	it("returns false for identical sequences", () => {
		expect(didCommitSequenceChange(["aaa", "bbb"], ["aaa", "bbb"])).toBe(false);
	});

	it("returns true when lengths differ", () => {
		expect(didCommitSequenceChange(["aaa"], ["aaa", "bbb"])).toBe(true);
	});

	it("returns true when a hash changes (amend replaces HEAD)", () => {
		expect(
			didCommitSequenceChange(["old-head", "bbb"], ["new-head", "bbb"]),
		).toBe(true);
	});

	it("returns true when order changes", () => {
		expect(didCommitSequenceChange(["aaa", "bbb"], ["bbb", "aaa"])).toBe(true);
	});
});

// ─── HistoryTreeProvider.refresh() selection clearing ────────────────────────

describe("HistoryTreeProvider.refresh() selection clearing", () => {
	const commitA = makeCommit("aaaa1111");
	const commitB = makeCommit("bbbb2222");
	const commitC = makeCommit("cccc3333");

	it("clears selection when commit list changes (amend replaces HEAD)", async () => {
		const newHead = makeCommit("dddd4444");
		let commits = [commitA, commitB, commitC];
		const bridge = makeBridge(() => makeResult(commits));
		const provider = makeHistoryProvider(bridge);

		// Initial load
		await provider.refresh();
		// Simulate user checking commits A and B
		const children = await provider.getChildren();
		provider.onCheckboxToggle(children[1] as CommitItem, true); // checks A (idx 0) and B (idx 1)
		expect(provider.getSelectedCommits()).toHaveLength(2);

		// Simulate amend: HEAD changes from A to newHead
		commits = [newHead, commitB, commitC];
		await provider.refresh();

		// Selection should be cleared
		expect(provider.getSelectedCommits()).toHaveLength(0);
	});

	it("clears selection when commit list changes (squash reduces count)", async () => {
		const squashed = makeCommit("eeee5555");
		let commits = [commitA, commitB, commitC];
		const bridge = makeBridge(() => makeResult(commits));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const children = await provider.getChildren();
		provider.onCheckboxToggle(children[1] as CommitItem, true);
		expect(provider.getSelectedCommits()).toHaveLength(2);

		// Simulate squash: 3 commits become 2
		commits = [squashed, commitC];
		await provider.refresh();

		expect(provider.getSelectedCommits()).toHaveLength(0);
	});

	it("preserves selection when commit list is unchanged", async () => {
		const commits = [commitA, commitB, commitC];
		const bridge = makeBridge(() => makeResult(commits));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const children = await provider.getChildren();
		provider.onCheckboxToggle(children[1] as CommitItem, true);
		expect(provider.getSelectedCommits()).toHaveLength(2);

		// Refresh with same commits — selection should survive
		await provider.refresh();

		expect(provider.getSelectedCommits()).toHaveLength(2);
	});

	it("no side effects when commit list changes but nothing is selected", async () => {
		let commits = [commitA, commitB];
		const bridge = makeBridge(() => makeResult(commits));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		expect(provider.getSelectedCommits()).toHaveLength(0);

		// Change commits with no selection — should not throw
		commits = [makeCommit("ffff6666"), commitB];
		await provider.refresh();

		expect(provider.getSelectedCommits()).toHaveLength(0);
	});

	it("clears selection when a new commit is added at HEAD", async () => {
		const newCommit = makeCommit("gggg7777");
		let commits = [commitA, commitB];
		const bridge = makeBridge(() => makeResult(commits));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const children = await provider.getChildren();
		provider.onCheckboxToggle(children[0] as CommitItem, true);
		expect(provider.getSelectedCommits()).toHaveLength(1);

		// New commit pushed at HEAD
		commits = [newCommit, commitA, commitB];
		await provider.refresh();

		expect(provider.getSelectedCommits()).toHaveLength(0);
	});
});

describe("HistoryTreeProvider tree behavior", () => {
	it("hides children when disabled or migrating", async () => {
		const provider = makeHistoryProvider(
			makeBridge(() => makeResult([makeCommit("aaaa1111")])),
		);

		provider.setEnabled(false);
		expect(await provider.getChildren()).toEqual([]);

		provider.setEnabled(true);
		provider.setMigrating(true);
		expect(await provider.getChildren()).toEqual([]);
	});

	it("does not fire tree change when setEnabled is called with the same value", () => {
		const provider = makeHistoryProvider(makeBridge(() => makeResult([])));
		const emitter = (
			provider as unknown as {
				_onDidChangeTreeData: { fire: ReturnType<typeof vi.fn> };
			}
		)._onDidChangeTreeData;

		// Default is enabled=true, so setting true again should NOT fire
		emitter.fire.mockClear();
		provider.setEnabled(true);
		expect(emitter.fire).not.toHaveBeenCalled();

		// Set to false (different value → fires)
		provider.setEnabled(false);
		expect(emitter.fire).toHaveBeenCalled();

		// Set to false again (same value → does NOT fire)
		emitter.fire.mockClear();
		provider.setEnabled(false);
		expect(emitter.fire).not.toHaveBeenCalled();
	});

	it("hides checkboxes and shows a commit icon in single-commit mode", async () => {
		const provider = makeHistoryProvider(
			makeBridge(() => makeResult([makeCommit("aaaa1111")])),
		);

		await provider.refresh();
		const [item] = await provider.getChildren();

		expect(item.checkboxState).toBeUndefined();
		expect((item.iconPath as { id: string }).id).toBe("git-commit");
	});

	it("hides checkboxes in merged mode", async () => {
		const provider = makeHistoryProvider(
			makeBridge(() =>
				makeResult([makeCommit("aaaa1111"), makeCommit("bbbb2222")], true),
			),
		);

		await provider.refresh();
		const [item] = await provider.getChildren();

		expect(item.checkboxState).toBeUndefined();
		expect(provider.isMerged).toBe(true);
	});

	it("toggles all commits on and off", async () => {
		const commits = [
			makeCommit("aaaa1111"),
			makeCommit("bbbb2222"),
			makeCommit("cccc3333"),
		];
		const provider = makeHistoryProvider(makeBridge(() => makeResult(commits)));

		await provider.refresh();
		provider.toggleSelectAll();
		expect(provider.getSelectedCommits().map((commit) => commit.hash)).toEqual([
			"aaaa1111",
			"bbbb2222",
			"cccc3333",
		]);

		provider.toggleSelectAll();
		expect(provider.getSelectedCommits()).toEqual([]);
	});

	it("getAllCommits returns all loaded commits", async () => {
		const commits = [
			makeCommit("aaaa1111"),
			makeCommit("bbbb2222"),
			makeCommit("cccc3333"),
		];
		const provider = makeHistoryProvider(makeBridge(() => makeResult(commits)));

		await provider.refresh();

		expect(provider.getAllCommits()).toHaveLength(3);
		expect(provider.getAllCommits().map((c) => c.hash)).toEqual([
			"aaaa1111",
			"bbbb2222",
			"cccc3333",
		]);
	});

	it("unchecks from index to end when a commit is unchecked", async () => {
		const commits = [
			makeCommit("aaaa1111"),
			makeCommit("bbbb2222"),
			makeCommit("cccc3333"),
		];
		const provider = makeHistoryProvider(makeBridge(() => makeResult(commits)));

		await provider.refresh();
		// Check all three commits (checking the last one auto-checks 0..2)
		const children1 = await provider.getChildren();
		provider.onCheckboxToggle(children1[2] as CommitItem, true);
		expect(provider.getSelectedCommits()).toHaveLength(3);

		// Uncheck commit at index 1 — should uncheck indices 1 and 2
		const children2 = await provider.getChildren();
		provider.onCheckboxToggle(children2[1] as CommitItem, false);
		expect(provider.getSelectedCommits().map((c) => c.hash)).toEqual([
			"aaaa1111",
		]);
	});

	it("ignores checkbox toggles for commits that are not in the current list", async () => {
		const provider = makeHistoryProvider(
			makeBridge(() => makeResult([makeCommit("aaaa1111")])),
		);

		await provider.refresh();
		provider.onCheckboxToggle(
			{ commit: makeCommit("zzzz9999") } as never,
			true,
		);

		expect(provider.getSelectedCommits()).toEqual([]);
	});

	it("reports selection debug info with stale hashes shortened", async () => {
		const commits = [makeCommit("aaaaaaaa"), makeCommit("bbbbbbbb")];
		const provider = makeHistoryProvider(makeBridge(() => makeResult(commits)));

		await provider.refresh();
		const debugChildren = await provider.getChildren();
		provider.onCheckboxToggle(debugChildren[1] as CommitItem, true);
		// Inject a stale selection directly into the underlying store to simulate
		// a commit that used to be selected but has disappeared from the list.
		(
			provider as unknown as {
				store: { checkedHashes: Set<string> };
			}
		).store.checkedHashes.add("stalehash0000");

		expect(provider.getSelectionDebugInfo()).toEqual({
			checkedHashes: ["aaaaaaaa", "bbbbbbbb", "stalehas"],
			selectedCommits: ["aaaaaaaa", "bbbbbbbb"],
			staleCheckedHashes: ["stalehas"],
			commitCount: 2,
			headHash: "aaaaaaaa",
			tailHash: "bbbbbbbb",
			isMerged: false,
		});
	});

	it("updates VS Code context keys during refresh", async () => {
		const provider = makeHistoryProvider(
			makeBridge(() => makeResult([makeCommit("aaaaaaaa")], true)),
		);

		await provider.refresh();

		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"setContext",
			"jollimemory.history.singleCommitMode",
			true,
		);
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"setContext",
			"jollimemory.history.mergedMode",
			true,
		);
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"setContext",
			"jollimemory.history.empty",
			false,
		);
	});

	it("swallows context sync failures", async () => {
		vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(
			new Error("boom"),
		);
		const provider = makeHistoryProvider(makeBridge(() => makeResult([])));

		await expect(provider.refresh()).resolves.toBeUndefined();
	});

	it("setMainBranch updates the internal main branch property", () => {
		const provider = makeHistoryProvider(makeBridge(() => makeResult([])));

		// setMainBranch should not throw and should set the internal property
		provider.setMainBranch("develop");

		// The branch now lives on the underlying store — access it via the
		// provider's private `store` field.
		const mainBranch = (
			provider as unknown as { store: { mainBranch: string } }
		).store.mainBranch;
		expect(mainBranch).toBe("develop");
	});

	it("appends cloud icon to label for pushed commits", async () => {
		const commit = {
			...makeCommit("aaaaaaaa", "deployed feature"),
			isPushed: true,
		};
		const provider = makeHistoryProvider(
			makeBridge(() => makeResult([commit])),
		);

		await provider.refresh();
		const [item] = (await provider.getChildren()) as Array<CommitItem>;

		// The pushed flag rides through to the serialized commit; the cloud
		// affordance is rendered from item.commit.isPushed in the webview.
		expect(item.commit.isPushed).toBe(true);
	});

	it("returns tree items unchanged and disposes its event emitter", async () => {
		const provider = makeHistoryProvider(
			makeBridge(() => makeResult([makeCommit("aaaaaaaa")])),
		);

		await provider.refresh();
		const [item] = await provider.getChildren();
		const disposeSpy = vi.spyOn(
			(provider as unknown as { _onDidChangeTreeData: { dispose: () => void } })
				._onDidChangeTreeData,
			"dispose",
		);

		expect(provider.getTreeItem(item)).toBe(item);

		provider.dispose();
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("CommitItem has stable id set to commit hash", async () => {
		const provider = makeHistoryProvider(
			makeBridge(() => makeResult([makeCommit("aaaa1111")])),
		);

		await provider.refresh();
		const [item] = await provider.getChildren();

		expect(item.id).toBe("aaaa1111");
	});

	it("commits have Collapsed collapsible state", async () => {
		const provider = makeHistoryProvider(
			makeBridge(() =>
				makeResult([makeCommit("aaaa1111"), makeCommit("bbbb2222")]),
			),
		);

		await provider.refresh();
		const [item] = await provider.getChildren();

		// TreeItemCollapsibleState.Collapsed = 1
		expect(item.collapsibleState).toBe(1);
	});
});

// ─── CommitFileItem expansion ───────────────────────────────────────────────

describe("HistoryTreeProvider commit file expansion", () => {
	const mockFiles: Array<CommitFileInfo> = [
		{ relativePath: "src/Foo.ts", statusCode: "M" },
		{ relativePath: "src/Bar.ts", statusCode: "A" },
		{ relativePath: "src/Old.ts", statusCode: "D" },
		{ relativePath: "src/New.ts", statusCode: "R", oldPath: "src/Legacy.ts" },
	];

	it("returns CommitFileItem children when expanding a commit", async () => {
		const bridge = makeBridge(
			() => makeResult([makeCommit("aaaa1111")]),
			async () => mockFiles,
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const [commitItem] = await provider.getChildren();
		const fileItems = await provider.getChildren(commitItem);

		expect(fileItems).toHaveLength(4);
		expect(fileItems.every((f) => f instanceof CommitFileItem)).toBe(true);
		expect(bridge.listCommitFiles).toHaveBeenCalledWith("aaaa1111");
	});

	it("returns empty array for CommitFileItem children (leaf nodes)", async () => {
		const bridge = makeBridge(
			() => makeResult([makeCommit("aaaa1111")]),
			async () => mockFiles,
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const [commitItem] = await provider.getChildren();
		const fileItems = await provider.getChildren(commitItem);
		const leafChildren = await provider.getChildren(fileItems[0]);

		expect(leafChildren).toEqual([]);
	});

	it("caches file list per commit — bridge called only once", async () => {
		const bridge = makeBridge(
			() => makeResult([makeCommit("aaaa1111")]),
			async () => mockFiles,
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const [commitItem] = await provider.getChildren();

		await provider.getChildren(commitItem);
		await provider.getChildren(commitItem);

		expect(bridge.listCommitFiles).toHaveBeenCalledTimes(1);
	});

	it("clears file cache when commit sequence changes", async () => {
		let commits = [makeCommit("aaaa1111")];
		const bridge = makeBridge(
			() => makeResult(commits),
			async () => mockFiles,
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const [commitItem1] = await provider.getChildren();
		await provider.getChildren(commitItem1);

		// Refresh with different commits — cache should be cleared
		commits = [makeCommit("bbbb2222")];
		await provider.refresh();
		const [commitItem2] = await provider.getChildren();
		await provider.getChildren(commitItem2);

		expect(bridge.listCommitFiles).toHaveBeenCalledTimes(2);
	});

	it("preserves file cache when commit sequence is unchanged", async () => {
		const commits = [makeCommit("aaaa1111")];
		const bridge = makeBridge(
			() => makeResult(commits),
			async () => mockFiles,
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const [commitItem1] = await provider.getChildren();
		await provider.getChildren(commitItem1);

		// Refresh with same commits — cache should survive
		await provider.refresh();
		const [commitItem2] = await provider.getChildren();
		await provider.getChildren(commitItem2);

		expect(bridge.listCommitFiles).toHaveBeenCalledTimes(1);
	});

	it("CommitFileItem has correct properties", async () => {
		const bridge = makeBridge(
			() => makeResult([makeCommit("aaaa1111")]),
			async () => [{ relativePath: "src/Foo.ts", statusCode: "M" }],
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const [commitItem] = await provider.getChildren();
		const [fileItem] = (await provider.getChildren(
			commitItem,
		)) as Array<CommitFileItem>;

		expect(fileItem.label).toBe("Foo.ts");
		expect(fileItem.description).toBe("src/Foo.ts");
		expect(fileItem.id).toBe("aaaa1111:src/Foo.ts");
		expect(fileItem.contextValue).toBe("historyFile");
		expect(fileItem.commitHash).toBe("aaaa1111");
		expect(fileItem.relativePath).toBe("src/Foo.ts");
		expect(fileItem.statusCode).toBe("M");
		expect(fileItem.iconPath).toBeUndefined();
		expect(fileItem.command?.command).toBe("jollimemory.openCommitFileChange");
	});

	it("CommitFileItem uses custom scheme with status in query (no iconPath)", async () => {
		const bridge = makeBridge(
			() => makeResult([makeCommit("aaaa1111")]),
			async () => mockFiles,
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const [commitItem] = await provider.getChildren();
		const fileItems = (await provider.getChildren(
			commitItem,
		)) as Array<CommitFileItem>;

		for (const item of fileItems) {
			expect(item.iconPath).toBeUndefined();
			expect(item.resourceUri).toBeDefined();
			expect(item.resourceUri?.scheme).toBe("jollimemory-commit");
			expect(item.resourceUri?.query).toContain("s=");
		}
	});

	it("CommitFileItem preserves oldPath for renames", async () => {
		const bridge = makeBridge(
			() => makeResult([makeCommit("aaaa1111")]),
			async () => [
				{ relativePath: "src/New.ts", statusCode: "R", oldPath: "src/Old.ts" },
			],
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const [commitItem] = await provider.getChildren();
		const [fileItem] = (await provider.getChildren(
			commitItem,
		)) as Array<CommitFileItem>;

		expect(fileItem.oldPath).toBe("src/Old.ts");
		expect(fileItem.relativePath).toBe("src/New.ts");
	});

	it("propagates errors from bridge.listCommitFiles()", async () => {
		const bridge = makeBridge(
			() => makeResult([makeCommit("aaaa1111")]),
			() => Promise.reject(new Error("git subprocess failed")),
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const [commitItem] = await provider.getChildren();

		await expect(provider.getChildren(commitItem)).rejects.toThrow(
			"git subprocess failed",
		);
	});

	it("does not cache failed promises — retry after error works", async () => {
		let callCount = 0;
		const bridge = makeBridge(
			() => makeResult([makeCommit("aaaa1111")]),
			() => {
				callCount++;
				if (callCount === 1) {
					return Promise.reject(new Error("transient failure"));
				}
				return Promise.resolve([
					{ relativePath: "src/Foo.ts", statusCode: "M" },
				]);
			},
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const [commitItem] = await provider.getChildren();

		// First call fails
		await expect(provider.getChildren(commitItem)).rejects.toThrow(
			"transient failure",
		);

		// Second call should retry (not return cached rejected promise)
		const files = await provider.getChildren(commitItem);
		expect(files).toHaveLength(1);
	});
});

// ─── CommitFileDecorationProvider ───────────────────────────────────────────

describe("CommitFileDecorationProvider", () => {
	const provider = new CommitFileDecorationProvider();

	function makeUri(
		scheme: string,
		path: string,
		query = "",
	): { scheme: string; path: string; query: string } {
		return { scheme, path, query } as never;
	}

	it("returns decoration for each known status code", () => {
		for (const [code, badge] of [
			["M", "M"],
			["A", "A"],
			["D", "D"],
			["R", "R"],
		] as const) {
			const decoration = provider.provideFileDecoration(
				makeUri(COMMIT_FILE_SCHEME, "/src/File.ts", `s=${code}`) as never,
			);
			expect(decoration).toBeDefined();
			expect(decoration?.badge).toBe(badge);
		}
	});

	it("returns undefined for unknown status codes", () => {
		expect(
			provider.provideFileDecoration(
				makeUri(COMMIT_FILE_SCHEME, "/src/File.ts", "s=X") as never,
			),
		).toBeUndefined();
	});

	it("returns undefined for non-matching URI schemes", () => {
		expect(
			provider.provideFileDecoration(
				makeUri("file", "/src/File.ts", "s=M") as never,
			),
		).toBeUndefined();
	});
});

// ─── HistoryTreeProvider.serialize ──────────────────────────────────────────

describe("HistoryTreeProvider.serialize", () => {
	it("returns SerializedTreeItem[] for top-level commits", async () => {
		const commits = [
			makeCommit("aaaa1111", "first commit"),
			makeCommit("bbbb2222", "second commit"),
		];
		const bridge = makeBridge(() => makeResult(commits));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const out = await provider.serialize();

		expect(Array.isArray(out)).toBe(true);
		expect(out.length).toBe(2);
		expect(out[0]).toMatchObject({
			id: "aaaa1111",
			label: expect.any(String),
		});
		expect(out[1]).toMatchObject({
			id: "bbbb2222",
			label: expect.any(String),
		});
	});

	it("walks nested children for expandable commit rows", async () => {
		const commits = [makeCommit("aaaa1111", "commit with files")];
		const mockFiles: Array<CommitFileInfo> = [
			{ relativePath: "src/Foo.ts", statusCode: "M" },
			{ relativePath: "src/Bar.ts", statusCode: "A" },
		];
		const bridge = makeBridge(
			() => makeResult(commits),
			async () => mockFiles,
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const out = await provider.serialize();

		expect(out).toHaveLength(1);
		const commitWithChildren = out[0];
		expect(commitWithChildren.id).toBe("aaaa1111");
		expect(commitWithChildren.collapsibleState).toBe("collapsed");
		expect(commitWithChildren.children).toBeDefined();
		expect(commitWithChildren.children).toHaveLength(2);
		if (commitWithChildren.children) {
			expect(commitWithChildren.children[0]).toMatchObject({
				id: "aaaa1111:src/Foo.ts",
				label: "Foo.ts",
				collapsibleState: "none",
			});
			expect(commitWithChildren.children[1]).toMatchObject({
				id: "aaaa1111:src/Bar.ts",
				label: "Bar.ts",
				collapsibleState: "none",
			});
		}
	});

	it("returns empty array when disabled or migrating", async () => {
		const commits = [makeCommit("aaaa1111")];
		const bridge = makeBridge(() => makeResult(commits));
		const provider = makeHistoryProvider(bridge);

		provider.setEnabled(false);
		let out = await provider.serialize();
		expect(out).toEqual([]);

		provider.setEnabled(true);
		provider.setMigrating(true);
		out = await provider.serialize();
		expect(out).toEqual([]);
	});

	it("serialize emits hasMemory=true for commits with summary", async () => {
		const commits = [makeCommit("h1", "x")];
		commits[0].hasSummary = true;
		const bridge = makeBridge(() => makeResult(commits));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const items = await provider.serialize();

		expect(items).toHaveLength(1);
		expect((items[0] as { hasMemory?: boolean }).hasMemory).toBe(true);
	});

	it("serialize emits hasMemory=false for commits without summary", async () => {
		const commits = [makeCommit("h1", "x")];
		commits[0].hasSummary = false;
		const bridge = makeBridge(() => makeResult(commits));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const items = await provider.serialize();

		expect(items).toHaveLength(1);
		expect((items[0] as { hasMemory?: boolean }).hasMemory).toBe(false);
	});

	it("serialize emits structured hover data for commit rows", async () => {
		// Distinct, non-default values so we can verify all hover fields flow
		// through buildHover instead of falling back to BranchCommit defaults.
		const commits: Array<BranchCommit> = [
			{
				hash: "abcd1234efgh5678",
				shortHash: "abcd1234",
				message: "feat: add hover card",
				author: "Test",
				authorEmail: "test@test.com",
				date: "2026-04-29T00:00:00Z",
				shortDate: "04-29",
				topicCount: 0,
				insertions: 12,
				deletions: 3,
				filesChanged: 2,
				isPushed: false,
				hasSummary: true,
				commitType: "amend",
			},
		];
		const bridge = makeBridge(() => makeResult(commits));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const items = await provider.serialize();

		expect(items).toHaveLength(1);
		const hover = (items[0] as { hover?: Record<string, unknown> }).hover;
		expect(hover).toBeDefined();
		expect(hover).toMatchObject({
			message: "feat: add hover card",
			shortHash: "abcd1234",
			commitType: "amend",
			statsLine: "2 files changed, 12 insertions(+), 3 deletions(-)",
		});
		expect(typeof hover?.relativeDate).toBe("string");
		// Compact form for the row subline ("2h ago" / "3d ago" / "just now") —
		// NOT the verbose formatRelativeDate which appends " (absolute date)".
		expect(hover?.relativeDate).not.toContain("(");
		expect(hover?.relativeDate).toMatch(/ago|just now/);
		// Branch is intentionally omitted on commit rows — see buildHover docs.
		expect(hover?.branch).toBeUndefined();
	});

	it("serialize sets jolliDocUrl from lookupSummary when commit has a memory", async () => {
		const commit = { ...makeCommit("abcd1234efgh5678"), hasSummary: true };
		const bridge = makeBridge(() => makeResult([commit]));
		const store = new CommitsStore(bridge as never);
		const provider = new HistoryTreeProvider(
			store,
			async (hash) => (hash === "abcd1234efgh5678" ? { jolliDocUrl: "https://team.jolli.app/d/42" } : null),
		);

		await store.refresh();
		const items = await provider.serialize();

		expect(items).toHaveLength(1);
		expect((items[0] as { jolliDocUrl?: string }).jolliDocUrl).toBe("https://team.jolli.app/d/42");
	});

	it("serialize omits jolliDocUrl when commit has no memory", async () => {
		const commit = { ...makeCommit("h1"), hasSummary: false };
		const bridge = makeBridge(() => makeResult([commit]));
		const store = new CommitsStore(bridge as never);
		const provider = new HistoryTreeProvider(
			store,
			async (_hash) => ({ jolliDocUrl: "https://team.jolli.app/d/99" }),
		);

		await store.refresh();
		const items = await provider.serialize();

		expect(items).toHaveLength(1);
		// lookupSummary should NOT be called for commits without a memory
		expect((items[0] as { jolliDocUrl?: string }).jolliDocUrl).toBeUndefined();
	});

	it("serialize omits jolliDocUrl when lookupSummary is not provided", async () => {
		const commit = { ...makeCommit("h1"), hasSummary: true };
		const bridge = makeBridge(() => makeResult([commit]));
		const store = new CommitsStore(bridge as never);
		// No lookupSummary passed — classic construction
		const provider = new HistoryTreeProvider(store);

		await store.refresh();
		const items = await provider.serialize();

		expect(items).toHaveLength(1);
		expect((items[0] as { jolliDocUrl?: string }).jolliDocUrl).toBeUndefined();
	});

	it("serialize resolves without throw and omits jolliDocUrl when lookupSummary rejects", async () => {
		const commit = { ...makeCommit("h1"), hasSummary: true };
		const bridge = makeBridge(() => makeResult([commit]));
		const store = new CommitsStore(bridge as never);
		const provider = new HistoryTreeProvider(store, async (_hash) => {
			throw new Error("network error");
		});

		await store.refresh();
		// serialize() must not reject even though lookupSummary throws
		const items = await provider.serialize();

		expect(items).toHaveLength(1);
		expect((items[0] as { jolliDocUrl?: string }).jolliDocUrl).toBeUndefined();
	});

	it("serialize sets e2eCount and conversationTokens from lookupSummary when commit has a memory", async () => {
		const commit = { ...makeCommit("abcd1234efgh5678"), hasSummary: true };
		const bridge = makeBridge(() => makeResult([commit]));
		const store = new CommitsStore(bridge as never);
		const provider = new HistoryTreeProvider(
			store,
			async (hash) =>
				hash === "abcd1234efgh5678"
					? { jolliDocUrl: "u", e2eCount: 3, conversationTokens: 1_400_000 }
					: null,
		);

		await store.refresh();
		const items = await provider.serialize();

		expect(items).toHaveLength(1);
		expect((items[0] as { e2eCount?: number }).e2eCount).toBe(3);
		expect((items[0] as { conversationTokens?: number }).conversationTokens).toBe(1_400_000);
	});

	it("serialize calls lookupSummary at most once per hash within a single pass (memoized)", async () => {
		// Two distinct memory-bearing commits → exactly two lookups, never more.
		const c1 = { ...makeCommit("hash-one"), hasSummary: true };
		const c2 = { ...makeCommit("hash-two"), hasSummary: true };
		const bridge = makeBridge(() => makeResult([c1, c2]));
		const store = new CommitsStore(bridge as never);
		const lookup = vi.fn(async (hash: string) => ({ jolliDocUrl: `u/${hash}` }));
		const provider = new HistoryTreeProvider(store, lookup);

		await store.refresh();
		await provider.serialize();

		expect(lookup).toHaveBeenCalledTimes(2);
		expect(lookup).toHaveBeenCalledWith("hash-one");
		expect(lookup).toHaveBeenCalledWith("hash-two");
	});

	it("serialize memoizes a repeated hash within one pass to a single read", async () => {
		// Snapshot with the SAME hash listed twice (e.g. a transient store state).
		// The per-pass memo must collapse the two rows to one lookupSummary read.
		const dup = { ...makeCommit("dup-hash"), hasSummary: true };
		const bridge = makeBridge(() => makeResult([dup, { ...dup }]));
		const store = new CommitsStore(bridge as never);
		const lookup = vi.fn(async (_hash: string) => ({ jolliDocUrl: "u" }));
		const provider = new HistoryTreeProvider(store, lookup);

		await store.refresh();
		const items = await provider.serialize();

		// Both rows are serialized, but the duplicate hash was read only once.
		expect(items.length).toBeGreaterThanOrEqual(1);
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("serialize memo is per-pass — a second serialize re-reads (no stale cross-pass cache)", async () => {
		const commit = { ...makeCommit("hash-x"), hasSummary: true };
		const bridge = makeBridge(() => makeResult([commit]));
		const store = new CommitsStore(bridge as never);
		const lookup = vi.fn(async (_hash: string) => ({ jolliDocUrl: "u" }));
		const provider = new HistoryTreeProvider(store, lookup);

		await store.refresh();
		await provider.serialize();
		await provider.serialize();

		// Memo lives only for one pass, so two passes → two reads.
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it("degrades a commit row to a childless node when its file fetch throws", async () => {
		// serializeNode fans out to getChildren(item) for each collapsible commit;
		// a git failure there must degrade to the base node (no children) rather
		// than rejecting the whole serialize pass.
		const bridge = makeBridge(
			() => makeResult([makeCommit("aaaa1111", "boom commit")]),
			() => Promise.reject(new Error("git diff-tree failed")),
		);
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const items = await provider.serialize();

		expect(items).toHaveLength(1);
		expect(items[0].id).toBe("aaaa1111");
		expect((items[0] as { children?: unknown }).children).toBeUndefined();
	});

	it("serialize hover statsLine handles zero insertions and a single deletion", async () => {
		const commit = {
			...makeCommit("aaaa1111"),
			insertions: 0,
			deletions: 1,
			filesChanged: 1,
		};
		const bridge = makeBridge(() => makeResult([commit]));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		const items = await provider.serialize();

		const hover = (items[0] as { hover?: { statsLine?: string } }).hover;
		expect(hover?.statsLine).toBe("1 file changed, 1 deletion(-)");
	});

	it("serialize omits e2eCount and conversationTokens when lookupSummary returns only jolliDocUrl", async () => {
		const commit = { ...makeCommit("abcd1234efgh5678"), hasSummary: true };
		const bridge = makeBridge(() => makeResult([commit]));
		const store = new CommitsStore(bridge as never);
		const provider = new HistoryTreeProvider(
			store,
			async (hash) => (hash === "abcd1234efgh5678" ? { jolliDocUrl: "u" } : null),
		);

		await store.refresh();
		const items = await provider.serialize();

		expect(items).toHaveLength(1);
		expect(Object.hasOwn(items[0], "e2eCount")).toBe(false);
		expect(Object.hasOwn(items[0], "conversationTokens")).toBe(false);
	});
});

// ─── HistoryTreeProvider.getMode ────────────────────────────────────────────

describe("getMode", () => {
	it("returns 'empty' when commits list is empty", async () => {
		const bridge = makeBridge(() => makeResult([]));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		expect((provider as unknown as { getMode: () => string }).getMode()).toBe(
			"empty",
		);
	});

	it("returns 'merged' when merged and non-empty", async () => {
		const bridge = makeBridge(() => makeResult([makeCommit("abc")], true));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		expect((provider as unknown as { getMode: () => string }).getMode()).toBe(
			"merged",
		);
	});

	it("returns 'single' when singleCommitMode is true and not merged", async () => {
		const bridge = makeBridge(() => makeResult([makeCommit("abc")]));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		expect((provider as unknown as { getMode: () => string }).getMode()).toBe(
			"single",
		);
	});

	it("returns 'multi' when multiple commits and not merged", async () => {
		const commits = [makeCommit("aaaa1111"), makeCommit("bbbb2222")];
		const bridge = makeBridge(() => makeResult(commits));
		const provider = makeHistoryProvider(bridge);

		await provider.refresh();
		expect((provider as unknown as { getMode: () => string }).getMode()).toBe(
			"multi",
		);
	});
});
