/**
 * HistoryTreeProvider
 *
 * TreeDataProvider for the "Branch Commits" panel.
 *
 * UX design:
 * - Lists commits on the current branch that are NOT in main.
 * - Ordered newest-first (HEAD at top).
 * - Checkboxes for squash selection with range semantics:
 *   checking commit X auto-checks all commits from X up to HEAD.
 * - ☁ badge on commits already pushed to remote.
 * - [👁] inline button opens the Commit Memory webview (only for commits with a summary).
 * - Description shows just the short date (e.g. "02-25").
 * - Rich MarkdownString tooltip with author, date, diff stats, full hash, and action links.
 */

import { basename } from "node:path";
import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { BranchCommit, CommitFileInfo } from "../Types.js";
import { escMd, formatRelativeDate } from "../util/FormatUtils.js";
import { log } from "../util/Logger.js";

// ─── Commit-file decoration ─────────────────────────────────────────────────

/**
 * Custom URI scheme for commit-file tree items.  Using a scheme other than
 * `file` prevents the built-in git extension's `GitDecorationProvider` from
 * matching (it keys on exact `file://` URI strings from the working tree).
 * Our own {@link CommitFileDecorationProvider} reads the per-commit status
 * code from the URI query string and returns the correct badge + colour.
 */
export const COMMIT_FILE_SCHEME = "jollimemory-commit";

/** Maps a single-letter git status to a VSCode file decoration. */
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

/**
 * Provides M/A/D/R badge decorations for commit-file tree items.
 * Only handles URIs with the {@link COMMIT_FILE_SCHEME} scheme.
 */
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

// contextValue used in package.json `when` clauses to show/hide inline actions.
// "commitWithMemory" → commit has a JolliMemory summary (shows View Commit Memory button).
// "commit"          → commit has no summary (hides View Commit Memory button).
const CONTEXT_WITH_MEMORY = "commitWithMemory";
const CONTEXT_NO_MEMORY = "commit";
const SINGLE_COMMIT_MODE_CONTEXT = "jollimemory.history.singleCommitMode";
const MERGED_MODE_CONTEXT = "jollimemory.history.mergedMode";
const EMPTY_CONTEXT = "jollimemory.history.empty";

function shortHash(hash: string | undefined): string | undefined {
	return hash ? hash.substring(0, 8) : undefined;
}

function shortHashes(hashes: ReadonlyArray<string>): Array<string> {
	return hashes.map((hash) => hash.substring(0, 8));
}

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

		// Stable identity so VSCode preserves expand/collapse state across refreshes.
		// Without this, VSCode falls back to label-based identity which breaks when
		// the label changes (e.g. ☁ badge added after push) or when duplicate messages exist.
		this.id = commit.hash;
		this.description = buildDescription(commit);
		if (checked !== undefined) {
			this.checkboxState = checked
				? vscode.TreeItemCheckboxState.Checked
				: vscode.TreeItemCheckboxState.Unchecked;
		}
		// VSCode tree rows always reserve a leading slot. In single-commit mode
		// we render a commit icon there so the row does not look like it has a
		// leftover blank area after hiding checkboxes.
		if (singleCommitMode) {
			this.iconPath = new vscode.ThemeIcon("git-commit");
		}
		// Use "commitWithMemory" so package.json can conditionally show the
		// View Commit Memory inline button only on commits that have a summary.
		this.contextValue = commit.hasSummary
			? CONTEXT_WITH_MEMORY
			: CONTEXT_NO_MEMORY;
		this.tooltip = buildTooltip(commit);
	}
}

// ─── CommitFileItem tree node ────────────────────────────────────────────────

