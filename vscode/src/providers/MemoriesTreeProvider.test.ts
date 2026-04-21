import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SummaryIndexEntry } from "../../../cli/src/Types.js";

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const {
	executeCommand,
	TreeItem,
	ThemeColor,
	ThemeIcon,
	EventEmitter,
	MarkdownString,
	formatShortRelativeDate,
	formatRelativeDate,
	escMd,
} = vi.hoisted(() => {
	const executeCommand = vi.fn().mockResolvedValue(undefined);
	class TreeItem {
		label: string;
		collapsibleState: number;
		id?: string;
		description?: string;
		iconPath?: unknown;
		contextValue?: string;
		tooltip?: unknown;
		command?: unknown;
		constructor(label: string, collapsibleState: number) {
			this.label = label;
			this.collapsibleState = collapsibleState;
		}
	}
	class ThemeColor {
		readonly id: string;
		constructor(id: string) {
			this.id = id;
		}
	}
	class ThemeIcon {
		readonly id: string;
		readonly color?: ThemeColor;
		constructor(id: string, color?: ThemeColor) {
			this.id = id;
			this.color = color;
		}
	}
	class EventEmitter {
		event = vi.fn();
		fire = vi.fn();
		dispose = vi.fn();
	}
	class MarkdownString {
		value: string;
		isTrusted = false;
		supportHtml = false;
		supportThemeIcons = false;
		constructor(value = "", supportThemeIcons = false) {
			this.value = value;
			this.supportThemeIcons = supportThemeIcons;
		}
		appendMarkdown(text: string) {
			this.value += text;
		}
	}
	return {
		executeCommand,
		TreeItem,
		ThemeColor,
		ThemeIcon,
		EventEmitter,
		MarkdownString,
		formatShortRelativeDate: vi.fn(() => "2d ago"),
		formatRelativeDate: vi.fn(() => "2 days ago"),
		escMd: vi.fn((s: string) => s),
	};
});

vi.mock("vscode", () => ({
	TreeItem,
	TreeItemCollapsibleState: { None: 0 },
	ThemeColor,
	ThemeIcon,
	EventEmitter,
	MarkdownString,
	commands: { executeCommand },
}));

vi.mock("../util/FormatUtils.js", () => ({
	formatShortRelativeDate,
	formatRelativeDate,
	escMd,
}));

vi.mock("../util/Logger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Import under test ─────────────────────────────────────────────────────

import { MemoriesTreeProvider, MemoryItem } from "./MemoriesTreeProvider.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(
	overrides: Partial<SummaryIndexEntry> = {},
): SummaryIndexEntry {
	return {
		commitHash: "abcdef1234567890",
		parentCommitHash: null,
		commitMessage: "Fix auth middleware",
		commitDate: "2026-04-08T12:00:00.000Z",
		branch: "feature/auth",
		generatedAt: "2026-04-08T12:05:00.000Z",
		topicCount: 3,
		diffStats: { filesChanged: 2, insertions: 10, deletions: 5 },
		...overrides,
	};
}

/**
 * Creates a mock bridge whose listSummaryEntries simulates bridge-side filtering.
 * When a filter argument is passed, it filters the entries array before returning.
 */
function makeBridge(
	entries: Array<SummaryIndexEntry> = [],
	totalCount?: number,
) {
	return {
		listSummaryEntries: vi.fn(
			(count: number, _offset?: number, filter?: string) => {
				let result = entries;
				if (filter) {
					const lower = filter.toLowerCase();
					result = entries.filter(
						(e) =>
							e.commitMessage.toLowerCase().includes(lower) ||
							e.branch.toLowerCase().includes(lower),
					);
				}
				return Promise.resolve({
					entries: result.slice(0, count),
					totalCount: totalCount ?? result.length,
				});
			},
		),
	};
}

// ─── MemoryItem ─────────────────────────────────────────────────────────────

