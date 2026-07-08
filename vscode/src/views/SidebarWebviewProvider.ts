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
import type { PinEntry, PinKind } from "../../../cli/src/core/PinStore.js";
import { resolveSessionTitle } from "../../../cli/src/core/SessionTitleResolver.js";
import { getTranscriptIds } from "../../../cli/src/core/SummaryTree.js";
import type {
	CommitSummary,
	StoredSession,
	StoredTranscript,
	TranscriptEntry,
	TranscriptSource,
} from "../../../cli/src/Types.js";
import { isTranscriptSource } from "../../../cli/src/Types.js";
import type { ActiveConversationItem } from "../../../cli/src/core/ActiveSessionAggregator.js";
import type { ActiveSessionsProvider } from "../services/ActiveSessionsProvider.js";
import type { CommitFileInfo } from "../Types.js";
import { flushExtensionTelemetry } from "../TelemetryActivation.js";
import type { IngestPhase } from "../stores/StatusStore.js";
import { log } from "../util/Logger.js";
import { ConversationDetailsPanel } from "./ConversationDetailsPanel.js";
import { SIDEBAR_EMPTY_STRINGS } from "./SidebarEmptyMessages.js";
import { buildSidebarHtml } from "./SidebarHtmlBuilder.js";
import type {
	BackfillCandidate,
	BackfillResultRow,
	BackfillScope,
	BranchMemoryItem,
	FolderNode,
	MemoryEvidence,
	MemoryEvidenceItem,
	MemoryItem,
	RepoChoice,
	SerializedTreeItem,
	SidebarInboundMsg,
	SidebarOutboundMsg,
	SidebarState,
} from "./SidebarMessages.js";
import { sliceStartTime } from "./TranscriptSliceOrder.js";

/**
 * Closed set of reference `SourceId`s (mirrors `SourceId` in cli Types.ts).
 * Used to validate the `source` on an inbound `kb:openEvidenceReference`
 * message — webview messages cross a trust boundary, so an unknown source is
 * dropped rather than forwarded into the archived-snapshot read path.
 */
const REFERENCE_SOURCE_IDS = new Set<string>(["linear", "jira", "github", "notion"]);

/**
 * Built-in VS Code commands the sidebar webview is allowed to dispatch, in
 * addition to this extension's own `jollimemory.*` commands. `vscode.open`
 * follows external links (the "View on Jolli" PR / synced-doc rows) since a
 * webview cannot navigate `<a href>` itself. `vscode.openFolder` backs the
 * no-workspace onboarding CTA (applyDegraded sets the enable button's
 * data-command to it); it is dispatched argless, so it only ever raises the
 * native folder picker. Keep this list minimal — every entry is a command a
 * webview-controlled message can trigger on the host.
 */
const ALLOWED_BUILTIN_WEBVIEW_COMMANDS = new Set<string>(["vscode.open", "vscode.openFolder"]);

/** True when the webview may ask the host to run `command` (see the set above). */
function isAllowedWebviewCommand(command: string): boolean {
	return command.startsWith("jollimemory.") || ALLOWED_BUILTIN_WEBVIEW_COMMANDS.has(command);
}

/**
 * Argument-level guard for the built-in commands on the allowlist. Gating the
 * command NAME is not enough for `vscode.open`: it resolves whatever URI it is
 * handed, so a webview-controlled `command:` URI would execute an arbitrary VS
 * Code command (with webview-controlled args), and `file:` / `vscode:` URIs
 * would open local files or trigger deep-link handlers. A corrupted or hostile
 * memory row's `href` flows straight into this path, so the payload — not just
 * the name — crosses the trust boundary. Only external `https:` links (the
 * "View on Jolli" PR / synced-doc rows the sidebar actually needs) are allowed
 * through; every other scheme is dropped. `vscode.openFolder` is only allowed
 * argless (raising the native folder picker) — a webview-supplied folder URI
 * would open an arbitrary folder as a trusted workspace, so any args are
 * dropped. `jollimemory.*` commands are dispatched only from host-defined call
 * sites, so their args are trusted.
 */
