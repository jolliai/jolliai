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
import type { TranscriptSource } from "../../../cli/src/Types.js";
import { isTranscriptSource } from "../../../cli/src/Types.js";
import type { ActiveSessionsProvider } from "../services/ActiveSessionsProvider.js";
import { log } from "../util/Logger.js";
import { ConversationDetailsPanel } from "./ConversationDetailsPanel.js";
import { SIDEBAR_EMPTY_STRINGS } from "./SidebarEmptyMessages.js";
import { buildSidebarHtml } from "./SidebarHtmlBuilder.js";
import type {
	BranchMemoryItem,
	FolderNode,
	MemoryItem,
	RepoChoice,
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
		/**
		 * Returns the current workerBusy flag from StatusStore. Pushed to the
		 * webview as a dedicated `worker:busy` message so the Branch tab toolbar
		 * can show an "AI summary in progress…" indicator without depending on
		 * the unstable `status:data` entries list.
		 */
		getWorkerBusy(): boolean;
		/**
		 * Returns the current sync-phase indicator from StatusStore. Pushed to
		 * the webview as `sync:phase` so the Branch tab toolbar can render the
		 * orchestrator's per-phase label (downloading / merging / uploading /
		 * sticky failure). Optional so existing tests (which only stub
		 * `getWorkerBusy`) keep compiling.
		 */
		getSyncPhase?: () => {
			readonly label: string;
			readonly severity: "info" | "error";
		} | null;
	};
	kbFolders?: {
		listChildren(relPath: string): Promise<FolderNode>;
		/**
		 * Drops the per-session "this repo is clean" memo so the next
		 * listChildren re-runs reconcile + heal. Optional so existing tests
		 * (which inject only `listChildren`) keep working.
		 */
		notifyDirty?: (kbRoot?: string) => void;
	};
	/**
	 * Source for the breadcrumb repo/branch dropdowns. `listRepos` enumerates
	 * every Memory Bank repo (current + foreign); `listBranches(repoName)`
	 * returns the branches known for that repo. Kept separate from `kbFolders`
	 * because the breadcrumb has no Folders-tab dependency: a webview with
	 * only the breadcrumb wired (e.g. a future trimmed-down host) still needs
	 * these. Both are sync — implementations read JSON metadata that's already
	 * cheap to slurp; pushRepos fires inside `handleReady`'s synchronous tail.
	 */
	selection?: {
		listRepos(): readonly RepoChoice[];
		listBranches(repoName: string): readonly string[];
		/**
		 * Returns every memory stored for the named repo+branch — including
		 * amend/rebase children — so the foreign-readonly Branch tab Memories
		 * section can match Memory Bank tree counts. The global KB Memories
		 * list intentionally collapses chains; this path bypasses that filter.
		 */
		listBranchMemories(
			repoName: string,
			branchName: string,
		): Promise<ReadonlyArray<BranchMemoryItem>>;
	};
	/** Returns absolute path under kbRoot for a relative path. */
	resolveKbAbs?: (relPath: string) => string;
	/**
	 * True when the Memory Bank `.md` at `abs` has been edited on disk and its
	 * sha256 no longer matches the manifest fingerprint. Consulted from
	 * `handleOpenFile` so opening a diverged file surfaces the Folders-tab ✎
	 * marker immediately (the row is already rendered; we just flip its flag)
	 * instead of waiting for the next full re-listing. Optional so existing
	 * tests that inject only `resolveKbAbs` keep working; absent → no check.
	 */
	isMemoryFileDivergedOnDisk?: (abs: string) => Promise<boolean>;
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
	 * Source for the Branch tab's Active Conversations section. Optional so
	 * existing tests can omit it. Re-queried on `handleReady()` and on every
	 * Branch-scope refresh — there's no `onDidChangeTreeData` channel here
	 * because the five no-hook sources (Codex/OpenCode/Cursor/Copilot CLI/
	 * Copilot Chat) have no host-side watchers; refresh is the only update
	 * path. Errors are already swallowed inside the provider.
	 */
	activeSessionsProvider?: ActiveSessionsProvider;
	/**
	 * Polling-path Codex reference extraction. Invoked (fire-and-forget) on every
	 * Active Conversations refresh — the same 60s tick that discovers Codex
	 * sessions — so references a Codex session fetched via MCP surface in
	 * Plans & Notes within ~60s, without any hook. `discover()` resolves the
	 * workspace cwd itself and MUST never throw/reject (the impl swallows errors),
	 * so callers `void`-call it. Optional so existing tests can omit it.
	 */
	codexReferenceDiscovery?: { discover(): void };
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
	/** Toggle a single conversation's selection state in ConversationsStore. */
	applyConversationCheckbox?: (
		source: TranscriptSource,
		sessionId: string,
		selected: boolean,
	) => void | Promise<void>;
	/** Toggle a single plan's selection state in PlansStore. */
	applyPlanCheckbox?: (
		planId: string,
		selected: boolean,
	) => void | Promise<void>;
	/**
	 * Toggle a single multi-source reference's exclusion state. The `mapKey`
	 * matches the `plans.json.references` map key (`<source>:<nativeId>`) and is
	 * forwarded verbatim to `setExcluded(.., "references", mapKey, ..)`.
	 */
	applyReferenceCheckbox?: (
		mapKey: string,
		selected: boolean,
	) => void | Promise<void>;
	/** Toggle a single note's selection state in NotesStore. */
	applyNoteCheckbox?: (
		noteId: string,
		selected: boolean,
	) => void | Promise<void>;
	/**
	 * Resolves once the host has finished its first-pass initial load — in
	 * particular once `statusStore.refresh()` has run so `getInitialState()`
	 * returns the real `configured` / `enabled` flags rather than their
	 * pessimistic activate-time defaults. The `ready` handler awaits this
	 * before posting `init`, which prevents the webview from briefly
	 * rendering the onboarding panel on reload (the bug this hooks into:
	 * `currentConfigured = false` → init pushed pre-refresh →
	 * applyConfigured(false) → onboarding flashes → configured:changed
	 * arrives → tab UI restored).
	 *
	 * Must never reject — the host wraps it in a `.catch(() => undefined)`
	 * so a failed initial load never traps the webview in the loading
	 * placeholder.
	 */
	initialStateReady?: Promise<unknown>;
}

