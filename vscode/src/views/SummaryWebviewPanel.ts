/**
 * SummaryWebviewPanel
 *
 * Opens a webview beside the editor showing the full JolliMemory "Commit Memory" for a commit.
 *
 * Features:
 * - Opens in ViewColumn.Beside (doesn't replace the active editor)
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
import {
	loadPlansRegistry,
	savePlansRegistry,
} from "../../../cli/src/core/SessionTracker.js";
import {
	generateE2eTest,
	generateRecap,
	translateToEnglish,
} from "../../../cli/src/core/Summarizer.js";
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
	NoteReference,
	PlanReference,
	ReferenceCommitRef,
	SourceId,
	StoredTranscript,
} from "../../../cli/src/Types.js";
import { CURRENT_SCHEMA_VERSION } from "../../../cli/src/Types.js";
import { removeNote, saveNote } from "../core/NoteService.js";
import {
	listAvailablePlans,
	removePlan,
} from "../core/PlanService.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import {
	BindingRequiredError,
	deleteFromJolli,
	PluginOutdatedError,
	parseJolliApiKey,
	pushToJolli,
} from "../services/JolliPushService.js";
import {
	handleCheckPrStatus,
	handleCreatePr,
	handlePrepareUpdatePr,
	handleUpdatePr,
	wrapWithMarkers,
} from "../services/PrCommentService.js";
import {
	deriveRepoNameFromUrl,
	getCanonicalRepoUrl,
} from "../util/GitRemoteUtils.js";
import { isWorkerBusy } from "../util/LockUtils.js";
import { log } from "../util/Logger.js";
import { loadGlobalConfig } from "../util/WorkspaceUtils.js";
import { BindingChooserWebviewPanel } from "./BindingChooserWebviewPanel.js";
import { loadBranchSummaries } from "./BranchSummaryLoader.js";
import { SOURCE_TITLES } from "./SourceLabels.js";
import { buildSummaryErrorBanner } from "./SummaryErrorBanner.js";
import {
	buildE2eTestSection,
	buildHtml,
	buildRecapSection,
	buildTopicsSection,
	renderE2eScenario,
	renderTopic,
} from "./SummaryHtmlBuilder.js";
import { buildMarkdown } from "./SummaryMarkdownBuilder.js";
import { buildAggregatedPrMarkdown } from "./SummaryPrAggregateMarkdownBuilder.js";
import { buildPrMarkdown } from "./SummaryPrMarkdownBuilder.js";
import {
	buildBranchRelativePath,
	buildNotePushTitle,
	buildPanelTitle,
	buildPlanPushTitle,
	buildPushTitle,
	collectSortedTopics,
	formatActiveProviderLabel,
} from "./SummaryUtils.js";
import type { RegenerateContext } from "../../../cli/src/core/RegenerateContext.js";
import { isSummaryError } from "../../../cli/src/core/SummaryErrorMarker.js";
import { getTranscriptIds } from "../../../cli/src/core/SummaryTree.js";
import type { LlmConfig } from "../../../cli/src/Types.js";

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
	| { command: "translatePlan"; slug: string }
	| { command: "loadAllTranscripts" }
	| {
			command: "saveAllTranscripts";
			entries: ReadonlyArray<TranscriptEntryUpdate>;
	  }
	| { command: "deleteAllTranscripts" }
	| { command: "editRecap"; recap: string }
	| { command: "generateRecap" }
	| { command: "regenerateSummary" }
	| { command: "openRewrittenCommit"; hash: string };

/** Entry data sent back from the webview on Save All. */
interface TranscriptEntryUpdate {
	readonly commitHash: string;
	readonly sessionId: string;
	readonly source?: string;
	readonly originalIndex: number;
	readonly role: "human" | "assistant";
	readonly content: string;
	readonly timestamp?: string;
}

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
	// mode. Transcripts (stats + Manage modal) and the rendered Markdown
	// previews for plans / notes are pure reads against the foreign repo's
	// FolderStorage — `loadPlanContent` / `loadNoteContent` (the inline
	// edit form's data loaders) are intentionally NOT here because edits
	// to a foreign-repo body are disabled in this mode and the edit
	// affordances are already CSS-hidden in `.foreign-readonly`.
	"loadTranscriptStats",
	"loadAllTranscripts",
	"previewPlan",
	"previewNote",
	// Reference previews / open-in-browser are read-only against the foreign
	// repo's storage. The destructive reference actions (loadReferenceContent /
	// saveReferenceEdit / removeReference / translateReference) are NOT here because
	// they write back to the orphan branch via `this.bridge` / `this.cwd`,
	// which is bound to the *current* workspace and would corrupt it.
	"previewReference",
	"openReferenceExternal",
]);

