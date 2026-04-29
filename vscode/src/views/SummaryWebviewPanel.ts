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

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as vscode from "vscode";
import type { SatelliteFile } from "../../../cli/src/core/LocalPusher.js";
import { pushSummaryToLocal as corePushSummaryToLocal } from "../../../cli/src/core/LocalPusher.js";
import {
	loadPlansRegistry,
	saveConfig,
	savePlansRegistry,
} from "../../../cli/src/core/SessionTracker.js";
import {
	generateE2eTest,
	generateRecap,
	translateToEnglish,
} from "../../../cli/src/core/Summarizer.js";
import {
	getTranscriptHashes,
	readNoteFromBranch,
	readPlanFromBranch,
	readTranscriptsForCommits,
	saveTranscriptsBatch,
	storeNotes,
	storePlans,
	storeSummary,
} from "../../../cli/src/core/SummaryStore.js";
import {
	deleteTopicInTree,
	updateTopicInTree,
} from "../../../cli/src/core/SummaryTree.js";
import type {
	CommitSummary,
	E2eTestScenario,
	NoteReference,
	PlanReference,
	StoredTranscript,
} from "../../../cli/src/Types.js";
import { version as pluginVersion } from "../../package.json";
import {
	archiveNoteForCommit,
	ignoreNote,
	saveNote,
	unassociateNoteFromCommit,
} from "../core/NoteService.js";
import {
	archivePlanForCommit,
	ignorePlan,
	listAvailablePlans,
	unassociatePlanFromCommit,
} from "../core/PlanService.js";
import {
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
import { log } from "../util/Logger.js";
import { loadGlobalConfig } from "../util/WorkspaceUtils.js";
import {
	buildE2eTestSection,
	buildHtml,
	buildRecapSection,
	renderE2eScenario,
	renderTopic,
} from "./SummaryHtmlBuilder.js";
import { buildMarkdown } from "./SummaryMarkdownBuilder.js";
import { buildPrMarkdown } from "./SummaryPrMarkdownBuilder.js";
import {
	buildNotePushTitle,
	buildPanelTitle,
	buildPlanPushTitle,
	buildPushTitle,
	collectSortedTopics,
} from "./SummaryUtils.js";

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
	| { command: "generateRecap" };

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
	/** Cached push action mode loaded from global config. */
	private pushAction: "jolli" | "both" = "jolli";
	/** Guards against concurrent push invocations (re-click during active push). */
	private pushInProgress = false;
	/**
	 * Set in `onDidDispose`. `show()` awaits I/O before calling `update()`; if
	 * a concurrent `show()` disposed this instance during those awaits, we must
	 * skip the webview write (panel.webview.html throws on a disposed panel).
	 */
	private disposed = false;

	private constructor(
		extensionUri: vscode.Uri,
		workspaceRoot: string,
		source: SummaryPanelSource,
		commitHash: string,
	) {
		this.workspaceRoot = workspaceRoot;
		this.source = source;
		this.commitHash = commitHash;
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
				void vscode.commands.executeCommand(
					"jollimemory.editPlan",
					message.slug,
					true,
					message.title,
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
				void vscode.commands.executeCommand(
					"jollimemory.previewNote",
					message.id,
					message.title,
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
			case "checkPrStatus":
				handleCheckPrStatus(
					this.workspaceRoot,
					(msg) => this.panel.webview.postMessage(msg),
					this.currentSummary?.branch,
					this.currentSummary?.commitHash,
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
						this.currentSummary?.commitHash,
					),
					"Create PR failed",
				);
				break;
			case "prepareCreatePr":
				if (this.currentSummary) {
					const body = wrapWithMarkers(buildPrMarkdown(this.currentSummary));
					const title = this.currentSummary.commitMessage;
					void this.panel.webview.postMessage({
						command: "prShowCreateForm",
						body,
						title,
					});
				}
				break;
			case "prepareUpdatePr":
				if (this.currentSummary) {
					this.catchAndShow(
						handlePrepareUpdatePr(
							this.currentSummary,
							this.workspaceRoot,
							(msg) => this.panel.webview.postMessage(msg),
							buildPrMarkdown,
						),
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
						this.currentSummary?.commitHash,
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
		source: SummaryPanelSource = "commit",
	): Promise<void> {
		const config = await loadGlobalConfig();
		const pushAction = config.pushAction ?? "jolli";

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
				// (summary + pushAction + 3 cache sets) to decide whether re-rendering
				// the webview HTML is necessary.
				const prevPushAction = existing.pushAction;
				const prevTranscriptHashSet = existing.transcriptHashSet;
				const prevPlanTranslateSet = existing.planTranslateSet;
				const prevNoteTranslateSet = existing.noteTranslateSet;
				existing.pushAction = pushAction;
				await existing.refreshTranscriptHashes(summary);
				await existing.refreshPlanTranslateSet(summary);
				await existing.refreshNoteTranslateSet(summary);
				const inputsChanged =
					!summariesEqual(existing.currentSummary, summary) ||
					prevPushAction !== pushAction ||
					!setsEqual(prevTranscriptHashSet, existing.transcriptHashSet) ||
					!setsEqual(prevPlanTranslateSet, existing.planTranslateSet) ||
					!setsEqual(prevNoteTranslateSet, existing.noteTranslateSet);
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
		);
		instance.pushAction = pushAction;
		if (source === "memory") {
			SummaryWebviewPanel.currentMemoryPanel = instance;
		} else {
			SummaryWebviewPanel.commitPanels.set(summary.commitHash, instance);
		}
		await instance.refreshTranscriptHashes(summary);
		await instance.refreshPlanTranslateSet(summary);
		await instance.refreshNoteTranslateSet(summary);
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
		this.panel.title = buildPanelTitle(summary);
		const nonce = randomBytes(16).toString("base64");
		this.panel.webview.html = buildHtml(summary, {
			transcriptHashSet: this.transcriptHashSet,
			planTranslateSet: this.planTranslateSet,
			noteTranslateSet: this.noteTranslateSet,
			nonce,
			pushAction: this.pushAction,
		});
	}

	/**
	 * Refreshes the cached `transcriptHashSet` by intersecting the summary tree's
	 * commit hashes with the transcript files that exist in the orphan branch.
	 */
	private async refreshTranscriptHashes(summary: CommitSummary): Promise<void> {
		try {
			const treeHashes = collectTreeHashes(summary);
			const allFileHashes = await getTranscriptHashes(this.workspaceRoot);
			this.transcriptHashSet = new Set(
				[...treeHashes].filter((h) => allFileHashes.has(h)),
			);
		} catch (err: unknown) {
			log.warn(
				"Failed to load transcript hashes: %s",
				err instanceof Error ? err.message : String(err),
			);
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
				const content = await readPlanFromBranch(plan.slug, this.workspaceRoot);
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
				const content = await readNoteFromBranch(note.id, this.workspaceRoot);
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

	/**
	 * Orchestrates push to Jolli Cloud and (optionally) to a local folder.
	 *
	 * - The Jolli push always runs.
	 * - When `pushAction === "both"`, a local push runs concurrently via
	 *   {@link runLocalPush}.
	 * - Uses `Promise.allSettled` so one side's failure doesn't block the other.
	 * - Posts independent result messages for each side.
	 */
	private async handlePush(): Promise<void> {
		// Prevent concurrent pushes: the button can be re-clicked when (1)
		// runJolliPush throws before posting pushStarted (button never disabled),
		// or (2) runJolliPush succeeds and calls this.update() which replaces the
		// webview HTML and re-enables the button while runLocalPush is still active.
		if (this.pushInProgress) {
			return;
		}
		this.pushInProgress = true;

		try {
			// The caller (dispatchWebviewMessage) already guards against null summary.
			// biome-ignore lint/style/noNonNullAssertion: dispatch guard ensures currentSummary is set
			const summary = this.currentSummary!;
			const config = await loadGlobalConfig();
			const pushAction = config.pushAction ?? "jolli";

			// Jolli side: always runs.
			const jolliPromise = this.runJolliPush(summary, config.jolliApiKey);

			// Local side: only when pushAction is "both".
			// Pass the captured summary to avoid a race with runJolliPush mutating this.currentSummary.
			let localPromise: Promise<{ filePath: string }> | undefined;
			if (pushAction === "both") {
				localPromise = this.runLocalPush(summary, config.localFolder);
			}

			const [jolliResult, localResult] = await Promise.allSettled([
				jolliPromise,
				localPromise ?? Promise.resolve(undefined),
			]);

			// Post Jolli result (always).
			this.panel.webview.postMessage(toJolliResultMessage(jolliResult));

			// Post Local result only when we attempted it.
			if (pushAction === "both") {
				this.panel.webview.postMessage(toLocalResultMessage(localResult));
			}
		} finally {
			this.pushInProgress = false;
		}
	}

	/**
	 * Runs the Jolli Cloud push (plans, notes, summary, orphan cleanup).
	 * Returns the outcome so the caller can post the result message.
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

		try {
			// Step 1: Upload associated plans and notes
			const planUrls = await this.pushPlans(
				summary,
				resolvedBaseUrl,
				baseUrl,
				jolliApiKey,
			);
			const noteUrls = await this.pushNotes(
				summary,
				resolvedBaseUrl,
				baseUrl,
				jolliApiKey,
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
				branch: summary.branch,
				...(summary.jolliDocId && { docId: summary.jolliDocId }),
				pluginVersion,
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
			await storeSummary(updatedSummary, this.workspaceRoot, true);

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
				this.workspaceRoot,
			);
			if (cleanedSummary) {
				this.currentSummary = cleanedSummary;
			}

			return { url: fullUrl, docId: result.docId };
		} catch (err: unknown) {
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

	/**
	 * Runs the local push: resolves the target folder (prompting with a picker
	 * if needed), then delegates to the core {@link corePushSummaryToLocal}.
	 *
	 * @returns The file path of the written summary file.
	 * @throws If no folder is selected or the push fails.
	 */
	private async runLocalPush(
		summary: CommitSummary,
		localFolder: string | undefined,
	): Promise<{ filePath: string }> {
		const folder = await this.resolveLocalFolder(localFolder);
		if (!folder) {
			throw new Error("No folder selected");
		}

		// Gather satellite plan/note content (mirrors JolliMemoryBridge.pushSummaryToLocal)
		const satellites = await this.gatherSatellites(summary);
		const summaryMarkdown = buildMarkdown(summary);

		const result = await corePushSummaryToLocal({
			folder,
			summary,
			summaryMarkdown,
			satellites,
			cwd: this.workspaceRoot,
		});
		return { filePath: result.summaryPath };
	}

	/**
	 * Resolves the local folder for push-to-local. If `localFolder` is set and
	 * exists on disk, returns it directly. Otherwise opens a folder picker and
	 * persists the user's choice via {@link saveConfig}.
	 *
	 * @returns The resolved folder path, or `undefined` if the user cancelled.
	 */
	private async resolveLocalFolder(
		localFolder: string | undefined,
	): Promise<string | undefined> {
		if (localFolder && existsSync(localFolder)) {
			return localFolder;
		}

		const picked = await vscode.window.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: "Select folder for Push to Local",
		});

		if (!picked || picked.length === 0) {
			return;
		}

		const chosenFolder = picked[0].fsPath;
		await saveConfig({ localFolder: chosenFolder });
		return chosenFolder;
	}

	/**
	 * Gathers plan and note satellite files for a summary, reading content from
	 * the orphan branch. Used by {@link runLocalPush} to build the satellite
	 * array expected by the core local pusher.
	 */
	private async gatherSatellites(
		summary: CommitSummary,
	): Promise<Array<SatelliteFile>> {
		const satellites: Array<SatelliteFile> = [];

		// Plans
		const planUrlBySlug = new Map(
			(summary.plans ?? []).map((p) => [p.slug, p.jolliPlanDocUrl]),
		);
		for (const plan of summary.plans ?? []) {
			const content = await readPlanFromBranch(plan.slug, this.workspaceRoot);
			if (!content) {
				continue;
			}
			satellites.push({
				slug: plan.slug,
				title: plan.title,
				content,
				jolliUrl: planUrlBySlug.get(plan.slug),
			});
		}

		// Notes
		const noteUrlById = new Map(
			(summary.notes ?? []).map((n) => [n.id, n.jolliNoteDocUrl]),
		);
		for (const note of summary.notes ?? []) {
			// Schema-guard for legacy/corrupt entries: snippet notes normally persist
			// `content`, but rows from before the snippet feature shipped may be missing
			// it. Log at warn level so the drift is visible instead of silently dropped.
			let content: string;
			if (note.format === "snippet") {
				/* v8 ignore start -- schema-guard mirror of runJolliPush's legacy-snippet handling (which IS tested); reached only via the local-push path (pushAction="both"), whose orchestration is out of scope for this file's unit tests. Follow-up: lift into a shared helper so one test covers both call sites. */
				if (note.content === undefined || note.content === "") {
					log.warn(
						"SummaryPanel",
						`Snippet note ${note.id} has no content — skipping`,
					);
					continue;
				}
				/* v8 ignore stop */
				content = note.content;
			} else {
				content = (await readNoteFromBranch(note.id, this.workspaceRoot)) ?? "";
				if (!content) {
					continue;
				}
			}
			satellites.push({
				slug: note.id,
				title: note.title,
				content,
				jolliUrl: noteUrlById.get(note.id),
			});
		}

		return satellites;
	}

	/** Uploads associated plans to Jolli and returns their published URLs. */
	private async pushPlans(
		summary: CommitSummary,
		resolvedBaseUrl: string,
		baseUrl: string,
		apiKey: string,
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
				branch: summary.branch,
				subFolder: "Plans & Notes",
				...(plan.jolliPlanDocId && { docId: plan.jolliPlanDocId }),
				pluginVersion,
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
				branch: summary.branch,
				subFolder: "Plans & Notes",
				...(note.jolliNoteDocId && { docId: note.jolliNoteDocId }),
				pluginVersion,
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

		const result = updateTopicInTree(summary, topicIndex, updates);
		if (!result) {
			throw new Error(`Memory index ${topicIndex} is out of range`);
		}

		await storeSummary(result.result, this.workspaceRoot, true);
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
		const trimmed = recap.trim();
		const updated: CommitSummary = trimmed
			? { ...summary, recap: trimmed }
			: { ...summary, recap: undefined };
		await storeSummary(updated, this.workspaceRoot, true);
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

		const updated: CommitSummary = { ...summary, recap: trimmed };
		await storeSummary(updated, this.workspaceRoot, true);
		this.currentSummary = updated;

		this.panel.webview.postMessage({
			command: "recapUpdated",
			html: buildRecapSection(updated.recap),
		});
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

		const result = deleteTopicInTree(summary, topicIndex);
		if (!result) {
			throw new Error(`Memory index ${topicIndex} is out of range`);
		}

		await storeSummary(result.result, this.workspaceRoot, true);
		this.update(result.result);
		this.panel.webview.postMessage({ command: "topicDeleted", topicIndex });
	}

	/** Generates E2E test scenarios from the current summary via AI. */
	private async handleGenerateE2eTest(): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
			return;
		}

		this.panel.webview.postMessage({ command: "e2eTestGenerating" });

		const { topics } = collectSortedTopics(summary);

		// Get diff for the commit (truncated to avoid huge prompts)
		let diff = "";
		try {
			diff = execSync(
				`git diff ${summary.commitHash}~1 ${summary.commitHash} -- . ":(exclude)*.lock"`,
				{
					cwd: this.workspaceRoot,
					encoding: "utf-8",
					maxBuffer: 512 * 1024,
				},
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

		const updatedSummary: CommitSummary = {
			...summary,
			e2eTestGuide: scenarios,
		};
		await storeSummary(updatedSummary, this.workspaceRoot, true);
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

		const updatedSummary: CommitSummary = {
			...summary,
			e2eTestGuide: scenarios,
		};
		await storeSummary(updatedSummary, this.workspaceRoot, true);
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
		await storeSummary(updatedSummary, this.workspaceRoot, true);
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

		const scenarioTitle = title ?? summary.e2eTestGuide[index].title;
		const choice = await vscode.window.showWarningMessage(
			`Delete scenario "${scenarioTitle}"?`,
			{ modal: true, detail: "This cannot be undone." },
			"Delete",
		);
		if (choice !== "Delete") {
			return;
		}

		const remaining = summary.e2eTestGuide.filter((_, i) => i !== index);
		const updatedSummary: CommitSummary = {
			...summary,
			e2eTestGuide: remaining.length > 0 ? remaining : undefined,
		};
		await storeSummary(updatedSummary, this.workspaceRoot, true);
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

		const updatedSummary: CommitSummary = {
			...summary,
			e2eTestGuide: undefined,
		};
		await storeSummary(updatedSummary, this.workspaceRoot, true);
		this.currentSummary = updatedSummary;

		const html = buildE2eTestSection(updatedSummary);
		this.panel.webview.postMessage({ command: "e2eTestUpdated", html });
	}

	// ── Plan handlers ────────────────────────────────────────────────────────

	private async handleLoadPlanContent(slug: string): Promise<void> {
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
		await storePlans(
			[{ slug, content }],
			`Edit plan ${slug}`,
			this.workspaceRoot,
		);
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
		await storeSummary(updatedSummary, this.workspaceRoot, true);
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

		const choice = await vscode.window.showWarningMessage(
			`Remove plan "${title}" from this commit?`,
			{
				modal: true,
				detail:
					"The plan will no longer be associated with this commit. The plan file itself is not deleted.",
			},
			"Remove",
		);
		if (choice !== "Remove") {
			return;
		}

		// Update CommitSummary: remove plan from plans array
		const updatedPlans = summary.plans.filter((p) => p.slug !== slug);
		const updatedSummary: CommitSummary = {
			...summary,
			plans: updatedPlans.length > 0 ? updatedPlans : undefined,
		};
		await storeSummary(updatedSummary, this.workspaceRoot, true);
		this.currentSummary = updatedSummary;

		// Clear commitHash in plans.json

		await unassociatePlanFromCommit(slug, this.workspaceRoot);
		// Mark as ignored so the plan doesn't reappear in the sidebar on next refresh
		// (unassociate only sets commitHash=null — the entry would still be visible)
		await ignorePlan(slug, this.workspaceRoot);

		this.update(updatedSummary);
	}

	private async handleAddPlan(): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
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

		const planRef = await archivePlanForCommit(
			selected.slug,
			summary.commitHash,
			this.workspaceRoot,
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
		await storeSummary(updatedSummary, this.workspaceRoot, true);
		this.currentSummary = updatedSummary;
		this.update(updatedSummary);
	}

	private async handleAddMarkdownNote(): Promise<void> {
		const summary = this.currentSummary;
		if (!summary) {
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

		const noteInfo = await saveNote(
			undefined,
			"",
			fileUri[0].fsPath,
			"markdown",
			this.workspaceRoot,
		);
		const noteRef = await archiveNoteForCommit(
			noteInfo.id,
			summary.commitHash,
			this.workspaceRoot,
		);
		if (!noteRef) {
			// Clean up the orphaned note entry so it doesn't linger in the sidebar
			await ignoreNote(noteInfo.id, this.workspaceRoot);
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
		await storeSummary(updatedSummary, this.workspaceRoot, true);
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

		const noteInfo = await saveNote(
			undefined,
			title,
			content,
			"snippet",
			this.workspaceRoot,
		);
		const noteRef = await archiveNoteForCommit(
			noteInfo.id,
			summary.commitHash,
			this.workspaceRoot,
		);
		if (!noteRef) {
			await ignoreNote(noteInfo.id, this.workspaceRoot);
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
		await storeSummary(updatedSummary, this.workspaceRoot, true);
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

		// Snippets carry their content inline; markdown notes read from orphan branch
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
		await storeNotes([{ id, content }], `Edit note ${id}`, this.workspaceRoot);

		// Sync title and (for snippets) inline content in the summary
		if (this.currentSummary?.notes) {
			const titleMatch = /^#\s+(.+)/m.exec(content);
			const newTitle = titleMatch?.[1]?.trim();
			const updatedNotes = this.currentSummary.notes.map((n) => {
				if (n.id !== id) {
					return n;
				}
				const updates: Partial<NoteReference> = {};
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
			await storeSummary(updatedSummary, this.workspaceRoot, true);
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

		const choice = await vscode.window.showWarningMessage(
			`Remove note "${title}" from this commit?`,
			{ modal: true },
			"Remove",
		);
		if (choice !== "Remove") {
			return;
		}

		const updatedNotes = summary.notes.filter((n) => n.id !== id);
		const updatedSummary: CommitSummary = {
			...summary,
			notes: updatedNotes.length > 0 ? updatedNotes : undefined,
		};
		await storeSummary(updatedSummary, this.workspaceRoot, true);
		this.currentSummary = updatedSummary;
		await unassociateNoteFromCommit(id, this.workspaceRoot);
		// Mark as ignored so the note doesn't reappear in the sidebar on next refresh
		// (unassociate only sets commitHash=null — the entry would still be visible)
		await ignoreNote(id, this.workspaceRoot);
		this.update(updatedSummary);
	}

	/** Translates a plan from its current language to English via LLM. */
	private async handleTranslatePlan(slug: string): Promise<void> {
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

		// Save translated content and sync title to summary + registry
		await storePlans(
			[{ slug, content: translated }],
			`Translate plan ${slug} to English`,
			this.workspaceRoot,
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

		// Save translated content to orphan branch
		await storeNotes(
			[{ id, content: translated }],
			`Translate note ${id} to English`,
			this.workspaceRoot,
		);

		// Sync title and (for snippets) inline content in the summary
		if (this.currentSummary?.notes) {
			const titleMatch = /^#\s+(.+)/m.exec(translated);
			const newTitle = titleMatch?.[1]?.trim();
			const updatedNotes = this.currentSummary.notes.map((n) => {
				if (n.id !== id) {
					return n;
				}
				const updates: Partial<NoteReference> = {};
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
			await storeSummary(updatedSummary, this.workspaceRoot, true);
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
		return sources;
	}

	/** Loads lightweight stats (session/entry counts by source) without sending full content. */
	private async handleLoadTranscriptStats(): Promise<void> {
		if (this.transcriptHashSet.size === 0) {
			return;
		}
		const transcriptMap = await readTranscriptsForCommits(
			[...this.transcriptHashSet],
			this.workspaceRoot,
		);
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
		const transcriptMap = await readTranscriptsForCommits(
			hashesWithTranscripts,
			this.workspaceRoot,
		);
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
		const originalTranscriptMap = await readTranscriptsForCommits(
			[...this.transcriptHashSet],
			this.workspaceRoot,
		);

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

		if (writes.length > 0 || deletes.length > 0) {
			await saveTranscriptsBatch(writes, deletes, this.workspaceRoot);
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
		const hashes = [...this.transcriptHashSet];
		if (hashes.length === 0) {
			return;
		}

		await saveTranscriptsBatch([], hashes, this.workspaceRoot);

		// Refresh cache and webview
		if (this.currentSummary) {
			await this.refreshTranscriptHashes(this.currentSummary);
			this.update(this.currentSummary);
		}

		this.panel.webview.postMessage({ command: "transcriptsDeleted" });
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

/** Recursively collects all commit hashes from a summary tree (root + all children). */
function collectTreeHashes(summary: CommitSummary): Set<string> {
	const hashes = new Set<string>();
	function walk(node: CommitSummary): void {
		hashes.add(node.commitHash);
		if (node.children) {
			for (const child of node.children) {
				walk(child);
			}
		}
	}
	walk(summary);
	return hashes;
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
	workspaceRoot: string,
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
	await storeSummary(cleaned, workspaceRoot, true);
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

/** Converts a settled local push result into the `pushToLocalResult` webview message. */
function toLocalResultMessage(
	result: PromiseSettledResult<{ filePath: string } | undefined>,
): Record<string, unknown> {
	if (result.status === "fulfilled" && result.value) {
		return {
			command: "pushToLocalResult",
			success: true,
			filePath: result.value.filePath,
		};
	}
	return {
		command: "pushToLocalResult",
		success: false,
		error: extractSettledError(result),
	};
}

/** Exposed for unit tests. */
export const __test__ = {
	summariesEqual,
	setsEqual,
};