export class SidebarWebviewProvider
	implements vscode.WebviewViewProvider, vscode.Disposable
{
	static readonly viewId = "jollimemory.mainView";

	/**
	 * Cadence for the Active Conversations background refresh. The five
	 * no-hook sources (Codex/OpenCode/Cursor/Copilot CLI/Copilot Chat) only
	 * surface state through on-disk transcripts that the host can't watch
	 * cheaply, so we poll. One minute is the lowest cadence that feels
	 * "live" without making the aggregator (which opens SQLite handles for
	 * Cursor/Copilot Chat) a notable background cost. Ticks while the view
	 * is hidden short-circuit before touching disk — see `tickConversations`.
	 */
	private static readonly CONVERSATIONS_REFRESH_INTERVAL_MS = 60_000;

	private view: vscode.WebviewView | undefined;
	private statusSub: { dispose(): void } | undefined;
	private memoriesSub: { dispose(): void } | undefined;
	private branchSub: { dispose(): void } | undefined;
	private plansSub: { dispose(): void } | undefined;
	private filesSub: { dispose(): void } | undefined;
	private historySub: { dispose(): void } | undefined;
	private conversationsRefreshTimer: ReturnType<typeof setInterval> | undefined;
	private firstVisibleFired = false;
	/**
	 * Latest activity-bar badge requested by the host (e.g. visible-changed-file
	 * count from filesStore). Cached because callers may push a value before
	 * `resolveWebviewView` has run — without the cache, badges set during
	 * activation would be silently dropped and only re-appear after the next
	 * filesStore.onChange. resolveWebviewView re-applies whatever's pending.
	 */
	private pendingBadge: vscode.WebviewView["badge"];
	/**
	 * Breadcrumb selection — mirrors `state.selectedRepoName` /
	 * `selectedBranchName` on the webview side. Undefined = viewing the
	 * workspace's own repo / branch (no foreign-readonly chrome). Held on the
	 * host so a webview reload can resync via `getInitialState`-adjacent
	 * pushes; today we drop on reload since the dropdowns re-populate fresh.
	 */
	private selectedRepoName: string | undefined;
	private selectedBranchName: string | undefined;
	// Per-path "latest divergence signal wins" generation. Bumped on every
	// open-file divergence check AND on every revert, so whichever fired last
	// for a given row is authoritative. markDivergedIfNeeded captures the value
	// before its async disk check and drops its result if anything bumped the
	// same path meanwhile — a newer open, or a revert. Without this, two opens
	// of the same file could let an older/slower check overwrite the newer one,
	// and a revert-in-flight could re-light a ✎ on a now-synced file. Keyed by
	// the repoDir-prefixed relPath all paths use, so signals for one row never
	// suppress another's.
	private readonly divergenceCheckSeq = new Map<string, number>();

	constructor(private readonly deps: SidebarWebviewDeps) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		// Re-apply any badge requested before the view resolved. WebviewView
		// shares the `.badge` API with TreeView (VS Code 1.72+); this is the
		// re-attachment point that replaces the legacy filesView.badge hooks
		// dropped when the file tree moved into the unified webview.
		view.badge = this.pendingBadge;
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
		// Background poll for Active Conversations. Started here (rather than
		// in handleReady) so it survives webview reloads — the timer is bound
		// to the view's lifetime, not the client-`ready` cycle. Guard against
		// double-registration when resolveWebviewView is called multiple times
		// (e.g. user drags the sidebar between activity bar and panel), same
		// pattern as the `!this.statusSub` checks above.
		if (this.deps.activeSessionsProvider && !this.conversationsRefreshTimer) {
			this.conversationsRefreshTimer = setInterval(
				() => this.tickConversations(),
				SidebarWebviewProvider.CONVERSATIONS_REFRESH_INTERVAL_MS,
			);
		}
	}

	/**
	 * Single tick of the Active Conversations refresh timer. Short-circuits
	 * when the view is hidden so a sidebar the user has collapsed doesn't
	 * keep paying the aggregator's SQLite reads in the background — on
	 * re-show the webview reloads and `handleReady` pushes a fresh list
	 * anyway, so we don't risk staleness by skipping ticks while hidden.
	 */
	private tickConversations(): void {
		if (!this.view?.visible) return;
		void this.pushConversations();
	}

	/** Send a message to the webview client. No-op when the view is not resolved. */
	postMessage(msg: SidebarInboundMsg): void {
		if (!this.view) return;
		void this.view.webview.postMessage(msg);
	}

	/**
	 * Set the activity-bar badge for this view. Pass `undefined` to clear.
	 * Safe to call before `resolveWebviewView` runs — the value is cached and
	 * re-applied on resolve, so badges driven by stores that broadcast during
	 * activation aren't lost when the user opens the sidebar later.
	 *
	 * Diverges from `postMessage`'s "drop-when-not-resolved" semantics on
	 * purpose: filesStore.onChange may not fire again for a while, so silently
	 * dropping the very first badge would leave the icon unbadged for the rest
	 * of the session.
	 *
	 * When clearing a previously-set badge, we first assign a `value: 0`
	 * sentinel (which VS Code suppresses visually, equivalent to "no badge")
	 * before assigning `undefined`. WebviewView.badge's setter does not always
	 * repaint the activity-bar counter when assigned `undefined` after a
	 * non-undefined ViewBadge — observed as a stuck count after the user
	 * reverted the last change (visibleCount 1 → 0, but the icon kept "1").
	 * The intermediate concrete value forces a repaint; the trailing
	 * `undefined` restores the documented API state for any reader.
	 */
	setBadge(badge: vscode.WebviewView["badge"]): void {
		this.pendingBadge = badge;
		if (!this.view) return;
		if (badge === undefined && this.view.badge !== undefined) {
			this.view.badge = { value: 0, tooltip: "" };
		}
		this.view.badge = badge;
	}

	/**
	 * Awaits `deps.initialStateReady` (when provided) before posting `init`,
	 * so the first state the webview sees already reflects the real
	 * `configured` / `enabled` derived from `statusStore`. Without the
	 * await, the webview would render against the host's pessimistic
	 * activate-time defaults (configured=false) and visibly flash the
	 * onboarding panel on reload.
	 *
	 * The promise is wrapped in `.catch` so a failed initial load still
	 * lets `init` go out — better an unflashed onboarding panel than a
	 * webview stuck on the loading placeholder forever.
	 */
	private async handleReady(): Promise<void> {
		try {
			await this.deps.initialStateReady;
		} catch {
			// fall through
		}
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
		void this.pushConversations();
		if (this.deps.branchWatcher) {
			const cur = this.deps.branchWatcher.current();
			this.postMessage({
				type: "branch:branchName",
				name: cur.name,
				detached: cur.detached,
			});
		}
		// Populate the breadcrumb dropdowns. Repos are pushed unconditionally
		// — even a single-repo result lets the webview decide whether to hide
		// the chevron (it suppresses < 2 entries). Branches are pushed for the
		// workspace's own repo so the branch dropdown is immediately usable;
		// foreign-repo branches are fetched lazily when the user picks that
		// repo via `selection:request`.
		this.pushRepos();
		const init = this.deps.getInitialState();
		if (init.currentRepoName) this.pushBranches(init.currentRepoName);
	}

	private handleOutbound(raw: unknown): void {
		if (!isOutbound(raw)) return;
		const msg: SidebarOutboundMsg = raw;
		switch (msg.type) {
			case "ready":
				void this.handleReady();
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
			case "branch:openReference":
				void this.deps.executeCommand(
					"jollimemory.openReferenceInBrowser",
					msg.mapKey,
				);
				return;
			case "branch:openReferenceMarkdown":
				void this.deps.executeCommand(
					"jollimemory.openReferenceMarkdown",
					msg.mapKey,
				);
				return;
			case "branch:ignoreReference":
				void this.deps.executeCommand(
					"jollimemory.ignoreReference",
					msg.mapKey,
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
			case "branch:openConversation":
				// Same sessionId reveals the existing panel; a different sessionId
				// disposes the prior panel and opens a fresh one. The source-specific
				// transcript reader is selected inside ConversationDetailsPanel from
				// `source` + `transcriptPath`. `title` is the already-fallback-resolved
				// label string from the row — panel uses it verbatim for both the
				// VS Code tab title and the in-panel header. `projectDir` is the
				// workspace root used to resolve the conversation-edits overlay
				// directory; undefined when no workspace is open, in which case
				// the panel becomes read-only.
				//
				// Webview messages cross a trust boundary — static typing only
				// describes the agreed wire shape, the actual runtime value is
				// `unknown`. `source` decides which overlay directory we touch
				// and is checked against the closed `TranscriptSource` enum.
				// `sessionId` keys the panel registry and the hide store;
				// `transcriptPath` ends up in `createReadStream` downstream;
				// `title` flows through `escapeHtml` into the panel header.
				// All three must be non-empty strings — anything else is
				// either a bug in the renderer or a spoofed message we drop
				// rather than forwarding into the file system / DOM.
				if (!isTranscriptSource(msg.source)) {
					log.warn(
						"SidebarWebviewProvider",
						"Rejected branch:openConversation with unknown source",
						{ source: String(msg.source) },
					);
					return;
				}
				if (
					typeof msg.sessionId !== "string" ||
					msg.sessionId.length === 0 ||
					typeof msg.transcriptPath !== "string" ||
					msg.transcriptPath.length === 0 ||
					typeof msg.title !== "string" ||
					msg.title.length === 0
				) {
					log.warn(
						"SidebarWebviewProvider",
						"Rejected branch:openConversation with non-string or empty sessionId/transcriptPath/title",
					);
					return;
				}
				ConversationDetailsPanel.show({
					extensionUri: this.deps.extensionUri,
					sessionId: msg.sessionId,
					source: msg.source,
					transcriptPath: msg.transcriptPath,
					title: msg.title,
					projectDir: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
					onSessionChanged: () => {
						// Any persisted edit/delete changes the row-level state
						// (edited badge, count, or visibility after new overlay
						// rules), so re-pull the list immediately after save.
						void this.pushConversations();
					},
				});
				return;
			case "branch:discardFile":
				// jollimemory.discardFileChanges reads item.fileStatus.{relativePath,
				// statusCode, absolutePath} — same structural shape we hand the open
				// command above. A bare id string would trip the handler's
				// `if (!item?.fileStatus) return;` guard and the click would silently
				// no-op, which is what the inline ↺ button hit before this case.
				//
				// indexStatus + worktreeStatus MUST be forwarded — `bridge.discardFiles`
				// dispatches on the raw porcelain v1 columns (worktree-only restore vs
				// staged-worktree restore vs unlink for untracked), not on the
				// collapsed statusCode letter. Routing only statusCode used to land
				// every file in the `git restore --staged --worktree` branch which
				// silently failed for untracked files (pathspec unknown to git),
				// leaving the activity-bar badge showing the pre-discard count.
				void this.deps.executeCommand("jollimemory.discardFileChanges", {
					fileStatus: {
						absolutePath: msg.filePath,
						relativePath: msg.relativePath,
						statusCode: msg.statusCode,
						indexStatus: msg.indexStatus,
						worktreeStatus: msg.worktreeStatus,
						...(msg.originalPath ? { originalPath: msg.originalPath } : {}),
					},
				});
				return;
			case "branch:toggleFileSelection":
				this.deps.applyFileCheckbox?.(msg.filePath, msg.selected);
				return;
			case "branch:toggleCommitSelection":
				this.deps.applyCommitCheckbox?.(msg.hash, msg.selected);
				return;
			case "branch:toggleConversationSelection":
				if (!isTranscriptSource(msg.source)) {
					log.warn(
						"SidebarWebviewProvider",
						"Rejected branch:toggleConversationSelection with unknown source",
						{ source: String(msg.source) },
					);
					return;
				}
				void this.deps.applyConversationCheckbox?.(
					msg.source,
					msg.sessionId,
					msg.selected,
				);
				return;
			case "branch:togglePlanSelection":
				void this.deps.applyPlanCheckbox?.(msg.planId, msg.selected);
				return;
			case "branch:toggleReferenceSelection":
				void this.deps.applyReferenceCheckbox?.(msg.mapKey, msg.selected);
				return;
			case "branch:toggleNoteSelection":
				void this.deps.applyNoteCheckbox?.(msg.noteId, msg.selected);
				return;
			case "refresh":
				this.handleRefresh(msg.scope);
				return;
			case "selection:request":
				this.handleSelectionRequest(msg.repoName, msg.branchName);
				return;
			case "selection:requestBranchMemories":
				void this.handleBranchMemoriesRequest(msg.repoName, msg.branchName);
				return;
			default:
				return;
		}
	}

	/**
	 * Resolves a breadcrumb pick from the webview into:
	 *   - updated host-side selection state (so subsequent pushes stay
	 *     consistent if we ever wire foreign-repo data into commitsStore),
	 *   - a `selection:set` ack so the webview can re-render its breadcrumb
	 *     and flip `.foreign-readonly` chrome,
	 *   - (when the repo changed) a fresh `selection:branches` for the newly
	 *     selected repo so its branch dropdown is populated.
	 *
	 * Repo picks auto-default to the first known branch. If the repo has no
	 * branches registered in `.jolli/branches.json` (e.g. an empty Memory
	 * Bank entry), `selectedBranchName` is left undefined and the webview
	 * falls back to showing the workspace branch label — a known minor UX
	 * wart for an edge case rather than a correctness bug.
	 */
	private handleSelectionRequest(
		repoName: string | undefined,
		branchName: string | undefined,
	): void {
		if (!this.deps.selection) return;
		if (repoName) {
			const repos = this.deps.selection.listRepos();
			const target = repos.find((r) => r.repoName === repoName);
			if (!target) return;
			this.selectedRepoName = target.repoName;
			const branches = this.deps.selection.listBranches(target.repoName);
			this.selectedBranchName = branches[0];
			this.postMessage({
				type: "selection:branches",
				repoName: target.repoName,
				branches: [...branches],
			});
			this.postMessage({
				type: "selection:set",
				repoName: this.selectedRepoName,
				branchName: this.selectedBranchName,
			});
			return;
		}
		if (branchName) {
			this.selectedBranchName = branchName;
			this.postMessage({
				type: "selection:set",
				repoName: this.selectedRepoName,
				branchName,
			});
		}
	}

	/**
	 * Resolves a webview request for "all memories on this repo+branch".
	 * Always echoes the request's repoName+branchName on the response so the
	 * webview can match it against its own cache key even if a faster newer
	 * request has already overwritten its in-flight selection state.
	 */
	private async handleBranchMemoriesRequest(
		repoName: string,
		branchName: string,
	): Promise<void> {
		if (!this.deps.selection) return;
		try {
			const items = await this.deps.selection.listBranchMemories(
				repoName,
				branchName,
			);
			this.postMessage({
				type: "selection:branchMemories",
				repoName,
				branchName,
				items: [...items],
			});
		} catch (err) {
			log.warn(
				"SidebarWebviewProvider",
				`handleBranchMemoriesRequest failed for ${repoName}/${branchName}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			this.postMessage({
				type: "selection:branchMemories",
				repoName,
				branchName,
				items: [],
			});
		}
	}

	private pushRepos(): void {
		if (!this.deps.selection) return;
		const repos = this.deps.selection.listRepos();
		this.postMessage({ type: "selection:repos", repos: [...repos] });
	}

	private pushBranches(repoName: string): void {
		if (!this.deps.selection) return;
		const branches = this.deps.selection.listBranches(repoName);
		this.postMessage({
			type: "selection:branches",
			repoName,
			branches: [...branches],
		});
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
			// The workspace-scoped refresh* commands above don't reach the
			// foreign-readonly Branch view's `branchMemoriesCache` (host pushes
			// land in branchData but the foreign render path reads from the
			// per-(repo, branch) cache instead). Without this signal a user
			// viewing a foreign repo+branch sees the Memories section frozen on
			// whatever the first selection load returned, no matter how many
			// times they click Refresh.
			this.postMessage({ type: "selection:invalidateBranchMemories" });
			// Active Conversations has no host-side watcher (the five no-hook
			// sources — Codex/OpenCode/Cursor/Copilot CLI/Copilot Chat — only
			// surface state through on-disk transcripts), so refresh is the
			// only update path after the initial `handleReady` push.
			void this.pushConversations();
		}
		if (scope === "status" || scope === "all") {
			void this.deps.executeCommand("jollimemory.refreshStatus");
		}
	}

	/**
	 * Used by destructive host-side operations (currently Migrate to Memory Bank)
	 * to force the client to drop its `folderCache` before the next listing
	 * arrives. The follow-up `handleExpandFolder("")` then re-fetches the root
	 * listing — auto-expand of the new current repo is driven by the next
	 * `kb:foldersData`'s `isCurrentRepo` flag, not by passing the folder name in
	 * this message.
	 *
	 * Safe to call even when the view hasn't resolved yet — postMessage no-ops,
	 * and the next `ready` will pick up the new state via getInitialState().
	 */
	refreshKnowledgeBaseFolders(): void {
		// Drop the "this repo is clean" memo before re-fetching so external
		// writes (post-commit, migration, manual file deletion / iCloud
		// eviction) actually re-trigger reconcile + heal. Without this the
		// memo would survive the kb:foldersReset and the follow-up
		// handleExpandFolder("") would short-circuit past the heal pipeline,
		// leaving evicted .md files unrecovered until a window reload.
		this.deps.kbFolders?.notifyDirty?.();
		this.postMessage({ type: "kb:foldersReset" });
		void this.handleExpandFolder("");
		// Also re-push the breadcrumb's repo list AND the active repo's
		// branches: those use the `selection:*` messages which are
		// otherwise only sent at init / repo-switch time. Pre-fix, a sync
		// round (or any external write that added a new branch directory)
		// would leave the breadcrumb's branch dropdown frozen on the
		// pre-sync set until the user manually switched repos. `listRepos`
		// and `listBranches` both read fresh from disk on every call, so
		// this re-push immediately reflects whatever the latest
		// `branches.json` says.
		if (this.deps.selection) {
			this.pushRepos();
			const repos = this.deps.selection.listRepos();
			const current = repos.find((r) => r.isCurrent) ?? repos[0];
			if (current) this.pushBranches(current.repoName);
		}
	}

	/**
	 * Clears one Folders-tab file row's ✎ marker in place after a successful
	 * single-file revert. Unlike {@link refreshKnowledgeBaseFolders} this does
	 * NOT wipe `folderCache`, so every expanded branch directory stays open — a
	 * content revert touches one file's bytes, not the tree's shape, so the
	 * heavyweight reset (which collapses the whole tree) is the wrong response.
	 * `relPath` is the repoDir-prefixed forward-slash path used as the client's
	 * `folderCache` key. A non-Memory-Bank path (revert fired from the explorer
	 * menu on an unrelated `.md`) simply finds no matching row and no-ops.
	 */
	clearKnowledgeBaseFolderDivergence(relPath: string): void {
		// Claim "latest signal" for this row so any in-flight open-file check
		// resolves into a no-op — the revert's clear is authoritative.
		this.bumpDivergenceSeq(relPath);
		this.postMessage({ type: "kb:clearDiverged", path: relPath });
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

	/**
	 * Pushed whenever the user's `configured` state changes — i.e. whenever
	 * either of the two underlying signals (`signedIn`, `hasApiKey`) flips.
	 * Drives the onboarding-panel vs main-UI split in the webview.
	 */
	notifyConfiguredChanged(configured: boolean): void {
		this.postMessage({ type: "configured:changed", configured });
	}

	/**
	 * Pushed only on the failure path of the inline onboarding API key save.
	 * Successful saves flip `configured` and ride the regular
	 * `configured:changed` channel — no explicit success ack here. The
	 * failure path needs an explicit message because nothing in
	 * statusStore changes to trigger the existing reactive plumbing.
	 */
	notifyApiKeySaveError(message: string): void {
		this.postMessage({ type: "apikey:saveError", message });
	}

	private pushStatus(): void {
		if (!this.deps.statusProvider) return;
		this.postMessage({
			type: "status:data",
			entries: this.deps.statusProvider.serialize(),
		});
		// Worker-busy travels on its own channel so the Branch tab toolbar can
		// react without re-parsing status entries. Pushed alongside status:data
		// because both originate from the same StatusStore change event.
		this.postMessage({
			type: "worker:busy",
			busy: this.deps.statusProvider.getWorkerBusy(),
		});
		// Sync-phase indicator. Optional on the provider interface so existing
		// tests that don't stub `getSyncPhase` keep working unchanged.
		const getSyncPhase = this.deps.statusProvider.getSyncPhase;
		if (getSyncPhase) {
			this.postMessage({
				type: "sync:phase",
				phase: getSyncPhase(),
			});
		}
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

	/**
	 * Pushes the Branch tab's Active Conversations list. Always emits a
	 * message when the provider is wired, so the webview can swap its
	 * "Loading…" placeholder for an empty state on first paint.
	 *
	 * Uses `listWithDiagnostics()` (not the simpler `list()`) so the outbound
	 * message carries `failedSources` — the set of TranscriptSource keys
	 * whose discoverer threw or returned a structured `r.error`. The webview
	 * surfaces that as a partial-data hint instead of silently presenting an
	 * incomplete list. The catch below is a defensive double-guard: the
	 * provider already swallows aggregator throws, but a future change that
	 * re-throws should still leave the webview in a renderable state.
	 */
	private async pushConversations(): Promise<void> {
		if (!this.deps.activeSessionsProvider) return;
		// Ride this 60s tick to extract Codex references on the polling path.
		// Fire-and-forget: `discover()` resolves cwd itself and a per-cwd
		// single-flight inside the impl collapses the multiple callers of
		// pushConversations (tick / handleReady / refresh / detail-panel save).
		// It is contractually non-throwing, but this is an opportunistic
		// background extraction — guard it so even a regressed wrapper can never
		// take down the user's conversation list, which is what this method exists
		// to render.
		try {
			this.deps.codexReferenceDiscovery?.discover();
		} catch {
			// ignore — background discovery must never break the refresh.
		}
		try {
			const { items, failedSources } =
				await this.deps.activeSessionsProvider.listWithDiagnostics();
			this.postMessage({
				type: "branch:conversationsData",
				items,
				failedSources: [...failedSources],
			});
		} catch (err) {
			log.warn(
				"SidebarWebviewProvider",
				"pushConversations: listWithDiagnostics() threw — emitting empty conversations",
				err instanceof Error ? err.message : err,
			);
			this.postMessage({
				type: "branch:conversationsData",
				items: [],
				failedSources: [],
			});
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
			// Opening a `.md` is the one place divergence is checked outside the
			// Folders-tab listing. Mirror that result onto the tree's ✎ marker so
			// a file edited on disk while the sidebar was already open lights up
			// the moment the user opens it — no manual refresh required.
			void this.markDivergedIfNeeded(relPath, abs);
		} else {
			void this.deps.executeCommand("vscode.open", vscode.Uri.file(abs));
		}
	}

	private bumpDivergenceSeq(relPath: string): number {
		const next = (this.divergenceCheckSeq.get(relPath) ?? 0) + 1;
		this.divergenceCheckSeq.set(relPath, next);
		return next;
	}

	private async markDivergedIfNeeded(
		relPath: string,
		abs: string,
	): Promise<void> {
		if (!this.deps.isMemoryFileDivergedOnDisk) return;
		// Claim "latest signal" for this row, then drop our result if a newer
		// open or a revert bumped the same path while our async disk check was in
		// flight — the newer signal is authoritative and posts the correct state.
		const seq = this.bumpDivergenceSeq(relPath);
		const diverged = await this.deps.isMemoryFileDivergedOnDisk(abs);
		if ((this.divergenceCheckSeq.get(relPath) ?? 0) !== seq) return;
		// Mirror the disk result onto the row BOTH ways: mark when diverged, clear
		// when in sync. The clear is what lets reopening a now-synced file drop a
		// ✎ left by an earlier open (or a stale listing) — without it the row
		// stays marked until an explicit revert or full refresh. A clear for a row
		// that isn't currently marked is a no-op client-side.
		this.postMessage({
			type: diverged ? "kb:markDiverged" : "kb:clearDiverged",
			path: relPath,
		});
	}

	public async refreshConversationsPanel(): Promise<void> {
		await this.pushConversations();
	}

	public async refreshPlansPanel(): Promise<void> {
		this.pushPlans();
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
		if (this.conversationsRefreshTimer) {
			clearInterval(this.conversationsRefreshTimer);
			this.conversationsRefreshTimer = undefined;
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
