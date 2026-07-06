/**
 * SummaryWebviewPanel
 *
 * Opens a webview beside the editor showing the full JolliMemory "Commit Memory" for a commit.
 *
 * Features:
 * - Opens in ViewColumn.One so every memory/summary panel — regardless of
 *   source (memory / commit / kb) — lands in the main editor group and stacks
 *   as tabs there, instead of cascading into a new column per click. One is
 *   also the group VS Code's built-in markdown preview opens into for the
 *   plain-markdown memory files (wiki / plan / note), so the rich summary
 *   panels and those previews end up tabbed together in one group.
 * - Notion-like Clean design: generous whitespace, callout blocks, toggle sections
 * - Automatic light/dark theme support via VSCode CSS variables + custom callout palette
 * - Collapsible memory toggles with smooth CSS transitions
 * - Two independent panels — one per source ("memory" tree vs "commit" tree).
 *   They live in separate static slots and never share or dispose each other.
 * - "Copy Markdown" button exports the summary as plain Markdown to the clipboard
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { execFileSyncHidden } from "../../../cli/src/util/Subprocess.js";
import { isAncestor } from "../../../cli/src/core/GitOps.js";
import { withPlansLock } from "../../../cli/src/core/Locks.js";
import { toForwardSlash } from "../../../cli/src/core/PathUtils.js";
import {
	loadPlansRegistry,
	savePlansRegistry,
} from "../../../cli/src/core/SessionTracker.js";
import {
	generateE2eTest,
	generateRecap,
	translateToEnglish,
} from "../../../cli/src/core/Summarizer.js";
import { getRepoContributors, type RepoContributor } from "../../../cli/src/core/GitOps.js";
import { resolveSessionTitle } from "../../../cli/src/core/SessionTitleResolver.js";
import { runWithTrace } from "../../../cli/src/core/TraceContext.js";
import {
	getTranscriptHashes as coreGetTranscriptHashes,
	readNoteFromBranch,
	readPlanFromBranch,
	readReferenceFromBranch,
	readTranscriptsForCommits as coreReadTranscriptsForCommits,
} from "../../../cli/src/core/SummaryStore.js";
import type { StorageProvider } from "../../../cli/src/core/StorageProvider.js";
import {
	deleteTopicInTree,
	updateTopicInTree,
} from "../../../cli/src/core/SummaryTree.js";
import type {
	CommitSummary,
	E2eTestScenario,
	ReferenceCommitRef,
	SourceId,
	StoredSession,
	StoredTranscript,
	TranscriptSource,
} from "../../../cli/src/Types.js";
import { CURRENT_SCHEMA_VERSION } from "../../../cli/src/Types.js";
import { removeNote, saveNote } from "../core/NoteService.js";
import {
	listAvailablePlans,
	removePlan,
} from "../core/PlanService.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { PluginOutdatedError, parseJolliApiKey } from "../services/JolliPushService.js";
import {
	type PushContext,
	pushSummaryWithAttachments,
	ShareBindingError,
} from "../services/JolliPushOrchestrator.js";
import {
	classifyCreatePrBranch,
	createPrBlockMessage,
	effectiveBranchFor,
} from "../services/CreatePrBranchClassifier.js";
import {
	handleCheckPrStatus,
	handleCreatePr,
	handlePrepareUpdatePr,
	handleUpdatePr,
} from "../services/PrCommentService.js";
import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "../util/GitRemoteUtils.js";
import { isWorkerBusy } from "../util/LockUtils.js";
import { log } from "../util/Logger.js";
import { loadGlobalConfig } from "../util/WorkspaceUtils.js";
import {
	type ShareKind,
	type ShareMember,
	type ShareVisibility,
	copyShareLinkModal,
	openShareModal,
	removeRecipientModal,
	sendInviteModal,
	setShareAccessModal,
	type ShareModalContext,
	type ShareModalIO,
	type ShareModalState,
} from "../services/BranchShareModal.js";
import { listOrgMembers } from "../services/JolliShareService.js";
import { BindingChooserWebviewPanel } from "./BindingChooserWebviewPanel.js";
import { resolveBindingViaChooser } from "./BindingResolver.js";
import { loadBranchSummaries } from "./BranchSummaryLoader.js";
import { sliceStartTime } from "./TranscriptSliceOrder.js";
import { SOURCE_TITLES } from "./SourceLabels.js";
import { buildSummaryErrorBanner } from "./SummaryErrorBanner.js";
import {
	buildE2eTestSection,
	buildHtml,
	buildJolliRow,
	buildPlansAndNotesSection,
	buildRecapSection,
	buildTopicsSection,
	type FileRow,
	renderE2eScenario,
	renderTopic,
} from "./SummaryHtmlBuilder.js";
import { buildMarkdown } from "./SummaryMarkdownBuilder.js";
import { buildPrBodyMarkdown, pickPrTitle, wrapWithMarkers } from "../../../cli/src/core/PrDescription.js";
import { ConversationDetailsPanel } from "./ConversationDetailsPanel.js";
import { buildPanelTitle, collectSortedTopics, formatActiveProviderLabel } from "./SummaryUtils.js";
import type { RegenerateContext } from "../../../cli/src/core/RegenerateContext.js";
import { isSummaryError } from "../../../cli/src/core/SummaryErrorMarker.js";
import { getTranscriptIds } from "../../../cli/src/core/SummaryTree.js";
import type { LlmConfig } from "../../../cli/src/Types.js";

const SHARE_KINDS = new Set<ShareKind>(["branch", "commit"]);
const SHARE_VISIBILITIES = new Set<ShareVisibility>(["public", "org", "people"]);
const SHARE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Repo contributors (a full-history `git log`) back the share picker's "Git
 * collaborators" suggestion group. They change only when new commits land, and the
 * share popover re-resolves its context on every interaction (copy / set-access /
 * invite / remove), so cache per workspace to keep those clicks off `git log`.
 * A long TTL — effectively the session — since the candidate-email list is a
 * convenience, not access control (mirrors {@link listOrgMembers}'s own cache).
 */
const CONTRIBUTORS_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const contributorsCache = new Map<string, { contributors: RepoContributor[]; ts: number }>();

/** Test hook: drops all cached contributor lists so cases don't leak into each other. */
export function clearContributorsCache(): void {
	contributorsCache.clear();
}

async function getCachedRepoContributors(workspaceRoot: string): Promise<RepoContributor[]> {
	const cached = contributorsCache.get(workspaceRoot);
	if (cached && Date.now() - cached.ts < CONTRIBUTORS_TTL_MS) {
		return cached.contributors;
	}
	const contributors = await getRepoContributors(workspaceRoot);
	contributorsCache.set(workspaceRoot, { contributors, ts: Date.now() });
	return contributors;
}

function normalizeShareVisibility(value: unknown): ShareVisibility | undefined {
	return typeof value === "string" && SHARE_VISIBILITIES.has(value as ShareVisibility)
		? (value as ShareVisibility)
		: undefined;
}

function normalizeShareKind(value: unknown): ShareKind {
	return typeof value === "string" && SHARE_KINDS.has(value as ShareKind) ? (value as ShareKind) : "branch";
}

function normalizeShareRecipients(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const recipients: string[] = [];
	for (const raw of value) {
		if (typeof raw !== "string") continue;
		const email = raw.trim().toLowerCase();
		if (!email || !SHARE_EMAIL_RE.test(email) || seen.has(email)) continue;
		seen.add(email);
		recipients.push(email);
		if (recipients.length >= 50) break;
	}
	return recipients;
}

/** Dedupes a member list by lowercased email, keeping the first (name-bearing) entry. */
function dedupeMembersByEmail(members: ReadonlyArray<ShareMember>): ShareMember[] {
	const seen = new Set<string>();
	const out: ShareMember[] = [];
	for (const m of members) {
		const key = m.email.trim().toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push({ name: m.name, email: m.email });
	}
	return out;
}

/** Memory field updates sent from the webview edit form. */
interface TopicUpdates {
	readonly title?: string;
	readonly trigger?: string;
	readonly response?: string;
	readonly decisions?: string;
	readonly todo?: string;
	readonly filesAffected?: Array<string>;
}

/** Message types sent from the webview to the extension host. */
type WebviewMessage =
	| { command: "copyMarkdown" }
	| { command: "downloadMarkdown" }
	| { command: "push" }
	| { command: "editTopic"; topicIndex: number; updates: TopicUpdates }
	| { command: "deleteTopic"; topicIndex: number; title?: string }
	| { command: "generateE2eTest" }
	| { command: "editE2eTest"; scenarios: Array<E2eTestScenario> }
	| { command: "deleteE2eTest" }
	| {
			command: "editE2eScenario";
			index: number;
			updates: Partial<E2eTestScenario>;
	  }
	| { command: "deleteE2eScenario"; index: number; title?: string }
	| { command: "editPlan"; slug: string; committed?: boolean }
	| { command: "loadPlanContent"; slug: string }
	| { command: "savePlan"; slug: string; content: string }
	| { command: "previewPlan"; slug: string; title: string }
	| { command: "removePlan"; slug: string; title: string }
	| { command: "addPlan" }
	| { command: "addMarkdownNote" }
	| { command: "saveSnippet"; title: string; content: string }
	| { command: "loadNoteContent"; id: string; format: string }
	| { command: "saveNote"; id: string; content: string; format: string }
	| { command: "previewNote"; id: string; title: string }
	| { command: "translateNote"; id: string }
	| { command: "removeNote"; id: string; title: string }
	| {
			command: "previewReference";
			archivedKey: string;
			source: SourceId;
			nativeId: string;
			title: string;
	  }
	| { command: "openReferenceExternal"; url: string }
	| {
			command: "loadReferenceContent";
			archivedKey: string;
			source: SourceId;
	  }
	| {
			command: "saveReferenceEdit";
			archivedKey: string;
			source: SourceId;
			content: string;
	  }
	| { command: "cancelReferenceEdit"; archivedKey: string }
	| {
			command: "removeReference";
			archivedKey: string;
			source: SourceId;
			nativeId: string;
			title: string;
	  }
	| {
			command: "translateReference";
			archivedKey: string;
			source: SourceId;
	  }
	| { command: "checkPrStatus" }
	| { command: "prepareCreatePr" }
	| { command: "createPr"; title: string; body: string }
	| { command: "prepareUpdatePr" }
	| { command: "updatePr"; title: string; body: string }
	| { command: "loadTranscriptStats" }
	| { command: "loadConversations" }
	| {
			command: "conversationDetach";
			hash: string;
			sessionId: string;
			source: TranscriptSource;
	  }
	| {
			command: "openConversation";
			sessionId: string;
			source: TranscriptSource;
	  }
	| { command: "translatePlan"; slug: string }
	| { command: "editRecap"; recap: string }
	| { command: "generateRecap" }
	| { command: "regenerateSummary" }
	| { command: "shareBranch"; shareKind?: ShareKind }
	| { command: "shareCopyLink"; visibility: ShareVisibility; shareKind?: ShareKind }
	| { command: "shareSetAccess"; visibility: ShareVisibility; shareKind?: ShareKind }
	| {
			command: "shareSendInvite";
			recipients: ReadonlyArray<string>;
			message?: string;
			visibility?: ShareVisibility;
			shareKind?: ShareKind;
	  }
	| { command: "shareRemoveRecipient"; email: string; shareKind?: ShareKind }
	| { command: "openRewrittenCommit"; hash: string }
	| { command: "loadFiles" }
	| {
			command: "openFileDiff";
			path: string;
			commitHash: string;
			status: string;
			/** Pre-rename path; only present (and only meaningful) when `status` is `"R"`. */
			oldPath?: string;
	  };

/** Source of the panel — determines which static slot it occupies. */
export type SummaryPanelSource = "memory" | "commit" | "kb";

/**
 * Read-only whitelist used by the foreign-repo dispatch guard. Everything
 * that DOESN'T appear here writes to `this.workspaceRoot` / `this.bridge`
 * (push, edit*, plan/note saves, PR helpers, transcript saves) or queries
 * the current workspace's git/orphan branch in a way that would surface
 * incorrect results for a foreign-origin summary (PR status, transcript
 * stats). Use a Set so the lookup is O(1) and stays explicit at the call
 * site.
 */
const FOREIGN_SAFE_COMMANDS: ReadonlySet<WebviewMessage["command"]> = new Set([
	"copyMarkdown",
	"downloadMarkdown",
	// Read-only PR lookup. The case handler routes the call through
	// `gh --repo <foreignRepoUrl>` so this never touches the current
	// workspace's git/GitHub; when foreignRepoUrl is null (local-only
	// foreign repo) the handler short-circuits with `unavailable`.
	"checkPrStatus",
	// Navigation-only — fires `jollimemory.viewSummary` against a hash
	// supplied by the stale banner the panel itself rendered. No write
	// path, no workspace coupling beyond opening another panel.
	"openRewrittenCommit",
	// Detail-panel read paths reached in foreign (cross-repo) view-only
	// mode. Transcript stats and the rendered Markdown previews for plans /
	// notes are pure reads against the foreign repo's FolderStorage —
	// `loadPlanContent` / `loadNoteContent` (the inline edit form's data
	// loaders) are intentionally NOT here because edits to a foreign-repo
	// body are disabled in this mode and the edit affordances are already
	// CSS-hidden in `.foreign-readonly`.
	"loadTranscriptStats",
	// Read-only conversation-list load (titles + counts) for the inline
	// Conversations rows. `conversationDetach` is deliberately NOT here — it
	// rewrites the orphan-branch transcript via `this.bridge` and must not run
	// against a foreign-origin memory.
	"loadConversations",
	// Opens the archived transcript in a read-only ConversationDetailsPanel.
	// Pure read (same foreign-storage-aware path as loadConversations); opening
	// a view-only panel touches neither the current workspace nor the orphan
	// branch, so it is safe against a foreign-origin memory.
	"openConversation",
	"previewPlan",
	"previewNote",
	// Reference previews / open-in-browser are read-only against the foreign
	// repo's storage. The destructive reference actions (loadReferenceContent /
	// saveReferenceEdit / removeReference / translateReference) are NOT here because
	// they write back to the orphan branch via `this.bridge` / `this.cwd`,
	// which is bound to the *current* workspace and would corrupt it.
	"previewReference",
	"openReferenceExternal",
	// Files panel: read-only. `loadFiles` computes per-file status for a
	// foreign summary by rendering the off-branch state (it never diffs the
	// current workspace's git for a foreign commit); `openFileDiff` only
	// opens a read-only VS Code diff view, and off-branch rows never carry
	// `data-path` in the first place so the webview cannot emit it for a
	// foreign or unreachable commit.
	"loadFiles",
	"openFileDiff",
]);

function isForeignSafeCommand(command: WebviewMessage["command"]): boolean {
	return FOREIGN_SAFE_COMMANDS.has(command);
}

/**
 * Converts a relative path + git status letter into a Files-panel `FileRow`,
 * splitting the path into `dir`/basename and normalizing separators via
 * {@link toForwardSlash} (the `StorageProvider.listFiles` / row-rendering
 * contract — see PathUtils.ts). `oldPath` (rename source) is forwarded
 * as-is so a rename row's diff can be opened correctly — see
 * `handleOpenFileDiff` / `jollimemory.openCommitFileChange`.
 */
function toFileRow(relativePath: string, status: string, oldPath?: string): FileRow {
	const path = toForwardSlash(relativePath);
	const lastSlash = path.lastIndexOf("/");
	const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : "";
	return oldPath !== undefined ? { path, dir, status, oldPath: toForwardSlash(oldPath) } : { path, dir, status };
}

/**
 * Read-only whitelist used by the regenerate-in-flight dispatch guard. While
 * regenerateSummary is awaiting the LLM, any other write to the orphan
 * branch (push, edit*, plan/note saves, generateRecap, generateE2eTest…)
 * would race with the eventual `storeSummary(outcome.updated, true)` at the
 * end of regenerate — whichever finished last would overwrite the other.
 *
 * Default-deny: only commands that don't touch the summary (read-only
 * stats, navigation, clipboard) are allowed through. The webview-side
 * `.regenerating-readonly` CSS already hides the affordances for everything
 * else; this is the second-layer guard against any postMessage that slips
 * past (e.g. from a queued event before the readonly mode took effect).
 */
const REGENERATE_SAFE_COMMANDS: ReadonlySet<WebviewMessage["command"]> = new Set([
	"copyMarkdown",
	"downloadMarkdown",
	"checkPrStatus",
	"openRewrittenCommit",
	"loadTranscriptStats",
	// Read-only conversation-list load. `conversationDetach` is excluded — it
	// writes the orphan branch and would race the in-flight regenerate's
	// storeSummary, same reason savePlan is excluded.
	"loadConversations",
	"loadPlanContent",
	"loadNoteContent",
	"previewPlan",
	"previewNote",
	// Reference previews & open-in-browser are read-only — safe to keep
	// reachable while regenerate is in flight. Write-side reference actions
	// (loadReferenceContent / saveReferenceEdit / removeReference / translateReference)
	// are NOT here for the same race reason that excludes savePlan /
	// removePlan / translatePlan.
	"previewReference",
	"openReferenceExternal",
	// regenerateSummary itself is denied while one is in flight; the
	// handler's own `regenerateInProgress` guard short-circuits a re-entry.
]);

function isRegenerateSafeCommand(command: WebviewMessage["command"]): boolean {
	return REGENERATE_SAFE_COMMANDS.has(command);
}

