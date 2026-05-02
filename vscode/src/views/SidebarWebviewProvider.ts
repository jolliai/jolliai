/**
 * SidebarWebviewProvider
 *
 * Registers as a WebviewViewProvider for the "jollimemory.mainView" view.
 * Builds the sidebar webview HTML, dispatches outbound messages from the
 * client to either jollimemory commands (via executeCommand) or to dedicated
 * data-loading paths (added in subsequent phases).
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { log } from "../util/Logger.js";
import { SIDEBAR_EMPTY_STRINGS } from "./SidebarEmptyMessages.js";
import { buildSidebarHtml } from "./SidebarHtmlBuilder.js";
import type {
	FolderNode,
	MemoryItem,
	SerializedTreeItem,
	SidebarInboundMsg,
	SidebarOutboundMsg,
	SidebarState,
} from "./SidebarMessages.js";

export interface SidebarWebviewDeps {
	executeCommand: (
		command: string,
		...args: ReadonlyArray<unknown>
	) => Thenable<unknown>;
	getInitialState: () => SidebarState;
	/** Extension installation root — used to compute webview-resolvable URIs for bundled assets (codicons). */
	extensionUri: vscode.Uri;
	/** Optional in scaffold; required once Phase 2 lands. */
	statusProvider?: {
		serialize(): ReadonlyArray<SerializedTreeItem>;
		onDidChangeTreeData: (cb: () => void) => { dispose: () => void };
	};
	kbFolders?: { listChildren(relPath: string): Promise<FolderNode> };
	/** Returns absolute path under kbRoot for a relative path. */
	resolveKbAbs?: (relPath: string) => string;
	memoriesProvider?: {
		serialize(): { items: ReadonlyArray<MemoryItem>; hasMore: boolean };
		onDidChangeTreeData: (cb: () => void) => { dispose: () => void };
	};
	branchWatcher?: {
		current(): { name: string; detached: boolean };
		onChange(cb: (name: string, detached: boolean) => void): {
			dispose: () => void;
		};
	};
	plansProvider?: {
		serialize(): ReadonlyArray<SerializedTreeItem>;
		onDidChangeTreeData: (cb: () => void) => { dispose: () => void };
	};
	filesProvider?: {
		serialize(): ReadonlyArray<SerializedTreeItem>;
		onDidChangeTreeData: (cb: () => void) => { dispose: () => void };
	};
	historyProvider?: {
		serialize(): Promise<ReadonlyArray<SerializedTreeItem>>;
		onDidChangeTreeData: (cb: () => void) => { dispose: () => void };
		getMode?(): "multi" | "single" | "merged" | "empty";
	};
	/**
	 * Called once when the sidebar webview first becomes visible. Used to trigger
	 * lazy-loaded data sources (e.g. MemoriesStore.ensureFirstLoad()) that the
	 * original tree views populated via onDidChangeVisibility — replaced here
	 * because the webview has no equivalent visibility event.
	 */
	onSidebarFirstVisible?: () => void | Promise<void>;
	/** Toggle a single file's selection state in FilesStore. */
	applyFileCheckbox?: (filePath: string, selected: boolean) => void;
	/** Toggle a single commit's selection state in CommitsStore. */
	applyCommitCheckbox?: (hash: string, selected: boolean) => void;
}

