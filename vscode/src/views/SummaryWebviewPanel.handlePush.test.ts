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
	MockBindingRequiredError,
	mockParseJolliApiKey,
} = vi.hoisted(() => {
	class MockPluginOutdatedError extends Error {
		constructor(msg = "outdated") {
			super(msg);
			this.name = "PluginOutdatedError";
		}
	}
	class MockBindingRequiredError extends Error {
		readonly repoUrl: string;
		constructor(repoUrl: string, msg = "binding_required") {
			super(msg);
			this.name = "BindingRequiredError";
			this.repoUrl = repoUrl;
		}
	}
	return {
		mockPushToJolli: vi.fn().mockResolvedValue({ docId: 42 }),
		mockDeleteFromJolli: vi.fn().mockResolvedValue(undefined),
		MockPluginOutdatedError,
		MockBindingRequiredError,
		mockParseJolliApiKey: vi
			.fn()
			.mockReturnValue({ u: "https://example.jolli.app" }),
	};
});

vi.mock("../services/JolliPushService.js", () => ({
	pushToJolli: mockPushToJolli,
	deleteFromJolli: mockDeleteFromJolli,
	PluginOutdatedError: MockPluginOutdatedError,
	BindingRequiredError: MockBindingRequiredError,
	parseJolliApiKey: mockParseJolliApiKey,
}));

const { mockGetCanonicalRepoUrl, mockDeriveRepoNameFromUrl } = vi.hoisted(
	() => ({
		mockGetCanonicalRepoUrl: vi
			.fn()
			.mockResolvedValue("https://github.com/example/repo"),
		mockDeriveRepoNameFromUrl: vi.fn().mockReturnValue("repo"),
	}),
);

vi.mock("../util/GitRemoteUtils.js", () => ({
	getCanonicalRepoUrl: mockGetCanonicalRepoUrl,
	deriveRepoNameFromUrl: mockDeriveRepoNameFromUrl,
}));

// `mockBindingChooserOpen` returns a BindingChooserOutcome:
//   { kind: "selected", result: BindingChooserResult }  // user picked a space
//   { kind: "cancelled" }                                // user dismissed
//   { kind: "anotherOpen" }                              // another chooser open for this repo
const { mockBindingChooserOpen, mockBindingChooserDispose } = vi.hoisted(
	() => ({
		mockBindingChooserOpen: vi.fn().mockResolvedValue({ kind: "cancelled" }),
		mockBindingChooserDispose: vi.fn(),
	}),
);

