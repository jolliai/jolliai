/**
 * FilesTreeProvider
 *
 * TreeDataProvider for the "Changes" panel. Thin subscriber over `FilesStore`.
 *
 * Provider responsibilities (only):
 *  1. subscribe to `store.onChange` → `setContext("jollimemory.files.empty", ...)`
 *  2. fire `onDidChangeTreeData` EXCEPT when the change reason is `"userCheckbox"`
 *     (VSCode has already painted the checkbox; re-firing would cause a full
 *     tree rebuild, flicker, and focus-border jump).
 *  3. render a `FileItem` per snapshot entry in `getChildren`.
 *
 * The provider holds NO mutable state; all reads go through `store.getSnapshot()`.
 * Badge / title / view description are owned by Extension.ts, not this class.
 */

import { basename } from "node:path";
import * as vscode from "vscode";
import type { FilesStore } from "../stores/FilesStore.js";
import type { FileStatus } from "../Types.js";

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
			// userCheckbox: VSCode has already drawn the checkbox state — skipping
			// fire avoids a full-tree rebuild flicker and focus-border jump.
			if (snap.changeReason !== "userCheckbox") {
				this._onDidChangeTreeData.fire(undefined);
			}
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

	dispose(): void {
		this.unsubscribe();
		this._onDidChangeTreeData.dispose();
	}
}
