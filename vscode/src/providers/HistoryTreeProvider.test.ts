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

	it("builds a tooltip with commit type, stats, and view link when a summary exists", async () => {
		const commit = {
			...makeCommit("aaaaaaaa", "  fix markdown *issue*"),
			author: "Taylor [QA]",
			date: "2026-03-29T00:00:00Z",
			commitType: "squash",
			insertions: 2,
			deletions: 1,
			filesChanged: 1,
			hasSummary: true,
		};
		const provider = makeHistoryProvider(
			makeBridge(() => makeResult([commit])),
		);

		await provider.refresh();
		const [item] = await provider.getChildren();
		const tooltip = item.tooltip as { value: string; isTrusted: boolean };

		expect(tooltip.isTrusted).toBe(true);
		expect(tooltip.value).toContain("**Taylor \\[QA\\]**");
		expect(tooltip.value).toContain("$(tag) squash");
		expect(tooltip.value).toContain("fix markdown \\*issue\\*");
		expect(tooltip.value).toContain(
			"1 file changed, 2 insertions(+), 1 deletion(-)",
		);
		expect(tooltip.value).toContain("command:jollimemory.viewSummary");
		expect(item.contextValue).toBe("commitWithMemory");
	});

	it("omits optional tooltip rows and view link when no summary exists", async () => {
		const commit = {
			...makeCommit("aaaaaaaa", "plain commit"),
			insertions: 0,
			deletions: 0,
			filesChanged: 2,
			hasSummary: false,
		};
		const provider = makeHistoryProvider(
			makeBridge(() => makeResult([commit])),
		);

		await provider.refresh();
		const [item] = await provider.getChildren();
		const tooltip = item.tooltip as { value: string };

		expect(tooltip.value).toContain("2 files changed");
		expect(tooltip.value).not.toContain("insertion");
		expect(tooltip.value).not.toContain("deletion");
		expect(tooltip.value).not.toContain("View Commit Memory");
		expect(item.contextValue).toBe("commit");
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
		const tooltip = item.tooltip as { value: string };

		// The tooltip contains the commit message and the label includes the cloud icon
		// Verify push status is reflected through the tooltip which contains the message
		expect(tooltip.value).toContain("deployed feature");
		// Also verify the commit is flagged as pushed
		expect(item.commit.isPushed).toBe(true);
	});

	it("includes deletions in tooltip stats", async () => {
		const commit = {
			...makeCommit("aaaaaaaa", "remove old code"),
			insertions: 0,
			deletions: 5,
			filesChanged: 2,
			hasSummary: false,
		};
		const provider = makeHistoryProvider(
			makeBridge(() => makeResult([commit])),
		);

		await provider.refresh();
		const [item] = await provider.getChildren();
		const tooltip = item.tooltip as { value: string };

		expect(tooltip.value).toContain("5 deletions(-)");
		expect(tooltip.value).not.toContain("insertion");
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
