/**
 * MemoriesTreeProvider
 *
 * TreeDataProvider for the "Memories" panel. Thin subscriber over MemoriesStore.
 *
 * Provider responsibilities (only):
 *  - subscribe to `store.onChange` → setContext('hasFilter', 'empty')
 *  - fire `onDidChangeTreeData` on every reason
 *  - render MemoryItem / LoadMoreItem from snapshot
 *
 * view.description is owned by Extension.ts (subscribes to store and writes
 * `memoriesView.description` via MemoriesDataService.buildDescription).
 * Provider does NOT hold a view reference.
 */

import * as vscode from "vscode";
import { getDisplayDate } from "../../../cli/src/core/SummaryFormat.js";
import type { SummaryIndexEntry } from "../../../cli/src/Types.js";
import type { MemoriesStore } from "../stores/MemoriesStore.js";
import {
	escMd,
	formatRelativeDate,
	formatShortRelativeDate,
} from "../util/FormatUtils.js";

const EMPTY_CONTEXT = "jollimemory.memories.empty";
const HAS_FILTER_CONTEXT = "jollimemory.memories.hasFilter";

// ─── Helper functions ────────────────────────────────────────────────────────

function buildDescription(entry: SummaryIndexEntry): string {
	return formatShortRelativeDate(getDisplayDate(entry));
}

function buildTooltip(entry: SummaryIndexEntry): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;

	const relativeDate = formatRelativeDate(getDisplayDate(entry));
	md.appendMarkdown(
		`**${escMd(entry.commitMessage)}**  $(clock) ${escMd(relativeDate)}\n\n`,
	);

	if (entry.commitType) {
		md.appendMarkdown(`$(tag) ${escMd(entry.commitType)}\n\n`);
	}

	md.appendMarkdown(`$(git-branch) ${escMd(entry.branch)}\n\n`);
	md.appendMarkdown("---\n\n");

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

	md.appendMarkdown("---\n\n");

	const hashArg = encodeURIComponent(JSON.stringify([entry.commitHash]));
	const copyLink = `[$(git-commit) \`${shortHash}\` $(copy)](command:jollimemory.copyCommitHash?${hashArg})`;
	const viewLink = `[$(eye) View Commit Memory](command:jollimemory.viewMemorySummary?${hashArg})`;
	md.appendMarkdown(`${copyLink}  |  ${viewLink}`);

	return md;
}

// ─── Tree node types ─────────────────────────────────────────────────────────

export class MemoryItem extends vscode.TreeItem {
	readonly entry: SummaryIndexEntry;

	constructor(entry: SummaryIndexEntry) {
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
	implements vscode.TreeDataProvider<MemoriesTreeItem>, vscode.Disposable
{
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		MemoriesTreeItem | undefined | null
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly unsubscribe: () => void;

	constructor(private readonly store: MemoriesStore) {
		this.unsubscribe = store.onChange((snap) => {
			void vscode.commands.executeCommand(
				"setContext",
				HAS_FILTER_CONTEXT,
				snap.hasFilter,
			);
			void vscode.commands.executeCommand(
				"setContext",
				EMPTY_CONTEXT,
				snap.isEmpty,
			);
			this._onDidChangeTreeData.fire(undefined);
		});
	}

	getTreeItem(element: MemoriesTreeItem): MemoriesTreeItem {
		return element;
	}

	getChildren(element?: MemoriesTreeItem): Array<MemoriesTreeItem> {
		if (element) {
			return [];
		}
		const snap = this.store.getSnapshot();
		if (!snap.isEnabled || !snap.firstLoadDone || snap.entries.length === 0) {
			return [];
		}

		const items: Array<MemoriesTreeItem> = [];
		for (const entry of snap.entries) {
			items.push(new MemoryItem(entry));
		}
		if (snap.canLoadMore) {
			items.push(new LoadMoreItem());
		}
		return items;
	}

	dispose(): void {
		this.unsubscribe();
		this._onDidChangeTreeData.dispose();
	}
}