describe("MemoryItem", () => {
	it("sets id, description, contextValue, and command correctly", () => {
		const entry = makeEntry();
		const item = new MemoryItem(entry);

		expect(item.id).toBe("memory-abcdef1234567890");
		expect(item.label).toBe("Fix auth middleware");
		expect(item.description).toBe("2d ago");
		expect(item.contextValue).toBe("memory");
		expect(item.command).toEqual({
			command: "jollimemory.viewMemorySummary",
			title: "View Commit Memory",
			arguments: [item],
		});
	});

	it("builds tooltip with markdown, commit message, branch, stats, and action links", () => {
		const item = new MemoryItem(makeEntry());
		const tooltip = item.tooltip as InstanceType<typeof MarkdownString>;

		expect(tooltip.isTrusted).toBe(true);
		// Row 1: bold commit message + relative date
		expect(tooltip.value).toContain("**Fix auth middleware**");
		expect(tooltip.value).toContain("$(clock)");
		// Branch row
		expect(tooltip.value).toContain("$(git-branch) feature/auth");
		// Stats
		expect(tooltip.value).toContain("3 topics");
		expect(tooltip.value).toContain("2 files changed");
		expect(tooltip.value).toContain("10 insertions(+)");
		expect(tooltip.value).toContain("5 deletions(-)");
		// Action links
		expect(tooltip.value).toContain("command:jollimemory.copyCommitHash");
		expect(tooltip.value).toContain("command:jollimemory.viewMemorySummary");
		expect(tooltip.value).toContain("`abcdef12`");
	});

	it("omits topic count when zero", () => {
		const item = new MemoryItem(makeEntry({ topicCount: 0 }));
		const tooltip = item.tooltip as InstanceType<typeof MarkdownString>;

		expect(tooltip.value).not.toContain("topic");
	});

	it("omits diff stats when absent", () => {
		const item = new MemoryItem(makeEntry({ diffStats: undefined }));
		const tooltip = item.tooltip as InstanceType<typeof MarkdownString>;

		expect(tooltip.value).not.toContain("file");
	});

	it("uses singular 'topic' when topicCount is 1", () => {
		const item = new MemoryItem(makeEntry({ topicCount: 1 }));
		const tooltip = item.tooltip as InstanceType<typeof MarkdownString>;

		expect(tooltip.value).toContain("1 topic,");
		expect(tooltip.value).not.toContain("1 topics");
	});

	it("uses singular 'file' when filesChanged is 1", () => {
		const item = new MemoryItem(
			makeEntry({
				diffStats: { filesChanged: 1, insertions: 5, deletions: 3 },
			}),
		);
		const tooltip = item.tooltip as InstanceType<typeof MarkdownString>;

		expect(tooltip.value).toContain("1 file changed");
		expect(tooltip.value).not.toContain("1 files");
	});

	it("omits insertions when zero", () => {
		const item = new MemoryItem(
			makeEntry({
				diffStats: { filesChanged: 3, insertions: 0, deletions: 7 },
			}),
		);
		const tooltip = item.tooltip as InstanceType<typeof MarkdownString>;

		expect(tooltip.value).not.toContain("insertion");
		expect(tooltip.value).toContain("7 deletions(-)");
		expect(tooltip.value).toContain("3 files changed");
	});

	it("omits deletions when zero", () => {
		const item = new MemoryItem(
			makeEntry({
				diffStats: { filesChanged: 2, insertions: 4, deletions: 0 },
			}),
		);
		const tooltip = item.tooltip as InstanceType<typeof MarkdownString>;

		expect(tooltip.value).toContain("4 insertions(+)");
		expect(tooltip.value).not.toContain("deletion");
	});

	it("omits entire stats line when topicCount is 0 and diffStats is absent", () => {
		const item = new MemoryItem(
			makeEntry({ topicCount: 0, diffStats: undefined }),
		);
		const tooltip = item.tooltip as InstanceType<typeof MarkdownString>;

		// No stats row should be rendered at all
		expect(tooltip.value).not.toContain("topic");
		expect(tooltip.value).not.toContain("file");
		expect(tooltip.value).not.toContain("insertion");
		expect(tooltip.value).not.toContain("deletion");
	});

	it("uses singular forms when insertions and deletions are 1", () => {
		const item = new MemoryItem(
			makeEntry({
				diffStats: { filesChanged: 1, insertions: 1, deletions: 1 },
			}),
		);
		const tooltip = item.tooltip as InstanceType<typeof MarkdownString>;

		expect(tooltip.value).toContain("1 insertion(+)");
		expect(tooltip.value).not.toContain("1 insertions");
		expect(tooltip.value).toContain("1 deletion(-)");
		expect(tooltip.value).not.toContain("1 deletions");
	});

	it("treats undefined topicCount as zero", () => {
		const item = new MemoryItem(makeEntry({ topicCount: undefined }));
		const tooltip = item.tooltip as InstanceType<typeof MarkdownString>;

		expect(tooltip.value).not.toContain("topic");
	});

	it("shows commit type tag when present", () => {
		const item = new MemoryItem(makeEntry({ commitType: "squash" as never }));
		const tooltip = item.tooltip as InstanceType<typeof MarkdownString>;

		expect(tooltip.value).toContain("$(tag) squash");
	});

	it("escapes markdown via escMd for commit message and branch", () => {
		const entry = makeEntry({
			commitMessage: "Fix *bold* stuff",
			branch: "feature/test_branch",
		});
		new MemoryItem(entry);

		// escMd should have been called with the commit message and branch
		expect(escMd).toHaveBeenCalledWith("Fix *bold* stuff");
		expect(escMd).toHaveBeenCalledWith("feature/test_branch");
	});
});

