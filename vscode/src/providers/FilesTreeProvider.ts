/**
 * FilesTreeProvider
 *
 * TreeDataProvider for the "Changes" panel.
 *
 * UX design (GitHub Desktop model):
 * - All changed files are shown in a flat list, unchecked by default.
 * - Clicking a checkbox toggles an in-memory "selected" flag — no git commands are run.
 * - The git index is only modified at commit time (CommitCommand stages selected files).
 * - Clicking the row label opens file content (new files) or a diff view (modified files).
 * - Uses `resourceUri` so VSCode automatically applies file icons and M/A/D color decorations.
 * - Auto-refreshes when `.git/index` changes or any workspace file changes (edits).
 * - Files matching exclude patterns are hidden from the list and auto-deselected.
 */

import { basename } from "node:path";
import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { FileStatus } from "../Types.js";
import type { ExcludeFilterManager } from "../util/ExcludeFilterManager.js";

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
		// Without this, position-based matching causes checkbox clicks to target the wrong row.
		this.id = fileStatus.relativePath;

		// resourceUri enables VSCode's built-in file color/icon decoration (M=yellow, A=green, etc.)
		this.resourceUri = vscode.Uri.file(fileStatus.absolutePath);

		// Show the relative path as description for context
		this.description = fileStatus.relativePath;

		// Checkbox state (requires vscode 1.80+)
		this.checkboxState = fileStatus.isSelected
			? vscode.TreeItemCheckboxState.Checked
			: vscode.TreeItemCheckboxState.Unchecked;

		this.contextValue = "file";
		this.tooltip = fileStatus.relativePath;

		// Clicking the row opens file content or a diff view (checkbox click is handled separately)
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

	private files: Array<FileStatus> = [];
	private enabled = true;
	/** True while v1→v3 migration is in progress — getChildren() returns []. */
	private migrating = false;
	private readonly watcher: vscode.FileSystemWatcher;
	private readonly workspaceWatcher: vscode.FileSystemWatcher;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;

	/** Incremented on each refresh call; stale results are discarded. */
	private refreshSeq = 0;

	/**
	 * In-memory selection state (GitHub Desktop model).
	 * Checkbox clicks update this set; the git index is untouched until commit time.
	 */
	private readonly selectedPaths = new Set<string>();

	/**
	 * Cached display order: maps relativePath → position index.
	 * When refresh is called without reorder, files keep their cached positions
	 * to avoid visual jumping when staging/unstaging changes git status order.
	 */
	private fileOrder = new Map<string, number>();

	constructor(
		private readonly bridge: JolliMemoryBridge,
		workspaceRoot: string,
		private readonly excludeFilter: ExcludeFilterManager,
	) {
		// Watch .git/index for changes to auto-refresh after external git operations
		this.watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, ".git/index"),
		);
		this.watcher.onDidChange(() => this.scheduleDebouncedRefresh());
		this.watcher.onDidCreate(() => this.scheduleDebouncedRefresh());

		// Watch all workspace files to detect new/modified/deleted files in the working tree.
		// .git/index only changes on stage/unstage — editing a file doesn't trigger it.
		// Debounced to avoid rapid refresh storms on bulk file changes (e.g. switching branches).
		this.workspaceWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, "**/*"),
		);
		const handleWorkspaceChange = (uri: vscode.Uri) => {
			// Skip git internal files to avoid feedback loops with the .git/index watcher above
			const p = uri.fsPath;
			if (p.includes("/.git/") || p.includes("\\.git\\")) {
				return;
			}
			this.scheduleDebouncedRefresh();
		};
		this.workspaceWatcher.onDidChange(handleWorkspaceChange);
		this.workspaceWatcher.onDidCreate(handleWorkspaceChange);
		this.workspaceWatcher.onDidDelete(handleWorkspaceChange);
	}

	/** Toggles the migrating state. While true, getChildren() returns []. */
	setMigrating(migrating: boolean): void {
		if (this.migrating === migrating) {
			return;
		}
		this.migrating = migrating;
		this._onDidChangeTreeData.fire();
	}

	/**
	 * Syncs the enabled state. When disabled, getChildren() returns an empty
	 * array so the viewsWelcome entry shows instead of a file list.
	 * Skips the fire when the value hasn't changed — this prevents
	 * `refreshStatusBar()` from triggering a redundant full tree rebuild
	 * after every checkbox click.
	 */
	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		this._onDidChangeTreeData.fire();
	}

	/**
	 * Refreshes the file list from git.
	 *
	 * @param reorder - When true, resets the display order to the natural git
	 *   status order. When false (default), files keep their cached positions
	 *   to avoid visual jumping during stage/unstage operations.
	 */
	async refresh(reorder = false): Promise<void> {
		const seq = ++this.refreshSeq;
		const newFiles = await this.bridge.listFiles();

		// A newer refresh was started while we were awaiting — discard stale result
		if (seq !== this.refreshSeq) {
			return;
		}

		// Overlay in-memory selection state onto the fresh file list.
		// Files no longer in git status are pruned from selectedPaths.
		const currentPaths = new Set(newFiles.map((f) => f.relativePath));
		for (const p of this.selectedPaths) {
			if (!currentPaths.has(p)) {
				this.selectedPaths.delete(p);
			}
		}
		const merged = newFiles.map((f) =>
			this.selectedPaths.has(f.relativePath) ? { ...f, isSelected: true } : f,
		);

		if (reorder || this.fileOrder.size === 0) {
			this.files = merged;
		} else {
			this.files = this.stableSort(merged);
		}
		this.rebuildFileOrder();
		this._onDidChangeTreeData.fire();
	}

	/** Notifies the tree view to re-render without re-fetching from git. */
	fireChange(): void {
		this._onDidChangeTreeData.fire();
	}

	/** Returns all currently-shown file statuses (used by CommitCommand). */
	getFiles(): Array<FileStatus> {
		return this.files;
	}

	/**
	 * Returns only the files that are currently selected (checked) AND visible.
	 * Excluded files are filtered out so they can never leak into a commit,
	 * even if they were selected before an exclude pattern was added.
	 */
	getSelectedFiles(): Array<FileStatus> {
		return this.files.filter(
			(f) => f.isSelected && !this.excludeFilter.isExcluded(f.relativePath),
		);
	}

	/** Deselects files matching the given paths (used by exclude filter). */
	deselectPaths(paths: ReadonlyArray<string>): void {
		for (const p of paths) {
			this.selectedPaths.delete(p);
		}
		const pathSet = new Set(paths);
		this.files = this.files.map((f) =>
			pathSet.has(f.relativePath) ? { ...f, isSelected: false } : f,
		);
	}

	/** Returns the number of files currently hidden by the exclude filter. */
	getExcludedCount(): number {
		return this.files.filter((f) =>
			this.excludeFilter.isExcluded(f.relativePath),
		).length;
	}

	/** Returns the number of files currently visible (not hidden by the exclude filter). */
	getVisibleFileCount(): number {
		if (!this.excludeFilter.hasPatterns()) {
			return this.files.length;
		}
		return this.files.filter(
			(f) => !this.excludeFilter.isExcluded(f.relativePath),
		).length;
	}

	/**
	 * Handles a checkbox toggle event from the tree view.
	 * Pure in-memory operation — no git commands are run.
	 */
	onCheckboxToggle(item: FileItem, checked: boolean): void {
		this.onCheckboxToggleBatch([[item, checked]]);
	}

	/**
	 * Handles a batch of checkbox toggle events.
	 * Updates the in-memory selection set; the git index is not touched.
	 *
	 * Does NOT fire `_onDidChangeTreeData` — VS Code has already toggled the
	 * checkbox visually. A full tree rebuild here would cause the panel to
	 * flash and the selection (focus border) to jump to the previously-focused
	 * row. The caller (Extension.ts) is responsible for updating the badge.
	 */
	onCheckboxToggleBatch(
		items: ReadonlyArray<readonly [FileItem, boolean]>,
	): void {
		for (const [item, checked] of items) {
			const path = item.fileStatus.relativePath;
			if (checked) {
				this.selectedPaths.add(path);
			} else {
				this.selectedPaths.delete(path);
			}
		}
		// Update the in-memory file list to reflect the new selection.
		const updateMap = new Map(
			items.map(([item, checked]) => [item.fileStatus.relativePath, checked]),
		);
		this.files = this.files.map((f) => {
			const target = updateMap.get(f.relativePath);
			return target !== undefined ? { ...f, isSelected: target } : f;
		});
	}

	/**
	 * Selects or deselects all visible (non-excluded) files.
	 * - If all visible files are already selected → deselect all visible.
	 * - Otherwise → select all visible.
	 * Pure in-memory operation — no git commands are run.
	 */
	toggleSelectAll(): void {
		const visibleFiles = this.getVisibleFiles();
		const allSelected =
			visibleFiles.length > 0 && visibleFiles.every((f) => f.isSelected);
		const targetSelected = !allSelected;

		for (const f of visibleFiles) {
			if (targetSelected) {
				this.selectedPaths.add(f.relativePath);
			} else {
				this.selectedPaths.delete(f.relativePath);
			}
		}

		this.files = this.files.map((f) => {
			if (this.selectedPaths.has(f.relativePath)) {
				return f.isSelected ? f : { ...f, isSelected: true };
			}
			return f.isSelected ? { ...f, isSelected: false } : f;
		});

		// Programmatic change — VS Code doesn't know about it, must fire.
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: FileItem): vscode.TreeItem {
		return element;
	}

	getChildren(): Array<FileItem> {
		if (!this.enabled || this.migrating) {
			return [];
		}
		return this.getVisibleFiles().map((f) => new FileItem(f));
	}

	dispose(): void {
		this.watcher.dispose();
		this.workspaceWatcher.dispose();
		if (this.debounceTimer !== undefined) {
			clearTimeout(this.debounceTimer);
		}
	}

	// ── Private helpers ───────────────────────────────────────────────────

	/** Returns files not hidden by the exclude filter. */
	private getVisibleFiles(): Array<FileStatus> {
		if (!this.excludeFilter.hasPatterns()) {
			return this.files;
		}
		return this.files.filter(
			(f) => !this.excludeFilter.isExcluded(f.relativePath),
		);
	}

	/**
	 * Sorts new files using cached positions: known files keep their order,
	 * new files are appended at the end.
	 */
	private stableSort(newFiles: Array<FileStatus>): Array<FileStatus> {
		const known: Array<FileStatus> = [];
		const added: Array<FileStatus> = [];

		for (const f of newFiles) {
			if (this.fileOrder.has(f.relativePath)) {
				known.push(f);
			} else {
				added.push(f);
			}
		}

		known.sort(
			(a, b) =>
				(this.fileOrder.get(a.relativePath) ?? 0) -
				(this.fileOrder.get(b.relativePath) ?? 0),
		);

		return [...known, ...added];
	}

	/** Rebuilds the position cache from the current file list. */
	private rebuildFileOrder(): void {
		this.fileOrder.clear();
		for (let i = 0; i < this.files.length; i++) {
			this.fileOrder.set(this.files[i].relativePath, i);
		}
	}

	/**
	 * Schedules a debounced refresh to avoid rapid re-queries when many workspace
	 * files change at once (e.g. branch switch, bulk file save).
	 */
	private scheduleDebouncedRefresh(): void {
		if (this.debounceTimer !== undefined) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			this.refresh().catch(() => {
				/* Silently swallow — debounced refresh errors are non-critical */
			});
		}, 400);
	}
}
