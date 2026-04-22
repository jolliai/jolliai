/**
 * MemoriesTreeProvider
 *
 * TreeDataProvider for the "Memories" panel.
 * Lists recent commit summaries from the JolliMemory orphan branch index.
 *
 * Each memory renders as a single line:
 *   Harden git status parsing and fix...
 *
 * Branch, date, topics, and diff stats are shown in the hover tooltip.
 *
 * Features:
 * - Loads lightweight SummaryIndexEntry data (no full summary needed for list)
 * - Title bar search icon triggers InputBox; active filter shown in view description
 * - "Load More" node at the bottom when more entries exist
 * - Clicking an item (or its history icon) opens the commit summary
 * - Inline action: Copy Recall Prompt (📋)
 * - Right-click menu: Open in Claude Code
 */

import * as vscode from "vscode";
import { getDisplayDate } from "../../../cli/src/core/SummaryFormat.js";
import type { SummaryIndexEntry } from "../../../cli/src/Types.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import {
	escMd,
	formatRelativeDate,
	formatShortRelativeDate,
} from "../util/FormatUtils.js";
import { log } from "../util/Logger.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Number of entries loaded per batch. */
const PAGE_SIZE = 10;

/** Upper bound for entries loaded during search to keep memory bounded. */
const MAX_SEARCH_ENTRIES = 500;

const EMPTY_CONTEXT = "jollimemory.memories.empty";

// ─── Helper functions ────────────────────────────────────────────────────────

/** Builds the description: "1d ago" */
function buildDescription(entry: SummaryIndexEntry): string {
	return formatShortRelativeDate(getDisplayDate(entry));
}

/**
 * Builds a rich MarkdownString tooltip matching the commits panel format.
 *
 * Layout (mirrors HistoryTreeProvider.buildTooltip):
 *   **commitMessage**  $(clock) relative date
 *   $(tag) commitType           ← only if present
 *   $(git-branch) branch
 *   ───────────────────
 *   N topic(s), N file(s) changed, N insertion(s)(+), N deletion(s)(-)
 *   ───────────────────
 *   $(git-commit) `shortHash` $(copy)  |  $(eye) View Commit Memory
 */
function buildTooltip(entry: SummaryIndexEntry): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;

	// Row 1: commit message (bold) + clock + relative date
	const relativeDate = formatRelativeDate(getDisplayDate(entry));
	md.appendMarkdown(
		`**${escMd(entry.commitMessage)}** \u00a0$(clock) ${escMd(relativeDate)}\n\n`,
	);

	// Optional: commit type indicator (amend, squash, etc.)
	if (entry.commitType) {
		md.appendMarkdown(`$(tag) ${escMd(entry.commitType)}\n\n`);
	}

	// Row 2: branch
	md.appendMarkdown(`$(git-branch) ${escMd(entry.branch)}\n\n`);

	// Separator
	md.appendMarkdown("---\n\n");

	// Stats line: topics + diff stats
	const shortHash = entry.commitHash.substring(0, 8);
	const topicCount = entry.topicCount ?? 0;
	const stats: Array<string> = [];
	if (topicCount > 0) {
		stats.push(`${topicCount} topic${topicCount !== 1 ? "s" : ""}`);
	}
	if (entry.diffStats) {
		const { insertions, deletions, filesChanged } = entry.diffStats;
		stats.push(`${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed`);
		if (insertions > 0) {
			stats.push(`${insertions} insertion${insertions !== 1 ? "s" : ""}(+)`);
		}
		if (deletions > 0) {
			stats.push(`${deletions} deletion${deletions !== 1 ? "s" : ""}(-)`);
		}
	}
	if (stats.length > 0) {
		md.appendMarkdown(`${stats.join(", ")}\n\n`);
	}

	// Separator
	md.appendMarkdown("---\n\n");

	// Actions row: copy hash + view memory
	const hashArg = encodeURIComponent(JSON.stringify([entry.commitHash]));
	const copyLink = `[$(git-commit) \`${shortHash}\` $(copy)](command:jollimemory.copyCommitHash?${hashArg})`;
	const viewLink = `[$(eye) View Commit Memory](command:jollimemory.viewMemorySummary?${hashArg})`;
	md.appendMarkdown(`${copyLink}\u00a0 |\u00a0 ${viewLink}`);

	return md;
}

// ─── Tree node types ─────────────────────────────────────────────────────────

/** Represents a single memory (commit summary) — flat, no children. */
export class MemoryItem extends vscode.TreeItem {
	readonly entry: SummaryIndexEntry;

