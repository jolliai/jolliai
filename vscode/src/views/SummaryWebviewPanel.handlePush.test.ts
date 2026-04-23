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
}));

vi.mock("../util/Logger.js", () => ({
	log: { info, warn, error: logError },
}));

const { mockBuildHtml, mockBuildE2eTestSection, mockRenderTopic } = vi.hoisted(
	() => ({
		mockBuildHtml: vi.fn().mockReturnValue("<html>mock</html>"),
		mockBuildE2eTestSection: vi.fn().mockReturnValue("<div>e2e</div>"),
		mockRenderTopic: vi.fn().mockReturnValue("<div>topic</div>"),
	}),
);

vi.mock("./SummaryHtmlBuilder.js", () => ({
	buildHtml: mockBuildHtml,
	buildE2eTestSection: mockBuildE2eTestSection,
	renderTopic: mockRenderTopic,
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

/** Creates a panel with a summary and returns the message dispatch function. */
async function setupPanel(
	overrides?: Partial<CommitSummary>,
): Promise<(msg: Record<string, unknown>) => void> {
	const summary = makeSummary(overrides);
	await SummaryWebviewPanel.show(summary, extensionUri, workspaceRoot);
	return captureMessageHandler();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SummaryWebviewPanel handlePush", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset the static singleton so each test starts fresh
		(
			SummaryWebviewPanel as unknown as { currentMemoryPanel: undefined }
		).currentMemoryPanel = undefined;
		(
			SummaryWebviewPanel as unknown as { commitPanels: Map<string, unknown> }
		).commitPanels.clear();
		// Default config returns pushAction: "jolli" (Jolli-only)
		mockLoadConfig.mockResolvedValue({
			apiKey: "test-key",
			model: "test-model",
		});
		mockExistsSync.mockReturnValue(true);
	});

	// ── Test 1 ───────────────────────────────────────────────────────────────

	describe("pushAction = 'jolli' runs Jolli only", () => {
		it("calls pushToJolli and never calls pushSummaryToLocal", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "jolli",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 99 });
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			// Jolli push was executed
			expect(mockPushToJolli).toHaveBeenCalled();
			// Local push was NOT executed
			expect(mockCorePushSummaryToLocal).not.toHaveBeenCalled();
			// pushToJolliResult posted with success
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: true,
				}),
			);
			// pushToLocalResult NOT posted
			const localResultCalls = postMessage.mock.calls.filter(
				(c: Array<unknown>) =>
					(c[0] as Record<string, unknown>).command === "pushToLocalResult",
			);
			expect(localResultCalls).toHaveLength(0);
		});

		it("defaults to jolli when pushAction is undefined", async () => {
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
			expect(mockCorePushSummaryToLocal).not.toHaveBeenCalled();
		});
	});

	// ── Test 2 ───────────────────────────────────────────────────────────────

	describe("pushAction = 'both' with folder set runs both concurrently", () => {
		it("calls both pushToJolli and pushSummaryToLocal, posts both results", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "both",
				localFolder: "/Users/me/docs",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 42 });
			mockExistsSync.mockReturnValue(true);
			mockCorePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/Users/me/docs/abc12345-summary.md",
				satellitePaths: [],
				indexPath: "/Users/me/docs/index.md",
			});
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			// Jolli push was executed
			expect(mockPushToJolli).toHaveBeenCalled();
			// Local push was executed with commitHash and localFolder
			expect(mockCorePushSummaryToLocal).toHaveBeenCalledWith(
				expect.objectContaining({ folder: "/Users/me/docs" }),
			);
			// pushToJolliResult posted with success
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: true,
				}),
			);
			// pushToLocalResult posted with success and filePath
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToLocalResult",
					success: true,
					filePath: "/Users/me/docs/abc12345-summary.md",
				}),
			);
		});
	});

	// ── Test 3 ───────────────────────────────────────────────────────────────

	describe("pushAction = 'both' with unset folder opens picker, saves, proceeds", () => {
		it("opens showOpenDialog, persists folder, runs both pushes", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "both",
				// localFolder is undefined
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 42 });
			showOpenDialog.mockResolvedValue([{ fsPath: "/Users/me/picked" }]);
			mockCorePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/Users/me/picked/abc12345-summary.md",
				satellitePaths: [],
				indexPath: "/Users/me/picked/index.md",
			});
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			// Folder picker was opened
			expect(showOpenDialog).toHaveBeenCalledWith(
				expect.objectContaining({
					canSelectFolders: true,
					canSelectFiles: false,
					canSelectMany: false,
					openLabel: "Select folder for Push to Local",
				}),
			);
			// Config persistence was called with the picked folder
			expect(mockSaveConfig).toHaveBeenCalledWith({
				localFolder: "/Users/me/picked",
			});
			// Local push was called with the picked folder
			expect(mockCorePushSummaryToLocal).toHaveBeenCalledWith(
				expect.objectContaining({ folder: "/Users/me/picked" }),
			);
			// Both result messages posted
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: true,
				}),
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToLocalResult",
					success: true,
					filePath: "/Users/me/picked/abc12345-summary.md",
				}),
			);
		});

		it("opens picker when localFolder is set but path does not exist", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "both",
				localFolder: "/Users/me/gone",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 42 });
			mockExistsSync.mockReturnValue(false);
			showOpenDialog.mockResolvedValue([{ fsPath: "/Users/me/new-folder" }]);
			mockCorePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/Users/me/new-folder/abc12345-summary.md",
				satellitePaths: [],
				indexPath: "/Users/me/new-folder/index.md",
			});
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			expect(showOpenDialog).toHaveBeenCalled();
			expect(mockSaveConfig).toHaveBeenCalledWith({
				localFolder: "/Users/me/new-folder",
			});
			expect(mockCorePushSummaryToLocal).toHaveBeenCalledWith(
				expect.objectContaining({ folder: "/Users/me/new-folder" }),
			);
		});
	});

	// ── Test 4 ───────────────────────────────────────────────────────────────

	describe("pushAction = 'both' with cancelled picker still runs Jolli", () => {
		it("posts pushToJolliResult success and pushToLocalResult failure", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "both",
				// localFolder is undefined, so picker will open
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 42 });
			showOpenDialog.mockResolvedValue(undefined); // user cancelled
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			// Jolli push still succeeds
			expect(mockPushToJolli).toHaveBeenCalled();
			// Local push was NOT executed
			expect(mockCorePushSummaryToLocal).not.toHaveBeenCalled();
			// pushToJolliResult posted with success
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: true,
				}),
			);
			// pushToLocalResult posted with failure
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToLocalResult",
					success: false,
					error: expect.stringMatching(/No folder/),
				}),
			);
		});
	});

	// ── Test 5 ───────────────────────────────────────────────────────────────

	describe("Jolli succeeds, Local fails - both results reported", () => {
		it("posts success for Jolli and failure for Local", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "both",
				localFolder: "/Users/me/docs",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 42 });
			mockExistsSync.mockReturnValue(true);
			mockCorePushSummaryToLocal.mockRejectedValue(new Error("disk full"));
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			// pushToJolliResult: success
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: true,
				}),
			);
			// pushToLocalResult: failure with error message
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToLocalResult",
					success: false,
					error: "disk full",
				}),
			);
		});
	});

	// ── Test 6 ───────────────────────────────────────────────────────────────

	describe("Jolli fails, Local succeeds - both results reported", () => {
		it("posts failure for Jolli and success for Local", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "both",
				localFolder: "/Users/me/docs",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockRejectedValue(new Error("server error"));
			mockExistsSync.mockReturnValue(true);
			mockCorePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/Users/me/docs/abc12345-summary.md",
				satellitePaths: [],
				indexPath: "/Users/me/docs/index.md",
			});
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			// pushToJolliResult: failure
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: false,
					error: expect.stringContaining("server error"),
				}),
			);
			// pushToLocalResult: success
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToLocalResult",
					success: true,
					filePath: "/Users/me/docs/abc12345-summary.md",
				}),
			);
		});
	});

	// ── Test 7: gatherSatellites — plan and note content ────────────────────

	describe("gatherSatellites collects plan and note content for local push", () => {
		it("includes plan and markdown note satellites when content is available", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "both",
				localFolder: "/Users/me/docs",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 42 });
			mockExistsSync.mockReturnValue(true);
			mockReadPlanFromBranch.mockResolvedValue(
				"# Plan Content\nHere is the plan.",
			);
			mockReadNoteFromBranch.mockResolvedValue(
				"# Note Content\nHere is the note.",
			);
			mockCorePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/Users/me/docs/abc12345-summary.md",
				satellitePaths: [
					"/Users/me/docs/plan-one.md",
					"/Users/me/docs/note-1.md",
				],
				indexPath: "/Users/me/docs/index.md",
			});

			const dispatch = await setupPanel({
				plans: [
					{
						slug: "plan-one",
						title: "Plan One",
						editCount: 2,
						addedAt: "2025-01-01",
						updatedAt: "2025-01-15",
						jolliPlanDocUrl: "https://jolli.ai/doc/plan-one",
					},
				],
				notes: [
					{
						id: "note-1",
						title: "Note One",
						format: "markdown" as const,
						addedAt: "2025-01-01",
						updatedAt: "2025-01-15",
						jolliNoteDocUrl: "https://jolli.ai/doc/note-1",
					},
				],
			});

			dispatch({ command: "push" });
			await flushPromises();

			// Verify readPlanFromBranch was called with the plan slug
			expect(mockReadPlanFromBranch).toHaveBeenCalledWith(
				"plan-one",
				"/workspace",
			);
			// Verify readNoteFromBranch was called with the note id
			expect(mockReadNoteFromBranch).toHaveBeenCalledWith(
				"note-1",
				"/workspace",
			);

			// corePushSummaryToLocal should include satellites
			expect(mockCorePushSummaryToLocal).toHaveBeenCalledWith(
				expect.objectContaining({
					satellites: expect.arrayContaining([
						expect.objectContaining({
							slug: "plan-one",
							title: "Plan One",
							content: "# Plan Content\nHere is the plan.",
							jolliUrl: "https://jolli.ai/doc/plan-one",
						}),
						expect.objectContaining({
							slug: "note-1",
							title: "Note One",
							content: "# Note Content\nHere is the note.",
							jolliUrl: "https://jolli.ai/doc/note-1",
						}),
					]),
				}),
			);
		});

		it("skips plans and notes when readPlanFromBranch/readNoteFromBranch return null", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "both",
				localFolder: "/Users/me/docs",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 42 });
			mockExistsSync.mockReturnValue(true);
			mockReadPlanFromBranch.mockResolvedValue(null);
			mockReadNoteFromBranch.mockResolvedValue(null);
			mockCorePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/Users/me/docs/abc12345-summary.md",
				satellitePaths: [],
				indexPath: "/Users/me/docs/index.md",
			});

			const dispatch = await setupPanel({
				plans: [
					{
						slug: "p1",
						title: "P1",
						editCount: 1,
						addedAt: "2025-01-01",
						updatedAt: "2025-01-01",
					},
				],
				notes: [
					{
						id: "n1",
						title: "N1",
						format: "markdown" as const,
						addedAt: "2025-01-01",
						updatedAt: "2025-01-01",
					},
				],
			});

			dispatch({ command: "push" });
			await flushPromises();

			expect(mockCorePushSummaryToLocal).toHaveBeenCalledWith(
				expect.objectContaining({ satellites: [] }),
			);
		});

		it("uses note.content directly for snippet notes instead of readNoteFromBranch", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "both",
				localFolder: "/Users/me/docs",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 42 });
			mockExistsSync.mockReturnValue(true);
			mockCorePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/Users/me/docs/abc12345-summary.md",
				satellitePaths: [],
				indexPath: "/Users/me/docs/index.md",
			});

			const dispatch = await setupPanel({
				notes: [
					{
						id: "snippet-1",
						title: "Snippet Note",
						format: "snippet" as const,
						content: "inline snippet content",
						addedAt: "2025-01-01",
						updatedAt: "2025-01-01",
					},
				],
			});

			dispatch({ command: "push" });
			await flushPromises();

			// readNoteFromBranch should NOT be called for snippet notes
			expect(mockReadNoteFromBranch).not.toHaveBeenCalled();

			expect(mockCorePushSummaryToLocal).toHaveBeenCalledWith(
				expect.objectContaining({
					satellites: expect.arrayContaining([
						expect.objectContaining({
							slug: "snippet-1",
							title: "Snippet Note",
							content: "inline snippet content",
						}),
					]),
				}),
			);
		});
	});

	// ── Test 8: result message edge cases ────────────────────────────────────

	describe("toJolliResultMessage / toLocalResultMessage edge cases", () => {
		it("uses String() for non-Error Jolli rejection reason", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "both",
				localFolder: "/Users/me/docs",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			// Reject with a string, not an Error
			mockPushToJolli.mockRejectedValue("string rejection reason");
			mockExistsSync.mockReturnValue(true);
			mockCorePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/Users/me/docs/abc12345-summary.md",
				satellitePaths: [],
				indexPath: "/Users/me/docs/index.md",
			});
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: false,
					error: "string rejection reason",
				}),
			);
		});

		it("uses String() for non-Error local push rejection reason", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
				pushAction: "both",
				localFolder: "/Users/me/docs",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 42 });
			mockExistsSync.mockReturnValue(true);
			// Reject with a number, not an Error
			mockCorePushSummaryToLocal.mockRejectedValue(42);
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToLocalResult",
					success: false,
					error: "42",
				}),
			);
		});
	});

	// ── Test 9: re-entrancy guard ───────────────────────────────────────────

	describe("concurrent push prevention", () => {
		it("ignores a second push dispatch while the first is still in flight", async () => {
			// Make pushToJolli hang so the first push stays in-flight
			let resolvePush!: (value: { docId: number }) => void;
			mockPushToJolli.mockReturnValue(
				new Promise<{ docId: number }>((resolve) => {
					resolvePush = resolve;
				}),
			);
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			const dispatch = await setupPanel();

			// Fire first push — it will hang on pushToJolli
			dispatch({ command: "push" });
			// Yield so handlePush enters and sets pushInProgress = true
			await new Promise((r) => setTimeout(r, 0));

			// Fire second push — should be silently ignored
			dispatch({ command: "push" });
			await new Promise((r) => setTimeout(r, 0));

			// Resolve the first push
			resolvePush({ docId: 1 });
			await flushPromises();

			// pushToJolli should have been called exactly once (not twice)
			expect(mockPushToJolli).toHaveBeenCalledTimes(1);
		});

		it("allows a new push after the previous one completes", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 1 });
			const dispatch = await setupPanel();

			// First push — completes normally
			dispatch({ command: "push" });
			await flushPromises();

			// Second push — should be allowed since first completed
			mockPushToJolli.mockResolvedValue({ docId: 2 });
			dispatch({ command: "push" });
			await flushPromises();

			expect(mockPushToJolli).toHaveBeenCalledTimes(2);
		});

		it("resets pushInProgress even when push fails", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			// First push fails
			mockPushToJolli.mockRejectedValue(new Error("network error"));
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			// Second push should be allowed (guard was reset in finally block)
			mockPushToJolli.mockResolvedValue({ docId: 1 });
			dispatch({ command: "push" });
			await flushPromises();

			expect(mockPushToJolli).toHaveBeenCalledTimes(2);
		});
	});
});