export class SummaryWebviewPanel {
	/**
	 * Single slot for panels opened from the Memories tree. Clicking another
	 * memory item disposes this panel and creates a new one — we never open
	 * two memory panels at once, because memory summaries are generally viewed
	 * one-at-a-time and the tree click is a navigation, not a tab-open.
	 */
	private static currentMemoryPanel: SummaryWebviewPanel | undefined;
	/**
	 * One panel per commit hash for panels opened from the Commits (history)
	 * tree. Clicking a different commit opens another tab; clicking the same
	 * commit reveals the existing tab instead of opening a duplicate.
	 */
	private static commitPanels: Map<string, SummaryWebviewPanel> = new Map();

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly workspaceRoot: string;
	private readonly source: SummaryPanelSource;
	/** Commit hash the panel is scoped to — used as the key in `commitPanels`. */
	private readonly commitHash: string;
	/** Tracks the currently displayed summary for the Copy Markdown action. */
	private currentSummary: CommitSummary | undefined;
	/**
	 * Effective branch resolved when a Create/Update PR form is opened (prepare
	 * step). Passed through to the submit handler so the service can detect a
	 * branch switch between opening and submitting the form (TOCTOU guard) and
	 * scope the PR to the same branch the body was aggregated for.
	 */
	private pendingPrBranch: string | undefined;
	/** Cached set of commit hashes that have transcript files in the orphan branch (scoped to current tree). */
	private transcriptHashSet: Set<string> = new Set();
	/** Cached set of plan slugs whose content contains non-ASCII characters (need translation). */
	private planTranslateSet: Set<string> = new Set();
	/** Cached set of note IDs whose content contains non-ASCII characters (need translation). */
	private noteTranslateSet: Set<string> = new Set();
	/** Cached set of reference `archivedKey`s whose snapshot contains CJK characters (need translation). */
	private referenceTranslateSet: Set<string> = new Set();
	/** Guards against concurrent push invocations (re-click during active push). */
	private pushInProgress = false;
	/**
	 * Set in `onDidDispose`. `show()` awaits I/O before calling `update()`; if
	 * a concurrent `show()` disposed this instance during those awaits, we must
	 * skip the webview write (panel.webview.html throws on a disposed panel).
	 */
	private disposed = false;
	/**
	 * Full 40-char hash of the live root commit when this panel's commit has
	 * been rewritten by amend / squash / rebase (set by
	 * `ensureCommitNotRewritten` on first detection). Once non-null the panel
	 * renders in stale-readonly mode: every destructive button is hidden via
	 * CSS, the banner explains where to go, and subsequent write attempts
	 * short-circuit silently without re-showing the modal. The field is
	 * never cleared — once the underlying commit is gone, the only sane
	 * transition is for the user to open the new commit's summary in its
	 * own panel.
	 *
	 * Why full hash: the banner's "Open new commit's summary" button posts
	 * this value through to `jollimemory.viewSummary` → `getSummary()`.
	 * `getSummary()` only resolves `commitAliases` for 40-char inputs and
	 * throws `AmbiguousHashError` on prefix collisions. A short prefix here
	 * would silently fail to navigate in those cases. Display short-form is
	 * computed at render time in `buildHtml`.
	 */
	private staleRewrittenInto: string | undefined;

	/**
	 * Default kind of the webview's header Share button — set by the panel's
	 * share ENTRY (`showWithShareModal`) and persisted for the panel's lifetime
	 * so full re-renders keep the button consistent with how the user got here
	 * ("Share this branch" entry → branch-first button; everything else →
	 * memory-first, the stock layout).
	 */
	private shareEntryKind: ShareKind = "commit";
	/**
	 * One-shot share-modal auto-open, consumed (and cleared) by the next
	 * `update()`. Set only by `showWithShareModal`. Cleared immediately so
	 * ordinary refreshes never re-pop the modal.
	 */
	private pendingShareOpen = false;

	private readonly bridge: JolliMemoryBridge;
	// Snapshot of `CommitsStore.getMainBranch()` at panel creation. Revisit
	// when `setMainBranch` is wired to a UI control (today there is no caller).
	private readonly mainBranch: string;
	/**
	 * Provenance: the source repo's name when the summary was loaded from a
	 * non-current repo (Memory Bank cross-repo lookup), otherwise null. When
	 * non-null, the panel is read-only — every destructive webview command
	 * (push / editTopic / editPlan / createPr / ...) writes to `this.bridge`
	 * / `this.workspaceRoot`, both of which are bound to the *current*
	 * workspace. Allowing those writes against a foreign-origin summary
	 * would silently corrupt the wrong project. `dispatchWebviewMessage`
	 * gates on `foreignRepoName != null` and short-circuits destructive
	 * commands with a clear notification.
	 */
	private readonly foreignRepoName: string | null;
	/**
	 * Foreign repo's `remote.origin.url` (from the KB folder's
	 * `.jolli/config.json`). Non-null only when `foreignRepoName` is also
	 * non-null. Used by the read-only PR section to route `gh pr view`
	 * through `--repo <url>`, so the displayed PR matches the foreign
	 * summary rather than the current workspace's repo.
	 */
	private readonly foreignRepoUrl: string | null;
	/**
	 * StorageProvider rooted at the foreign repo's Memory Bank `.jolli/`
	 * directory. Non-null only when `foreignRepoName` is also non-null —
	 * built by Extension via `bridge.createStorageForRepo(...)` and threaded
	 * through every read path (transcripts, plans, notes) so the detail
	 * panel renders data from the foreign repo's storage instead of the
	 * current workspace's cwd-rooted storage. Without this, foreign-mode
	 * panels would show empty "All Conversations" / empty plan/note bodies
	 * because the cwd storage has no files for the foreign commit hash.
	 */
	private readonly foreignStorage: StorageProvider | null;

