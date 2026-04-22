/**
 * FilesStore — host-side state controller for the "Changes" panel.
 *
 * Owns:
 *  - the latest raw file list from `bridge.listFiles()`
 *  - in-memory selection set (GitHub Desktop model — git index untouched)
 *  - display-order cache (stable sort across refreshes)
 *  - migrating / enabled flags
 *  - two FileSystemWatchers (.git/index + workspace/**)
 *
 * Broadcasts `FilesSnapshot` via `onChange`. Each snapshot carries a
 * `changeReason` so TreeProviders can skip re-render on `userCheckbox` (VSCode
 * has already painted the checkbox) while Webview / badge consumers react to
 * every change regardless.
 */

import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import {
	type ExcludePredicate,
	FilesDataService,
} from "../services/data/FilesDataService.js";
import type { FileStatus } from "../Types.js";
import type { ExcludeFilterManager } from "../util/ExcludeFilterManager.js";
import { BaseStore, type Snapshot } from "./BaseStore.js";

export type FilesChangeReason =
	| "init"
	| "refresh"
	| "selectAll"
	| "userCheckbox"
	| "excludeFilter"
	| "migrating"
	| "enabled"
	| "deselect";

export interface FilesSnapshot extends Snapshot<FilesChangeReason> {
	/** Full list after selection overlay + sort (pre-exclude). */
	readonly files: ReadonlyArray<FileStatus>;
	/** Files not hidden by the exclude filter. */
	readonly visibleFiles: ReadonlyArray<FileStatus>;
	/** Selected AND visible (safe input for commit). */
	readonly selectedFiles: ReadonlyArray<FileStatus>;
	/** Count of files hidden by the exclude filter. */
	readonly excludedCount: number;
	readonly visibleCount: number;
	readonly isEmpty: boolean;
	readonly isMigrating: boolean;
	readonly isEnabled: boolean;
}

const EMPTY: FilesSnapshot = {
	files: [],
	visibleFiles: [],
	selectedFiles: [],
	excludedCount: 0,
	visibleCount: 0,
	isEmpty: true,
	isMigrating: false,
	isEnabled: true,
	changeReason: "init",
};

const DEBOUNCE_MS = 400;

export class FilesStore extends BaseStore<FilesChangeReason, FilesSnapshot> {
	private snapshot: FilesSnapshot = EMPTY;
	/** Latest bridge output, before selection overlay / sort / exclude. */
	private rawFiles: ReadonlyArray<FileStatus> = [];
	private readonly selectedPaths = new Set<string>();
	private fileOrder = new Map<string, number>();
	private enabled = true;
	private migrating = false;
	private refreshSeq = 0;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly excludePredicate: ExcludePredicate;

