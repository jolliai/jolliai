/**
 * KnowledgeBaseTreeProvider
 *
 * TreeDataProvider for the "Knowledge Base" panel. Shows the KB folder
 * as a file tree: branch folders → markdown files with C/P/N badges.
 *
 * Hides .jolli/ metadata. Displays readable titles from manifest.
 * Click commit files to open SummaryWebviewPanel; other files open in editor.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as vscode from "vscode";
import type { Manifest, ManifestEntry } from "../../../cli/src/core/KBTypes.js";

// ─── Tree node types ────────────────────────────────────────────────────────

export class KBFolderItem extends vscode.TreeItem {
	readonly fsPath: string;

	constructor(name: string, fsPath: string) {
		super(name, vscode.TreeItemCollapsibleState.Expanded);
		this.fsPath = fsPath;
		this.iconPath = vscode.ThemeIcon.Folder;
		this.contextValue = "kbFolder";
	}
}

export class KBFileItem extends vscode.TreeItem {
	readonly fsPath: string;
	readonly manifestEntry?: ManifestEntry;

	constructor(name: string, fsPath: string, entry?: ManifestEntry) {
		const displayName = entry?.title ?? name;
		super(displayName, vscode.TreeItemCollapsibleState.None);
		this.fsPath = fsPath;
		this.manifestEntry = entry;

		this.description =
			entry?.type === "commit"
				? "C"
				: entry?.type === "plan"
					? "P"
					: entry?.type === "note"
						? "N"
						: undefined;
		this.tooltip = new vscode.MarkdownString(
			`**${displayName}**\n\n\`${name}\``,
		);
		this.contextValue = entry ? `kbFile.${entry.type}` : "kbFile";
		this.iconPath = new vscode.ThemeIcon("file");

		if (entry?.type === "commit") {
			this.command = {
				command: "jollimemory.openKBCommitSummary",
				title: "View Commit Memory",
				arguments: [this],
			};
		} else if (fsPath.endsWith(".md")) {
			this.command = {
				command: "markdown.showPreview",
				title: "Preview Markdown",
				arguments: [vscode.Uri.file(fsPath)],
			};
		} else {
			this.command = {
				command: "vscode.open",
				title: "Open File",
				arguments: [vscode.Uri.file(fsPath)],
			};
		}
	}
}

export class KBWarningItem extends vscode.TreeItem {
	constructor(message: string) {
		super(message, vscode.TreeItemCollapsibleState.None);
		this.iconPath = new vscode.ThemeIcon(
			"warning",
			new vscode.ThemeColor("problemsWarningIcon.foreground"),
		);
		this.contextValue = "kbWarning";
	}
}

type KBTreeItem = KBFolderItem | KBFileItem | KBWarningItem;

// ─── Hidden/internal folder names to exclude ────────────────────────────────

const HIDDEN_DIRS = new Set([
	".jolli",
	"summaries",
	"transcripts",
	"plan-progress",
]);

function isHiddenOrInternal(name: string): boolean {
	return name.startsWith(".") || HIDDEN_DIRS.has(name);
}

function readManifest(jolliDir: string): Manifest {
	const path = join(jolliDir, "manifest.json");
	if (!existsSync(path)) return { version: 1, files: [] };
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Manifest;
	} catch {
		return { version: 1, files: [] };
	}
}

// ─── KnowledgeBaseTreeProvider ──────────────────────────────────────────────

export class KnowledgeBaseTreeProvider
	implements vscode.TreeDataProvider<KBTreeItem>, vscode.Disposable
{
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		KBTreeItem | undefined | null
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	kbRoot: string | undefined;
	private badgeMap = new Map<string, ManifestEntry>();
	private watcher: vscode.FileSystemWatcher | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	setKBRoot(kbRoot: string): void {
		this.kbRoot = kbRoot;
		this.setupWatcher();
		this.refresh();
	}

	refresh(): void {
		this.loadManifest();
		this.updateEmptyContext();
		this._onDidChangeTreeData.fire(undefined);
	}

	private setupWatcher(): void {
		// Dispose previous watcher if KB root changed
		if (this.watcher) {
			this.watcher.dispose();
		}
		if (!this.kbRoot) return;

		// Watch for any file changes in the KB folder
		const pattern = new vscode.RelativePattern(
			vscode.Uri.file(this.kbRoot),
			"**/*",
		);
		this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
		this.watcher.onDidCreate(() => this.refresh());
		this.watcher.onDidChange(() => this.refresh());
		this.watcher.onDidDelete(() => this.refresh());
		this.disposables.push(this.watcher);
	}

	private updateEmptyContext(): void {
		const isEmpty =
			!this.kbRoot ||
			!existsSync(this.kbRoot) ||
			this.readDir(this.kbRoot).length === 0;
		void vscode.commands.executeCommand(
			"setContext",
			"jollimemory.kb.empty",
			isEmpty,
		);
	}

	private loadManifest(): void {
		if (!this.kbRoot) return;
		this.badgeMap.clear();
		const manifest = readManifest(join(this.kbRoot, ".jolli"));
		for (const entry of manifest.files) {
			this.badgeMap.set(entry.path, entry);
		}
	}

	getTreeItem(element: KBTreeItem): KBTreeItem {
		return element;
	}

	getChildren(element?: KBTreeItem): KBTreeItem[] {
		if (!this.kbRoot || !existsSync(this.kbRoot)) return [];
		if (element) {
			return element instanceof KBFolderItem
				? this.readDir(element.fsPath)
				: [];
		}
		const items: KBTreeItem[] = [];
		// Show warning if shadow storage is out of sync
		const shadowStatus = join(this.kbRoot, ".jolli", "shadow-status.json");
		if (existsSync(shadowStatus)) {
			items.push(new KBWarningItem("⚠ KB out of sync — run migration to fix"));
		}
		items.push(...this.readDir(this.kbRoot));
		return items;
	}

	private readDir(dir: string): KBTreeItem[] {
		const root = this.kbRoot ?? dir;
		const items: KBTreeItem[] = [];

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			const folders = entries.filter(
				(e) => e.isDirectory() && !isHiddenOrInternal(e.name),
			);
			const files = entries.filter(
				(e) => e.isFile() && !e.name.startsWith(".") && e.name !== "index.json",
			);

			for (const folder of folders.sort((a, b) =>
				a.name.localeCompare(b.name),
			)) {
				items.push(new KBFolderItem(folder.name, join(dir, folder.name)));
			}

			for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
				const fullPath = join(dir, file.name);
				const relPath = relative(root, fullPath);
				const entry = this.badgeMap.get(relPath);
				items.push(new KBFileItem(file.name, fullPath, entry));
			}
		} catch {
			// Directory not accessible
		}

		return items;
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
		this._onDidChangeTreeData.dispose();
	}
}