vi.mock("./BindingChooserWebviewPanel.js", () => ({
	BindingChooserWebviewPanel: {
		openAndAwait: mockBindingChooserOpen,
		dispose: mockBindingChooserDispose,
	},
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

const {
	mockBuildHtml,
	mockBuildE2eTestSection,
	mockRenderTopic,
	mockRenderE2eScenario,
} = vi.hoisted(() => ({
	mockBuildHtml: vi.fn().mockReturnValue("<html>mock</html>"),
	mockBuildE2eTestSection: vi.fn().mockReturnValue("<div>e2e</div>"),
	mockRenderTopic: vi.fn().mockReturnValue("<div>topic</div>"),
	mockRenderE2eScenario: vi.fn().mockReturnValue("<div>scenario</div>"),
}));

vi.mock("./SummaryHtmlBuilder.js", () => ({
	buildHtml: mockBuildHtml,
	buildE2eTestSection: mockBuildE2eTestSection,
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
	mockBuildBranchRelativePath,
} = vi.hoisted(() => ({
	mockBuildPanelTitle: vi.fn().mockReturnValue("Panel Title"),
	mockBuildPushTitle: vi.fn().mockReturnValue("Push Title"),
	mockBuildPlanPushTitle: vi.fn().mockReturnValue("Plan Push Title"),
	mockBuildNotePushTitle: vi.fn().mockReturnValue("Note Push Title"),
	mockCollectSortedTopics: vi
		.fn()
		.mockReturnValue({ topics: [], sourceNodes: [], showRecordDates: false }),
	mockCollectAllPlans: vi.fn().mockReturnValue([]),
	mockBuildBranchRelativePath: vi.fn().mockReturnValue("main"),
}));

vi.mock("./SummaryUtils.js", () => ({
	buildPanelTitle: mockBuildPanelTitle,
	buildPushTitle: mockBuildPushTitle,
	buildPlanPushTitle: mockBuildPlanPushTitle,
	buildNotePushTitle: mockBuildNotePushTitle,
	collectSortedTopics: mockCollectSortedTopics,
	collectAllPlans: mockCollectAllPlans,
	buildBranchRelativePath: mockBuildBranchRelativePath,
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
	await SummaryWebviewPanel.show(
		summary,
		extensionUri,
		workspaceRoot,
		stubBridge,
		"main",
	);
	return captureMessageHandler();
}

// Bridge stub used only to satisfy the panel ctor signature; handlePush tests
// exercise the push path which threads writes through `this.bridge.storeSummary`,
// so the stub delegates to module-level mockStoreSummary to keep existing
// assertions like `expect(mockStoreSummary).toHaveBeenCalled()` working.
const stubBridge = {
	listBranchCommits: vi.fn(),
	getSummary: vi.fn(),
	storeSummary: vi.fn(
		(
			summary: import("../../../cli/src/Types.js").CommitSummary,
			force = false,
			artifacts?: unknown,
		): Promise<void> =>
			artifacts === undefined
				? (mockStoreSummary(summary, "/workspace", force) as Promise<void>)
				: (mockStoreSummary(
						summary,
						"/workspace",
						force,
						artifacts,
					) as Promise<void>),
	),
	// Stale-commit guard reads the index via this bridge wrapper. Default to
	// "empty index" so push tests stay on the happy path.
	getSummaryIndexEntryMap: vi.fn().mockResolvedValue(new Map()),
	getTranscriptHashes: vi.fn(
		() => mockGetTranscriptHashes() as Promise<Set<string>>,
	),
	readTranscriptsForCommits: vi.fn(
		(commitHashes: ReadonlyArray<string>) =>
			mockReadTranscriptsForCommits(commitHashes) as Promise<Map<string, unknown>>,
	),
} as unknown as import("../JolliMemoryBridge.js").JolliMemoryBridge;

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
		mockLoadConfig.mockResolvedValue({
			apiKey: "test-key",
			model: "test-model",
		});
	});

	describe("Jolli-only push", () => {
		// The local-push pathway (and the "both" mode that drove it) was
		// removed in 2026-05; handlePush now always runs runJolliPush and posts
		// exactly one result message. Tests below pin that contract — anyone
		// reintroducing a `pushAction` branch will trip the
		// `pushToLocalResult NOT posted` assertion.
		it("calls runJolliPush and posts a pushToJolliResult success message", async () => {
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
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: true,
				}),
			);
			const localResultCalls = postMessage.mock.calls.filter(
				(c: Array<unknown>) =>
					(c[0] as Record<string, unknown>).command === "pushToLocalResult",
			);
			expect(localResultCalls).toHaveLength(0);
		});
	});
	// ── Test 8: result message edge cases ────────────────────────────────────

	describe("toJolliResultMessage edge cases", () => {
		it("uses String() for non-Error Jolli rejection reason", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			// Reject with a string, not an Error
			mockPushToJolli.mockRejectedValue("string rejection reason");
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

	// ── Test 10: 412 binding_required → chooser → retry ─────────────────────

	describe("412 binding_required opens chooser and retries the push", () => {
		const baseConfig = {
			apiKey: "test",
			jolliApiKey: "jk_valid",
		};

		it("opens BindingChooser with derived params and retries on confirm", async () => {
			mockLoadConfig.mockResolvedValue(baseConfig);
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockGetCanonicalRepoUrl.mockResolvedValue(
				"https://github.com/example/repo",
			);
			mockDeriveRepoNameFromUrl.mockReturnValue("repo");
			// First call: 412; second call (after chooser confirms): success
			mockPushToJolli
				.mockRejectedValueOnce(
					new MockBindingRequiredError("https://github.com/example/repo"),
				)
				.mockResolvedValueOnce({ docId: 77 });
			mockBindingChooserOpen.mockResolvedValue({
				kind: "selected",
				result: {
					id: 1,
					jmSpaceId: 5,
					jmSpaceName: "team-space",
					repoName: "repo",
				},
			});
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			expect(mockBindingChooserOpen).toHaveBeenCalledTimes(1);
			expect(mockBindingChooserOpen).toHaveBeenCalledWith(
				expect.objectContaining({
					baseUrl: "https://my.jolli.app",
					apiKey: "jk_valid",
					repoUrl: "https://github.com/example/repo",
					suggestedRepoName: "repo",
				}),
			);
			expect(mockPushToJolli).toHaveBeenCalledTimes(2);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: true,
				}),
			);
		});

		it("does not retry and reports failure when the user cancels", async () => {
			mockLoadConfig.mockResolvedValue(baseConfig);
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockGetCanonicalRepoUrl.mockResolvedValue(
				"https://github.com/example/repo",
			);
			mockPushToJolli.mockRejectedValue(
				new MockBindingRequiredError("https://github.com/example/repo"),
			);
			mockBindingChooserOpen.mockResolvedValue({ kind: "cancelled" });
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			expect(mockBindingChooserOpen).toHaveBeenCalledTimes(1);
			expect(mockPushToJolli).toHaveBeenCalledTimes(1);
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining(
					"Push cancelled — no Memory space chosen for this repo",
				),
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: false,
				}),
			);
		});

		it("shows an informational hint (not 'Push cancelled') when another chooser is open for the same repo", async () => {
			mockLoadConfig.mockResolvedValue(baseConfig);
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockGetCanonicalRepoUrl.mockResolvedValue(
				"https://github.com/example/repo",
			);
			mockPushToJolli.mockRejectedValue(
				new MockBindingRequiredError("https://github.com/example/repo"),
			);
			mockBindingChooserOpen.mockResolvedValue({ kind: "anotherOpen" });
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			expect(mockBindingChooserOpen).toHaveBeenCalledTimes(1);
			// No retry — the *other* panel will retry once it gets a binding.
			expect(mockPushToJolli).toHaveBeenCalledTimes(1);
			// Informational hint, not the misleading "Push cancelled" error.
			expect(showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining(
					"A Memory space chooser is already open for this repo",
				),
			);
			expect(showErrorMessage).not.toHaveBeenCalledWith(
				expect.stringContaining("Push cancelled"),
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: false,
				}),
			);
		});

		it("does not loop: a second 412 after the retry surfaces as a normal error", async () => {
			mockLoadConfig.mockResolvedValue(baseConfig);
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockGetCanonicalRepoUrl.mockResolvedValue(
				"https://github.com/example/repo",
			);
			// Both push attempts return 412 — runJolliPush passes retried=true on the
			// second call, so the chooser must NOT open a second time.
			mockPushToJolli.mockRejectedValue(
				new MockBindingRequiredError("https://github.com/example/repo"),
			);
			mockBindingChooserOpen.mockResolvedValue({
				kind: "selected",
				result: {
					id: 1,
					jmSpaceId: 5,
					jmSpaceName: "team-space",
					repoName: "repo",
				},
			});
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			expect(mockPushToJolli).toHaveBeenCalledTimes(2);
			expect(mockBindingChooserOpen).toHaveBeenCalledTimes(1);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "pushToJolliResult",
					success: false,
				}),
			);
		});
	});
});