	constructor(
		private readonly bridge: JolliMemoryBridge,
		workspaceRoot: string,
		private readonly excludeFilter: ExcludeFilterManager,
	) {
		super();

		this.excludePredicate = {
			hasPatterns: () => this.excludeFilter.hasPatterns(),
			isExcluded: (p) => this.excludeFilter.isExcluded(p),
		};

		// .git/index watcher — stage/unstage triggers refresh.
		const indexWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, ".git/index"),
		);
		indexWatcher.onDidChange(() => this.scheduleDebouncedRefresh());
		indexWatcher.onDidCreate(() => this.scheduleDebouncedRefresh());
		this.disposables.push(indexWatcher);

		// Workspace watcher — any working-tree change (except .git/ internals).
		const wsWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, "**/*"),
		);
		const onChange = (uri: vscode.Uri) => {
			const p = uri.fsPath;
			if (p.includes("/.git/") || p.includes("\\.git\\")) {
				return;
			}
			this.scheduleDebouncedRefresh();
		};
		wsWatcher.onDidChange(onChange);
		wsWatcher.onDidCreate(onChange);
		wsWatcher.onDidDelete(onChange);
		this.disposables.push(wsWatcher);
	}

	protected getCurrentSnapshot(): FilesSnapshot {
		return this.snapshot;
	}

	// ── Reads ─────────────────────────────────────────────────────────────────

	getSelectedPaths(): ReadonlySet<string> {
		return this.selectedPaths;
	}

	// ── Mutations ─────────────────────────────────────────────────────────────

	async refresh(reorder = false): Promise<void> {
		const seq = ++this.refreshSeq;
		const raw = await this.bridge.listFiles();
		if (seq !== this.refreshSeq) {
			return;
		}

		// Prune stale selections: files no longer in git status.
		const currentPaths = new Set(raw.map((f) => f.relativePath));
		for (const p of [...this.selectedPaths]) {
			if (!currentPaths.has(p)) {
				this.selectedPaths.delete(p);
			}
		}

		// Seed selection from any `isSelected: true` entries returned by the
		// bridge.  In production the bridge always returns `isSelected: false`
		// because selection is host-side UI state, but callers (and tests) may
		// pre-populate the flag to bootstrap a "this file is selected" fixture.
		// Migrating those into `selectedPaths` keeps the legacy semantics and
		// keeps selection state centralized in the store.
		for (const f of raw) {
			if (f.isSelected) {
				this.selectedPaths.add(f.relativePath);
			}
		}

		this.rawFiles = raw;
		this.rebuildSnapshot({ reorder, reason: "refresh" });
	}

	/**
	 * User-driven checkbox batch (from `filesView.onDidChangeCheckboxState`).
	 * Broadcasts with reason `"userCheckbox"` — provider does NOT fire TreeData
	 * to avoid full-tree rebuild flicker and focus-border jump.
	 */
	applyCheckboxBatch(
		items: ReadonlyArray<readonly [path: string, checked: boolean]>,
	): void {
		if (items.length === 0) {
			return;
		}
		for (const [path, checked] of items) {
			if (checked) {
				this.selectedPaths.add(path);
			} else {
				this.selectedPaths.delete(path);
			}
		}
		this.rebuildSnapshot({ reorder: false, reason: "userCheckbox" });
	}

	/** Programmatic select-all toggle (from the "Select All" button). */
	toggleSelectAll(): void {
		const visible = this.snapshot.visibleFiles;
		const allSelected =
			visible.length > 0 && visible.every((f) => f.isSelected);
		const target = !allSelected;
		for (const f of visible) {
			if (target) {
				this.selectedPaths.add(f.relativePath);
			} else {
				this.selectedPaths.delete(f.relativePath);
			}
		}
		this.rebuildSnapshot({ reorder: false, reason: "selectAll" });
	}

	/**
	 * Called after the exclude filter's patterns have changed. Prunes selected
	 * paths that are now excluded, then rebuilds the snapshot (bridge is NOT
	 * re-queried — rebuild only).
	 */
	applyExcludeFilterChange(): void {
		for (const f of this.rawFiles) {
			if (this.excludeFilter.isExcluded(f.relativePath)) {
				this.selectedPaths.delete(f.relativePath);
			}
		}
		this.rebuildSnapshot({ reorder: false, reason: "excludeFilter" });
	}

	/** Programmatic deselect of specific paths (e.g. after discard). */
	deselectPaths(paths: ReadonlyArray<string>): void {
		let changed = false;
		for (const p of paths) {
			if (this.selectedPaths.delete(p)) {
				changed = true;
			}
		}
		if (!changed) {
			return;
		}
		this.rebuildSnapshot({ reorder: false, reason: "deselect" });
	}

	setMigrating(m: boolean): void {
		if (this.migrating === m) {
			return;
		}
		this.migrating = m;
		this.rebuildSnapshot({ reorder: false, reason: "migrating" });
	}

	setEnabled(e: boolean): void {
		if (this.enabled === e) {
			return;
		}
		this.enabled = e;
		// Clear cached data on disable so downstream UI (badge, visible count,
		// "N files hidden" description) does not stick at the last enabled value
		// while the viewsWelcome placeholder is shown.  Re-enabling triggers a
		// fresh bridge refresh via refreshStatusBar / initialLoad, so the
		// throwaway here is recoverable.
		if (!e) {
			this.rawFiles = [];
			this.selectedPaths.clear();
			this.fileOrder.clear();
		}
		this.rebuildSnapshot({ reorder: false, reason: "enabled" });
	}

	// ── Internal ──────────────────────────────────────────────────────────────

	private rebuildSnapshot(opts: {
		reorder: boolean;
		reason: FilesChangeReason;
	}): void {
		const merged = FilesDataService.mergeWithSelection(
			this.rawFiles,
			this.selectedPaths,
		);
		const ordered =
			opts.reorder || this.fileOrder.size === 0
				? merged
				: FilesDataService.stableSort(merged, this.fileOrder);
		const { visible, excludedCount } = FilesDataService.applyExcludeFilter(
			ordered,
			this.excludePredicate,
		);
		this.fileOrder = FilesDataService.rebuildOrder(ordered);

		const selectedFiles = FilesDataService.selectedAndVisible(
			ordered,
			this.excludePredicate,
		);

		this.snapshot = {
			files: ordered,
			visibleFiles: visible,
			selectedFiles,
			excludedCount,
			visibleCount: visible.length,
			isEmpty: ordered.length === 0,
			isMigrating: this.migrating,
			isEnabled: this.enabled,
			changeReason: opts.reason,
		};
		this.emit();
	}

	private scheduleDebouncedRefresh(): void {
		if (this.debounceTimer !== undefined) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			this.refresh().catch(() => {
				// Non-critical — next user action will trigger another refresh.
			});
		}, DEBOUNCE_MS);
	}

	override dispose(): void {
		if (this.debounceTimer !== undefined) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
		super.dispose();
	}
}