	private constructor(
		extensionUri: vscode.Uri,
		workspaceRoot: string,
		source: SummaryPanelSource,
		commitHash: string,
		bridge: JolliMemoryBridge,
		mainBranch: string,
		foreignRepoName: string | null,
		foreignRepoUrl: string | null,
		foreignStorage: StorageProvider | null,
	) {
		this.extensionUri = extensionUri;
		this.workspaceRoot = workspaceRoot;
		this.source = source;
		this.commitHash = commitHash;
		this.bridge = bridge;
		this.mainBranch = mainBranch;
		this.foreignRepoName = foreignRepoName;
		this.foreignRepoUrl = foreignRepoUrl;
		this.foreignStorage = foreignStorage;
		// Distinct viewType per source keeps the two panels independently identified by VSCode.
		const viewType =
			source === "memory"
				? "jollimemory.summary.memory"
				: "jollimemory.summary.commit";
		this.panel = vscode.window.createWebviewPanel(
			viewType,
			"Commit Memory",
			// Every source opens in the same fixed column (One — the main editor
			// group) so the panels stack as tabs in one group rather than
			// cascading into a fresh column on each click (which is what
			// ViewColumn.Beside did — it recomputes "beside the active group"
			// every time, so panel N+1 lands beside panel N). One is also the
			// group VS Code's built-in markdown preview opens into for the
			// plain-markdown memory files (wiki / plan / note), so the rich
			// summary panels and those previews tab together. kb was already
			// special-cased to One; commit/memory now join it instead of Beside.
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri],
				retainContextWhenHidden: true,
			},
		);

		this.panel.onDidDispose(() => {
			this.disposed = true;
			/* v8 ignore start -- slot-cleanup only fires when the real VSCode host emits onDidDispose. Unit tests call the mocked `dispose()` directly, which doesn't traverse this callback; the stale-guard invariants are covered by runtime scenarios. */
			// Only clear the slot/map entry if it still points at this instance.
			// A stale dispose handler from a replaced memory panel, or from a
			// commit-hash key that a newer instance has taken over, must not
			// null out the live reference.
			if (this.source === "memory") {
				if (SummaryWebviewPanel.currentMemoryPanel === this) {
					SummaryWebviewPanel.currentMemoryPanel = undefined;
				}
			} else if (
				SummaryWebviewPanel.commitPanels.get(this.commitHash) === this
			) {
				SummaryWebviewPanel.commitPanels.delete(this.commitHash);
			}
			/* v8 ignore stop */
		});

		// Handle messages from the webview. Each message is one logical operation
		// (push, regenerate, editTopic, …) — run it in a fresh `runWithTrace`
		// scope so all its log lines and every backend request it makes share one
		// trace id that can be grepped against the backend logs.
		this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
			runWithTrace(undefined, () => this.dispatchWebviewMessage(message));
		});
	}

	/**
	 * Routes a webview message to the appropriate handler, catching errors
	 * and displaying them via VS Code notifications.
	 */
	private dispatchWebviewMessage(message: WebviewMessage): void {
		// Foreign-repo guard. When the loaded summary came from a repo OTHER
		// than the current workspace (Memory Bank cross-repo lookup), every
		// destructive handler below would write to this workspace's git /
		// orphan branch using fields from a foreign summary — i.e. silently
		// corrupt the wrong project. Whitelist the read-only commands and
		// deny everything else. Default-deny (whitelist) is intentional so
		// any future command lands in the safe branch unless explicitly
		// vetted as workspace-independent.
		if (this.foreignRepoName) {
			if (!isForeignSafeCommand(message.command)) {
				this.notifyForeignDenied(message.command);
				return;
			}
		}
		// Regenerate-in-flight guard. The webview's regenerating-readonly
		// mode already hides the affordances for every command outside this
		// allow-list; this is the second layer protecting against any
		// postMessage that slipped past (queued / late / programmatic). A
		// write while regenerate's LLM call is awaiting would be silently
		// clobbered by the final `storeSummary(outcome.updated, true)` at
		// the end of the regenerate path.
		if (this.regenerateInProgress) {
			if (!isRegenerateSafeCommand(message.command)) {
				// Silent drop — the webview's regenerating-readonly chrome
				// already hides the affordance; an in-flight late postMessage
				// from a queued event isn't worth a user-visible notification.
				return;
			}
		}
		switch (message.command) {
			case "copyMarkdown":
				if (this.currentSummary) {
					vscode.env.clipboard
						.writeText(buildMarkdown(this.currentSummary))
						.then(() => {
							vscode.window.showInformationMessage("Copied as Markdown.");
						});
				}
				break;
			case "downloadMarkdown":
				if (this.currentSummary) {
					this.catchAndShow(this.handleDownloadMarkdown(), "Download failed");
				}
				break;
			case "push":
				if (this.currentSummary) {
					this.catchAndShow(this.handlePush(), "Push failed");
				}
				break;
			case "shareBranch":
				if (this.currentSummary) {
					this.catchAndShow(
					this.handleShareAction(normalizeShareKind(message.shareKind), openShareModal, true),
					"Share failed",
				);
				}
				break;
			case "shareCopyLink":
				if (this.currentSummary) {
					const visibility = normalizeShareVisibility(message.visibility);
					if (!visibility) {
						vscode.window.showErrorMessage("Invalid share access level.");
						break;
					}
					this.catchAndShow(
						this.handleShareAction(normalizeShareKind(message.shareKind), (io, ctx) =>
							copyShareLinkModal(io, ctx, visibility),
						),
						"Share failed",
					);
				}
				break;
			case "shareSetAccess":
				if (this.currentSummary) {
					const visibility = normalizeShareVisibility(message.visibility);
					if (!visibility) {
						vscode.window.showErrorMessage("Invalid share access level.");
						break;
					}
					this.catchAndShow(
						this.handleShareAction(normalizeShareKind(message.shareKind), (io, ctx) =>
							setShareAccessModal(io, ctx, visibility),
						),
						"Share failed",
					);
				}
				break;
			case "shareSendInvite":
				if (this.currentSummary) {
					const recipients = normalizeShareRecipients(message.recipients);
					const note = typeof message.message === "string" ? message.message.slice(0, 2000) : undefined;
					// The tier the user had selected; a first invite mints the link at it.
					const inviteVisibility = normalizeShareVisibility(message.visibility);
					this.catchAndShow(
						this.handleShareAction(normalizeShareKind(message.shareKind), (io, ctx) =>
							sendInviteModal(io, ctx, recipients, note, inviteVisibility),
						),
						"Share failed",
					);
				}
				break;
			case "shareRemoveRecipient":
				if (this.currentSummary) {
					const email = typeof message.email === "string" ? message.email : "";
					this.catchAndShow(
						this.handleShareAction(normalizeShareKind(message.shareKind), (io, ctx) =>
							removeRecipientModal(io, ctx, email),
						),
						"Share failed",
					);
				}
				break;
			case "editTopic":
				this.catchAndShow(
					this.handleEditTopic(message.topicIndex, message.updates),
					"Edit failed",
					{
						command: "topicUpdateError",
					},
				);
				break;
			case "editRecap":
				this.catchAndShow(
					this.handleEditRecap(message.recap ?? ""),
					"Recap save failed",
					{
						command: "recapUpdateError",
					},
				);
				break;
			case "generateRecap":
				this.catchAndShow(
					this.handleGenerateRecap(),
					"Recap generation failed",
					{
						command: "recapUpdateError",
					},
				);
				break;
			case "regenerateSummary":
				this.catchAndShow(
					this.handleRegenerateSummary(),
					"Regenerate failed",
					{
						command: "summaryRegenerateError",
					},
				);
				break;
			case "deleteTopic":
				this.catchAndShow(
					this.handleDeleteTopic(message.topicIndex, message.title),
					"Delete failed",
					{
						command: "topicDeleteError",
					},
				);
				break;
			case "generateE2eTest":
				this.catchAndShow(
					this.handleGenerateE2eTest(),
					"E2E test generation failed",
					{
						command: "e2eTestError",
					},
				);
				break;
			case "editE2eTest":
				this.catchAndShow(
					this.handleEditE2eTest(message.scenarios),
					"E2E test save failed",
					{
						command: "e2eTestError",
					},
				);
				break;
			case "deleteE2eTest":
				this.catchAndShow(this.handleDeleteE2eTest(), "Delete failed");
				break;
			case "editE2eScenario":
				this.catchAndShow(
					this.handleEditE2eScenario(message.index, message.updates),
					"E2E scenario save failed",
					{
						command: "e2eScenarioUpdateError",
					},
				);
				break;
			case "deleteE2eScenario":
				this.catchAndShow(
					this.handleDeleteE2eScenario(message.index, message.title),
					"Delete scenario failed",
				);
				break;
			case "editPlan":
				void vscode.commands.executeCommand(
					"jollimemory.editPlan",
					message.slug,
					message.committed ?? false,
				);
				break;
			case "loadPlanContent":
				this.catchAndShow(
					this.handleLoadPlanContent(message.slug),
					"Load plan failed",
				);
				break;
			case "savePlan":
				this.catchAndShow(
					this.handleSavePlan(message.slug, message.content),
					"Save plan failed",
				);
				break;
			case "previewPlan":
				// Pass the panel's foreign provenance through so the editPlan
				// command can resolve the foreign repo's FolderStorage and
				// read the plan body from there. Local panels pass null/null
				// and the command falls back to workspace-default reads.
				void vscode.commands.executeCommand(
					"jollimemory.editPlan",
					message.slug,
					true,
					message.title,
					this.foreignRepoName,
					this.foreignRepoUrl,
				);
				break;
			case "removePlan":
				this.catchAndShow(
					this.handleRemovePlan(message.slug, message.title),
					"Remove plan failed",
				);
				break;
			case "translatePlan":
				this.catchAndShow(
					this.handleTranslatePlan(message.slug),
					"Translation failed",
					{
						command: "planTranslateError",
						slug: message.slug,
					},
				);
				break;
			case "addPlan":
				this.catchAndShow(this.handleAddPlan(), "Add plan failed");
				break;
			case "addMarkdownNote":
				this.catchAndShow(
					this.handleAddMarkdownNote(),
					"Add markdown note failed",
				);
				break;
			case "saveSnippet":
				this.catchAndShow(
					this.handleSaveSnippet(message.title, message.content),
					"Save snippet failed",
				);
				break;
			case "loadNoteContent":
				this.catchAndShow(
					this.handleLoadNoteContent(message.id, message.format),
					"Load note failed",
				);
				break;
			case "saveNote":
				this.catchAndShow(
					this.handleSaveNote(message.id, message.content, message.format),
					"Save note failed",
				);
				break;
			case "previewNote":
				// Same foreign-provenance plumbing as previewPlan above.
				void vscode.commands.executeCommand(
					"jollimemory.previewNote",
					message.id,
					message.title,
					this.foreignRepoName,
					this.foreignRepoUrl,
				);
				break;
			case "translateNote":
				this.catchAndShow(
					this.handleTranslateNote(message.id),
					"Translation failed",
					{
						command: "noteTranslateError",
						id: message.id,
					},
				);
				break;
			case "removeNote":
				this.catchAndShow(
					this.handleRemoveNote(message.id, message.title),
					"Remove note failed",
				);
				break;
			case "previewReference":
				this.catchAndShow(
					this.handlePreviewReference(
						message.archivedKey,
						message.source,
						message.nativeId,
						message.title,
					),
					"Open reference preview failed",
				);
				break;
			case "openReferenceExternal":
				// `url` is round-tripped from the rendered row so we don't have
				// to re-load the orphan branch summary to find the link target.
				this.catchAndShow(
					this.handleOpenReferenceExternal(message.url),
					"Open reference external failed",
				);
				break;
			case "loadReferenceContent":
				this.catchAndShow(
					this.handleLoadReferenceContent(message.archivedKey, message.source),
					"Load reference failed",
				);
				break;
			case "saveReferenceEdit":
				this.catchAndShow(
					this.handleSaveReferenceEdit(
						message.archivedKey,
						message.source,
						message.content,
					),
					"Save reference failed",
				);
				break;
			case "cancelReferenceEdit":
				// No host action — the webview owns the textarea toggle. This
				// case exists so dispatchWebviewMessage's exhaustive switch
				// covers every command in the union (TypeScript will error if
				// we drop it).
				break;
			case "removeReference":
				this.catchAndShow(
					this.handleRemoveReference(
						message.archivedKey,
						message.source,
						message.nativeId,
						message.title,
					),
					"Remove reference failed",
				);
				break;
			case "translateReference":
				this.catchAndShow(
					this.handleTranslateReference(message.archivedKey, message.source),
					"Translation failed",
					{
						command: "referenceTranslateError",
						archivedKey: message.archivedKey,
					},
				);
				break;
			case "checkPrStatus":
				// Foreign-origin panels route the query to the foreign repo
				// via `gh --repo <foreignRepoUrl>` so the displayed PR matches
				// the loaded summary, not the current workspace. When the
				// foreign repo is local-only (no remoteUrl in its KB config),
				// pass null and let PrCommentService short-circuit to
				// `unavailable` rather than silently querying this workspace.
				// `resolveEffectiveBranch` keeps the displayed PR aligned with a
				// renamed branch (and short-circuits to the summary branch for
				// foreign panels).
				this.resolveEffectiveBranch()
					.then(({ effectiveBranch }) =>
						handleCheckPrStatus(
							this.workspaceRoot,
							(msg) => this.panel.webview.postMessage(msg),
							effectiveBranch,
							this.foreignRepoName ? this.foreignRepoUrl : null,
						),
					)
					.catch((err: unknown) =>
						log.error("SummaryPanel", `Check PR status failed: ${err}`),
					);
				break;
			case "createPr":
				this.catchAndShow(
					handleCreatePr(
						message.title,
						message.body,
						this.workspaceRoot,
						(msg) => this.panel.webview.postMessage(msg),
						this.pendingPrBranch,
					),
					"Create PR failed",
				);
				break;
			case "prepareCreatePr":
				if (this.currentSummary) {
					this.catchAndShow(this.handlePrepareCreatePr(), "Prepare PR failed");
				}
				break;
			case "prepareUpdatePr":
				if (this.currentSummary) {
					this.catchAndShow(
						this.handlePrepareUpdatePr(),
						"Load PR data failed",
					);
				}
				break;
			case "updatePr":
				this.catchAndShow(
					handleUpdatePr(
						message.title,
						message.body,
						this.workspaceRoot,
						(msg: Record<string, unknown>) =>
							this.panel.webview.postMessage(msg),
						this.pendingPrBranch,
					),
					"Update PR failed",
				);
				break;
			case "loadTranscriptStats":
				this.handleLoadTranscriptStats().catch((err: unknown) => {
					log.warn(
						"Load transcript stats failed: %s",
						err instanceof Error ? err.message : String(err),
					);
				});
				break;
			case "loadConversations":
				this.handleLoadConversations().catch((err: unknown) => {
					log.warn(
						"Load conversations failed: %s",
						err instanceof Error ? err.message : String(err),
					);
				});
				break;
			case "conversationDetach":
				this.catchAndShow(
					this.handleConversationDetach(message.hash, message.sessionId, message.source),
					"Detach conversation failed",
				);
				break;
			case "openConversation":
				this.handleOpenConversation(message.sessionId, message.source).catch((err: unknown) => {
					log.warn(
						"Open conversation failed: %s",
						err instanceof Error ? err.message : String(err),
					);
				});
				break;
			case "openRewrittenCommit":
				this.catchAndShow(
					this.openRewrittenCommit(message.hash),
					"Open rewritten commit failed",
				);
				break;
			case "loadFiles":
				this.handleLoadFiles().catch((err: unknown) => {
					log.warn(
						"Load files failed: %s",
						err instanceof Error ? err.message : String(err),
					);
				});
				break;
			case "openFileDiff":
				this.catchAndShow(
					this.handleOpenFileDiff(message.path, message.commitHash, message.status, message.oldPath),
					"Open diff failed",
				);
				break;
		}
	}

	/**
	 * Catches a rejected promise, shows an error notification, and optionally
	 * posts an error message back to the webview.
	 */
	private catchAndShow(
		promise: Promise<unknown>,
		label: string,
		webviewErrorMsg?: Record<string, unknown>,
	): void {
		promise.catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`${label} — ${msg}`);
			if (webviewErrorMsg) {
				this.panel.webview.postMessage({ ...webviewErrorMsg, message: msg });
			}
		});
	}

	/**
	 * User-facing notification used by the foreign-repo dispatch guard. The
	 * webview ships every possible button without knowing its panel is
	 * read-only, so clicks land here as ordinary messages — this surfaces
	 * a clear "why didn't it work" cue instead of failing silently.
	 *
	 * Uses showInformationMessage rather than showWarningMessage because
	 * the user's action wasn't an error — it's an expected outcome of
	 * viewing a foreign-origin memory. Single notification per click; no
	 * modal prompt so they aren't blocked from clicking around.
	 */
	private notifyForeignDenied(command: string): void {
		void vscode.window.showInformationMessage(
			`This memory is from ${this.foreignRepoName} — "${command}" is disabled to prevent writes to the current workspace. Open the source repo to edit.`,
		);
	}

	/**
	 * Pre-write guard for handlers that persist to the orphan branch.
	 *
	 * The panel is keyed by `commitHash` in the static `commitPanels` map, so a
	 * panel opened against commit X stays open after amend / squash / rebase
	 * rewrites X into Y. Without this guard, any subsequent write from the
	 * still-open panel (Push to Jolli, Generate E2E, edit memory / recap /
	 * scenario) silently overwrites the orphaned commit's summary on the orphan
	 * branch — most visibly losing `jolliDocId` / `jolliDocUrl` for the user
	 * because the new HEAD's summary was hoisted from the pre-push old summary.
	 *
	 * We detect this via the index: every rewrite by jollimemory's own queue
	 * sets `parentCommitHash` on the old entry pointing at the new root. An
	 * entry with `parentCommitHash != null` therefore means "this commit has
	 * been folded into another" — block the write and transition the panel
	 * into stale-readonly mode (parallel to foreign-readonly): a banner
	 * appears, every destructive button is hidden via CSS, and a one-time
	 * modal offers the user a button to jump straight to the new commit's
	 * summary. The panel itself is kept open so the user can still read the
	 * orphaned commit's content (which they may need for context) and so they
	 * don't lose their place mid-task (e.g. mid-LLM-wait).
	 *
	 * Returns `true` when the operation may proceed (commit is still a root,
	 * or absent from the index entirely — legacy / external commits / freshly
	 * created entries the worker has not yet indexed). Returns `false` after
	 * triggering the stale-readonly transition; callers must short-circuit.
	 *
	 * Idempotent: once the panel is already in stale-readonly mode, returns
	 * false silently without re-firing the modal — every subsequent click on
	 * a destructive control would otherwise spam the user.
	 */
	private async ensureCommitNotRewritten(operation: string): Promise<boolean> {
		// Already stale → short-circuit without re-prompting. The CSS hides
		// the destructive buttons; this guards the dispatcher path against
		// any direct postMessage from a stale tab that survived a webview
		// reload.
		if (this.staleRewrittenInto) return false;
		if (!this.currentSummary) return true;
		const hash = this.currentSummary.commitHash;
		// Route through the Bridge so the read picks up the extension's
		// DualWriteStorage / FolderStorage instance instead of the
		// `resolveStorage()` fallback to a fresh OrphanBranchStorage. In
		// folder-mode the index lives in the folder, not the orphan branch —
		// missing this would let the guard miss real rewrites (or fire on
		// stale orphan-branch data) under that storage mode.
		const entryMap = await this.bridge.getSummaryIndexEntryMap();
		const entry = entryMap.get(hash);

		// Not in index (legacy / external / pre-index race) or still a root → allow.
		if (!entry || entry.parentCommitHash == null) return true;

		// Walk up the parentCommitHash chain to find the live root. The cycle
		// guard is defensive — index links form a DAG by construction, but a
		// corrupted file shouldn't lock the UI in an infinite loop.
		let rootHash = entry.parentCommitHash;
		const visited = new Set<string>([hash]);
		while (!visited.has(rootHash)) {
			visited.add(rootHash);
			const parent = entryMap.get(rootHash);
			if (!parent || parent.parentCommitHash == null) break;
			rootHash = parent.parentCommitHash;
		}

		await this.enterStaleReadonlyMode(operation, hash, rootHash);
		return false;
	}

	/**
	 * Transitions the panel into stale-readonly mode after a guard detects
	 * the underlying commit was rewritten. One-shot: only the FIRST guard
	 * trip reaches here (subsequent attempts short-circuit on the
	 * `staleRewrittenInto` field). Fires a modal so the user understands
	 * what changed and gets a one-click jump to the live commit's panel,
	 * then re-renders the webview in stale-readonly mode so the banner
	 * appears and destructive buttons disappear.
	 */
	private async enterStaleReadonlyMode(
		operation: string,
		hash: string,
		rootHash: string,
	): Promise<void> {
		const shortRoot = rootHash.substring(0, 8);
		const shortHash = hash.substring(0, 8);
		// Store the FULL hash so the banner's "Open new commit's summary"
		// action resolves through `getSummary()`'s alias lookup (40-char
		// only) and side-steps prefix-collision throws. Display short-form
		// is derived at render time in `buildHtml`.
		this.staleRewrittenInto = rootHash;
		// Re-render BEFORE the modal so the banner and hidden-button state
		// are visible the moment the user dismisses the modal — they get
		// instant feedback that the panel changed even if they click
		// "Stay here".
		if (this.currentSummary) {
			this.update(this.currentSummary);
		}
		const openLabel = "Open new commit's summary";
		const choice = await vscode.window.showWarningMessage(
			`Cannot ${operation}: commit ${shortHash} was rewritten into ${shortRoot}.`,
			{
				modal: true,
				detail:
					"This panel is now read-only. The buttons that write to the commit's summary have been hidden so further edits don't land on the orphaned commit. Open the new commit's summary to continue your work — or stay here to keep reading.",
			},
			openLabel,
		);
		if (choice === openLabel) {
			await this.openRewrittenCommit(rootHash);
		}
	}

	/**
	 * Opens the summary panel for the live root that replaced this panel's
	 * (now-orphaned) commit. Delegates to the existing
	 * `jollimemory.viewSummary` command rather than calling
	 * `SummaryWebviewPanel.show` directly so the lookup path stays uniform
	 * (it handles "summary not found" with a toast and runs the same
	 * pre-render refresh as the sidebar entry point).
	 */
	private async openRewrittenCommit(rootHash: string): Promise<void> {
		await vscode.commands.executeCommand("jollimemory.viewSummary", rootHash);
	}

	/**
	 * Opens the Commit Memory panel for the given summary.
	 *
	 * Memory source (single slot): the existing memory panel — if any — is
	 * disposed and a fresh one is created, matching the "navigation-style"
	 * behavior of the memory tree.
	 *
	 * Commit source (one panel per commit hash): each commit gets its own
	 * dedicated tab. Clicking the same commit again re-renders in place if the
	 * summary changed, otherwise just reveals the existing tab. Different
	 * commits coexist as separate tabs.
	 *
	 * The two sources never interfere with each other — opening one never
	 * disposes the other, so a memory panel and any number of commit panels
	 * can be open simultaneously.
	 *
	 * Async: fetches the transcript file listing from the orphan branch before rendering.
	 */
	static async show(
		summary: CommitSummary,
		extensionUri: vscode.Uri,
		workspaceRoot: string,
		bridge: JolliMemoryBridge,
		mainBranch: string,
		source: SummaryPanelSource = "commit",
		foreignRepoName: string | null = null,
		foreignRepoUrl: string | null = null,
		foreignStorage: StorageProvider | null = null,
	): Promise<void> {
		if (source === "commit" || source === "kb") {
			const existing = SummaryWebviewPanel.commitPanels.get(summary.commitHash);
			if (existing) {
				// Snapshot prior state, then re-run refresh pipeline unconditionally.
				// The refresh methods read orphan-branch files (transcripts, plan/note
				// bodies) that can change without the CommitSummary JSON changing —
				// e.g., a background session writing new transcripts, or a translate
				// op rewriting a plan body. Gating the refresh on summary-equality
				// alone would leave those stale. The refreshes are cheap reads, so
				// we always run them and then compare the full render-input set
				// (summary + 3 cache sets) to decide whether re-rendering the
				// webview HTML is necessary.
				const prevTranscriptHashSet = existing.transcriptHashSet;
				const prevPlanTranslateSet = existing.planTranslateSet;
				const prevNoteTranslateSet = existing.noteTranslateSet;
				const prevReferenceTranslateSet = existing.referenceTranslateSet;
				await existing.refreshTranscriptHashes(summary);
				await existing.refreshPlanTranslateSet(summary);
				await existing.refreshNoteTranslateSet(summary);
				await existing.refreshReferenceTranslateSet(summary);
				const inputsChanged =
					!summariesEqual(existing.currentSummary, summary) ||
					!setsEqual(prevTranscriptHashSet, existing.transcriptHashSet) ||
					!setsEqual(prevPlanTranslateSet, existing.planTranslateSet) ||
					!setsEqual(prevNoteTranslateSet, existing.noteTranslateSet) ||
					!setsEqual(prevReferenceTranslateSet, existing.referenceTranslateSet);
				if (inputsChanged) {
					existing.update(summary);
				}
				// reveal() with no args keeps the panel in its current view column.
				// Passing an explicit column here can trigger a column-move (the
				// panel may have been dragged to another group since creation),
				// which destroys and recreates the iframe and leaves it blank —
				// so we always pass undefined and let it stay put.
				// KB source: switch focus to the tab (folder-tree "open file"
				// intent). Commit source: keep focus on the sidebar so the user
				// can keep arrow-keying down the list. This focus distinction is
				// independent of the (now unified) column.
				existing.panel.reveal(undefined, source !== "kb");
				return;
			}
		}

		if (source === "memory") {
			SummaryWebviewPanel.currentMemoryPanel?.panel.dispose();
		}

		const instance = new SummaryWebviewPanel(
			extensionUri,
			workspaceRoot,
			source,
			summary.commitHash,
			bridge,
			mainBranch,
			foreignRepoName,
			foreignRepoUrl,
			foreignStorage,
		);
		if (source === "memory") {
			SummaryWebviewPanel.currentMemoryPanel = instance;
		} else {
			SummaryWebviewPanel.commitPanels.set(summary.commitHash, instance);
		}
		await instance.refreshTranscriptHashes(summary);
		await instance.refreshPlanTranslateSet(summary);
		await instance.refreshNoteTranslateSet(summary);
		await instance.refreshReferenceTranslateSet(summary);
		instance.update(summary);
	}

	/**
	 * Opens (or reveals) the commit panel for `summary` with the in-panel share
	 * modal already open — the entry point for the sidebar's share affordances
	 * (footer "Share" → `kind: "branch"` on the newest branch memory; a row's
	 * "Share this memory" icon → `kind: "commit"`). The modal lives in this
	 * panel's webview, so sharing from anywhere else must route through here;
	 * the kind is threaded into the webview so the modal title matches the
	 * entry the user clicked. Workspace summaries only (foreign/readonly panels
	 * render no share modal).
	 */
	static async showWithShareModal(
		summary: CommitSummary,
		extensionUri: vscode.Uri,
		workspaceRoot: string,
		bridge: JolliMemoryBridge,
		mainBranch: string,
		kind: ShareKind,
		readStorage: StorageProvider | null = null,
	): Promise<void> {
		await SummaryWebviewPanel.show(
			summary,
			extensionUri,
			workspaceRoot,
			bridge,
			mainBranch,
			"commit",
			null,
			null,
			readStorage,
		);
		// A full re-render with the one-shot flag: show() may have skipped its
		// update (unchanged inputs on an already-open panel), and a baked-in
		// script call is the only delivery that can't race webview listener
		// setup on a fresh panel. The entry kind persists on the instance so the
		// header Share button keeps matching this entry across later re-renders.
		const instance = SummaryWebviewPanel.commitPanels.get(summary.commitHash);
		if (!instance) return;
		instance.shareEntryKind = kind;
		instance.pendingShareOpen = true;
		instance.update(instance.currentSummary ?? summary);
	}

	/** Updates the webview HTML content and tab title with a new summary. Stays synchronous. */
	private update(summary: CommitSummary): void {
		// A concurrent show() may have disposed this instance while the caller
		// was awaiting its refresh pipeline. Writing webview.html on a disposed
		// panel throws; silently skip instead.
		if (this.disposed) {
			return;
		}
		this.currentSummary = summary;
		// Prefix the tab title to communicate panel state at a glance.
		// Foreign-repo prefix comes first since it's intrinsic to the panel,
		// stale prefix comes second since it's a transient state of the
		// underlying commit. Both can coexist on a foreign panel whose
		// source commit was rewritten in the foreign repo.
		const baseTitle = buildPanelTitle(summary);
		let title = baseTitle;
		if (this.foreignRepoName) title = `← ${this.foreignRepoName}: ${title}`;
		if (this.staleRewrittenInto) title = `⚠ Rewritten — ${title}`;
		this.panel.title = title;
		const nonce = randomBytes(16).toString("base64");
		const autoOpenShare = this.pendingShareOpen;
		this.pendingShareOpen = false;
		// Mirrors SidebarWebviewProvider's codicon wiring: the redesign uses
		// codicons (ship card's codicon-arrow-swap, conversation detach's
		// codicon-trash, …) that render empty without this stylesheet loaded.
		// `localResourceRoots: [extensionUri]` (set at panel construction)
		// already covers `assets/codicons/`, so no options change is needed
		// there — only the URI computation + threading into buildHtml.
		const codiconCssUri = this.panel.webview
			.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "assets", "codicons", "codicon.css"))
			.toString();
		this.panel.webview.html = buildHtml(summary, {
			transcriptHashSet: this.transcriptHashSet,
			planTranslateSet: this.planTranslateSet,
			noteTranslateSet: this.noteTranslateSet,
			referenceTranslateSet: this.referenceTranslateSet,
			nonce,
			foreignRepoName: this.foreignRepoName,
			staleRewrittenInto: this.staleRewrittenInto ?? null,
			shareDefaultKind: this.shareEntryKind,
			autoOpenShare,
			codiconCssUri,
			cspSource: this.panel.webview.cspSource,
		});
	}

	/**
	 * Partial-refresh helpers — used by mutation handlers instead of `update()`
	 * to re-render just the affected block via `postMessage` (no full-page
	 * `webview.html` rebuild, so expand/collapse + scroll state survive).
	 *
	 * Each helper mirrors `update()`'s two preconditions: bail if the panel was
	 * disposed mid-await, then adopt the new summary as `currentSummary` so a
	 * subsequent block render reads fresh data. Render inputs reuse the same
	 * cached translate/transcript sets as `update()` so partial and full renders
	 * stay in sync.
	 *
	 * They deliberately do NOT skip while `regenerateInProgress`: these blocks
	 * (plans/notes, topics) are disjoint from what the regenerate completion
	 * re-renders (topics+recap+banner only re-render via `summaryRegenerated`;
	 * plans/notes do not). An in-flight async write (e.g. a translate
	 * dispatched before regenerate started, landing mid-regenerate) MUST still
	 * post its partial refresh — it is the only path that clears the block's
	 * loading state (there is no `*Translated` DOM-restore in the webview; the
	 * section rebuild is the restore). Skipping it would strand the translate
	 * button on "translating". The regenerating-readonly CSS still hides the
	 * freshly-rendered block's buttons, so no readonly affordance leaks.
	 */
	private get isReadOnlyPanel(): boolean {
		return !!this.foreignRepoName || !!this.staleRewrittenInto;
	}

	/**
	 * Re-renders the Plans & Notes block AND the header `#jolliRow`. The two are
	 * sent together because `#jolliRow` embeds the published Plans & Notes link
	 * list (see buildJolliRow); refreshing only the section would leave the
	 * header's link list stale after a published plan/note add/remove.
	 */
	private refreshPlansAndNotes(summary: CommitSummary): void {
		if (this.disposed) {
			return;
		}
		this.currentSummary = summary;
		this.panel.webview.postMessage({
			command: "plansAndNotesUpdated",
			html: buildPlansAndNotesSection(
				summary.plans,
				summary.notes,
				summary.references ?? [],
				this.planTranslateSet,
				this.noteTranslateSet,
				this.referenceTranslateSet,
			),
		});
		this.panel.webview.postMessage({
			command: "jolliRowUpdated",
			html: buildJolliRow(
				summary.jolliDocUrl,
				summary.commitMessage,
				summary.plans,
				summary.notes,
			),
		});
	}

	/**
	 * Re-renders the whole `#topicsSection`. Topic edit/delete buttons carry a
	 * positional `treeIndex`; deleting a topic shifts every later index, so the
	 * whole section is rebuilt (rather than removing one node) to keep indices
	 * consistent. Nothing outside the topics block depends on topic data, so no
	 * companion refresh is needed.
	 */
	private refreshTopicsSection(summary: CommitSummary): void {
		if (this.disposed) {
			return;
		}
		this.currentSummary = summary;
		this.panel.webview.postMessage({
			command: "topicsUpdated",
			html: buildTopicsSection(summary, { readOnly: this.isReadOnlyPanel }),
		});
	}

	/**
	 * Refreshes the cached `transcriptHashSet` (logically a transcript-ID set
	 * after v5: the entries may be UUIDs or legacy commit hashes — both are
	 * opaque IDs to read/write/delete paths). Pulled via `getTranscriptIds`
	 * which prefers `summary.transcripts` (v5) and falls back to walking
	 * children for v3/v4 data; intersected with the files actually present
	 * on the orphan branch so a missing-on-disk ID isn't kept in the set.
	 */
	private async refreshTranscriptHashes(summary: CommitSummary): Promise<void> {
		try {
			// `getTranscriptIds` returns the v5 `summary.transcripts` field
			// verbatim when present and falls back to walking children for
			// v3/v4 data — see SummaryTree.getTranscriptIds. Then intersect
			// with the IDs actually on disk so a stale entry (file deleted
			// out from under us) doesn't render in the panel.
			const transcriptIds = getTranscriptIds(summary);
			// Foreign mode: read the transcript file listing from the foreign
			// repo's `.jolli/transcripts/` via the supplied StorageProvider.
			// Going through `this.bridge.getTranscriptHashes()` here would hit
			// `this.cwd`'s storage and return hashes disjoint from the foreign
			// commit — which is what made "All Conversations" render empty for
			// every cross-repo summary.
			const allFileIds = this.foreignStorage
				? await coreGetTranscriptHashes(this.workspaceRoot, this.foreignStorage)
				: await this.bridge.getTranscriptHashes();
			this.transcriptHashSet = new Set(transcriptIds.filter((id) => allFileIds.has(id)));
		} catch (err: unknown) {
			log.warn("Failed to load transcript hashes: %s", err instanceof Error ? err.message : String(err));
			this.transcriptHashSet = new Set();
		}
	}

	/** CJK regex: matches Chinese/Japanese/Korean ideographs (the actual trigger for translation). */
	private static readonly CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;

	/**
	 * Refreshes `planTranslateSet` by reading each plan's content from the orphan branch
	 * and checking whether the title or body contains non-ASCII characters.
	 */
	private async refreshPlanTranslateSet(summary: CommitSummary): Promise<void> {
		const result = new Set<string>();
		const plans = summary.plans ?? [];
		for (const plan of plans) {
			// Title check (cheap — no I/O)
			if (SummaryWebviewPanel.CJK_RE.test(plan.title)) {
				result.add(plan.slug);
				continue;
			}
			// Body check (reads from orphan branch)
			try {
				const content = await readPlanFromBranch(
					plan.slug,
					this.workspaceRoot,
					this.foreignStorage ?? undefined,
				);
				if (content && SummaryWebviewPanel.CJK_RE.test(content)) {
					result.add(plan.slug);
				}
			} catch {
				// If read fails, skip — no translate button for this plan
			}
		}
		this.planTranslateSet = result;
	}

	/**
	 * Refreshes `referenceTranslateSet` by reading each reference's archived
	 * markdown from the orphan branch and checking whether its title (from
	 * the `ReferenceCommitRef`) or body contains CJK characters. Mirrors
	 * `refreshPlanTranslateSet` / `refreshNoteTranslateSet`.
	 */
	private async refreshReferenceTranslateSet(
		summary: CommitSummary,
	): Promise<void> {
		const result = new Set<string>();
		const references: ReadonlyArray<ReferenceCommitRef> = summary.references ?? [];
		for (const reference of references) {
			if (SummaryWebviewPanel.CJK_RE.test(reference.title)) {
				result.add(reference.archivedKey);
				continue;
			}
			try {
				const content = await readReferenceFromBranch(
					reference.source,
					reference.archivedKey,
					this.workspaceRoot,
					this.foreignStorage ?? undefined,
				);
				if (content && SummaryWebviewPanel.CJK_RE.test(content)) {
					result.add(reference.archivedKey);
				}
			} catch {
				/* skip — no translate button when read fails */
			}
		}
		this.referenceTranslateSet = result;
	}

	/**
	 * Refreshes `noteTranslateSet` by reading each note's content from the orphan branch
	 * and checking whether the title or body contains CJK characters.
	 */
	private async refreshNoteTranslateSet(summary: CommitSummary): Promise<void> {
		const result = new Set<string>();
		const notes = summary.notes ?? [];
		for (const note of notes) {
			// Title check (cheap — no I/O)
			if (SummaryWebviewPanel.CJK_RE.test(note.title)) {
				result.add(note.id);
				continue;
			}
			// Snippet content is inline — check directly
			if (note.format === "snippet" && note.content) {
				if (SummaryWebviewPanel.CJK_RE.test(note.content)) {
					result.add(note.id);
				}
				continue;
			}
			// Markdown notes — read from orphan branch
			try {
				const content = await readNoteFromBranch(
					note.id,
					this.workspaceRoot,
					this.foreignStorage ?? undefined,
				);
				if (content && SummaryWebviewPanel.CJK_RE.test(content)) {
					result.add(note.id);
				}
			} catch {
				// If read fails, skip — no translate button for this note
			}
		}
		this.noteTranslateSet = result;
	}

	/** Handles the "Download .md" button click — saves markdown to a user-chosen file. */
	private async handleDownloadMarkdown(): Promise<void> {
		// The caller (dispatchWebviewMessage) already guards against null summary.
		// biome-ignore lint/style/noNonNullAssertion: dispatch guard ensures currentSummary is set
		const summary = this.currentSummary!;
		// Use the same title as the panel tab, sanitized for filesystem use
		const safeTitle = buildPanelTitle(summary).replace(/[<>:"/\\|?*]/g, "-");
		const defaultName = `${safeTitle}.md`;
		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.joinPath(
				vscode.Uri.file(this.workspaceRoot),
				defaultName,
			),
			filters: { Markdown: ["md"] },
			title: "Save Summary as Markdown",
		});
		if (!uri) {
			return;
		}
		const markdown = buildMarkdown(summary);
		await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, "utf-8"));
		vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
	}

	private async handlePrepareCreatePr(): Promise<void> {
		// biome-ignore lint/style/noNonNullAssertion: dispatch guard ensures currentSummary is set
		const summary = this.currentSummary!;
		const postMessage = (msg: Record<string, unknown>): void => {
			this.panel.webview.postMessage(msg);
		};

		if (await this.handleWorkerBusyOrContinue(postMessage)) {
			return;
		}

		// Cross-branch guard: Create PR requires being checked out on the branch
		// the PR will be scoped to (because `git push -u origin HEAD` pushes the
		// current branch). `classifyCreatePrBranch` distinguishes a genuine
		// cross-branch view (summary's branch still exists → block) from a rename
		// or delete-to-successor (old ref gone + current branch contains the
		// commit → allow, scoping to the current branch). Foreign panels never
		// reach here — `createPr` / `prepareCreatePr` are denied at dispatch, so
		// only `checkPrStatus` (via `resolveEffectiveBranch`) runs for them.
		this.pendingPrBranch = summary.branch;
		let currentBranch: string | undefined;
		if (summary.branch) {
			currentBranch = await this.bridge.getCurrentBranch();
			const decision = await classifyCreatePrBranch(
				summary.branch,
				currentBranch,
				summary.commitHash,
				this.workspaceRoot,
			);
			const blockMessage = createPrBlockMessage(decision, summary.branch);
			if (blockMessage) {
				vscode.window.showWarningMessage(blockMessage);
				postMessage({
					command: "prCreateBlockedCrossBranch",
					summaryBranch: summary.branch,
					currentBranch,
				});
				return;
			}
			this.pendingPrBranch = effectiveBranchFor(decision, summary.branch);
		}

		const { summaries, missingCount } = await this.loadBranchSummariesForPr(
			this.pendingPrBranch,
			currentBranch,
		);
		const markdown = buildPrBodyMarkdown(summary, summaries, missingCount);
		const title = pickPrTitle(summary, summaries);
		postMessage({
			command: "prShowCreateForm",
			body: wrapWithMarkers(markdown),
			title,
		});
	}

	private async handlePrepareUpdatePr(): Promise<void> {
		// biome-ignore lint/style/noNonNullAssertion: dispatch guard ensures currentSummary is set
		const summary = this.currentSummary!;
		const postMessage = (msg: Record<string, unknown>): void => {
			this.panel.webview.postMessage(msg);
		};

		if (await this.handleWorkerBusyOrContinue(postMessage)) {
			return;
		}

		// Edit PR is branch-name-routed (no `git push`), so a renamed branch must
		// resolve to the same effective branch the status section displays —
		// otherwise the page shows the new branch's PR while Edit queries/edits
		// the stale one. `resolveEffectiveBranch` also scopes body aggregation.
		const { effectiveBranch, currentBranch } =
			await this.resolveEffectiveBranch();
		this.pendingPrBranch = effectiveBranch;

		const { summaries, missingCount } = await this.loadBranchSummariesForPr(
			effectiveBranch,
			currentBranch,
		);
		const markdown = buildPrBodyMarkdown(summary, summaries, missingCount);

		await handlePrepareUpdatePr(
			markdown,
			this.workspaceRoot,
			postMessage,
			effectiveBranch,
		);
	}

	/**
	 * The branch a PR status query / body aggregation should be scoped to for
	 * the currently displayed summary, plus the `currentBranch` it was resolved
	 * against (so callers can reuse the single `getCurrentBranch` read). The
	 * effective branch is the summary's own branch except when that branch was
	 * renamed away and the current branch now carries its commit (`okAsCurrent`),
	 * in which case it follows the rename to the current branch. Foreign-repo
	 * panels short-circuit to the summary branch — their branches aren't in this
	 * workspace's git graph, so the local classifier must not run (and there is
	 * no meaningful local `currentBranch` for them).
	 */
	private async resolveEffectiveBranch(): Promise<{
		effectiveBranch: string | undefined;
		currentBranch: string | undefined;
	}> {
		const summary = this.currentSummary;
		if (!summary?.branch || this.foreignRepoName) {
			return { effectiveBranch: summary?.branch, currentBranch: undefined };
		}
		const currentBranch = await this.bridge.getCurrentBranch();
		const decision = await classifyCreatePrBranch(
			summary.branch,
			currentBranch,
			summary.commitHash,
			this.workspaceRoot,
		);
		return {
			effectiveBranch: effectiveBranchFor(decision, summary.branch),
			currentBranch,
		};
	}

	// Returns true when worker is busy with a blocking (summary) run: shows the
	// toast and re-runs the status check so the click-time "Loading..." button
	// gets rebuilt. Ingest is not gated: it runs under its own ingest.lock, not
	// worker.lock, and PR creation reads already-stored orphan-branch summaries
	// that ingest never writes.
	private async handleWorkerBusyOrContinue(
		postMessage: (msg: Record<string, unknown>) => void,
	): Promise<boolean> {
		if (!(await isWorkerBusy(this.workspaceRoot))) {
			return false;
		}
		vscode.window.showWarningMessage(
			"Jolli Memory: AI summary is being generated. Please wait a moment.",
		);
		const { effectiveBranch } = await this.resolveEffectiveBranch();
		await handleCheckPrStatus(
			this.workspaceRoot,
			postMessage,
			effectiveBranch,
			this.foreignRepoName ? this.foreignRepoUrl : null,
		);
		return true;
	}

	/**
	 * Loads summaries for PR body aggregation, scoped to `effectiveBranch`.
	 *
	 * Memory Bank lets the user open any historical summary, including ones on
	 * branches they're not currently checked out on. In that cross-branch case
	 * aggregating `currentBranch`'s commits into a PR for the summary's branch is
	 * misleading — the body would describe commits unrelated to that PR. So we
	 * force the single-summary fallback by returning an empty array, and
	 * `buildPrBodyMarkdown` / `pickPrTitle` fall back to the clicked summary.
	 *
	 * When `effectiveBranch === currentBranch` (or `effectiveBranch` is
	 * undefined) we run the existing HEAD-based `loadBranchSummaries` to get the
	 * full branch-aggregation behavior. `currentBranch` is supplied by the caller
	 * (already read for the branch classifier) so a renamed branch resolves to
	 * the current checkout and a single `getCurrentBranch` read serves both.
	 */
	private async loadBranchSummariesForPr(
		effectiveBranch: string | undefined,
		currentBranch: string | undefined,
	): Promise<{
		summaries: ReadonlyArray<CommitSummary>;
		missingCount: number;
	}> {
		if (effectiveBranch && effectiveBranch !== currentBranch) {
			return { summaries: [], missingCount: 0 };
		}
		const result = await loadBranchSummaries(this.bridge, this.mainBranch);
		return {
			summaries: result.summaries,
			missingCount: result.missingCount,
		};
	}

	/**
	 * Builds the VS Code-backed ShareModalIO: pushes modal states to the webview
	 * and opens external targets (browser page / mail client / clipboard).
	 */
	private buildShareModalIO(): ShareModalIO {
		return {
			postState: (state: ShareModalState) => {
				this.panel.webview.postMessage({ command: "shareState", state });
			},
			// Clipboard writes happen host-side (webview postMessage is one-way, so the
			// modal can't hand the URL back for a client-side copy); the webview only
			// gets the shareCopyResult ack to flash its button.
			copyToClipboard: async (text) => {
				try {
					await vscode.env.clipboard.writeText(text);
					return true;
				} catch {
					return false;
				}
			},
			postCopyResult: (result) => {
				this.panel.webview.postMessage({ command: "shareCopyResult", ...result });
			},
			notifyError: (message) => {
				vscode.window.showErrorMessage(message);
			},
			notifyInfo: (message) => {
				vscode.window.showInformationMessage(message);
			},
		};
	}

	/**
	 * Resolves the share context for the current summary: the current branch, API
	 * key, the two suggestion groups (jolli account members / git collaborators),
	 * the bridge (for the live push), and a binding-chooser callback.
	 */
	private async shareContext(kind: ShareKind = "branch"): Promise<ShareModalContext | undefined> {
		const summary = this.currentSummary;
		if (!summary) return undefined;
		// A rewritten/stale commit's memory no longer exists on the branch, so
		// sharing it would publish a read-only link for an orphaned commit. Only
		// the `commit` kind is orphaned by a rewrite; branch shares follow live HEAD,
		// so leave them reachable. Idempotent + one-shot (fires the "rewritten" modal
		// only on first detection).
		if (kind === "commit" && !(await this.ensureCommitNotRewritten("share this memory"))) {
			return undefined;
		}
		const config = await loadGlobalConfig();
		// Branch shares are sourced from the CURRENT git checkout (base..HEAD), so their
		// label/key follows HEAD. Commit shares are the open memory itself; keep them
		// bound to `summary.branch` so a later branch switch doesn't make "Share this
		// memory" re-filter the wrong branch and lose the commit.
		const current = await this.bridge.getCurrentBranch();
		// A branch share needs a real named branch to label + key by. In detached HEAD
		// (`getCurrentBranch()` → "HEAD") the content would still be the detached
		// base..HEAD but get mislabeled/miskeyed under `summary.branch`, so block it and
		// tell the user. Commit shares are unaffected (bound to the memory's own commit).
		if (kind === "branch" && current === "HEAD") {
			vscode.window.showWarningMessage(
				"Can't share a branch while HEAD is detached — check out a branch first, then share.",
			);
			return undefined;
		}
		const branch = kind === "commit" ? summary.branch : current || summary.branch;
		const commitHash = kind === "commit" ? summary.commitHash : undefined;
		const apiKey = config.jolliApiKey;
		const keyMeta = apiKey ? parseJolliApiKey(apiKey) : null;
		const baseUrl = keyMeta?.u || "";
		// The org toggle is only meaningful when the key carries an org.
		const canOrg = Boolean(keyMeta?.o);
		// Two suggestion groups for the invite search: "From your jolli account" (org
		// members, cached + capped in the service) and "Git collaborators" (repo
		// contributors with deliverable emails, minus anyone already in the account
		// group — the account entry carries the better name). These four lookups are
		// independent — a whole-history git log, a network GET, and two git-config
		// reads — so run them concurrently to keep modal-open latency the max, not the
		// sum. The git-config owner name is only a fallback, but fetching it eagerly
		// (a cheap read) is what lets the join happen in one await.
		const [contributors, accountMembers, ownerEmail, ownerNameFromGit] = await Promise.all([
			getCachedRepoContributors(this.workspaceRoot),
			apiKey ? listOrgMembers(baseUrl, apiKey).catch(() => []) : Promise.resolve([]),
			this.bridge.getCurrentUserEmail(),
			this.bridge.getCurrentUserName(),
		]);
		const accountEmails = new Set(accountMembers.map((m) => m.email.trim().toLowerCase()));
		const gitCollaborators = dedupeMembersByEmail(
			contributors.map((c) => ({ name: c.name, email: c.email })),
		).filter((m) => !accountEmails.has(m.email.trim().toLowerCase()));
		const ownerLower = ownerEmail.toLowerCase();
		const ownerName =
			[...accountMembers, ...gitCollaborators].find((m) => m.email.toLowerCase() === ownerLower)?.name ||
			ownerNameFromGit;
		const owner = { name: ownerName, email: ownerEmail };
		return {
			workspaceRoot: this.workspaceRoot,
			branch,
			apiKey,
			commitHash,
			commitSummary: kind === "commit" ? summary : undefined,
			subjectTitle: kind === "commit" ? summary.commitMessage : branch,
			canOrg,
			owner,
			accountMembers,
			gitCollaborators,
			bridge: this.bridge,
			resolveBinding: async (repo) => {
				const outcome = await BindingChooserWebviewPanel.openAndAwait({
					extensionUri: this.extensionUri,
					baseUrl: baseUrl.replace(/\/+$/, ""),
					apiKey: apiKey ?? "",
					repoUrl: repo,
					suggestedRepoName: deriveRepoNameFromUrl(repo),
				});
				if (outcome.kind === "selected") return { status: "bound" };
				if (outcome.kind === "anotherOpen") return { status: "anotherOpen" };
				return { status: "cancelled" };
			},
			nowMs: Date.now(),
		};
	}

	/**
	 * Runs one share-modal entry point (open / copy-link / org-toggle / invite /
	 * remove-recipient / stop-link / open-target) against a freshly-resolved
	 * context. Foreign summaries can't reach here (the share commands are not in
	 * FOREIGN_SAFE_COMMANDS) — sharing always targets the current workspace.
	 */
	private async handleShareAction(
		kind: ShareKind,
		action: (io: ShareModalIO, ctx: ShareModalContext) => Promise<void>,
		opensModal = false,
	): Promise<void> {
		const ctx = await this.shareContext(kind);
		const io = this.buildShareModalIO();
		if (!ctx) {
			// No context (e.g. detached HEAD / missing current summary). Ack a failed
			// copy so an optimistically-disabled Copy button re-enables.
			io.postCopyResult({ ok: false });
			// ONLY the open path put the webview on the loading pane (which would spin
			// forever without a state) — post an error so it recovers. For other actions
			// the popover is already on the main pane; posting an error would destructively
			// tear it down (and discard the user's dropdown/staged state), so we don't.
			if (opensModal) {
				io.postState({
					kind: "error",
					message: "Can't share right now — if HEAD is detached, check out a branch first, then reopen Share.",
				});
			}
			return;
		}
		await action(io, ctx);
	}

	/**
	 * Orchestrates the push to Jolli Cloud and posts the result message back
	 * to the webview. Wrapped in `Promise.allSettled` semantics by
	 * {@link toJolliResultMessage} so a thrown error becomes a structured
	 * `pushToJolliResult` instead of an uncaught rejection.
	 *
	 * Known race window (intentionally not double-guarded): once
	 * `pushToJolli` has been kicked off (1–3s HTTP round-trip in practice),
	 * an amend landing mid-call would let `runJolliPush` persist the
	 * resulting `jolliDocId` to the now-orphaned commit's summary. We accept
	 * this because:
	 *   - the window is short and requires concurrent user action on the
	 *     same workspace (sidebar Amend / terminal `git commit --amend`),
	 *   - re-checking AFTER pushToJolli but BEFORE storeSummary would leave
	 *     the article created on the Jolli side without a local record,
	 *     causing the next push of the new HEAD to create a duplicate
	 *     article instead of updating in place.
	 * Trade-off is favourable for the common case; documented here so a
	 * future maintainer doesn't quietly add the re-check without realising.
	 */
	private async handlePush(): Promise<void> {
		// Prevent concurrent pushes: the button can be re-clicked when
		// runJolliPush throws before posting pushStarted (button never
		// disabled), or when a successful run calls this.update() which
		// replaces the webview HTML mid-promise.
		if (this.pushInProgress) {
			return;
		}
		// Refuse to publish a degraded summary (LLM failed, persisted placeholder
		// or Copy-Hoist / mechanical fallback with summaryError marker). If we let
		// the push through and this commit already has a jolliDocId from an
		// earlier successful push, Jolli would silently update the cloud article
		// in place — overwriting good content with placeholder topics. The user
		// must Regenerate first; the in-page banner already tells them how.
		// biome-ignore lint/style/noNonNullAssertion: dispatch guard ensures currentSummary is set
		if (isSummaryError(this.currentSummary!)) {
			vscode.window.showWarningMessage(
				"This summary's last LLM generation failed. Click Regenerate above and try again before pushing to Jolli.",
			);
			return;
		}
		// Check BEFORE setting pushInProgress so that a stale-commit early exit
		// doesn't leave the flag stuck (the panel is about to be disposed anyway,
		// but defensive against future code paths that survive the guard).
		if (!(await this.ensureCommitNotRewritten("push to Jolli"))) {
			return;
		}
		this.pushInProgress = true;

		try {
			// The caller (dispatchWebviewMessage) already guards against null summary.
			// biome-ignore lint/style/noNonNullAssertion: dispatch guard ensures currentSummary is set
			const summary = this.currentSummary!;
			const config = await loadGlobalConfig();
			const jolliResult = await Promise.allSettled([
				this.runJolliPush(summary, config.jolliApiKey),
			]);
			this.panel.webview.postMessage(toJolliResultMessage(jolliResult[0]));
		} finally {
			this.pushInProgress = false;
		}
	}

	/**
	 * Runs the Jolli Cloud push for this panel's summary via the shared
	 * {@link pushSummaryWithAttachments} orchestrator (so the per-summary button and
	 * the subject-level live share never double-push or fight over jolliDocId). This
	 * wrapper owns only the VS Code UI: the progress ping, the binding-chooser
	 * wiring, the success/partial toasts, and adopting the returned summary.
	 */
	private async runJolliPush(
		summary: CommitSummary,
		jolliApiKey: string | undefined,
	): Promise<{ url: string; docId: number }> {
		if (!jolliApiKey) {
			vscode.window.showWarningMessage(
				"Please configure your Jolli API Key first (STATUS panel → ...).",
			);
			throw new Error("No Jolli API Key configured");
		}

		// Derive base URL from the API key metadata
		const resolvedBaseUrl = parseJolliApiKey(jolliApiKey)?.u;
		if (!resolvedBaseUrl) {
			vscode.window.showWarningMessage(
				"Jolli site URL could not be determined. Please regenerate your Jolli API Key and set it again (STATUS panel → ...).",
			);
			throw new Error("Jolli site URL could not be determined from API key");
		}

		// Show progress indicator in the webview
		this.panel.webview.postMessage({ command: "pushStarted" });

		const baseUrl = resolvedBaseUrl.replace(/\/+$/, "");
		const repoUrl = await getCanonicalRepoUrl(this.workspaceRoot);

		const ctx: PushContext = {
			baseUrl: resolvedBaseUrl,
			apiKey: jolliApiKey,
			repoUrl,
			workspaceRoot: this.workspaceRoot,
			storeSummary: (s, syncToCloud) => this.bridge.storeSummary(s, syncToCloud),
			// On 412 binding_required the orchestrator calls this; we open the chooser
			// and map its outcome back. Chooser UI stays in the panel layer.
			resolveBinding: (repo) => resolveBindingViaChooser({ extensionUri: this.extensionUri, baseUrl, apiKey: jolliApiKey, repoUrl: repo }),
		};

		// Re-read the freshest summary from disk right before pushing. Another
		// surface — a second summary panel for this commit, the Create PR pane's
		// branch-wide share, or live share — may have pushed this same commit since
		// this panel captured `currentSummary`, writing a `jolliDocId` back to disk.
		// Pushing our stale in-memory copy (which lacks that id) would make the
		// server mint a DUPLICATE article instead of updating in place, and the
		// subsequent storeSummary would then clobber the good id with the
		// duplicate's. Reloading guarantees the push carries the latest jolliDocId;
		// every edit path persists immediately, so disk is always the authority.
		const fresh = await this.bridge.getSummary(summary.commitHash);
		const summaryToPush = fresh ?? summary;

		try {
			const result = await pushSummaryWithAttachments(summaryToPush, ctx);

			// Adopt the pushed/cleaned summary and fully re-render so the PR section
			// picks up the new plan/note URLs and jolliDocUrl in its markdown body.
			this.currentSummary = result.updatedSummary;
			this.update(result.updatedSummary);

			const verb = result.isUpdate ? "Updated" : "Pushed";
			const attachMsg =
				result.attachmentCount > 0
					? ` (with ${result.attachmentCount} attachment${result.attachmentCount > 1 ? "s" : ""})`
					: "";
			if (result.attachmentFailures.length > 0) {
				// Modal (not a transient toast): a partial failure must be as visible as
				// the old fail-fast error — the panel otherwise re-renders to "Synced".
				vscode.window.showWarningMessage(
					`${verb} the memory on Jolli Space${attachMsg}, but ${result.attachmentFailures.length} attachment(s) failed to push.`,
					{
						modal: true,
						detail: result.attachmentFailures.map((f) => `• ${f.label}: ${f.message}`).join("\n"),
					},
				);
			} else {
				vscode.window.showInformationMessage(`${verb} on Jolli Space${attachMsg}.`);
			}

			return { url: result.pushedDoc.summaryUrl, docId: result.pushedDoc.summaryDocId };
		} catch (err: unknown) {
			if (err instanceof ShareBindingError) {
				if (err.outcome === "anotherOpen") {
					// Another summary panel for the same repo already opened the chooser;
					// that panel drives the binding decision. Tell this caller to wait
					// there and re-push — "cancelled" would be misleading here.
					vscode.window.showInformationMessage(
						"A Memory space chooser is already open for this repo. Finish there, then click the Jolli push button again.",
					);
				} else if (err.outcome === "cancelled") {
					vscode.window.showErrorMessage(
						"Push cancelled — no Memory space chosen for this repo. Click the Jolli push button again when you're ready.",
					);
				} else {
					vscode.window.showErrorMessage(
						"Push failed — could not bind a Memory space for this repo.",
					);
				}
				throw err;
			}
			if (err instanceof PluginOutdatedError) {
				vscode.window.showErrorMessage(
					"Push failed — your Jolli Memory plugin is outdated. Please update to the latest version.",
					{ modal: true },
				);
			} else {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Push failed: ${msg}`);
			}
			throw err;
		}
	}

	/** Handles editing a memory at the given global index. */
	private async handleEditTopic(
		topicIndex: number,
		updates: TopicUpdates,
	): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}
		if (!(await this.ensureCommitNotRewritten("edit memory"))) {
			return;
		}

		const result = updateTopicInTree(summary, topicIndex, updates);
		if (!result) {
			throw new Error(`Memory index ${topicIndex} is out of range`);
		}

		await this.bridge.storeSummary(result.result, true);
		this.currentSummary = result.result;

		// Re-render just the updated topic and send the HTML to the webview for in-place replacement.
		// topicIndex is the tree traversal index, so find the matching topic by treeIndex.
		const { topics: allTopics } = collectSortedTopics(result.result);
		const displayIndex = allTopics.findIndex((t) => t.treeIndex === topicIndex);
		const topic = displayIndex >= 0 ? allTopics[displayIndex] : undefined;
		const html = topic ? renderTopic(topic, displayIndex) : "";
		this.panel.webview.postMessage({
			command: "topicUpdated",
			topicIndex,
			html,
		});
	}

	/**
	 * Handles user editing the Quick recap. Empty input clears the field
	 * (undefined on the persisted summary, no recap section in the rendered
	 * webview); non-empty input replaces the trimmed recap.
	 */
	private async handleEditRecap(recap: string): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}
		if (!(await this.ensureCommitNotRewritten("edit recap"))) {
			return;
		}
		const trimmed = recap.trim();
		const updated: CommitSummary = trimmed
			? { ...summary, recap: trimmed }
			: { ...summary, recap: undefined };
		await this.bridge.storeSummary(updated, true);
		this.currentSummary = updated;
		// Server-render the section so the webview gets the canonical HTML
		// (including the trailing <hr/> separator). Empty result removes the
		// section entirely; the webview-side handler treats empty html as
		// "delete recap section".
		this.panel.webview.postMessage({
			command: "recapUpdated",
			html: buildRecapSection(updated.recap),
		});
	}

	/**
	 * Generates (or regenerates) the Quick Recap paragraph via a standalone
	 * LLM call against the existing topics. The diff is intentionally NOT
	 * included -- the recap is a narrative over already-extracted topics, not a
	 * fresh code analysis, and skipping the diff keeps token cost low for an
	 * action users may invoke repeatedly until the wording feels right.
	 *
	 * If the commit has no major topics, generateRecap returns an empty string
	 * and the section re-renders into its placeholder (state-1) form. The
	 * webview's recapUpdated handler treats the new HTML as canonical, so the
	 * Generate button reappears automatically without extra signalling.
	 */
	private async handleGenerateRecap(): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}
		if (!(await this.ensureCommitNotRewritten("generate recap"))) {
			return;
		}

		this.panel.webview.postMessage({ command: "recapGenerating" });

		const { topics } = collectSortedTopics(summary);
		const config = await loadGlobalConfig();
		const recap = await generateRecap({
			topics,
			commitMessage: summary.commitMessage,
			config,
		});

		const trimmed = recap.trim();
		// Empty result means generateRecap short-circuited because the commit has
		// no `importance: major` topics. Surface a toast and exit without
		// touching storage so an existing recap (legacy summaries, or summaries
		// where the user just demoted every topic) is never silently destroyed.
		if (!trimmed) {
			vscode.window.showInformationMessage(
				"No major topics in this commit, so there's nothing to recap.",
			);
			this.panel.webview.postMessage({ command: "recapUpdateError" });
			return;
		}

		// Race-window re-check: amend can land during the LLM call (10–60s).
		// Without this the recap would be persisted to the now-orphaned commit.
		if (!(await this.ensureCommitNotRewritten("generate recap"))) {
			return;
		}

		const updated: CommitSummary = { ...summary, recap: trimmed };
		await this.bridge.storeSummary(updated, true);
		this.currentSummary = updated;

		this.panel.webview.postMessage({
			command: "recapUpdated",
			html: buildRecapSection(updated.recap),
		});
	}

	private regenerateInProgress = false;

	/**
	 * End-to-end re-run of the summary LLM. Replaces topics + recap (plus
	 * supporting fields like diffStats, transcriptEntries, llm); preserves
	 * ticketId, e2eTestGuide, plans, notes, references, children, and all
	 * push metadata. See cli/src/core/Regenerator.ts for the isolation
	 * contract (no cursor advance, no archive re-write, no queue side
	 * effects).
	 */
	private async handleRegenerateSummary(): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) return;
		if (this.regenerateInProgress) return;
		// Reject if a Push to Jolli is already mid-flight. Push writes back
		// jolliDocId / jolliDocUrl on completion (handlePush:1428); regenerate
		// captures the summary snapshot NOW and writes back at the end of its
		// LLM call. If push completes between the two writes, regenerate's
		// final storeSummary clobbers the jolliDocId — the next push would
		// then create a duplicate article instead of updating in place.
		// (The reverse direction — push during regenerate — is already
		// blocked by the regenerate-in-flight dispatchWebviewMessage guard.)
		//
		// INVARIANT: this panel-local check assumes pushes always originate
		// from a webview panel (via handlePush) — the only producer of
		// pushInProgress today. If JolliPushService is ever exposed to the
		// CLI or a scheduled task, this check becomes blind to those callers;
		// replace with a bridge-level write lock at that point.
		if (this.pushInProgress) {
			vscode.window.showInformationMessage(
				"A push to Jolli is in progress. Wait for it to finish before regenerating.",
			);
			return;
		}
		// Set the flag SYNCHRONOUSLY (before any await) so a double-click can't
		// race past the guard while the first invocation is suspended awaiting
		// ensureCommitNotRewritten. The flag stays set across the confirm
		// dialog too — if the user cancels, finally clears it.
		this.regenerateInProgress = true;
		try {
			if (!(await this.ensureCommitNotRewritten("regenerate summary"))) return;

			// loadRegenerateContext always resolves; zero-valued ctx for legacy
			// summaries with no stored transcript, the confirm dialog adjusts copy.
			// Route through the Bridge so folder-only Memory Bank users hit
			// FolderStorage rather than the OrphanBranchStorage fallback in
			// resolveStorage. The bare CLI helper does not know about the
			// extension's active storage backend.
			const ctx = await this.bridge.loadRegenerateContext(summary);

			// Load config BEFORE the confirm dialog so the dialog can show the
			// provider label the next call will actually use. Same config feeds
			// the regenerate call below.
			const config = await loadGlobalConfig();

			const detail = this.buildRegenerateConfirmDetail(
				ctx,
				config,
				summary.commitHash,
			);
			const choice = await vscode.window.showWarningMessage(
				"Regenerate this summary?",
				{ modal: true, detail },
				"Regenerate",
			);
			if (choice !== "Regenerate") return;

			if (!(await this.ensureCommitNotRewritten("regenerate summary"))) return;

			this.panel.webview.postMessage({ command: "summaryRegenerating" });

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Regenerating summary…",
					cancellable: true,
				},
				async (_progress, token) => {
					// AbortController wiring: Summarizer.callLlm / LlmClient don't
					// accept an AbortSignal today, so user-cancel only drops the
					// LLM result locally — the in-flight HTTP request keeps running
					// to completion in the background and we pay for those tokens.
					// TODO: when Summarizer.SummarizeParams gains a `signal?:
					// AbortSignal` field and forwards it to the Anthropic SDK's
					// `messages.create({ signal })` (and combines with the proxy
					// fetch's existing timeout signal), thread `token` through
					// `this.bridge.regenerateSummary(summary, config, signal)` so
					// cancel actually aborts the request.
					const cancelled = new Promise<"cancelled">((resolve) => {
						token.onCancellationRequested(() => resolve("cancelled"));
					});
					// Route through the Bridge so the read path (transcripts,
					// archived plans/notes/linear) hits the active storage
					// backend rather than the OrphanBranchStorage fallback.
					const work = this.bridge.regenerateSummary(summary, config);
					const outcome = await Promise.race([work, cancelled]);
					if (outcome === "cancelled") {
						this.panel.webview.postMessage({
							command: "summaryRegenerateError",
						});
						return;
					}

					// Race-window re-check: amend can land during the 30 s LLM call.
					if (!(await this.ensureCommitNotRewritten("regenerate summary"))) {
						this.panel.webview.postMessage({
							command: "summaryRegenerateError",
						});
						return;
					}

					await this.bridge.storeSummary(outcome.updated, true);
					this.currentSummary = outcome.updated;
					this.panel.webview.postMessage({
						command: "summaryRegenerated",
						topicsHtml: buildTopicsSection(outcome.updated),
						recapHtml: buildRecapSection(outcome.updated.recap),
						// Empty string on success → script removes any existing
						// banner from the DOM. Non-empty (unlikely on success
						// but defensible — e.g. regenerate produced a partial
						// result that re-tripped the marker) replaces the
						// banner in place.
						summaryErrorBannerHtml: buildSummaryErrorBanner(outcome.updated),
					});
					vscode.window.showInformationMessage("Summary regenerated.");
				},
			);
		} finally {
			this.regenerateInProgress = false;
		}
	}

	private buildRegenerateConfirmDetail(
		ctx: RegenerateContext,
		config: LlmConfig,
		commitHash: string,
	): string {
		const s = (n: number): string => (n === 1 ? "" : "s");
		const sources = ctx.sources.length > 0 ? ctx.sources.join(", ") : "Unknown";
		const shortHash = commitHash.substring(0, 8);
		const provider = formatActiveProviderLabel(config);

		const lines: string[] = [];
		lines.push("The LLM will be re-run using:");
		if (ctx.entryCount === 0) {
			lines.push(
				"  • No saved AI conversations for this commit — regenerating from the diff and attached metadata alone",
			);
		} else {
			lines.push(
				`  • ${ctx.entryCount} transcript ${ctx.entryCount === 1 ? "entry" : "entries"} from ${ctx.sessionCount} session${s(ctx.sessionCount)} (${sources})`,
			);
		}
		lines.push(`  • The commit diff (reconstructed via \`git show ${shortHash}\`)`);
		const referenceTotal = Object.values(ctx.referenceCountsBySource).reduce(
			(acc: number, n) => acc + (n ?? 0),
			0,
		);
		if (ctx.plansCount + ctx.notesCount + referenceTotal > 0) {
			const parts: string[] = [];
			if (ctx.plansCount > 0) parts.push(`${ctx.plansCount} plan${s(ctx.plansCount)}`);
			if (ctx.notesCount > 0) parts.push(`${ctx.notesCount} note${s(ctx.notesCount)}`);
			// Render one segment per source with a positive count, using the
			// canonical label (e.g. "2 Linear issues", "1 Jira issue"). Order
			// follows the SOURCE_TITLES key order so the dialog is stable.
			for (const source of Object.keys(SOURCE_TITLES) as Array<keyof typeof SOURCE_TITLES>) {
				const n = ctx.referenceCountsBySource[source] ?? 0;
				if (n > 0) {
					parts.push(`${n} ${SOURCE_TITLES[source]} issue${s(n)}`);
				}
			}
			lines.push(`  • Archived ${parts.join(", ")} attached to this commit`);
		}
		lines.push("");
		lines.push("These fields will be OVERWRITTEN:");
		lines.push("  • Topics — including any you have edited");
		lines.push("  • Recap — including any you have edited");
		lines.push("");
		lines.push(
			provider
				? `This typically takes 20–40 seconds · via ${provider}`
				: "This typically takes 20–40 seconds.",
		);
		return lines.join("\n");
	}

	/** Handles deleting a memory at the given global index (with confirmation). */
	private async handleDeleteTopic(
		topicIndex: number,
		title?: string,
	): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}
		// Check BEFORE the confirm dialog so the user isn't asked to confirm a
		// destructive action that won't actually take effect on this commit.
		if (!(await this.ensureCommitNotRewritten("delete memory"))) {
			return;
		}

		const choice = await vscode.window.showWarningMessage(
			title ? "Delete memory?" : "Delete this memory?",
			{
				modal: true,
				detail: title
					? `"${title}"\n\nThis cannot be undone.`
					: "This cannot be undone.",
			},
			"Delete",
		);
		if (choice !== "Delete") {
			return;
		}

		// Race-window re-check: amend can land between the entry guard and the
		// user dismissing the modal. Without this the delete would persist to
		// the now-orphaned commit's summary.
		if (!(await this.ensureCommitNotRewritten("delete memory"))) {
			return;
		}

		const result = deleteTopicInTree(summary, topicIndex);
		if (!result) {
			throw new Error(`Memory index ${topicIndex} is out of range`);
		}

		await this.bridge.storeSummary(result.result, true);
		// Re-render the whole topics section (not a single-node removal): topic
		// edit/delete buttons carry positional treeIndex values, and deleting one
		// shifts every later index, so a full section rebuild keeps them correct.
		this.refreshTopicsSection(result.result);
	}

	/** Generates E2E test scenarios from the current summary via AI. */
	private async handleGenerateE2eTest(): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}
		if (!(await this.ensureCommitNotRewritten("generate E2E test guide"))) {
			return;
		}

		this.panel.webview.postMessage({ command: "e2eTestGenerating" });

		const { topics } = collectSortedTopics(summary);

		// Get diff for the commit (truncated to avoid huge prompts)
		let diff = "";
		try {
			diff = execFileSyncHidden(
				"git",
				["diff", `${summary.commitHash}~1`, summary.commitHash, "--", ".", ":(exclude)*.lock"],
				{ cwd: this.workspaceRoot, encoding: "utf-8", maxBuffer: 512 * 1024 },
			).substring(0, 30000);
		} catch {
			// Diff may fail for initial commits; proceed without it
		}

		const config = await loadGlobalConfig();
		const scenarios = await generateE2eTest({
			topics,
			commitMessage: summary.commitMessage,
			diff,
			config,
		});

		// Empty result means generateE2eTest short-circuited because the commit
		// has no testable major topics (no topics at all, or every topic is
		// `importance: minor`). Surface a toast and exit without touching
		// storage so a previously generated guide is never silently overwritten.
		if (scenarios.length === 0) {
			vscode.window.showInformationMessage(
				"No major topics in this commit, so there's nothing to test.",
			);
			this.panel.webview.postMessage({ command: "e2eTestError" });
			return;
		}

		// Race-window re-check: amend can land during the LLM call (10–60s).
		if (!(await this.ensureCommitNotRewritten("generate E2E test guide"))) {
			return;
		}

		const updatedSummary: CommitSummary = {
			...summary,
			e2eTestGuide: scenarios,
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;

		// Send rendered HTML to webview for in-place replacement
		const html = buildE2eTestSection(updatedSummary);
		this.panel.webview.postMessage({ command: "e2eTestUpdated", html });
	}

	/**
	 * Saves edited E2E test scenarios from the webview (bulk replace).
	 *
	 * @deprecated Replaced by per-scenario `handleEditE2eScenario` /
	 * `handleDeleteE2eScenario`. Kept as a defensive fallback in case any
	 * external caller still posts `editE2eTest`; current webview UI no
	 * longer triggers this command.
	 */
	private async handleEditE2eTest(
		scenarios: Array<E2eTestScenario>,
	): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}
		if (!(await this.ensureCommitNotRewritten("edit E2E test guide"))) {
			return;
		}

		const updatedSummary: CommitSummary = {
			...summary,
			e2eTestGuide: scenarios,
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;

		const html = buildE2eTestSection(updatedSummary);
		this.panel.webview.postMessage({ command: "e2eTestUpdated", html });
	}

	/**
	 * Updates a single E2E scenario at the given index. Sends back a
	 * rendered scenario row via `e2eScenarioUpdated` so the webview can
	 * replace just that row, preserving collapsed state on other scenarios.
	 */
	private async handleEditE2eScenario(
		index: number,
		updates: Partial<E2eTestScenario>,
	): Promise<void> {
		const summary = this.currentSummary;
		if (!summary || !summary.e2eTestGuide) {
			return;
		}
		if (index < 0 || index >= summary.e2eTestGuide.length) {
			log.warn(
				"SummaryWebviewPanel",
				"editE2eScenario: index out of range",
				index,
			);
			return;
		}
		if (!(await this.ensureCommitNotRewritten("edit E2E scenario"))) {
			return;
		}

		const oldScenario = summary.e2eTestGuide[index];
		const merged: E2eTestScenario = {
			...oldScenario,
			...updates,
			// Preserve required-array shape: caller may omit unchanged arrays.
			steps: updates.steps ?? oldScenario.steps,
			expectedResults: updates.expectedResults ?? oldScenario.expectedResults,
		};
		// Honor caller's intent to clear preconditions: empty/undefined value
		// in updates means drop the field. Omitting the key keeps the old
		// value (already handled by the spread above).
		if (
			"preconditions" in updates &&
			(updates.preconditions === undefined || updates.preconditions === "")
		) {
			delete (merged as { preconditions?: string }).preconditions;
		}

		const newScenarios = summary.e2eTestGuide.map((s, i) =>
			i === index ? merged : s,
		);
		const updatedSummary: CommitSummary = {
			...summary,
			e2eTestGuide: newScenarios,
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;

		const html = renderE2eScenario(merged, index);
		this.panel.webview.postMessage({
			command: "e2eScenarioUpdated",
			scenarioIndex: index,
			html,
		});
	}

	/**
	 * Deletes a single E2E scenario at the given index. Since indices shift
	 * after removal, sends back a full re-rendered section via
	 * `e2eTestUpdated` (the existing whole-section replacement path).
	 *
	 * If the deletion empties the guide, `e2eTestGuide` is set to undefined
	 * so the webview falls back to the "no scenarios" placeholder.
	 */
	private async handleDeleteE2eScenario(
		index: number,
		title?: string,
	): Promise<void> {
		const summary = this.currentSummary;
		if (!summary || !summary.e2eTestGuide) {
			return;
		}
		if (index < 0 || index >= summary.e2eTestGuide.length) {
			log.warn(
				"SummaryWebviewPanel",
				"deleteE2eScenario: index out of range",
				index,
			);
			return;
		}
		// Check BEFORE the confirm dialog (same rationale as handleDeleteTopic).
		if (!(await this.ensureCommitNotRewritten("delete E2E scenario"))) {
			return;
		}

		const scenarioTitle = title ?? summary.e2eTestGuide[index].title;
		const choice = await vscode.window.showWarningMessage(
			`Delete scenario "${scenarioTitle}"?`,
			{ modal: true, detail: "This cannot be undone." },
			"Delete",
		);
		if (choice !== "Delete") {
			return;
		}

		// Race-window re-check: amend can land while the confirm modal is open.
		if (!(await this.ensureCommitNotRewritten("delete E2E scenario"))) {
			return;
		}

		const remaining = summary.e2eTestGuide.filter((_, i) => i !== index);
		const updatedSummary: CommitSummary = {
			...summary,
			e2eTestGuide: remaining.length > 0 ? remaining : undefined,
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;

		const html = buildE2eTestSection(updatedSummary);
		this.panel.webview.postMessage({ command: "e2eTestUpdated", html });
	}

	/** Deletes the E2E test guide (with confirmation). */
	private async handleDeleteE2eTest(): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}
		// Check BEFORE the confirm dialog (same rationale as handleDeleteTopic).
		if (!(await this.ensureCommitNotRewritten("delete E2E test guide"))) {
			return;
		}

		const choice = await vscode.window.showWarningMessage(
			"Delete E2E Test Guide?",
			{
				modal: true,
				detail: "This will remove all test scenarios. This cannot be undone.",
			},
			"Delete",
		);
		if (choice !== "Delete") {
			return;
		}

		// Race-window re-check: amend can land while the confirm modal is open.
		if (!(await this.ensureCommitNotRewritten("delete E2E test guide"))) {
			return;
		}

		const updatedSummary: CommitSummary = {
			...summary,
			e2eTestGuide: undefined,
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;

		const html = buildE2eTestSection(updatedSummary);
		this.panel.webview.postMessage({ command: "e2eTestUpdated", html });
	}

	// ── Plan handlers ────────────────────────────────────────────────────────

	private async handleLoadPlanContent(slug: string): Promise<void> {
		// Inline-edit data loader — never reachable in foreign mode (the
		// edit affordances are CSS-hidden under `.foreign-readonly` and
		// `loadPlanContent` is not on the foreign-safe whitelist). Reads
		// stay on the workspace's default storage.
		const content = await readPlanFromBranch(slug, this.workspaceRoot);
		if (content === null) {
			vscode.window.showErrorMessage(
				`Could not read plan "${slug}" from the orphan branch.`,
			);
			return; // Do NOT open edit with empty content — would silently overwrite the plan on save
		}
		this.panel.webview.postMessage({
			command: "planContentLoaded",
			slug,
			content,
		});
	}

	private async handleSavePlan(slug: string, content: string): Promise<void> {
		// Block the plan-write BEFORE it lands: although plan files are global
		// (one copy per slug, not per commit), this handler's side effect is
		// syncPlanTitle which writes back to the panel's stale summary. Letting
		// the plan write proceed alone would persist user intent but the title
		// sync would silently apply to an orphaned commit's summary, so we
		// treat the whole handler as a write against the stale commit.
		if (!(await this.ensureCommitNotRewritten("save plan"))) {
			return;
		}
		await this.bridge.storePlans([{ slug, content }], `Edit plan ${slug}`);
		await this.syncPlanTitle(slug, content);

		this.panel.webview.postMessage({ command: "planSaved", slug });
		void vscode.commands.executeCommand("jollimemory.refreshPlans");
		log.info("SummaryPanel", `Plan ${slug} saved to orphan branch`);
	}

	/**
	 * Extracts the title from plan markdown content and syncs it to
	 * CommitSummary.plans, plans.json registry, and the current webview.
	 */
	private async syncPlanTitle(
		slug: string,
		content: string,
		opts: { refresh?: boolean } = {},
	): Promise<void> {
		const { refresh = true } = opts;
		const titleMatch = /^#\s+(.+)/m.exec(content);
		const newTitle = titleMatch?.[1]?.trim();
		if (!newTitle || !this.currentSummary?.plans) {
			return;
		}

		const updatedPlans = this.currentSummary.plans.map((p) =>
			p.slug === slug ? { ...p, title: newTitle } : p,
		);
		const updatedSummary: CommitSummary = {
			...this.currentSummary,
			plans: updatedPlans,
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;
		// `refresh: false` lets the translate path batch a single refresh after it
		// finishes its own state mutation (planTranslateSet.delete), avoiding a
		// double render where the first one still shows the 🌐 button.
		if (refresh) {
			this.refreshPlansAndNotes(updatedSummary);
		}

		// plans.lock + fresh re-read so this title sync merges onto the latest state
		// instead of clobbering a concurrent write (the Codex-discovery tick in this
		// host, or a cross-process StopHook/QueueWorker).
		await withPlansLock(this.workspaceRoot, async () => {
			const registry = await loadPlansRegistry(this.workspaceRoot);
			const entry = registry.plans[slug];
			if (!entry) return;
			await savePlansRegistry(
				{
					...registry,
					plans: { ...registry.plans, [slug]: { ...entry, title: newTitle } },
				},
				this.workspaceRoot,
			);
		});
	}

	private async handleRemovePlan(slug: string, title: string): Promise<void> {
		const summary = this.currentSummary;
		if (!summary?.plans) {
			return;
		}
		// Check BEFORE the confirm dialog (same rationale as handleDeleteTopic).
		if (!(await this.ensureCommitNotRewritten("remove plan"))) {
			return;
		}

		const choice = await vscode.window.showWarningMessage(
			`Remove plan "${title}" from this commit?`,
			{
				modal: true,
				detail:
					"The plan will be unlinked from this commit and its Memory Bank copy in the branch folder will be removed. The plan source on the orphan branch is preserved.",
			},
			"Remove",
		);
		if (choice !== "Remove") {
			return;
		}

		// Race-window re-check: amend can land while the confirm modal is open.
		if (!(await this.ensureCommitNotRewritten("remove plan"))) {
			return;
		}

		// Update CommitSummary: remove plan from plans array
		const updatedPlans = summary.plans.filter((p) => p.slug !== slug);
		const updatedSummary: CommitSummary = {
			...summary,
			plans: updatedPlans.length > 0 ? updatedPlans : undefined,
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;

		// Dissociate from THIS commit: removePlan resolves the archive base
		// internally, but only deletes the base guard if it still belongs to this
		// commit (`expectedCommitHash`) — so removing an old summary's reference
		// never wipes a base row that has since been revived to a live plan or
		// re-committed elsewhere. No `ignored` tombstone — re-associable later.
		await removePlan(slug, this.workspaceRoot, summary.commitHash ?? undefined);

		// Remove the visible <branchFolder>/plan--<slug>.md in dual-write/folder
		// modes so the Memory Bank tree view stops showing a ghost file. Goes
		// through the Bridge so it picks up the extension's DualWriteStorage
		// instance — calling the SummaryStore wrapper directly here would fall
		// back to OrphanBranchStorage and silently no-op (the extension process
		// does not install setActiveStorage; only QueueWorker does).
		await this.bridge.cleanupVisiblePlanArtifact(slug, summary.branch);

		this.refreshPlansAndNotes(updatedSummary);
	}

	private async handleAddPlan(): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}
		// Check BEFORE the QuickPick so the user isn't prompted to pick a plan
		// that would be associated with an orphaned commit.
		if (!(await this.ensureCommitNotRewritten("add plan"))) {
			return;
		}

		const existingSlugs = new Set((summary.plans ?? []).map((p) => p.slug));
		const available = listAvailablePlans(existingSlugs);

		if (available.length === 0) {
			vscode.window.showInformationMessage("No plans available to add.");
			return;
		}

		const items = available.map((p) => ({
			label: p.title,
			description: `${p.slug}.md`,
			slug: p.slug,
		}));
		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select a plan to associate with this commit",
		});
		if (!selected) {
			return;
		}

		// Race-window re-check: amend can land while the QuickPick is open.
		// `archivePlanForCommit` would otherwise bind the plan to an orphaned
		// commit hash, and the subsequent `storeSummary` would write to the
		// orphaned summary.
		if (!(await this.ensureCommitNotRewritten("add plan"))) {
			return;
		}

		const planRef = await this.bridge.archivePlanForCommit(
			selected.slug,
			summary.commitHash,
		);
		if (!planRef) {
			vscode.window.showErrorMessage(
				`Failed to add plan "${selected.slug}" — plan file not found.`,
			);
			return;
		}

		const existingPlans = summary.plans ?? [];
		const updatedSummary: CommitSummary = {
			...summary,
			plans: [...existingPlans, planRef],
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;
		this.refreshPlansAndNotes(updatedSummary);
	}

	private async handleAddMarkdownNote(): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}
		// Check BEFORE the file picker so the user isn't asked to choose a note
		// that would be archived against an orphaned commit.
		if (!(await this.ensureCommitNotRewritten("add markdown note"))) {
			return;
		}

		const fileUri = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { Markdown: ["md"] },
			title: "Select a Markdown file to add as a note",
		});
		if (!fileUri || fileUri.length === 0) {
			return;
		}

		// Race-window re-check: amend can land while the file picker is open.
		// `archiveNoteForCommit` would otherwise bind the note to an orphaned
		// commit hash.
		if (!(await this.ensureCommitNotRewritten("add markdown note"))) {
			return;
		}

		const noteInfo = await saveNote(
			undefined,
			"",
			fileUri[0].fsPath,
			"markdown",
			this.workspaceRoot,
		);
		const noteRef = await this.bridge.archiveNoteForCommit(
			noteInfo.id,
			summary.commitHash,
		);
		if (!noteRef) {
			// Hard-remove the orphaned note entry so it doesn't linger in the sidebar
			await removeNote(noteInfo.id, this.workspaceRoot);
			vscode.window.showErrorMessage(
				"Failed to add markdown note — archive failed.",
			);
			return;
		}

		const existingNotes = summary.notes ?? [];
		const updatedSummary: CommitSummary = {
			...summary,
			notes: [...existingNotes, noteRef],
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;
		await this.refreshNoteTranslateSet(updatedSummary);
		this.refreshPlansAndNotes(updatedSummary);
	}

	private async handleSaveSnippet(
		title: string,
		content: string,
	): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}
		if (!content.trim()) {
			throw new Error("Snippet content is required");
		}
		if (!(await this.ensureCommitNotRewritten("save snippet"))) {
			return;
		}

		const noteInfo = await saveNote(
			undefined,
			title,
			content,
			"snippet",
			this.workspaceRoot,
		);
		const noteRef = await this.bridge.archiveNoteForCommit(
			noteInfo.id,
			summary.commitHash,
		);
		if (!noteRef) {
			await removeNote(noteInfo.id, this.workspaceRoot);
			vscode.window.showErrorMessage(
				"Failed to save snippet — archive failed.",
			);
			return;
		}

		const existingNotes = summary.notes ?? [];
		const updatedSummary: CommitSummary = {
			...summary,
			notes: [...existingNotes, noteRef],
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;
		await this.refreshNoteTranslateSet(updatedSummary);
		this.refreshPlansAndNotes(updatedSummary);
		this.panel.webview.postMessage({ command: "snippetSaved" });
	}

	/** Loads note content and sends it to the webview for inline editing (mirrors handleLoadPlanContent). */
	private async handleLoadNoteContent(
		id: string,
		format: string,
	): Promise<void> {
		const noteRef = this.currentSummary?.notes?.find((n) => n.id === id);
		if (!noteRef) {
			return;
		}

		// Snippets carry their content inline; markdown notes read from orphan branch.
		// Same rationale as handleLoadPlanContent: inline-edit loader, not
		// reachable in foreign mode — workspace-default storage stays correct.
		let content: string | null;
		if (format === "snippet" && noteRef.content) {
			content = noteRef.content;
		} else {
			content = await readNoteFromBranch(id, this.workspaceRoot);
		}

		if (content === null) {
			vscode.window.showErrorMessage(
				`Could not read note "${noteRef.title}" from the orphan branch.`,
			);
			return;
		}

		this.panel.webview.postMessage({
			command: "noteContentLoaded",
			id,
			content,
		});
	}

	/** Saves edited note content back to the orphan branch and updates the summary (mirrors handleSavePlan). */
	private async handleSaveNote(
		id: string,
		content: string,
		format: string,
	): Promise<void> {
		// Same rationale as handleSavePlan: the note body is global, but the
		// title/content sync writes back to the panel's stale summary.
		if (!(await this.ensureCommitNotRewritten("save note"))) {
			return;
		}
		await this.bridge.storeNotes([{ id, content }], `Edit note ${id}`);

		// Sync title and (for snippets) inline content in the summary
		if (this.currentSummary?.notes) {
			const titleMatch = /^#\s+(.+)/m.exec(content);
			const newTitle = titleMatch?.[1]?.trim();
			const updatedNotes = this.currentSummary.notes.map((n) => {
				if (n.id !== id) {
					return n;
				}
				const updates: { title?: string; content?: string } = {};
				if (newTitle) {
					updates.title = newTitle;
				}
				if (format === "snippet") {
					updates.content = content;
				}
				return { ...n, ...updates };
			});
			const updatedSummary: CommitSummary = {
				...this.currentSummary,
				notes: updatedNotes,
			};
			await this.bridge.storeSummary(updatedSummary, true);
			this.currentSummary = updatedSummary;
			// Stays inside the `if (this.currentSummary?.notes)` block: when there
			// are no notes there is nothing to re-render, but `noteSaved` below is
			// still posted so the webview exits inline-edit mode.
			this.refreshPlansAndNotes(updatedSummary);
		}

		this.panel.webview.postMessage({ command: "noteSaved", id });
		log.info("SummaryPanel", `Note ${id} saved to orphan branch`);
	}

	private async handleRemoveNote(id: string, title: string): Promise<void> {
		const summary = this.currentSummary;
		if (!summary?.notes) {
			return;
		}
		// Check BEFORE the confirm dialog (same rationale as handleDeleteTopic).
		if (!(await this.ensureCommitNotRewritten("remove note"))) {
			return;
		}

		const choice = await vscode.window.showWarningMessage(
			`Remove note "${title}" from this commit?`,
			{
				modal: true,
				detail:
					"The note will be unlinked from this commit and its Memory Bank copy in the branch folder will be removed. The note source on the orphan branch is preserved.",
			},
			"Remove",
		);
		if (choice !== "Remove") {
			return;
		}

		// Race-window re-check: amend can land while the confirm modal is open.
		if (!(await this.ensureCommitNotRewritten("remove note"))) {
			return;
		}

		const updatedNotes = summary.notes.filter((n) => n.id !== id);
		const updatedSummary: CommitSummary = {
			...summary,
			notes: updatedNotes.length > 0 ? updatedNotes : undefined,
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;
		// Dissociate from THIS commit: removeNote resolves the archive base but only
		// deletes the base guard if it still belongs to this commit
		// (`expectedCommitHash`), so removing an old summary's reference never wipes
		// a since-revived/re-committed live note. No `ignored` tombstone.
		await removeNote(id, this.workspaceRoot, summary.commitHash ?? undefined);

		// Remove the visible <branchFolder>/note--<id>.md in dual-write/folder
		// modes so the Memory Bank tree view stops showing a ghost file. Goes
		// through the Bridge so it picks up the extension's DualWriteStorage
		// instance (see handleRemovePlan for the rationale).
		await this.bridge.cleanupVisibleNoteArtifact(id, summary.branch);

		this.refreshPlansAndNotes(updatedSummary);
	}

	// ── Reference actions (multi-source: Linear / Jira / GitHub / Notion) ───
	//
	// All reference rows share the same `*Reference` data-action names. Once a
	// reference is associated with a commit, the orphan branch is the system
	// of record — the local `.jolli/jollimemory/` directory is never
	// consulted by these handlers.

	/**
	 * Opens the reference's URL in the default browser. Defense-in-depth: each
	 * SourceAdapter.extractRef already gates incoming URLs through
	 * `^https?://`, but the URL flows through `data-reference-url` on the
	 * rendered row (a sink the user can't taint directly but a bug upstream
	 * could). Re-validate at the sink so `javascript:` / `data:` / `file:`
	 * can't smuggle through `openExternal`. Mirrors ReferenceService.open-
	 * ReferenceInBrowser verbatim.
	 */
	private async handleOpenReferenceExternal(url: string): Promise<void> {
		if (!url) return;
		const uri = vscode.Uri.parse(url);
		if (uri.scheme !== "http" && uri.scheme !== "https") {
			log.warn(
				"SummaryPanel",
				`refusing non-http(s) URL for openReferenceExternal: scheme=${uri.scheme}`,
			);
			vscode.window.showWarningMessage(
				`Refused to open non-http(s) URL: ${url}`,
			);
			return;
		}
		await vscode.env.openExternal(uri);
	}

	/**
	 * Opens the captured-at-commit markdown snapshot for a reference in a
	 * read-only editor.
	 *
	 * Source: orphan branch `references/<source>/<sanitized>.md`. Once a
	 * reference is associated with a commit, the local `.jolli/jollimemory/`
	 * directory is no longer authoritative — the orphan branch is the system
	 * of record. Linear is treated identically to Jira / GitHub / Notion.
	 */
	private async handlePreviewReference(
		archivedKey: string,
		source: SourceId,
		_nativeId: string,
		_title: string,
	): Promise<void> {
		if (!archivedKey) return;
		const content = await readReferenceFromBranch(
			source,
			archivedKey,
			this.workspaceRoot,
			this.foreignStorage ?? undefined,
		);
		if (!content) {
			vscode.window.showErrorMessage(
				`Reference snapshot "${archivedKey}" not found on the orphan branch.`,
			);
			return;
		}
		// Untitled doc — same rationale as plan / note preview: never re-
		// materialize on the user's disk. The orphan branch is the source of
		// truth for archived snapshots.
		const doc = await vscode.workspace.openTextDocument({
			language: "markdown",
			content,
		});
		await vscode.window.showTextDocument(doc);
	}

	/**
	 * Loads the archived reference markdown body into the webview for inline
	 * editing. Mirrors `handleLoadPlanContent`.
	 */
	private async handleLoadReferenceContent(
		archivedKey: string,
		source: SourceId,
	): Promise<void> {
		const content = await readReferenceFromBranch(
			source,
			archivedKey,
			this.workspaceRoot,
			this.foreignStorage ?? undefined,
		);
		if (content === null) {
			vscode.window.showErrorMessage(
				`Could not read reference "${archivedKey}" from the orphan branch.`,
			);
			return; // Do NOT open edit with empty content — would silently overwrite on save.
		}
		this.panel.webview.postMessage({
			command: "referenceContentLoaded",
			archivedKey,
			source,
			content,
		});
	}

	/**
	 * Writes edited reference content back to the orphan branch. Mirrors
	 * `handleSavePlan` — the file lives at
	 * `references/<source>/<sanitized-bareKey>.md`. We do NOT sync the title
	 * back into `summary.references[].title` because the reference title is
	 * sourced from the upstream system (Jira/Linear/Notion/GitHub) and
	 * silently overwriting it with the markdown's first heading would drift
	 * from upstream on every save.
	 */
	private async handleSaveReferenceEdit(
		archivedKey: string,
		source: SourceId,
		content: string,
	): Promise<void> {
		if (!(await this.ensureCommitNotRewritten("save reference"))) {
			return;
		}
		await this.bridge.storeReferences(
			[{ archivedKey, source, content }],
			`Edit ${source} reference ${archivedKey}`,
		);
		this.panel.webview.postMessage({
			command: "referenceSaved",
			archivedKey,
			source,
		});
		log.info(
			"SummaryPanel",
			`Reference ${source}:${archivedKey} saved to orphan branch`,
		);
	}

	/**
	 * Dissociates a reference from this commit's summary. Mirrors
	 * `handleRemovePlan` / `handleRemoveNote`. Splices from `references`. The
	 * archived markdown file on the orphan branch is preserved (don't delete
	 * history).
	 */
	private async handleRemoveReference(
		archivedKey: string,
		source: SourceId,
		nativeId: string,
		title: string,
	): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) return;
		const hasReference = summary.references?.some((e) => e.archivedKey === archivedKey) ?? false;
		if (!hasReference) return;

		// Check BEFORE the confirm dialog (same rationale as handleDeleteTopic).
		if (!(await this.ensureCommitNotRewritten("remove reference"))) {
			return;
		}

		const sourceLabel = SOURCE_TITLES[source];
		const dialogTitle = title || nativeId || archivedKey;
		const choice = await vscode.window.showWarningMessage(
			`Remove ${sourceLabel} reference "${dialogTitle}" from this commit?`,
			{
				modal: true,
				detail:
					"The reference will no longer be linked to this commit's summary. The captured markdown snapshot is preserved on the orphan branch.",
			},
			"Remove",
		);
		if (choice !== "Remove") {
			return;
		}

		// Race-window re-check: amend can land while the confirm modal is open.
		if (!(await this.ensureCommitNotRewritten("remove reference"))) {
			return;
		}

		// `summary.references` is guaranteed a non-empty array here: the
		// `hasReference` guard above returns early when it is missing or empty, so
		// the `?? []` fallback branch is unreachable.
		/* v8 ignore start */
		const existingReferences = summary.references ?? [];
		/* v8 ignore stop */
		const updatedReferences = existingReferences.filter(
			(e) => e.archivedKey !== archivedKey,
		);
		const updatedSummary: CommitSummary = {
			...summary,
			references: updatedReferences.length > 0 ? updatedReferences : undefined,
		};
		await this.bridge.storeSummary(updatedSummary, true);
		this.currentSummary = updatedSummary;

		// Dissociation is complete once the entry is dropped from the commit's
		// CommitSummary.references (above). Under the commit-deletes-entry model
		// (§13), a committed reference has no plans.json row and no local `.md`
		// (both removed at association time), so there is nothing else to delete
		// here. A later re-reference of the same entity is re-discovered as a
		// fresh uncommitted reference — dissociation does not blacklist.

		this.refreshPlansAndNotes(updatedSummary);
	}

	/**
	 * Translates a reference's archived markdown to English via LLM. Mirrors
	 * `handleTranslatePlan` — same translation pipeline, same cache shape
	 * (keyed on archivedKey). Writes the translated content back to the
	 * orphan branch via `storeReferences`.
	 */
	private async handleTranslateReference(
		archivedKey: string,
		source: SourceId,
	): Promise<void> {
		if (!(await this.ensureCommitNotRewritten("translate reference"))) {
			return;
		}
		const content = await readReferenceFromBranch(
			source,
			archivedKey,
			this.workspaceRoot,
			this.foreignStorage ?? undefined,
		);
		if (content === null) {
			vscode.window.showErrorMessage(
				`Could not read reference "${archivedKey}" from the orphan branch.`,
			);
			return;
		}

		// Check both title and body — title is part of the ReferenceCommitRef
		// snapshot, body is on the orphan branch.
		const reference = this.findReferenceInSummary(archivedKey);
		const titleHasNonAscii = reference
			? SummaryWebviewPanel.CJK_RE.test(reference.title)
			: false;
		if (!titleHasNonAscii && !SummaryWebviewPanel.CJK_RE.test(content)) {
			vscode.window.showInformationMessage("Reference is already in English.");
			return;
		}

		this.panel.webview.postMessage({
			command: "referenceTranslating",
			archivedKey,
		});

		const translateConfig = await loadGlobalConfig();
		const translated = await translateToEnglish({
			content,
			config: translateConfig,
		});

		// Race-window re-check: amend can land during the LLM call (10–60s).
		// `storeReferences` is content-only (no per-commit metadata sync), so
		// we let it land regardless — losing translated bodies would discard
		// real user work.
		if (!(await this.ensureCommitNotRewritten("translate reference"))) {
			return;
		}

		await this.bridge.storeReferences(
			[{ archivedKey, source, content: translated }],
			`Translate ${source} reference ${archivedKey} to English`,
		);

		// Drop from translate set immediately — user explicitly translated.
		this.referenceTranslateSet.delete(archivedKey);
		if (this.currentSummary) {
			this.refreshPlansAndNotes(this.currentSummary);
		}

		this.panel.webview.postMessage({
			command: "referenceTranslated",
			archivedKey,
		});
		vscode.window.showInformationMessage(
			`Reference "${archivedKey}" has been translated to English.`,
		);
		log.info(
			"SummaryPanel",
			`Reference ${source}:${archivedKey} translated to English`,
		);
	}

	/**
	 * Finds a reference in the current summary by archivedKey. Used by
	 * handleTranslateReference for the cheap title-CJK check.
	 */
	private findReferenceInSummary(
		archivedKey: string,
	): ReferenceCommitRef | undefined {
		const s = this.currentSummary;
		if (!s) return undefined;
		return s.references?.find((e) => e.archivedKey === archivedKey);
	}

	/** Translates a plan from its current language to English via LLM. */
	private async handleTranslatePlan(slug: string): Promise<void> {
		// Same rationale as handleSavePlan: title sync goes to the stale summary.
		if (!(await this.ensureCommitNotRewritten("translate plan"))) {
			return;
		}
		const content = await readPlanFromBranch(slug, this.workspaceRoot);
		if (content === null) {
			vscode.window.showErrorMessage(
				`Could not read plan "${slug}" from the orphan branch.`,
			);
			return;
		}

		// Check both title and body — title is embedded in the markdown as # heading
		const plan = this.currentSummary?.plans?.find((p) => p.slug === slug);
		const titleHasNonAscii = plan
			? SummaryWebviewPanel.CJK_RE.test(plan.title)
			: false;
		if (!titleHasNonAscii && !SummaryWebviewPanel.CJK_RE.test(content)) {
			vscode.window.showInformationMessage("Plan is already in English.");
			return;
		}

		// Notify webview of loading state
		this.panel.webview.postMessage({ command: "planTranslating", slug });

		const translateConfig = await loadGlobalConfig();
		const translated = await translateToEnglish({
			content,
			config: translateConfig,
		});

		// Race-window re-check: amend can land during the LLM call (10–60s).
		// `syncPlanTitle` would otherwise persist the new title to the stale
		// commit's summary. `storePlans` is global content so we let it run
		// regardless — losing the translated body would discard real user work.
		if (!(await this.ensureCommitNotRewritten("translate plan"))) {
			return;
		}

		// Save translated content and sync title to summary + registry
		await this.bridge.storePlans(
			[{ slug, content: translated }],
			`Translate plan ${slug} to English`,
		);
		// `refresh: false`: syncPlanTitle must not render before the translate set
		// is updated below, or the first render would still show the 🌐 button.
		await this.syncPlanTitle(slug, translated, { refresh: false });

		// Remove from translate set immediately — user explicitly requested translation
		this.planTranslateSet.delete(slug);
		if (this.currentSummary) {
			this.refreshPlansAndNotes(this.currentSummary);
		}

		this.panel.webview.postMessage({ command: "planTranslated", slug });
		void vscode.commands.executeCommand("jollimemory.refreshPlans");
		vscode.window.showInformationMessage(
			`Plan "${slug}" has been translated to English.`,
		);
		log.info("SummaryPanel", `Plan ${slug} translated to English`);
	}

	/** Translates a note from its current language to English via LLM. */
	private async handleTranslateNote(id: string): Promise<void> {
		const noteRef = this.currentSummary?.notes?.find((n) => n.id === id);
		if (!noteRef) {
			return;
		}
		// Same rationale as handleSavePlan: title sync goes to the stale summary.
		if (!(await this.ensureCommitNotRewritten("translate note"))) {
			return;
		}
		const content =
			noteRef.format === "snippet" && noteRef.content
				? noteRef.content
				: await readNoteFromBranch(id, this.workspaceRoot);
		if (content === null) {
			vscode.window.showErrorMessage(
				`Could not read note "${noteRef.title}" from the orphan branch.`,
			);
			return;
		}

		// Check both title and body for CJK characters
		const titleHasNonAscii = SummaryWebviewPanel.CJK_RE.test(noteRef.title);
		if (!titleHasNonAscii && !SummaryWebviewPanel.CJK_RE.test(content)) {
			vscode.window.showInformationMessage("Note is already in English.");
			return;
		}

		// Notify webview of loading state
		this.panel.webview.postMessage({ command: "noteTranslating", id });

		const translateConfig = await loadGlobalConfig();
		const translated = await translateToEnglish({
			content,
			config: translateConfig,
		});

		// Race-window re-check: amend can land during the LLM call (10–60s).
		// The note body sync below would otherwise persist to the stale summary.
		// `storeNotes` is global content so we let it run regardless.
		if (!(await this.ensureCommitNotRewritten("translate note"))) {
			return;
		}

		// Save translated content to orphan branch
		await this.bridge.storeNotes(
			[{ id, content: translated }],
			`Translate note ${id} to English`,
		);

		// Sync title and (for snippets) inline content in the summary
		if (this.currentSummary?.notes) {
			const titleMatch = /^#\s+(.+)/m.exec(translated);
			const newTitle = titleMatch?.[1]?.trim();
			const updatedNotes = this.currentSummary.notes.map((n) => {
				if (n.id !== id) {
					return n;
				}
				const updates: { title?: string; content?: string } = {};
				if (newTitle) {
					updates.title = newTitle;
				}
				if (n.format === "snippet") {
					updates.content = translated;
				}
				return { ...n, ...updates };
			});
			const updatedSummary: CommitSummary = {
				...this.currentSummary,
				notes: updatedNotes,
			};
			await this.bridge.storeSummary(updatedSummary, true);
			this.currentSummary = updatedSummary;
		}

		// Remove from translate set immediately — user explicitly requested translation
		this.noteTranslateSet.delete(id);
		if (this.currentSummary) {
			this.refreshPlansAndNotes(this.currentSummary);
		}

		const translatedTitle =
			this.currentSummary?.notes?.find((n) => n.id === id)?.title ??
			noteRef.title;
		this.panel.webview.postMessage({ command: "noteTranslated", id });
		vscode.window.showInformationMessage(
			`Note "${translatedTitle}" has been translated to English.`,
		);
		log.info("SummaryPanel", `Note ${id} translated to English`);
	}

	// ─── Transcript handlers ─────────────────────────────────────────────────

	/** Loads lightweight stats (session/entry counts by source) without sending full content. */
	private async handleLoadTranscriptStats(): Promise<void> {
		if (this.transcriptHashSet.size === 0) {
			return;
		}
		const transcriptMap = this.foreignStorage
			? await coreReadTranscriptsForCommits(
					[...this.transcriptHashSet],
					this.workspaceRoot,
					this.foreignStorage,
				)
			: await this.bridge.readTranscriptsForCommits([
					...this.transcriptHashSet,
				]);

		// Stats reflect the transcripts actually archived at commit time. They are
		// NOT filtered by the current Settings enable flags: those flags govern
		// whether a source is *captured going forward*, not whether already-archived
		// history is shown. Filtering here under-counted disabled-source sessions and
		// — paired with the save path — was the visible half of a silent data-loss bug.
		const seen = new Set<string>();
		let totalEntries = 0;
		const sessionCounts: Record<string, number> = {};
		for (const [, transcript] of transcriptMap) {
			for (const session of transcript.sessions) {
				const source = session.source ?? "claude";
				const key = `${source}:${session.sessionId}`;
				totalEntries += session.entries.length;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				sessionCounts[source] = (sessionCounts[source] ?? 0) + 1;
			}
		}

		this.panel.webview.postMessage({
			command: "transcriptStatsLoaded",
			totalEntries,
			sessionCounts,
		});
	}

	/**
	 * Reads the archived transcripts and collapses them into per-conversation
	 * rows for the inline Conversations panel. One row per `source:sessionId`
	 * (a session may be split across several commits' transcript files — its
	 * entries are merged, mirroring SidebarWebviewProvider.readArchivedSessions
	 * / computeMemoryEvidence). The title goes through the SAME
	 * `resolveSessionTitle` the sidebar uses, so the two surfaces show identical
	 * labels — that consistency is the point. Titles/counts are only knowable at
	 * runtime, so the build-time `buildConversationsSection` only renders the
	 * panel shell + a Loading placeholder; this fills it.
	 */
	/**
	 * Reads the archived transcripts and collapses the same session across
	 * transcript files into one entry per `source:sessionId`, keeping first-seen
	 * order and the first-seen owning commit hash (the row's data-hash). The
	 * "claude" default mirrors the reader's back-compat for a source-less stored
	 * session (matches getSourceLabel + the detach match key). Shared by the
	 * Conversations list render (handleLoadConversations) and the row-click
	 * open (handleOpenConversation) so both agree on session identity + merged
	 * entries — that consistency is the point.
	 */
	private async readGroupedArchivedSessions(): Promise<{
		order: string[];
		grouped: Map<
			string,
			{ session: StoredSession; hash: string; entries: StoredSession["entries"][number][] }
		>;
	}> {
		const hashes = [...this.transcriptHashSet];
		const transcriptMap = this.foreignStorage
			? await coreReadTranscriptsForCommits(hashes, this.workspaceRoot, this.foreignStorage)
			: await this.bridge.readTranscriptsForCommits(hashes);

		const order: string[] = [];
		// Collect each session's slices separately first; a consolidated memory's
		// transcript set is NOT in time order, so appending slices as they arrive
		// would interleave turns wrong. We sort the slices chronologically below.
		const collected = new Map<
			string,
			{ session: StoredSession; hash: string; parts: StoredSession["entries"][number][][] }
		>();
		for (const [commitHash, transcript] of transcriptMap) {
			for (const session of transcript.sessions) {
				const key = `${session.source ?? "claude"}:${session.sessionId}`;
				const slice = [...(session.entries ?? [])];
				const existing = collected.get(key);
				if (existing) {
					existing.parts.push(slice);
				} else {
					order.push(key);
					collected.set(key, { session, hash: commitHash, parts: [slice] });
				}
			}
		}

		// Reassemble each session by ordering its slices by first-known timestamp,
		// then flattening — the same sliceStartTime + stable-sort the sidebar's
		// readArchivedSessions uses, so the inline Conversations list and its
		// row-click transcript show turns in true chronological order (slices with
		// no parseable timestamp keep first-seen order via the 0-return comparator).
		const grouped = new Map<
			string,
			{ session: StoredSession; hash: string; entries: StoredSession["entries"][number][] }
		>();
		for (const key of order) {
			const g = collected.get(key) as NonNullable<ReturnType<typeof collected.get>>;
			const sorted = [...g.parts].sort((a, b) => {
				const ta = sliceStartTime(a);
				const tb = sliceStartTime(b);
				if (ta === undefined || tb === undefined) return 0;
				return ta - tb;
			});
			grouped.set(key, { session: g.session, hash: g.hash, entries: sorted.flat() });
		}
		return { order, grouped };
	}

	private async handleLoadConversations(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const { order, grouped } = await this.readGroupedArchivedSessions();

		const items = await Promise.all(
			order.map(async (key) => {
				const { session, hash, entries } = grouped.get(key) as NonNullable<
					ReturnType<typeof grouped.get>
				>;
				const source: TranscriptSource = session.source ?? "claude";
				const title = await resolveSessionTitle(
					{
						sessionId: session.sessionId,
						transcriptPath: session.transcriptPath ?? "",
						updatedAt: "",
						source,
					},
					entries,
				);
				return {
					sessionId: session.sessionId,
					hash,
					source,
					title,
					messageCount: entries.length,
				};
			}),
		);

		this.panel.webview.postMessage({ command: "conversationsData", items });
	}

	/**
	 * Opens one conversation row's transcript in a read-only
	 * `ConversationDetailsPanel` (archived snapshot off the orphan branch),
	 * mirroring the sidebar's `kb:openEvidenceConversation`. The detail panel
	 * only ever shows a COMMITTED memory, so the live cursor-trimmed read is
	 * wrong here — we hand the panel the merged archived `entries` directly.
	 *
	 * Source crosses the webview trust boundary as `unknown`; a spoofed or stale
	 * `source`/`sessionId` simply misses the grouped map and degrades to a warn
	 * (no FS write, no workspace coupling — the archived read is view-only).
	 */
	private async handleOpenConversation(sessionId: string, source: TranscriptSource): Promise<void> {
		if (this.disposed || !this.currentSummary) {
			return;
		}
		const { grouped } = await this.readGroupedArchivedSessions();
		const entry = grouped.get(`${source}:${sessionId}`);
		if (!entry) {
			log.warn("Open conversation: session %s (%s) not found in this memory", sessionId, source);
			return;
		}
		const title = await resolveSessionTitle(
			{
				sessionId,
				transcriptPath: entry.session.transcriptPath ?? "",
				updatedAt: "",
				source,
			},
			entry.entries,
		);
		ConversationDetailsPanel.show({
			extensionUri: this.extensionUri,
			sessionId,
			source,
			transcriptPath: entry.session.transcriptPath ?? "",
			title,
			archivedEntries: entry.entries,
			commitHash: this.currentSummary.commitHash,
		});
	}

	/**
	 * Resolves whether the Files panel's diff affordance is usable: the
	 * commit must live in THIS workspace's git history (not a foreign Memory
	 * Bank repo) AND be reachable from the checked-out branch. A foreign
	 * summary's commit hash simply doesn't exist in the current repo's git
	 * history; a same-repo summary's commit can still be unreachable if the
	 * user has switched branches since the memory was recorded (amend/rebase
	 * on another branch, or the summary just belongs to an unmerged branch
	 * that isn't checked out right now). Either way `vscode.diff` would be
	 * given a ref git can't resolve, so both fold into the same off-branch
	 * rendering (`.is-unresolvable` rows + a "check out `<branch>`" hint).
	 */
	private async isFilesDiffResolvable(commitHash: string): Promise<boolean> {
		if (this.foreignRepoName) {
			return false;
		}
		return isAncestor(commitHash, "HEAD", this.workspaceRoot);
	}

	/**
	 * Computes per-file status rows for the Files panel and posts them to the
	 * webview. Mirrors `handleLoadConversations`'s build-time-shell +
	 * postMessage pattern: `buildFilesPanelShell` renders a "Loading…"
	 * placeholder synchronously, and this async handler fills it once the
	 * git diff resolves.
	 *
	 * Row source: `bridge.listCommitFiles(commitHash)` — the same
	 * `git diff-tree -m --first-parent -M --root` projection the Commits-tree
	 * view uses, so status codes (added/deleted/renamed) are real git truth
	 * rather than defaulting everything to "M". Falls back to the summary's
	 * per-topic `filesAffected` (path-only, deduped, status defaulted to "M")
	 * only when `listCommitFiles` didn't run at all (foreign-repo summary,
	 * whose commit was never in this workspace's git) or threw — mirroring
	 * `SidebarWebviewProvider.pushMemoryEvidence`'s identical fallback for the
	 * sidebar's FILES evidence group. A same-repo commit that legitimately
	 * changed zero files (e.g. an empty merge commit) is NOT treated as a
	 * fallback trigger — an empty git-truth result is trusted as-is.
	 */
	private async handleLoadFiles(): Promise<void> {
		if (this.disposed || !this.currentSummary) {
			return;
		}
		const summary = this.currentSummary;
		const commitHash = summary.commitHash;

		let rows: FileRow[] = [];
		let filesResolved = false;
		if (!this.foreignRepoName) {
			try {
				const commitFiles = await this.bridge.listCommitFiles(commitHash);
				rows = commitFiles.map((f) => toFileRow(f.relativePath, f.statusCode, f.oldPath));
				filesResolved = true;
			} catch (err) {
				log.warn(
					"Load files: listCommitFiles failed, falling back to topic paths: %s",
					err instanceof Error ? err.message : String(err),
				);
			}
		}
		if (!filesResolved) {
			const seen = new Set<string>();
			for (const topic of summary.topics ?? []) {
				for (const relPath of topic.filesAffected ?? []) {
					if (!seen.has(relPath)) {
						seen.add(relPath);
						rows.push(toFileRow(relPath, "M"));
					}
				}
			}
		}

		const offBranch = !(await this.isFilesDiffResolvable(commitHash));
		if (this.disposed) {
			return;
		}
		this.panel.webview.postMessage({
			command: "files:rows",
			rows,
			offBranch,
			branch: summary.branch,
			commitHash,
		});
	}

	/**
	 * Opens the file's diff at the memory's commit via the same VS Code
	 * `git:` URI + `vscode.diff` plumbing `jollimemory.openCommitFileChange`
	 * uses for the Commits (history) tree — added files show the
	 * post-commit content, deleted files show the pre-commit content, and
	 * modified/renamed files diff parent↔commit. Reusing the registered
	 * command (rather than duplicating its `toGitUri` calls here) keeps the
	 * diff-opening behavior in exactly one place.
	 *
	 * The webview only emits `openFileDiff` for resolvable rows (off-branch
	 * rows render without `data-path`, so there's nothing to click), but this
	 * handler doesn't re-check reachability — `jollimemory.openCommitFileChange`
	 * simply fails to resolve the git URI if the commit isn't reachable,
	 * which surfaces as VS Code's own "file not found" editor error.
	 *
	 * `oldPath` is forwarded straight through for rename rows (`status ===
	 * "R"`) — `jollimemory.openCommitFileChange` needs it to diff the
	 * pre-rename blob against the post-rename one. Without it, a rename
	 * falls through to the "modified" branch keyed on the new path, which
	 * has no parent-side blob to diff against.
	 */
	private async handleOpenFileDiff(
		path: string,
		commitHash: string,
		status: string,
		oldPath?: string,
	): Promise<void> {
		await vscode.commands.executeCommand("jollimemory.openCommitFileChange", {
			commitHash,
			relativePath: path,
			statusCode: status,
			oldPath,
		});
	}

	/**
	 * Detaches a single conversation (one `source:sessionId`) from this memory:
	 * rewrites every transcript file that contains that session with the session
	 * removed, deleting any transcript that becomes empty (and dropping the empty
	 * ones from `summary.transcripts`). This is the per-session slice of the old
	 * modal's "Mark as Deleted" flow, reusing `saveTranscriptsBatch` +
	 * `persistTranscriptIdRemoval`. On success posts `conversationDetached` so the
	 * webview removes just that row in place.
	 *
	 * Matches on the composite `source:sessionId` key — the same identity
	 * `handleLoadConversations` groups sessions by — not bare `sessionId`.
	 * Per-source discoverers (Cursor's composerId,
	 * Copilot's raw SQLite row id, Codex's session-file id, …) mint IDs with no
	 * cross-tool namespacing, so two different sources can produce the same raw
	 * sessionId; matching on sessionId alone could silently detach an unrelated
	 * conversation from a different source.
	 */
	private async handleConversationDetach(
		hash: string,
		sessionId: string,
		source: TranscriptSource,
	): Promise<void> {
		if (this.foreignRepoName) {
			this.notifyForeignDenied("conversationDetach");
			return;
		}
		// Same stale-commit guard the transcript save/delete handlers use: writes
		// are keyed by `transcriptHashSet`, which reflects the orphaned tree after
		// an amend/rebase — letting them through would mutate the wrong commit's
		// transcript files.
		if (!(await this.ensureCommitNotRewritten("detach conversation"))) {
			return;
		}

		const transcriptMap = await this.bridge.readTranscriptsForCommits([
			...this.transcriptHashSet,
		]);

		const writes: Array<{ hash: string; data: StoredTranscript }> = [];
		const deletes: Array<string> = [];
		let removedAny = false;

		for (const [commitHash, transcript] of transcriptMap) {
			const kept = transcript.sessions.filter(
				(s) => !(s.sessionId === sessionId && (s.source ?? "claude") === source),
			);
			if (kept.length === transcript.sessions.length) {
				// Session not in this transcript — leave it untouched.
				continue;
			}
			removedAny = true;
			if (kept.length === 0) {
				deletes.push(commitHash);
			} else {
				writes.push({ hash: commitHash, data: { sessions: kept } });
			}
		}

		if (!removedAny) {
			// Nothing matched (already detached / stale row) — ack anyway so the
			// webview clears the row rather than leaving it stuck.
			this.panel.webview.postMessage({
				command: "conversationDetached",
				hash,
				sessionId,
				source,
			});
			return;
		}

		// Summary-first ordering (same rationale as persistTranscriptIdRemoval's
		// other callers): if any transcript files become empty, drop their IDs from
		// `summary.transcripts` BEFORE touching files, so a file-batch failure
		// leaves at worst "no files touched yet" rather than a dangling reference.
		// Both steps re-throw on failure (rather than swallowing the error) so
		// the dispatcher's `catchAndShow` wrapper surfaces a visible error toast
		// instead of leaving `summary.transcripts` and the on-disk transcript
		// files silently inconsistent with each other. Unlike the old modal's
		// Save/Delete buttons, this row has no "in progress" UI state to unstick,
		// so there's no need for a dedicated webview-side failure message.
		if (deletes.length > 0 && this.currentSummary) {
			try {
				this.currentSummary = await this.persistTranscriptIdRemoval(
					this.currentSummary,
					new Set(deletes),
				);
			} catch (err) {
				log.warn(
					"Detach aborted — could not persist summary.transcripts: %s",
					err instanceof Error ? err.message : String(err),
				);
				throw new Error("Could not update summary. Transcript files were NOT modified.");
			}
		}

		try {
			await this.bridge.saveTranscriptsBatch(writes, deletes);
		} catch (err) {
			log.warn(
				"Summary updated but transcript file batch failed during detach: %s",
				err instanceof Error ? err.message : String(err),
			);
			throw new Error("Some transcript files failed to write. See logs.");
		}

		if (this.currentSummary) {
			await this.refreshTranscriptHashes(this.currentSummary);
		}

		this.panel.webview.postMessage({
			command: "conversationDetached",
			hash,
			sessionId,
			source,
		});
	}

	/**
	 * Removes the given transcript IDs from `summary.transcripts` and persists
	 * the updated summary via `storeSummary(force=true)`. Returns the new
	 * summary on success; **throws** on `storeSummary` failure so callers can
	 * surface the abort decision (e.g. skip the file delete that would otherwise
	 * leave a half-migration state).
	 *
	 * Handles both v5 and pre-v5 (legacy v3/v4) inputs:
	 *   - v5 (`summary.transcripts !== undefined`): filter the existing
	 *     authoritative array.
	 *   - Legacy: derive the effective ID list from `transcriptHashSet`, which
	 *     `refreshTranscriptHashes` already filtered to tree IDs that have a
	 *     `transcripts/<id>.json` file on disk — so the lazy upgrade writes the
	 *     SAME file-backed set the v5 migration would (no dangling commit-hash
	 *     IDs baked in). Filter, then write back as a v5 summary — the delete
	 *     **lazily upgrades** the on-disk record to v5 (`version: 5` + the
	 *     `transcripts` field). Without this, a delete that runs before the
	 *     background v5 migration completes would leave the legacy summary
	 *     intact; the next amend/squash/rebase would then re-inherit the
	 *     just-deleted IDs via the legacy fallback and stamp them onto the new
	 *     v5 root.
	 *
	 * No-op (returns same reference) when nothing references any of the
	 * removal IDs — both for empty v5 arrays and for legacy summaries whose
	 * file-backed set is empty.
	 */
	private async persistTranscriptIdRemoval(
		summary: CommitSummary,
		idsToRemove: ReadonlySet<string>,
	): Promise<CommitSummary> {
		const isLegacy = summary.transcripts === undefined;
		// Legacy: `transcriptHashSet` is the tree's transcript IDs already
		// intersected with on-disk files (see refreshTranscriptHashes), so it's
		// the file-backed set the migration would produce — using it avoids
		// re-baking dangling IDs. v5: the array is authoritative.
		const current = isLegacy ? [...this.transcriptHashSet] : (summary.transcripts ?? []);
		if (current.length === 0) {
			return summary;
		}
		const filtered = current.filter((id) => !idsToRemove.has(id));
		// Fast-path: nothing removed AND already v5-shaped → return as-is.
		// Legacy summaries still need a write even when `filtered.length ===
		// current.length` would normally short-circuit, because the legacy
		// summary itself doesn't have a `transcripts` field / `version: 5` —
		// writing it is the lazy-upgrade.
		if (!isLegacy && filtered.length === current.length) {
			return summary;
		}
		// Write back as a real v5 record: stamp `version: 5` AND the
		// `transcripts` field (v5 contract: always present, even when empty —
		// `[]` means "this commit no longer references any transcripts"). Bumping
		// the version keeps the on-disk record from being a "version<5 but has
		// transcripts" hybrid that a future version-routing read path would
		// misclassify.
		const updated: CommitSummary = { ...summary, version: CURRENT_SCHEMA_VERSION, transcripts: filtered };
		await this.bridge.storeSummary(updated, true);
		return updated;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deep-equal comparison for two CommitSummary objects via JSON serialization.
 * Lets `show()` skip the refresh + re-render pipeline when the user clicks
 * the same tree item twice without any underlying data change.
 */
function summariesEqual(
	a: CommitSummary | undefined,
	b: CommitSummary,
): boolean {
	if (!a) {
		return false;
	}
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Shallow set-equality for the cache sets used by the render inputs. */
function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const v of a) {
		if (!b.has(v)) {
			return false;
		}
	}
	return true;
}

/** Extracts a human-readable error message from a rejected `PromiseSettledResult`. */
function extractSettledError(result: PromiseSettledResult<unknown>): string {
	// Callers guard the fulfilled+value path, so only rejected results reach here.
	// The cast is safe because the caller already checked `result.status === "fulfilled" && result.value`.
	const { reason } = result as PromiseRejectedResult;
	return reason instanceof Error ? reason.message : String(reason);
}

/** Converts a settled Jolli push result into the `pushToJolliResult` webview message. */
function toJolliResultMessage(
	result: PromiseSettledResult<{ url: string; docId: number } | undefined>,
): Record<string, unknown> {
	if (result.status === "fulfilled" && result.value) {
		return {
			command: "pushToJolliResult",
			success: true,
			url: result.value.url,
			docId: result.value.docId,
		};
	}
	return {
		command: "pushToJolliResult",
		success: false,
		error: extractSettledError(result),
	};
}

/** Exposed for unit tests. */
export const __test__ = {
	summariesEqual,
	setsEqual,
};
