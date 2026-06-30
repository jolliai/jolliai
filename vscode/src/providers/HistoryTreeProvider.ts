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
import { formatShortRelativeDate } from "../util/FormatUtils.js";
import type {
	MemoryHover,
	SerializedTreeItem,
} from "../views/SidebarMessages.js";
import { treeItemToSerialized } from "../views/SidebarSerialize.js";

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

	/**
	 * Optional summary lookup used by serializeNode to populate jolliDocUrl,
	 * e2eCount, and conversationTokens on committed memory rows. The callback
	 * receives a commit hash and should return an object with those fields (or
	 * null/undefined on miss). Kept out-of-band from CommitsStore so the store
	 * remains a pure BranchCommit list without an extra per-commit round-trip
	 * for every refresh.
	 *
	 * When absent, none of the three fields are set on the serialized item.
	 */
	private readonly lookupSummary?: (
		hash: string,
	) => Promise<{ jolliDocUrl?: string; e2eCount?: number; conversationTokens?: number } | null | undefined>;

	constructor(
		private readonly store: CommitsStore,
		lookupSummary?: (
			hash: string,
		) => Promise<{ jolliDocUrl?: string; e2eCount?: number; conversationTokens?: number } | null | undefined>,
	) {
		this.lookupSummary = lookupSummary;
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

	getMode(): "multi" | "single" | "merged" | "empty" {
		const snap = this.store.getSnapshot();
		if (snap.isEmpty) return "empty";
		if (snap.isMerged) return "merged";
		if (snap.singleCommitMode) return "single";
		return "multi";
	}

	/**
	 * Resolves a commit's summary once per `serialize()` pass.
	 *
	 * `lookupSummary` (= `bridge.getSummary`) is an UNCACHED storage read — a
	 * `git show` / file read per call. Without memoization a single Branch
	 * refresh that lists the same hash more than once (or re-serializes after a
	 * cheap change) would issue N duplicate uncached reads. The `memo` map is
	 * created fresh in `serialize()` and shared across the whole recursive pass,
	 * so each hash is read at most once per refresh. Stores the in-flight
	 * Promise (not the resolved value) so concurrent `Promise.all` siblings for
	 * the same hash share one read.
	 */
	private lookupSummaryMemoized(
		hash: string,
		memo: Map<string, ReturnType<NonNullable<typeof this.lookupSummary>>>,
	): ReturnType<NonNullable<typeof this.lookupSummary>> {
		const cached = memo.get(hash);
		if (cached) {
			return cached;
		}
		// lookupSummary is guaranteed defined by the caller's guard.
		const p = (this.lookupSummary as NonNullable<typeof this.lookupSummary>)(hash);
		memo.set(hash, p);
		return p;
	}

	private async serializeNode(
		item: CommitItem | CommitFileItem,
		memo: Map<string, ReturnType<NonNullable<typeof this.lookupSummary>>>,
	): Promise<SerializedTreeItem> {
		// CommitItem has a stable id (commit hash) set directly; use it as idHint.
		// CommitFileItem already has id set to "commitHash:relativePath", so use that directly.
		const idHint = item instanceof CommitItem ? item.commit.hash : item.id;
		const base = treeItemToSerialized(item, idHint);
		let enriched: SerializedTreeItem;
		if (item instanceof CommitItem) {
			// isSelected mirrors the native TreeItem.checkboxState that VSCode
			// would render automatically in a TreeView. After the migration to
			// a webview, the JS render code reads this flat boolean instead —
			// FilesTreeProvider already does the same for its file rows.
			// In single-commit / merged modes checkboxState is left undefined
			// (see getChildren above), so isSelected falls to false and the
			// webview gates checkbox rendering on commitsMode === 'multi'.
			//
			// jolliDocUrl: read from the full summary via the optional lookupSummary
			// callback. Only fetched when the commit has a memory — avoids a
			// superfluous async call for code-only commits. Undefined when
			// lookupSummary is not provided (e.g. in tests) or the summary is
			// missing.
			let jolliDocUrl: string | undefined;
			let e2eCount: number | undefined;
			let conversationTokens: number | undefined;
			if (item.commit.hasSummary && this.lookupSummary) {
				try {
					const s = await this.lookupSummaryMemoized(item.commit.hash, memo);
					jolliDocUrl = s?.jolliDocUrl;
					e2eCount = s?.e2eCount;
					conversationTokens = s?.conversationTokens;
				} catch {
					// Graceful fallback — leave all three fields undefined so the row
					// renders in a degraded-but-safe state. Matches the per-commit
					// getChildren degradation pattern (line ~291).
				}
			}
			enriched = {
				...base,
				hasMemory: !!item.commit.hasSummary,
				hover: buildHover(item.commit),
				isSelected: item.checkboxState === vscode.TreeItemCheckboxState.Checked,
				...(jolliDocUrl !== undefined && { jolliDocUrl }),
				...(e2eCount !== undefined && { e2eCount }),
				...(conversationTokens !== undefined && { conversationTokens }),
			};
		} else {
			// CommitFileItem: surface the four fields needed to dispatch
			// jollimemory.openCommitFileChange from the webview. command.arguments
			// gets dropped during serialization (circular reference), so the
			// webview reconstructs the payload from this side-channel.
			enriched = {
				...base,
				commitFile: {
					commitHash: item.commitHash,
					relativePath: item.relativePath,
					statusCode: item.statusCode,
					oldPath: item.oldPath,
				},
				gitStatus: item.statusCode,
			};
		}
		// `collapsibleState` truthy already excludes `None` (= 0) and
		// `undefined`, so an explicit `!== None` check would be redundant
		// and trips TS2367 once enriched gains a precise SerializedTreeItem
		// annotation.
		if (item.collapsibleState) {
			// Local try/catch: each commit's file fetch fans out to a separate
			// `git diff-tree` shell call. A single failure (e.g. orphan ref,
			// transient git lock) should not nuke the whole top-level list, so
			// we degrade to a base node without children rather than rejecting.
			try {
				const kidsRaw = await this.getChildren(item);
				const kids = await Promise.all(
					kidsRaw.map((k) => this.serializeNode(k, memo)),
				);
				return Object.assign({}, enriched, { children: kids });
			} catch {
				return enriched;
			}
		}
		return enriched;
	}

	async serialize(): Promise<ReadonlyArray<SerializedTreeItem>> {
		const tops = await this.getChildren();
		// Per-pass memo: one uncached summary read per hash for this whole refresh.
		const memo = new Map<string, ReturnType<NonNullable<typeof this.lookupSummary>>>();
		return Promise.all(tops.map((it) => this.serializeNode(it, memo)));
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

function buildStatsLine(c: BranchCommit): string {
	const stats: Array<string> = [
		`${c.filesChanged} file${c.filesChanged !== 1 ? "s" : ""} changed`,
	];
	if (c.insertions > 0) {
		stats.push(`${c.insertions} insertion${c.insertions !== 1 ? "s" : ""}(+)`);
	}
	if (c.deletions > 0) {
		stats.push(`${c.deletions} deletion${c.deletions !== 1 ? "s" : ""}(-)`);
	}
	return stats.join(", ");
}

/**
 * Structured hover-card payload for a single commit row. The webview renders
 * this through the same `.hover-card` popover that drives Memories rows
 * (see SidebarScriptBuilder.renderHoverCard) — keeping both surfaces visually
 * 1:1 with the legacy MarkdownString tooltip.
 *
 * `branch` is intentionally omitted: the entire Commits panel is one branch's
 * history, so repeating the branch name on every row's hover is noise. The
 * Memories view is the only consumer that fills it (rows can come from any
 * branch), and the renderer skips the branch line when absent.
 */
function buildHover(c: BranchCommit): MemoryHover {
	return {
		message: c.message,
		// Compact relative form ("2h ago", "3d ago") for the row subline — the
		// verbose formatRelativeDate ("… (absolute date)") stays on the
		// MarkdownString tooltip below, but the subline wants the short style.
		relativeDate: formatShortRelativeDate(c.date),
		commitType: c.commitType,
		shortHash: c.shortHash,
		statsLine: buildStatsLine(c),
	};
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