function isAllowedWebviewCommandArgs(command: string, args: ReadonlyArray<unknown> | undefined): boolean {
	if (command === "vscode.openFolder") return args === undefined || args.length === 0;
	if (command !== "vscode.open") return true;
	const target = args?.[0];
	if (typeof target !== "string") return false;
	try {
		return new URL(target).protocol === "https:";
	} catch {
		return false;
	}
}

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
		/**
		 * Returns the current ingest display state from StatusStore. Pushed to the
		 * webview as `ingest:phase` so the Branch tab toolbar can show the matching
		 * "Building knowledge wiki/graph…" pill during a topic-KB ingest. Fully
		 * independent of worker-busy (ingest has its own lock). Optional so existing
		 * tests that only stub `getWorkerBusy` keep compiling.
		 */
		getIngest?: () => { readonly busy: boolean; readonly phase: IngestPhase };
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
	/**
	 * Returns the absolute path under kbRoot for a relative path, or `undefined`
	 * when `relPath` would escape the Memory Bank parent (traversal guard).
	 */
	resolveKbAbs?: (relPath: string) => string | undefined;
	/**
	 * True when the Memory Bank `.md` at `abs` has been edited on disk and its
	 * sha256 no longer matches the manifest fingerprint. Consulted from
	 * `handleOpenFile` so opening a diverged file surfaces the Folders-tab ✎
	 * marker immediately (the row is already rendered; we just flip its flag)
	 * instead of waiting for the next full re-listing. Optional so existing
	 * tests that inject only `resolveKbAbs` keep working; absent → no check.
	 */
	isMemoryFileDivergedOnDisk?: (abs: string) => Promise<boolean>;
	/**
	 * Back-fill cold-start card orchestration. Optional so existing provider
	 * tests can omit it (absent → the four backfill:* messages are inert no-ops).
	 * Wired in Extension.ts against the isolated CLI back-fill engine:
	 *   - `listCandidates` runs a dry-run (no LLM) and returns the selectable rows
	 *     + the full-scope missing count.
	 *   - `run` generates summaries for the given hashes, streaming per-commit
	 *     progress through `onProgress`, and resolves with the result rows.
	 *   - `dismiss` persists the per-repo "card dismissed" marker.
	 */
	backfill?: {
		listCandidates(scope: BackfillScope): Promise<{
			items: ReadonlyArray<BackfillCandidate>;
			totalMissing: number;
		}>;
		run(
			hashes: ReadonlyArray<string>,
			onProgress: (done: number, total: number, subject: string, failed: boolean) => void,
		): Promise<{
			rows: ReadonlyArray<BackfillResultRow>;
			generated: number;
			skipped: number;
			errors: number;
		}>;
		dismiss(): void;
	};
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
	/**
	 * Resolves the workspace HEAD short hash, attached to `worker:busy` while
	 * the blocking summary runs so the webview's "Summarizing <hash>…" row can
	 * name the commit. Returns undefined on any failure (detached/empty repo).
	 * Optional so existing provider tests keep compiling without a stub.
	 */
	getHeadShortHash?: () => string | undefined;
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
	 * Polling-path Codex artifact discovery. Invoked (fire-and-forget) on every
	 * Active Conversations refresh — the same 60s tick that discovers Codex
	 * sessions — so references a Codex session fetched via MCP surface in
	 * Plans & Notes within ~60s, without any hook. `discover()` resolves the
	 * workspace cwd itself and MUST never throw/reject (the impl swallows errors),
	 * so callers `void`-call it. Optional so existing tests can omit it.
	 */
	codexDiscovery?: { discover(): void };
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
	/**
	 * Clear ALL commit selections in CommitsStore. Called when the squash UI
	 * enters or exits selection mode so host-side isSelected flags never go
	 * stale across squash sessions (the webview squashMode flag is local only).
	 */
	deselectAllCommits?: () => void;
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
	 * Dismiss one AI soft-exclude suggestion — removes it from aiSuggestedExclude so
	 * the item lands normally. `kind` is the single-form context kind; the handler
	 * maps it to the plural ExclusionKind for removeAiExclusion.
	 */
	applyDismissAiExclude?: (kind: "plan" | "note" | "reference", key: string) => void | Promise<void>;
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
	/**
	 * Access to the PinStore operations. Optional so existing tests (which
	 * don't exercise pin/unpin) keep compiling without changes. When absent,
	 * `branch:pin` / `branch:unpin` messages are silently ignored and
	 * `pushPins()` posts an empty list.
	 */
	pinStore?: {
		addPin(projectDir: string, repoName: string, branchName: string, entry: PinEntry): Promise<void>;
		removePin(projectDir: string, repoName: string, branchName: string, kind: PinKind, id: string): Promise<void>;
		listPins(projectDir: string, repoName: string, branchName: string): Promise<PinEntry[]>;
	};
	/**
	 * Source-aware summary lookup for the Timeline's `kb:expandMemory` handler.
	 * Returns the `CommitSummary` together with its provenance (`sourceRepoName` /
	 * `sourceRemoteUrl`) so that `pushMemoryEvidence` can route transcript reads
	 * to the correct repo's storage rather than always reading from the cwd
	 * workspace storage (which lacks transcripts for foreign-repo memories).
	 *
	 * Optional so existing tests that don't exercise `kb:expandMemory` keep
	 * compiling without changes. When absent, `pushMemoryEvidence` falls back
	 * to `getSummaryByHash` (no source provenance, cwd storage used for
	 * transcripts). When both are absent, evidence groups are empty.
	 *
	 * Wired in Extension.ts via `bridge.getSummaryAnyRepoWithSource(hash)`.
	 */
	getSummaryAnyRepoWithSource?: (commitHash: string) => Promise<{
		summary: CommitSummary | undefined;
		sourceRepoName: string | null;
		sourceRemoteUrl: string | null;
	}>;
	/**
	 * Resolves a commit hash to its stored `CommitSummary`. Optional fallback
	 * for tests that mock only the simple lookup without source provenance.
	 * `getSummaryAnyRepoWithSource` takes precedence when both are wired.
	 */
	getSummaryByHash?: (commitHash: string) => Promise<CommitSummary | undefined>;
	/**
	 * Reads the `StoredTranscript` for a given transcript ID from the repo
	 * identified by `sourceRepoName` / `sourceRemoteUrl`. When `sourceRepoName`
	 * is non-null the implementation reads from that foreign repo's FolderStorage
	 * (mirroring `SummaryWebviewPanel`'s detail-panel read path); when null it
	 * reads from the current workspace storage. Optional; when absent,
	 * `readTranscriptById` is tried as a fallback (cwd storage only).
	 *
	 * Wired in Extension.ts via `bridge.createStorageForRepo` /
	 * `bridge.createReadStorageForCurrentRepo` + `readTranscript`.
	 */
	readTranscriptForRepo?: (
		id: string,
		sourceRepoName: string | null,
		sourceRemoteUrl: string | null,
	) => Promise<StoredTranscript | null>;
	/**
	 * Reads the `StoredTranscript` for a given transcript ID from the current
	 * workspace storage. Optional fallback used when `readTranscriptForRepo` is
	 * absent; when both are absent, conversations evidence is empty.
	 */
	readTranscriptById?: (id: string) => Promise<StoredTranscript | null>;
	/**
	 * Returns aggregated LLM token counts across all committed summaries on
	 * the current branch. Called alongside `pushCommits` so the token bar
	 * renders immediately when commits data arrives. Optional: when absent,
	 * no `branch:tokenStats` message is posted (the bar keeps whatever it last
	 * showed). When present, a message is posted on every refresh — INCLUDING a
	 * zero-total result — so a switch to an empty branch clears any prior bar
	 * instead of stranding a stale one. Must never reject — caller uses
	 * `.catch(() => undefined)`.
	 */
	getBranchTokenStats?: () => Promise<{
		input: number;
		output: number;
		cached: number;
		/**
		 * Scalar branch total (Σ `aggregateConversationTokens` per root) — the SAME
		 * basis each memory row's subline uses, so the bar total reconciles with the
		 * sum of its rows even when legacy roots carry a scalar `conversationTokens`
		 * with no per-segment breakdown. Always ≥ input+output+cached; the difference
		 * is untracked legacy tokens the coloured segments cannot attribute.
		 */
		total: number;
		reporting: number;
		memories: number;
		/**
		 * Σ per-root estimated USD cost from the stored per-model usage
		 * (`aggregateEstimatedCost`). A lower bound — 0 for roots with no priced
		 * model or written before the field existed. When 0, the webview falls
		 * back to a client-side Sonnet-rate estimate off the segment breakdown.
		 */
		estimatedCostUsd?: number;
	}>;
	/**
	 * Returns the real per-file git status (A/M/D/R + rename oldPath) for a
	 * commit — the same `git diff-tree --name-status` projection the Branch-tab
	 * commit-file rows use. Wired in Extension.ts via `bridge.listCommitFiles`.
	 *
	 * Used by `pushMemoryEvidence` to source a LOCAL memory's FILES group from
	 * git truth instead of the summary's path-only `topic.filesAffected`, so
	 * `jollimemory.openCommitFileChange` opens the correct diff for added /
	 * deleted / renamed files (a path-only list defaulted every file to 'M',
	 * which errored "file not found" for non-modified files). Optional: when
	 * absent (or it yields nothing) the path-only topic projection is the
	 * fallback. Foreign-repo memories never call it — their commit can't be
	 * diffed against the workspace git, so their rows are non-interactive.
	 */
	listCommitFiles?: (commitHash: string) => Promise<ReadonlyArray<CommitFileInfo>>;
	/**
	 * Looks up the open GitHub PR for the given branch via `gh pr list`.
	 * Returns `{ number, url }` when an open PR is found, or `undefined` when
	 * there is none. Runs `gh` as a subprocess — callers must guard failures
	 * with try/catch. Optional so existing tests keep compiling without changes.
	 * Wired in Extension.ts via `findOpenPrForBranch(workspaceRoot, branch)`.
	 */
	findOpenPrForBranch?: (branch: string) => Promise<{ number: number; url: string } | undefined>;
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
	private readonly broadcastTargets = new Set<vscode.Webview>();
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
				// Pins are grouped per branch (pinGroupKey(repo, branch)). A git
				// checkout changes which group is current, so re-push or the
				// Pinned section keeps showing the previous branch's pins until a
				// manual refresh — and a pin added meanwhile lands in the new
				// branch's group while the stale list hides it. Skip when the user
				// is viewing a foreign branch via the breadcrumb (selectedBranchName
				// set): that selection is independent of the workspace HEAD.
				if (this.selectedBranchName === undefined) void this.pushPins();
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
		// JOLLI-1785: piggyback the existing 60s tick to flush buffered telemetry.
		// Fire-and-forget; the helper swallows all errors and no-ops on an empty buffer.
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		// Pass the live platform opt-out so the flush-time consent re-gate honors a
		// VS Code telemetry toggle even for events buffered before it was turned off.
		if (cwd) flushExtensionTelemetry(cwd, !vscode.env.isTelemetryEnabled);
	}

	/**
	 * Lets a second webview (the Next Memory review panel) receive the same
	 * host→webview pushes the sidebar gets, so both surfaces render from one
	 * data stream and never drift. The panel registers on open, unregisters
	 * in its onDidDispose.
	 */
	registerBroadcastTarget(webview: vscode.Webview): void {
		this.broadcastTargets.add(webview);
	}

	unregisterBroadcastTarget(webview: vscode.Webview): void {
		this.broadcastTargets.delete(webview);
	}

	/** Send a message to the webview client. No-op when the view is not resolved. */
	postMessage(msg: SidebarInboundMsg): void {
		if (this.view) void this.view.webview.postMessage(msg);
		for (const target of this.broadcastTargets) {
			void target.postMessage(msg);
		}
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
		void this.pushPins();
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

	handleOutbound(raw: unknown): void {
		if (!isOutbound(raw)) return;
		const msg: SidebarOutboundMsg = raw;
		switch (msg.type) {
			case "ready":
				void this.handleReady();
				return;
			case "command":
				// Defense-in-depth (confused-deputy): the webview can only ask the
				// host to run this extension's own commands. `msg.command` is
				// webview-supplied and flows straight into executeCommand — without a
				// check, any VS Code command (built-in or from another extension)
				// could be invoked with webview-controlled args. Sidebar-dispatched
				// commands are `jollimemory.*`, PLUS a tiny allowlist of built-ins the
				// sidebar itself needs: `vscode.open` is how it follows external links
				// (webviews don't navigate `<a href>`), e.g. the "View on Jolli" PR /
				// synced-doc rows in the Branch view.
				if (typeof msg.command !== "string" || !isAllowedWebviewCommand(msg.command)) {
					log.warn("SidebarWebviewProvider", `Blocked disallowed command from webview: ${msg.command}`);
					return;
				}
				// Name-allowlisted, but built-ins like `vscode.open` also need their
				// URI argument validated — an unchecked scheme (command:/file:/vscode:)
				// re-opens the confused-deputy hole the name gate closed.
				if (!isAllowedWebviewCommandArgs(msg.command, msg.args)) {
					log.warn("SidebarWebviewProvider", `Blocked disallowed command args from webview: ${msg.command}`);
					return;
				}
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
			case "kb:expandMemory":
				void this.pushMemoryEvidence(msg.commitHash);
				return;
			case "kb:openEvidenceNote":
				// Committed-memory note evidence row. Routes to the orphan-only
				// previewNote (the same command the detail panel uses for committed
				// notes), passing the memory's provenance so a foreign-repo note
				// reads from the owning repo's storage. The live openNoteForPreview
				// would silently no-op here — the note is gone from plans.json.
				void this.deps.executeCommand(
					"jollimemory.previewNote",
					msg.noteId,
					msg.title,
					msg.sourceRepoName,
					msg.sourceRemoteUrl,
				);
				return;
			case "kb:openEvidencePlan":
				// Foreign-repo committed-memory plan evidence row. Routes to
				// previewCommittedPlan, passing the memory's provenance so the plan
				// body reads from the owning repo's FolderStorage. The live
				// openPlanForPreview path resolves against the current workspace and
				// can't see a foreign repo's plan.
				void this.deps.executeCommand(
					"jollimemory.previewCommittedPlan",
					msg.planId,
					msg.title,
					msg.sourceRepoName,
					msg.sourceRemoteUrl,
				);
				return;
			case "kb:openEvidenceReference": {
				// Committed-memory reference evidence row. The archived snapshot is
				// read off the orphan branch by source + archivedKey; the live
				// openReferenceForPreview path is dead post-commit. `source` crosses
				// a trust boundary, so validate it against the closed SourceId set
				// before forwarding (mirrors branch:openConversation's source check).
				if (!REFERENCE_SOURCE_IDS.has(msg.source)) {
					log.warn("SidebarWebviewProvider", "Rejected kb:openEvidenceReference with unknown source", {
						source: String(msg.source),
					});
					return;
				}
				void this.deps.executeCommand(
					"jollimemory.previewCommittedReference",
					msg.archivedKey,
					msg.source,
					msg.sourceRepoName,
					msg.sourceRemoteUrl,
				);
				return;
			}
			case "branch:openPlan":
				// Sidebar row-click → markdown preview, not editor. Editing goes
				// through the context menu's "Edit Plan" (editPlan).
				void this.deps.executeCommand(
					"jollimemory.openPlanForPreview",
					msg.planId,
				);
				return;
			case "branch:openNote":
				// Sidebar row-click → markdown preview, not editor. Editing goes
				// through the context menu's "Edit Note" (editNote). Differs
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
			case "branch:openReferencePreview":
				// Sidebar row-click → rendered markdown preview, matching the
				// plan/note rows. "Edit Markdown" in the context menu keeps the
				// editor path (branch:openReferenceMarkdown).
				void this.deps.executeCommand(
					"jollimemory.openReferenceForPreview",
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
			case "kb:openEvidenceConversation":
				// Committed-memory conversation evidence row. Unlike
				// branch:openConversation, this reads the ARCHIVED snapshot off
				// the orphan branch and renders it read-only — the live
				// cursor-trimmed path is empty for a committed memory. Same trust
				// boundary as branch:openConversation: every field is `unknown`
				// at runtime and must be validated before it routes a storage
				// read / flows into the panel DOM.
				if (!isTranscriptSource(msg.source)) {
					log.warn(
						"SidebarWebviewProvider",
						"Rejected kb:openEvidenceConversation with unknown source",
						{ source: String(msg.source) },
					);
					return;
				}
				if (
					typeof msg.commitHash !== "string" ||
					msg.commitHash.length === 0 ||
					typeof msg.sessionId !== "string" ||
					msg.sessionId.length === 0 ||
					typeof msg.title !== "string" ||
					msg.title.length === 0
				) {
					log.warn(
						"SidebarWebviewProvider",
						"Rejected kb:openEvidenceConversation with non-string or empty commitHash/sessionId/title",
					);
					return;
				}
				void this.openEvidenceConversation(msg.commitHash, msg.sessionId, msg.source, msg.title);
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
			case "branch:deselectAllCommits":
				this.deps.deselectAllCommits?.();
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
			case "branch:dismissAiExclude":
				void this.deps.applyDismissAiExclude?.(msg.kind, msg.key);
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
			case "branch:pin": {
				const state = this.deps.getInitialState();
				const repo = this.selectedRepoName ?? state.currentRepoName ?? "";
				// Resolve the branch the same way pushPins() does: the live HEAD from
				// branchWatcher is authoritative because state.branchName can lag a
				// fresh checkout. A pin written under the stale branch group would
				// never surface in the pushPins() read (which uses the live branch).
				const branch =
					this.selectedBranchName ?? this.deps.branchWatcher?.current().name ?? state.branchName;
				const projectDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (projectDir && repo && this.deps.pinStore) {
					void this.deps.pinStore
						.addPin(projectDir, repo, branch, {
							kind: msg.kind,
							id: msg.id,
							title: msg.title,
							pinnedAt: Date.now(),
							// Persist source/transcriptPath only when non-empty.
							// Webview messages cross a trust boundary, and an empty
							// string here would round-trip into a conversation pin
							// the openConversation handler later rejects as empty —
							// a row that silently does nothing on click.
							...(msg.source ? { source: msg.source } : {}),
							...(msg.transcriptPath ? { transcriptPath: msg.transcriptPath } : {}),
						})
						.then(() => this.pushPins())
						// The webview only renders pins from the pushPins response —
						// it never optimistically draws the row — so a swallowed write
						// failure would leave the user's click doing nothing with no
						// signal. Log it instead of leaking an unhandled rejection.
						.catch((err) =>
							log.warn(
								"SidebarWebviewProvider",
								`addPin failed: ${err instanceof Error ? err.message : String(err)}`,
							),
						);
				}
				return;
			}
			case "branch:unpin": {
				const state = this.deps.getInitialState();
				const repo = this.selectedRepoName ?? state.currentRepoName ?? "";
				// Resolve the branch the same way pushPins() does: the live HEAD from
				// branchWatcher is authoritative because state.branchName can lag a
				// fresh checkout. A pin written under the stale branch group would
				// never surface in the pushPins() read (which uses the live branch).
				const branch =
					this.selectedBranchName ?? this.deps.branchWatcher?.current().name ?? state.branchName;
				const projectDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (projectDir && repo && this.deps.pinStore) {
					void this.deps.pinStore
						.removePin(projectDir, repo, branch, msg.kind, msg.id)
						.then(() => this.pushPins())
						.catch((err) =>
							log.warn(
								"SidebarWebviewProvider",
								`removePin failed: ${err instanceof Error ? err.message : String(err)}`,
							),
						);
				}
				return;
			}
			case "kb:requestPrStatus": {
				// Fire-and-forget: never throw — post pr: null on any failure or
				// when the dep is absent. Mirrors the fire-and-forget pattern of
				// other optional-dep handlers (e.g. kb:expandMemory / pushCommits).
				const { branch } = msg;
				void (async () => {
					let pr: { number: number; url: string } | null = null;
					if (this.deps.findOpenPrForBranch) {
						try {
							pr = (await this.deps.findOpenPrForBranch(branch)) ?? null;
						} catch {
							pr = null;
						}
					}
					this.postMessage({ type: "kb:prStatus", branch, pr });
				})();
				return;
			}
			case "backfill:requestCandidates": {
				const { scope } = msg;
				void this.handleBackfillRequestCandidates(scope);
				return;
			}
			case "backfill:run": {
				const { hashes } = msg;
				void this.handleBackfillRun(hashes);
				return;
			}
			case "backfill:dismiss":
				this.deps.backfill?.dismiss();
				return;
			case "backfill:openSettings":
				void this.deps.executeCommand("jollimemory.openSettings");
				return;
			default:
				return;
		}
	}

	/**
	 * Dry-run attribution for the cold-start card (no LLM). Never throws — a
	 * failure posts an empty candidate set so the card can show its empty/error
	 * copy rather than hanging on the spinner.
	 */
	private async handleBackfillRequestCandidates(scope: BackfillScope): Promise<void> {
		if (!this.deps.backfill) {
			this.postMessage({ type: "backfill:candidates", scope, items: [], totalMissing: 0 });
			return;
		}
		try {
			const { items, totalMissing } = await this.deps.backfill.listCandidates(scope);
			this.postMessage({ type: "backfill:candidates", scope, items, totalMissing });
		} catch {
			this.postMessage({ type: "backfill:candidates", scope, items: [], totalMissing: 0 });
		}
	}

	/**
	 * Runs the real back-fill for the selected hashes, streaming per-commit
	 * progress to the card and finishing with the result list. Never throws — a
	 * failure posts a terminal `backfill:done` with an errored summary so the
	 * card leaves its progress state.
	 */
	private async handleBackfillRun(hashes: ReadonlyArray<string>): Promise<void> {
		if (!this.deps.backfill || hashes.length === 0) {
			this.postMessage({ type: "backfill:done", rows: [], generated: 0, skipped: 0, errors: 0 });
			return;
		}
		try {
			const result = await this.deps.backfill.run(hashes, (done, total, subject, failed) => {
				this.postMessage({ type: "backfill:progress", done, total, subject, failed });
			});
			this.postMessage({
				type: "backfill:done",
				rows: result.rows,
				generated: result.generated,
				skipped: result.skipped,
				errors: result.errors,
			});
		} catch {
			this.postMessage({
				type: "backfill:done",
				rows: [],
				generated: 0,
				skipped: 0,
				errors: hashes.length,
			});
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
			void this.pushPins();
			return;
		}
		if (branchName) {
			this.selectedBranchName = branchName;
			this.postMessage({
				type: "selection:set",
				repoName: this.selectedRepoName,
				branchName,
			});
			void this.pushPins();
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

	/**
	 * Reads every archived `StoredSession` for a commit's transcripts, deduped by
	 * (source, sessionId) in first-seen order. Routes the read to the owning
	 * repo's storage via `readTranscriptForRepo` (foreign-repo memories), falling
	 * back to `readTranscriptById` (cwd storage) then to `[]` when neither dep is
	 * wired. Per-transcript read failures degrade to an empty slice + a warn,
	 * never throw — both callers (`pushMemoryEvidence` projection and the archived
	 * conversation opener) treat a missing transcript as "no conversations".
	 *
	 * Dedupe-and-merge is essential for consolidated / squashed memories: a
	 * long-running session is captured once per commit it spans, each transcript
	 * holding only the unread turns consumed at THAT commit (disjoint, sequential
	 * slices — not a full copy). A consolidated summary references every such
	 * transcript, so a naive flatten emitted one duplicate row per slice (observed
	 * as 17 identical rows for a single session) and the opener's `sessions.find`
	 * surfaced just the first slice. Collapsing by (source, sessionId) and
	 * concatenating slices in first-seen order yields one row per session whose
	 * `entries` reconstruct the full conversation. The first-seen
	 * source/transcriptPath win — they are identical across a session's slices.
	 */
	private async readArchivedSessions(
		summary: CommitSummary,
		sourceRepoName: string | null,
		sourceRemoteUrl: string | null,
	): Promise<StoredSession[]> {
		const transcriptIds = getTranscriptIds(summary);
		const readFn = this.deps.readTranscriptForRepo
			? (tid: string) => this.deps.readTranscriptForRepo?.(tid, sourceRepoName, sourceRemoteUrl)
			: this.deps.readTranscriptById
				? (tid: string) => this.deps.readTranscriptById?.(tid)
				: null;
		if (!readFn) return [];
		// Read transcripts concurrently — each readFn call resolves the owning
		// repo's storage independently, so serial awaits would stack the per-read
		// latencies. Promise.all preserves first-seen order.
		const perTranscript = await Promise.all(
			transcriptIds.map(async (tid) => {
				try {
					const stored = await readFn(tid);
					return stored?.sessions ?? [];
				} catch (err) {
					log.warn(
						"SidebarWebviewProvider",
						`readArchivedSessions: failed to read transcript ${tid}: ${err instanceof Error ? err.message : String(err)}`,
					);
					return [];
				}
			}),
		);
		// Collapse the same session across transcripts: keep first-seen order of
		// sessions, gathering each transcript's slice of a session as a separate
		// part. The "claude" default mirrors the reader's back-compat for a
		// source-less stored session and matches the opener's match key + the
		// aggregator's dedupe key, so the same session keys consistently
		// everywhere.
		const order: string[] = [];
		const grouped = new Map<
			string,
			{ base: StoredSession; parts: ReadonlyArray<TranscriptEntry>[] }
		>();
		for (const session of perTranscript.flat()) {
			const key = `${session.source ?? "claude"}:${session.sessionId}`;
			// Coalesce: a malformed stored session may omit `entries` (the JSON
			// field is optional in practice). Treat it as an empty slice so the
			// flatten below never yields an `undefined` entry.
			const entries = session.entries ?? [];
			const existing = grouped.get(key);
			if (existing) {
				existing.parts.push(entries);
			} else {
				order.push(key);
				grouped.set(key, { base: session, parts: [entries] });
			}
		}
		// Reassemble each session by ordering its slices chronologically. The
		// `transcripts` array is NOT in time order for a consolidated memory, but
		// each slice is internally time-ordered and a session's slices occupy
		// disjoint time ranges (cursor consumes turns in order), so sorting slices
		// by their first known timestamp reconstructs the true conversation order.
		// The sort is stable, so slices with no parseable timestamp (legacy data)
		// keep their first-seen order rather than jumping to the front.
		return order.map((key) => {
			// Non-null: every key in `order` was set in `grouped` above.
			const { base, parts } = grouped.get(key) as {
				base: StoredSession;
				parts: ReadonlyArray<TranscriptEntry>[];
			};
			const sorted = [...parts].sort((a, b) => {
				const ta = sliceStartTime(a);
				const tb = sliceStartTime(b);
				if (ta === undefined || tb === undefined) return 0;
				return ta - tb;
			});
			return { ...base, entries: sorted.flat() };
		});
	}

	/**
	 * Reads the `CommitSummary` for `commitHash` and projects it into
	 * `MemoryEvidence` groups (conversations / context / files), then posts
	 * `kb:memoryEvidence` back to the webview so the Timeline can render
	 * per-memory evidence rows without a full detail-panel open.
	 *
	 * Evidence sourcing mirrors `SummaryWebviewPanel.show()`:
	 * - `conversations` — one item per stored session (from each
	 *   `transcripts/{id}.json`), carrying `source` + `transcriptPath` so
	 *   the Timeline can open `ConversationDetailsPanel` exactly as the
	 *   Branch view's `branch:openConversation` does.
	 * - `context` — `summary.plans` / `summary.notes` / `summary.references`,
	 *   each projected to an id/title item for its existing open command.
	 * - `files` — unique relative paths from `summary.topics[].filesAffected`,
	 *   the same source the detail pane's topic-level files callout uses.
	 *
	 * A foreign-repo memory resolves against the right storage: the summary
	 * lookup returns its source repo provenance, and each transcript is read
	 * from that source repo's storage (falling back to the workspace storage
	 * for local memories).
	 *
	 * On any error (missing summary, read failure), posts empty groups and
	 * never throws so the Timeline row stays interactive.
	 */
	private async pushMemoryEvidence(commitHash: string): Promise<void> {
		const empty: MemoryEvidence = { conversations: [], context: [], files: [] };
		try {
			// Prefer the source-aware lookup so we know which repo owns this
			// memory and can route transcript reads to its storage. Fall back to
			// the simpler getSummaryByHash (no provenance, cwd storage used).
			let summary: CommitSummary | undefined;
			let sourceRepoName: string | null = null;
			let sourceRemoteUrl: string | null = null;
			if (this.deps.getSummaryAnyRepoWithSource) {
				const result = await this.deps.getSummaryAnyRepoWithSource(commitHash);
				summary = result.summary;
				sourceRepoName = result.sourceRepoName;
				sourceRemoteUrl = result.sourceRemoteUrl;
			} else {
				summary = await this.deps.getSummaryByHash?.(commitHash);
			}
			if (!summary) {
				this.postMessage({ type: "kb:memoryEvidence", commitHash, evidence: empty });
				return;
			}

			// — conversations —
			// Title goes through the SAME resolver the working-memory "All
			// Conversations" list uses (resolveSessionTitle), so the two surfaces
			// show identical labels. For Claude that means preferring the
			// `ai-title` row — which is stripped from the archived `entries` and
			// can only be recovered by re-reading the live transcript at
			// `session.transcriptPath`. Without this, the list fell back to the
			// raw first human turn ("继续", "1", "<task-notification>…") or
			// "(untitled session)" even when a human-readable title existed.
			//
			// When the live transcript is gone, resolveSessionTitle degrades to
			// the archived first human turn (we pass `session.entries` as its
			// merged-entries fallback) — identical to the previous behavior, so a
			// deleted transcript is no worse than before, never a throw. `?? []`
			// guards a malformed transcript JSON missing `entries`.
			const archivedSessions = await this.readArchivedSessions(summary, sourceRepoName, sourceRemoteUrl);
			const conversations: MemoryEvidenceItem[] = await Promise.all(
				archivedSessions.map(async (session) => ({
					kind: "conversation" as const,
					id: session.sessionId,
					title: await resolveSessionTitle(
						{
							sessionId: session.sessionId,
							transcriptPath: session.transcriptPath ?? "",
							updatedAt: "",
							source: session.source,
						},
						// readArchivedSessions always returns sessions with `entries` set
						// to an array (`{ ...base, entries: sorted.flat() }`), so the `?? []`
						// fallback arm here is unreachable defensive code.
						/* v8 ignore start */
						session.entries ?? [],
						/* v8 ignore stop */
					),
					...(session.source ? { source: session.source } : {}),
					...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
					// Archived turn count for the trailing "N msgs" evidence-row label.
					// session.entries is the orphan-branch snapshot consumed into this
					// commit, so its length is the memory's conversation depth.
					// `entries` is always an array here (see readArchivedSessions), so the
					// `?? 0` fallback arm is unreachable defensive code.
					/* v8 ignore start */
					messageCount: session.entries?.length ?? 0,
					/* v8 ignore stop */
				})),
			);

			// — context —
			const context: MemoryEvidenceItem[] = [];
			for (const plan of summary.plans ?? []) {
				context.push({ kind: "plan", id: plan.slug, title: plan.title });
			}
			for (const note of summary.notes ?? []) {
				context.push({ kind: "note", id: note.id, title: note.title });
			}
			for (const ref of summary.references ?? []) {
				// `source` is required so the Timeline can read the archived
				// snapshot off the orphan branch (readReferenceFromBranch keys on
				// source + archivedKey); the live openReferenceForPreview path is
				// dead post-commit (registry row deleted, mapKey ≠ archivedKey).
				context.push({ kind: "reference", id: ref.archivedKey, title: ref.title, source: ref.source });
			}

			// — files —
			// Prefer git truth for LOCAL memories: listCommitFiles gives the real
			// per-file status (A/M/D/R) + rename oldPath, so openCommitFileChange
			// opens the correct diff. The summary's topic.filesAffected is path-only
			// — projecting from it defaulted statusCode to 'M', so added / deleted /
			// renamed files diffed against a parent/commit tree where they don't
			// exist and the editor errored "file was not found". Foreign memories
			// can't be diffed against the workspace git at all, so they skip this and
			// keep the path-only projection (their rows are non-interactive).
			const files: MemoryEvidenceItem[] = [];
			let commitFiles: ReadonlyArray<CommitFileInfo> = [];
			if (!sourceRepoName && this.deps.listCommitFiles) {
				try {
					commitFiles = await this.deps.listCommitFiles(commitHash);
				} catch (err) {
					log.warn(
						"SidebarWebviewProvider",
						`listCommitFiles(${commitHash.substring(0, 8)}) failed, falling back to topic paths: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			if (commitFiles.length > 0) {
				for (const f of commitFiles) {
					files.push({
						kind: "file",
						id: f.relativePath,
						title: f.relativePath,
						relativePath: f.relativePath,
						statusCode: f.statusCode,
						...(f.oldPath ? { oldPath: f.oldPath } : {}),
					});
				}
			} else {
				// Fallback (foreign memory, or a commit listCommitFiles couldn't read):
				// path-only projection from topics, deduped in first-seen order. Rows
				// default to statusCode 'M' on the client.
				const seenPaths = new Set<string>();
				for (const topic of summary.topics ?? []) {
					for (const relPath of topic.filesAffected ?? []) {
						if (!seenPaths.has(relPath)) {
							seenPaths.add(relPath);
							files.push({ kind: "file", id: relPath, title: relPath, relativePath: relPath });
						}
					}
				}
			}

			this.postMessage({
				type: "kb:memoryEvidence",
				commitHash,
				evidence: { conversations, context, files, sourceRepoName, sourceRemoteUrl },
			});
		} catch (err) {
			log.warn(
				"SidebarWebviewProvider",
				`pushMemoryEvidence(${commitHash.substring(0, 8)}) failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			this.postMessage({ type: "kb:memoryEvidence", commitHash, evidence: empty });
		}
	}

	/**
	 * Opens a committed memory's conversation from its ARCHIVED snapshot. Mirrors
	 * `pushMemoryEvidence`'s provenance lookup, then re-reads the orphan-branch
	 * sessions and hands the matching session's full `entries` to
	 * `ConversationDetailsPanel` in archived (read-only) mode — the same content
	 * the memory-details "Manage" view shows. The live `branch:openConversation`
	 * path is wrong here: its cursor-trimmed read returns nothing once the turns
	 * have been consumed into the commit summary.
	 *
	 * Never throws — a missing summary / session degrades to a warn so a stale
	 * evidence row (e.g. summary GC'd) cannot break the sidebar.
	 */
	private async openEvidenceConversation(
		commitHash: string,
		sessionId: string,
		source: TranscriptSource,
		title: string,
	): Promise<void> {
		try {
			let summary: CommitSummary | undefined;
			let sourceRepoName: string | null = null;
			let sourceRemoteUrl: string | null = null;
			if (this.deps.getSummaryAnyRepoWithSource) {
				const result = await this.deps.getSummaryAnyRepoWithSource(commitHash);
				summary = result.summary;
				sourceRepoName = result.sourceRepoName;
				sourceRemoteUrl = result.sourceRemoteUrl;
			} else {
				summary = await this.deps.getSummaryByHash?.(commitHash);
			}
			if (!summary) {
				log.warn(
					"SidebarWebviewProvider",
					`openEvidenceConversation: no summary for ${commitHash.substring(0, 8)}`,
				);
				return;
			}
			const sessions = await this.readArchivedSessions(summary, sourceRepoName, sourceRemoteUrl);
			// Match on session + source: sessionId alone is not unique across
			// sources (Claude UUIDs and Cursor hashes share a namespace). Stored
			// sessions default to "claude" when source is absent, mirroring the
			// reader's back-compat default.
			const session = sessions.find((s) => s.sessionId === sessionId && (s.source ?? "claude") === source);
			if (!session) {
				log.warn(
					"SidebarWebviewProvider",
					`openEvidenceConversation: session ${sessionId} not found in ${commitHash.substring(0, 8)}`,
				);
				return;
			}
			ConversationDetailsPanel.show({
				extensionUri: this.deps.extensionUri,
				sessionId,
				source,
				transcriptPath: session.transcriptPath ?? "",
				title,
				archivedEntries: session.entries,
				commitHash,
			});
		} catch (err) {
			log.warn(
				"SidebarWebviewProvider",
				`openEvidenceConversation(${commitHash.substring(0, 8)}) failed: ${err instanceof Error ? err.message : String(err)}`,
			);
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
	private handleRefresh(
		scope:
			| "kb"
			| "branch"
			| "branch-current"
			| "branch-commits"
			| "status"
			| "all",
	): void {
		if (scope === "kb" || scope === "all") {
			void this.handleExpandFolder("");
			void this.deps.executeCommand("jollimemory.refreshMemories");
		}
		// Current Memory block: conversations + context (plans/notes) + files.
		// Split out of the whole-branch refresh so the Current Memory header's
		// own refresh button reloads only the next-memory draft, not the
		// committed history below it.
		if (scope === "branch" || scope === "branch-current" || scope === "all") {
			void this.deps.executeCommand("jollimemory.refreshPlans");
			void this.deps.executeCommand("jollimemory.refreshFiles");
			// Active Conversations has no host-side watcher (the five no-hook
			// sources — Codex/OpenCode/Cursor/Copilot CLI/Copilot Chat — only
			// surface state through on-disk transcripts), so refresh is the
			// only update path after the initial `handleReady` push.
			void this.pushConversations();
			void this.pushPins();
		}
		// Committed Memories section: git history + the foreign-readonly memory
		// cache. The Committed Memories header's refresh button targets this.
		if (scope === "branch" || scope === "branch-commits" || scope === "all") {
			void this.deps.executeCommand("jollimemory.refreshHistory");
			// The workspace-scoped refresh* commands above don't reach the
			// foreign-readonly Branch view's `branchMemoriesCache` (host pushes
			// land in branchData but the foreign render path reads from the
			// per-(repo, branch) cache instead). Without this signal a user
			// viewing a foreign repo+branch sees the Memories section frozen on
			// whatever the first selection load returned, no matter how many
			// times they click Refresh.
			this.postMessage({ type: "selection:invalidateBranchMemories" });
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

	/**
	 * Pushed after `enableJolliMemory` so the cold-start card can appear without a
	 * window reload when the freshly-enabled repo is empty OR has a last-month
	 * back-fill backlog. The webview re-asserts card visibility only when it is
	 * not mid-flow (offer state), so an in-progress / done view is never clobbered.
	 */
	notifyColdStart(signals: {
		readonly coldStartVariant: "empty" | "gaps" | null;
		readonly recentMissingCount: number;
		readonly repoHasMemories: boolean;
		readonly backfillDismissed: boolean;
	}): void {
		this.postMessage({ type: "backfill:coldStart", ...signals });
	}

	/**
	 * Toggle the Status overlay from the native view-title Status icon
	 * (`jollimemory.toggleStatus`). No-ops when the view hasn't resolved —
	 * the title-bar icon is only clickable while the view is visible anyway.
	 */
	toggleStatus(): void {
		this.postMessage({ type: "status:toggle" });
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
		// because both originate from the same StatusStore change event. While
		// busy, attach the HEAD short hash so the Working Memory "Summarizing
		// <hash>…" row can name the commit (only resolved when busy to avoid a
		// git call on every idle status push).
		const workerBusy = this.deps.statusProvider.getWorkerBusy();
		this.postMessage({
			type: "worker:busy",
			busy: workerBusy,
			commit: workerBusy ? this.deps.getHeadShortHash?.() : undefined,
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
		// Ingest indicator. Same StatusStore change event as worker:busy; optional
		// getter so existing stubs keep compiling. Independent of worker:busy — the
		// ingest pill shows even when no summary (worker.lock) is running.
		const getIngest = this.deps.statusProvider.getIngest;
		if (getIngest) {
			const ingest = getIngest();
			this.postMessage({
				type: "ingest:phase",
				busy: ingest.busy,
				phase: ingest.phase,
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

	private async pushPins(): Promise<void> {
		const state = this.deps.getInitialState();
		const repo = this.selectedRepoName ?? state.currentRepoName ?? "";
		// When not viewing a foreign branch, the live HEAD from branchWatcher is
		// the source of truth for the current branch — getInitialState().branchName
		// can lag a fresh checkout (handleReady reads branchWatcher.current() for
		// the displayed name for the same reason). Without this, pins re-pushed
		// from a checkout would still resolve against the stale branch group.
		const branch =
			this.selectedBranchName ?? this.deps.branchWatcher?.current().name ?? state.branchName;
		const projectDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!projectDir || !repo) {
			// Documented empty-list contract — but log so this is distinguishable
			// from "genuinely no pins". A persistently empty Pinned section paired
			// with this line points at an unresolved workspace/repo, not user state.
			log.info("SidebarWebviewProvider", "pushPins: no projectDir/repo resolved, posting empty list", {
				hasProjectDir: !!projectDir,
				hasRepo: !!repo,
			});
			this.postMessage({ type: "branch:pinsData", items: [] });
			return;
		}
		try {
			const items = this.deps.pinStore
				? await this.deps.pinStore.listPins(projectDir, repo, branch)
				: [];
			this.postMessage({ type: "branch:pinsData", items });
		} catch (err) {
			log.warn(
				"SidebarWebviewProvider",
				`pushPins failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			this.postMessage({ type: "branch:pinsData", items: [] });
		}
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
		// Post aggregated token stats alongside commits data. Fire-and-forget;
		// errors degrade silently (no token bar rendered rather than broken view).
		// Not posted in foreign-readonly mode — aggregate is workspace-branch-bound.
		// Both selectedRepoName and selectedBranchName are set together on a foreign breadcrumb pick, so "neither set" == viewing the workspace branch — post stats only then.
		if (this.deps.getBranchTokenStats && !this.selectedRepoName && !this.selectedBranchName) {
			void this.deps
				.getBranchTokenStats()
				.then((stats) => {
					// `cached` here is cache_CREATION only (cache_read is deliberately
					// excluded — see ConversationTokenBreakdown in Types.ts), matching the
					// per-memory subline basis so the two token figures reconcile. The bar
					// TOTAL comes from the scalar `stats.total` (Σ aggregateConversationTokens),
					// NOT input+output+cached: a branch with legacy roots that carry the
					// scalar but no breakdown would otherwise read as LESS than the sum of
					// its own rows. The coloured segments stay a floor of what's attributable.
					// Post unconditionally, INCLUDING total === 0. Skipping the
					// zero-total case leaves the webview's last `state.tokenStats`
					// intact — so switching to a fresh/empty branch would keep the
					// PREVIOUS branch's token bar on screen (a stale 300M+ bar above
					// the "Start coding" empty state). The webview hides the bar when
					// total === 0 (renderTokenBar returns null), so posting zeros is
					// the self-healing reset; withholding the message is the bug.
					this.postMessage({
						type: "branch:tokenStats",
						input: stats.input,
						output: stats.output,
						cached: stats.cached,
						total: stats.total,
						reporting: stats.reporting,
						memories: stats.memories,
						...(stats.estimatedCostUsd !== undefined && { estimatedCostUsd: stats.estimatedCostUsd }),
						scope: "branch",
					});
				})
				.catch(() => undefined);
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
		// Ride this 60s tick to run Codex artifact discovery on the polling path.
		// Fire-and-forget: `discover()` resolves cwd itself and a per-cwd
		// single-flight inside the impl collapses the multiple callers of
		// pushConversations (tick / handleReady / refresh / detail-panel save).
		// It is contractually non-throwing, but this is an opportunistic
		// background extraction — guard it so even a regressed wrapper can never
		// take down the user's conversation list, which is what this method exists
		// to render.
		try {
			this.deps.codexDiscovery?.discover();
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
			// split("/") is always non-empty, so the last segment is a string —
			// index it directly rather than coalescing a pop() that can't be
			// undefined here.
			const segments = relPath.split("/");
			const name = relPath === "" ? "" : segments[segments.length - 1];
			this.postMessage({
				type: "kb:foldersData",
				tree: { name, relPath, isDirectory: true, children: [] },
			});
		}
	}

	private handleOpenFile(relPath: string): void {
		if (!this.deps.resolveKbAbs) return;
		const abs = this.deps.resolveKbAbs(relPath);
		// undefined → resolveKbAbs rejected a traversal escape; do not open it.
		if (!abs) return;
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
		// `seq` is always ≥ 1 (bumpDivergenceSeq increments) and the map is only
		// ever get/set, so `get()` returns the latest number here; an absent
		// entry (undefined) compares unequal to seq exactly as the old `?? 0`
		// did. No coalesce needed — and the fallback was unreachable anyway.
		if (this.divergenceCheckSeq.get(relPath) !== seq) return;
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

	/**
	 * Synchronous snapshot of the current Context selection (plans / notes /
	 * references), for the Next Memory review panel's ticket detection. Reads
	 * the same source `pushPlans()` already reads.
	 */
	getPlansSnapshot(): ReadonlyArray<SerializedTreeItem> {
		return this.deps.plansProvider?.serialize() ?? [];
	}

	/**
	 * Synchronous snapshot of the current Changes/Files rows (including their
	 * `isSelected` flag), for the Next Memory review panel's proposed-title and
	 * diffstat, both computed over the *selected* files. Reads the same source
	 * `pushChanges()` already reads.
	 */
	getFilesSnapshot(): ReadonlyArray<SerializedTreeItem> {
		return this.deps.filesProvider?.serialize() ?? [];
	}

	/**
	 * Snapshot of the current active-conversation list, for the Next Memory
	 * review panel's token meter. Reads the same source `pushConversations()`
	 * already reads.
	 */
	async getConversationsSnapshot(): Promise<ReadonlyArray<ActiveConversationItem>> {
		if (!this.deps.activeSessionsProvider) return [];
		const { items } = await this.deps.activeSessionsProvider.listWithDiagnostics();
		return items;
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