function isForeignSafeCommand(command: WebviewMessage["command"]): boolean {
	return FOREIGN_SAFE_COMMANDS.has(command);
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
	"loadAllTranscripts",
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


// Single source of truth for Create/Update PR body assembly. Branch-first
// three-tier selection:
//   • ≥2 branch summaries → aggregate them
//   • 1 branch summary    → use that one (NOT currentSummary, which may be
//                           stale or from another branch the webview was
//                           opened on)
//   • 0 branch summaries  → fall back to currentSummary (rebase just happened
//                           and the worker has not produced a summary for the
//                           new commit hash yet — keeps the form usable)
// `missingCount > 0` appends a "K skipped" footnote ONLY when summaries.length
// >= 1 — the footnote contextualizes "alongside the branch summaries shown, N
// more were skipped". On the 0-summary fallback the body comes from
// currentSummary (possibly stale or from another branch), so a current-branch
// "N skipped" note would describe commits unrelated to the body and read as
// noise.
function buildPrBodyMarkdown(
	currentSummary: CommitSummary,
	summaries: ReadonlyArray<CommitSummary>,
	missingCount: number,
): string {
	if (summaries.length >= 2) {
		return buildAggregatedPrMarkdown(summaries, missingCount);
	}
	const source = summaries.length === 1 ? summaries[0] : currentSummary;
	const base = buildPrMarkdown(source);
	if (missingCount <= 0 || summaries.length === 0) return base;
	return `${base}\n\n> Note: ${missingCount} commit(s) without summary were skipped.`;
}

/**
 * Picks the commit message to use as the PR title, mirroring
 * {@link buildPrBodyMarkdown}'s three-tier selection so title and body always
 * come from the same source.
 *   • ≥2 branch summaries → the last (most recent) one's message
 *   • 1 branch summary    → that summary's message
 *   • 0 branch summaries  → fall back to currentSummary's message
 */
function pickPrTitle(
	currentSummary: CommitSummary,
	summaries: ReadonlyArray<CommitSummary>,
): string {
	if (summaries.length >= 2) {
		return summaries[summaries.length - 1].commitMessage;
	}
	if (summaries.length === 1) {
		return summaries[0].commitMessage;
	}
	return currentSummary.commitMessage;
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
			source === "kb" ? vscode.ViewColumn.One : vscode.ViewColumn.Beside,
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

		// Handle messages from the webview
		this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
			this.dispatchWebviewMessage(message);
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
				handleCheckPrStatus(
					this.workspaceRoot,
					(msg) => this.panel.webview.postMessage(msg),
					this.currentSummary?.branch,
					this.foreignRepoName ? this.foreignRepoUrl : null,
				).catch((err: unknown) =>
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
						this.currentSummary?.branch,
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
						this.currentSummary?.branch,
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
			case "loadAllTranscripts":
				this.catchAndShow(
					this.handleLoadAllTranscripts(),
					"Load transcripts failed",
				);
				break;
			case "saveAllTranscripts":
				this.catchAndShow(
					this.handleSaveAllTranscripts(message.entries),
					"Save transcripts failed",
				);
				break;
			case "deleteAllTranscripts":
				this.catchAndShow(
					this.handleDeleteAllTranscripts(),
					"Delete transcripts failed",
				);
				break;
			case "openRewrittenCommit":
				this.catchAndShow(
					this.openRewrittenCommit(message.hash),
					"Open rewritten commit failed",
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
				// Passing ViewColumn.Beside can trigger a column-move (VSCode
				// recomputes "beside" against the active editor at call time),
				// which destroys and recreates the iframe and leaves it blank.
				// KB source: switch focus to the tab. Commit source: keep focus on sidebar.
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
		this.panel.webview.html = buildHtml(summary, {
			transcriptHashSet: this.transcriptHashSet,
			planTranslateSet: this.planTranslateSet,
			noteTranslateSet: this.noteTranslateSet,
			referenceTranslateSet: this.referenceTranslateSet,
			nonce,
			foreignRepoName: this.foreignRepoName,
			staleRewrittenInto: this.staleRewrittenInto ?? null,
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

		// Cross-branch guard: Create PR requires being checked out on the
		// summary's branch (because `git push -u origin HEAD` pushes the current
		// branch). Block before opening the form to avoid misleading the user.
		//
		// `bridge.getCurrentBranch()` returns the literal sentinel "HEAD" when
		// `git rev-parse --abbrev-ref HEAD` yields nothing — detached HEAD,
		// `.git/index.lock`, or permission failures. Telling the user to
		// "checkout <summary.branch>" in that state is wrong (the repo is in
		// a transient bad state, not on a different branch); they'd checkout
		// and only then discover the real problem. Use a distinct message.
		if (summary.branch) {
			const currentBranch = await this.bridge.getCurrentBranch();
			if (summary.branch !== currentBranch) {
				const message =
					currentBranch === "HEAD"
						? `Cannot determine the current branch (detached HEAD or git error). Resolve the repository state, then retry creating the PR for ${summary.branch}.`
						: `This summary is on branch ${summary.branch}. Checkout ${summary.branch} to create its PR.`;
				vscode.window.showWarningMessage(message);
				postMessage({
					command: "prCreateBlockedCrossBranch",
					summaryBranch: summary.branch,
					currentBranch,
				});
				return;
			}
		}

		const { summaries, missingCount } = await this.loadBranchSummariesForPr(
			summary.branch,
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

		const { summaries, missingCount } = await this.loadBranchSummariesForPr(
			summary.branch,
		);
		const markdown = buildPrBodyMarkdown(summary, summaries, missingCount);

		await handlePrepareUpdatePr(
			markdown,
			this.workspaceRoot,
			postMessage,
			summary.branch,
		);
	}

	// Returns true when worker is busy: shows the toast and re-runs the
	// status check so the click-time "Loading..." button gets rebuilt.
	private async handleWorkerBusyOrContinue(
		postMessage: (msg: Record<string, unknown>) => void,
	): Promise<boolean> {
		if (!(await isWorkerBusy(this.workspaceRoot))) {
			return false;
		}
		vscode.window.showWarningMessage(
			"Jolli Memory: AI summary is being generated. Please wait a moment.",
		);
		await handleCheckPrStatus(
			this.workspaceRoot,
			postMessage,
			this.currentSummary?.branch,
		);
		return true;
	}

	/**
	 * Loads summaries for PR body aggregation, scoped to the summary's branch.
	 *
	 * Memory Bank lets the user open any historical summary, including ones on
	 * branches they're not currently checked out on. In that cross-branch case
	 * aggregating `currentBranch`'s commits into a PR for `summaryBranch` is
	 * misleading — the body would describe commits unrelated to that PR. So we
	 * force the single-summary fallback by returning an empty array, and
	 * `buildPrBodyMarkdown` / `pickPrTitle` fall back to the clicked summary.
	 *
	 * When `summaryBranch === currentBranch` (or `summaryBranch` is undefined),
	 * we run the existing HEAD-based `loadBranchSummaries` to get the full
	 * branch-aggregation behavior.
	 */
	private async loadBranchSummariesForPr(
		summaryBranch: string | undefined,
	): Promise<{
		summaries: ReadonlyArray<CommitSummary>;
		missingCount: number;
	}> {
		if (summaryBranch) {
			const currentBranch = await this.bridge.getCurrentBranch();
			if (summaryBranch !== currentBranch) {
				return { summaries: [], missingCount: 0 };
			}
		}
		const result = await loadBranchSummaries(this.bridge, this.mainBranch);
		return {
			summaries: result.summaries,
			missingCount: result.missingCount,
		};
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
	 * Runs the Jolli Cloud push (plans, notes, summary, orphan cleanup).
	 * Returns the outcome so the caller can post the result message.
	 *
	 * On `412 binding_required` the plugin opens BindingChooserWebviewPanel for
	 * the user to pick or create a JM space, registers the binding server-side,
	 * and retries the push exactly once. The `retried` flag prevents infinite
	 * recursion if a second 412 fires after binding registration (which would
	 * indicate a server bug).
	 */
	private async runJolliPush(
		summary: CommitSummary,
		jolliApiKey: string | undefined,
		retried = false,
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

		try {
			// Step 1: Upload associated plans and notes
			const planUrls = await this.pushPlans(
				summary,
				resolvedBaseUrl,
				baseUrl,
				jolliApiKey,
				repoUrl,
			);
			const noteUrls = await this.pushNotes(
				summary,
				resolvedBaseUrl,
				baseUrl,
				jolliApiKey,
				repoUrl,
			);

			// Step 2: Update plan/note URLs in summary before building markdown
			// (so the Plans & Notes section in markdown includes the published URLs)
			const plansWithUrls = applyPlanUrls(summary.plans, planUrls);
			const notesWithUrls = summary.notes
				? applyNoteUrls(summary.notes, noteUrls)
				: summary.notes;
			const summaryForMarkdown: CommitSummary = {
				...summary,
				...(plansWithUrls !== summary.plans && { plans: plansWithUrls }),
				...(notesWithUrls !== summary.notes && { notes: notesWithUrls }),
			};
			const markdown = buildMarkdown(summaryForMarkdown);

			const title = buildPushTitle(summary);
			const result = await pushToJolli(resolvedBaseUrl, jolliApiKey, {
				title,
				content: markdown,
				commitHash: summary.commitHash,
				docType: "summary",
				branch: summary.branch,
				...(summary.jolliDocId && { docId: summary.jolliDocId }),
				repoUrl,
				relativePath: buildBranchRelativePath(summary.branch),
			});

			// Build the full article URL using docId query param (matches frontend routing)
			const fullUrl = `${baseUrl}/articles?doc=${result.docId}`;

			const updatedSummary: CommitSummary = {
				...summary,
				jolliDocUrl: fullUrl,
				jolliDocId: result.docId,
				...(planUrls.length > 0
					? { plans: applyPlanUrls(summary.plans, planUrls) }
					: {}),
				...(noteUrls.length > 0 && summary.notes
					? { notes: applyNoteUrls(summary.notes, noteUrls) }
					: {}),
			};
			await this.bridge.storeSummary(updatedSummary, true);

			// Update in-memory state and fully re-render the WebView so PR section picks up
			// the new plan/note URLs and jolliDocUrl in its markdown body
			this.currentSummary = updatedSummary;
			this.update(updatedSummary);
			const docUrl = summary.jolliDocUrl;
			const verb = docUrl ? "Updated" : "Pushed";
			const attachments = planUrls.length + noteUrls.length;
			const attachMsg =
				attachments > 0
					? ` (with ${attachments} attachment${attachments > 1 ? "s" : ""})`
					: "";
			vscode.window.showInformationMessage(
				`${verb} on Jolli Space${attachMsg}.`,
			);

			// Clean up orphaned memory articles, then persist which ones were actually deleted
			const cleanedSummary = await cleanupOrphanedDocs(
				summary,
				updatedSummary,
				baseUrl,
				jolliApiKey,
				this.bridge,
			);
			if (cleanedSummary) {
				this.currentSummary = cleanedSummary;
			}

			return { url: fullUrl, docId: result.docId };
		} catch (err: unknown) {
			if (err instanceof BindingRequiredError && !retried) {
				const outcome = await BindingChooserWebviewPanel.openAndAwait({
					extensionUri: this.extensionUri,
					baseUrl,
					apiKey: jolliApiKey,
					repoUrl,
					suggestedRepoName: deriveRepoNameFromUrl(repoUrl),
				});
				if (outcome.kind === "selected") {
					return this.runJolliPush(summary, jolliApiKey, true);
				}
				if (outcome.kind === "anotherOpen") {
					// Another summary panel for the same repo already opened the
					// chooser; that panel is the one driving the binding decision.
					// Tell this caller to wait there and re-push afterwards — using
					// "Push cancelled" here would be misleading (the user never
					// cancelled anything in this panel).
					vscode.window.showInformationMessage(
						"A Memory space chooser is already open for this repo. Finish there, then click the Jolli push button again.",
					);
				} else {
					vscode.window.showErrorMessage(
						"Push cancelled — no Memory space chosen for this repo. Click the Jolli push button again when you're ready.",
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

	/** Uploads associated plans to Jolli and returns their published URLs. */
	private async pushPlans(
		summary: CommitSummary,
		resolvedBaseUrl: string,
		baseUrl: string,
		apiKey: string,
		repoUrl: string,
	): Promise<
		Array<{ slug: string; title: string; url: string; docId: number }>
	> {
		const allPlans = summary.plans ?? [];
		log.info(
			"SummaryPanel",
			`Push to Jolli: found ${allPlans.length} plan(s) to upload`,
		);
		const results: Array<{
			slug: string;
			title: string;
			url: string;
			docId: number;
		}> = [];

		for (const plan of allPlans) {
			const planContent =
				(await readPlanFromBranch(plan.slug, this.workspaceRoot)) ?? "";
			if (!planContent) {
				log.info(
					"SummaryPanel",
					`Plan ${plan.slug}: no content found, skipping`,
				);
				continue;
			}
			log.info(
				"SummaryPanel",
				`Uploading plan ${plan.slug} (${planContent.length} chars)`,
			);

			const planResult = await pushToJolli(resolvedBaseUrl, apiKey, {
				title: buildPlanPushTitle(summary, plan.title),
				content: planContent,
				commitHash: summary.commitHash,
				docType: "plan",
				branch: summary.branch,
				...(plan.jolliPlanDocId && { docId: plan.jolliPlanDocId }),
				repoUrl,
				relativePath: buildBranchRelativePath(summary.branch),
			});
			const planUrl = `${baseUrl}/articles?doc=${planResult.docId}`;
			log.info(
				"SummaryPanel",
				`Plan ${plan.slug} uploaded: docId=${planResult.docId}, url=${planUrl}`,
			);
			results.push({
				slug: plan.slug,
				title: plan.title,
				url: planUrl,
				docId: planResult.docId,
			});
		}
		return results;
	}

	/** Uploads associated notes to Jolli and returns their published URLs. */
	private async pushNotes(
		summary: CommitSummary,
		resolvedBaseUrl: string,
		baseUrl: string,
		apiKey: string,
		repoUrl: string,
	): Promise<Array<{ id: string; title: string; url: string; docId: number }>> {
		const allNotes = summary.notes ?? [];
		log.info(
			"SummaryPanel",
			`Push to Jolli: found ${allNotes.length} note(s) to upload`,
		);
		const results: Array<{
			id: string;
			title: string;
			url: string;
			docId: number;
		}> = [];

		for (const note of allNotes) {
			// Schema-guard for legacy/corrupt entries — see mirrored logic in
			// buildSatellitesFromSummary. Snippets with missing `content` are warned
			// (and reported back to the webview via the skipped tally below).
			let noteContent: string;
			if (note.format === "snippet") {
				if (note.content === undefined || note.content === "") {
					log.warn(
						"SummaryPanel",
						`Snippet note ${note.id} has no content — skipping push`,
					);
					continue;
				}
				noteContent = note.content;
			} else {
				noteContent =
					(await readNoteFromBranch(note.id, this.workspaceRoot)) ?? "";
				if (!noteContent) {
					log.info(
						"SummaryPanel",
						`Note ${note.id}: no content found, skipping`,
					);
					continue;
				}
			}
			const noteResult = await pushToJolli(resolvedBaseUrl, apiKey, {
				title: buildNotePushTitle(summary, note.title),
				content: noteContent,
				commitHash: summary.commitHash,
				docType: "note",
				branch: summary.branch,
				...(note.jolliNoteDocId && { docId: note.jolliNoteDocId }),
				repoUrl,
				relativePath: buildBranchRelativePath(summary.branch),
			});
			const noteUrl = `${baseUrl}/articles?doc=${noteResult.docId}`;
			results.push({
				id: note.id,
				title: note.title,
				url: noteUrl,
				docId: noteResult.docId,
			});
		}
		return results;
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
		this.update(result.result);
		this.panel.webview.postMessage({ command: "topicDeleted", topicIndex });
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
	private async syncPlanTitle(slug: string, content: string): Promise<void> {
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
		this.update(updatedSummary);

		const registry = await loadPlansRegistry(this.workspaceRoot);
		const entry = registry.plans[slug];
		if (entry) {
			await savePlansRegistry(
				{
					...registry,
					plans: { ...registry.plans, [slug]: { ...entry, title: newTitle } },
				},
				this.workspaceRoot,
			);
		}
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

		this.update(updatedSummary);
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
		this.update(updatedSummary);
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
		this.update(updatedSummary);
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
		this.update(updatedSummary);
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
			this.update(updatedSummary);
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

		this.update(updatedSummary);
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

		const updatedReferences = (summary.references ?? []).filter(
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

		this.update(updatedSummary);
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
			this.update(this.currentSummary);
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
		await this.syncPlanTitle(slug, translated);

		// Remove from translate set immediately — user explicitly requested translation
		this.planTranslateSet.delete(slug);
		if (this.currentSummary) {
			this.update(this.currentSummary);
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
			this.update(this.currentSummary);
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

	/** Returns the set of integration source names that are currently enabled in config. */
	private async getEnabledSources(): Promise<Set<string>> {
		const config = await loadGlobalConfig();
		const sources = new Set<string>();
		if (config.claudeEnabled !== false) {
			sources.add("claude");
		}
		if (config.codexEnabled !== false) {
			sources.add("codex");
		}
		if (config.geminiEnabled !== false) {
			sources.add("gemini");
		}
		if (config.openCodeEnabled !== false) {
			sources.add("opencode");
		}
		if (config.cursorEnabled !== false) {
			sources.add("cursor");
		}
		if (config.copilotEnabled !== false) {
			sources.add("copilot");
			sources.add("copilot-chat");
		}
		return sources;
	}

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
		const enabledSources = await this.getEnabledSources();

		// Deduplicate sessions by source:sessionId (same session may appear in multiple commit transcripts)
		const seen = new Set<string>();
		let totalEntries = 0;
		const sessionCounts: Record<string, number> = {};
		for (const [, transcript] of transcriptMap) {
			for (const session of transcript.sessions) {
				const source = session.source ?? "claude";
				if (!enabledSources.has(source)) {
					continue;
				}
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

	/** Loads all transcripts for the current summary tree and sends them to the webview. */
	private async handleLoadAllTranscripts(): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}

		this.panel.webview.postMessage({ command: "transcriptsLoading" });

		const hashesWithTranscripts = [...this.transcriptHashSet];
		const transcriptMap = this.foreignStorage
			? await coreReadTranscriptsForCommits(
					hashesWithTranscripts,
					this.workspaceRoot,
					this.foreignStorage,
				)
			: await this.bridge.readTranscriptsForCommits(hashesWithTranscripts);
		const enabledSources = await this.getEnabledSources();

		// Build tagged entries: each entry carries its commit hash, session info, and original index
		const taggedEntries: Array<{
			commitHash: string;
			sessionId: string;
			source: string;
			transcriptPath: string;
			originalIndex: number;
			role: string;
			content: string;
			timestamp: string;
		}> = [];

		for (const [commitHash, transcript] of transcriptMap) {
			for (const session of transcript.sessions) {
				const source = session.source ?? "claude";
				if (!enabledSources.has(source)) {
					continue;
				}
				for (let i = 0; i < session.entries.length; i++) {
					const entry = session.entries[i];
					taggedEntries.push({
						commitHash,
						sessionId: session.sessionId,
						source: session.source ?? "claude",
						transcriptPath: session.transcriptPath ?? "",
						originalIndex: i,
						role: entry.role,
						content: entry.content,
						timestamp: entry.timestamp ?? "",
					});
				}
			}
		}

		this.panel.webview.postMessage({
			command: "allTranscriptsLoaded",
			entries: taggedEntries,
			totalCommits: hashesWithTranscripts.length,
		});
	}

	/** Saves edited transcripts back to the orphan branch, deleting empty ones. */
	private async handleSaveAllTranscripts(
		entries: ReadonlyArray<TranscriptEntryUpdate>,
	): Promise<void> {
		// Stale-commit guard: transcript writes are keyed by the panel's
		// `transcriptHashSet`, which reflects the stale tree after amend.
		// Letting these go through would mutate the orphaned commit's
		// `transcripts/<hash>.json` files instead of the new HEAD's — same
		// silent-mismatch class the summary handlers guard against.
		if (!(await this.ensureCommitNotRewritten("save transcripts"))) {
			return;
		}
		// Group entries by commitHash
		const byCommit = new Map<string, Array<TranscriptEntryUpdate>>();
		for (const entry of entries) {
			const list = byCommit.get(entry.commitHash);
			if (list) {
				list.push(entry);
			} else {
				byCommit.set(entry.commitHash, [entry]);
			}
		}

		// Re-read originals to preserve session metadata (e.g. transcriptPath) that is not round-tripped via the DOM
		const originalTranscriptMap = await this.bridge.readTranscriptsForCommits([...this.transcriptHashSet]);

		// Reconstruct StoredTranscript per commit, merging with original session metadata
		const writes: Array<{ hash: string; data: StoredTranscript }> = [];
		const deletes: Array<string> = [];

		// Determine which commits originally had transcripts but now have 0 entries (should delete)
		for (const commitHash of this.transcriptHashSet) {
			const commitEntries = byCommit.get(commitHash);
			if (!commitEntries || commitEntries.length === 0) {
				deletes.push(commitHash);
				continue;
			}

			const originalTranscript = originalTranscriptMap.get(commitHash);

			// Group entries by source:sessionId to rebuild sessions, restoring transcriptPath from originals
			const sessionMap = new Map<
				string,
				{
					sessionId: string;
					source: string;
					transcriptPath?: string;
					entries: Array<{
						role: "human" | "assistant";
						content: string;
						timestamp?: string;
					}>;
				}
			>();
			for (const e of commitEntries) {
				const key = `${e.source ?? "claude"}:${e.sessionId}`;
				let session = sessionMap.get(key);
				if (!session) {
					const originalSession = originalTranscript?.sessions.find(
						(s) => `${s.source ?? "claude"}:${s.sessionId}` === key,
					);
					session = {
						sessionId: e.sessionId,
						source: e.source ?? "claude",
						transcriptPath: originalSession?.transcriptPath,
						entries: [],
					};
					sessionMap.set(key, session);
				}
				session.entries.push({
					role: e.role,
					content: e.content,
					...(e.timestamp ? { timestamp: e.timestamp } : {}),
				});
			}

			const storedTranscript: StoredTranscript = {
				sessions: [...sessionMap.values()].map((s) => ({
					sessionId: s.sessionId,
					source: s.source as "claude" | "codex",
					...(s.transcriptPath !== undefined && {
						transcriptPath: s.transcriptPath,
					}),
					entries: s.entries,
				})),
			};
			writes.push({ hash: commitHash, data: storedTranscript });
		}

		// Summary-first ordering: if any deletes are in scope, persist the
		// updated `summary.transcripts` BEFORE touching transcript files.
		// Earlier code ran the file batch first, then the summary update; a
		// failure in the second step left the half-migrated state "files
		// gone but summary still references them", letting future
		// amend/squash/rebase inherit stale IDs. Now the worst case after a
		// summary-write failure is "no files touched yet" — clean abort.
		if (deletes.length > 0 && this.currentSummary) {
			try {
				this.currentSummary = await this.persistTranscriptIdRemoval(
					this.currentSummary,
					new Set(deletes),
				);
			} catch (err) {
				log.warn(
					"Save aborted — could not persist summary.transcripts: %s",
					err instanceof Error ? err.message : String(err),
				);
				this.panel.webview.postMessage({
					command: "transcriptsSaveFailed",
					message: "Could not update summary. Transcript files were NOT modified.",
				});
				return;
			}
		}

		if (writes.length > 0 || deletes.length > 0) {
			try {
				await this.bridge.saveTranscriptsBatch(writes, deletes);
			} catch (err) {
				// File batch failed AFTER summary already updated. Outcomes:
				//   - `writes` items: user's edits never reached disk →
				//     they'll see old content on next read; this is a real
				//     data-fidelity miss the user must know about.
				//   - `deletes` items: files still on disk but no longer
				//     referenced by summary (orphan); from the summary's view
				//     it's "deleted" but the bytes are still there.
				// We post Failed (not Saved) so the modal's save button can
				// reset out of its disabled "Saving..." state and the user
				// can retry. Better to over-alert than silently lose edits.
				log.warn(
					"Summary updated but transcript file batch failed: %s",
					err instanceof Error ? err.message : String(err),
				);
				// Deliberately do NOT `refreshTranscriptHashes` here. The summary
				// was already cleared of the deleted IDs above, so refreshing from
				// it would empty `transcriptHashSet` and erase the still-on-disk
				// files from the panel — leaving the user no way to retry the very
				// delete that just failed. Keeping the pre-operation set (which
				// still matches what's on disk, since the batch failed) keeps those
				// files visible and the retry path live. The Failed message unsticks
				// the modal buttons on its own.
				this.panel.webview.postMessage({
					command: "transcriptsSaveFailed",
					message: "Some transcript files failed to write. See logs.",
				});
				return;
			}
		}

		// Refresh cache and webview
		if (this.currentSummary) {
			await this.refreshTranscriptHashes(this.currentSummary);
			this.update(this.currentSummary);
		}

		this.panel.webview.postMessage({ command: "transcriptsSaved" });
	}

	/** Deletes all transcript files for the current summary tree (scoped by operation boundary). */
	private async handleDeleteAllTranscripts(): Promise<void> {
		// Stale-commit guard: same rationale as handleSaveAllTranscripts —
		// `transcriptHashSet` reflects the orphaned tree post-amend, and a
		// bulk delete against it would wipe transcripts the new HEAD still
		// references as descendants of its hoisted tree.
		if (!(await this.ensureCommitNotRewritten("delete transcripts"))) {
			return;
		}
		const hashes = [...this.transcriptHashSet];
		if (hashes.length === 0) {
			return;
		}

		// Summary-first: clear `summary.transcripts` BEFORE the file delete.
		// Earlier code deleted files first, then updated the summary; a
		// failure in the second step left the half-migrated state "files
		// gone but summary still references them", letting future
		// amend/squash/rebase inherit stale IDs.
		if (this.currentSummary) {
			try {
				this.currentSummary = await this.persistTranscriptIdRemoval(
					this.currentSummary,
					new Set(hashes),
				);
			} catch (err) {
				log.warn(
					"Delete aborted — could not persist summary.transcripts: %s",
					err instanceof Error ? err.message : String(err),
				);
				this.panel.webview.postMessage({
					command: "transcriptsDeleteFailed",
					message: "Could not update summary. Transcript files were NOT deleted.",
				});
				return;
			}
		}

		try {
			await this.bridge.saveTranscriptsBatch([], hashes);
		} catch (err) {
			// Summary already cleared but the orphan files weren't removed — the
			// bytes remain on the orphan branch and could resurface via direct
			// branch inspection or a future `git push`. For privacy-sensitive
			// "delete my AI conversations" use cases that is NOT what the user
			// asked for, so the delete MUST stay retryable.
			log.warn(
				"Summary cleared but transcript file delete failed: %s",
				err instanceof Error ? err.message : String(err),
			);
			// Deliberately do NOT `refreshTranscriptHashes` here. `currentSummary`
			// was cleared above, so refreshing from it would empty
			// `transcriptHashSet` and erase the still-on-disk files from the panel
			// — the user would see "delete failed" with an empty list and no way
			// to retry the orphaned bytes. Keeping the pre-delete set (which still
			// matches disk, since the delete failed) keeps those conversations
			// visible so a repeat "Delete all transcripts" re-attempts the file
			// removal (the already-cleared v5 summary makes that a summary no-op,
			// so only the file delete is retried). The Failed message unsticks the
			// modal buttons on its own.
			this.panel.webview.postMessage({
				command: "transcriptsDeleteFailed",
				message: "Some transcript files failed to delete. See logs.",
			});
			return;
		}

		// Refresh cache and webview
		if (this.currentSummary) {
			await this.refreshTranscriptHashes(this.currentSummary);
			this.update(this.currentSummary);
		}

		this.panel.webview.postMessage({ command: "transcriptsDeleted" });
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

/** Merges published plan URLs/docIds into plan references. */
function applyPlanUrls(
	plans: ReadonlyArray<PlanReference> | undefined,
	planUrls: ReadonlyArray<{ slug: string; url: string; docId: number }>,
): ReadonlyArray<PlanReference> | undefined {
	if (!plans || planUrls.length === 0) {
		return plans;
	}
	const urlMap = new Map(planUrls.map((p) => [p.slug, p]));
	return plans.map((p) => {
		const pushed = urlMap.get(p.slug);
		return pushed
			? { ...p, jolliPlanDocUrl: pushed.url, jolliPlanDocId: pushed.docId }
			: p;
	});
}

/** Merges published note URLs/docIds into note references. */
function applyNoteUrls(
	notes: ReadonlyArray<NoteReference>,
	noteUrls: ReadonlyArray<{ id: string; url: string; docId: number }>,
): ReadonlyArray<NoteReference> {
	const urlMap = new Map(noteUrls.map((n) => [n.id, n]));
	return notes.map((n) => {
		const pushed = urlMap.get(n.id);
		return pushed
			? { ...n, jolliNoteDocUrl: pushed.url, jolliNoteDocId: pushed.docId }
			: n;
	});
}

/**
 * Deletes orphaned memory articles from Jolli Space, then persists the result.
 * Only IDs that were successfully deleted are removed from orphanedDocIds;
 * IDs that failed to delete are kept so the next push retries them.
 */
async function cleanupOrphanedDocs(
	originalSummary: CommitSummary,
	updatedSummary: CommitSummary,
	baseUrl: string,
	apiKey: string,
	bridge: JolliMemoryBridge,
): Promise<CommitSummary | null> {
	const orphanedIds = originalSummary.orphanedDocIds
		? [...originalSummary.orphanedDocIds]
		: [];
	if (orphanedIds.length === 0) {
		return null;
	}

	const results = await Promise.allSettled(
		orphanedIds.map((id) =>
			deleteFromJolli(baseUrl, apiKey, id).then(() => id),
		),
	);

	const deleted = new Set<number>();
	for (const r of results) {
		if (r.status === "fulfilled") {
			deleted.add(r.value);
		}
	}

	const remaining = orphanedIds.filter((id) => !deleted.has(id));
	if (deleted.size > 0) {
		log.info("SummaryPanel", `Deleted ${deleted.size} orphaned article(s)`);
	}
	if (remaining.length > 0) {
		log.warn(
			"SummaryPanel",
			`Failed to delete ${remaining.length} orphaned article(s), will retry on next push`,
		);
	}

	// Persist: clear successfully deleted IDs, keep failed ones for retry
	const cleaned: CommitSummary = {
		...updatedSummary,
		...(remaining.length > 0
			? { orphanedDocIds: remaining }
			: { orphanedDocIds: undefined }),
	};
	await bridge.storeSummary(cleaned, true);
	return cleaned;
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
