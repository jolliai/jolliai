/**
 * HistoryTreeProvider
 *
 * TreeDataProvider for the "Commits" panel. Thin subscriber over `CommitsStore`.
 *
 * Provider responsibilities (only):
 *  - subscribe to `store.onChange` → syncContextKeys(singleCommitMode, mergedMode, empty)
 *  - fire `onDidChangeTreeData` on every reason (`userCheckbox` is safe to fire
 *    here because the existing UX already fires on single-click range checks —
 *    the behaviour decision documented in the plan was "keep firing as before").
 *  - render CommitItem / CommitFileItem instances from snapshot + per-commit
 *    cached file lists.
 *
 * `historyView.title` is owned by Extension.ts (subscribes to the store and
 * writes `snap.isMerged ? "COMMITS (merged — read-only history)" : "COMMITS"`).
 */

import { basename } from "node:path";
import * as vscode from "vscode";
import type { CommitsStore } from "../stores/CommitsStore.js";
import type { BranchCommit, CommitFileInfo } from "../Types.js";
import { escMd, formatRelativeDate } from "../util/FormatUtils.js";

// ─── Commit-file decoration ─────────────────────────────────────────────────

export const COMMIT_FILE_SCHEME = "jollimemory-commit";

function statusToDecoration(
	status: string | null,
): vscode.FileDecoration | undefined {
	switch (status) {
		case "M":
			return new vscode.FileDecoration(
				"M",
				"Modified",
				new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
			);
		case "A":
			return new vscode.FileDecoration(
				"A",
				"Added",
				new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
			);
		case "D":
			return new vscode.FileDecoration(
				"D",
				"Deleted",
				new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
			);
		case "R":
			return new vscode.FileDecoration(
				"R",
				"Renamed",
				new vscode.ThemeColor("gitDecoration.renamedResourceForeground"),
			);
		default:
			return;
	}
}

export class CommitFileDecorationProvider
	implements vscode.FileDecorationProvider
{
	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== COMMIT_FILE_SCHEME) {
			return;
		}
		const params = new URLSearchParams(uri.query);
		return statusToDecoration(params.get("s"));
	}
}

const CONTEXT_WITH_MEMORY = "commitWithMemory";
const CONTEXT_NO_MEMORY = "commit";
const SINGLE_COMMIT_MODE_CONTEXT = "jollimemory.history.singleCommitMode";
const MERGED_MODE_CONTEXT = "jollimemory.history.mergedMode";
const EMPTY_CONTEXT = "jollimemory.history.empty";

// ─── CommitItem tree node ─────────────────────────────────────────────────────

export class CommitItem extends vscode.TreeItem {
	readonly commit: BranchCommit;

	constructor(
		commit: BranchCommit,
		checked: boolean | undefined,
		singleCommitMode: boolean,
	) {
		super(buildLabel(commit), vscode.TreeItemCollapsibleState.Collapsed);
		this.commit = commit;
		this.id = commit.hash;
		this.description = buildDescription(commit);
		if (checked !== undefined) {
			this.checkboxState = checked
				? vscode.TreeItemCheckboxState.Checked
				: vscode.TreeItemCheckboxState.Unchecked;
		}
		if (singleCommitMode) {
			this.iconPath = new vscode.ThemeIcon("git-commit");
		}
		this.contextValue = commit.hasSummary
			? CONTEXT_WITH_MEMORY
			: CONTEXT_NO_MEMORY;
		this.tooltip = buildTooltip(commit);
	}
}

// ─── CommitFileItem tree node ────────────────────────────────────────────────

export class CommitFileItem extends vscode.TreeItem {
	readonly commitHash: string;
	readonly relativePath: string;
	readonly statusCode: string;
	readonly oldPath?: string;

	constructor(commitHash: string, file: CommitFileInfo) {
		super(basename(file.relativePath), vscode.TreeItemCollapsibleState.None);
		this.commitHash = commitHash;
		this.relativePath = file.relativePath;
		this.statusCode = file.statusCode;
		this.oldPath = file.oldPath;

		this.id = `${commitHash}:${file.relativePath}`;
		this.description = file.relativePath;
		this.resourceUri = vscode.Uri.from({
			scheme: COMMIT_FILE_SCHEME,
			path: `/${file.relativePath}`,
			query: `s=${file.statusCode}`,
		});
		this.contextValue = "historyFile";
		this.command = {
			command: "jollimemory.openCommitFileChange",
			title: "Open Commit File Diff",
			arguments: [this],
		};
	}
}