	constructor(entry: SummaryIndexEntry) {
		// Full label — VSCode auto-truncates with ellipsis based on panel width
		super(entry.commitMessage, vscode.TreeItemCollapsibleState.None);
		this.entry = entry;

		this.id = `memory-${entry.commitHash}`;
		this.iconPath = new vscode.ThemeIcon("history");
		this.description = buildDescription(entry);
		this.contextValue = "memory";
		this.tooltip = buildTooltip(entry);
		this.command = {
			command: "jollimemory.viewMemorySummary",
			title: "View Commit Memory",
			arguments: [this],
		};
	}
}

/** "Load More" link shown at the bottom of the list. */
class LoadMoreItem extends vscode.TreeItem {
	constructor() {
		super("Load More", vscode.TreeItemCollapsibleState.None);
		this.id = "memory-load-more";
		this.contextValue = "memoryLoadMore";
		this.description = "...";
		this.command = {
			command: "jollimemory.loadMoreMemories",
			title: "Load More Memories",
		};
	}
}

// ─── MemoriesTreeProvider ────────────────────────────────────────────────────

type MemoriesTreeItem = MemoryItem | LoadMoreItem;

export class MemoriesTreeProvider
	implements vscode.TreeDataProvider<MemoriesTreeItem>
{
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		MemoriesTreeItem | undefined | null
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private entries: Array<SummaryIndexEntry> = [];
	private totalCount = 0;
	private loadedCount = PAGE_SIZE;
	private filter = "";
	private enabled = true;
	/** True once the first data load has completed (lazy-load gate). */
	private loaded = false;
	/** Reference to the TreeView — set by Extension.ts for description updates. */
	private view: vscode.TreeView<MemoriesTreeItem> | undefined;

	constructor(private readonly bridge: JolliMemoryBridge) {}

	// ── Public API ──

	/** Stores the TreeView reference so we can update its description for filter state. */
	setView(view: vscode.TreeView<MemoriesTreeItem>): void {
		this.view = view;
	}

	/**
	 * Refreshes the memories list from the orphan branch index.
	 * Filtering is handled bridge-side so only matched entries are transferred.
	 */
	async refresh(): Promise<void> {
		try {
			const count = this.filter ? MAX_SEARCH_ENTRIES : this.loadedCount;
			const result = await this.bridge.listSummaryEntries(
				count,
				0,
				this.filter || undefined,
			);
			this.entries = [...result.entries];
			this.totalCount = result.totalCount;
		} catch (err: unknown) {
			log.warn(
				"MemoriesTreeProvider",
				"Failed to load entries: %s",
				err instanceof Error ? err.message : String(err),
			);
			this.entries = [];
			this.totalCount = 0;
		}
		this.loaded = true;
		await this.syncContextKeys();
		this.syncViewDescription();
		this._onDidChangeTreeData.fire(undefined);
	}

	/** Loads the next page of entries and appends to the list. */
	async loadMore(): Promise<void> {
		this.loadedCount += PAGE_SIZE;
		await this.refresh();
	}

	/**
	 * Sets or clears the search filter.
	 * Filtering is pushed to the bridge so only matched entries are returned.
	 */
	async setFilter(text: string): Promise<void> {
		const newFilter = text.trim();
		this.filter = newFilter;
		void vscode.commands.executeCommand(
			"setContext",
			"jollimemory.memories.hasFilter",
			newFilter.length > 0,
		);
		await this.refresh();
	}

	/** Returns the current filter text. */
	getFilter(): string {
		return this.filter;
	}

	/** Called when the extension enable/disable state changes. */
	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		this._onDidChangeTreeData.fire(undefined);
	}

	// ── TreeDataProvider ──

	getTreeItem(element: MemoriesTreeItem): MemoriesTreeItem {
		return element;
	}

	getChildren(element?: MemoriesTreeItem): Array<MemoriesTreeItem> {
		// Flat list — no children
		if (element) {
			return [];
		}

		// Root level — return [] so viewsWelcome handles disabled/empty states
		if (!this.enabled || !this.loaded || this.entries.length === 0) {
			return [];
		}

		const items: Array<MemoriesTreeItem> = [];

		for (const entry of this.entries) {
			items.push(new MemoryItem(entry));
		}

		// Load More if there are more entries available and no active filter
		if (!this.filter && this.loadedCount < this.totalCount) {
			items.push(new LoadMoreItem());
		}

		return items;
	}

	// ── Private helpers ──

	/** Updates the TreeView description to show the active filter or total count. */
	private syncViewDescription(): void {
		if (!this.view) {
			return;
		}
		if (this.filter) {
			const count = this.entries.length;
			this.view.description = `"${this.filter}" \u2014 ${count} result${count !== 1 ? "s" : ""}`;
		} else {
			this.view.description =
				this.totalCount > 0 ? `${this.totalCount} memories` : undefined;
		}
	}

	private async syncContextKeys(): Promise<void> {
		const hasEntries = this.entries.length > 0;
		await vscode.commands.executeCommand(
			"setContext",
			EMPTY_CONTEXT,
			!hasEntries,
		);
	}
}