export class SidebarWebviewProvider
	implements vscode.WebviewViewProvider, vscode.Disposable
{
	static readonly viewId = "jollimemory.mainView";

	private view: vscode.WebviewView | undefined;
	private statusSub: { dispose(): void } | undefined;
	private memoriesSub: { dispose(): void } | undefined;
	private branchSub: { dispose(): void } | undefined;
	private plansSub: { dispose(): void } | undefined;
	private filesSub: { dispose(): void } | undefined;
	private historySub: { dispose(): void } | undefined;
	private firstVisibleFired = false;

	constructor(private readonly deps: SidebarWebviewDeps) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.deps.extensionUri],
		};
		const nonce = randomBytes(16).toString("hex");
		const codiconCssUri = view.webview.asWebviewUri(
			vscode.Uri.joinPath(
				this.deps.extensionUri,
				"assets",
				"codicons",
				"codicon.css",
			),
		);
		view.webview.html = buildSidebarHtml(
			nonce,
			view.webview.cspSource,
			codiconCssUri.toString(),
			SIDEBAR_EMPTY_STRINGS,
		);
		view.webview.onDidReceiveMessage((msg: unknown) => {
			this.handleOutbound(msg);
		});
		if (this.deps.statusProvider && !this.statusSub) {
			this.statusSub = this.deps.statusProvider.onDidChangeTreeData(() =>
				this.pushStatus(),
			);
		}
		if (this.deps.memoriesProvider && !this.memoriesSub) {
			this.memoriesSub = this.deps.memoriesProvider.onDidChangeTreeData(() =>
				this.pushMemories(),
			);
		}
		if (this.deps.branchWatcher && !this.branchSub) {
			this.branchSub = this.deps.branchWatcher.onChange((name, detached) => {
				this.postMessage({ type: "branch:branchName", name, detached });
			});
		}
		if (this.deps.plansProvider && !this.plansSub) {
			this.plansSub = this.deps.plansProvider.onDidChangeTreeData(() =>
				this.pushPlans(),
			);
		}
		if (this.deps.filesProvider && !this.filesSub) {
			this.filesSub = this.deps.filesProvider.onDidChangeTreeData(() =>
				this.pushChanges(),
			);
		}
		if (this.deps.historyProvider && !this.historySub) {
			this.historySub = this.deps.historyProvider.onDidChangeTreeData(
				() => void this.pushCommits(),
			);
		}
	}

	/** Send a message to the webview client. No-op when the view is not resolved. */
	postMessage(msg: SidebarInboundMsg): void {
		if (!this.view) return;
		void this.view.webview.postMessage(msg);
	}

	private handleOutbound(raw: unknown): void {
		if (!isOutbound(raw)) return;
		const msg: SidebarOutboundMsg = raw;
		switch (msg.type) {
			case "ready":
				this.postMessage({ type: "init", state: this.deps.getInitialState() });
				// Trigger lazy-loaded data sources on first visibility. Idempotent —
				// `firstVisibleFired` guards against re-firing on view re-resolves
				// (e.g. user collapses + reopens the sidebar).
				if (!this.firstVisibleFired) {
					this.firstVisibleFired = true;
					if (this.deps.onSidebarFirstVisible) {
						void this.deps.onSidebarFirstVisible();
					}
				}
				this.pushStatus();
				this.pushMemories();
				this.pushPlans();
				this.pushChanges();
				void this.pushCommits();
				if (this.deps.branchWatcher) {
					const cur = this.deps.branchWatcher.current();
					this.postMessage({
						type: "branch:branchName",
						name: cur.name,
						detached: cur.detached,
					});
				}
				return;
			case "command":
				if (msg.args && msg.args.length > 0) {
					void this.deps.executeCommand(msg.command, ...msg.args);
				} else {
					void this.deps.executeCommand(msg.command);
				}
				return;
			case "kb:expandFolder":
				void this.handleExpandFolder(msg.path);
				return;
			case "kb:openFile":
				this.handleOpenFile(msg.path);
				return;
			case "kb:setMode":
				// Webview switches mode locally; if user switches to memories, push fresh data.
				if (msg.mode === "memories") this.pushMemories();
				return;
			case "kb:search":
				void this.deps.executeCommand("jollimemory.searchMemories", msg.query);
				return;
			case "kb:clearSearch":
				void this.deps.executeCommand("jollimemory.clearMemoryFilter");
				return;
			case "kb:loadMore":
				void this.deps.executeCommand("jollimemory.loadMoreMemories");
				return;
			case "kb:openMemory":
				void this.deps.executeCommand(
					"jollimemory.viewMemorySummary",
					msg.commitHash,
				);
				return;
			case "branch:openPlan":
				// Sidebar row-click → markdown preview, not editor. The ✎ inline
				// button still goes through editPlan for actual editing.
				void this.deps.executeCommand(
					"jollimemory.openPlanForPreview",
					msg.planId,
				);
				return;
			case "branch:openNote":
				// Sidebar row-click → markdown preview, not editor. The ✎ inline
				// button still goes through editNote for actual editing. Differs
				// from `previewNote` (used by Summary) which is orphan-only.
				void this.deps.executeCommand(
					"jollimemory.openNoteForPreview",
					msg.noteId,
				);
				return;
			case "branch:openChange":
				// Rebuild the minimum FileItem-shape the command handler reads.
				// jollimemory.openFileChange in Extension.ts only touches
				// `item.fileStatus.absolutePath / statusCode / relativePath`,
				// so we can hand it a structurally equivalent plain object.
				// We don't go through filesStore: the webview already has the
				// authoritative snapshot it just rendered, and a store
				// roundtrip would race against rapid clicks while git's
				// index is changing.
				void this.deps.executeCommand("jollimemory.openFileChange", {
					fileStatus: {
						absolutePath: msg.filePath,
						relativePath: msg.relativePath,
						statusCode: msg.statusCode,
					},
				});
				return;
			case "branch:openCommit":
				void this.deps.executeCommand("jollimemory.viewSummary", msg.hash);
				return;
			case "branch:discardFile":
				// jollimemory.discardFileChanges reads item.fileStatus.{relativePath,
				// statusCode, absolutePath} — same structural shape we hand the open
				// command above. A bare id string would trip the handler's
				// `if (!item?.fileStatus) return;` guard and the click would silently
				// no-op, which is what the inline ↺ button hit before this case.
				void this.deps.executeCommand("jollimemory.discardFileChanges", {
					fileStatus: {
						absolutePath: msg.filePath,
						relativePath: msg.relativePath,
						statusCode: msg.statusCode,
					},
				});
				return;
			case "branch:toggleFileSelection":
				this.deps.applyFileCheckbox?.(msg.filePath, msg.selected);
				return;
			case "branch:toggleCommitSelection":
				this.deps.applyCommitCheckbox?.(msg.hash, msg.selected);
				return;
			case "refresh":
				this.handleRefresh(msg.scope);
				return;
			default:
				return;
		}
	}

	/**
	 * Handles toolbar refresh button clicks. Each scope re-fetches the upstream
	 * data via the same `jollimemory.refresh*` commands that the section-level
	 * refresh buttons use — keeps the refresh contract in one place. KB folders
	 * have no command equivalent (no upstream cache; we read fs each time), so
	 * we call `handleExpandFolder("")` directly to push a fresh root listing.
	 */
	private handleRefresh(scope: "kb" | "branch" | "status" | "all"): void {
		if (scope === "kb" || scope === "all") {
			void this.handleExpandFolder("");
			void this.deps.executeCommand("jollimemory.refreshMemories");
		}
		if (scope === "branch" || scope === "all") {
			void this.deps.executeCommand("jollimemory.refreshPlans");
			void this.deps.executeCommand("jollimemory.refreshFiles");
			void this.deps.executeCommand("jollimemory.refreshHistory");
		}
		if (scope === "status" || scope === "all") {
			void this.deps.executeCommand("jollimemory.refreshStatus");
		}
	}

	/**
	 * Used by destructive host-side operations (currently Migrate to Memory Bank)
	 * to force the client to drop its `folderCache` before the next listing
	 * arrives. `newKbRepoFolder` replaces the client's auto-expand anchor so the
	 * freshly created `-N`-suffixed folder is the one that gets auto-expanded.
	 *
	 * Safe to call even when the view hasn't resolved yet — postMessage no-ops,
	 * and the next `ready` will pick up the new state via getInitialState().
	 */
	refreshKnowledgeBaseFolders(newKbRepoFolder?: string): void {
		this.postMessage({
			type: "kb:foldersReset",
			kbRepoFolder: newKbRepoFolder,
		});
		void this.handleExpandFolder("");
	}

	/** Pushed from refreshStatusBar after enable/disable so the sidebar can show
	 * or hide the disabled banner without an extension reload. */
	notifyEnabledChanged(enabled: boolean): void {
		this.postMessage({ type: "enabled:changed", enabled });
	}

	/** Pushed after the OAuth callback completes (sign-in) and after signOut. */
	notifyAuthChanged(authenticated: boolean): void {
		this.postMessage({ type: "auth:changed", authenticated });
	}

	private pushStatus(): void {
		if (!this.deps.statusProvider) return;
		this.postMessage({
			type: "status:data",
			entries: this.deps.statusProvider.serialize(),
		});
	}

	private pushMemories(): void {
		if (!this.deps.memoriesProvider) return;
		const { items, hasMore } = this.deps.memoriesProvider.serialize();
		log.info("SidebarWebviewProvider", `pushMemories: ${items.length} item(s)`);
		this.postMessage({ type: "kb:memoriesData", items, hasMore });
	}

	private pushPlans(): void {
		if (!this.deps.plansProvider) return;
		this.postMessage({
			type: "branch:plansData",
			items: this.deps.plansProvider.serialize(),
		});
	}

	private pushChanges(): void {
		if (!this.deps.filesProvider) return;
		this.postMessage({
			type: "branch:changesData",
			items: this.deps.filesProvider.serialize(),
		});
	}

	private async pushCommits(): Promise<void> {
		if (!this.deps.historyProvider) return;
		const mode = this.deps.historyProvider.getMode?.() ?? "empty";
		try {
			const items = await this.deps.historyProvider.serialize();
			log.info(
				"SidebarWebviewProvider",
				`pushCommits: ${items.length} item(s), mode=${mode}`,
			);
			this.postMessage({ type: "branch:commitsData", items, mode });
		} catch (err) {
			// HistoryTreeProvider.serialize walks each commit's children which
			// fans out to bridge.listCommitFiles. If any of those rejects, the
			// whole Promise.all rejects and we'd silently swallow it (callers
			// fire-and-forget with `void this.pushCommits()`). Log and post an
			// empty list so the section renders its empty-state instead of the
			// initial "Loading..." placeholder.
			log.error(
				"SidebarWebviewProvider",
				`pushCommits failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			this.postMessage({ type: "branch:commitsData", items: [], mode });
		}
	}

	private async handleExpandFolder(relPath: string): Promise<void> {
		if (!this.deps.kbFolders) return;
		try {
			const tree = await this.deps.kbFolders.listChildren(relPath);
			this.postMessage({ type: "kb:foldersData", tree });
		} catch (err) {
			// The webview's renderFolders gates its empty state on the cache having
			// SOME entry for the path — without a follow-up message it stays on
			// "Loading…" forever (no client-side retry). So always reply, even on
			// error: send an empty FolderNode so the user sees "no files yet" and
			// can use the refresh button to recover.
			log.warn(
				"SidebarWebviewProvider",
				`handleExpandFolder(${relPath || "<root>"}) failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			const name = relPath === "" ? "" : (relPath.split("/").pop() ?? "");
			this.postMessage({
				type: "kb:foldersData",
				tree: { name, relPath, isDirectory: true, children: [] },
			});
		}
	}

	private handleOpenFile(relPath: string): void {
		if (!this.deps.resolveKbAbs) return;
		const abs = this.deps.resolveKbAbs(relPath);
		if (relPath.toLowerCase().endsWith(".md")) {
			void this.deps.executeCommand("jollimemory.openMemoryFile", abs);
		} else {
			void this.deps.executeCommand("vscode.open", vscode.Uri.file(abs));
		}
	}

	dispose(): void {
		if (this.statusSub) {
			this.statusSub.dispose();
			this.statusSub = undefined;
		}
		if (this.memoriesSub) {
			this.memoriesSub.dispose();
			this.memoriesSub = undefined;
		}
		if (this.branchSub) {
			this.branchSub.dispose();
			this.branchSub = undefined;
		}
		if (this.plansSub) {
			this.plansSub.dispose();
			this.plansSub = undefined;
		}
		if (this.filesSub) {
			this.filesSub.dispose();
			this.filesSub = undefined;
		}
		if (this.historySub) {
			this.historySub.dispose();
			this.historySub = undefined;
		}
	}
}

function isOutbound(x: unknown): x is SidebarOutboundMsg {
	return (
		!!x &&
		typeof x === "object" &&
		typeof (x as { type?: unknown }).type === "string"
	);
}
