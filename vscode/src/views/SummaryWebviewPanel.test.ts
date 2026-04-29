import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
	info,
	warn,
	error: logError,
} = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

const {
	postMessage,
	onDidReceiveMessage,
	onDidDispose,
	reveal,
	showInformationMessage,
	showErrorMessage,
	showWarningMessage,
	showQuickPick,
	showOpenDialog,
	showSaveDialog,
	clipboardWriteText,
	fsWriteFile,
	openExternal,
	executeCommand,
	getConfiguration,
} = vi.hoisted(() => ({
	postMessage: vi.fn().mockResolvedValue(true),
	onDidReceiveMessage: vi.fn(),
	onDidDispose: vi.fn(),
	reveal: vi.fn(),
	showInformationMessage: vi.fn(),
	showErrorMessage: vi.fn(),
	showWarningMessage: vi.fn(),
	showQuickPick: vi.fn(),
	showOpenDialog: vi.fn(),
	showSaveDialog: vi.fn(),
	clipboardWriteText: vi.fn().mockResolvedValue(undefined),
	fsWriteFile: vi.fn().mockResolvedValue(undefined),
	openExternal: vi.fn(),
	executeCommand: vi.fn(),
	getConfiguration: vi.fn(() => ({ get: vi.fn() })),
}));

const { createWebviewPanel } = vi.hoisted(() => ({
	createWebviewPanel: vi.fn(() => ({
		webview: {
			postMessage,
			onDidReceiveMessage,
			asWebviewUri: vi.fn((uri: unknown) => uri),
			html: "",
		},
		onDidDispose,
		reveal,
		title: "",
		dispose: vi.fn(),
	})),
}));

vi.mock("vscode", () => ({
	window: {
		createWebviewPanel,
		showInformationMessage,
		showErrorMessage,
		showWarningMessage,
		showQuickPick,
		showOpenDialog,
		showSaveDialog,
	},
	env: {
		clipboard: { writeText: clipboardWriteText },
		openExternal,
	},
	Uri: {
		parse: vi.fn((s: string) => ({ toString: () => s })),
		file: vi.fn((s: string) => ({ fsPath: s, toString: () => s })),
		joinPath: vi.fn((...args: Array<unknown>) => ({
			toString: () => String(args.join("/")),
		})),
	},
	ViewColumn: { Beside: 2 },
	workspace: { getConfiguration, fs: { writeFile: fsWriteFile } },
	commands: { executeCommand },
}));

const {
	mockLoadConfig,
	mockLoadPlansRegistry,
	mockSavePlansRegistry,
	mockSaveConfig,
} = vi.hoisted(() => ({
	mockLoadConfig: vi
		.fn()
		.mockResolvedValue({ apiKey: "test-key", model: "test-model" }),
	mockLoadPlansRegistry: vi.fn().mockResolvedValue({ plans: {} }),
	mockSavePlansRegistry: vi.fn().mockResolvedValue(undefined),
	mockSaveConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadPlansRegistry: mockLoadPlansRegistry,
	savePlansRegistry: mockSavePlansRegistry,
	saveConfig: mockSaveConfig,
}));

vi.mock("../util/WorkspaceUtils.js", () => ({
	loadGlobalConfig: mockLoadConfig,
}));

const { mockGenerateE2eTest, mockTranslateToEnglish } = vi.hoisted(() => ({
	mockGenerateE2eTest: vi.fn().mockResolvedValue([]),
	mockTranslateToEnglish: vi
		.fn()
		.mockResolvedValue("# Translated Plan\n\nEnglish content"),
}));

vi.mock("../../../cli/src/core/Summarizer.js", () => ({
	generateE2eTest: mockGenerateE2eTest,
	translateToEnglish: mockTranslateToEnglish,
}));

const {
	mockGetTranscriptHashes,
	mockReadNoteFromBranch,
	mockReadPlanFromBranch,
	mockReadTranscriptsForCommits,
	mockSaveTranscriptsBatch,
	mockStoreNotes,
	mockStorePlans,
	mockStoreSummary,
} = vi.hoisted(() => ({
	mockGetTranscriptHashes: vi.fn().mockResolvedValue(new Set<string>()),
	mockReadNoteFromBranch: vi.fn().mockResolvedValue(null),
	mockReadPlanFromBranch: vi.fn().mockResolvedValue(null),
	mockReadTranscriptsForCommits: vi.fn().mockResolvedValue(new Map()),
	mockSaveTranscriptsBatch: vi.fn().mockResolvedValue(undefined),
	mockStoreNotes: vi.fn().mockResolvedValue(undefined),
	mockStorePlans: vi.fn().mockResolvedValue(undefined),
	mockStoreSummary: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../cli/src/core/SummaryStore.js", () => ({
	getTranscriptHashes: mockGetTranscriptHashes,
	readNoteFromBranch: mockReadNoteFromBranch,
	readPlanFromBranch: mockReadPlanFromBranch,
	readTranscriptsForCommits: mockReadTranscriptsForCommits,
	saveTranscriptsBatch: mockSaveTranscriptsBatch,
	storeNotes: mockStoreNotes,
	storePlans: mockStorePlans,
	storeSummary: mockStoreSummary,
}));

const { mockDeleteTopicInTree, mockUpdateTopicInTree } = vi.hoisted(() => ({
	mockDeleteTopicInTree: vi.fn(),
	mockUpdateTopicInTree: vi.fn(),
}));

vi.mock("../../../cli/src/core/SummaryTree.js", () => ({
	deleteTopicInTree: mockDeleteTopicInTree,
	updateTopicInTree: mockUpdateTopicInTree,
}));

const { mockCorePushSummaryToLocal } = vi.hoisted(() => ({
	mockCorePushSummaryToLocal: vi.fn().mockResolvedValue({
		summaryPath: "/local/abc12345-summary.md",
		satellitePaths: [],
		indexPath: "/local/index.md",
	}),
}));

vi.mock("../../../cli/src/core/LocalPusher.js", () => ({
	pushSummaryToLocal: mockCorePushSummaryToLocal,
}));

const { mockExistsSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("node:fs", () => ({
	existsSync: mockExistsSync,
}));

vi.mock("../../package.json", () => ({ version: "0.90.0" }));

const {
	mockListAvailablePlans,
	mockArchivePlanForCommit,
	mockUnassociatePlanFromCommit,
	mockIgnorePlan,
} = vi.hoisted(() => ({
	mockListAvailablePlans: vi.fn().mockReturnValue([]),
	mockArchivePlanForCommit: vi.fn().mockResolvedValue(null),
	mockUnassociatePlanFromCommit: vi.fn().mockResolvedValue(undefined),
	mockIgnorePlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/PlanService.js", () => ({
	listAvailablePlans: mockListAvailablePlans,
	archivePlanForCommit: mockArchivePlanForCommit,
	unassociatePlanFromCommit: mockUnassociatePlanFromCommit,
	ignorePlan: mockIgnorePlan,
}));

const {
	mockSaveNote,
	mockArchiveNoteForCommit,
	mockUnassociateNoteFromCommit,
	mockIgnoreNote,
} = vi.hoisted(() => ({
	mockSaveNote: vi.fn().mockResolvedValue({
		id: "note-1",
		title: "Test Snippet",
		format: "snippet",
	}),
	mockArchiveNoteForCommit: vi.fn().mockResolvedValue(null),
	mockUnassociateNoteFromCommit: vi.fn().mockResolvedValue(undefined),
	mockIgnoreNote: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/NoteService.js", () => ({
	saveNote: mockSaveNote,
	archiveNoteForCommit: mockArchiveNoteForCommit,
	unassociateNoteFromCommit: mockUnassociateNoteFromCommit,
	ignoreNote: mockIgnoreNote,
}));

const {
	mockPushToJolli,
	mockDeleteFromJolli,
	MockPluginOutdatedError,
	mockParseJolliApiKey,
} = vi.hoisted(() => {
	class MockPluginOutdatedError extends Error {
		constructor(msg = "outdated") {
			super(msg);
			this.name = "PluginOutdatedError";
		}
	}
	return {
		mockPushToJolli: vi.fn().mockResolvedValue({ docId: 42 }),
		mockDeleteFromJolli: vi.fn().mockResolvedValue(undefined),
		MockPluginOutdatedError,
		mockParseJolliApiKey: vi
			.fn()
			.mockReturnValue({ u: "https://example.jolli.app" }),
	};
});

vi.mock("../services/JolliPushService.js", () => ({
	pushToJolli: mockPushToJolli,
	deleteFromJolli: mockDeleteFromJolli,
	PluginOutdatedError: MockPluginOutdatedError,
	parseJolliApiKey: mockParseJolliApiKey,
}));

const {
	mockHandleCheckPrStatus,
	mockHandleCreatePr,
	mockHandlePrepareUpdatePr,
	mockHandleUpdatePr,
} = vi.hoisted(() => ({
	mockHandleCheckPrStatus: vi.fn().mockResolvedValue(undefined),
	mockHandleCreatePr: vi.fn().mockResolvedValue(undefined),
	mockHandlePrepareUpdatePr: vi.fn().mockResolvedValue(undefined),
	mockHandleUpdatePr: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/PrCommentService.js", () => ({
	handleCheckPrStatus: mockHandleCheckPrStatus,
	handleCreatePr: mockHandleCreatePr,
	handlePrepareUpdatePr: mockHandlePrepareUpdatePr,
	handleUpdatePr: mockHandleUpdatePr,
	wrapWithMarkers: (s: string) => `[MARKERS]${s}[/MARKERS]`,
}));

vi.mock("../util/Logger.js", () => ({
	log: { info, warn, error: logError },
}));

const {
	mockBuildHtml,
	mockBuildE2eTestSection,
	mockBuildRecapSection,
	mockRenderTopic,
	mockRenderE2eScenario,
} = vi.hoisted(() => ({
	mockBuildHtml: vi.fn().mockReturnValue("<html>mock</html>"),
	mockBuildE2eTestSection: vi.fn().mockReturnValue("<div>e2e</div>"),
	mockBuildRecapSection: vi.fn().mockReturnValue("<div>recap</div>"),
	mockRenderTopic: vi.fn().mockReturnValue("<div>topic</div>"),
	mockRenderE2eScenario: vi.fn().mockReturnValue("<div>scenario</div>"),
}));

vi.mock("./SummaryHtmlBuilder.js", () => ({
	buildHtml: mockBuildHtml,
	buildE2eTestSection: mockBuildE2eTestSection,
	buildRecapSection: mockBuildRecapSection,
	renderTopic: mockRenderTopic,
	renderE2eScenario: mockRenderE2eScenario,
}));

const { mockBuildMarkdown, mockBuildPrMarkdown } = vi.hoisted(() => ({
	mockBuildMarkdown: vi.fn().mockReturnValue("# Markdown Output"),
	mockBuildPrMarkdown: vi.fn().mockReturnValue("# PR Markdown"),
}));

vi.mock("./SummaryMarkdownBuilder.js", () => ({
	buildMarkdown: mockBuildMarkdown,
}));

vi.mock("./SummaryPrMarkdownBuilder.js", () => ({
	buildPrMarkdown: mockBuildPrMarkdown,
}));

const {
	mockBuildPanelTitle,
	mockBuildPushTitle,
	mockBuildPlanPushTitle,
	mockBuildNotePushTitle,
	mockCollectSortedTopics,
	mockCollectAllPlans,
} = vi.hoisted(() => ({
	mockBuildPanelTitle: vi.fn().mockReturnValue("Panel Title"),
	mockBuildPushTitle: vi.fn().mockReturnValue("Push Title"),
	mockBuildPlanPushTitle: vi.fn().mockReturnValue("Plan Push Title"),
	mockBuildNotePushTitle: vi.fn().mockReturnValue("Note Push Title"),
	mockCollectSortedTopics: vi
		.fn()
		.mockReturnValue({ topics: [], sourceNodes: [], showRecordDates: false }),
	mockCollectAllPlans: vi.fn().mockReturnValue([]),
}));

vi.mock("./SummaryUtils.js", () => ({
	buildPanelTitle: mockBuildPanelTitle,
	buildPushTitle: mockBuildPushTitle,
	buildPlanPushTitle: mockBuildPlanPushTitle,
	buildNotePushTitle: mockBuildNotePushTitle,
	collectSortedTopics: mockCollectSortedTopics,
	collectAllPlans: mockCollectAllPlans,
}));

const { mockExecSync } = vi.hoisted(() => ({
	mockExecSync: vi.fn().mockReturnValue("diff content"),
}));

vi.mock("node:child_process", () => ({
	execSync: mockExecSync,
}));

const { mockRandomBytes } = vi.hoisted(() => ({
	mockRandomBytes: vi
		.fn()
		.mockReturnValue({ toString: () => "mocknonce1234567=" }),
}));

vi.mock("node:crypto", () => ({
	randomBytes: mockRandomBytes,
}));

// ── Import under test ────────────────────────────────────────────────────────

import type { CommitSummary } from "../../../cli/src/Types.js";
import { SummaryWebviewPanel } from "./SummaryWebviewPanel.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSummary(overrides?: Partial<CommitSummary>): CommitSummary {
	return {
		version: 3,
		commitHash: "abc123",
		commitMessage: "feat: add feature",
		commitAuthor: "Test User",
		commitDate: "2025-01-15T10:00:00Z",
		branch: "feature/test",
		generatedAt: "2025-01-15T10:01:00Z",
		...overrides,
	};
}

const extensionUri = { fsPath: "/ext", toString: () => "/ext" } as never;
const workspaceRoot = "/workspace";

/**
 * Captures the onDidReceiveMessage callback registered by the panel constructor,
 * then returns a function that dispatches messages to it.
 */
function captureMessageHandler(): (msg: Record<string, unknown>) => void {
	const call =
		onDidReceiveMessage.mock.calls[onDidReceiveMessage.mock.calls.length - 1];
	return call[0] as (msg: Record<string, unknown>) => void;
}

/** Flushes pending promises to let async handlers resolve. */
function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Returns the sole commit-source panel instance from the per-hash map. Tests
 * that reach into private state (e.g. to null out `currentSummary`) use this
 * helper; they all open exactly one commit panel before calling it.
 */