// ─── HistoryTreeProvider ──────────────────────────────────────────────────────

export class HistoryTreeProvider
	implements
		vscode.TreeDataProvider<CommitItem | CommitFileItem>,
		vscode.Disposable
{
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		CommitItem | CommitFileItem | undefined | null
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly unsubscribe: () => void;

	constructor(private readonly store: CommitsStore) {
		this.unsubscribe = store.onChange((snap) => {
			void this.syncContextKeys(
				snap.isEnabled && snap.singleCommitMode,
				snap.isMerged,
				snap.isEnabled && snap.isEmpty,
			);
			this._onDidChangeTreeData.fire(undefined);
		});
	}

	getTreeItem(element: CommitItem | CommitFileItem): vscode.TreeItem {
		return element;
	}

	async getChildren(
		element?: CommitItem | CommitFileItem,
	): Promise<Array<CommitItem | CommitFileItem>> {
		if (element instanceof CommitFileItem) {
			return [];
		}
		if (element instanceof CommitItem) {
			const files = await this.store.getCommitFiles(element.commit.hash);
			return files.map((f) => new CommitFileItem(element.commit.hash, f));
		}
		const snap = this.store.getSnapshot();
		if (!snap.isEnabled || snap.isMigrating) {
			return [];
		}
		const hideCheckboxes = snap.singleCommitMode || snap.isMerged;
		return snap.commits.map(
			(c) =>
				new CommitItem(
					c,
					hideCheckboxes ? undefined : snap.selectedHashes.has(c.hash),
					snap.singleCommitMode,
				),
		);
	}

	private async syncContextKeys(
		singleCommitMode: boolean,
		mergedMode: boolean,
		empty: boolean,
	): Promise<void> {
		try {
			await Promise.all([
				vscode.commands.executeCommand(
					"setContext",
					SINGLE_COMMIT_MODE_CONTEXT,
					singleCommitMode,
				),
				vscode.commands.executeCommand(
					"setContext",
					MERGED_MODE_CONTEXT,
					mergedMode,
				),
				vscode.commands.executeCommand("setContext", EMPTY_CONTEXT, empty),
			]);
		} catch {
			// Ignore — tree rendering remains functional.
		}
	}

	dispose(): void {
		this.unsubscribe();
		this._onDidChangeTreeData.dispose();
	}
}

// ─── Label / description / tooltip helpers ────────────────────────────────────

function buildLabel(c: BranchCommit): string {
	const message = c.message.trimStart();
	return c.isPushed ? `${message} ☁` : message;
}

function buildDescription(c: BranchCommit): string {
	return c.shortDate;
}

function buildTooltip(c: BranchCommit): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;

	const relativeDate = formatRelativeDate(c.date);
	md.appendMarkdown(
		`**${escMd(c.author)}**  $(clock) ${escMd(relativeDate)}\n\n`,
	);

	if (c.commitType) {
		md.appendMarkdown(`$(tag) ${escMd(c.commitType)}\n\n`);
	}

	md.appendMarkdown(`${escMd(c.message)}\n\n`);
	md.appendMarkdown("---\n\n");

	const stats: Array<string> = [
		`${c.filesChanged} file${c.filesChanged !== 1 ? "s" : ""} changed`,
	];
	if (c.insertions > 0) {
		stats.push(`${c.insertions} insertion${c.insertions !== 1 ? "s" : ""}(+)`);
	}
	if (c.deletions > 0) {
		stats.push(`${c.deletions} deletion${c.deletions !== 1 ? "s" : ""}(-)`);
	}
	md.appendMarkdown(`${stats.join(", ")}\n\n`);

	md.appendMarkdown("---\n\n");

	const hashArg = encodeURIComponent(JSON.stringify([c.hash]));
	const copyLink = `[$(git-commit) \`${c.shortHash}\` $(copy)](command:jollimemory.copyCommitHash?${hashArg})`;

	if (c.hasSummary) {
		const viewLink = `[$(eye) View Commit Memory](command:jollimemory.viewSummary?${hashArg})`;
		md.appendMarkdown(`${copyLink}  |  ${viewLink}`);
	} else {
		md.appendMarkdown(copyLink);
	}

	return md;
}

// Re-exported helper (kept for backward compat with old test imports).
export function didCommitSequenceChange(
	previousHashes: ReadonlyArray<string>,
	nextHashes: ReadonlyArray<string>,
): boolean {
	if (previousHashes.length !== nextHashes.length) {
		return true;
	}
	return previousHashes.some((h, i) => h !== nextHashes[i]);
}