// ─── MemoriesTreeProvider ───────────────────────────────────────────────────

describe("MemoriesTreeProvider", () => {
	beforeEach(() => {
		executeCommand.mockClear();
		formatShortRelativeDate.mockClear();
	});

	// ── refresh ──

	describe("refresh", () => {
		it("populates entries from bridge and sets loaded flag", async () => {
			const entries = [
				makeEntry(),
				makeEntry({ commitHash: "bbbb", commitMessage: "Second" }),
			];
			const bridge = makeBridge(entries);
			const provider = new MemoriesTreeProvider(bridge as never);

			await provider.refresh();

			expect(bridge.listSummaryEntries).toHaveBeenCalledWith(10, 0, undefined); // PAGE_SIZE, no filter
			const children = provider.getChildren();
			expect(children).toHaveLength(2);
			expect(children[0]).toBeInstanceOf(MemoryItem);
		});

		it("handles bridge errors gracefully with empty list", async () => {
			const bridge = {
				listSummaryEntries: vi.fn().mockRejectedValue(new Error("git failed")),
			};
			const provider = new MemoriesTreeProvider(bridge as never);

			await provider.refresh();

			expect(provider.getChildren()).toEqual([]);
		});

		it("handles non-Error rejections from bridge", async () => {
			const bridge = {
				listSummaryEntries: vi.fn().mockRejectedValue("string error"),
			};
			const provider = new MemoriesTreeProvider(bridge as never);

			await provider.refresh();

			expect(provider.getChildren()).toEqual([]);
		});

		it("passes filter to bridge and uses MAX_SEARCH_ENTRIES when filter is active", async () => {
			const entries = [
				makeEntry({ commitHash: "aaaa", commitMessage: "auth fix" }),
			];
			const bridge = makeBridge(entries, 1);
			const provider = new MemoriesTreeProvider(bridge as never);

			await provider.setFilter("auth");
			bridge.listSummaryEntries.mockClear();

			// Refresh while filter is active — passes filter to bridge with capped count
			await provider.refresh();

			expect(bridge.listSummaryEntries).toHaveBeenCalledWith(500, 0, "auth"); // MAX_SEARCH_ENTRIES
		});
	});

	// ── getChildren ──

	describe("getChildren", () => {
		it("returns [] when disabled", async () => {
			const bridge = makeBridge([makeEntry()]);
			const provider = new MemoriesTreeProvider(bridge as never);
			await provider.refresh();

			provider.setEnabled(false);

			expect(provider.getChildren()).toEqual([]);
		});

		it("returns [] when not yet loaded", () => {
			const bridge = makeBridge([makeEntry()]);
			const provider = new MemoriesTreeProvider(bridge as never);

			// No refresh called — loaded is still false
			expect(provider.getChildren()).toEqual([]);
		});

		it("returns [] when entries are empty", async () => {
			const bridge = makeBridge([]);
			const provider = new MemoriesTreeProvider(bridge as never);
			await provider.refresh();

			expect(provider.getChildren()).toEqual([]);
		});

		it("returns [] for child elements (flat list)", async () => {
			const bridge = makeBridge([makeEntry()]);
			const provider = new MemoriesTreeProvider(bridge as never);
			await provider.refresh();

			const children = provider.getChildren();
			expect(provider.getChildren(children[0])).toEqual([]);
		});

		it("appends LoadMoreItem when more entries exist and no filter", async () => {
			const entries = [makeEntry()];
			const bridge = makeBridge(entries, 20); // totalCount > loadedCount
			const provider = new MemoriesTreeProvider(bridge as never);
			await provider.refresh();

			const children = provider.getChildren();
			expect(children).toHaveLength(2); // 1 MemoryItem + 1 LoadMoreItem
			const loadMore = children[1];
			expect(loadMore.contextValue).toBe("memoryLoadMore");
		});

		it("omits LoadMoreItem when all entries are loaded", async () => {
			const entries = [makeEntry()];
			const bridge = makeBridge(entries, 1); // totalCount === entries.length
			const provider = new MemoriesTreeProvider(bridge as never);
			await provider.refresh();

			const children = provider.getChildren();
			expect(children).toHaveLength(1);
			expect(children[0]).toBeInstanceOf(MemoryItem);
		});

		it("omits LoadMoreItem when filter is active", async () => {
			const entries = [makeEntry()];
			const bridge = makeBridge(entries, 20);
			const provider = new MemoriesTreeProvider(bridge as never);
			await provider.refresh();
			await provider.setFilter("auth");

			const children = provider.getChildren();
			for (const child of children) {
				expect(child.contextValue).not.toBe("memoryLoadMore");
			}
		});
	});

	// ── setFilter ──

	describe("setFilter", () => {
		it("passes filter to bridge for server-side filtering", async () => {
			const entries = [
				makeEntry({
					commitHash: "aaaa",
					commitMessage: "Fix Auth bug",
					branch: "feature/auth",
				}),
				makeEntry({
					commitHash: "bbbb",
					commitMessage: "Update biome config",
					branch: "main",
				}),
			];
			const bridge = makeBridge(entries);
			const provider = new MemoriesTreeProvider(bridge as never);

			await provider.setFilter("auth");

			// Bridge should receive filter param
			expect(bridge.listSummaryEntries).toHaveBeenCalledWith(500, 0, "auth");
			const children = provider.getChildren() as Array<MemoryItem>;
			expect(children).toHaveLength(1);
			expect(children[0].entry.commitHash).toBe("aaaa");
		});

		it("filters by branch name via bridge", async () => {
			const entries = [
				makeEntry({ commitHash: "aaaa", branch: "feature/auth" }),
				makeEntry({ commitHash: "bbbb", branch: "main" }),
			];
			const bridge = makeBridge(entries);
			const provider = new MemoriesTreeProvider(bridge as never);

			await provider.setFilter("feature");

			const children = provider.getChildren() as Array<MemoryItem>;
			expect(children).toHaveLength(1);
			expect(children[0].entry.commitHash).toBe("aaaa");
		});

		it("clearing filter restores paged view", async () => {
			const bridge = makeBridge([makeEntry()], 1);
			const provider = new MemoriesTreeProvider(bridge as never);
			await provider.setFilter("auth");
			bridge.listSummaryEntries.mockClear();

			await provider.setFilter("");

			// Should call with PAGE_SIZE and no filter
			expect(bridge.listSummaryEntries).toHaveBeenCalledWith(10, 0, undefined);
		});

		it("updates view description with filter result count", async () => {
			const bridge = makeBridge([makeEntry()], 1);
			const provider = new MemoriesTreeProvider(bridge as never);
			const mockView = { description: undefined as string | undefined };
			provider.setView(mockView as never);

			await provider.setFilter("auth");

			expect(mockView.description).toContain('"auth"');
			expect(mockView.description).toContain("result");
		});

		it("returns current filter via getFilter()", async () => {
			const bridge = makeBridge([makeEntry()], 1);
			const provider = new MemoriesTreeProvider(bridge as never);

			await provider.setFilter("biome");

			expect(provider.getFilter()).toBe("biome");
		});
	});

	// ── loadMore ──

	describe("loadMore", () => {
		it("increments loadedCount by PAGE_SIZE and re-fetches", async () => {
			const bridge = makeBridge([makeEntry()], 30);
			const provider = new MemoriesTreeProvider(bridge as never);
			await provider.refresh();
			bridge.listSummaryEntries.mockClear();

			await provider.loadMore();

			// Should have fetched with loadedCount = 10 + 10 = 20, no filter
			expect(bridge.listSummaryEntries).toHaveBeenCalledWith(20, 0, undefined);
		});
	});

	// ── setEnabled ──

	describe("setEnabled", () => {
		it("is idempotent — no-op when value unchanged", () => {
			const bridge = makeBridge([makeEntry()]);
			const provider = new MemoriesTreeProvider(bridge as never);
			const emitter = (
				provider as unknown as {
					_onDidChangeTreeData: { fire: ReturnType<typeof vi.fn> };
				}
			)._onDidChangeTreeData;

			provider.setEnabled(true); // default is true

			expect(emitter.fire).not.toHaveBeenCalled();
		});

		it("fires tree change event on transition", () => {
			const bridge = makeBridge([makeEntry()]);
			const provider = new MemoriesTreeProvider(bridge as never);
			const emitter = (
				provider as unknown as {
					_onDidChangeTreeData: { fire: ReturnType<typeof vi.fn> };
				}
			)._onDidChangeTreeData;

			provider.setEnabled(false);

			expect(emitter.fire).toHaveBeenCalledWith(undefined);
		});
	});

	// ── getTreeItem ──

	describe("getTreeItem", () => {
		it("returns the element itself", async () => {
			const bridge = makeBridge([makeEntry()]);
			const provider = new MemoriesTreeProvider(bridge as never);
			await provider.refresh();

			const children = provider.getChildren();
			expect(provider.getTreeItem(children[0])).toBe(children[0]);
		});
	});

	// ── view description ──

	describe("syncViewDescription", () => {
		it("shows total count when no filter", async () => {
			const bridge = makeBridge([makeEntry()], 5);
			const provider = new MemoriesTreeProvider(bridge as never);
			const mockView = { description: undefined as string | undefined };
			provider.setView(mockView as never);

			await provider.refresh();

			expect(mockView.description).toBe("5 memories");
		});

		it("uses plural 'results' when filter returns multiple matches", async () => {
			const entries = [
				makeEntry({ commitHash: "aaa1", commitMessage: "Fix auth login" }),
				makeEntry({ commitHash: "bbb2", commitMessage: "Fix auth session" }),
			];
			const bridge = makeBridge(entries, 2);
			const provider = new MemoriesTreeProvider(bridge as never);
			const mockView = { description: undefined as string | undefined };
			provider.setView(mockView as never);

			await provider.setFilter("auth");

			expect(mockView.description).toContain("2 results");
		});

		it("uses singular 'result' when filter returns exactly 1 match", async () => {
			const bridge = makeBridge([makeEntry()], 1);
			const provider = new MemoriesTreeProvider(bridge as never);
			const mockView = { description: undefined as string | undefined };
			provider.setView(mockView as never);

			await provider.setFilter("auth");

			expect(mockView.description).toContain("1 result");
			expect(mockView.description).not.toContain("1 results");
		});

		it("shows undefined when no entries", async () => {
			const bridge = makeBridge([], 0);
			const provider = new MemoriesTreeProvider(bridge as never);
			const mockView = { description: undefined as string | undefined };
			provider.setView(mockView as never);

			await provider.refresh();

			expect(mockView.description).toBeUndefined();
		});
	});
});