/**
 * Tree node representing a single file changed in a commit.
 * Clicking opens the commit diff for this file.
 */
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
		// Custom scheme so the built-in git GitDecorationProvider (which keys on
		// file:// URIs) does NOT overlay the current working-tree status.  Our own
		// CommitFileDecorationProvider reads `?s=<status>` and applies the correct
		// per-commit badge + colour.  The path preserves the file extension so
		// VSCode's icon theme still resolves the correct file-type icon.
		this.resourceUri = vscode.Uri.from({
			scheme: COMMIT_FILE_SCHEME,
			path: `/${file.relativePath}`,
			query: `s=${file.statusCode}`,
		});
		// Must NOT start with "commit" — package.json uses viewItem =~ /^commit/
		// to match commit nodes. Starting with "commit" would cause commit-only
		// menu items (e.g. Copy Commit Hash) to appear on file nodes.
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

	private commits: Array<BranchCommit> = [];
	/** Set of hashes currently checked by the user. */
	private checkedHashes: Set<string> = new Set();
	/**
	 * Cache of files per commit hash. Stores the Promise (not the resolved value)
	 * so that concurrent getChildren() calls for the same commit share a single
	 * in-flight git subprocess instead of spawning duplicates.
	 * Commits are immutable (same hash = same files), so caching is always safe.
	 */
	private fileCache = new Map<string, Promise<Array<CommitFileInfo>>>();
	private enabled = true;
	/** True while v1→v3 migration is in progress — getChildren() returns []. */
	private migrating = false;
	/** True when the branch is fully merged into main (read-only history view). */
	private _isMerged = false;

	/** Exposes the merged state so consumers (e.g. Extension.ts) can update the view title/message. */
	get isMerged(): boolean {
		return this._isMerged;
	}

	/** The main branch name used to compute the fork point. */
	private mainBranch = "main";

	constructor(private readonly bridge: JolliMemoryBridge) {}

	/** Updates the main branch reference (used to filter commits). */
	setMainBranch(branch: string): void {
		this.mainBranch = branch;
	}

	/** Toggles the migrating state. While true, getChildren() returns []. */
	setMigrating(migrating: boolean): void {
		this.migrating = migrating;
		this._onDidChangeTreeData.fire();
	}

	/**
	 * Syncs the enabled state. When disabled, getChildren() returns an empty
	 * array so the viewsWelcome entry shows instead of a commit list.
	 */
	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		void this.syncContextKeys();
		this._onDidChangeTreeData.fire();
	}

	/** Refreshes the commit list from git. */
	async refresh(): Promise<void> {
		log.debug("commits", "refresh entered");
		const previousHashes = this.commits.map((c) => c.hash);
		const result = await this.bridge.listBranchCommits(this.mainBranch);
		log.debug(
			"commits",
			`listBranchCommits returned ${result.commits.length} commits, head=${shortHash(result.commits[0]?.hash) ?? "none"}`,
		);
		this.commits = [...result.commits];
		this._isMerged = result.isMerged;

		const nextHashes = this.commits.map((c) => c.hash);
		const sequenceChanged = didCommitSequenceChange(previousHashes, nextHashes);

		// Only clear the file cache when the commit sequence actually changed.
		// Commits are immutable (same hash = same files), so keeping the cache
		// across no-op refreshes avoids re-running git for already-expanded commits.
		if (sequenceChanged) {
			this.fileCache.clear();
		}

		// Clear all selections when the commit list changes (commit, amend, squash,
		// external rebase, etc.) — same as clearing table row selection after data refresh.
		let selectionCleared = false;
		if (sequenceChanged && this.checkedHashes.size > 0) {
			this.checkedHashes.clear();
			selectionCleared = true;
		}

		if (sequenceChanged) {
			log.debug("commits", "COMMITS panel refreshed", {
				previousHead: shortHash(previousHashes[0]),
				nextHead: shortHash(nextHashes[0]),
				commitCount: nextHashes.length,
				selectionCleared,
			});
		}
		await this.syncContextKeys();
		this._onDidChangeTreeData.fire();
	}

	/** Returns the commits currently selected for squash. */
	getSelectedCommits(): Array<BranchCommit> {
		return this.commits.filter((c) => this.checkedHashes.has(c.hash));
	}

	/** Returns all commits currently loaded. */
	getAllCommits(): Array<BranchCommit> {
		return this.commits;
	}

	/**
	 * Handles a checkbox toggle from the tree view.
	 *
	 * Range semantics:
	 * - Checking commit at index N → also check all commits from 0..N (HEAD..commit).
	 * - Unchecking commit at index N → also uncheck all commits from N..end (commit..oldest).
	 */
	onCheckboxToggle(item: CommitItem, checked: boolean): void {
		const index = this.commits.findIndex((c) => c.hash === item.commit.hash);
		if (index === -1) {
			return;
		}

		if (checked) {
			// Check this commit and everything newer (up to HEAD, index 0)
			for (let i = 0; i <= index; i++) {
				this.checkedHashes.add(this.commits[i].hash);
			}
		} else {
			// Uncheck this commit and everything older (from index to end)
			for (let i = index; i < this.commits.length; i++) {
				this.checkedHashes.delete(this.commits[i].hash);
			}
		}

		this._onDidChangeTreeData.fire();
	}

	/**
	 * Toggles the select-all state:
	 * - If any commits are checked → deselect all.
	 * - If none are checked → select all.
	 */
	toggleSelectAll(): void {
		if (this.checkedHashes.size > 0) {
			this.checkedHashes.clear();
		} else {
			for (const c of this.commits) {
				this.checkedHashes.add(c.hash);
			}
		}
		this._onDidChangeTreeData.fire();
	}

	getSelectionDebugInfo(): {
		checkedHashes: Array<string>;
		selectedCommits: Array<string>;
		staleCheckedHashes: Array<string>;
		commitCount: number;
		headHash?: string;
		tailHash?: string;
		isMerged: boolean;
	} {
		const validHashes = new Set(this.commits.map((c) => c.hash));
		const selectedCommits = this.commits
			.filter((c) => this.checkedHashes.has(c.hash))
			.map((c) => c.hash);
		const staleCheckedHashes = [...this.checkedHashes].filter(
			(hash) => !validHashes.has(hash),
		);
		return {
			checkedHashes: shortHashes([...this.checkedHashes]),
			selectedCommits: shortHashes(selectedCommits),
			staleCheckedHashes: shortHashes(staleCheckedHashes),
			commitCount: this.commits.length,
			headHash: shortHash(this.commits[0]?.hash),
			tailHash: shortHash(this.commits[this.commits.length - 1]?.hash),
			isMerged: this._isMerged,
		};
	}

	getTreeItem(element: CommitItem | CommitFileItem): vscode.TreeItem {
		return element;
	}

	async getChildren(
		element?: CommitItem | CommitFileItem,
	): Promise<Array<CommitItem | CommitFileItem>> {
		// File nodes are leaf nodes — no children
		if (element instanceof CommitFileItem) {
			return [];
		}

		// Expanding a commit → return its changed files
		if (element instanceof CommitItem) {
			return await this.getCommitFiles(element);
		}

		// Root call → return commit list
		if (!this.enabled || this.migrating) {
			return [];
		}
		const singleCommitMode = this.commits.length === 1;
		// Hide checkboxes in single-commit mode and merged mode (no squash allowed)
		const hideCheckboxes = singleCommitMode || this._isMerged;
		return this.commits.map(
			(c) =>
				new CommitItem(
					c,
					hideCheckboxes ? undefined : this.checkedHashes.has(c.hash),
					singleCommitMode,
				),
		);
	}

	/**
	 * Fetches (with cache) the files changed in a commit and returns them as tree items.
	 * Caches the Promise itself so concurrent calls for the same hash share a single
	 * in-flight request instead of spawning duplicate git subprocesses.
	 */
	private async getCommitFiles(
		parent: CommitItem,
	): Promise<Array<CommitFileItem>> {
		const { hash } = parent.commit;
		let pending = this.fileCache.get(hash);
		if (!pending) {
			pending = this.bridge.listCommitFiles(hash);
			this.fileCache.set(hash, pending);
			// Evict rejected promises so the next expand retries instead of
			// returning a cached failure (e.g. transient git subprocess error).
			pending.catch(() => this.fileCache.delete(hash));
		}
		const files = await pending;
		return files.map((f) => new CommitFileItem(hash, f));
	}

	/** Syncs VSCode context keys that control button visibility in the panel header. */
	private async syncContextKeys(): Promise<void> {
		const singleCommitMode = this.enabled && this.commits.length === 1;
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
					this._isMerged,
				),
				vscode.commands.executeCommand(
					"setContext",
					EMPTY_CONTEXT,
					this.enabled && this.commits.length === 0,
				),
			]);
		} catch {
			// Ignore context sync failures — tree rendering should remain functional.
		}
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}
}