function firstCommitPanel<T = { currentSummary: unknown }>(): T {
	const map = (
		SummaryWebviewPanel as unknown as { commitPanels: Map<string, T> }
	).commitPanels;
	const first = map.values().next().value;
	if (!first) {
		throw new Error("firstCommitPanel() called but no commit panel is open");
	}
	return first;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SummaryWebviewPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset the static slots by accessing the class internals:
		// the memory slot is a single field; commit panels live in a per-hash Map.
		(
			SummaryWebviewPanel as unknown as { currentMemoryPanel: undefined }
		).currentMemoryPanel = undefined;
		(
			SummaryWebviewPanel as unknown as { commitPanels: Map<string, unknown> }
		).commitPanels.clear();
		mockGetTranscriptHashes.mockResolvedValue(new Set<string>());
		mockReadPlanFromBranch.mockResolvedValue(null);
		mockLoadConfig.mockResolvedValue({
			apiKey: "test-key",
			model: "test-model",
		});
	});

	// ── show() ───────────────────────────────────────────────────────────────

	describe("show()", () => {
		it("creates a new webview panel when none exists (commit slot by default)", async () => {
			const summary = makeSummary();
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			expect(createWebviewPanel).toHaveBeenCalledWith(
				"jollimemory.summary.commit",
				"Commit Memory",
				2,
				expect.objectContaining({
					enableScripts: true,
					retainContextWhenHidden: true,
				}),
			);
		});

		it("uses a distinct viewType when opened in the memory slot", async () => {
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				"memory",
			);

			expect(createWebviewPanel).toHaveBeenCalledWith(
				"jollimemory.summary.memory",
				"Commit Memory",
				2,
				expect.objectContaining({
					enableScripts: true,
					retainContextWhenHidden: true,
				}),
			);
		});

		it("memory and commit slots are independent — opening one does not dispose the other", async () => {
			const summary1 = makeSummary({ commitHash: "aaa" });
			const summary2 = makeSummary({ commitHash: "bbb" });

			await SummaryWebviewPanel.show(
				summary1,
				extensionUri,
				workspaceRoot,
				"commit",
			);
			const commitPanelDispose =
				createWebviewPanel.mock.results[0].value.dispose;

			await SummaryWebviewPanel.show(
				summary2,
				extensionUri,
				workspaceRoot,
				"memory",
			);

			expect(createWebviewPanel).toHaveBeenCalledTimes(2);
			expect(commitPanelDispose).not.toHaveBeenCalled();
		});

		it("sets panel title from buildPanelTitle", async () => {
			mockBuildPanelTitle.mockReturnValue("Custom Title");
			const summary = makeSummary();
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			const panel = createWebviewPanel.mock.results[0].value;
			expect(panel.title).toBe("Custom Title");
		});

		it("sets HTML content from buildHtml", async () => {
			mockBuildHtml.mockReturnValue("<html>test content</html>");
			const summary = makeSummary();
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			const panel = createWebviewPanel.mock.results[0].value;
			expect(panel.webview.html).toBe("<html>test content</html>");
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: expect.any(Set),
					nonce: "mocknonce1234567=",
					pushAction: "jolli",
				}),
			);
		});

		it("dispose handler removes the commit panel from the per-hash map", async () => {
			const summary = makeSummary();
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			expect(onDidDispose).toHaveBeenCalled();
			const disposeCallback = onDidDispose.mock.calls[0][0] as () => void;
			disposeCallback();

			// After dispose, a new call to show() for the same commit should
			// create a new panel (instead of revealing the now-disposed one).
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
			expect(createWebviewPanel).toHaveBeenCalledTimes(2);
		});

		it("commit slot: opens a distinct panel per commit hash without disposing the previous", async () => {
			const summary1 = makeSummary({ commitHash: "aaa" });
			const summary2 = makeSummary({ commitHash: "bbb" });

			await SummaryWebviewPanel.show(summary1, extensionUri, workspaceRoot);
			const firstPanelDispose =
				createWebviewPanel.mock.results[0].value.dispose;
			await SummaryWebviewPanel.show(summary2, extensionUri, workspaceRoot);

			expect(createWebviewPanel).toHaveBeenCalledTimes(2);
			expect(firstPanelDispose).not.toHaveBeenCalled();
		});

		it("commit slot: reveals the existing panel when the same commit is shown again", async () => {
			const summary = makeSummary({ commitHash: "aaa" });

			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
			reveal.mockClear();
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			expect(createWebviewPanel).toHaveBeenCalledTimes(1);
			// reveal() with undefined viewColumn keeps the panel in its current column
			// (passing ViewColumn.Beside would risk a column-move that blanks the iframe).
			expect(reveal).toHaveBeenCalledWith(undefined, true);
		});

		it("commit slot: skips webview re-render when summary + config + orphan state all unchanged", async () => {
			const summary = makeSummary({ commitHash: "aaa" });

			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
			mockGetTranscriptHashes.mockClear();
			mockBuildHtml.mockClear();

			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			// Refreshes always run (they're cheap reads that cover orphan-branch
			// state which can change without a summary JSON change). But when all
			// render inputs are identical we skip buildHtml — preserving scroll
			// and in-webview state via retainContextWhenHidden.
			expect(mockGetTranscriptHashes).toHaveBeenCalled();
			expect(mockBuildHtml).not.toHaveBeenCalled();
			expect(reveal).toHaveBeenCalled();
		});

		it("commit slot: re-renders when pushAction config changed between clicks", async () => {
			const summary = makeSummary({ commitHash: "aaa" });

			mockLoadConfig.mockResolvedValueOnce({
				apiKey: "k",
				model: "m",
				pushAction: "jolli",
			});
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
			mockBuildHtml.mockClear();

			mockLoadConfig.mockResolvedValueOnce({
				apiKey: "k",
				model: "m",
				pushAction: "both",
			});
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({ pushAction: "both" }),
			);
		});

		it("commit slot: re-renders when orphan-branch transcript hashes changed between clicks", async () => {
			const summary = makeSummary({ commitHash: "aaa" });

			mockGetTranscriptHashes.mockResolvedValueOnce(new Set<string>());
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
			mockBuildHtml.mockClear();

			// Background session added a transcript for this commit — summary JSON
			// is identical, but the orphan-branch state changed.
			mockGetTranscriptHashes.mockResolvedValueOnce(new Set(["aaa"]));
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({ transcriptHashSet: new Set(["aaa"]) }),
			);
		});

		it("commit slot: re-renders the existing panel when the summary content changes", async () => {
			const summary1 = makeSummary({ commitHash: "aaa", commitMessage: "v1" });
			const summary2 = makeSummary({ commitHash: "aaa", commitMessage: "v2" });

			await SummaryWebviewPanel.show(summary1, extensionUri, workspaceRoot);
			mockGetTranscriptHashes.mockClear();
			mockBuildHtml.mockClear();

			await SummaryWebviewPanel.show(summary2, extensionUri, workspaceRoot);

			// Content differs → refresh + update runs on the existing panel.
			expect(createWebviewPanel).toHaveBeenCalledTimes(1);
			expect(mockGetTranscriptHashes).toHaveBeenCalled();
			expect(mockBuildHtml).toHaveBeenCalled();
		});

		it("memory slot: disposes the previous panel and creates a new one on each show", async () => {
			const summary1 = makeSummary({ commitHash: "aaa" });
			const summary2 = makeSummary({ commitHash: "bbb" });

			await SummaryWebviewPanel.show(
				summary1,
				extensionUri,
				workspaceRoot,
				"memory",
			);
			const firstPanelDispose =
				createWebviewPanel.mock.results[0].value.dispose;
			await SummaryWebviewPanel.show(
				summary2,
				extensionUri,
				workspaceRoot,
				"memory",
			);

			// Memory slot behaves like navigation: each new memory replaces the
			// current panel, so show() always disposes and recreates.
			expect(createWebviewPanel).toHaveBeenCalledTimes(2);
			expect(firstPanelDispose).toHaveBeenCalledTimes(1);
		});

		it("renders the new summary's HTML in the newly created panel", async () => {
			const summary1 = makeSummary({ commitHash: "aaa" });
			const summary2 = makeSummary({ commitHash: "bbb" });
			mockBuildHtml
				.mockReturnValueOnce("<html>first</html>")
				.mockReturnValueOnce("<html>second</html>");

			await SummaryWebviewPanel.show(summary1, extensionUri, workspaceRoot);
			await SummaryWebviewPanel.show(summary2, extensionUri, workspaceRoot);

			const secondPanel = createWebviewPanel.mock.results[1].value;
			expect(secondPanel.webview.html).toBe("<html>second</html>");
		});

		it("update() on a disposed instance is a no-op (race: concurrent show disposed it mid-refresh)", async () => {
			const summary = makeSummary({ commitHash: "aaa" });
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				"memory",
			);

			// Simulate a concurrent show() having disposed this instance while
			// the first show() was still awaiting its refresh pipeline.
			const instance = (
				SummaryWebviewPanel as unknown as {
					currentMemoryPanel: { disposed: boolean };
				}
			).currentMemoryPanel;
			instance.disposed = true;

			const firstPanel = createWebviewPanel.mock.results[0].value;
			firstPanel.webview.html = "<sentinel>";

			// Call update() via the dispatch — use any message that triggers an update,
			// or call it directly through the prototype since it's private.
			type UpdateCallable = { update: (s: unknown) => void };
			(instance as unknown as UpdateCallable).update(summary);

			// webview.html must not have been overwritten — update() short-circuited.
			expect(firstPanel.webview.html).toBe("<sentinel>");
		});

		it("collects transcript hashes from nested children via collectTreeHashes", async () => {
			const childHash = "child111";
			const grandchildHash = "grandchild222";
			mockGetTranscriptHashes.mockResolvedValue(
				new Set(["abc123", childHash, grandchildHash]),
			);
			const summary = makeSummary({
				commitHash: "abc123",
				children: [
					makeSummary({
						commitHash: childHash,
						children: [makeSummary({ commitHash: grandchildHash })],
					}),
				],
			});
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			// buildHtml should receive all 3 hashes (root + child + grandchild) intersected with file hashes
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: new Set(["abc123", childHash, grandchildHash]),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: expect.any(Set),
					nonce: "mocknonce1234567=",
					pushAction: "jolli",
				}),
			);
		});

		it("populates transcriptHashSet from orphan branch", async () => {
			mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123", "def456"]));
			const summary = makeSummary({ commitHash: "abc123" });
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			// buildHtml should receive the intersection of tree hashes and file hashes
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: new Set(["abc123"]),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: expect.any(Set),
					nonce: "mocknonce1234567=",
					pushAction: "jolli",
				}),
			);
		});

		it("populates planTranslateSet for CJK plan titles", async () => {
			const summary = makeSummary({
				plans: [
					{
						slug: "plan-1",
						title: "中文计划",
						editCount: 0,
						addedAt: "",
						updatedAt: "",
					},
					{
						slug: "plan-2",
						title: "English Plan",
						editCount: 0,
						addedAt: "",
						updatedAt: "",
					},
				],
			});
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			// plan-1 has CJK title, plan-2 does not and readPlanFromBranch returns null
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: new Set(["plan-1"]),
					noteTranslateSet: expect.any(Set),
					nonce: "mocknonce1234567=",
					pushAction: "jolli",
				}),
			);
		});

		it("populates planTranslateSet for CJK plan body content", async () => {
			mockReadPlanFromBranch.mockResolvedValue("# Plan\n\n这是计划内容");
			const summary = makeSummary({
				plans: [
					{
						slug: "plan-ascii",
						title: "ASCII Title",
						editCount: 0,
						addedAt: "",
						updatedAt: "",
					},
				],
			});
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: new Set(["plan-ascii"]),
					noteTranslateSet: expect.any(Set),
					nonce: "mocknonce1234567=",
					pushAction: "jolli",
				}),
			);
		});

		it("populates noteTranslateSet for CJK note titles", async () => {
			const summary = makeSummary({
				notes: [
					{
						id: "cn-note",
						title: "中文笔记",
						format: "markdown" as const,
						addedAt: "",
						updatedAt: "",
					},
					{
						id: "en-note",
						title: "English Note",
						format: "markdown" as const,
						addedAt: "",
						updatedAt: "",
					},
				],
			});
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			// cn-note has CJK title, en-note does not
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: new Set(["cn-note"]),
					nonce: "mocknonce1234567=",
					pushAction: "jolli",
				}),
			);
		});

		it("populates noteTranslateSet for CJK snippet content", async () => {
			const summary = makeSummary({
				notes: [
					{
						id: "cn-snippet",
						title: "English Title",
						format: "snippet" as const,
						content: "中文内容",
						addedAt: "",
						updatedAt: "",
					},
				],
			});
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: new Set(["cn-snippet"]),
					nonce: "mocknonce1234567=",
					pushAction: "jolli",
				}),
			);
		});

		it("populates noteTranslateSet for CJK markdown body content", async () => {
			mockReadNoteFromBranch.mockResolvedValue("# Note\n\n这是笔记内容");
			const summary = makeSummary({
				notes: [
					{
						id: "md-cn",
						title: "ASCII Title",
						format: "markdown" as const,
						addedAt: "",
						updatedAt: "",
					},
				],
			});
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: new Set(["md-cn"]),
					nonce: "mocknonce1234567=",
					pushAction: "jolli",
				}),
			);
		});

		it("skips note when readNoteFromBranch throws during translate set refresh", async () => {
			mockReadNoteFromBranch.mockRejectedValue(new Error("orphan read failed"));
			const summary = makeSummary({
				notes: [
					{
						id: "fail-note",
						title: "ASCII Title",
						format: "markdown" as const,
						addedAt: "",
						updatedAt: "",
					},
				],
			});
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

			// noteTranslateSet should be empty since read failed
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: new Set(),
					nonce: "mocknonce1234567=",
					pushAction: "jolli",
				}),
			);
		});
	});

	// ── Message handlers ─────────────────────────────────────────────────────

	describe("message handlers", () => {
		/** Creates a panel with a summary and returns the message dispatch function. */
		async function setupPanel(
			overrides?: Partial<CommitSummary>,
		): Promise<(msg: Record<string, unknown>) => void> {
			const summary = makeSummary(overrides);
			await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
			return captureMessageHandler();
		}

		// ── copyMarkdown ─────────────────────────────────────────────────────

		describe("copyMarkdown", () => {
			it("writes markdown to clipboard and shows info message", async () => {
				mockBuildMarkdown.mockReturnValue("# My Markdown");
				clipboardWriteText.mockResolvedValue(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "copyMarkdown" });
				await flushPromises();

				expect(mockBuildMarkdown).toHaveBeenCalled();
				expect(clipboardWriteText).toHaveBeenCalledWith("# My Markdown");
				expect(showInformationMessage).toHaveBeenCalledWith(
					"Copied as Markdown.",
				);
			});
		});

		// ── downloadMarkdown ─────────────────────────────────────────────────

		describe("downloadMarkdown", () => {
			it("saves markdown file to user-chosen location", async () => {
				mockBuildMarkdown.mockReturnValue("# Downloaded Markdown");
				showSaveDialog.mockResolvedValue({ fsPath: "/output/summary.md" });
				const dispatch = await setupPanel();

				dispatch({ command: "downloadMarkdown" });
				await flushPromises();

				expect(showSaveDialog).toHaveBeenCalledWith(
					expect.objectContaining({ filters: { Markdown: ["md"] } }),
				);
				expect(fsWriteFile).toHaveBeenCalled();
				expect(showInformationMessage).toHaveBeenCalledWith(
					"Saved to /output/summary.md",
				);
			});

			it("does nothing when user cancels save dialog", async () => {
				showSaveDialog.mockResolvedValue(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "downloadMarkdown" });
				await flushPromises();

				expect(fsWriteFile).not.toHaveBeenCalled();
			});

			it("does nothing when currentSummary is null", async () => {
				const dispatch = await setupPanel();
				const panel = firstCommitPanel<{ currentSummary: null }>();
				panel.currentSummary = null;
				vi.clearAllMocks();

				dispatch({ command: "downloadMarkdown" });
				await flushPromises();

				expect(showSaveDialog).not.toHaveBeenCalled();
			});
		});

		// ── pushToJolli ──────────────────────────────────────────────────────

		describe("pushToJolli", () => {
			it("pushes summary and shows success message", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockResolvedValue({ docId: 99 });
				const dispatch = await setupPanel();

				dispatch({ command: "push" });
				await flushPromises();

				expect(mockPushToJolli).toHaveBeenCalled();
				expect(mockStoreSummary).toHaveBeenCalled();
				expect(showInformationMessage).toHaveBeenCalledWith(
					"Pushed on Jolli Space.",
				);
			});

			it("shows warning when no API key configured", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: undefined,
				});
				const dispatch = await setupPanel();

				dispatch({ command: "push" });
				await flushPromises();

				expect(showWarningMessage).toHaveBeenCalledWith(
					"Please configure your Jolli API Key first (STATUS panel → ...).",
				);
				expect(mockPushToJolli).not.toHaveBeenCalled();
			});

			it("warns and skips snippet notes missing content (schema-drift guard)", async () => {
				// Legacy/corrupt entry: snippet without `content` must not silently drop —
				// it should log.warn and skip the push, while other valid notes still go through.
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockResolvedValue({ docId: 42 });
				warn.mockClear();

				const dispatch = await setupPanel({
					notes: [
						{
							id: "broken-snip",
							title: "Legacy Broken Snippet",
							format: "snippet" as const,
							// content intentionally missing — legacy data
							addedAt: "",
							updatedAt: "",
						},
						{
							id: "ok-snip",
							title: "Healthy Snippet",
							format: "snippet" as const,
							content: "valid body",
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "push" });
				await flushPromises();

				expect(warn).toHaveBeenCalledWith(
					"SummaryPanel",
					expect.stringContaining("broken-snip"),
				);
				// mockPushToJolli is called for: summary + ok-snip (the broken one is skipped).
				// Exactly assert it was invoked with the healthy note content.
				const noteCall = mockPushToJolli.mock.calls.find(
					(c) => c[2]?.content === "valid body",
				);
				expect(noteCall).toBeDefined();
				const brokenCall = mockPushToJolli.mock.calls.find(
					(c) => c[2]?.content === "",
				);
				expect(brokenCall).toBeUndefined();
			});

			it("pushes notes with an existing jolliNoteDocId using docId, new notes without", async () => {
				// Exercises both branches of `...(note.jolliNoteDocId && { docId })` — previously
				// guarded by a v8-ignore; now tested directly so coverage reflects real behavior.
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockResolvedValue({ docId: 42 });

				const dispatch = await setupPanel({
					notes: [
						{
							id: "new-note",
							title: "New",
							format: "snippet" as const,
							content: "new content",
							addedAt: "",
							updatedAt: "",
							// no jolliNoteDocId → falsy branch of `&&`
						},
						{
							id: "existing-note",
							title: "Existing",
							format: "snippet" as const,
							content: "existing content",
							addedAt: "",
							updatedAt: "",
							jolliNoteDocId: 77, // truthy branch of `&&`
						},
					],
				});

				dispatch({ command: "push" });
				await flushPromises();

				const newNoteCall = mockPushToJolli.mock.calls.find(
					(c) => c[2]?.content === "new content",
				);
				const existingNoteCall = mockPushToJolli.mock.calls.find(
					(c) => c[2]?.content === "existing content",
				);
				expect(newNoteCall?.[2]).not.toHaveProperty("docId");
				expect(existingNoteCall?.[2]).toMatchObject({ docId: 77 });
			});

			it("shows warning when base URL cannot be parsed from API key", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "bad_key",
				});
				mockParseJolliApiKey.mockReturnValue(null);
				const dispatch = await setupPanel();

				dispatch({ command: "push" });
				await flushPromises();

				expect(showWarningMessage).toHaveBeenCalledWith(
					"Jolli site URL could not be determined. Please regenerate your Jolli API Key and set it again (STATUS panel → ...).",
				);
			});

			it("shows specific error for PluginOutdatedError", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockRejectedValue(new MockPluginOutdatedError());
				const dispatch = await setupPanel();

				dispatch({ command: "push" });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					"Push failed — your Jolli Memory plugin is outdated. Please update to the latest version.",
					{ modal: true },
				);
			});

			it("shows generic error on push failure", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockRejectedValue(new Error("network error"));
				const dispatch = await setupPanel();

				dispatch({ command: "push" });
				await flushPromises();

				// runJolliPush shows the error, then re-throws which catchAndShow catches
				expect(showErrorMessage).toHaveBeenCalledWith(
					"Push failed: network error",
				);
				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Push failed"),
				);
			});

			it("uploads associated plans during push", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockReadPlanFromBranch.mockResolvedValue("# Plan Content\n\nPlan body");
				mockPushToJolli.mockResolvedValue({ docId: 50 });
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "plan-abc",
							title: "Test Plan",
							editCount: 1,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "push" });
				await flushPromises();

				// Two pushToJolli calls: one for plan, one for summary
				expect(mockPushToJolli).toHaveBeenCalledTimes(2);
			});

			it("updates plan URLs in summary when some plans are pushed and some are not", async () => {
				// Exercises line 389: planUrls.length > 0 && plansWithUrls
				// And line 393: pushed ? { ...p, ...urls } : p (falsy path for plan-empty)
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				// Plan A has content, Plan B has no content (returns null, then "")
				mockReadPlanFromBranch
					.mockResolvedValueOnce(null) // for show() planTranslateSet check
					.mockResolvedValueOnce(null) // for show() planTranslateSet check
					.mockResolvedValueOnce("# Plan A content") // for push
					.mockResolvedValueOnce(null); // Plan B → skipped
				mockPushToJolli.mockResolvedValue({ docId: 77 });
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "plan-a",
							title: "Plan A",
							editCount: 1,
							addedAt: "",
							updatedAt: "",
						},
						{
							slug: "plan-empty",
							title: "Plan Empty",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "push" });
				await flushPromises();

				// buildMarkdown should be called with summary that has updated plan URLs
				expect(mockBuildMarkdown).toHaveBeenCalled();
				expect(mockStoreSummary).toHaveBeenCalled();
			});

			it("cleans up orphaned articles after push and stores cleaned summary", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockResolvedValue({ docId: 42 });
				mockDeleteFromJolli.mockResolvedValue(undefined);
				const dispatch = await setupPanel({ orphanedDocIds: [10, 20] });

				dispatch({ command: "push" });
				await flushPromises();

				// deleteFromJolli should be called for each orphaned ID
				expect(mockDeleteFromJolli).toHaveBeenCalledWith(
					"https://my.jolli.app",
					"jk_valid",
					10,
				);
				expect(mockDeleteFromJolli).toHaveBeenCalledWith(
					"https://my.jolli.app",
					"jk_valid",
					20,
				);
				// storeSummary called twice: once for the push, once for orphan cleanup
				expect(mockStoreSummary).toHaveBeenCalledTimes(2);
				// The cleanup call should have orphanedDocIds cleared (undefined)
				expect(mockStoreSummary).toHaveBeenLastCalledWith(
					expect.objectContaining({ orphanedDocIds: undefined }),
					workspaceRoot,
					true,
				);
			});

			it("keeps remaining orphaned IDs when some deletes fail", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockResolvedValue({ docId: 42 });
				// First delete succeeds, second fails
				mockDeleteFromJolli
					.mockResolvedValueOnce(undefined)
					.mockRejectedValueOnce(new Error("delete failed"));
				const dispatch = await setupPanel({ orphanedDocIds: [10, 20] });

				dispatch({ command: "push" });
				await flushPromises();

				expect(mockDeleteFromJolli).toHaveBeenCalledTimes(2);
				// The cleanup call should keep the failed ID (20)
				expect(mockStoreSummary).toHaveBeenLastCalledWith(
					expect.objectContaining({ orphanedDocIds: [20] }),
					workspaceRoot,
					true,
				);
			});

			it("retains all orphaned IDs when all deletes fail", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockResolvedValue({ docId: 42 });
				// All deletes fail
				mockDeleteFromJolli.mockRejectedValue(new Error("delete failed"));
				const dispatch = await setupPanel({ orphanedDocIds: [10, 20] });

				dispatch({ command: "push" });
				await flushPromises();

				expect(mockDeleteFromJolli).toHaveBeenCalledTimes(2);
				// Since all deletes failed, orphanedDocIds should remain unchanged
				expect(mockStoreSummary).toHaveBeenLastCalledWith(
					expect.objectContaining({ orphanedDocIds: [10, 20] }),
					workspaceRoot,
					true,
				);
			});

			it("skips orphan cleanup when no orphanedDocIds present", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockResolvedValue({ docId: 42 });
				const dispatch = await setupPanel(); // no orphanedDocIds

				dispatch({ command: "push" });
				await flushPromises();

				expect(mockDeleteFromJolli).not.toHaveBeenCalled();
				// storeSummary only called once for the main push
				expect(mockStoreSummary).toHaveBeenCalledTimes(1);
			});

			it("returns early when currentSummary is null (handlePushToJolli guard)", async () => {
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();
				// Clear the summary from the internal state to exercise lines 329-332
				const panelInstance = firstCommitPanel<{ currentSummary: null }>();
				panelInstance.currentSummary = null;
				mockLoadConfig.mockClear();

				dispatch({ command: "push" });
				await flushPromises();

				// Should return early without loading config
				expect(mockLoadConfig).not.toHaveBeenCalled();
				expect(mockPushToJolli).not.toHaveBeenCalled();
			});

			it("shows 'Updated' verb when summary already has jolliDocUrl", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockResolvedValue({ docId: 42 });
				const dispatch = await setupPanel({
					jolliDocUrl: "https://my.jolli.app/articles?doc=42",
				});

				dispatch({ command: "push" });
				await flushPromises();

				expect(showInformationMessage).toHaveBeenCalledWith(
					"Updated on Jolli Space.",
				);
			});
		});

		// ── editTopic ────────────────────────────────────────────────────────

		describe("editTopic", () => {
			it("calls updateTopicInTree, stores summary, and refreshes HTML", async () => {
				const updatedSummary = makeSummary({ commitMessage: "updated" });
				mockUpdateTopicInTree.mockReturnValue({ result: updatedSummary });
				mockCollectSortedTopics.mockReturnValue({
					topics: [{ treeIndex: 0, title: "Topic 1" }],
					sourceNodes: [],
					showRecordDates: false,
				});
				mockRenderTopic.mockReturnValue("<div>updated topic</div>");
				const dispatch = await setupPanel();

				dispatch({
					command: "editTopic",
					topicIndex: 0,
					updates: { title: "New Title" },
				});
				await flushPromises();

				expect(mockUpdateTopicInTree).toHaveBeenCalled();
				expect(mockStoreSummary).toHaveBeenCalledWith(
					updatedSummary,
					workspaceRoot,
					true,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "topicUpdated",
					topicIndex: 0,
					html: "<div>updated topic</div>",
				});
			});

			it("throws error when topic index is out of range", async () => {
				mockUpdateTopicInTree.mockReturnValue(null);
				const dispatch = await setupPanel();

				dispatch({
					command: "editTopic",
					topicIndex: 99,
					updates: { title: "X" },
				});
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Edit failed"),
				);
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ command: "topicUpdateError" }),
				);
			});
		});

		// ── editRecap ────────────────────────────────────────────────────────

		describe("editRecap", () => {
			it("stores the new recap and posts recapUpdated with re-rendered HTML", async () => {
				mockBuildRecapSection.mockReturnValue(
					'<div id="recapSection">new</div>',
				);
				const dispatch = await setupPanel();

				dispatch({ command: "editRecap", recap: "  A new recap.  " });
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ recap: "A new recap." }),
					workspaceRoot,
					true,
				);
				expect(mockBuildRecapSection).toHaveBeenCalledWith("A new recap.");
				expect(postMessage).toHaveBeenCalledWith({
					command: "recapUpdated",
					html: '<div id="recapSection">new</div>',
				});
			});

			it("clears the recap when input is empty (recap=undefined on summary)", async () => {
				mockBuildRecapSection.mockReturnValue("");
				const dispatch = await setupPanel();

				dispatch({ command: "editRecap", recap: "   " });
				await flushPromises();

				const stored = mockStoreSummary.mock.calls[0][0] as {
					recap?: string;
				};
				expect(stored.recap).toBeUndefined();
				expect(mockBuildRecapSection).toHaveBeenCalledWith(undefined);
				expect(postMessage).toHaveBeenCalledWith({
					command: "recapUpdated",
					html: "",
				});
			});

			it("posts recapUpdateError when storeSummary throws", async () => {
				mockStoreSummary.mockRejectedValueOnce(new Error("disk full"));
				const dispatch = await setupPanel();

				dispatch({ command: "editRecap", recap: "anything" });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Recap save failed"),
				);
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ command: "recapUpdateError" }),
				);
			});
		});

		// ── deleteTopic ──────────────────────────────────────────────────────

		describe("deleteTopic", () => {
			it("confirms deletion and updates panel", async () => {
				const updatedSummary = makeSummary({ commitMessage: "after delete" });
				showWarningMessage.mockResolvedValue("Delete");
				mockDeleteTopicInTree.mockReturnValue({ result: updatedSummary });
				const dispatch = await setupPanel();

				dispatch({ command: "deleteTopic", topicIndex: 1, title: "Old Topic" });
				await flushPromises();

				expect(showWarningMessage).toHaveBeenCalledWith(
					"Delete memory?",
					expect.objectContaining({ modal: true }),
					"Delete",
				);
				expect(mockDeleteTopicInTree).toHaveBeenCalled();
				expect(mockStoreSummary).toHaveBeenCalledWith(
					updatedSummary,
					workspaceRoot,
					true,
				);
			});

			it("does nothing when user cancels deletion", async () => {
				showWarningMessage.mockResolvedValue(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "deleteTopic", topicIndex: 0 });
				await flushPromises();

				expect(mockDeleteTopicInTree).not.toHaveBeenCalled();
			});

			it("throws error when topic index is out of range", async () => {
				showWarningMessage.mockResolvedValue("Delete");
				mockDeleteTopicInTree.mockReturnValue(null);
				const dispatch = await setupPanel();

				dispatch({ command: "deleteTopic", topicIndex: 99 });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Delete failed"),
				);
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ command: "topicDeleteError" }),
				);
			});
		});

		// ── generateE2eTest ──────────────────────────────────────────────────

		describe("generateE2eTest", () => {
			it("calls generateE2eTest, stores summary, and refreshes section", async () => {
				const scenarios = [
					{ title: "Test A", steps: ["Step 1"], expectedResults: ["Result 1"] },
				];
				mockGenerateE2eTest.mockResolvedValue(scenarios);
				mockBuildE2eTestSection.mockReturnValue("<div>e2e tests</div>");
				const dispatch = await setupPanel();

				dispatch({ command: "generateE2eTest" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({
					command: "e2eTestGenerating",
				});
				expect(mockGenerateE2eTest).toHaveBeenCalledWith(
					expect.objectContaining({
						config: expect.objectContaining({
							apiKey: "test-key",
							model: "test-model",
						}),
					}),
				);
				expect(mockStoreSummary).toHaveBeenCalled();
				expect(postMessage).toHaveBeenCalledWith({
					command: "e2eTestUpdated",
					html: "<div>e2e tests</div>",
				});
			});

			it("handles diff failure gracefully", async () => {
				mockExecSync.mockImplementation(() => {
					throw new Error("no parent");
				});
				mockGenerateE2eTest.mockResolvedValue([]);
				const dispatch = await setupPanel();

				dispatch({ command: "generateE2eTest" });
				await flushPromises();

				// Should still call generateE2eTest with empty diff
				expect(mockGenerateE2eTest).toHaveBeenCalledWith(
					expect.objectContaining({ diff: "" }),
				);
			});
		});

		// ── editE2eTest ──────────────────────────────────────────────────────

		describe("editE2eTest", () => {
			it("stores updated scenarios and refreshes section", async () => {
				const scenarios = [
					{ title: "Updated", steps: ["Step"], expectedResults: ["Result"] },
				];
				mockBuildE2eTestSection.mockReturnValue("<div>updated</div>");
				const dispatch = await setupPanel();

				dispatch({ command: "editE2eTest", scenarios });
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ e2eTestGuide: scenarios }),
					workspaceRoot,
					true,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "e2eTestUpdated",
					html: "<div>updated</div>",
				});
			});
		});

		// ── deleteE2eTest ────────────────────────────────────────────────────

		describe("deleteE2eTest", () => {
			it("confirms and clears scenarios on Delete", async () => {
				showWarningMessage.mockResolvedValue("Delete");
				const dispatch = await setupPanel({
					e2eTestGuide: [{ title: "T", steps: [], expectedResults: [] }],
				});

				dispatch({ command: "deleteE2eTest" });
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ e2eTestGuide: undefined }),
					workspaceRoot,
					true,
				);
			});

			it("does nothing when user cancels", async () => {
				showWarningMessage.mockResolvedValue(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "deleteE2eTest" });
				await flushPromises();

				expect(mockStoreSummary).not.toHaveBeenCalled();
			});
		});

		// ── editE2eScenario ──────────────────────────────────────────────────

		describe("editE2eScenario", () => {
			it("merges updates into the scenario at index, persists, and posts e2eScenarioUpdated", async () => {
				const original = {
					title: "Old",
					preconditions: "before",
					steps: ["s1"],
					expectedResults: ["r1"],
				};
				mockRenderE2eScenario.mockReturnValue("<div>row 0</div>");
				const dispatch = await setupPanel({ e2eTestGuide: [original] });

				dispatch({
					command: "editE2eScenario",
					index: 0,
					updates: { title: "New", steps: ["a", "b"] },
				});
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						e2eTestGuide: [
							{
								title: "New",
								preconditions: "before",
								steps: ["a", "b"],
								expectedResults: ["r1"],
							},
						],
					}),
					workspaceRoot,
					true,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "e2eScenarioUpdated",
					scenarioIndex: 0,
					html: "<div>row 0</div>",
				});
			});

			it("clears preconditions when updates omits or empties the field", async () => {
				const original = {
					title: "T",
					preconditions: "old",
					steps: ["s"],
					expectedResults: ["r"],
				};
				const dispatch = await setupPanel({ e2eTestGuide: [original] });

				// Empty string → backend should drop the field.
				dispatch({
					command: "editE2eScenario",
					index: 0,
					updates: { title: "T", preconditions: "" },
				});
				await flushPromises();

				const stored = mockStoreSummary.mock.calls[0][0] as {
					e2eTestGuide: ReadonlyArray<{ preconditions?: string }>;
				};
				expect(stored.e2eTestGuide[0].preconditions).toBeUndefined();
			});

			it("preserves original preconditions when updates does not mention the field", async () => {
				const original = {
					title: "T",
					preconditions: "keep me",
					steps: ["s"],
					expectedResults: ["r"],
				};
				const dispatch = await setupPanel({ e2eTestGuide: [original] });

				dispatch({
					command: "editE2eScenario",
					index: 0,
					updates: { title: "renamed" },
				});
				await flushPromises();

				const stored = mockStoreSummary.mock.calls[0][0] as {
					e2eTestGuide: ReadonlyArray<{ preconditions?: string }>;
				};
				expect(stored.e2eTestGuide[0].preconditions).toBe("keep me");
			});

			it("returns early when summary is not loaded", async () => {
				const dispatch = await setupPanel();
				// no e2eTestGuide on default summary

				dispatch({
					command: "editE2eScenario",
					index: 0,
					updates: { title: "x" },
				});
				await flushPromises();

				expect(mockStoreSummary).not.toHaveBeenCalled();
			});

			it("returns early when index is out of range", async () => {
				const dispatch = await setupPanel({
					e2eTestGuide: [
						{ title: "only", steps: ["s"], expectedResults: ["r"] },
					],
				});

				dispatch({
					command: "editE2eScenario",
					index: 5,
					updates: { title: "x" },
				});
				await flushPromises();

				expect(mockStoreSummary).not.toHaveBeenCalled();
			});

			it("only mutates the targeted scenario in a multi-scenario guide", async () => {
				const a = { title: "A", steps: ["a"], expectedResults: ["ra"] };
				const b = { title: "B", steps: ["b"], expectedResults: ["rb"] };
				const c = { title: "C", steps: ["c"], expectedResults: ["rc"] };
				const dispatch = await setupPanel({ e2eTestGuide: [a, b, c] });

				dispatch({
					command: "editE2eScenario",
					index: 1,
					updates: { title: "B-edited" },
				});
				await flushPromises();

				const stored = mockStoreSummary.mock.calls[0][0] as {
					e2eTestGuide: ReadonlyArray<{ title: string }>;
				};
				expect(stored.e2eTestGuide.map((s) => s.title)).toEqual([
					"A",
					"B-edited",
					"C",
				]);
			});

			it("treats explicit preconditions: undefined the same as empty string (clears)", async () => {
				const original = {
					title: "T",
					preconditions: "old",
					steps: ["s"],
					expectedResults: ["r"],
				};
				const dispatch = await setupPanel({ e2eTestGuide: [original] });

				dispatch({
					command: "editE2eScenario",
					index: 0,
					updates: { title: "T", preconditions: undefined },
				});
				await flushPromises();

				const stored = mockStoreSummary.mock.calls[0][0] as {
					e2eTestGuide: ReadonlyArray<{ preconditions?: string }>;
				};
				expect(stored.e2eTestGuide[0].preconditions).toBeUndefined();
			});
		});

		// ── deleteE2eScenario ────────────────────────────────────────────────

		describe("deleteE2eScenario", () => {
			it("removes the scenario at index after confirmation, posts e2eTestUpdated", async () => {
				showWarningMessage.mockResolvedValue("Delete");
				const a = { title: "A", steps: ["s"], expectedResults: ["r"] };
				const b = { title: "B", steps: ["s"], expectedResults: ["r"] };
				const dispatch = await setupPanel({ e2eTestGuide: [a, b] });

				dispatch({ command: "deleteE2eScenario", index: 0, title: "A" });
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ e2eTestGuide: [b] }),
					workspaceRoot,
					true,
				);
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ command: "e2eTestUpdated" }),
				);
			});

			it("sets e2eTestGuide to undefined when removing the last scenario", async () => {
				showWarningMessage.mockResolvedValue("Delete");
				const dispatch = await setupPanel({
					e2eTestGuide: [
						{ title: "only", steps: ["s"], expectedResults: ["r"] },
					],
				});

				dispatch({ command: "deleteE2eScenario", index: 0 });
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ e2eTestGuide: undefined }),
					workspaceRoot,
					true,
				);
			});

			it("does nothing when user cancels", async () => {
				showWarningMessage.mockResolvedValue(undefined);
				const dispatch = await setupPanel({
					e2eTestGuide: [{ title: "T", steps: ["s"], expectedResults: ["r"] }],
				});

				dispatch({ command: "deleteE2eScenario", index: 0 });
				await flushPromises();

				expect(mockStoreSummary).not.toHaveBeenCalled();
			});

			it("returns early when summary is not loaded", async () => {
				const dispatch = await setupPanel();
				// default summary has no e2eTestGuide

				dispatch({ command: "deleteE2eScenario", index: 0 });
				await flushPromises();

				expect(showWarningMessage).not.toHaveBeenCalled();
				expect(mockStoreSummary).not.toHaveBeenCalled();
			});

			it("returns early when index is out of range", async () => {
				const dispatch = await setupPanel({
					e2eTestGuide: [{ title: "T", steps: ["s"], expectedResults: ["r"] }],
				});

				dispatch({ command: "deleteE2eScenario", index: 99 });
				await flushPromises();

				expect(showWarningMessage).not.toHaveBeenCalled();
				expect(mockStoreSummary).not.toHaveBeenCalled();
			});
		});

		// ── loadPlanContent ──────────────────────────────────────────────────

		describe("loadPlanContent", () => {
			it("reads plan from branch and sends content to webview", async () => {
				mockReadPlanFromBranch.mockResolvedValue("# My Plan\n\nContent here");
				const dispatch = await setupPanel();

				dispatch({ command: "loadPlanContent", slug: "my-plan" });
				await flushPromises();

				expect(mockReadPlanFromBranch).toHaveBeenCalledWith(
					"my-plan",
					workspaceRoot,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "planContentLoaded",
					slug: "my-plan",
					content: "# My Plan\n\nContent here",
				});
			});

			it("shows error when plan cannot be read", async () => {
				mockReadPlanFromBranch.mockResolvedValue(null);
				const dispatch = await setupPanel();

				dispatch({ command: "loadPlanContent", slug: "missing-plan" });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					'Could not read plan "missing-plan" from the orphan branch.',
				);
			});
		});

		// ── savePlan ─────────────────────────────────────────────────────────

		describe("savePlan", () => {
			it("stores plan and refreshes section", async () => {
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "my-plan",
							title: "Old Title",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({
					command: "savePlan",
					slug: "my-plan",
					content: "# New Title\n\nUpdated content",
				});
				await flushPromises();

				expect(mockStorePlans).toHaveBeenCalledWith(
					[{ slug: "my-plan", content: "# New Title\n\nUpdated content" }],
					"Edit plan my-plan",
					workspaceRoot,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "planSaved",
					slug: "my-plan",
				});
			});

			it("syncs plan title from markdown heading", async () => {
				mockLoadPlansRegistry.mockResolvedValue({
					plans: {
						"my-plan": { slug: "my-plan", title: "Old", commitHash: "abc" },
					},
				});
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "my-plan",
							title: "Old",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({
					command: "savePlan",
					slug: "my-plan",
					content: "# Updated Title\n\nBody",
				});
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						plans: expect.arrayContaining([
							expect.objectContaining({
								slug: "my-plan",
								title: "Updated Title",
							}),
						]),
					}),
					workspaceRoot,
					true,
				);
				expect(mockSavePlansRegistry).toHaveBeenCalled();
			});
		});

		// ── previewPlan ──────────────────────────────────────────────────────

		describe("previewPlan", () => {
			it("opens plan in editor via vscode command", async () => {
				const dispatch = await setupPanel();

				dispatch({
					command: "previewPlan",
					slug: "my-plan",
					title: "Plan Title",
				});
				await flushPromises();

				expect(executeCommand).toHaveBeenCalledWith(
					"jollimemory.editPlan",
					"my-plan",
					true,
					"Plan Title",
				);
			});
		});

		// ── removePlan ───────────────────────────────────────────────────────

		describe("removePlan", () => {
			it("confirms and removes plan association", async () => {
				showWarningMessage.mockResolvedValue("Remove");
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "plan-a",
							title: "Plan A",
							editCount: 1,
							addedAt: "",
							updatedAt: "",
						},
						{
							slug: "plan-b",
							title: "Plan B",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "removePlan", slug: "plan-a", title: "Plan A" });
				await flushPromises();

				expect(mockUnassociatePlanFromCommit).toHaveBeenCalledWith(
					"plan-a",
					workspaceRoot,
				);
				// Must also mark as ignored so the plan doesn't reappear in the sidebar
				expect(mockIgnorePlan).toHaveBeenCalledWith("plan-a", workspaceRoot);
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						plans: [expect.objectContaining({ slug: "plan-b" })],
					}),
					workspaceRoot,
					true,
				);
			});

			it("clears plans field when last plan is removed", async () => {
				showWarningMessage.mockResolvedValue("Remove");
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "only-plan",
							title: "Only",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "removePlan", slug: "only-plan", title: "Only" });
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ plans: undefined }),
					workspaceRoot,
					true,
				);
			});

			it("does nothing when user cancels", async () => {
				showWarningMessage.mockResolvedValue(undefined);
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "plan-a",
							title: "Plan A",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "removePlan", slug: "plan-a", title: "Plan A" });
				await flushPromises();

				expect(mockUnassociatePlanFromCommit).not.toHaveBeenCalled();
			});
		});

		// ── addPlan ──────────────────────────────────────────────────────────

		describe("addPlan", () => {
			it("shows quickpick and calls archivePlanForCommit", async () => {
				mockListAvailablePlans.mockReturnValue([
					{ title: "Available Plan", slug: "avail-plan" },
				]);
				showQuickPick.mockResolvedValue({
					label: "Available Plan",
					slug: "avail-plan",
				});
				mockArchivePlanForCommit.mockResolvedValue({
					slug: "avail-plan-abc123",
					title: "Available Plan",
					editCount: 0,
					addedAt: "2025-01-01",
					updatedAt: "2025-01-01",
				});
				const dispatch = await setupPanel();

				dispatch({ command: "addPlan" });
				await flushPromises();

				expect(showQuickPick).toHaveBeenCalled();
				expect(mockArchivePlanForCommit).toHaveBeenCalledWith(
					"avail-plan",
					"abc123",
					workspaceRoot,
				);
				expect(mockStoreSummary).toHaveBeenCalled();
			});

			it("excludes already-attached plans from available list", async () => {
				mockListAvailablePlans.mockReturnValue([
					{ title: "New Plan", slug: "new-plan" },
				]);
				showQuickPick.mockResolvedValue({
					label: "New Plan",
					slug: "new-plan",
				});
				mockArchivePlanForCommit.mockResolvedValue({
					slug: "new-plan-abc123",
					title: "New Plan",
					editCount: 0,
					addedAt: "2025-01-01",
					updatedAt: "2025-01-01",
				});
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "existing-plan",
							title: "Existing",
							editCount: 1,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "addPlan" });
				await flushPromises();

				// listAvailablePlans should be called with a Set containing the existing slug
				expect(mockListAvailablePlans).toHaveBeenCalledWith(
					new Set(["existing-plan"]),
				);
			});

			it("shows info message when no plans available", async () => {
				mockListAvailablePlans.mockReturnValue([]);
				const dispatch = await setupPanel();

				dispatch({ command: "addPlan" });
				await flushPromises();

				expect(showInformationMessage).toHaveBeenCalledWith(
					"No plans available to add.",
				);
				expect(showQuickPick).not.toHaveBeenCalled();
			});

			it("does nothing when user dismisses quickpick", async () => {
				mockListAvailablePlans.mockReturnValue([{ title: "Plan", slug: "p" }]);
				showQuickPick.mockResolvedValue(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "addPlan" });
				await flushPromises();

				expect(mockArchivePlanForCommit).not.toHaveBeenCalled();
			});

			it("shows error when archive fails", async () => {
				mockListAvailablePlans.mockReturnValue([{ title: "Plan", slug: "p" }]);
				showQuickPick.mockResolvedValue({ label: "Plan", slug: "p" });
				mockArchivePlanForCommit.mockResolvedValue(null);
				const dispatch = await setupPanel();

				dispatch({ command: "addPlan" });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					'Failed to add plan "p" — plan file not found.',
				);
			});
		});

		// ── PR handlers ──────────────────────────────────────────────────────

		describe("checkPrStatus", () => {
			it("delegates to handleCheckPrStatus", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "checkPrStatus" });
				await flushPromises();

				expect(mockHandleCheckPrStatus).toHaveBeenCalledWith(
					workspaceRoot,
					expect.any(Function),
					"feature/test",
					"abc123",
				);
			});

			it("forwards postMessage callback to the webview panel", async () => {
				// Make handleCheckPrStatus invoke the callback to exercise the lambda on line 192
				mockHandleCheckPrStatus.mockImplementationOnce(
					(_cwd: string, pm: (msg: Record<string, unknown>) => void) =>
						Promise.resolve(pm({ command: "prStatusLoaded" })),
				);
				const dispatch = await setupPanel();

				dispatch({ command: "checkPrStatus" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({ command: "prStatusLoaded" });
			});
		});

		describe("createPr", () => {
			it("delegates to handleCreatePr", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "createPr", title: "PR Title", body: "PR Body" });
				await flushPromises();

				expect(mockHandleCreatePr).toHaveBeenCalledWith(
					"PR Title",
					"PR Body",
					workspaceRoot,
					expect.any(Function),
					"feature/test",
					"abc123",
				);
			});

			it("forwards postMessage callback to the webview panel", async () => {
				// Make handleCreatePr invoke the callback to exercise line 198
				mockHandleCreatePr.mockImplementationOnce(
					(
						_t: string,
						_b: string,
						_cwd: string,
						pm: (msg: Record<string, unknown>) => void,
					) => Promise.resolve(pm({ command: "prCreating" })),
				);
				const dispatch = await setupPanel();

				dispatch({ command: "createPr", title: "T", body: "B" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({ command: "prCreating" });
			});
		});

		describe("prepareCreatePr", () => {
			it("posts prShowCreateForm with wrapped body and commit message title", async () => {
				mockBuildPrMarkdown.mockReturnValue("# fresh body");
				const dispatch = await setupPanel({ commitMessage: "feat: add thing" });

				dispatch({ command: "prepareCreatePr" });
				await flushPromises();

				expect(mockBuildPrMarkdown).toHaveBeenCalledWith(
					expect.objectContaining({ commitHash: "abc123" }),
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "prShowCreateForm",
					body: "[MARKERS]# fresh body[/MARKERS]",
					title: "feat: add thing",
				});
			});

			it("does nothing when no summary is loaded", async () => {
				await SummaryWebviewPanel.show(
					makeSummary(),
					extensionUri,
					workspaceRoot,
				);
				const dispatch = captureMessageHandler();
				firstCommitPanel<{ currentSummary: null }>().currentSummary = null;
				vi.clearAllMocks();

				dispatch({ command: "prepareCreatePr" });
				await flushPromises();

				expect(postMessage).not.toHaveBeenCalledWith(
					expect.objectContaining({ command: "prShowCreateForm" }),
				);
			});
		});

		describe("prepareUpdatePr", () => {
			it("delegates to handlePrepareUpdatePr with current summary", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "prepareUpdatePr" });
				await flushPromises();

				expect(mockHandlePrepareUpdatePr).toHaveBeenCalledWith(
					expect.objectContaining({ commitHash: "abc123" }),
					workspaceRoot,
					expect.any(Function),
					mockBuildPrMarkdown,
				);
			});

			it("forwards postMessage callback to the webview panel", async () => {
				// Make handlePrepareUpdatePr invoke the callback to exercise the lambda on line 210
				mockHandlePrepareUpdatePr.mockImplementationOnce(
					(
						_summary: unknown,
						_cwd: string,
						pm: (msg: Record<string, unknown>) => void,
						_buildPr: unknown,
					) => Promise.resolve(pm({ command: "prDataLoaded" })),
				);
				const dispatch = await setupPanel();

				dispatch({ command: "prepareUpdatePr" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({ command: "prDataLoaded" });
			});
		});

		describe("updatePr", () => {
			it("delegates to handleUpdatePr", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "updatePr", title: "Updated", body: "Body" });
				await flushPromises();

				expect(mockHandleUpdatePr).toHaveBeenCalledWith(
					"Updated",
					"Body",
					workspaceRoot,
					expect.any(Function),
					"feature/test",
					"abc123",
				);
			});

			it("forwards postMessage callback to the webview panel", async () => {
				// Make handleUpdatePr invoke the callback to exercise line 219
				mockHandleUpdatePr.mockImplementationOnce(
					(
						_t: string,
						_b: string,
						_cwd: string,
						pm: (msg: Record<string, unknown>) => void,
					) => Promise.resolve(pm({ command: "prUpdating" })),
				);
				const dispatch = await setupPanel();

				dispatch({ command: "updatePr", title: "T", body: "B" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({ command: "prUpdating" });
			});
		});

		// ── loadTranscriptStats ──────────────────────────────────────────────

		describe("loadTranscriptStats", () => {
			it("deduplicates sessions and counts codex sessions separately", async () => {
				mockGetTranscriptHashes.mockResolvedValue(
					new Set(["abc123", "def456"]),
				);
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "s1",
									source: "claude" as const,
									entries: [{ role: "human" as const, content: "A" }],
								},
								{
									sessionId: "cx1",
									source: "codex" as const,
									entries: [{ role: "human" as const, content: "B" }],
								},
							],
						},
					],
					[
						"def456",
						{
							sessions: [
								// Duplicate of s1 from abc123 — should be deduplicated (line 784-786)
								{
									sessionId: "s1",
									source: "claude" as const,
									entries: [{ role: "human" as const, content: "C" }],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						totalEntries: 3,
						sessionCounts: expect.objectContaining({ claude: 1, codex: 1 }),
					}),
				);
			});

			it("loads transcript metadata and sends stats to webview", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "s1",
									source: "claude" as const,
									entries: [
										{ role: "human" as const, content: "Hello" },
										{ role: "assistant" as const, content: "Hi" },
									],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						totalEntries: 2,
						sessionCounts: expect.objectContaining({ claude: 1 }),
					}),
				);
			});

			it("does nothing when no transcripts exist", async () => {
				const dispatch = await setupPanel();
				postMessage.mockClear();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				// No transcriptStatsLoaded message sent (transcriptHashSet is empty)
				const statsMessages = postMessage.mock.calls.filter(
					(c: Array<unknown>) =>
						(c[0] as Record<string, unknown>).command ===
						"transcriptStatsLoaded",
				);
				expect(statsMessages).toHaveLength(0);
			});

			it("excludes sessions from disabled sources in transcript stats", async () => {
				// Disable claude and codex; only gemini is enabled
				mockLoadConfig.mockResolvedValue({
					claudeEnabled: false,
					codexEnabled: false,
					geminiEnabled: true,
				});
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "s1",
									source: "claude" as const,
									entries: [{ role: "human" as const, content: "A" }],
								},
								{
									sessionId: "cx1",
									source: "codex" as const,
									entries: [
										{ role: "human" as const, content: "B" },
										{ role: "assistant" as const, content: "C" },
									],
								},
								{
									sessionId: "g1",
									source: "gemini" as const,
									entries: [{ role: "human" as const, content: "D" }],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				// Claude (s1) and codex (cx1) sessions should be excluded; only gemini (g1) counted
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						totalEntries: 1,
						sessionCounts: expect.objectContaining({ gemini: 1 }),
					}),
				);
			});

			it("excludes gemini sessions when geminiEnabled is false", async () => {
				// Disable gemini while keeping claude and codex enabled
				mockLoadConfig.mockResolvedValue({
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: false,
				});
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "s1",
									source: "claude" as const,
									entries: [{ role: "human" as const, content: "A" }],
								},
								{
									sessionId: "g1",
									source: "gemini" as const,
									entries: [{ role: "human" as const, content: "B" }],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				// Gemini session (g1) should be excluded; only claude session counted
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						totalEntries: 1,
						sessionCounts: expect.objectContaining({ claude: 1 }),
					}),
				);
			});

			it("treats sessions with undefined source as claude", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "s1",
									// source is undefined — should default to "claude"
									entries: [{ role: "human" as const, content: "Hi" }],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						totalEntries: 1,
						sessionCounts: expect.objectContaining({ claude: 1 }),
					}),
				);
			});
		});

		// ── translatePlan ────────────────────────────────────────────────────

		describe("translatePlan", () => {
			it("skips the final update when currentSummary is null (race)", async () => {
				// Covers `if (this.currentSummary)` falsy branch in handleTranslatePlan.
				mockReadPlanFromBranch.mockResolvedValue("# 中文\n\n内容");
				mockTranslateToEnglish.mockResolvedValue("# Translated\n\nContent");
				mockLoadPlansRegistry.mockResolvedValue({ plans: {} });
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "race-plan",
							title: "中文",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});
				// Simulate a dispose race: currentSummary cleared mid-operation.
				const panel = firstCommitPanel<{ currentSummary: unknown }>();
				panel.currentSummary = undefined;

				dispatch({ command: "translatePlan", slug: "race-plan" });
				await flushPromises();

				// Translation still propagated — post-event message still posts.
				expect(postMessage).toHaveBeenCalledWith({
					command: "planTranslated",
					slug: "race-plan",
				});
			});

			it("translates plan content and saves", async () => {
				mockReadPlanFromBranch.mockResolvedValue("# 中文标题\n\n内容");
				mockTranslateToEnglish.mockResolvedValue(
					"# Translated Title\n\nContent",
				);
				mockLoadPlansRegistry.mockResolvedValue({ plans: {} });
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "cn-plan",
							title: "中文标题",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "translatePlan", slug: "cn-plan" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({
					command: "planTranslating",
					slug: "cn-plan",
				});
				expect(mockTranslateToEnglish).toHaveBeenCalledWith(
					expect.objectContaining({
						content: "# 中文标题\n\n内容",
						config: expect.objectContaining({
							apiKey: "test-key",
							model: "test-model",
						}),
					}),
				);
				expect(mockStorePlans).toHaveBeenCalledWith(
					[{ slug: "cn-plan", content: "# Translated Title\n\nContent" }],
					"Translate plan cn-plan to English",
					workspaceRoot,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "planTranslated",
					slug: "cn-plan",
				});
				expect(showInformationMessage).toHaveBeenCalledWith(
					'Plan "cn-plan" has been translated to English.',
				);
			});

			it("shows info when plan is already in English", async () => {
				mockReadPlanFromBranch.mockResolvedValue(
					"# English Plan\n\nAll ASCII content",
				);
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "en-plan",
							title: "English Plan",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "translatePlan", slug: "en-plan" });
				await flushPromises();

				expect(showInformationMessage).toHaveBeenCalledWith(
					"Plan is already in English.",
				);
				expect(mockTranslateToEnglish).not.toHaveBeenCalled();
			});

			it("shows error when plan cannot be read", async () => {
				mockReadPlanFromBranch.mockResolvedValue(null);
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "bad",
							title: "Bad",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "translatePlan", slug: "bad" });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					'Could not read plan "bad" from the orphan branch.',
				);
			});
		});

		// ── loadAllTranscripts ───────────────────────────────────────────────

		describe("loadAllTranscripts", () => {
			it("does nothing when no current summary is set", async () => {
				// Create a panel, then clear the internal currentSummary to exercise
				// the `if (!summary) { return; }` guard on line 807-809.
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();
				// Clear the summary from the internal state
				const panelInstance = firstCommitPanel<{ currentSummary: null }>();
				panelInstance.currentSummary = null;
				postMessage.mockClear();

				dispatch({ command: "loadAllTranscripts" });
				await flushPromises();

				// Should not even post transcriptsLoading
				const loadingMessages = postMessage.mock.calls.filter(
					(c: Array<unknown>) =>
						(c[0] as Record<string, unknown>).command === "transcriptsLoading",
				);
				expect(loadingMessages).toHaveLength(0);
			});

			it("excludes sessions from disabled sources in loadAllTranscripts", async () => {
				// Disable claude so claude-sourced sessions are filtered out
				mockLoadConfig.mockResolvedValue({
					claudeEnabled: false,
					codexEnabled: true,
					geminiEnabled: true,
				});
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "s1",
									source: "claude" as const,
									transcriptPath: "/path/claude",
									entries: [
										{
											role: "human" as const,
											content: "X",
											timestamp: "2025-01-01T00:00:00Z",
										},
									],
								},
								{
									sessionId: "cx1",
									source: "codex" as const,
									transcriptPath: "/path/codex",
									entries: [
										{
											role: "human" as const,
											content: "Y",
											timestamp: "2025-01-01T00:01:00Z",
										},
									],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadAllTranscripts" });
				await flushPromises();

				const loadedCall = postMessage.mock.calls.find(
					(c: Array<unknown>) =>
						(c[0] as Record<string, unknown>).command ===
						"allTranscriptsLoaded",
				);
				expect(loadedCall).toBeDefined();
				const payload = (loadedCall as Array<unknown>)[0] as {
					entries: Array<{ source: string }>;
				};
				// Only codex entries should be present; claude entries filtered out
				expect(payload.entries.every((e) => e.source === "codex")).toBe(true);
				expect(payload.entries).toHaveLength(1);
			});

			it("loads all transcript entries and sends to webview", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "s1",
									source: "claude" as const,
									transcriptPath: "/path/to/transcript",
									entries: [
										{
											role: "human" as const,
											content: "Q",
											timestamp: "2025-01-01T00:00:00Z",
										},
										{
											role: "assistant" as const,
											content: "A",
											timestamp: "2025-01-01T00:01:00Z",
										},
									],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadAllTranscripts" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({
					command: "transcriptsLoading",
				});
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "allTranscriptsLoaded",
						totalCommits: 1,
						entries: expect.arrayContaining([
							expect.objectContaining({
								commitHash: "abc123",
								sessionId: "s1",
								role: "human",
								content: "Q",
							}),
						]),
					}),
				);
			});

			it("defaults undefined session source to claude in loadAllTranscripts", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "s1",
									// source is undefined — should default to "claude"
									transcriptPath: "/path/to/transcript",
									entries: [
										{
											role: "human" as const,
											content: "Hi",
											timestamp: "2025-01-01T00:00:00Z",
										},
									],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadAllTranscripts" });
				await flushPromises();

				const loadedCall = postMessage.mock.calls.find(
					(c: Array<unknown>) =>
						(c[0] as Record<string, unknown>).command ===
						"allTranscriptsLoaded",
				);
				expect(loadedCall).toBeDefined();
				const payload = (loadedCall as Array<unknown>)[0] as {
					entries: Array<{ source: string }>;
				};
				// Source should be defaulted to "claude"
				expect(payload.entries[0].source).toBe("claude");
			});
		});

		// ── saveAllTranscripts ───────────────────────────────────────────────

		describe("saveAllTranscripts", () => {
			it("saves edited transcripts back to orphan branch", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				mockReadTranscriptsForCommits.mockResolvedValue(
					new Map([
						[
							"abc123",
							{
								sessions: [
									{
										sessionId: "s1",
										source: "claude" as const,
										transcriptPath: "/original/path",
										entries: [{ role: "human" as const, content: "Old" }],
									},
								],
							},
						],
					]),
				);
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({
					command: "saveAllTranscripts",
					entries: [
						{
							commitHash: "abc123",
							sessionId: "s1",
							source: "claude",
							originalIndex: 0,
							role: "human",
							content: "Edited content",
						},
					],
				});
				await flushPromises();

				expect(mockSaveTranscriptsBatch).toHaveBeenCalled();
				expect(postMessage).toHaveBeenCalledWith({
					command: "transcriptsSaved",
				});
			});
		});

		describe("saveAllTranscripts with multiple entries per commit", () => {
			it("groups multiple entries under the same commitHash in the Map", async () => {
				// Exercises the `if (list) { list.push(entry); }` branch (line 859-860)
				// where a second entry for the same commitHash is appended to the existing list.
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				mockReadTranscriptsForCommits.mockResolvedValue(
					new Map([
						[
							"abc123",
							{
								sessions: [
									{
										sessionId: "s1",
										source: "claude" as const,
										transcriptPath: "/original/path",
										entries: [
											{ role: "human" as const, content: "Q1" },
											{ role: "assistant" as const, content: "A1" },
										],
									},
								],
							},
						],
					]),
				);
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({
					command: "saveAllTranscripts",
					entries: [
						{
							commitHash: "abc123",
							sessionId: "s1",
							source: "claude",
							originalIndex: 0,
							role: "human",
							content: "Edited Q1",
						},
						{
							commitHash: "abc123",
							sessionId: "s1",
							source: "claude",
							originalIndex: 1,
							role: "assistant",
							content: "Edited A1",
						},
					],
				});
				await flushPromises();

				expect(mockSaveTranscriptsBatch).toHaveBeenCalled();
				expect(postMessage).toHaveBeenCalledWith({
					command: "transcriptsSaved",
				});
			});
		});

		describe("saveAllTranscripts with empty commit entries", () => {
			it("adds commit to delete list when entries array for that commit is empty", async () => {
				mockGetTranscriptHashes.mockResolvedValue(
					new Set(["abc123", "def456"]),
				);
				mockReadTranscriptsForCommits.mockResolvedValue(
					new Map([
						[
							"abc123",
							{
								sessions: [
									{
										sessionId: "s1",
										source: "claude" as const,
										transcriptPath: "/path/to/transcript",
										entries: [{ role: "human" as const, content: "Hello" }],
									},
								],
							},
						],
						[
							"def456",
							{
								sessions: [
									{
										sessionId: "s2",
										source: "claude" as const,
										entries: [{ role: "human" as const, content: "World" }],
									},
								],
							},
						],
					]),
				);
				const summary = makeSummary({
					children: [makeSummary({ commitHash: "def456" })],
				});
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				// Send entries only for abc123 — def456 has no entries so should be deleted
				dispatch({
					command: "saveAllTranscripts",
					entries: [
						{
							commitHash: "abc123",
							sessionId: "s1",
							source: "claude",
							originalIndex: 0,
							role: "human",
							content: "Edited",
						},
					],
				});
				await flushPromises();

				// saveTranscriptsBatch should be called; the second arg (deletes) should contain "def456"
				expect(mockSaveTranscriptsBatch).toHaveBeenCalledWith(
					expect.any(Array),
					expect.arrayContaining(["def456"]),
					workspaceRoot,
				);
			});
		});

		// ── deleteAllTranscripts ─────────────────────────────────────────────

		describe("deleteAllTranscripts", () => {
			it("deletes all transcript files for current summary", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "deleteAllTranscripts" });
				await flushPromises();

				expect(mockSaveTranscriptsBatch).toHaveBeenCalledWith(
					[],
					["abc123"],
					workspaceRoot,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "transcriptsDeleted",
				});
			});

			it("does nothing when no transcripts exist", async () => {
				const dispatch = await setupPanel();
				mockSaveTranscriptsBatch.mockClear();

				dispatch({ command: "deleteAllTranscripts" });
				await flushPromises();

				expect(mockSaveTranscriptsBatch).not.toHaveBeenCalled();
			});

			it("skips refresh when currentSummary is null during delete", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				// Clear the summary after showing the panel
				const panelInstance = firstCommitPanel<{ currentSummary: null }>();
				panelInstance.currentSummary = null;
				const dispatch = captureMessageHandler();

				dispatch({ command: "deleteAllTranscripts" });
				await flushPromises();

				// Delete still runs (transcriptHashSet was populated earlier)
				expect(mockSaveTranscriptsBatch).toHaveBeenCalledWith(
					[],
					["abc123"],
					workspaceRoot,
				);
				// transcriptsDeleted still posted
				expect(postMessage).toHaveBeenCalledWith({
					command: "transcriptsDeleted",
				});
			});
		});

		// ── editPlan (command delegation) ────────────────────────────────────

		describe("editPlan", () => {
			it("delegates to vscode.commands.executeCommand", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "editPlan", slug: "my-plan", committed: true });
				await flushPromises();

				expect(executeCommand).toHaveBeenCalledWith(
					"jollimemory.editPlan",
					"my-plan",
					true,
				);
			});

			it("defaults committed to false when not provided", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "editPlan", slug: "my-plan" });
				await flushPromises();

				expect(executeCommand).toHaveBeenCalledWith(
					"jollimemory.editPlan",
					"my-plan",
					false,
				);
			});
		});

		// ── Guards: no currentSummary ────────────────────────────────────────

		describe("guards when currentSummary is cleared", () => {
			/** Creates a panel, clears currentSummary, and returns the dispatch function. */
			async function setupPanelWithoutSummary(): Promise<
				(msg: Record<string, unknown>) => void
			> {
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();
				const panelInstance = firstCommitPanel<{ currentSummary: null }>();
				panelInstance.currentSummary = null;
				vi.clearAllMocks();
				return dispatch;
			}

			it("copyMarkdown does nothing when no summary", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "copyMarkdown" });
				await flushPromises();

				expect(clipboardWriteText).not.toHaveBeenCalled();
			});

			it("pushToJolli does nothing when no summary", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "push" });
				await flushPromises();

				expect(mockLoadConfig).not.toHaveBeenCalled();
			});

			it("prepareUpdatePr does nothing when no summary", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "prepareUpdatePr" });
				await flushPromises();

				expect(mockHandlePrepareUpdatePr).not.toHaveBeenCalled();
			});

			it("handleEditTopic returns early when no summary", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({
					command: "editTopic",
					topicIndex: 0,
					updates: { title: "X" },
				});
				await flushPromises();

				expect(mockUpdateTopicInTree).not.toHaveBeenCalled();
			});

			it("handleDeleteTopic returns early when no summary", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "deleteTopic", topicIndex: 0, title: "X" });
				await flushPromises();

				expect(showWarningMessage).not.toHaveBeenCalled();
			});

			it("handleGenerateE2eTest returns early when no summary", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "generateE2eTest" });
				await flushPromises();

				expect(mockGenerateE2eTest).not.toHaveBeenCalled();
			});

			it("handleEditE2eTest returns early when no summary", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "editE2eTest", scenarios: [] });
				await flushPromises();

				expect(mockStoreSummary).not.toHaveBeenCalled();
			});

			it("handleDeleteE2eTest returns early when no summary", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "deleteE2eTest" });
				await flushPromises();

				expect(showWarningMessage).not.toHaveBeenCalled();
			});

			it("handleAddPlan returns early when no summary", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "addPlan" });
				await flushPromises();

				expect(mockListAvailablePlans).not.toHaveBeenCalled();
			});

			it("handleRemovePlan returns early when summary has no plans", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "removePlan", slug: "plan-a", title: "Plan A" });
				await flushPromises();

				expect(showWarningMessage).not.toHaveBeenCalled();
			});

			it("handlePushToJolli returns early via guard when summary cleared", async () => {
				// handlePushToJolli has its own `if (!summary) return;` guard on line 330
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "push" });
				await flushPromises();

				expect(mockPushToJolli).not.toHaveBeenCalled();
			});

			it("saveAllTranscripts skips refresh when currentSummary is null", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "saveAllTranscripts", entries: [] });
				await flushPromises();

				// transcriptsSaved is still posted, but the refresh guard is skipped
				expect(postMessage).toHaveBeenCalledWith({
					command: "transcriptsSaved",
				});
			});

			it("handlePush dispatch guard skips call when summary is null", async () => {
				// The dispatch-level guard `if (this.currentSummary)` prevents handlePush
				// from being called at all when the summary is cleared.
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const panelInstance = firstCommitPanel<{ currentSummary: null }>();
				panelInstance.currentSummary = null;
				mockLoadConfig.mockClear();
				const dispatch = captureMessageHandler();

				dispatch({ command: "push" });
				await flushPromises();

				expect(mockLoadConfig).not.toHaveBeenCalled();
			});
		});

		// ── catchAndShow with webviewErrorMsg ────────────────────────────────

		describe("catchAndShow posts error to webview", () => {
			it("posts e2eTestError when generateE2eTest fails", async () => {
				mockGenerateE2eTest.mockRejectedValue(new Error("AI unavailable"));
				const dispatch = await setupPanel();

				dispatch({ command: "generateE2eTest" });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("E2E test generation failed"),
				);
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "e2eTestError",
						message: "AI unavailable",
					}),
				);
			});

			it("posts e2eTestError when editE2eTest fails", async () => {
				mockStoreSummary.mockRejectedValueOnce(new Error("store error"));
				const dispatch = await setupPanel();

				dispatch({ command: "editE2eTest", scenarios: [] });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "e2eTestError",
						message: "store error",
					}),
				);
			});

			it("posts planTranslateError when translatePlan fails", async () => {
				mockReadPlanFromBranch.mockResolvedValue("# 中文\n\n内容");
				mockTranslateToEnglish.mockRejectedValue(new Error("translate error"));
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "cn",
							title: "中文计划",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "translatePlan", slug: "cn" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "planTranslateError",
						slug: "cn",
						message: "translate error",
					}),
				);
			});
		});

		// ── catchAndShow with non-Error objects ──────────────────────────────

		describe("catchAndShow coerces non-Error to string", () => {
			it("coerces a plain string error from editTopic", async () => {
				mockUpdateTopicInTree.mockImplementation(() => {
					throw "raw string failure";
				});
				const dispatch = await setupPanel();

				dispatch({ command: "editTopic", topicIndex: 0, updates: {} });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					"Edit failed — raw string failure",
				);
			});
		});

		// ── deleteTopic without title ────────────────────────────────────────

		describe("deleteTopic without title", () => {
			it("shows generic 'Delete this memory?' when no title provided", async () => {
				showWarningMessage.mockResolvedValue("Delete");
				mockDeleteTopicInTree.mockReturnValue({ result: makeSummary() });
				const dispatch = await setupPanel();

				dispatch({ command: "deleteTopic", topicIndex: 0 });
				await flushPromises();

				expect(showWarningMessage).toHaveBeenCalledWith(
					"Delete this memory?",
					expect.objectContaining({ detail: "This cannot be undone." }),
					"Delete",
				);
			});
		});

		// ── editTopic when topic not found in sorted list ────────────────────

		describe("editTopic renders empty html when topic not found in sorted list", () => {
			it("sends empty html when displayIndex is -1", async () => {
				const updatedSummary = makeSummary({ commitMessage: "updated" });
				mockUpdateTopicInTree.mockReturnValue({ result: updatedSummary });
				// Return topics with a treeIndex that doesn't match the requested topicIndex
				mockCollectSortedTopics.mockReturnValue({
					topics: [{ treeIndex: 99, title: "Other Topic" }],
					sourceNodes: [],
					showRecordDates: false,
				});
				const dispatch = await setupPanel();

				dispatch({
					command: "editTopic",
					topicIndex: 0,
					updates: { title: "New" },
				});
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({
					command: "topicUpdated",
					topicIndex: 0,
					html: "",
				});
			});
		});

		// ── syncPlanTitle with no title match ────────────────────────────────

		describe("syncPlanTitle edge cases", () => {
			it("skips sync when plan content has no markdown heading", async () => {
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "no-heading",
							title: "Original",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});
				mockStoreSummary.mockClear();

				dispatch({
					command: "savePlan",
					slug: "no-heading",
					content: "No heading here, just text",
				});
				await flushPromises();

				// storePlans should have been called, but storeSummary should NOT have been called
				// (because syncPlanTitle returns early when no heading found)
				expect(mockStorePlans).toHaveBeenCalled();
				expect(mockStoreSummary).not.toHaveBeenCalled();
			});

			it("skips sync when plan slug does not match any plan in currentSummary", async () => {
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "other-plan",
							title: "Other",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});
				mockStoreSummary.mockClear();

				dispatch({
					command: "savePlan",
					slug: "nonexistent",
					content: "# Title\n\nBody",
				});
				await flushPromises();

				// storePlans should be called, but storeSummary should also be called because
				// syncPlanTitle will find the title but the slug won't match, so plans stay the same
				expect(mockStorePlans).toHaveBeenCalled();
			});

			it("skips registry update when plan slug not in registry", async () => {
				mockLoadPlansRegistry.mockResolvedValue({
					plans: { "other-slug": { slug: "other-slug", title: "X" } },
				});
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "my-plan",
							title: "Old",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({
					command: "savePlan",
					slug: "my-plan",
					content: "# New Title\n\nBody",
				});
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalled();
				expect(mockSavePlansRegistry).not.toHaveBeenCalled();
			});
		});

		// ── handleTranslatePlan: CJK in body but not title ───────────────────

		describe("translatePlan CJK in body only", () => {
			it("translates when body has CJK but title is English", async () => {
				// Return CJK body content for the plan
				mockReadPlanFromBranch.mockResolvedValue(
					"# English Title\n\n这是中文内容",
				);
				mockTranslateToEnglish.mockResolvedValue(
					"# English Title\n\nEnglish content",
				);
				mockLoadPlansRegistry.mockResolvedValue({ plans: {} });
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "body-cjk",
							title: "English Title",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "translatePlan", slug: "body-cjk" });
				await flushPromises();

				expect(mockTranslateToEnglish).toHaveBeenCalled();
				expect(showInformationMessage).toHaveBeenCalledWith(
					'Plan "body-cjk" has been translated to English.',
				);
			});
		});

		// ── handleTranslatePlan: plan not found in currentSummary ─────────────

		describe("translatePlan when plan not in currentSummary.plans", () => {
			it("proceeds using titleHasNonAscii=false when plan not found", async () => {
				// Content has CJK, so translation should still happen
				mockReadPlanFromBranch.mockResolvedValue("# 中文内容\n\n内容");
				mockTranslateToEnglish.mockResolvedValue("# English\n\nContent");
				mockLoadPlansRegistry.mockResolvedValue({ plans: {} });
				const dispatch = await setupPanel();

				dispatch({ command: "translatePlan", slug: "orphan-plan" });
				await flushPromises();

				expect(mockTranslateToEnglish).toHaveBeenCalled();
			});
		});

		// ── refreshTranscriptHashes error path ───────────────────────────────

		describe("refreshTranscriptHashes error handling", () => {
			it("sets transcriptHashSet to empty on error", async () => {
				mockGetTranscriptHashes.mockRejectedValue(new Error("git error"));
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

				// buildHtml should have been called with an empty set
				expect(mockBuildHtml).toHaveBeenCalledWith(
					summary,
					expect.objectContaining({
						transcriptHashSet: new Set(),
						planTranslateSet: expect.any(Set),
						noteTranslateSet: expect.any(Set),
						nonce: "mocknonce1234567=",
						pushAction: "jolli",
					}),
				);
			});

			it("handles non-Error rejection via String()", async () => {
				mockGetTranscriptHashes.mockRejectedValue("string git error");
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("Failed to load transcript hashes"),
					"string git error",
				);
				expect(mockBuildHtml).toHaveBeenCalledWith(
					summary,
					expect.objectContaining({ transcriptHashSet: new Set() }),
				);
			});
		});

		// ── refreshPlanTranslateSet: plan body read failure ──────────────────

		describe("refreshPlanTranslateSet body read failure", () => {
			it("skips plan when readPlanFromBranch throws", async () => {
				mockReadPlanFromBranch.mockRejectedValue(new Error("git error"));
				const summary = makeSummary({
					plans: [
						{
							slug: "err-plan",
							title: "English Title",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);

				// plan should NOT be in planTranslateSet because read failed
				expect(mockBuildHtml).toHaveBeenCalledWith(
					summary,
					expect.objectContaining({
						transcriptHashSet: expect.any(Set),
						planTranslateSet: new Set(),
						noteTranslateSet: expect.any(Set),
						nonce: "mocknonce1234567=",
						pushAction: "jolli",
					}),
				);
			});
		});

		// ── loadTranscriptStats: sessions without explicit source ────────────

		describe("loadTranscriptStats: sessions with missing source field", () => {
			it("treats sessions with no source as claude", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "s1",
									// No source field — should default to "claude"
									entries: [{ role: "human" as const, content: "Hello" }],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						sessionCounts: expect.objectContaining({ claude: 1 }),
					}),
				);
			});
		});

		// ── push with plans that have existing jolliPlanDocId ─────────────────

		describe("pushToJolli with existing plan docId", () => {
			it("includes docId in push call when plan has jolliPlanDocId", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockReadPlanFromBranch.mockResolvedValue("# Plan\n\nContent");
				mockPushToJolli.mockResolvedValue({ docId: 50 });
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "plan-a",
							title: "Plan A",
							editCount: 1,
							addedAt: "",
							updatedAt: "",
							jolliPlanDocId: 77,
						},
					],
				});

				dispatch({ command: "push" });
				await flushPromises();

				// First pushToJolli call should include docId: 77 for the plan
				expect(mockPushToJolli).toHaveBeenCalledWith(
					"https://my.jolli.app",
					"jk_valid",
					expect.objectContaining({ docId: 77, subFolder: "Plans & Notes" }),
				);
			});
		});

		// ── push with existing jolliDocId on summary ─────────────────────────

		describe("pushToJolli with existing jolliDocId", () => {
			it("includes docId in push call for summary update", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockResolvedValue({ docId: 42 });
				const dispatch = await setupPanel({ jolliDocId: 42 });

				dispatch({ command: "push" });
				await flushPromises();

				expect(mockPushToJolli).toHaveBeenCalledWith(
					"https://my.jolli.app",
					"jk_valid",
					expect.objectContaining({ docId: 42 }),
				);
			});
		});

		// ── plan push message pluralization ──────────────────────────────────

		describe("pushToJolli attachment message pluralization", () => {
			it("shows singular 'attachment' for one plan", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockReadPlanFromBranch.mockResolvedValue("# Plan\n\nContent");
				mockPushToJolli.mockResolvedValue({ docId: 50 });
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "p1",
							title: "P1",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "push" });
				await flushPromises();

				expect(showInformationMessage).toHaveBeenCalledWith(
					"Pushed on Jolli Space (with 1 attachment).",
				);
			});

			it("shows plural 'attachments' for multiple plans", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockReadPlanFromBranch.mockResolvedValue("# Plan\n\nContent");
				mockPushToJolli.mockResolvedValue({ docId: 50 });
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "p1",
							title: "P1",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
						{
							slug: "p2",
							title: "P2",
							editCount: 0,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "push" });
				await flushPromises();

				expect(showInformationMessage).toHaveBeenCalledWith(
					"Pushed on Jolli Space (with 2 attachments).",
				);
			});
		});

		// ── checkPrStatus error handling ─────────────────────────────────────

		describe("checkPrStatus error handling", () => {
			it("logs error when handleCheckPrStatus rejects", async () => {
				mockHandleCheckPrStatus.mockRejectedValue(new Error("pr check failed"));
				const dispatch = await setupPanel();

				dispatch({ command: "checkPrStatus" });
				await flushPromises();

				expect(logError).toHaveBeenCalledWith(
					"SummaryPanel",
					expect.stringContaining("pr check failed"),
				);
			});
		});

		// ── loadTranscriptStats error handling ──────────────────────────────

		describe("loadTranscriptStats error handling", () => {
			it("logs warning when load fails", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				mockReadTranscriptsForCommits.mockRejectedValue(
					new Error("read failed"),
				);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("Load transcript stats failed"),
					expect.any(String),
				);
			});

			it("logs warning with String() when rejection is not an Error", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				mockReadTranscriptsForCommits.mockRejectedValue("string rejection");

				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("Load transcript stats failed"),
					"string rejection",
				);
			});
		});

		// ── saveAllTranscripts with timestamp ────────────────────────────────

		describe("saveAllTranscripts preserves timestamps", () => {
			it("includes timestamps in saved transcripts when provided", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				mockReadTranscriptsForCommits.mockResolvedValue(
					new Map([
						[
							"abc123",
							{
								sessions: [
									{
										sessionId: "s1",
										source: "claude" as const,
										entries: [
											{
												role: "human" as const,
												content: "Old",
												timestamp: "2025-01-01T00:00:00Z",
											},
										],
									},
								],
							},
						],
					]),
				);
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({
					command: "saveAllTranscripts",
					entries: [
						{
							commitHash: "abc123",
							sessionId: "s1",
							source: "claude",
							originalIndex: 0,
							role: "human",
							content: "Edited",
							timestamp: "2025-01-01T12:00:00Z",
						},
					],
				});
				await flushPromises();

				expect(mockSaveTranscriptsBatch).toHaveBeenCalledWith(
					expect.arrayContaining([
						expect.objectContaining({
							data: expect.objectContaining({
								sessions: expect.arrayContaining([
									expect.objectContaining({
										entries: expect.arrayContaining([
											expect.objectContaining({
												timestamp: "2025-01-01T12:00:00Z",
											}),
										]),
									}),
								]),
							}),
						}),
					]),
					expect.any(Array),
					workspaceRoot,
				);
			});
		});

		// ── push with trailing slashes on base URL ───────────────────────────

		describe("pushToJolli trims trailing slashes from base URL", () => {
			it("removes trailing slashes from resolved base URL", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app///" });
				mockPushToJolli.mockResolvedValue({ docId: 42 });
				const dispatch = await setupPanel();

				dispatch({ command: "push" });
				await flushPromises();

				// pushToJolli should receive the base URL without trailing slashes
				expect(mockPushToJolli).toHaveBeenCalledWith(
					"https://my.jolli.app///",
					"jk_valid",
					expect.any(Object),
				);
			});
		});

		// ── push with non-Error throw in catchAndShow ────────────────────────

		describe("push error non-Error from catchAndShow", () => {
			it("catches non-Error thrown from pushToJolli and displays string", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockRejectedValue("string error");
				const dispatch = await setupPanel();

				dispatch({ command: "push" });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					"Push failed: string error",
				);
			});
		});

		// ── loadAllTranscripts with entries missing timestamps ────────────────

		describe("loadAllTranscripts with entries missing timestamps", () => {
			it("uses empty string for missing timestamps and transcriptPaths", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "s1",
									source: "claude" as const,
									// No transcriptPath
									entries: [
										{ role: "human" as const, content: "Q" },
										// No timestamp
									],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadAllTranscripts" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "allTranscriptsLoaded",
						entries: expect.arrayContaining([
							expect.objectContaining({
								transcriptPath: "",
								timestamp: "",
							}),
						]),
					}),
				);
			});
		});

		// ── saveAllTranscripts: entries without source and timestamp ──────────

		describe("saveAllTranscripts defaults", () => {
			it("defaults source to 'claude' when not provided in entries", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				mockReadTranscriptsForCommits.mockResolvedValue(
					new Map([
						[
							"abc123",
							{
								sessions: [
									{
										sessionId: "s1",
										entries: [{ role: "human" as const, content: "Old" }],
									},
								],
							},
						],
					]),
				);
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({
					command: "saveAllTranscripts",
					entries: [
						{
							commitHash: "abc123",
							sessionId: "s1",
							originalIndex: 0,
							role: "human",
							content: "Edited",
						},
					],
				});
				await flushPromises();

				expect(mockSaveTranscriptsBatch).toHaveBeenCalledWith(
					expect.arrayContaining([
						expect.objectContaining({
							data: expect.objectContaining({
								sessions: expect.arrayContaining([
									expect.objectContaining({ source: "claude" }),
								]),
							}),
						}),
					]),
					expect.any(Array),
					workspaceRoot,
				);
			});
		});

		// ── saveAllTranscripts: no writes and no deletes ─────────────────────

		describe("saveAllTranscripts no-op", () => {
			it("skips saveTranscriptsBatch when writes and deletes are both empty", async () => {
				// transcriptHashSet is empty, so no commits to process
				const dispatch = await setupPanel();
				mockSaveTranscriptsBatch.mockClear();

				dispatch({ command: "saveAllTranscripts", entries: [] });
				await flushPromises();

				// With empty transcriptHashSet, no writes or deletes are generated
				expect(mockSaveTranscriptsBatch).not.toHaveBeenCalled();
			});
		});

		// ── saveSnippet ──────────────────────────────────────────────────────

		describe("saveSnippet", () => {
			it("saves snippet, archives it, stores summary, and posts snippetSaved", async () => {
				mockSaveNote.mockResolvedValue({
					id: "snip-1",
					title: "My Snippet",
					format: "snippet",
				});
				mockArchiveNoteForCommit.mockResolvedValue({
					id: "snip-1",
					title: "My Snippet",
					format: "snippet" as const,
					content: "snippet content",
					addedAt: "2025-01-01",
					updatedAt: "2025-01-01",
				});
				const dispatch = await setupPanel();

				dispatch({
					command: "saveSnippet",
					title: "My Snippet",
					content: "snippet content",
				});
				await flushPromises();

				expect(mockSaveNote).toHaveBeenCalledWith(
					undefined,
					"My Snippet",
					"snippet content",
					"snippet",
					workspaceRoot,
				);
				expect(mockArchiveNoteForCommit).toHaveBeenCalledWith(
					"snip-1",
					"abc123",
					workspaceRoot,
				);
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: expect.arrayContaining([
							expect.objectContaining({ id: "snip-1" }),
						]),
					}),
					workspaceRoot,
					true,
				);
				expect(postMessage).toHaveBeenCalledWith({ command: "snippetSaved" });
			});

			it("appends to existing notes when summary already has notes", async () => {
				mockSaveNote.mockResolvedValue({
					id: "snip-2",
					title: "New Snippet",
					format: "snippet",
				});
				mockArchiveNoteForCommit.mockResolvedValue({
					id: "snip-2",
					title: "New Snippet",
					format: "snippet" as const,
					content: "new content",
					addedAt: "2025-01-01",
					updatedAt: "2025-01-01",
				});
				const dispatch = await setupPanel({
					notes: [
						{
							id: "existing-1",
							title: "Existing Note",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({
					command: "saveSnippet",
					title: "New Snippet",
					content: "new content",
				});
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: expect.arrayContaining([
							expect.objectContaining({ id: "existing-1" }),
							expect.objectContaining({ id: "snip-2" }),
						]),
					}),
					workspaceRoot,
					true,
				);
			});

			it("refreshes noteTranslateSet before rendering after adding CJK snippet", async () => {
				mockSaveNote.mockResolvedValue({
					id: "cn-snip",
					title: "中文片段",
					format: "snippet",
				});
				mockArchiveNoteForCommit.mockResolvedValue({
					id: "cn-snip",
					title: "中文片段",
					format: "snippet" as const,
					content: "中文内容",
					addedAt: "2025-01-01",
					updatedAt: "2025-01-01",
				});
				const dispatch = await setupPanel();
				vi.clearAllMocks();

				dispatch({
					command: "saveSnippet",
					title: "中文片段",
					content: "中文内容",
				});
				await flushPromises();

				// buildHtml should be called with noteTranslateSet containing the new CJK note
				expect(mockBuildHtml).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({
						noteTranslateSet: new Set(["cn-snip"]),
					}),
				);
			});

			it("shows error when archiveNoteForCommit returns null", async () => {
				mockSaveNote.mockResolvedValue({
					id: "snip-fail",
					title: "Fail",
					format: "snippet",
				});
				mockArchiveNoteForCommit.mockResolvedValue(null);
				const dispatch = await setupPanel();

				dispatch({ command: "saveSnippet", title: "Fail", content: "content" });
				await flushPromises();

				expect(mockIgnoreNote).toHaveBeenCalledWith("snip-fail", workspaceRoot);
				expect(showErrorMessage).toHaveBeenCalledWith(
					"Failed to save snippet — archive failed.",
				);
				expect(mockStoreSummary).not.toHaveBeenCalled();
			});

			it("returns early when currentSummary is null", async () => {
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();
				const panelInstance = firstCommitPanel<{ currentSummary: null }>();
				panelInstance.currentSummary = null;
				vi.clearAllMocks();

				dispatch({
					command: "saveSnippet",
					title: "Snippet",
					content: "content",
				});
				await flushPromises();

				expect(mockSaveNote).not.toHaveBeenCalled();
			});

			it("shows error message when snippet content is empty or whitespace-only", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "saveSnippet", title: "Empty", content: "   " });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Snippet content is required"),
				);
				expect(mockSaveNote).not.toHaveBeenCalled();
			});
		});

		// ── addMarkdownNote ──────────────────────────────────────────────────

		describe("addMarkdownNote", () => {
			it("saves markdown note, archives it, and stores updated summary", async () => {
				mockSaveNote.mockResolvedValue({
					id: "md-1",
					title: "Imported Note",
					format: "markdown",
				});
				mockArchiveNoteForCommit.mockResolvedValue({
					id: "md-1",
					title: "Imported Note",
					format: "markdown",
					addedAt: "2025-01-01",
					updatedAt: "2025-01-01",
				});
				showOpenDialog.mockResolvedValue([{ fsPath: "/path/to/note.md" }]);
				const dispatch = await setupPanel();

				dispatch({ command: "addMarkdownNote" });
				await flushPromises();

				expect(showOpenDialog).toHaveBeenCalledWith(
					expect.objectContaining({ canSelectMany: false }),
				);
				expect(mockSaveNote).toHaveBeenCalledWith(
					undefined,
					"",
					"/path/to/note.md",
					"markdown",
					workspaceRoot,
				);
				expect(mockArchiveNoteForCommit).toHaveBeenCalledWith(
					"md-1",
					expect.any(String),
					workspaceRoot,
				);
				expect(mockStoreSummary).toHaveBeenCalled();
			});

			it("refreshes noteTranslateSet before rendering after adding CJK markdown note", async () => {
				mockSaveNote.mockResolvedValue({
					id: "cn-md",
					title: "中文笔记",
					format: "markdown",
				});
				mockArchiveNoteForCommit.mockResolvedValue({
					id: "cn-md",
					title: "中文笔记",
					format: "markdown" as const,
					addedAt: "2025-01-01",
					updatedAt: "2025-01-01",
				});
				showOpenDialog.mockResolvedValue([{ fsPath: "/path/to/中文.md" }]);
				const dispatch = await setupPanel();
				vi.clearAllMocks();

				dispatch({ command: "addMarkdownNote" });
				await flushPromises();

				expect(mockBuildHtml).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({
						noteTranslateSet: new Set(["cn-md"]),
					}),
				);
			});

			it("does nothing when user cancels file dialog", async () => {
				showOpenDialog.mockResolvedValue(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "addMarkdownNote" });
				await flushPromises();

				expect(mockSaveNote).not.toHaveBeenCalled();
			});

			it("does nothing when file dialog returns empty array", async () => {
				showOpenDialog.mockResolvedValue([]);
				const dispatch = await setupPanel();

				dispatch({ command: "addMarkdownNote" });
				await flushPromises();

				expect(mockSaveNote).not.toHaveBeenCalled();
			});

			it("shows error when archive fails", async () => {
				mockSaveNote.mockResolvedValue({
					id: "md-fail",
					title: "Fail",
					format: "markdown",
				});
				mockArchiveNoteForCommit.mockResolvedValue(null);
				showOpenDialog.mockResolvedValue([{ fsPath: "/path/to/note.md" }]);
				const dispatch = await setupPanel();

				dispatch({ command: "addMarkdownNote" });
				await flushPromises();

				expect(mockIgnoreNote).toHaveBeenCalledWith("md-fail", workspaceRoot);
				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("archive failed"),
				);
			});

			it("does nothing when currentSummary is null", async () => {
				showOpenDialog.mockResolvedValue([{ fsPath: "/path/to/note.md" }]);
				const dispatch = await setupPanel();
				const panel = firstCommitPanel<{ currentSummary: unknown }>();
				panel.currentSummary = null;
				vi.clearAllMocks();

				dispatch({ command: "addMarkdownNote" });
				await flushPromises();

				expect(showOpenDialog).not.toHaveBeenCalled();
			});
		});

		// ── loadNoteContent ──────────────────────────────────────────────────

		describe("loadNoteContent", () => {
			it("loads snippet content inline without reading from branch", async () => {
				const dispatch = await setupPanel({
					notes: [
						{
							id: "snip-1",
							title: "Snippet",
							format: "snippet" as const,
							content: "inline content",
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({
					command: "loadNoteContent",
					id: "snip-1",
					format: "snippet",
				});
				await flushPromises();

				expect(mockReadNoteFromBranch).not.toHaveBeenCalled();
				expect(postMessage).toHaveBeenCalledWith({
					command: "noteContentLoaded",
					id: "snip-1",
					content: "inline content",
				});
			});

			it("reads markdown content from orphan branch", async () => {
				mockReadNoteFromBranch.mockResolvedValue("# Markdown Content");
				const dispatch = await setupPanel({
					notes: [
						{
							id: "md-1",
							title: "Markdown",
							format: "markdown" as const,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({
					command: "loadNoteContent",
					id: "md-1",
					format: "markdown",
				});
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({
					command: "noteContentLoaded",
					id: "md-1",
					content: "# Markdown Content",
				});
			});

			it("shows error when note content cannot be read", async () => {
				mockReadNoteFromBranch.mockResolvedValue(null);
				const dispatch = await setupPanel({
					notes: [
						{
							id: "bad-1",
							title: "Bad Note",
							format: "markdown" as const,
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({
					command: "loadNoteContent",
					id: "bad-1",
					format: "markdown",
				});
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Could not read note"),
				);
			});

			it("does nothing when note id is not found", async () => {
				const dispatch = await setupPanel({ notes: [] });

				dispatch({
					command: "loadNoteContent",
					id: "nonexistent",
					format: "markdown",
				});
				await flushPromises();

				expect(mockReadNoteFromBranch).not.toHaveBeenCalled();
			});
		});

		// ── saveNote (edit) ──────────────────────────────────────────────────

		describe("saveNote (edit)", () => {
			it("skips summary sync when currentSummary has no notes (race)", async () => {
				// Covers `if (this.currentSummary?.notes)` falsy branch in handleSaveNote.
				// A panel opened for a summary without a notes array simulates the race.
				const dispatch = await setupPanel({});
				// Null out .notes on the live panel to force the falsy branch.
				const panel = firstCommitPanel<{
					currentSummary: { notes?: unknown } | undefined;
				}>();
				if (panel.currentSummary) {
					delete panel.currentSummary.notes;
				}

				dispatch({
					command: "saveNote",
					id: "any",
					content: "# New",
					format: "markdown",
				});
				await flushPromises();

				// Writes still go through, but no storeSummary call happened.
				expect(mockStoreNotes).toHaveBeenCalled();
				expect(mockStoreSummary).not.toHaveBeenCalled();
				expect(postMessage).toHaveBeenCalledWith({
					command: "noteSaved",
					id: "any",
				});
			});

			it("saves note content to orphan branch and updates summary", async () => {
				const dispatch = await setupPanel({
					notes: [
						{
							id: "edit-1",
							title: "Old Title",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({
					command: "saveNote",
					id: "edit-1",
					content: "# New Title\n\nUpdated body",
					format: "markdown",
				});
				await flushPromises();

				expect(mockStoreNotes).toHaveBeenCalledWith(
					[{ id: "edit-1", content: "# New Title\n\nUpdated body" }],
					expect.stringContaining("Edit note"),
					workspaceRoot,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "noteSaved",
					id: "edit-1",
				});
			});

			it("updates snippet content inline in the summary", async () => {
				const dispatch = await setupPanel({
					notes: [
						{
							id: "snip-edit",
							title: "Snippet",
							format: "snippet" as const,
							content: "old content",
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({
					command: "saveNote",
					id: "snip-edit",
					content: "new content",
					format: "snippet",
				});
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: [
							expect.objectContaining({
								id: "snip-edit",
								content: "new content",
							}),
						],
					}),
					workspaceRoot,
					true,
				);
			});

			it("leaves non-matching notes unchanged when saving a specific note", async () => {
				const dispatch = await setupPanel({
					notes: [
						{
							id: "other-note",
							title: "Other Note",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
						{
							id: "target-note",
							title: "Target Note",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({
					command: "saveNote",
					id: "target-note",
					content: "# Updated Title\n\nNew body",
					format: "markdown",
				});
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: [
							expect.objectContaining({
								id: "other-note",
								title: "Other Note",
							}),
							expect.objectContaining({
								id: "target-note",
								title: "Updated Title",
							}),
						],
					}),
					workspaceRoot,
					true,
				);
			});

			it("does not update title when content has no heading", async () => {
				const dispatch = await setupPanel({
					notes: [
						{
							id: "no-heading",
							title: "Original Title",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({
					command: "saveNote",
					id: "no-heading",
					content: "Just plain text without a heading",
					format: "markdown",
				});
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: [
							expect.objectContaining({
								id: "no-heading",
								title: "Original Title",
							}),
						],
					}),
					workspaceRoot,
					true,
				);
			});
		});

		// ── previewNote ─────────────────────────────────────────────────────

		describe("previewNote", () => {
			it("opens note preview via vscode command", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "previewNote", id: "note-1", title: "Note Title" });
				await flushPromises();

				expect(executeCommand).toHaveBeenCalledWith(
					"jollimemory.previewNote",
					"note-1",
					"Note Title",
				);
			});
		});

		// ── translateNote ────────────────────────────────────────────────────

		describe("translateNote", () => {
			it("translates note content and updates summary", async () => {
				mockReadNoteFromBranch.mockResolvedValue("# 中文笔记\n\n内容");
				mockTranslateToEnglish.mockResolvedValue(
					"# Translated Note\n\nEnglish content",
				);
				const dispatch = await setupPanel({
					notes: [
						{
							id: "cn-note",
							title: "中文笔记",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "translateNote", id: "cn-note" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({
					command: "noteTranslating",
					id: "cn-note",
				});
				expect(mockTranslateToEnglish).toHaveBeenCalled();
				expect(mockStoreNotes).toHaveBeenCalledWith(
					[{ id: "cn-note", content: "# Translated Note\n\nEnglish content" }],
					expect.stringContaining("Translate note"),
					workspaceRoot,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "noteTranslated",
					id: "cn-note",
				});
				// Toast should show the translated title, not the original CJK title
				expect(showInformationMessage).toHaveBeenCalledWith(
					'Note "Translated Note" has been translated to English.',
				);
			});

			it("shows info message when note is already in English", async () => {
				mockReadNoteFromBranch.mockResolvedValue(
					"# English Note\n\nAll English content",
				);
				const dispatch = await setupPanel({
					notes: [
						{
							id: "en-note",
							title: "English Note",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "translateNote", id: "en-note" });
				await flushPromises();

				expect(showInformationMessage).toHaveBeenCalledWith(
					"Note is already in English.",
				);
				expect(mockTranslateToEnglish).not.toHaveBeenCalled();
			});

			it("shows error when note content cannot be read", async () => {
				mockReadNoteFromBranch.mockResolvedValue(null);
				const dispatch = await setupPanel({
					notes: [
						{
							id: "bad-note",
							title: "Bad Note",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "translateNote", id: "bad-note" });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Could not read note"),
				);
			});

			it("translates snippet note using inline content", async () => {
				mockTranslateToEnglish.mockResolvedValue("Translated snippet");
				const dispatch = await setupPanel({
					notes: [
						{
							id: "snippet-cn",
							title: "中文片段",
							format: "snippet" as const,
							content: "中文内容",
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "translateNote", id: "snippet-cn" });
				await flushPromises();

				// Should NOT read from branch — uses inline content
				expect(mockReadNoteFromBranch).not.toHaveBeenCalled();
				expect(mockTranslateToEnglish).toHaveBeenCalledWith(
					expect.objectContaining({ content: "中文内容" }),
				);
			});

			it("does nothing when note id is not found in summary", async () => {
				const dispatch = await setupPanel({ notes: [] });

				dispatch({ command: "translateNote", id: "nonexistent" });
				await flushPromises();

				expect(mockReadNoteFromBranch).not.toHaveBeenCalled();
				expect(mockTranslateToEnglish).not.toHaveBeenCalled();
			});

			it("leaves non-matching notes unchanged when translating a specific note", async () => {
				mockReadNoteFromBranch.mockResolvedValue("# 中文笔记\n\n内容");
				mockTranslateToEnglish.mockResolvedValue(
					"# Translated Note\n\nEnglish content",
				);
				const dispatch = await setupPanel({
					notes: [
						{
							id: "unrelated-note",
							title: "Unrelated",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
						{
							id: "cn-target",
							title: "中文笔记",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "translateNote", id: "cn-target" });
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: [
							expect.objectContaining({
								id: "unrelated-note",
								title: "Unrelated",
							}),
							expect.objectContaining({
								id: "cn-target",
								title: "Translated Note",
							}),
						],
					}),
					workspaceRoot,
					true,
				);
			});

			it("updates snippet content inline when translating a snippet with multiple notes", async () => {
				mockTranslateToEnglish.mockResolvedValue("Translated snippet content");
				const dispatch = await setupPanel({
					notes: [
						{
							id: "other-md",
							title: "Other Note",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
						{
							id: "cn-snippet",
							title: "中文片段",
							format: "snippet" as const,
							content: "中文内容",
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "translateNote", id: "cn-snippet" });
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: [
							expect.objectContaining({ id: "other-md", title: "Other Note" }),
							expect.objectContaining({
								id: "cn-snippet",
								content: "Translated snippet content",
							}),
						],
					}),
					workspaceRoot,
					true,
				);
			});
		});

		describe("translateNote gracefully handles cleared currentSummary", () => {
			it("skips summary update when currentSummary is cleared during translation", async () => {
				mockReadNoteFromBranch.mockResolvedValue("# 中文\n正文");
				mockTranslateToEnglish.mockResolvedValue("# English\nBody");
				const dispatch = await setupPanel({
					notes: [
						{
							id: "cn-1",
							title: "中文",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				// storeNotes side-effect: clears currentSummary to simulate concurrent panel disposal
				mockStoreNotes.mockImplementation(() => {
					const panelInstance = firstCommitPanel<{ currentSummary: null }>();
					panelInstance.currentSummary = null;
				});

				dispatch({ command: "translateNote", id: "cn-1" });
				await flushPromises();

				// storeNotes was called (translation happened)
				expect(mockStoreNotes).toHaveBeenCalled();
				// storeSummary should NOT be called since currentSummary?.notes is null
				expect(mockStoreSummary).not.toHaveBeenCalled();
				// Falls back to noteRef.title since currentSummary is null at line 1284
				expect(showInformationMessage).toHaveBeenCalledWith(
					expect.stringContaining("中文"),
				);

				// Reset mock to default
				mockStoreNotes.mockResolvedValue(undefined);
			});
		});

		// ── removeNote ───────────────────────────────────────────────────────

		describe("removeNote", () => {
			it("confirms and removes note from commit", async () => {
				showWarningMessage.mockResolvedValue("Remove");
				const dispatch = await setupPanel({
					notes: [
						{
							id: "note-a",
							title: "Note A",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
						{
							id: "note-b",
							title: "Note B",
							format: "snippet" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "removeNote", id: "note-a", title: "Note A" });
				await flushPromises();

				expect(showWarningMessage).toHaveBeenCalledWith(
					'Remove note "Note A" from this commit?',
					{ modal: true },
					"Remove",
				);
				expect(mockUnassociateNoteFromCommit).toHaveBeenCalledWith(
					"note-a",
					workspaceRoot,
				);
				// Must also mark as ignored so the note doesn't reappear in the sidebar
				expect(mockIgnoreNote).toHaveBeenCalledWith("note-a", workspaceRoot);
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: [expect.objectContaining({ id: "note-b" })],
					}),
					workspaceRoot,
					true,
				);
			});

			it("clears notes field when last note is removed", async () => {
				showWarningMessage.mockResolvedValue("Remove");
				const dispatch = await setupPanel({
					notes: [
						{
							id: "only-note",
							title: "Only",
							format: "snippet" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "removeNote", id: "only-note", title: "Only" });
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ notes: undefined }),
					workspaceRoot,
					true,
				);
			});

			it("does nothing when user cancels", async () => {
				showWarningMessage.mockResolvedValue(undefined);
				const dispatch = await setupPanel({
					notes: [
						{
							id: "note-a",
							title: "Note A",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "removeNote", id: "note-a", title: "Note A" });
				await flushPromises();

				expect(mockUnassociateNoteFromCommit).not.toHaveBeenCalled();
				expect(mockStoreSummary).not.toHaveBeenCalled();
			});

			it("returns early when summary has no notes", async () => {
				const dispatch = await setupPanel(); // no notes
				vi.clearAllMocks();

				dispatch({ command: "removeNote", id: "note-a", title: "Note A" });
				await flushPromises();

				expect(showWarningMessage).not.toHaveBeenCalled();
			});
		});

		// ── applyNoteUrls (via pushToJolli with notes) ───────────────────────

		describe("pushToJolli with snippet notes", () => {
			it("pushes each snippet note as a separate article", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				let docIdCounter = 77;
				mockPushToJolli.mockImplementation(() =>
					Promise.resolve({ docId: docIdCounter++ }),
				);
				const dispatch = await setupPanel({
					notes: [
						{
							id: "snip-1",
							title: "Snippet One",
							format: "snippet" as const,
							content: "First snippet",
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
						{
							id: "snip-2",
							title: "Snippet Two",
							format: "snippet" as const,
							content: "Second snippet",
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "push" });
				await flushPromises();

				// pushToJolli: once per snippet + once for summary = 3 total
				expect(mockPushToJolli).toHaveBeenCalledTimes(3);
				const noteCalls = mockPushToJolli.mock.calls.filter(
					(c: Array<unknown>) =>
						(c[2] as { subFolder?: string })?.subFolder === "Plans & Notes",
				);
				expect(noteCalls).toHaveLength(2);
				expect((noteCalls[0][2] as { content: string }).content).toBe(
					"First snippet",
				);
				expect((noteCalls[1][2] as { content: string }).content).toBe(
					"Second snippet",
				);

				// storeSummary should have each snippet note with its own docId/URL
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: expect.arrayContaining([
							expect.objectContaining({
								id: "snip-1",
								jolliNoteDocUrl: expect.stringContaining("doc=77"),
							}),
							expect.objectContaining({
								id: "snip-2",
								jolliNoteDocUrl: expect.stringContaining("doc=78"),
							}),
						]),
					}),
					workspaceRoot,
					true,
				);
			});
		});

		// ── downloadMarkdown ─────────────────────────────────────────────────────

		describe("downloadMarkdown", () => {
			/** Creates a panel, clears currentSummary, and returns the dispatch function. */
			async function setupPanelWithoutSummary(): Promise<
				(msg: Record<string, unknown>) => void
			> {
				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();
				const panelInstance = firstCommitPanel<{ currentSummary: null }>();
				panelInstance.currentSummary = null;
				vi.clearAllMocks();
				return dispatch;
			}

			it("returns early when currentSummary is null", async () => {
				const dispatch = await setupPanelWithoutSummary();

				dispatch({ command: "downloadMarkdown" });
				await flushPromises();

				expect(showSaveDialog).not.toHaveBeenCalled();
				expect(fsWriteFile).not.toHaveBeenCalled();
			});

			it("returns early when showSaveDialog returns undefined (user cancels)", async () => {
				showSaveDialog.mockResolvedValue(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "downloadMarkdown" });
				await flushPromises();

				expect(showSaveDialog).toHaveBeenCalled();
				expect(fsWriteFile).not.toHaveBeenCalled();
				expect(showInformationMessage).not.toHaveBeenCalled();
			});

			it("writes markdown to file and shows info message", async () => {
				const mockUri = { fsPath: "/workspace/Panel-Title.md" };
				showSaveDialog.mockResolvedValue(mockUri);
				mockBuildMarkdown.mockReturnValue("# Markdown Output");
				fsWriteFile.mockResolvedValue(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "downloadMarkdown" });
				await flushPromises();

				expect(showSaveDialog).toHaveBeenCalledWith(
					expect.objectContaining({
						filters: { Markdown: ["md"] },
						title: "Save Summary as Markdown",
					}),
				);
				expect(fsWriteFile).toHaveBeenCalledWith(mockUri, expect.any(Buffer));
				expect(showInformationMessage).toHaveBeenCalledWith(
					`Saved to ${mockUri.fsPath}`,
				);
			});
		});

		// ── saveSnippet: empty content ────────────────────────────────────────────

		describe("saveSnippet: empty content", () => {
			it("shows error when snippet content is empty/whitespace-only", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "saveSnippet", title: "T", content: "   " });
				await flushPromises();

				expect(mockSaveNote).not.toHaveBeenCalled();
				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Save snippet failed"),
				);
			});
		});

		// ── saveNote: multiple notes (n.id !== id branch) ────────────────────────

		describe("saveNote: multiple notes", () => {
			it("preserves other notes unchanged when editing one of multiple notes", async () => {
				const dispatch = await setupPanel({
					notes: [
						{
							id: "edit-1",
							title: "First Note",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
						{
							id: "other-note",
							title: "Other Note",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({
					command: "saveNote",
					id: "edit-1",
					content: "# Updated Title\n\nBody",
					format: "markdown",
				});
				await flushPromises();

				// The second note (id !== "edit-1") is returned unchanged via the else branch
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: expect.arrayContaining([
							expect.objectContaining({
								id: "other-note",
								title: "Other Note",
							}),
							expect.objectContaining({ id: "edit-1", title: "Updated Title" }),
						]),
					}),
					workspaceRoot,
					true,
				);
			});

			it("does not update title when note content has no # heading", async () => {
				const dispatch = await setupPanel({
					notes: [
						{
							id: "edit-1",
							title: "Original Title",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({
					command: "saveNote",
					id: "edit-1",
					content: "No heading here",
					format: "markdown",
				});
				await flushPromises();

				// newTitle is falsy, so title should remain unchanged
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: expect.arrayContaining([
							expect.objectContaining({
								id: "edit-1",
								title: "Original Title",
							}),
						]),
					}),
					workspaceRoot,
					true,
				);
			});
		});

		// ── translateNote: multiple notes (n.id !== id branch) ───────────────────

		describe("translateNote: multiple notes", () => {
			it("preserves other notes unchanged when translating one of multiple notes", async () => {
				mockReadNoteFromBranch.mockResolvedValue("# 中文笔记\n\n内容");
				mockTranslateToEnglish.mockResolvedValue(
					"# Translated Note\n\nEnglish content",
				);
				const dispatch = await setupPanel({
					notes: [
						{
							id: "cn-note",
							title: "中文笔记",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
						{
							id: "other-note",
							title: "Other Note",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "translateNote", id: "cn-note" });
				await flushPromises();

				// The second note (id !== "cn-note") is returned unchanged via the n.id !== id branch
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: expect.arrayContaining([
							expect.objectContaining({
								id: "other-note",
								title: "Other Note",
							}),
							expect.objectContaining({
								id: "cn-note",
								title: "Translated Note",
							}),
						]),
					}),
					workspaceRoot,
					true,
				);
			});

			it("does not update title when translated content has no # heading", async () => {
				mockReadNoteFromBranch.mockResolvedValue("# 中文笔记\n\n内容");
				// Translation result has no # heading, so newTitle should be falsy
				mockTranslateToEnglish.mockResolvedValue(
					"Translated content without heading",
				);
				const dispatch = await setupPanel({
					notes: [
						{
							id: "cn-note",
							title: "中文笔记",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "translateNote", id: "cn-note" });
				await flushPromises();

				// newTitle is falsy — title remains unchanged, no title update applied
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: expect.arrayContaining([
							expect.objectContaining({ id: "cn-note", title: "中文笔记" }),
						]),
					}),
					workspaceRoot,
					true,
				);
			});
		});

		// ── openCodeEnabled: false ────────────────────────────────────────────────

		describe("loadTranscriptStats: openCodeEnabled false", () => {
			it("excludes opencode sessions when openCodeEnabled is false", async () => {
				mockLoadConfig.mockResolvedValue({
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					openCodeEnabled: false,
				});
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "s1",
									source: "claude" as const,
									entries: [{ role: "human" as const, content: "A" }],
								},
								{
									sessionId: "oc1",
									source: "opencode" as const,
									entries: [
										{ role: "human" as const, content: "B" },
										{ role: "assistant" as const, content: "C" },
									],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				// opencode session (oc1) should be excluded; only claude session counted
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						totalEntries: 1,
						sessionCounts: expect.objectContaining({ claude: 1 }),
					}),
				);
			});
		});

		// ── loadNoteContent: snippet without inline content ───────────────────────

		describe("loadNoteContent: snippet without inline content", () => {
			it("reads from orphan branch when snippet has no inline content", async () => {
				mockReadNoteFromBranch.mockResolvedValue("snippet body from branch");
				const dispatch = await setupPanel({
					notes: [
						{
							id: "snip-empty",
							title: "Empty Snippet",
							format: "snippet" as const,
							// content is intentionally absent to exercise the else branch (line 948)
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({
					command: "loadNoteContent",
					id: "snip-empty",
					format: "snippet",
				});
				await flushPromises();

				// Since content is undefined, it falls through to the else branch and reads from branch
				expect(mockReadNoteFromBranch).toHaveBeenCalledWith(
					"snip-empty",
					workspaceRoot,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "noteContentLoaded",
					id: "snip-empty",
					content: "snippet body from branch",
				});
			});
		});

		describe("pushToJolli with notes (exercises applyNoteUrls)", () => {
			it("merges published note URLs into summary notes", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockReadNoteFromBranch.mockResolvedValue("# Note Content\n\nBody");
				mockPushToJolli.mockResolvedValue({ docId: 55 });
				const dispatch = await setupPanel({
					notes: [
						{
							id: "md-note-1",
							title: "Markdown Note",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "push" });
				await flushPromises();

				// pushToJolli called twice: once for the note, once for the summary
				expect(mockPushToJolli).toHaveBeenCalledTimes(2);
				// storeSummary should contain note with updated jolliNoteDocUrl and jolliNoteDocId
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: expect.arrayContaining([
							expect.objectContaining({
								id: "md-note-1",
								jolliNoteDocUrl: "https://my.jolli.app/articles?doc=55",
								jolliNoteDocId: 55,
							}),
						]),
					}),
					workspaceRoot,
					true,
				);
			});

			it("returns notes unchanged when noteUrls is empty (no notes pushed)", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				// readNoteFromBranch returns null so no note is pushed
				mockReadNoteFromBranch.mockResolvedValue(null);
				mockPushToJolli.mockResolvedValue({ docId: 42 });
				const dispatch = await setupPanel({
					notes: [
						{
							id: "md-note-1",
							title: "Empty Note",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "push" });
				await flushPromises();

				// Only summary push, no note push
				expect(mockPushToJolli).toHaveBeenCalledTimes(1);
				// storeSummary should NOT have jolliNoteDocUrl on the note (no noteUrls applied)
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						jolliDocUrl: "https://my.jolli.app/articles?doc=42",
					}),
					workspaceRoot,
					true,
				);
			});

			it("returns notes unchanged when notes is undefined", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				mockPushToJolli.mockResolvedValue({ docId: 42 });
				const dispatch = await setupPanel(); // no notes

				dispatch({ command: "push" });
				await flushPromises();

				// storeSummary should not contain notes field from applyNoteUrls
				const storedSummary = mockStoreSummary.mock.calls[0][0] as Record<
					string,
					unknown
				>;
				expect(storedSummary.notes).toBeUndefined();
			});

			it("maps URLs onto matching notes by id (some match, some do not)", async () => {
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
				// First two calls consumed by refreshNoteTranslateSet during show();
				// next two are the actual reads during pushToJolli
				mockReadNoteFromBranch
					.mockResolvedValueOnce(null) // refreshNoteTranslateSet: note-a
					.mockResolvedValueOnce(null) // refreshNoteTranslateSet: note-b
					.mockResolvedValueOnce("# Note A\n\nContent") // pushToJolli: note-a
					.mockResolvedValueOnce(null); // pushToJolli: note-b (skipped)
				mockPushToJolli.mockResolvedValue({ docId: 60 });
				const dispatch = await setupPanel({
					notes: [
						{
							id: "note-a",
							title: "Note A",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
						{
							id: "note-b",
							title: "Note B",
							format: "markdown" as const,
							addedAt: "2025-01-01",
							updatedAt: "2025-01-01",
						},
					],
				});

				dispatch({ command: "push" });
				await flushPromises();

				// storeSummary should have note-a with URL and note-b without
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: expect.arrayContaining([
							expect.objectContaining({
								id: "note-a",
								jolliNoteDocUrl: "https://my.jolli.app/articles?doc=60",
								jolliNoteDocId: 60,
							}),
							expect.objectContaining({ id: "note-b" }),
						]),
					}),
					workspaceRoot,
					true,
				);
				// note-b should NOT have jolliNoteDocUrl
				const storedSummary = mockStoreSummary.mock.calls[0][0] as {
					notes: Array<{ id: string; jolliNoteDocUrl?: string }>;
				};
				const noteB = storedSummary.notes.find((n) => n.id === "note-b");
				expect(noteB?.jolliNoteDocUrl).toBeUndefined();
			});
		});
	});

	// ── Internal helpers (summariesEqual / setsEqual) ────────────────────────
	describe("internal helpers", () => {
		it("summariesEqual returns false when a is undefined", async () => {
			const { __test__ } = await import("./SummaryWebviewPanel.js");
			const b = { commitHash: "h" } as never;
			expect(__test__.summariesEqual(undefined, b)).toBe(false);
		});

		it("summariesEqual returns true for deep-equal summaries", async () => {
			const { __test__ } = await import("./SummaryWebviewPanel.js");
			const a = { commitHash: "h", commitMessage: "m" } as never;
			const b = { commitHash: "h", commitMessage: "m" } as never;
			expect(__test__.summariesEqual(a, b)).toBe(true);
		});

		it("summariesEqual returns false for different summaries", async () => {
			const { __test__ } = await import("./SummaryWebviewPanel.js");
			const a = { commitHash: "h", commitMessage: "m1" } as never;
			const b = { commitHash: "h", commitMessage: "m2" } as never;
			expect(__test__.summariesEqual(a, b)).toBe(false);
		});

		it("setsEqual returns true for identical sets", async () => {
			const { __test__ } = await import("./SummaryWebviewPanel.js");
			expect(__test__.setsEqual(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(
				true,
			);
		});

		it("setsEqual returns false when sizes differ", async () => {
			const { __test__ } = await import("./SummaryWebviewPanel.js");
			expect(__test__.setsEqual(new Set(["a"]), new Set(["a", "b"]))).toBe(
				false,
			);
		});

		it("setsEqual returns false when same-size sets have different members", async () => {
			const { __test__ } = await import("./SummaryWebviewPanel.js");
			expect(__test__.setsEqual(new Set(["a"]), new Set(["b"]))).toBe(false);
		});
	});
});
