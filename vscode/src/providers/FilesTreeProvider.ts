/**
 * FilesTreeProvider
 *
 * TreeDataProvider for the "Changes" panel. Thin subscriber over `FilesStore`.
 *
 * Provider responsibilities (only):
 *  1. subscribe to `store.onChange` → `setContext("jollimemory.files.empty", ...)`
 *  2. fire `onDidChangeTreeData` on every reason. The sidebar webview consumes
 *     this event to push a fresh `branch:changesData` snapshot — including the
 *     `userCheckbox` reason, because the webview's toolbar disabled-state is
 *     derived from `branchData.changes[i].isSelected` and only refreshes when
 *     that snapshot is re-pushed. The legacy "skip on userCheckbox" guard
 *     existed to avoid native-TreeView flicker, but the native views were
 *     removed in commit e2aaf561.
 *  3. render a `FileItem` per snapshot entry in `getChildren`.
 *
 * The provider holds NO mutable state; all reads go through `store.getSnapshot()`.
 * Badge / title / view description are owned by Extension.ts, not this class.
 */

import { basename } from "node:path";
import * as vscode from "vscode";
import type { FilesStore } from "../stores/FilesStore.js";
import type { FileStatus } from "../Types.js";
import type { SerializedTreeItem } from "../views/SidebarMessages.js";
import { treeItemToSerialized } from "../views/SidebarSerialize.js";

// ─── FileItem tree node ───────────────────────────────────────────────────────

export class FileItem extends vscode.TreeItem {
	readonly fileStatus: FileStatus;

	constructor(fileStatus: FileStatus) {
		super(
			basename(fileStatus.relativePath),
			vscode.TreeItemCollapsibleState.None,
		);
		this.fileStatus = fileStatus;

		// Stable identity so VS Code correctly maps checkbox state across tree rebuilds.
		this.id = fileStatus.relativePath;
		this.resourceUri = vscode.Uri.file(fileStatus.absolutePath);
		this.description = fileStatus.relativePath;
		this.checkboxState = fileStatus.isSelected
			? vscode.TreeItemCheckboxState.Checked
			: vscode.TreeItemCheckboxState.Unchecked;
		this.contextValue = "file";
		this.tooltip = fileStatus.relativePath;
		this.command = {
			command: "jollimemory.openFileChange",
			title: "Open Change",
			arguments: [this],
		};
	}
}

// ─── FilesTreeProvider ────────────────────────────────────────────────────────

export class FilesTreeProvider
	implements vscode.TreeDataProvider<FileItem>, vscode.Disposable
{
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		FileItem | undefined | null | undefined
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly unsubscribe: () => void;

	constructor(private readonly store: FilesStore) {
		this.unsubscribe = store.onChange((snap) => {
			void vscode.commands.executeCommand(
				"setContext",
				"jollimemory.files.empty",
				snap.isEmpty,
			);
			this._onDidChangeTreeData.fire(undefined);
		});
	}

	getTreeItem(element: FileItem): vscode.TreeItem {
		return element;
	}

	getChildren(): Array<FileItem> {
		const snap = this.store.getSnapshot();
		if (!snap.isEnabled || snap.isMigrating) {
			return [];
		}
		return snap.visibleFiles.map((f) => new FileItem(f));
	}

	serialize(): ReadonlyArray<SerializedTreeItem> {
		return this.getChildren().map((it) => {
			const idHint =
				typeof it.resourceUri?.fsPath === "string"
					? it.resourceUri.fsPath
					: undefined;
			const base = treeItemToSerialized(it, idHint);
			return {
				...base,
				gitStatus: it.fileStatus.statusCode,
				isSelected: it.fileStatus.isSelected,
			};
		});
	}

	dispose(): void {
		this.unsubscribe();
		this._onDidChangeTreeData.dispose();
	}
}