// ─── Label / description / tooltip helpers ────────────────────────────────────

/**
 * Returns the tree item label: full commit message (no truncation) + ☁ if pushed.
 * VSCode wraps or truncates long labels automatically.
 */
function buildLabel(c: BranchCommit): string {
	const message = c.message.trimStart();
	return c.isPushed ? `${message} ☁` : message;
}

/**
 * Returns a minimal description (just the short date) so the label stays clean.
 */
function buildDescription(c: BranchCommit): string {
	return c.shortDate;
}

/**
 * Builds a rich MarkdownString tooltip that pixel-matches the VSCode Source Control
 * GRAPH panel hover popup layout:
 *
 *   **Author**  $(clock) 22 hours ago (February 25, 2026 at 4:57 PM)
 *
 *   Commit message body (plain weight, not bold)
 *
 *   ---
 *   N files changed, N insertions(+), N deletions(-)
 *   ---
 *   $(git-commit) `shortHash` $(copy)  |  $(eye) View Commit Memory
 *
 * isTrusted = true       → enables command:// links
 * supportThemeIcons = true (constructor arg) → enables $(icon) syntax
 */
function buildTooltip(c: BranchCommit): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;

	// Row 1: author name (bold) + clock + relative date
	const relativeDate = formatRelativeDate(c.date);
	md.appendMarkdown(
		`**${escMd(c.author)}** \u00a0$(clock) ${escMd(relativeDate)}\n\n`,
	);

	// Optional: commit type indicator (only for non-standard commits like amend, squash, etc.)
	if (c.commitType) {
		md.appendMarkdown(`$(tag) ${escMd(c.commitType)}\n\n`);
	}

	// Row 2: commit message — plain weight, matching GRAPH panel body text style
	md.appendMarkdown(`${escMd(c.message)}\n\n`);

	// Separator — matches GRAPH panel's horizontal rule between message and stats
	md.appendMarkdown("---\n\n");

	// Stats on one line to match GRAPH panel structure.
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

	// Separator — matches GRAPH panel's horizontal rule between stats and actions
	md.appendMarkdown("---\n\n");

	// Row 4: actions — matches GRAPH panel's "◇ hash □  |  ⓘ Open on GitHub" row
	// We replace "Open on GitHub" position with "View Commit Memory"
	const hashArg = encodeURIComponent(JSON.stringify([c.hash]));
	const copyLink = `[$(git-commit) \`${c.shortHash}\` $(copy)](command:jollimemory.copyCommitHash?${hashArg})`;

	if (c.hasSummary) {
		const viewLink = `[$(eye) View Commit Memory](command:jollimemory.viewSummary?${hashArg})`;
		md.appendMarkdown(`${copyLink}\u00a0 |\u00a0 ${viewLink}`);
	} else {
		md.appendMarkdown(copyLink);
	}

	return md;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Returns true if the commit hash sequence changed between two snapshots.
 * Used by refresh() to decide whether to clear the checked selection.
 */
export function didCommitSequenceChange(
	previousHashes: ReadonlyArray<string>,
	nextHashes: ReadonlyArray<string>,
): boolean {
	if (previousHashes.length !== nextHashes.length) {
		return true;
	}
	return previousHashes.some((h, i) => h !== nextHashes[i]);
}
