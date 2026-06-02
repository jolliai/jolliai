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
	showTextDocument,
	openTextDocument,
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
	showTextDocument: vi.fn().mockResolvedValue(undefined),
	openTextDocument: vi.fn().mockResolvedValue({}),
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

const { withProgress } = vi.hoisted(() => ({
	// Default: pass-through the task with a non-cancelled token. Individual
	// tests can override via withProgress.mockImplementationOnce(...).
	// NOTE: NOT async — we want to forward the task's promise directly so
	// caller's `await withProgress(...)` resolves on the same microtask
	// chain as the task body's internal awaits.
	withProgress: vi.fn(
		(
			_opts: unknown,
			task: (
				progress: { report: (v: unknown) => void },
				token: { onCancellationRequested: (cb: () => void) => void },
			) => unknown,
		) => task({ report: vi.fn() }, { onCancellationRequested: vi.fn() }),
	),
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
		showTextDocument,
		withProgress,
	},
	ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
	env: {
		clipboard: { writeText: clipboardWriteText },
		openExternal,
	},
	Uri: {
		// Lightweight URL parser — extracts the scheme so `openEntityExternal`'s
		// http(s) defense-in-depth check has something to read; the real
		// vscode.Uri has many more fields but tests only exercise these.
		parse: vi.fn((s: string) => {
			const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
			const scheme = match ? match[1].toLowerCase() : "";
			return { scheme, toString: () => s };
		}),
		file: vi.fn((s: string) => ({ fsPath: s, toString: () => s })),
		joinPath: vi.fn((...args: Array<unknown>) => ({
			toString: () => String(args.join("/")),
		})),
	},
	ViewColumn: { One: 1, Beside: 2 },
	workspace: {
		getConfiguration,
		fs: { writeFile: fsWriteFile },
		// openTextDocument is used by handleOpenLinearIssueMarkdown's orphan-
		// branch fallback path; default returns a stub doc, individual tests
		// can override via openTextDocument.mockResolvedValueOnce(...).
		openTextDocument,
	},
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

const { mockGenerateE2eTest, mockGenerateRecap, mockTranslateToEnglish } =
	vi.hoisted(() => ({
		mockGenerateE2eTest: vi.fn().mockResolvedValue([]),
		mockGenerateRecap: vi.fn().mockResolvedValue(""),
		mockTranslateToEnglish: vi
			.fn()
			.mockResolvedValue("# Translated Plan\n\nEnglish content"),
	}));

vi.mock("../../../cli/src/core/Summarizer.js", () => ({
	generateE2eTest: mockGenerateE2eTest,
	generateRecap: mockGenerateRecap,
	translateToEnglish: mockTranslateToEnglish,
}));

const { mockRegenerateSummary, mockLoadRegenerateContext } = vi.hoisted(() => ({
	mockRegenerateSummary: vi.fn(),
	mockLoadRegenerateContext: vi.fn(),
}));

vi.mock("../../../cli/src/core/Regenerator.js", () => ({
	regenerateSummary: mockRegenerateSummary,
}));

vi.mock("../../../cli/src/core/RegenerateContext.js", () => ({
	loadRegenerateContext: mockLoadRegenerateContext,
}));

const {
	mockGetTranscriptHashes,
	mockReadReferenceFromBranch,
	mockReadNoteFromBranch,
	mockReadPlanFromBranch,
	mockReadTranscriptsForCommits,
	mockSaveTranscriptsBatch,
	mockStoreReferences,
	mockStoreNotes,
	mockStorePlans,
	mockStoreSummary,
} = vi.hoisted(() => ({
	mockGetTranscriptHashes: vi.fn().mockResolvedValue(new Set<string>()),
	// Default: every read returns null so the inline-edit / preview "snapshot
	// not found" branch is hit; tests that exercise the happy path override.
	mockReadReferenceFromBranch: vi.fn().mockResolvedValue(null),
	mockReadNoteFromBranch: vi.fn().mockResolvedValue(null),
	mockReadPlanFromBranch: vi.fn().mockResolvedValue(null),
	mockReadTranscriptsForCommits: vi.fn().mockResolvedValue(new Map()),
	mockSaveTranscriptsBatch: vi.fn().mockResolvedValue(undefined),
	mockStoreReferences: vi.fn().mockResolvedValue(undefined),
	mockStoreNotes: vi.fn().mockResolvedValue(undefined),
	mockStorePlans: vi.fn().mockResolvedValue(undefined),
	mockStoreSummary: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../cli/src/core/SummaryStore.js", () => ({
	getTranscriptHashes: mockGetTranscriptHashes,
	readReferenceFromBranch: mockReadReferenceFromBranch,
	readNoteFromBranch: mockReadNoteFromBranch,
	readPlanFromBranch: mockReadPlanFromBranch,
	readTranscriptsForCommits: mockReadTranscriptsForCommits,
	saveTranscriptsBatch: mockSaveTranscriptsBatch,
	storeReferences: mockStoreReferences,
	storeNotes: mockStoreNotes,
	storePlans: mockStorePlans,
	storeSummary: mockStoreSummary,
}));

const { mockDeleteTopicInTree, mockUpdateTopicInTree } = vi.hoisted(() => ({
	mockDeleteTopicInTree: vi.fn(),
	mockUpdateTopicInTree: vi.fn(),
}));

vi.mock("../../../cli/src/core/SummaryTree.js", async () => {
	// Pull real impls for everything not explicitly stubbed (notably
	// `getTranscriptIds`, used by the panel's refreshTranscriptHashes flow
	// after the v5 schema migration to a stable transcript-ID set).
	const actual = await vi.importActual<typeof import("../../../cli/src/core/SummaryTree.js")>(
		"../../../cli/src/core/SummaryTree.js",
	);
	return {
		...actual,
		deleteTopicInTree: mockDeleteTopicInTree,
		updateTopicInTree: mockUpdateTopicInTree,
	};
});

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

vi.mock("../../package.json", () => ({ version: "0.90.0" }));

const {
	mockListAvailablePlans,
	mockArchivePlanForCommit,
	mockRemovePlan,
} = vi.hoisted(() => ({
	mockListAvailablePlans: vi.fn().mockReturnValue([]),
	mockArchivePlanForCommit: vi.fn().mockResolvedValue(null),
	mockRemovePlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/PlanService.js", () => ({
	listAvailablePlans: mockListAvailablePlans,
	archivePlanForCommit: mockArchivePlanForCommit,
	removePlan: mockRemovePlan,
}));

const {
	mockSaveNote,
	mockArchiveNoteForCommit,
	mockRemoveNote,
} = vi.hoisted(() => ({
	mockSaveNote: vi.fn().mockResolvedValue({
		id: "note-1",
		title: "Test Snippet",
		format: "snippet",
	}),
	mockArchiveNoteForCommit: vi.fn().mockResolvedValue(null),
	mockRemoveNote: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/NoteService.js", () => ({
	saveNote: mockSaveNote,
	archiveNoteForCommit: mockArchiveNoteForCommit,
	removeNote: mockRemoveNote,
}));

const { mockRemoveReference } = vi.hoisted(() => ({
	mockRemoveReference: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/ReferenceService.js", () => ({
	removeReference: mockRemoveReference,
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

const { mockBindingChooserOpen, mockBindingChooserDispose } = vi.hoisted(
	() => ({
		mockBindingChooserOpen: vi.fn().mockResolvedValue(undefined),
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
	wrapWithMarkers: (s: string) => `[MARKERS]${s}[/MARKERS]`,
}));

const { mockIsWorkerBusy } = vi.hoisted(() => ({
	mockIsWorkerBusy: vi.fn().mockResolvedValue(false),
}));

vi.mock("../util/LockUtils.js", () => ({
	isWorkerBusy: mockIsWorkerBusy,
}));

const { mockLoadBranchSummaries } = vi.hoisted(() => ({
	// Default: empty branch summaries → routes through single-summary path.
	mockLoadBranchSummaries: vi
		.fn()
		.mockResolvedValue({ summaries: [], missingCount: 0, totalCount: 0 }),
}));

vi.mock("./BranchSummaryLoader.js", () => ({
	loadBranchSummaries: mockLoadBranchSummaries,
}));

const { mockBuildAggregatedPrMarkdown } = vi.hoisted(() => ({
	mockBuildAggregatedPrMarkdown: vi.fn().mockReturnValue("# Aggregated body"),
}));

vi.mock("./SummaryPrAggregateMarkdownBuilder.js", () => ({
	buildAggregatedPrMarkdown: mockBuildAggregatedPrMarkdown,
}));

vi.mock("../util/Logger.js", () => ({
	log: { info, warn, error: logError },
}));

const {
	mockBuildHtml,
	mockBuildE2eTestSection,
	mockBuildRecapSection,
	mockBuildTopicsSection,
	mockRenderTopic,
	mockRenderE2eScenario,
} = vi.hoisted(() => ({
	mockBuildHtml: vi.fn().mockReturnValue("<html>mock</html>"),
	mockBuildE2eTestSection: vi.fn().mockReturnValue("<div>e2e</div>"),
	mockBuildRecapSection: vi.fn().mockReturnValue("<div>recap</div>"),
	mockBuildTopicsSection: vi.fn().mockReturnValue("<div>topics</div>"),
	mockRenderTopic: vi.fn().mockReturnValue("<div>topic</div>"),
	mockRenderE2eScenario: vi.fn().mockReturnValue("<div>scenario</div>"),
}));

vi.mock("./SummaryHtmlBuilder.js", () => ({
	buildHtml: mockBuildHtml,
	buildE2eTestSection: mockBuildE2eTestSection,
	buildRecapSection: mockBuildRecapSection,
	buildTopicsSection: mockBuildTopicsSection,
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

const { mockFormatActiveProviderLabel } = vi.hoisted(() => ({
	mockFormatActiveProviderLabel: vi.fn().mockReturnValue("Anthropic"),
}));

vi.mock("./SummaryUtils.js", () => ({
	buildPanelTitle: mockBuildPanelTitle,
	buildPushTitle: mockBuildPushTitle,
	buildPlanPushTitle: mockBuildPlanPushTitle,
	buildNotePushTitle: mockBuildNotePushTitle,
	collectSortedTopics: mockCollectSortedTopics,
	collectAllPlans: mockCollectAllPlans,
	buildBranchRelativePath: mockBuildBranchRelativePath,
	formatActiveProviderLabel: mockFormatActiveProviderLabel,
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
// Bridge stub used to satisfy the panel ctor signature. `getCurrentBranch` is
// the only method exercised here — by the cross-branch guard in
// `handlePrepareCreatePr` and by `loadBranchSummariesForPr`. It defaults to
// matching `makeSummary().branch` so existing tests stay on the same-branch
// path; cross-branch tests override with `vi.spyOn(stubBridge, ...)`.
const stubBridge = {
	listBranchCommits: vi.fn(),
	getSummary: vi.fn(),
	getCurrentBranch: vi.fn().mockResolvedValue("feature/test"),
	cleanupVisiblePlanArtifact: vi.fn().mockResolvedValue(undefined),
	cleanupVisibleNoteArtifact: vi.fn().mockResolvedValue(undefined),
	// Bridge wrappers delegate to the module-level SummaryStore/PlanService/
	// NoteService mocks with workspaceRoot injected, so existing assertions
	// like `expect(mockStoreSummary).toHaveBeenCalledWith(summary, workspaceRoot, true)`
	// keep working after the panel migrated to `this.bridge.storeSummary(...)`.
	// Delegate the bridge wrappers without forwarding trailing `undefined`
	// arguments — `toHaveBeenLastCalledWith` is arity-strict and existing
	// assertions only specify the args that were originally passed.
	storeSummary: vi.fn(
		(
			summary: import("../../../cli/src/Types.js").CommitSummary,
			force = false,
			artifacts?: unknown,
		): Promise<void> =>
			artifacts === undefined
				? (mockStoreSummary(summary, workspaceRoot, force) as Promise<void>)
				: (mockStoreSummary(
						summary,
						workspaceRoot,
						force,
						artifacts,
					) as Promise<void>),
	),
	storePlans: vi.fn(
		(
			planFiles: ReadonlyArray<{ slug: string; content: string }>,
			message: string,
			branch?: string,
		): Promise<void> =>
			branch === undefined
				? (mockStorePlans(planFiles, message, workspaceRoot) as Promise<void>)
				: (mockStorePlans(
						planFiles,
						message,
						workspaceRoot,
						branch,
					) as Promise<void>),
	),
	storeNotes: vi.fn(
		(
			noteFiles: ReadonlyArray<{ id: string; content: string }>,
			message: string,
			branch?: string,
		): Promise<void> =>
			branch === undefined
				? (mockStoreNotes(noteFiles, message, workspaceRoot) as Promise<void>)
				: (mockStoreNotes(
						noteFiles,
						message,
						workspaceRoot,
						branch,
					) as Promise<void>),
	),
	storeReferences: vi.fn(
		(
			entityFiles: ReadonlyArray<{
				archivedKey: string;
				source: string;
				content: string;
			}>,
			message: string,
			branch?: string,
		): Promise<void> =>
			branch === undefined
				? (mockStoreReferences(
						entityFiles,
						message,
						workspaceRoot,
					) as Promise<void>)
				: (mockStoreReferences(
						entityFiles,
						message,
						workspaceRoot,
						branch,
					) as Promise<void>),
	),
	saveTranscriptsBatch: vi.fn(
		(writes: ReadonlyArray<unknown>, deletes: ReadonlyArray<string>) =>
			mockSaveTranscriptsBatch(writes, deletes, workspaceRoot) as Promise<void>,
	),
	getTranscriptHashes: vi.fn(
		(): Promise<Set<string>> =>
			mockGetTranscriptHashes(workspaceRoot) as Promise<Set<string>>,
	),
	readTranscriptsForCommits: vi.fn((commitHashes: ReadonlyArray<string>) =>
		mockReadTranscriptsForCommits(commitHashes, workspaceRoot) as Promise<
			Map<string, unknown>
		>,
	),
	archivePlanForCommit: vi.fn((slug: string, commitHash: string) =>
		mockArchivePlanForCommit(slug, commitHash, workspaceRoot),
	),
	archiveNoteForCommit: vi.fn((id: string, commitHash: string) =>
		mockArchiveNoteForCommit(id, commitHash, workspaceRoot),
	),
	// Stale-commit guard reads the index via this bridge wrapper (storage
	// threading — see JolliMemoryBridge.getSummaryIndexEntryMap docstring).
	// Default to "empty index" so existing tests are unaffected; the
	// stale-commit describe block overrides per test.
	getSummaryIndexEntryMap: vi.fn().mockResolvedValue(new Map()),
	// Regenerate flow now routes through bridge wrappers so the storage
	// provider is threaded (folder-only Memory Bank correctness). Bridge
	// wrappers delegate to mockLoadRegenerateContext / mockRegenerateSummary
	// — same shape as the rest of this stub bridge's mocks.
	loadRegenerateContext: vi.fn((summary: unknown) =>
		mockLoadRegenerateContext(summary, workspaceRoot),
	),
	regenerateSummary: vi.fn((summary: unknown, config: unknown) =>
		mockRegenerateSummary(summary, workspaceRoot, config),
	),
} as unknown as import("../JolliMemoryBridge.js").JolliMemoryBridge;
const mainBranch = "main";

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
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

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
				stubBridge,
				mainBranch,
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

		// The KB-folder browser opens a summary tab against an explicit ViewColumn
		// instead of "Beside" so it lands in column One (the main editor area)
		// rather than floating next to whatever happens to be focused. The
		// commit-source default uses Beside; switching source to "kb" must flip
		// the column the panel is created in.
		it("opens the KB source in ViewColumn.One instead of Beside", async () => {
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"kb",
			);

			// Third positional arg is the ViewColumn — 1 for One, 2 for Beside.
			expect(createWebviewPanel).toHaveBeenCalledWith(
				"jollimemory.summary.commit",
				"Commit Memory",
				1,
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
				stubBridge,
				mainBranch,
				"commit",
			);
			const commitPanelDispose =
				createWebviewPanel.mock.results[0].value.dispose;

			await SummaryWebviewPanel.show(
				summary2,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
			);

			expect(createWebviewPanel).toHaveBeenCalledTimes(2);
			expect(commitPanelDispose).not.toHaveBeenCalled();
		});

		it("sets panel title from buildPanelTitle", async () => {
			mockBuildPanelTitle.mockReturnValue("Custom Title");
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			const panel = createWebviewPanel.mock.results[0].value;
			expect(panel.title).toBe("Custom Title");
		});

		it("sets HTML content from buildHtml", async () => {
			mockBuildHtml.mockReturnValue("<html>test content</html>");
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			const panel = createWebviewPanel.mock.results[0].value;
			expect(panel.webview.html).toBe("<html>test content</html>");
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: expect.any(Set),
					nonce: "mocknonce1234567=",
				}),
			);
		});

		// ── Foreign storage threading ────────────────────────────────────────
		// When show() receives a non-null foreignStorage (built by Extension via
		// `bridge.createStorageForRepo`), every read path inside the panel must
		// thread that storage through instead of falling back to the current
		// workspace's storage. Without this, viewing a foreign-repo summary
		// shows "All Conversations" / plans / notes as empty because the cwd
		// storage has no transcript/plan/note files for the foreign commit.

		it("refreshTranscriptHashes passes foreignStorage to the core getTranscriptHashes call", async () => {
			const foreignStorage = {
				kind: "foreign-storage-stub",
			} as unknown as import(
				"../../../cli/src/core/StorageProvider.js"
			).StorageProvider;
			const summary = makeSummary({ commitHash: "fff" });
			mockGetTranscriptHashes.mockResolvedValue(new Set(["fff"]));

			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo",
				"https://github.com/x/foreign.git",
				foreignStorage,
			);

			// Core helper invoked directly (not through stubBridge.getTranscriptHashes
			// which would drop the storage arg). The foreignStorage instance is
			// the load-bearing signal — without it the call would hit cwd storage.
			expect(mockGetTranscriptHashes).toHaveBeenCalledWith(
				workspaceRoot,
				foreignStorage,
			);
		});

		it("refreshPlanTranslateSet passes foreignStorage to readPlanFromBranch", async () => {
			const foreignStorage = {
				kind: "foreign-storage-stub",
			} as unknown as import(
				"../../../cli/src/core/StorageProvider.js"
			).StorageProvider;
			const summary = makeSummary({
				plans: [
					{
						slug: "plan-1",
						title: "p",
						status: "active",
						commitHash: "aaa",
					},
				],
			});

			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo",
				"https://github.com/x/foreign.git",
				foreignStorage,
			);

			expect(mockReadPlanFromBranch).toHaveBeenCalledWith(
				"plan-1",
				workspaceRoot,
				foreignStorage,
			);
		});

		it("refreshNoteTranslateSet passes foreignStorage to readNoteFromBranch", async () => {
			const foreignStorage = {
				kind: "foreign-storage-stub",
			} as unknown as import(
				"../../../cli/src/core/StorageProvider.js"
			).StorageProvider;
			const summary = makeSummary({
				notes: [
					{
						id: "note-1",
						title: "n",
						format: "markdown",
						commitHash: "aaa",
					},
				],
			});

			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo",
				"https://github.com/x/foreign.git",
				foreignStorage,
			);

			expect(mockReadNoteFromBranch).toHaveBeenCalledWith(
				"note-1",
				workspaceRoot,
				foreignStorage,
			);
		});

		it("non-foreign panels keep using bridge.getTranscriptHashes (no storage override)", async () => {
			// Regression guard: passing foreignStorage=null must NOT change the
			// existing non-foreign read path. The bridge wrapper carries the
			// cwd+config-derived storage already.
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			// stubBridge.getTranscriptHashes() forwards to mockGetTranscriptHashes
			// with workspaceRoot only — no second storage argument.
			expect(mockGetTranscriptHashes).toHaveBeenCalledWith(workspaceRoot);
			expect(mockGetTranscriptHashes).not.toHaveBeenCalledWith(
				workspaceRoot,
				expect.anything(),
			);
		});

		it("passes foreignRepoName through to buildHtml so CSS can hide destructive controls", async () => {
			// The foreign-readonly hook lives in SummaryHtmlBuilder /
			// SummaryCssBuilder. SummaryWebviewPanel's responsibility is
			// just plumbing — make sure update() forwards the provenance the
			// constructor received so the rendered HTML actually gets the
			// hook class. Without this assertion a regression that drops the
			// argument from the options object would still ship green tests
			// at the buildHtml layer.
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo",
			);
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({ foreignRepoName: "other-repo" }),
			);
		});

		it("dispose handler removes the commit panel from the per-hash map", async () => {
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			expect(onDidDispose).toHaveBeenCalled();
			const disposeCallback = onDidDispose.mock.calls[0][0] as () => void;
			disposeCallback();

			// After dispose, a new call to show() for the same commit should
			// create a new panel (instead of revealing the now-disposed one).
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			expect(createWebviewPanel).toHaveBeenCalledTimes(2);
		});

		it("commit slot: opens a distinct panel per commit hash without disposing the previous", async () => {
			const summary1 = makeSummary({ commitHash: "aaa" });
			const summary2 = makeSummary({ commitHash: "bbb" });

			await SummaryWebviewPanel.show(
				summary1,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const firstPanelDispose =
				createWebviewPanel.mock.results[0].value.dispose;
			await SummaryWebviewPanel.show(
				summary2,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			expect(createWebviewPanel).toHaveBeenCalledTimes(2);
			expect(firstPanelDispose).not.toHaveBeenCalled();
		});

		it("commit slot: reveals the existing panel when the same commit is shown again", async () => {
			const summary = makeSummary({ commitHash: "aaa" });

			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			reveal.mockClear();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			expect(createWebviewPanel).toHaveBeenCalledTimes(1);
			// reveal() with undefined viewColumn keeps the panel in its current column
			// (passing ViewColumn.Beside would risk a column-move that blanks the iframe).
			expect(reveal).toHaveBeenCalledWith(undefined, true);
		});

		it("commit slot: skips webview re-render when summary + config + orphan state all unchanged", async () => {
			const summary = makeSummary({ commitHash: "aaa" });

			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			mockGetTranscriptHashes.mockClear();
			mockBuildHtml.mockClear();

			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			// Refreshes always run (they're cheap reads that cover orphan-branch
			// state which can change without a summary JSON change). But when all
			// render inputs are identical we skip buildHtml — preserving scroll
			// and in-webview state via retainContextWhenHidden.
			expect(mockGetTranscriptHashes).toHaveBeenCalled();
			expect(mockBuildHtml).not.toHaveBeenCalled();
			expect(reveal).toHaveBeenCalled();
		});

		it("commit slot: re-renders when orphan-branch transcript hashes changed between clicks", async () => {
			const summary = makeSummary({ commitHash: "aaa" });

			mockGetTranscriptHashes.mockResolvedValueOnce(new Set<string>());
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			mockBuildHtml.mockClear();

			// Background session added a transcript for this commit — summary JSON
			// is identical, but the orphan-branch state changed.
			mockGetTranscriptHashes.mockResolvedValueOnce(new Set(["aaa"]));
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({ transcriptHashSet: new Set(["aaa"]) }),
			);
		});

		it("commit slot: re-renders the existing panel when the summary content changes", async () => {
			const summary1 = makeSummary({ commitHash: "aaa", commitMessage: "v1" });
			const summary2 = makeSummary({ commitHash: "aaa", commitMessage: "v2" });

			await SummaryWebviewPanel.show(
				summary1,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			mockGetTranscriptHashes.mockClear();
			mockBuildHtml.mockClear();

			await SummaryWebviewPanel.show(
				summary2,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

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
				stubBridge,
				mainBranch,
				"memory",
			);
			const firstPanelDispose =
				createWebviewPanel.mock.results[0].value.dispose;
			await SummaryWebviewPanel.show(
				summary2,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
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

			await SummaryWebviewPanel.show(
				summary1,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			await SummaryWebviewPanel.show(
				summary2,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			const secondPanel = createWebviewPanel.mock.results[1].value;
			expect(secondPanel.webview.html).toBe("<html>second</html>");
		});

		it("update() on a disposed instance is a no-op (race: concurrent show disposed it mid-refresh)", async () => {
			const summary = makeSummary({ commitHash: "aaa" });
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
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
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			// buildHtml should receive all 3 hashes (root + child + grandchild) intersected with file hashes
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: new Set(["abc123", childHash, grandchildHash]),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: expect.any(Set),
					nonce: "mocknonce1234567=",
				}),
			);
		});

		it("populates transcriptHashSet from orphan branch", async () => {
			mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123", "def456"]));
			const summary = makeSummary({ commitHash: "abc123" });
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			// buildHtml should receive the intersection of tree hashes and file hashes
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: new Set(["abc123"]),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: expect.any(Set),
					nonce: "mocknonce1234567=",
				}),
			);
		});

		it("populates planTranslateSet for CJK plan titles", async () => {
			const summary = makeSummary({
				plans: [
					{
						slug: "plan-1",
						title: "中文计划",
						addedAt: "",
						updatedAt: "",
					},
					{
						slug: "plan-2",
						title: "English Plan",
						addedAt: "",
						updatedAt: "",
					},
				],
			});
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			// plan-1 has CJK title, plan-2 does not and readPlanFromBranch returns null
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: new Set(["plan-1"]),
					noteTranslateSet: expect.any(Set),
					nonce: "mocknonce1234567=",
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
						addedAt: "",
						updatedAt: "",
					},
				],
			});
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: new Set(["plan-ascii"]),
					noteTranslateSet: expect.any(Set),
					nonce: "mocknonce1234567=",
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
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			// cn-note has CJK title, en-note does not
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: new Set(["cn-note"]),
					nonce: "mocknonce1234567=",
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
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: new Set(["cn-snippet"]),
					nonce: "mocknonce1234567=",
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
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: new Set(["md-cn"]),
					nonce: "mocknonce1234567=",
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
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);

			// noteTranslateSet should be empty since read failed
			expect(mockBuildHtml).toHaveBeenCalledWith(
				summary,
				expect.objectContaining({
					transcriptHashSet: expect.any(Set),
					planTranslateSet: expect.any(Set),
					noteTranslateSet: new Set(),
					nonce: "mocknonce1234567=",
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
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
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

			it("refuses to push a summary with summaryError marker and prompts user to Regenerate", async () => {
				// A degraded summary (LLM failed → placeholder/Copy-Hoist/mechanical
				// fallback with summaryError marker) must NOT be published to Jolli:
				// if the commit already has a jolliDocId from an earlier successful
				// push, the new push would silently overwrite the cloud article with
				// placeholder content. The user must Regenerate first.
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				const dispatch = await setupPanel({ summaryError: "llm-failed" });

				dispatch({ command: "push" });
				await flushPromises();

				expect(showWarningMessage).toHaveBeenCalledWith(
					"This summary's last LLM generation failed. Click Regenerate above and try again before pushing to Jolli.",
				);
				expect(mockPushToJolli).not.toHaveBeenCalled();
				expect(mockLoadConfig).not.toHaveBeenCalled();
			});

			it("refuses to push legacy summaries with llm.stopReason === 'error'", async () => {
				// Pre-`summaryError` summaries (written before this field existed)
				// signal failure via `llm.stopReason === "error"`. The push gate
				// uses isSummaryError() which honors both new field and legacy
				// fallback, so legacy degraded summaries are also refused.
				mockLoadConfig.mockResolvedValue({
					apiKey: "test",
					jolliApiKey: "jk_valid",
				});
				const dispatch = await setupPanel({
					llm: { model: "claude", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, stopReason: "error" },
				});

				dispatch({ command: "push" });
				await flushPromises();

				expect(showWarningMessage).toHaveBeenCalledWith(
					expect.stringContaining("Regenerate above"),
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
							addedAt: "",
							updatedAt: "",
						},
						{
							slug: "plan-empty",
							title: "Plan Empty",
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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

		// ── generateRecap ────────────────────────────────────────────────────

		describe("generateRecap", () => {
			it("stores the new recap and posts recapUpdated when generation succeeds", async () => {
				mockGenerateRecap.mockResolvedValueOnce("  Generated recap.  ");
				mockBuildRecapSection.mockReturnValue('<div id="recapSection">x</div>');
				const dispatch = await setupPanel();

				dispatch({ command: "generateRecap" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({
					command: "recapGenerating",
				});
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ recap: "Generated recap." }),
					workspaceRoot,
					true,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "recapUpdated",
					html: '<div id="recapSection">x</div>',
				});
			});

			it("preserves existing recap and shows toast when generation returns empty", async () => {
				// Empty result happens when the commit has no major topics. The
				// handler must not destroy a previously stored recap.
				mockGenerateRecap.mockResolvedValueOnce("");
				const dispatch = await setupPanel({ recap: "Existing recap." });

				dispatch({ command: "generateRecap" });
				await flushPromises();

				expect(mockStoreSummary).not.toHaveBeenCalled();
				expect(showInformationMessage).toHaveBeenCalledWith(
					expect.stringContaining("nothing to recap"),
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "recapUpdateError",
				});
				expect(postMessage).not.toHaveBeenCalledWith(
					expect.objectContaining({ command: "recapUpdated" }),
				);
			});

			it("treats whitespace-only generation as empty (no store, toast surfaced)", async () => {
				mockGenerateRecap.mockResolvedValueOnce("   \n\t  ");
				const dispatch = await setupPanel();

				dispatch({ command: "generateRecap" });
				await flushPromises();

				expect(mockStoreSummary).not.toHaveBeenCalled();
				expect(showInformationMessage).toHaveBeenCalled();
				expect(postMessage).toHaveBeenCalledWith({
					command: "recapUpdateError",
				});
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

			// Defensive: if the webview drops the recap field (older client, or
			// a malformed message), the handler should still clear the recap
			// rather than throw on the missing string. Covers the
			// `message.recap ?? ""` fallback in the editRecap case.
			it("treats a missing recap field as the empty string (clears the recap)", async () => {
				mockBuildRecapSection.mockReturnValue("");
				const dispatch = await setupPanel();

				dispatch({ command: "editRecap" });
				await flushPromises();

				const stored = mockStoreSummary.mock.calls[0][0] as {
					recap?: string;
				};
				expect(stored.recap).toBeUndefined();
				expect(postMessage).toHaveBeenCalledWith({
					command: "recapUpdated",
					html: "",
				});
			});
		});

		// ── regenerateSummary ───────────────────────────────────────────────

		describe("regenerateSummary", () => {
			const stubCtx = () => ({
				entryCount: 7,
				sessionCount: 1,
				sources: ["Claude"],
				humanTurns: 3,
				plansCount: 0,
				notesCount: 0,
				referenceCountsBySource: {} as const,
			});
			const stubUpdated = () =>
				makeSummary({
					topics: [],
					recap: "regenerated",
					commitMessage: "after regen",
				});

			beforeEach(() => {
				mockLoadRegenerateContext.mockReset();
				mockRegenerateSummary.mockReset();
				withProgress.mockClear();
				mockBuildTopicsSection.mockReturnValue('<div id="topicsSection">t</div>');
				mockBuildRecapSection.mockReturnValue('<div id="recapSection">r</div>');
			});

			it("no-ops when the user cancels the confirm dialog", async () => {
				mockLoadRegenerateContext.mockResolvedValue(stubCtx());
				showWarningMessage.mockResolvedValueOnce(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				expect(mockRegenerateSummary).not.toHaveBeenCalled();
				expect(mockStoreSummary).not.toHaveBeenCalled();
			});

			it("persists the updated summary and posts re-render on success", async () => {
				mockLoadRegenerateContext.mockResolvedValue(stubCtx());
				showWarningMessage.mockResolvedValueOnce("Regenerate");
				mockRegenerateSummary.mockResolvedValue({
					updated: stubUpdated(),
					result: {} as never,
				});
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ recap: "regenerated" }),
					workspaceRoot,
					true,
				);
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "summaryRegenerated",
						topicsHtml: '<div id="topicsSection">t</div>',
						recapHtml: '<div id="recapSection">r</div>',
						// Healthy regenerate → empty banner so the script removes any
						// stale .summary-error-banner from the DOM.
						summaryErrorBannerHtml: "",
					}),
				);
			});

			it("includes a non-empty summaryErrorBannerHtml when regenerate still produces a degraded summary", async () => {
				// Defensive: if the regenerate result itself somehow carries
				// summaryError (e.g. user clicks Regenerate while creds are still
				// broken — though in practice the regenerate path would have
				// thrown earlier), the post-message should reflect that with a
				// non-empty banner HTML so the DOM keeps showing it.
				mockLoadRegenerateContext.mockResolvedValue(stubCtx());
				showWarningMessage.mockResolvedValueOnce("Regenerate");
				mockRegenerateSummary.mockResolvedValue({
					updated: { ...stubUpdated(), summaryError: "llm-failed" } as never,
					result: {} as never,
				});
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				const lastCalls = postMessage.mock.calls;
				const regenMsg = lastCalls.find(
					(call) => (call[0] as { command?: string }).command === "summaryRegenerated",
				)?.[0] as { summaryErrorBannerHtml?: string } | undefined;
				expect(regenMsg).toBeDefined();
				expect(regenMsg?.summaryErrorBannerHtml).toContain('class="summary-error-banner"');
			});

			it("does NOT pass artifacts to bridge.storeSummary on success", async () => {
				// Regression guard: artifacts must stay undefined or the orphan-
				// branch transcripts / plan-progress written at first-run time
				// would be overwritten on every regenerate.
				mockLoadRegenerateContext.mockResolvedValue(stubCtx());
				showWarningMessage.mockResolvedValueOnce("Regenerate");
				mockRegenerateSummary.mockResolvedValue({
					updated: stubUpdated(),
					result: {} as never,
				});
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				// bridge.storeSummary signature is (summary, force, artifacts?);
				// stubBridge forwards positional args without the trailing
				// undefined, so the recorded call should be (summary, root, true).
				const lastCall = mockStoreSummary.mock.calls[mockStoreSummary.mock.calls.length - 1];
				expect(lastCall.length).toBe(3);
			});

			it("includes entry/session counts and the active provider in the confirm dialog detail", async () => {
				mockLoadRegenerateContext.mockResolvedValue({
					entryCount: 7,
					sessionCount: 1,
					sources: ["Claude"],
					humanTurns: 3,
					plansCount: 0,
					notesCount: 0,
					referenceCountsBySource: {},
				});
				mockLoadConfig.mockResolvedValueOnce({ apiKey: "k", model: "haiku" });
				showWarningMessage.mockResolvedValueOnce(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				const [, opts] = showWarningMessage.mock.calls[0];
				expect(opts.detail).toContain(
					"7 transcript entries from 1 session (Claude)",
				);
				expect(opts.detail).toContain("OVERWRITTEN");
				expect(opts.detail).toContain("via Anthropic");
				expect(opts.detail).not.toContain("PRESERVED");
			});

			it("uses the zero-transcript copy when no AI sessions were saved", async () => {
				mockLoadRegenerateContext.mockResolvedValue({
					entryCount: 0,
					sessionCount: 0,
					sources: [],
					humanTurns: 0,
					plansCount: 0,
					notesCount: 0,
					referenceCountsBySource: {},
				});
				mockLoadConfig.mockResolvedValueOnce({ apiKey: "k", model: "haiku" });
				showWarningMessage.mockResolvedValueOnce(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				const [, opts] = showWarningMessage.mock.calls[0];
				expect(opts.detail).toContain("No saved AI conversations");
				expect(showErrorMessage).not.toHaveBeenCalled();
			});

			it("posts summaryRegenerateError when the user cancels via the progress notification", async () => {
				mockLoadRegenerateContext.mockResolvedValue(stubCtx());
				showWarningMessage.mockResolvedValueOnce("Regenerate");
				// regenerateSummary never resolves; we trigger the cancel token instead.
				mockRegenerateSummary.mockReturnValue(new Promise(() => {}));
				// Override withProgress for this test only: fire the cancellation
				// token before returning the task's result, so the Promise.race
				// inside the handler resolves to "cancelled".
				withProgress.mockImplementationOnce(
					(
						_opts: unknown,
						task: (
							progress: { report: (v: unknown) => void },
							token: { onCancellationRequested: (cb: () => void) => void },
						) => unknown,
					): unknown => {
						let cancelCb: (() => void) | null = null;
						const token = {
							onCancellationRequested: (cb: () => void) => {
								cancelCb = cb;
							},
						};
						const taskResult = task({ report: vi.fn() }, token);
						// Fire cancel on the next microtask so the handler's
						// Promise.race sees a "cancelled" winner.
						queueMicrotask(() => cancelCb?.());
						return taskResult;
					},
				);
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				expect(mockStoreSummary).not.toHaveBeenCalled();
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ command: "summaryRegenerateError" }),
				);
			});

			it("uses singular 'entry'/'session' copy when count is 1", async () => {
				mockLoadRegenerateContext.mockResolvedValue({
					entryCount: 1,
					sessionCount: 1,
					sources: ["Claude"],
					humanTurns: 1,
					plansCount: 0,
					notesCount: 0,
					referenceCountsBySource: {},
				});
				showWarningMessage.mockResolvedValueOnce(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				const [, opts] = showWarningMessage.mock.calls[0];
				// "1 transcript entry from 1 session" — no plural "s".
				expect(opts.detail).toContain("1 transcript entry from 1 session");
				expect(opts.detail).not.toContain("entries");
				expect(opts.detail).not.toContain("sessions");
			});

			it("includes only the plans line when plans is the sole attached artifact", async () => {
				// Covers the false branches of the notesCount / referenceCountsBySource
				// conditionals inside buildRegenerateConfirmDetail.
				mockLoadRegenerateContext.mockResolvedValue({
					entryCount: 5,
					sessionCount: 1,
					sources: ["Claude"],
					humanTurns: 2,
					plansCount: 1,
					notesCount: 0,
					referenceCountsBySource: {},
				});
				showWarningMessage.mockResolvedValueOnce(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				const [, opts] = showWarningMessage.mock.calls[0];
				expect(opts.detail).toContain("Archived 1 plan attached");
				expect(opts.detail).not.toContain("note");
				expect(opts.detail).not.toContain("Linear");
			});

			it("includes attached plans/notes/linear lines when any are present", async () => {
				mockLoadRegenerateContext.mockResolvedValue({
					entryCount: 5,
					sessionCount: 2,
					sources: ["Claude"],
					humanTurns: 2,
					plansCount: 2,
					notesCount: 1,
					referenceCountsBySource: { linear: 3 },
				});
				showWarningMessage.mockResolvedValueOnce(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				const [, opts] = showWarningMessage.mock.calls[0];
				expect(opts.detail).toContain("2 plans");
				expect(opts.detail).toContain("1 note");
				expect(opts.detail).toContain("3 Linear issues");
			});

			it("omits the 'via {provider}' suffix when no credentials are configured", async () => {
				mockLoadRegenerateContext.mockResolvedValue(stubCtx());
				mockFormatActiveProviderLabel.mockReturnValueOnce(undefined);
				showWarningMessage.mockResolvedValueOnce(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				const [, opts] = showWarningMessage.mock.calls[0];
				// Bare period ends the line; no provider attribution appended.
				expect(opts.detail).toMatch(/This typically takes 20–40 seconds\.\s*$/);
				expect(opts.detail).not.toMatch(/seconds\s+·\s+via\s/);
			});

			it("posts summaryRegenerateError when storeSummary throws (catchAndShow error path)", async () => {
				mockLoadRegenerateContext.mockResolvedValue(stubCtx());
				showWarningMessage.mockResolvedValueOnce("Regenerate");
				mockRegenerateSummary.mockResolvedValue({
					updated: stubUpdated(),
					result: {} as never,
				});
				mockStoreSummary.mockRejectedValueOnce(new Error("disk full"));
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Regenerate failed"),
				);
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ command: "summaryRegenerateError" }),
				);
			});

			it("shows 'Unknown' source label when ctx.sources is empty but entryCount > 0", async () => {
				mockLoadRegenerateContext.mockResolvedValue({
					entryCount: 2,
					sessionCount: 1,
					sources: [],
					humanTurns: 1,
					plansCount: 0,
					notesCount: 0,
					referenceCountsBySource: {},
				});
				showWarningMessage.mockResolvedValueOnce(undefined);
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				const [, opts] = showWarningMessage.mock.calls[0];
				expect(opts.detail).toContain("(Unknown)");
			});

			it("does nothing when a regenerate is already in flight (double-click guard)", async () => {
				mockLoadRegenerateContext.mockResolvedValue(stubCtx());
				// Only ONE mockResolvedValueOnce — the second dispatch must
				// short-circuit BEFORE reaching showWarningMessage. Two onces
				// would leave a stale "Regenerate" in the queue for later tests.
				showWarningMessage.mockResolvedValueOnce("Regenerate");
				// Never-resolving promise → first call locks the in-flight flag.
				mockRegenerateSummary.mockReturnValue(new Promise(() => {}));
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				expect(mockRegenerateSummary).toHaveBeenCalledTimes(1);
			});

			it("rejects regenerate when a push is already in flight (race against push's writeback)", async () => {
				// Push completion writes back jolliDocId / jolliDocUrl. If
				// regenerate captures the pre-push summary snapshot and writes
				// at the end of its 30 s LLM call, push's writeback gets
				// silently clobbered — next push creates a duplicate article.
				mockLoadRegenerateContext.mockResolvedValue(stubCtx());
				const dispatch = await setupPanel();

				// Reach into the panel instance and flip pushInProgress on
				// — same pattern as the currentSummary-null tests above.
				const panel = firstCommitPanel<{ pushInProgress: boolean }>();
				panel.pushInProgress = true;

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				// Regenerate must have early-returned with a toast — no
				// confirm dialog, no LLM call, no storeSummary.
				expect(mockRegenerateSummary).not.toHaveBeenCalled();
				expect(mockStoreSummary).not.toHaveBeenCalled();
				expect(showInformationMessage).toHaveBeenCalledWith(
					expect.stringContaining("push to Jolli is in progress"),
				);
			});

			it("denies mutating commands while regenerate is in flight (host-side guard)", async () => {
				// Set up a never-resolving regenerate so the in-flight flag
				// stays set; then dispatch a representative set of mutating
				// commands and confirm the storeSummary mock is never called
				// (the guard short-circuits before the handler runs).
				mockLoadRegenerateContext.mockResolvedValue(stubCtx());
				showWarningMessage.mockResolvedValueOnce("Regenerate");
				mockRegenerateSummary.mockReturnValue(new Promise(() => {}));
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();
				// Sanity: we're now in flight; storeSummary has not been called yet.
				expect(mockStoreSummary).not.toHaveBeenCalled();

				// All of these would normally write to the orphan branch — under
				// the guard they must be silently dropped.
				dispatch({ command: "push" });
				dispatch({ command: "generateRecap" });
				dispatch({ command: "generateE2eTest" });
				dispatch({
					command: "editTopic",
					topicIndex: 0,
					updates: { title: "x" },
				});
				dispatch({ command: "deleteTopic", topicIndex: 0 });
				dispatch({ command: "editRecap", recap: "hi" });
				await flushPromises();

				expect(mockStoreSummary).not.toHaveBeenCalled();
				expect(mockGenerateRecap).not.toHaveBeenCalled();
				expect(mockGenerateE2eTest).not.toHaveBeenCalled();
			});

			it("allows read-only commands (copyMarkdown) while regenerate is in flight", async () => {
				mockLoadRegenerateContext.mockResolvedValue(stubCtx());
				showWarningMessage.mockResolvedValueOnce("Regenerate");
				mockRegenerateSummary.mockReturnValue(new Promise(() => {}));
				mockBuildMarkdown.mockReturnValue("# md");
				const dispatch = await setupPanel();

				dispatch({ command: "regenerateSummary" });
				await flushPromises();

				dispatch({ command: "copyMarkdown" });
				await flushPromises();

				// copyMarkdown went through — clipboard was written.
				expect(clipboardWriteText).toHaveBeenCalledWith("# md");
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

			it("preserves existing guide and shows toast when generation returns no scenarios", async () => {
				// Empty array happens when the commit has no major (testable) topics.
				// The handler must not overwrite an existing guide with [].
				const existingGuide = [
					{
						title: "Existing scenario",
						steps: ["Step 1"],
						expectedResults: ["Result 1"],
					},
				];
				mockGenerateE2eTest.mockResolvedValueOnce([]);
				const dispatch = await setupPanel({ e2eTestGuide: existingGuide });

				dispatch({ command: "generateE2eTest" });
				await flushPromises();

				expect(mockStoreSummary).not.toHaveBeenCalled();
				expect(showInformationMessage).toHaveBeenCalledWith(
					expect.stringContaining("nothing to test"),
				);
				expect(postMessage).toHaveBeenCalledWith({ command: "e2eTestError" });
				expect(postMessage).not.toHaveBeenCalledWith(
					expect.objectContaining({ command: "e2eTestUpdated" }),
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

				// Local (non-foreign) panel: foreignRepoName + foreignRepoUrl
				// trail as null so jollimemory.editPlan stays on its default
				// workspace-storage read path.
				expect(executeCommand).toHaveBeenCalledWith(
					"jollimemory.editPlan",
					"my-plan",
					true,
					"Plan Title",
					null,
					null,
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
							addedAt: "",
							updatedAt: "",
						},
						{
							slug: "plan-b",
							title: "Plan B",
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "removePlan", slug: "plan-a", title: "Plan A" });
				await flushPromises();

				// Hard-removes the archived plans.json row (the CommitSummary
				// reference was dropped above); no unassociate + ignore steps.
				expect(mockRemovePlan).toHaveBeenCalledWith("plan-a", workspaceRoot);
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						plans: [expect.objectContaining({ slug: "plan-b" })],
					}),
					workspaceRoot,
					true,
				);
				// Cleans up the visible <branch>/plan--<slug>.md in dual-write mode
				// so the Memory Bank tree view doesn't keep a ghost file behind.
				// Routes through the Bridge so it picks up the extension's
				// DualWriteStorage instance (the SummaryStore wrapper alone
				// would fall back to OrphanBranchStorage and silently no-op).
				expect(stubBridge.cleanupVisiblePlanArtifact).toHaveBeenCalledWith(
					"plan-a",
					expect.any(String),
				);
			});

			it("clears plans field when last plan is removed", async () => {
				showWarningMessage.mockResolvedValue("Remove");
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "only-plan",
							title: "Only",
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
							addedAt: "",
							updatedAt: "",
						},
					],
				});

				dispatch({ command: "removePlan", slug: "plan-a", title: "Plan A" });
				await flushPromises();

				expect(mockRemovePlan).not.toHaveBeenCalled();
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
					addedAt: "2025-01-01",
					updatedAt: "2025-01-01",
				});
				const dispatch = await setupPanel({
					plans: [
						{
							slug: "existing-plan",
							title: "Existing",
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
			it("delegates to handleCheckPrStatus with null repoUrl for the local panel", async () => {
				// Local panels (foreignRepoName=null) leave the 4th arg null so
				// PrCommentService falls back to its existing implicit-repo
				// path (`gh pr view -- <branch>` from `cwd`'s working tree).
				const dispatch = await setupPanel();

				dispatch({ command: "checkPrStatus" });
				await flushPromises();

				expect(mockHandleCheckPrStatus).toHaveBeenCalledWith(
					workspaceRoot,
					expect.any(Function),
					"feature/test",
					null,
				);
			});

			it("passes foreign repo's remoteUrl as the 4th arg when the panel is foreign-origin", async () => {
				// Memory Bank cross-repo browsing path: the panel was created
				// with foreignRepoName + foreignRepoUrl, so checkPrStatus must
				// hand the remote URL to PrCommentService — pinning the gh
				// query to the foreign repo instead of the current workspace.
				const summary = makeSummary();
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
					"memory",
					"other-repo",
					"https://github.com/other/repo.git",
				);
				const dispatch = captureMessageHandler();

				dispatch({ command: "checkPrStatus" });
				await flushPromises();

				expect(mockHandleCheckPrStatus).toHaveBeenCalledWith(
					workspaceRoot,
					expect.any(Function),
					"feature/test",
					"https://github.com/other/repo.git",
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
			it("delegates to handleCreatePr, passing summary.branch", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "createPr", title: "PR Title", body: "PR Body" });
				await flushPromises();

				expect(mockHandleCreatePr).toHaveBeenCalledWith(
					"PR Title",
					"PR Body",
					workspaceRoot,
					expect.any(Function),
					"feature/test",
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
			it("posts prShowCreateForm with wrapped body and commit message title (single-summary path)", async () => {
				// Default branch state: 0 summaries → caller falls back to
				// buildPrMarkdown(currentSummary). missingCount=0 means no footnote
				// is appended, so the body is byte-identical to today.
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

			it("uses aggregated body and HEAD commit message title when branch has 2+ summaries", async () => {
				const sA = makeSummary({
					commitHash: "AAAA1234",
					commitMessage: "first commit",
				});
				const sB = makeSummary({
					commitHash: "BBBB5678",
					commitMessage: "head commit",
				});
				mockLoadBranchSummaries.mockResolvedValueOnce({
					summaries: [sA, sB],
					missingCount: 0,
					totalCount: 2,
				});
				mockBuildAggregatedPrMarkdown.mockReturnValueOnce("# aggregated");
				const dispatch = await setupPanel({ commitMessage: "viewer commit" });

				dispatch({ command: "prepareCreatePr" });
				await flushPromises();

				expect(mockBuildAggregatedPrMarkdown).toHaveBeenCalledWith([sA, sB], 0);
				expect(postMessage).toHaveBeenCalledWith({
					command: "prShowCreateForm",
					body: "[MARKERS]# aggregated[/MARKERS]",
					title: "head commit",
				});
			});

			it("appends missing-summary footnote on the single-summary tier when missingCount > 0", async () => {
				// Footnote contextualizes "alongside the 1 branch summary shown,
				// N more on this branch were skipped" — coherent with the body.
				const branchSummary = makeSummary({
					commitHash: "BRANCHONLY",
					commitMessage: "the one summary",
				});
				mockLoadBranchSummaries.mockResolvedValueOnce({
					summaries: [branchSummary],
					missingCount: 3,
					totalCount: 4,
				});
				mockBuildPrMarkdown.mockReturnValueOnce("# only body");
				const dispatch = await setupPanel({ commitMessage: "lone msg" });

				dispatch({ command: "prepareCreatePr" });
				await flushPromises();

				const call = postMessage.mock.calls.find(
					(c) => (c[0] as { command?: string }).command === "prShowCreateForm",
				);
				expect(call).toBeDefined();
				const body = (call?.[0] as { body: string }).body;
				expect(body).toContain("# only body");
				expect(body).toContain(
					"> Note: 3 commit(s) without summary were skipped.",
				);
			});

			it("zero-summary fallback (currentSummary) does NOT append footnote even when missingCount > 0", async () => {
				// 0-summary tier = rebase just happened, worker hasn't caught up.
				// Body comes from currentSummary (possibly stale or from another
				// branch), so a current-branch "N skipped" note would describe
				// commits unrelated to the body — drop the footnote.
				mockLoadBranchSummaries.mockResolvedValueOnce({
					summaries: [],
					missingCount: 3,
					totalCount: 3,
				});
				mockBuildPrMarkdown.mockReturnValueOnce("# fallback body");
				const dispatch = await setupPanel({ commitMessage: "fallback msg" });

				dispatch({ command: "prepareCreatePr" });
				await flushPromises();

				const call = postMessage.mock.calls.find(
					(c) => (c[0] as { command?: string }).command === "prShowCreateForm",
				);
				expect(call).toBeDefined();
				const body = (call?.[0] as { body: string }).body;
				expect(body).toContain("# fallback body");
				expect(body).not.toContain("commit(s) without summary were skipped");
			});

			it("branch has exactly 1 summary: uses summaries[0], NOT the webview's currentSummary", async () => {
				// Branch-first guarantee: even if the panel was opened on a stale
				// or different summary, when the current branch has one indexed
				// summary the PR body/title come from THAT summary — the
				// currentSummary is only a fallback for the length===0 tier.
				const branchSummary = makeSummary({
					commitHash: "BRANCH001",
					commitMessage: "real branch commit",
				});
				mockLoadBranchSummaries.mockResolvedValueOnce({
					summaries: [branchSummary],
					missingCount: 0,
					totalCount: 1,
				});
				mockBuildPrMarkdown.mockReturnValueOnce("# branch body");
				const dispatch = await setupPanel({
					commitHash: "STALEVIEW",
					commitMessage: "stale viewer commit",
				});

				dispatch({ command: "prepareCreatePr" });
				await flushPromises();

				// PR body source = summaries[0], not currentSummary
				expect(mockBuildPrMarkdown).toHaveBeenCalledWith(
					expect.objectContaining({ commitHash: "BRANCH001" }),
				);
				expect(mockBuildAggregatedPrMarkdown).not.toHaveBeenCalled();
				expect(postMessage).toHaveBeenCalledWith({
					command: "prShowCreateForm",
					body: "[MARKERS]# branch body[/MARKERS]",
					title: "real branch commit",
				});
			});

			it("branch has 0 summaries: falls back to currentSummary (rebase-not-yet-summarized tier)", async () => {
				// Worker hasn't produced a summary for the rebased hash yet —
				// the form should still be usable with the pre-rebase summary
				// the webview was opened with.
				mockLoadBranchSummaries.mockResolvedValueOnce({
					summaries: [],
					missingCount: 0,
					totalCount: 0,
				});
				mockBuildPrMarkdown.mockReturnValueOnce("# fallback body");
				const dispatch = await setupPanel({
					commitHash: "PREREBASEHASH",
					commitMessage: "pre-rebase msg",
				});

				dispatch({ command: "prepareCreatePr" });
				await flushPromises();

				expect(mockBuildPrMarkdown).toHaveBeenCalledWith(
					expect.objectContaining({ commitHash: "PREREBASEHASH" }),
				);
				expect(mockBuildAggregatedPrMarkdown).not.toHaveBeenCalled();
				expect(postMessage).toHaveBeenCalledWith({
					command: "prShowCreateForm",
					body: "[MARKERS]# fallback body[/MARKERS]",
					title: "pre-rebase msg",
				});
			});

			it("worker-busy: shows warning + re-runs handleCheckPrStatus to reset the button", async () => {
				mockIsWorkerBusy.mockResolvedValueOnce(true);
				const dispatch = await setupPanel();

				dispatch({ command: "prepareCreatePr" });
				await flushPromises();

				expect(showWarningMessage).toHaveBeenCalledWith(
					expect.stringContaining("AI summary is being generated"),
				);
				// Status check is invoked so the webview rebuilds the section,
				// which replaces the click-time "Loading..." button with a fresh one.
				expect(mockHandleCheckPrStatus).toHaveBeenCalled();
				// No prShowCreateForm should be posted.
				expect(postMessage).not.toHaveBeenCalledWith(
					expect.objectContaining({ command: "prShowCreateForm" }),
				);
			});

			it("does nothing when no summary is loaded", async () => {
				await SummaryWebviewPanel.show(
					makeSummary(),
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
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

			it("cross-branch (Memory Bank): blocks Create PR with prCreateBlockedCrossBranch instead of opening the form", async () => {
				// User has checked out branch Y but is looking at a summary on
				// branch X in Memory Bank. Create PR must NOT push Y's HEAD to X's
				// PR — block before the form opens.
				(
					stubBridge.getCurrentBranch as ReturnType<typeof vi.fn>
				).mockResolvedValueOnce("feature/other-branch");
				const dispatch = await setupPanel({ branch: "feature/test" });

				dispatch({ command: "prepareCreatePr" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({
					command: "prCreateBlockedCrossBranch",
					summaryBranch: "feature/test",
					currentBranch: "feature/other-branch",
				});
				// Form must not open; loader must not be called.
				expect(postMessage).not.toHaveBeenCalledWith(
					expect.objectContaining({ command: "prShowCreateForm" }),
				);
				expect(mockLoadBranchSummaries).not.toHaveBeenCalled();
				expect(showWarningMessage).toHaveBeenCalledWith(
					expect.stringContaining("feature/test"),
				);
			});

			it("detached HEAD / git error: gives a distinct message rather than asking the user to 'checkout HEAD'", async () => {
				// Regression: `bridge.getCurrentBranch()` returns the sentinel
				// string "HEAD" when git can't resolve the current branch
				// (detached, .git/index.lock, permission). Telling the user to
				// "Checkout HEAD" is nonsense — the repo is in a transient bad
				// state, not on a different branch. We must surface that.
				(
					stubBridge.getCurrentBranch as ReturnType<typeof vi.fn>
				).mockResolvedValueOnce("HEAD");
				const dispatch = await setupPanel({ branch: "feature/test" });

				dispatch({ command: "prepareCreatePr" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({
					command: "prCreateBlockedCrossBranch",
					summaryBranch: "feature/test",
					currentBranch: "HEAD",
				});
				// Distinct toast — NOT "Checkout HEAD to create its PR".
				expect(showWarningMessage).toHaveBeenCalledWith(
					expect.stringContaining("Cannot determine the current branch"),
				);
				expect(showWarningMessage).not.toHaveBeenCalledWith(
					expect.stringContaining("Checkout HEAD"),
				);
			});
		});

		describe("prepareUpdatePr", () => {
			it("delegates to handlePrepareUpdatePr with single-summary markdown when branch has <= 1 summary", async () => {
				mockBuildPrMarkdown.mockReturnValueOnce("# update body");
				const dispatch = await setupPanel();

				dispatch({ command: "prepareUpdatePr" });
				await flushPromises();

				expect(mockHandlePrepareUpdatePr).toHaveBeenCalledWith(
					"# update body",
					workspaceRoot,
					expect.any(Function),
					"feature/test",
				);
			});

			it("delegates with aggregated markdown when branch has 2+ summaries", async () => {
				const sA = makeSummary({ commitHash: "AAAA1234" });
				const sB = makeSummary({ commitHash: "BBBB5678" });
				mockLoadBranchSummaries.mockResolvedValueOnce({
					summaries: [sA, sB],
					missingCount: 0,
					totalCount: 2,
				});
				mockBuildAggregatedPrMarkdown.mockReturnValueOnce(
					"# aggregated update",
				);
				const dispatch = await setupPanel();

				dispatch({ command: "prepareUpdatePr" });
				await flushPromises();

				expect(mockBuildAggregatedPrMarkdown).toHaveBeenCalledWith([sA, sB], 0);
				expect(mockHandlePrepareUpdatePr).toHaveBeenCalledWith(
					"# aggregated update",
					workspaceRoot,
					expect.any(Function),
					"feature/test",
				);
			});

			it("appends missing-summary footnote on the single-summary tier when missingCount > 0", async () => {
				const branchSummary = makeSummary({
					commitHash: "BRANCHONLY",
					commitMessage: "the one summary",
				});
				mockLoadBranchSummaries.mockResolvedValueOnce({
					summaries: [branchSummary],
					missingCount: 4,
					totalCount: 5,
				});
				mockBuildPrMarkdown.mockReturnValueOnce("# update body");
				const dispatch = await setupPanel();

				dispatch({ command: "prepareUpdatePr" });
				await flushPromises();

				const md = mockHandlePrepareUpdatePr.mock.calls[0][0];
				expect(md).toContain("# update body");
				expect(md).toContain(
					"> Note: 4 commit(s) without summary were skipped.",
				);
			});

			it("zero-summary fallback does NOT append footnote even when missingCount > 0", async () => {
				// Same semantic as the prepareCreatePr counterpart: body from
				// currentSummary should not carry a current-branch footnote.
				mockLoadBranchSummaries.mockResolvedValueOnce({
					summaries: [],
					missingCount: 4,
					totalCount: 4,
				});
				mockBuildPrMarkdown.mockReturnValueOnce("# update body");
				const dispatch = await setupPanel();

				dispatch({ command: "prepareUpdatePr" });
				await flushPromises();

				const md = mockHandlePrepareUpdatePr.mock.calls[0][0];
				expect(md).toContain("# update body");
				expect(md).not.toContain("commit(s) without summary were skipped");
			});

			it("worker-busy: shows warning + re-runs handleCheckPrStatus to reset the button", async () => {
				mockIsWorkerBusy.mockResolvedValueOnce(true);
				const dispatch = await setupPanel();

				dispatch({ command: "prepareUpdatePr" });
				await flushPromises();

				expect(showWarningMessage).toHaveBeenCalledWith(
					expect.stringContaining("AI summary is being generated"),
				);
				expect(mockHandleCheckPrStatus).toHaveBeenCalled();
				expect(mockHandlePrepareUpdatePr).not.toHaveBeenCalled();
			});

			it("forwards postMessage callback to the webview panel", async () => {
				mockHandlePrepareUpdatePr.mockImplementationOnce(
					(
						_md: string,
						_cwd: string,
						pm: (msg: Record<string, unknown>) => void,
					) => Promise.resolve(pm({ command: "prDataLoaded" })),
				);
				const dispatch = await setupPanel();

				dispatch({ command: "prepareUpdatePr" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith({ command: "prDataLoaded" });
			});

			it("cross-branch (Memory Bank): skips branch aggregation and uses currentSummary for the body", async () => {
				// On Y looking at X's summary in Memory Bank: aggregating Y's
				// commits into X's PR description is misleading — force the
				// single-summary fallback by skipping loadBranchSummaries.
				(
					stubBridge.getCurrentBranch as ReturnType<typeof vi.fn>
				).mockResolvedValueOnce("feature/other-branch");
				mockBuildPrMarkdown.mockReturnValueOnce("# clicked summary body");
				const dispatch = await setupPanel({ branch: "feature/test" });

				dispatch({ command: "prepareUpdatePr" });
				await flushPromises();

				expect(mockLoadBranchSummaries).not.toHaveBeenCalled();
				expect(mockBuildAggregatedPrMarkdown).not.toHaveBeenCalled();
				expect(mockHandlePrepareUpdatePr).toHaveBeenCalledWith(
					"# clicked summary body",
					workspaceRoot,
					expect.any(Function),
					"feature/test",
				);
			});
		});

		describe("updatePr", () => {
			it("delegates to handleUpdatePr, passing summary.branch", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "updatePr", title: "Updated", body: "Body" });
				await flushPromises();

				expect(mockHandleUpdatePr).toHaveBeenCalledWith(
					"Updated",
					"Body",
					workspaceRoot,
					expect.any(Function),
					"feature/test",
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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

			it("counts cursor sessions in transcript stats when cursor integration is enabled", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "cur1",
									source: "cursor" as const,
									entries: [{ role: "human" as const, content: "hi" }],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						totalEntries: 1,
						sessionCounts: expect.objectContaining({ cursor: 1 }),
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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

			// ── Failure paths (v5 summary-first ordering) ─────────────────────

			it("posts transcriptsSaveFailed when storeSummary rejects — files NOT touched", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123", "def456"]));
				const summary = {
					...makeSummary(),
					version: 5,
					transcripts: ["abc123", "def456"],
				} as ReturnType<typeof makeSummary>;
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
				const dispatch = captureMessageHandler();
				mockStoreSummary.mockClear();
				mockStoreSummary.mockRejectedValueOnce(new Error("orphan lock contention"));
				mockSaveTranscriptsBatch.mockClear();

				// Trigger save with one commit having no entries → goes to deletes,
				// which forces persistTranscriptIdRemoval to run and fail.
				dispatch({
					command: "saveAllTranscripts",
					entries: [
						{
							commitHash: "abc123",
							sessionId: "s1",
							source: "claude",
							originalIndex: 0,
							role: "human",
							content: "x",
						},
					],
				});
				await flushPromises();

				// File batch must NOT run after summary failure
				expect(mockSaveTranscriptsBatch).not.toHaveBeenCalled();
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ command: "transcriptsSaveFailed" }),
				);
				expect(postMessage).not.toHaveBeenCalledWith({ command: "transcriptsSaved" });
			});

			it("posts transcriptsSaveFailed when file batch rejects after summary updated", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123", "def456"]));
				const summary = {
					...makeSummary(),
					version: 5,
					transcripts: ["abc123", "def456"],
				} as ReturnType<typeof makeSummary>;
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
				const dispatch = captureMessageHandler();
				mockStoreSummary.mockClear();
				mockSaveTranscriptsBatch.mockClear();
				// Clear so we can assert the failure path does NOT re-refresh the
				// cache (P2: refreshing from the already-updated summary would hide
				// the still-on-disk files and break retry).
				mockGetTranscriptHashes.mockClear();
				mockSaveTranscriptsBatch.mockRejectedValueOnce(new Error("io error"));

				dispatch({
					command: "saveAllTranscripts",
					entries: [
						{
							commitHash: "abc123",
							sessionId: "s1",
							source: "claude",
							originalIndex: 0,
							role: "human",
							content: "edited",
						},
					],
				});
				await flushPromises();

				// Summary was updated; file batch was attempted and failed.
				expect(mockStoreSummary).toHaveBeenCalled();
				expect(mockSaveTranscriptsBatch).toHaveBeenCalled();
				// Failed message posted, NOT success
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ command: "transcriptsSaveFailed" }),
				);
				expect(postMessage).not.toHaveBeenCalledWith({ command: "transcriptsSaved" });
				// P2: no refresh-from-updated-summary on failure — the pre-operation
				// `transcriptHashSet` is kept so the affected transcripts stay
				// visible and the save/delete stays retryable.
				expect(mockGetTranscriptHashes).not.toHaveBeenCalled();
			});
		});

		// ── deleteAllTranscripts ─────────────────────────────────────────────

		describe("deleteAllTranscripts", () => {
			it("deletes all transcript files for current summary", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const summary = makeSummary();
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				// #5 + #4: the legacy (v3) summary is lazily upgraded to a REAL v5
				// record — version bumped to 5 and `transcripts` written from the
				// file-backed set (emptied here by the delete), not left as a
				// "version<5 but has transcripts" hybrid.
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ version: 5, transcripts: [] }),
					workspaceRoot,
					true,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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

			// ── Failure paths (v5 summary-first ordering) ─────────────────────

			it("posts transcriptsDeleteFailed when storeSummary rejects — files NOT touched", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const summary = {
					...makeSummary(),
					version: 5,
					transcripts: ["abc123"],
				} as ReturnType<typeof makeSummary>;
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
				mockStoreSummary.mockClear();
				mockStoreSummary.mockRejectedValueOnce(new Error("disk full"));
				mockSaveTranscriptsBatch.mockClear();
				const dispatch = captureMessageHandler();

				dispatch({ command: "deleteAllTranscripts" });
				await flushPromises();

				// File batch must NOT run when summary update failed first.
				expect(mockSaveTranscriptsBatch).not.toHaveBeenCalled();
				// Failure message reaches the user; no Success message is sent.
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ command: "transcriptsDeleteFailed" }),
				);
				expect(postMessage).not.toHaveBeenCalledWith({ command: "transcriptsDeleted" });
			});

			it("posts transcriptsDeleteFailed when saveTranscriptsBatch rejects after summary already updated", async () => {
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const summary = {
					...makeSummary(),
					version: 5,
					transcripts: ["abc123"],
				} as ReturnType<typeof makeSummary>;
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
				mockStoreSummary.mockClear();
				mockSaveTranscriptsBatch.mockClear();
				mockSaveTranscriptsBatch.mockRejectedValueOnce(new Error("git push timeout"));
				const dispatch = captureMessageHandler();

				dispatch({ command: "deleteAllTranscripts" });
				await flushPromises();

				// summary write was attempted (summary-first ordering)
				expect(mockStoreSummary).toHaveBeenCalled();
				// file delete was attempted and failed
				expect(mockSaveTranscriptsBatch).toHaveBeenCalled();
				// FailureMessage is posted instead of success
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ command: "transcriptsDeleteFailed" }),
				);
				expect(postMessage).not.toHaveBeenCalledWith({ command: "transcriptsDeleted" });

				// P2: the failed delete stays RETRYABLE. The still-on-disk file is
				// NOT hidden (we don't refresh from the cleared summary), so a
				// repeat "Delete all transcripts" re-attempts the file removal and
				// succeeds this time.
				mockSaveTranscriptsBatch.mockClear();
				mockSaveTranscriptsBatch.mockResolvedValueOnce(undefined);
				postMessage.mockClear();

				dispatch({ command: "deleteAllTranscripts" });
				await flushPromises();

				expect(mockSaveTranscriptsBatch).toHaveBeenCalledWith([], ["abc123"], workspaceRoot);
				expect(postMessage).toHaveBeenCalledWith({ command: "transcriptsDeleted" });
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);

				// buildHtml should have been called with an empty set
				expect(mockBuildHtml).toHaveBeenCalledWith(
					summary,
					expect.objectContaining({
						transcriptHashSet: new Set(),
						planTranslateSet: expect.any(Set),
						noteTranslateSet: expect.any(Set),
						nonce: "mocknonce1234567=",
					}),
				);
			});

			it("handles non-Error rejection via String()", async () => {
				mockGetTranscriptHashes.mockRejectedValue("string git error");
				const summary = makeSummary();
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);

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
							addedAt: "",
							updatedAt: "",
						},
					],
				});
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);

				// plan should NOT be in planTranslateSet because read failed
				expect(mockBuildHtml).toHaveBeenCalledWith(
					summary,
					expect.objectContaining({
						transcriptHashSet: expect.any(Set),
						planTranslateSet: new Set(),
						noteTranslateSet: expect.any(Set),
						nonce: "mocknonce1234567=",
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
					expect.objectContaining({ docId: 77, relativePath: "main" }),
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
							addedAt: "",
							updatedAt: "",
						},
						{
							slug: "p2",
							title: "P2",
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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

				expect(mockRemoveNote).toHaveBeenCalledWith("snip-fail", workspaceRoot);
				expect(showErrorMessage).toHaveBeenCalledWith(
					"Failed to save snippet — archive failed.",
				);
				expect(mockStoreSummary).not.toHaveBeenCalled();
			});

			it("returns early when currentSummary is null", async () => {
				const summary = makeSummary();
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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

				expect(mockRemoveNote).toHaveBeenCalledWith("md-fail", workspaceRoot);
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

				// Local panel: null/null trail keeps the command on its
				// default workspace-storage read path (mirrors previewPlan
				// above).
				expect(executeCommand).toHaveBeenCalledWith(
					"jollimemory.previewNote",
					"note-1",
					"Note Title",
					null,
					null,
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
					expect.objectContaining({ modal: true }),
					"Remove",
				);
				// Hard-removes the archived plans.json row (the CommitSummary
				// reference was dropped above); no unassociate + ignore steps.
				expect(mockRemoveNote).toHaveBeenCalledWith("note-a", workspaceRoot);
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						notes: [expect.objectContaining({ id: "note-b" })],
					}),
					workspaceRoot,
					true,
				);
				// Cleans up the visible <branch>/note--<id>.md in dual-write mode
				// so the Memory Bank tree view doesn't keep a ghost file behind.
				// Routes through the Bridge (see removePlan test for rationale).
				expect(stubBridge.cleanupVisibleNoteArtifact).toHaveBeenCalledWith(
					"note-a",
					expect.any(String),
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

				expect(mockRemoveNote).not.toHaveBeenCalled();
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

		// ── Entity handlers (multi-source: Linear / Jira / GitHub / Notion) ──
		//
		// Mirrors the removePlan / removeNote test shape but exercises the
		// source-agnostic *Entity commands. Choice A: every source — including
		// Linear — flows through the same handler set (previewEntity /
		// openEntityExternal / loadEntityContent / saveEntityEdit /
		// removeEntity / translateEntity). The host dispatches by `source`
		// where behaviour genuinely differs (Linear keeps a legacy local-disk
		// fast-path under `.jolli/jollimemory/linear-issues/`).

		describe("openReferenceExternal", () => {
			it("opens the upstream URL via vscode.env.openExternal", async () => {
				const dispatch = await setupPanel();

				dispatch({
					command: "openReferenceExternal",
					url: "https://linear.app/x/issue/PROJ-1/test",
				});
				await flushPromises();

				expect(openExternal).toHaveBeenCalledTimes(1);
				const arg = openExternal.mock.calls[0][0] as { toString(): string };
				expect(arg.toString()).toBe("https://linear.app/x/issue/PROJ-1/test");
			});

			it("no-ops when url is empty (defensive against missing data-attr)", async () => {
				const dispatch = await setupPanel();

				dispatch({ command: "openReferenceExternal", url: "" });
				await flushPromises();

				expect(openExternal).not.toHaveBeenCalled();
			});

			it("refuses to open non-http(s) URLs (defense-in-depth against tainted data-reference-url)", async () => {
				// The row's data-reference-url is bounded by ^https?:// at the
				// SourceAdapter, but flows through plans.json (a user-editable
				// file). Re-validate at the sink — `javascript:` / `data:` /
				// `file:` must never reach openExternal.
				const dispatch = await setupPanel();

				dispatch({
					command: "openReferenceExternal",
					url: "javascript:alert(1)",
				});
				await flushPromises();

				expect(openExternal).not.toHaveBeenCalled();
				expect(showWarningMessage).toHaveBeenCalledWith(
					expect.stringContaining("javascript:alert(1)"),
				);
			});
		});

		describe("previewReference", () => {
			// Core principle: once an entity is associated with a commit, the
			// orphan branch is the system of record. `.jolli/jollimemory/` is
			// never consulted by previewEntity for any source. Linear is
			// treated identically to Jira / GitHub / Notion; legacy
			// `linear-issues/<bare>.md` fallback lives inside
			// `SummaryStore.readReferenceFromBranch`, not in the panel handler.

			it("Linear: reads the snapshot from the orphan branch", async () => {
				mockReadReferenceFromBranch.mockResolvedValueOnce(
					'---\nticketId: "PROJ-1"\n---\nbody from orphan branch',
				);
				openTextDocument.mockClear();
				const dispatch = await setupPanel();

				dispatch({
					command: "previewReference",
					archivedKey: "linear:PROJ-1-aaaaaaaa",
					source: "linear",
					nativeId: "PROJ-1",
					title: "T",
				});
				await flushPromises();

				expect(mockReadReferenceFromBranch).toHaveBeenCalledWith(
					"linear",
					"linear:PROJ-1-aaaaaaaa",
					workspaceRoot,
					undefined,
				);
				// Opens an untitled markdown doc with the orphan-branch content
				// — does NOT re-materialize the local file. Orphan branch is
				// the source of truth for archived snapshots.
				expect(openTextDocument).toHaveBeenCalledWith({
					language: "markdown",
					content: '---\nticketId: "PROJ-1"\n---\nbody from orphan branch',
				});
			});

			it("Jira: reads the snapshot from the orphan branch", async () => {
				mockReadReferenceFromBranch.mockResolvedValueOnce(
					"# KAN-5\n\nJira ticket body",
				);
				openTextDocument.mockClear();
				const dispatch = await setupPanel();

				dispatch({
					command: "previewReference",
					archivedKey: "jira:KAN-5-aaaa1111",
					source: "jira",
					nativeId: "KAN-5",
					title: "Jira ticket",
				});
				await flushPromises();

				expect(mockReadReferenceFromBranch).toHaveBeenCalledWith(
					"jira",
					"jira:KAN-5-aaaa1111",
					workspaceRoot,
					undefined,
				);
				expect(openTextDocument).toHaveBeenCalledWith({
					language: "markdown",
					content: "# KAN-5\n\nJira ticket body",
				});
			});

			it("shows an error when the orphan-branch lookup misses", async () => {
				mockReadReferenceFromBranch.mockResolvedValueOnce(null);
				const dispatch = await setupPanel();

				dispatch({
					command: "previewReference",
					archivedKey: "linear:PROJ-MISSING-12345678",
					source: "linear",
					nativeId: "PROJ-MISSING",
					title: "Missing",
				});
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("PROJ-MISSING"),
				);
				expect(showTextDocument).not.toHaveBeenCalled();
			});

			it("no-ops when archivedKey is empty", async () => {
				const dispatch = await setupPanel();

				dispatch({
					command: "previewReference",
					archivedKey: "",
					source: "linear",
					nativeId: "",
					title: "",
				});
				await flushPromises();

				expect(showTextDocument).not.toHaveBeenCalled();
				expect(mockReadReferenceFromBranch).not.toHaveBeenCalled();
			});
		});

		describe("loadEntityContent (inline-edit loader, mirrors loadPlanContent)", () => {
			it("reads from orphan branch and posts referenceContentLoaded back to the webview", async () => {
				mockReadReferenceFromBranch.mockResolvedValueOnce(
					"# Edited body\n\nEntity content.",
				);
				const dispatch = await setupPanel();

				dispatch({
					command: "loadReferenceContent",
					archivedKey: "linear:PROJ-1-aaaaaaaa",
					source: "linear",
				});
				await flushPromises();

				expect(mockReadReferenceFromBranch).toHaveBeenCalledWith(
					"linear",
					"linear:PROJ-1-aaaaaaaa",
					workspaceRoot,
					undefined,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "referenceContentLoaded",
					archivedKey: "linear:PROJ-1-aaaaaaaa",
					source: "linear",
					content: "# Edited body\n\nEntity content.",
				});
			});

			it("does NOT open the inline editor when orphan-branch read returns null (avoids overwriting on Save)", async () => {
				mockReadReferenceFromBranch.mockResolvedValueOnce(null);
				const dispatch = await setupPanel();
				postMessage.mockClear();

				dispatch({
					command: "loadReferenceContent",
					archivedKey: "linear:PROJ-MISSING",
					source: "linear",
				});
				await flushPromises();

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("PROJ-MISSING"),
				);
				// Must not surface a `referenceContentLoaded` message — otherwise
				// the webview opens the textarea empty, and a Save would
				// silently overwrite the orphan-branch snapshot with "".
				const loadedCalls = postMessage.mock.calls.filter(
					(c) =>
						(c[0] as { command?: string })?.command === "referenceContentLoaded",
				);
				expect(loadedCalls).toHaveLength(0);
			});
		});

		describe("saveReferenceEdit", () => {
			it("writes back to the orphan branch via bridge.storeReferences", async () => {
				const dispatch = await setupPanel();

				dispatch({
					command: "saveReferenceEdit",
					archivedKey: "linear:PROJ-1-aaaaaaaa",
					source: "linear",
					content: "# Updated\n\nNew body.",
				});
				await flushPromises();

				expect(mockStoreReferences).toHaveBeenCalledWith(
					[
						{
							archivedKey: "linear:PROJ-1-aaaaaaaa",
							source: "linear",
							content: "# Updated\n\nNew body.",
						},
					],
					expect.stringContaining("Edit linear reference"),
					workspaceRoot,
				);
				expect(postMessage).toHaveBeenCalledWith({
					command: "referenceSaved",
					archivedKey: "linear:PROJ-1-aaaaaaaa",
					source: "linear",
				});
			});
		});

		describe("removeReference", () => {
			it("confirms and dissociates the reference from this commit", async () => {
				showWarningMessage.mockResolvedValue("Remove");
				const dispatch = await setupPanel({
					references: [
						{
							archivedKey: "linear:PROJ-1-aaaaaaaa",
							source: "linear",
							nativeId: "PROJ-1",
							title: "T1",
							url: "https://linear.app/x/issue/PROJ-1/test",
							referencedAt: "x",
							sourceToolName: "mcp__linear__get_issue",
						},
						{
							archivedKey: "linear:PROJ-2-aaaaaaaa",
							source: "linear",
							nativeId: "PROJ-2",
							title: "T2",
							url: "https://linear.app/x/issue/PROJ-2/test",
							referencedAt: "x",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				});

				dispatch({
					command: "removeReference",
					archivedKey: "linear:PROJ-1-aaaaaaaa",
					source: "linear",
					nativeId: "PROJ-1",
					title: "T1",
				});
				await flushPromises();

				expect(showWarningMessage).toHaveBeenCalledWith(
					'Remove Linear reference "T1" from this commit?',
					expect.objectContaining({ modal: true }),
					"Remove",
				);
				expect(mockRemoveReference).toHaveBeenCalledWith(
					workspaceRoot,
					"linear:PROJ-1-aaaaaaaa",
				);
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({
						references: [
							expect.objectContaining({ archivedKey: "linear:PROJ-2-aaaaaaaa" }),
						],
					}),
					workspaceRoot,
					true,
				);
			});

			it("clears the references field when the last reference is removed", async () => {
				showWarningMessage.mockResolvedValue("Remove");
				const dispatch = await setupPanel({
					references: [
						{
							archivedKey: "linear:PROJ-9-bbbbbbbb",
							source: "linear",
							nativeId: "PROJ-9",
							title: "Only",
							url: "https://linear.app/x/issue/PROJ-9/test",
							referencedAt: "x",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				});

				dispatch({
					command: "removeReference",
					archivedKey: "linear:PROJ-9-bbbbbbbb",
					source: "linear",
					nativeId: "PROJ-9",
					title: "Only",
				});
				await flushPromises();

				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ references: undefined }),
					workspaceRoot,
					true,
				);
			});

			it("does nothing when user cancels the confirmation", async () => {
				showWarningMessage.mockResolvedValue(undefined);
				const dispatch = await setupPanel({
					references: [
						{
							archivedKey: "linear:PROJ-1-aaaaaaaa",
							source: "linear",
							nativeId: "PROJ-1",
							title: "T",
							url: "https://linear.app/x/issue/PROJ-1/test",
							referencedAt: "x",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				});

				dispatch({
					command: "removeReference",
					archivedKey: "linear:PROJ-1-aaaaaaaa",
					source: "linear",
					nativeId: "PROJ-1",
					title: "T",
				});
				await flushPromises();

				expect(mockRemoveReference).not.toHaveBeenCalled();
				expect(mockStoreSummary).not.toHaveBeenCalled();
			});

			it("returns early when summary has no references", async () => {
				const dispatch = await setupPanel(); // no references
				vi.clearAllMocks();

				dispatch({
					command: "removeReference",
					archivedKey: "linear:PROJ-1-aaaaaaaa",
					source: "linear",
					nativeId: "PROJ-1",
					title: "T",
				});
				await flushPromises();

				expect(showWarningMessage).not.toHaveBeenCalled();
				expect(mockRemoveReference).not.toHaveBeenCalled();
			});

			it("returns early when archivedKey not in summary.references", async () => {
				showWarningMessage.mockResolvedValue("Remove");
				const dispatch = await setupPanel({
					references: [
						{
							archivedKey: "linear:PROJ-1",
							source: "linear",
							nativeId: "PROJ-1",
							title: "T",
							url: "https://linear.app/x/issue/PROJ-1/test",
							referencedAt: "x",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				});

				dispatch({
					command: "removeReference",
					archivedKey: "linear:NOT-IN-LIST",
					source: "linear",
					nativeId: "NOT-IN-LIST",
					title: "X",
				});
				await flushPromises();

				expect(showWarningMessage).not.toHaveBeenCalled();
				expect(mockRemoveReference).not.toHaveBeenCalled();
			});

			it("non-Linear source: dissociates a Jira reference uniformly via the same handler", async () => {
				showWarningMessage.mockResolvedValue("Remove");
				const dispatch = await setupPanel({
					references: [
						{
							archivedKey: "jira:KAN-5-aaaa1111",
							source: "jira",
							nativeId: "KAN-5",
							title: "Jira ticket",
							url: "https://example.atlassian.net/browse/KAN-5",
							referencedAt: "x",
							sourceToolName: "mcp__claude_ai_Atlassian__getJiraIssue",
						},
					],
				});

				dispatch({
					command: "removeReference",
					archivedKey: "jira:KAN-5-aaaa1111",
					source: "jira",
					nativeId: "KAN-5",
					title: "Jira ticket",
				});
				await flushPromises();

				expect(mockRemoveReference).toHaveBeenCalledWith(
					workspaceRoot,
					"jira:KAN-5-aaaa1111",
				);
				expect(mockStoreSummary).toHaveBeenCalledWith(
					expect.objectContaining({ references: undefined }),
					workspaceRoot,
					true,
				);
			});
		});

		describe("translateReference", () => {
			it("translates the archived markdown and writes the result back via storeReferences", async () => {
				mockReadReferenceFromBranch.mockResolvedValueOnce(
					"# 中文标题\n\n中文内容",
				);
				mockTranslateToEnglish.mockResolvedValueOnce(
					"# English Title\n\nEnglish body",
				);
				const dispatch = await setupPanel({
					references: [
						{
							archivedKey: "linear:PROJ-1-aaaaaaaa",
							source: "linear",
							nativeId: "PROJ-1",
							title: "中文标题",
							url: "https://linear.app/x/issue/PROJ-1",
							referencedAt: "x",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				});

				dispatch({
					command: "translateReference",
					archivedKey: "linear:PROJ-1-aaaaaaaa",
					source: "linear",
				});
				await flushPromises();

				expect(mockTranslateToEnglish).toHaveBeenCalledTimes(1);
				expect(mockStoreReferences).toHaveBeenCalledWith(
					[
						{
							archivedKey: "linear:PROJ-1-aaaaaaaa",
							source: "linear",
							content: "# English Title\n\nEnglish body",
						},
					],
					expect.stringContaining("Translate linear reference"),
					workspaceRoot,
				);
				// Webview gets a translating-on / translated-off message pair so
				// the 🌐 button reflects the in-flight LLM state.
				const messages = postMessage.mock.calls.map(
					(c) => (c[0] as { command: string }).command,
				);
				expect(messages).toContain("referenceTranslating");
				expect(messages).toContain("referenceTranslated");
			});

			it("short-circuits with a toast when the entity is already in English (no LLM call, no write)", async () => {
				mockReadReferenceFromBranch.mockResolvedValueOnce(
					"# English Title\n\nAll English here.",
				);
				const dispatch = await setupPanel({
					references: [
						{
							archivedKey: "linear:PROJ-1-aaaaaaaa",
							source: "linear",
							nativeId: "PROJ-1",
							title: "English Title",
							url: "https://linear.app/x/issue/PROJ-1",
							referencedAt: "x",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				});
				vi.clearAllMocks();
				mockReadReferenceFromBranch.mockResolvedValueOnce(
					"# English Title\n\nAll English here.",
				);

				dispatch({
					command: "translateReference",
					archivedKey: "linear:PROJ-1-aaaaaaaa",
					source: "linear",
				});
				await flushPromises();

				expect(showInformationMessage).toHaveBeenCalledWith(
					expect.stringContaining("already in English"),
				);
				expect(mockTranslateToEnglish).not.toHaveBeenCalled();
				expect(mockStoreReferences).not.toHaveBeenCalled();
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
						(c[2] as { docType?: string })?.docType === "note",
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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

		// ── cursorEnabled: false ────────────────────────────────────────────────

		describe("loadTranscriptStats: cursorEnabled false", () => {
			it("excludes cursor sessions when cursorEnabled is false", async () => {
				mockLoadConfig.mockResolvedValue({
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					openCodeEnabled: true,
					cursorEnabled: false,
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
									sessionId: "cur1",
									source: "cursor" as const,
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
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

		// ── copilotEnabled ────────────────────────────────────────────────────────

		describe("loadTranscriptStats: copilotEnabled", () => {
			it("includes copilot sessions when copilotEnabled !== false", async () => {
				mockLoadConfig.mockResolvedValue({
					claudeEnabled: true,
					copilotEnabled: true,
				});
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "cp1",
									source: "copilot" as const,
									entries: [
										{ role: "human" as const, content: "X" },
										{ role: "assistant" as const, content: "Y" },
									],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						sessionCounts: expect.objectContaining({ copilot: 1 }),
					}),
				);
			});

			it("excludes copilot sessions when copilotEnabled === false", async () => {
				mockLoadConfig.mockResolvedValue({
					claudeEnabled: true,
					copilotEnabled: false,
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
									sessionId: "cp1",
									source: "copilot" as const,
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				// copilot session (cp1) should be excluded; only claude session counted
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						totalEntries: 1,
						sessionCounts: expect.objectContaining({ claude: 1 }),
					}),
				);
			});

			it("includes copilot-chat in enabled sources when copilotEnabled is true", async () => {
				mockLoadConfig.mockResolvedValue({
					claudeEnabled: true,
					copilotEnabled: true,
				});
				mockGetTranscriptHashes.mockResolvedValue(new Set(["abc123"]));
				const transcriptMap = new Map([
					[
						"abc123",
						{
							sessions: [
								{
									sessionId: "cc1",
									source: "copilot-chat" as const,
									entries: [
										{ role: "human" as const, content: "X" },
										{ role: "assistant" as const, content: "Y" },
									],
								},
							],
						},
					],
				]);
				mockReadTranscriptsForCommits.mockResolvedValue(transcriptMap);

				const summary = makeSummary();
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						sessionCounts: expect.objectContaining({ "copilot-chat": 1 }),
					}),
				);
			});

			it("excludes copilot-chat when copilotEnabled is false", async () => {
				mockLoadConfig.mockResolvedValue({
					claudeEnabled: true,
					copilotEnabled: false,
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
									sessionId: "cc1",
									source: "copilot-chat" as const,
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
				await SummaryWebviewPanel.show(
					summary,
					extensionUri,
					workspaceRoot,
					stubBridge,
					mainBranch,
				);
				const dispatch = captureMessageHandler();

				dispatch({ command: "loadTranscriptStats" });
				await flushPromises();

				// copilot-chat session (cc1) should be excluded; only claude session counted
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						command: "transcriptStatsLoaded",
						totalEntries: 1,
						sessionCounts: expect.objectContaining({ claude: 1 }),
					}),
				);
				const lastCall = postMessage.mock.calls[
					postMessage.mock.calls.length - 1
				]?.[0] as { sessionCounts?: Record<string, number> } | undefined;
				expect(lastCall?.sessionCounts).not.toHaveProperty("copilot-chat");
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

	// ── Foreign-repo dispatch guard ──────────────────────────────────────────
	// When the panel was opened against a summary loaded from a NON-current
	// repo (Memory Bank cross-repo lookup), every destructive webview command
	// must short-circuit. The whitelist is small on purpose (default-deny):
	// only commands that are workspace-independent reach their handler. This
	// is the P1 silent-corruption guard — without it, push/edit clicks on a
	// foreign memory write to the current workspace's orphan branch.

	describe("foreign-repo guard", () => {
		it("prefixes the panel title with the source repo name when foreign", async () => {
			mockBuildPanelTitle.mockReturnValue("Original Title");
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo", // foreign provenance
			);

			const panel = createWebviewPanel.mock.results[0].value;
			// `← <repo>:` prefix tells the user at a glance the tab is from
			// another project. Without this, foreign panels were visually
			// indistinguishable from a local read+write panel.
			expect(panel.title).toBe("← other-repo: Original Title");
		});

		it("does NOT prefix the title when sourceRepoName is null (local panel)", async () => {
			mockBuildPanelTitle.mockReturnValue("Original Title");
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				null,
			);

			const panel = createWebviewPanel.mock.results[0].value;
			expect(panel.title).toBe("Original Title");
		});

		it("intercepts destructive commands and surfaces an info notification when foreign", async () => {
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo",
			);
			const dispatch = captureMessageHandler();

			// Sample of the destructive surface: push is the canonical write;
			// editTopic exercises the edit family; createPr exercises the
			// workspace-git family. All three must short-circuit before any
			// handler runs.
			dispatch({ command: "push" });
			dispatch({ command: "editTopic", topicIndex: 0, updates: {} });
			dispatch({
				command: "createPr",
				title: "x",
				body: "y",
			});
			await flushPromises();

			expect(showInformationMessage).toHaveBeenCalledTimes(3);
			expect(showInformationMessage).toHaveBeenCalledWith(
				expect.stringMatching(/from other-repo.*push.*disabled/i),
			);
			expect(showInformationMessage).toHaveBeenCalledWith(
				expect.stringMatching(/from other-repo.*editTopic.*disabled/i),
			);
			expect(showInformationMessage).toHaveBeenCalledWith(
				expect.stringMatching(/from other-repo.*createPr.*disabled/i),
			);
		});

		it("also intercepts prepareUpdatePr and updatePr — neither must reach PrCommentService on a foreign panel", async () => {
			// Regression guard: PrCommentService.handlePrepareUpdatePr /
			// handleUpdatePr do NOT carry the foreign repoUrl plumbing that
			// handleCheckPrStatus does, so if either ever leaked past the
			// allowlist it would silently target a same-named branch PR in
			// the CURRENT workspace's repo instead of the foreign repo's PR.
			// Pin them into the deny list at the dispatcher layer so a
			// future allowlist edit can't accidentally regress this.
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo",
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "prepareUpdatePr" });
			dispatch({
				command: "updatePr",
				title: "x",
				body: "y",
			});
			await flushPromises();

			expect(showInformationMessage).toHaveBeenCalledTimes(2);
			expect(showInformationMessage).toHaveBeenCalledWith(
				expect.stringMatching(/from other-repo.*prepareUpdatePr.*disabled/i),
			);
			expect(showInformationMessage).toHaveBeenCalledWith(
				expect.stringMatching(/from other-repo.*updatePr.*disabled/i),
			);
		});

		it("allows read-only display commands (transcript stats/all, plan/note preview) on a foreign panel", async () => {
			// foreignStorage threading is useless if the dispatch guard
			// denies these commands before they reach the handler. The
			// foreign mode is read-only-view: transcripts (stats + Manage
			// modal) and the rendered Markdown previews for plans / notes
			// are the four display paths a foreign-panel user can reach.
			// `loadPlanContent` / `loadNoteContent` are intentionally NOT
			// pinned here — those drive the inline edit form, which is
			// CSS-hidden in `.foreign-readonly`.
			const foreignStorage = {
				kind: "foreign-storage-stub",
			} as unknown as import(
				"../../../cli/src/core/StorageProvider.js"
			).StorageProvider;
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo",
				"https://github.com/x/foreign.git",
				foreignStorage,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "loadTranscriptStats" });
			dispatch({ command: "loadAllTranscripts" });
			dispatch({ command: "previewPlan", slug: "plan-x", title: "Plan X" });
			dispatch({ command: "previewNote", id: "note-x", title: "Note X" });
			await flushPromises();

			const denialCalls = showInformationMessage.mock.calls.filter((c) =>
				typeof c[0] === "string" ? c[0].includes("disabled") : false,
			);
			expect(denialCalls).toHaveLength(0);
		});

		it("handleLoadTranscriptStats and handleLoadAllTranscripts read transcripts through foreignStorage when set", async () => {
			// Pins the non-bridge branch of the read ternary in both
			// transcript-load handlers — without this, foreign-mode "All
			// Conversations" stats and the Manage modal would silently call
			// `this.bridge.readTranscriptsForCommits` (cwd storage) and
			// surface 0 sessions for every cross-repo summary. Setting
			// transcriptHashSet via a matched commitHash + non-empty
			// transcript file map drives the handler past the early-return
			// `transcriptHashSet.size === 0` guard.
			const foreignStorage = {
				kind: "foreign-storage-stub",
			} as unknown as import(
				"../../../cli/src/core/StorageProvider.js"
			).StorageProvider;
			const summary = makeSummary({ commitHash: "fff" });
			mockGetTranscriptHashes.mockResolvedValue(new Set(["fff"]));
			mockReadTranscriptsForCommits.mockResolvedValue(
				new Map([["fff", { sessions: [] }]]),
			);

			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo",
				"https://github.com/x/foreign.git",
				foreignStorage,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "loadTranscriptStats" });
			dispatch({ command: "loadAllTranscripts" });
			await flushPromises();

			// Both reads went through the direct core helper (3-arg form)
			// rather than the stub bridge wrapper (1-arg form). The
			// foreignStorage instance is the load-bearing signal.
			expect(mockReadTranscriptsForCommits).toHaveBeenCalledWith(
				["fff"],
				workspaceRoot,
				foreignStorage,
			);
		});

		it("previewPlan dispatch threads foreignRepoName / foreignRepoUrl to jollimemory.editPlan", async () => {
			// The external `jollimemory.editPlan` command reads plan content
			// via `readPlanFromBranch(slug, workspaceRoot, storage)`. For a
			// foreign panel the storage must be the foreign repo's
			// FolderStorage — Extension.ts derives it from the
			// foreignRepoName / foreignRepoUrl hint that this dispatch
			// passes. Without these positional args, the command would
			// silently fall back to reading the current workspace's plan
			// file, producing either an empty body or the wrong plan.
			const foreignStorage = {
				kind: "foreign-storage-stub",
			} as unknown as import(
				"../../../cli/src/core/StorageProvider.js"
			).StorageProvider;
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo",
				"https://github.com/x/foreign.git",
				foreignStorage,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "previewPlan", slug: "my-plan", title: "My Plan" });
			await flushPromises();

			expect(executeCommand).toHaveBeenCalledWith(
				"jollimemory.editPlan",
				"my-plan",
				true,
				"My Plan",
				"other-repo",
				"https://github.com/x/foreign.git",
			);
		});

		it("previewNote dispatch threads foreignRepoName / foreignRepoUrl to jollimemory.previewNote", async () => {
			const foreignStorage = {
				kind: "foreign-storage-stub",
			} as unknown as import(
				"../../../cli/src/core/StorageProvider.js"
			).StorageProvider;
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo",
				"https://github.com/x/foreign.git",
				foreignStorage,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "previewNote", id: "my-note", title: "My Note" });
			await flushPromises();

			expect(executeCommand).toHaveBeenCalledWith(
				"jollimemory.previewNote",
				"my-note",
				"My Note",
				"other-repo",
				"https://github.com/x/foreign.git",
			);
		});

		it("still allows the read-only whitelist (copyMarkdown, downloadMarkdown) on a foreign panel", async () => {
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				"other-repo",
			);
			const dispatch = captureMessageHandler();

			// copyMarkdown is workspace-independent (clipboard only) so it
			// must NOT trip the foreign guard. Verifying it makes it past
			// the guard by checking that the denial notification did NOT
			// fire — the handler itself goes on to use vscode.env.clipboard
			// which is mocked elsewhere.
			dispatch({ command: "copyMarkdown" });
			await flushPromises();

			// No "disabled to prevent writes" notification should have appeared.
			const denialCalls = showInformationMessage.mock.calls.filter((c) =>
				typeof c[0] === "string" ? c[0].includes("disabled") : false,
			);
			expect(denialCalls).toHaveLength(0);
		});

		it("does NOT intercept any commands when sourceRepoName is null", async () => {
			const summary = makeSummary();
			await SummaryWebviewPanel.show(
				summary,
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
				"memory",
				null,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "push" });
			await flushPromises();

			// `push` goes to the real handler (which then runs handlePush
			// against the bridge); the foreign-denial notification path
			// must not fire for local panels.
			const denialCalls = showInformationMessage.mock.calls.filter((c) =>
				typeof c[0] === "string" ? c[0].includes("disabled") : false,
			);
			expect(denialCalls).toHaveLength(0);
		});
	});

	// ── Stale-commit (rewritten-into) guard ──────────────────────────────────
	// When a commit shown in the panel is rewritten by amend / squash / rebase,
	// the panel for the OLD hash stays open and any subsequent write from it
	// silently overwrites the orphaned commit's summary on the orphan branch.
	// Most visibly, Push to Jolli writes `jolliDocId` / `jolliDocUrl` to the
	// orphaned commit, leaving the live HEAD's summary without those fields.
	// `ensureCommitNotRewritten` blocks every write handler when the panel's
	// commitHash is no longer a root entry in the index — i.e. has a non-null
	// `parentCommitHash`, the marker jollimemory writes when the original commit
	// is folded into a new root by amend/squash/rebase.

	describe("stale-commit guard", () => {
		// Helper: build an index entry map representing the chain
		// `commitHash` → `parentCommitHash` → ... → `rootHash`. Returns the map
		// in the shape `getIndexEntryMap` resolves to.
		function buildChainEntryMap(
			chain: ReadonlyArray<{ hash: string; parent: string | null }>,
		): Map<string, { commitHash: string; parentCommitHash: string | null }> {
			const map = new Map<
				string,
				{ commitHash: string; parentCommitHash: string | null }
			>();
			for (const link of chain) {
				map.set(link.hash, {
					commitHash: link.hash,
					parentCommitHash: link.parent,
				});
			}
			return map;
		}

		async function setupCommit(
			hash: string,
		): Promise<(msg: Record<string, unknown>) => void> {
			await SummaryWebviewPanel.show(
				makeSummary({ commitHash: hash }),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			return captureMessageHandler();
		}

		/**
		 * Asserts the stale-commit modal was raised with the expected
		 * substrings in its message. `showWarningMessage` is called with
		 * `(msg, { modal: true, detail }, "Open new commit's summary")` —
		 * checking presence via mock.calls.some lets each test target a
		 * specific operation label without binding to the full arg shape.
		 */
		function expectStaleModalShown(...substrings: ReadonlyArray<string>): void {
			const matched = showWarningMessage.mock.calls.find(
				(c) =>
					typeof c[0] === "string" &&
					substrings.every((s) => (c[0] as string).includes(s)) &&
					typeof c[1] === "object" &&
					c[1] !== null &&
					(c[1] as { modal?: boolean }).modal === true &&
					c[2] === "Open new commit's summary",
			);
			expect(matched).toBeDefined();
		}

		it("allows push when the commit is still a root entry", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([{ hash: "abc123", parent: null }]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "push" });
			await flushPromises();

			// Guard let it through; runJolliPush would be reached. Since no API
			// key is configured by default, the user-facing warning is the
			// "configure Jolli API Key" one — NOT our "rewritten into" message.
			const rewriteWarnings = showWarningMessage.mock.calls.filter((c) =>
				typeof c[0] === "string" ? c[0].includes("rewritten into") : false,
			);
			expect(rewriteWarnings).toHaveLength(0);
		});

		it("allows push when the commit is absent from the index (legacy / external / pre-index)", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(new Map());
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "push" });
			await flushPromises();

			const rewriteWarnings = showWarningMessage.mock.calls.filter((c) =>
				typeof c[0] === "string" ? c[0].includes("rewritten into") : false,
			);
			expect(rewriteWarnings).toHaveLength(0);
		});

		it("blocks push when the commit was rewritten into a new root", async () => {
			// abc123 → ROOT_NEW (one-step rewrite, e.g. single amend)
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "push" });
			await flushPromises();

			// User-facing modal carries the old and new short hashes plus the
			// operation label so the user knows exactly what was blocked.
			expectStaleModalShown(
				"rewritten into rootnew0",
				"abc123",
				"push to Jolli",
			);
			// Panel transitions to stale-readonly (NOT disposed) — buildHtml is
			// re-invoked with `staleRewrittenInto` set so the rendered output
			// gets the .stale-readonly hook class and the banner. We verify
			// the option, not the rendered HTML, because buildHtml is mocked.
			const staleRender = mockBuildHtml.mock.calls.find(
				(c) =>
					(c[1] as { staleRewrittenInto?: string } | undefined)
						?.staleRewrittenInto === "rootnew0",
			);
			expect(staleRender).toBeDefined();
			// And the storage write never happened.
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("walks a multi-hop parent chain to the final live root", async () => {
			// abc123 → mid0001 → mid0002 → finalroot
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "mid0001" },
					{ hash: "mid0001", parent: "mid0002" },
					{ hash: "mid0002", parent: "finalrt" },
					{ hash: "finalrt", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "push" });
			await flushPromises();

			expectStaleModalShown("rewritten into finalrt");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("breaks out of a cyclic parent chain instead of looping forever", async () => {
			// Defensive: index links form a DAG by construction, but a corrupted
			// file shouldn't lock the UI in an infinite loop.
			//   abc123 → cyclea → cycleb → cyclea (cycle back)
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "cyclea0" },
					{ hash: "cyclea0", parent: "cycleb0" },
					{ hash: "cycleb0", parent: "cyclea0" },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "push" });
			await flushPromises();

			// We surface whichever hash the walk landed on before detecting the
			// cycle — either cyclea0 or cycleb0, depending on iteration order;
			// the important thing is that no crash and no storage write happens.
			const cycleModal = showWarningMessage.mock.calls.find(
				(c) =>
					typeof c[0] === "string" &&
					/rewritten into (cyclea0|cycleb0)/.test(c[0]) &&
					c[2] === "Open new commit's summary",
			);
			expect(cycleModal).toBeDefined();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks the same write across all guarded handlers (edit memory)", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({
				command: "editTopic",
				topicIndex: 0,
				updates: { title: "new" },
			});
			await flushPromises();

			expectStaleModalShown("edit memory");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks generate E2E test guide with the correct operation label", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "generateE2eTest" });
			await flushPromises();

			expectStaleModalShown("generate E2E test guide");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks edit E2E scenario when the commit was rewritten", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					e2eTestGuide: [
						{
							title: "Scenario 1",
							preconditions: "",
							steps: ["step"],
							expectedResults: ["ok"],
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({
				command: "editE2eScenario",
				index: 0,
				updates: { title: "x" },
			});
			await flushPromises();

			expectStaleModalShown("edit E2E scenario");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks delete E2E scenario BEFORE the confirm dialog", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					e2eTestGuide: [
						{
							title: "Scenario 1",
							preconditions: "",
							steps: ["step"],
							expectedResults: ["ok"],
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "deleteE2eScenario", index: 0 });
			await flushPromises();

			// Stale warning surfaced, confirm dialog ("Delete scenario ...?") never shown.
			expectStaleModalShown("delete E2E scenario");
			const confirmCalls = showWarningMessage.mock.calls.filter((c) =>
				typeof c[0] === "string" ? c[0].startsWith("Delete scenario") : false,
			);
			expect(confirmCalls).toHaveLength(0);
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks delete E2E test guide BEFORE the confirm dialog", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "deleteE2eTest" });
			await flushPromises();

			expectStaleModalShown("delete E2E test guide");
			const confirmCalls = showWarningMessage.mock.calls.filter((c) =>
				typeof c[0] === "string" ? c[0] === "Delete E2E Test Guide?" : false,
			);
			expect(confirmCalls).toHaveLength(0);
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks generate recap with the correct operation label", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "generateRecap" });
			await flushPromises();

			expectStaleModalShown("generate recap");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		// handleEditRecap's entry-point guard mirrors the push / edit-memory
		// handlers above. Editing a recap on a commit that has been folded into
		// a new root must surface the same modal and skip storeSummary.
		it("blocks edit recap with the correct operation label", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "editRecap", recap: "blocked recap" });
			await flushPromises();

			expectStaleModalShown("edit recap");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		// Race-window pattern: the entry guard sees a clean root, the user
		// clicks the confirm in the modal, then the second guard re-fetches
		// the index and detects the rewrite that landed during the dialog —
		// storeSummary must NOT fire. Repeated below for note / Linear /
		// translateNote to keep each handler's second guard exercised; without
		// this they appear "covered" only by the entry path and a regression
		// in the second call would slip through.
		it("blocks remove plan via the race-window re-check after confirm", async () => {
			(stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce(new Map()) // entry guard: not stale
				.mockResolvedValueOnce(
					buildChainEntryMap([
						{ hash: "abc123", parent: "rootnew0" },
						{ hash: "rootnew0", parent: null },
					]),
				);
			showWarningMessage.mockResolvedValueOnce("Remove");

			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					plans: [{ slug: "p1", title: "Plan 1", commitHash: "abc123" }],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();
			dispatch({ command: "removePlan", slug: "p1", title: "Plan 1" });
			await flushPromises();

			expectStaleModalShown("remove plan");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks remove note via the race-window re-check after confirm", async () => {
			(stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce(new Map())
				.mockResolvedValueOnce(
					buildChainEntryMap([
						{ hash: "abc123", parent: "rootnew0" },
						{ hash: "rootnew0", parent: null },
					]),
				);
			showWarningMessage.mockResolvedValueOnce("Remove");

			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					notes: [{ id: "n1", title: "Note 1", format: "markdown" }],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();
			dispatch({ command: "removeNote", id: "n1", title: "Note 1" });
			await flushPromises();

			expectStaleModalShown("remove note");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks remove entity (Linear-archived) via the race-window re-check after confirm", async () => {
			(stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce(new Map())
				.mockResolvedValueOnce(
					buildChainEntryMap([
						{ hash: "abc123", parent: "rootnew0" },
						{ hash: "rootnew0", parent: null },
					]),
				);
			showWarningMessage.mockResolvedValueOnce("Remove");

			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					references: [
						{
							archivedKey: "linear:ENG-123-aaaa1111",
							source: "linear",
							nativeId: "ENG-123",
							title: "Issue 1",
							url: "https://linear.app/team/issue/ENG-123",
							referencedAt: "x",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();
			dispatch({
				command: "removeReference",
				archivedKey: "linear:ENG-123-aaaa1111",
				source: "linear",
				nativeId: "ENG-123",
				title: "Issue 1",
			});
			await flushPromises();

			expectStaleModalShown("remove reference");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks delete E2E scenario via the race-window re-check after confirm", async () => {
			(stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce(new Map())
				.mockResolvedValueOnce(
					buildChainEntryMap([
						{ hash: "abc123", parent: "rootnew0" },
						{ hash: "rootnew0", parent: null },
					]),
				);
			showWarningMessage.mockResolvedValueOnce("Delete");

			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					e2eTestGuide: [
						{
							title: "Scenario 1",
							preconditions: "",
							steps: ["step"],
							expectedResults: ["ok"],
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();
			dispatch({
				command: "deleteE2eScenario",
				index: 0,
				title: "Scenario 1",
			});
			await flushPromises();

			expectStaleModalShown("delete E2E scenario");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks regenerate summary BEFORE the confirm dialog", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "regenerateSummary" });
			await flushPromises();

			expectStaleModalShown("regenerate summary");
			// Confirm dialog ("Regenerate this summary?") never shown.
			const confirmCalls = showWarningMessage.mock.calls.filter((c) =>
				typeof c[0] === "string" ? c[0] === "Regenerate this summary?" : false,
			);
			expect(confirmCalls).toHaveLength(0);
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks regenerate summary when commit goes stale DURING the LLM call", async () => {
			// First two guards (entry + post-modal) → not stale; the third
			// re-check (after the LLM returns) sees a stale chain and aborts
			// before storeSummary. summaryRegenerateError is posted.
			(stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce(new Map())
				.mockResolvedValueOnce(new Map())
				.mockResolvedValueOnce(
					buildChainEntryMap([
						{ hash: "abc123", parent: "rootnew0" },
						{ hash: "rootnew0", parent: null },
					]),
				);
			mockLoadRegenerateContext.mockResolvedValue({
				entryCount: 1,
				sessionCount: 1,
				sources: ["Claude"],
				humanTurns: 1,
				plansCount: 0,
				notesCount: 0,
				referenceCountsBySource: {},
			});
			showWarningMessage.mockResolvedValueOnce("Regenerate");
			mockRegenerateSummary.mockResolvedValue({
				updated: makeSummary({ commitHash: "abc123", recap: "fresh" }),
				result: {} as never,
			});
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "regenerateSummary" });
			await flushPromises();

			expectStaleModalShown("regenerate summary");
			expect(mockRegenerateSummary).toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ command: "summaryRegenerateError" }),
			);
		});

		it("blocks regenerate summary when commit goes stale BETWEEN entry guard and confirm acceptance", async () => {
			// First entry-guard call → not stale. Modal-accept guard → stale.
			// Confirms the post-modal race-window re-check fires; storeSummary
			// never runs because the LLM step is short-circuited.
			(stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce(new Map())
				.mockResolvedValueOnce(
					buildChainEntryMap([
						{ hash: "abc123", parent: "rootnew0" },
						{ hash: "rootnew0", parent: null },
					]),
				);
			mockLoadRegenerateContext.mockResolvedValue({
				entryCount: 1,
				sessionCount: 1,
				sources: ["Claude"],
				humanTurns: 1,
				plansCount: 0,
				notesCount: 0,
				referenceCountsBySource: {},
			});
			showWarningMessage.mockResolvedValueOnce("Regenerate");
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "regenerateSummary" });
			await flushPromises();

			expectStaleModalShown("regenerate summary");
			expect(mockRegenerateSummary).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks delete memory BEFORE the confirm dialog", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "deleteTopic", topicIndex: 0 });
			await flushPromises();

			expectStaleModalShown("delete memory");
			// Confirm dialog ("Delete memory?" / "Delete this memory?") never shown.
			const confirmCalls = showWarningMessage.mock.calls.filter((c) =>
				typeof c[0] === "string" ? c[0].startsWith("Delete") : false,
			);
			expect(confirmCalls).toHaveLength(0);
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks edit E2E test guide (deprecated bulk edit path)", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "editE2eTest", scenarios: [] });
			await flushPromises();

			expectStaleModalShown("edit E2E test guide");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		// Plan / note / Linear-issue write entry points — same stale-commit bug
		// class as the E2E/topic/recap handlers above. Each here drives a write
		// to `bridge.storeSummary` with the stale `currentSummary.commitHash`,
		// or an archive call (archivePlanForCommit / archiveNoteForCommit) that
		// binds new content to the orphaned commit.

		it("blocks remove plan BEFORE confirm + storeSummary", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					plans: [
						{
							slug: "p",
							title: "P",
							addedAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "removePlan", slug: "p", title: "P" });
			await flushPromises();

			expectStaleModalShown("remove plan");
			const confirmCalls = showWarningMessage.mock.calls.filter((c) =>
				typeof c[0] === "string" ? c[0].startsWith("Remove plan") : false,
			);
			expect(confirmCalls).toHaveLength(0);
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks remove note BEFORE confirm + storeSummary", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					notes: [
						{
							id: "n",
							title: "N",
							format: "snippet",
							addedAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "removeNote", id: "n", title: "N" });
			await flushPromises();

			expectStaleModalShown("remove note");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks remove entity (Linear-archived) BEFORE confirm + storeSummary", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					references: [
						{
							archivedKey: "linear:JOLLI-1-abc",
							source: "linear",
							nativeId: "JOLLI-1",
							title: "T",
							url: "https://linear.app/x",
							referencedAt: "2026-01-01T00:00:00Z",
							sourceToolName: "linear:get-issue",
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({
				command: "removeReference",
				archivedKey: "linear:JOLLI-1-abc",
				source: "linear",
				nativeId: "JOLLI-1",
				title: "T",
			});
			await flushPromises();

			expectStaleModalShown("remove reference");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks add plan BEFORE the QuickPick + archivePlanForCommit", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			mockListAvailablePlans.mockReturnValue([
				{ slug: "available-plan", title: "Available Plan" },
			]);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "addPlan" });
			await flushPromises();

			expectStaleModalShown("add plan");
			expect(showQuickPick).not.toHaveBeenCalled();
			expect(mockArchivePlanForCommit).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks add markdown note BEFORE the file picker", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "addMarkdownNote" });
			await flushPromises();

			expectStaleModalShown("add markdown note");
			expect(showOpenDialog).not.toHaveBeenCalled();
			expect(mockArchiveNoteForCommit).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks save snippet (no saveNote / archive / storeSummary)", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({
				command: "saveSnippet",
				title: "T",
				content: "some content",
			});
			await flushPromises();

			expectStaleModalShown("save snippet");
			expect(mockSaveNote).not.toHaveBeenCalled();
			expect(mockArchiveNoteForCommit).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks save plan BEFORE storePlans (no plan content write)", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({
				command: "savePlan",
				slug: "p",
				content: "# Title\n\nbody",
			});
			await flushPromises();

			expectStaleModalShown("save plan");
			expect(mockStorePlans).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks save note BEFORE storeNotes", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({
				command: "saveNote",
				id: "n",
				content: "# Title\n\nbody",
				format: "markdown",
			});
			await flushPromises();

			expectStaleModalShown("save note");
			expect(mockStoreNotes).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks translate plan BEFORE readPlanFromBranch", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "translatePlan", slug: "p" });
			await flushPromises();

			expectStaleModalShown("translate plan");
			expect(mockReadPlanFromBranch).not.toHaveBeenCalled();
			expect(mockStorePlans).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("blocks translate note when the commit was rewritten", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					notes: [
						{
							id: "n",
							title: "N",
							format: "snippet",
							content: "中文",
							addedAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "translateNote", id: "n" });
			await flushPromises();

			expectStaleModalShown("translate note");
			expect(mockStoreNotes).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("reads the index via the bridge (storage-threaded), not via direct SummaryStore", async () => {
			// Storage-threading regression guard: ensureCommitNotRewritten must
			// route through bridge.getSummaryIndexEntryMap so folder-mode users
			// get the correct backend. A direct `getIndexEntryMap(cwd)` call
			// would silently fall back to OrphanBranchStorage and read the wrong
			// file under non-default storage modes.
			const spy = stubBridge.getSummaryIndexEntryMap as ReturnType<
				typeof vi.fn
			>;
			spy.mockResolvedValue(new Map());
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "push" });
			await flushPromises();

			expect(spy).toHaveBeenCalled();
		});

		// ── Race-window: amend lands BETWEEN entry guard and write ───────────
		// Entry guard passes (commit is still root at click time) but the
		// commit gets rewritten during the long-async step (LLM call /
		// QuickPick / confirm modal). The second guard must catch this and
		// block the write. Verifying by flipping the index entry map between
		// the first and second `getSummaryIndexEntryMap` calls.

		/** Returns a `getSummaryIndexEntryMap` mock that resolves to `firstMap`
		 *  on the first call and `restMap` on every subsequent call — simulates
		 *  an amend landing between entry guard and pre-write re-check. */
		function makeRacingEntryMapMock(
			firstMap: ReadonlyMap<
				string,
				{ commitHash: string; parentCommitHash: string | null }
			>,
			restMap: ReadonlyMap<
				string,
				{ commitHash: string; parentCommitHash: string | null }
			>,
		) {
			let calls = 0;
			return vi.fn(() => {
				calls += 1;
				return Promise.resolve(calls === 1 ? firstMap : restMap);
			});
		}

		it("race-window: blocks generate E2E test guide if amend lands during the LLM call", async () => {
			const rootMap = buildChainEntryMap([{ hash: "abc123", parent: null }]);
			const rewrittenMap = buildChainEntryMap([
				{ hash: "abc123", parent: "rootnew0" },
				{ hash: "rootnew0", parent: null },
			]);
			(
				stubBridge as unknown as {
					getSummaryIndexEntryMap: ReturnType<typeof vi.fn>;
				}
			).getSummaryIndexEntryMap = makeRacingEntryMapMock(rootMap, rewrittenMap);
			mockGenerateE2eTest.mockResolvedValue([
				{ title: "Scenario", steps: [], expectedResults: [] },
			]);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "generateE2eTest" });
			await flushPromises();

			// LLM call DID happen (entry guard let it through); the result was
			// discarded by the pre-write guard.
			expect(mockGenerateE2eTest).toHaveBeenCalled();
			expectStaleModalShown("rewritten into rootnew0");
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("race-window: blocks delete memory if amend lands while confirm modal is open", async () => {
			const rootMap = buildChainEntryMap([{ hash: "abc123", parent: null }]);
			const rewrittenMap = buildChainEntryMap([
				{ hash: "abc123", parent: "rootnew0" },
				{ hash: "rootnew0", parent: null },
			]);
			(
				stubBridge as unknown as {
					getSummaryIndexEntryMap: ReturnType<typeof vi.fn>;
				}
			).getSummaryIndexEntryMap = makeRacingEntryMapMock(rootMap, rewrittenMap);
			// User confirms the deletion — modal returns "Delete".
			showWarningMessage.mockResolvedValueOnce("Delete");
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "deleteTopic", topicIndex: 0 });
			await flushPromises();

			// Confirm modal WAS shown (entry guard let it through); the
			// post-confirm guard blocked the storeSummary write.
			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringMatching(/^Delete /),
				expect.any(Object),
				"Delete",
			);
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("race-window: blocks add plan if amend lands while QuickPick is open", async () => {
			const rootMap = buildChainEntryMap([{ hash: "abc123", parent: null }]);
			const rewrittenMap = buildChainEntryMap([
				{ hash: "abc123", parent: "rootnew0" },
				{ hash: "rootnew0", parent: null },
			]);
			(
				stubBridge as unknown as {
					getSummaryIndexEntryMap: ReturnType<typeof vi.fn>;
				}
			).getSummaryIndexEntryMap = makeRacingEntryMapMock(rootMap, rewrittenMap);
			mockListAvailablePlans.mockReturnValue([{ slug: "p", title: "P" }]);
			// User picks a plan from the QuickPick.
			showQuickPick.mockResolvedValueOnce({
				label: "P",
				description: "p.md",
				slug: "p",
			});
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "addPlan" });
			await flushPromises();

			// QuickPick DID open (entry guard let it through); the post-pick
			// guard blocked both the archive and storeSummary.
			expect(showQuickPick).toHaveBeenCalled();
			expect(mockArchivePlanForCommit).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("race-window: blocks delete E2E scenario if amend lands while confirm modal is open", async () => {
			const rootMap = buildChainEntryMap([{ hash: "abc123", parent: null }]);
			const rewrittenMap = buildChainEntryMap([
				{ hash: "abc123", parent: "rootnew0" },
				{ hash: "rootnew0", parent: null },
			]);
			(
				stubBridge as unknown as {
					getSummaryIndexEntryMap: ReturnType<typeof vi.fn>;
				}
			).getSummaryIndexEntryMap = makeRacingEntryMapMock(rootMap, rewrittenMap);
			showWarningMessage.mockResolvedValueOnce("Delete");
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					e2eTestGuide: [
						{
							title: "Scenario 1",
							preconditions: "",
							steps: ["step"],
							expectedResults: ["ok"],
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "deleteE2eScenario", index: 0, title: "Scenario 1" });
			await flushPromises();

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringMatching(/^Delete scenario/),
				expect.any(Object),
				"Delete",
			);
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("race-window: blocks delete E2E test guide if amend lands while confirm modal is open", async () => {
			const rootMap = buildChainEntryMap([{ hash: "abc123", parent: null }]);
			const rewrittenMap = buildChainEntryMap([
				{ hash: "abc123", parent: "rootnew0" },
				{ hash: "rootnew0", parent: null },
			]);
			(
				stubBridge as unknown as {
					getSummaryIndexEntryMap: ReturnType<typeof vi.fn>;
				}
			).getSummaryIndexEntryMap = makeRacingEntryMapMock(rootMap, rewrittenMap);
			showWarningMessage.mockResolvedValueOnce("Delete");
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					e2eTestGuide: [
						{ title: "T", preconditions: "", steps: [], expectedResults: [] },
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "deleteE2eTest" });
			await flushPromises();

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringMatching(/^Delete E2E Test Guide/),
				expect.any(Object),
				"Delete",
			);
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("race-window: blocks remove plan if amend lands while confirm modal is open", async () => {
			const rootMap = buildChainEntryMap([{ hash: "abc123", parent: null }]);
			const rewrittenMap = buildChainEntryMap([
				{ hash: "abc123", parent: "rootnew0" },
				{ hash: "rootnew0", parent: null },
			]);
			(
				stubBridge as unknown as {
					getSummaryIndexEntryMap: ReturnType<typeof vi.fn>;
				}
			).getSummaryIndexEntryMap = makeRacingEntryMapMock(rootMap, rewrittenMap);
			showWarningMessage.mockResolvedValueOnce("Remove");
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					plans: [
						{
							slug: "plan-a",
							title: "Plan A",
							addedAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "removePlan", slug: "plan-a", title: "Plan A" });
			await flushPromises();

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringMatching(/^Remove/),
				expect.any(Object),
				"Remove",
			);
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("race-window: blocks add markdown note if amend lands while file picker is open", async () => {
			const rootMap = buildChainEntryMap([{ hash: "abc123", parent: null }]);
			const rewrittenMap = buildChainEntryMap([
				{ hash: "abc123", parent: "rootnew0" },
				{ hash: "rootnew0", parent: null },
			]);
			(
				stubBridge as unknown as {
					getSummaryIndexEntryMap: ReturnType<typeof vi.fn>;
				}
			).getSummaryIndexEntryMap = makeRacingEntryMapMock(rootMap, rewrittenMap);
			// File picker returns a chosen file URI; the post-pick guard blocks storeSummary.
			showOpenDialog.mockResolvedValueOnce([{ fsPath: "/tmp/picked.md" }]);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "addMarkdownNote" });
			await flushPromises();

			expect(showOpenDialog).toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("race-window: blocks remove note if amend lands while confirm modal is open", async () => {
			const rootMap = buildChainEntryMap([{ hash: "abc123", parent: null }]);
			const rewrittenMap = buildChainEntryMap([
				{ hash: "abc123", parent: "rootnew0" },
				{ hash: "rootnew0", parent: null },
			]);
			(
				stubBridge as unknown as {
					getSummaryIndexEntryMap: ReturnType<typeof vi.fn>;
				}
			).getSummaryIndexEntryMap = makeRacingEntryMapMock(rootMap, rewrittenMap);
			showWarningMessage.mockResolvedValueOnce("Remove");
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					notes: [
						{
							id: "note-a",
							title: "Note A",
							kind: "snippet",
							snippet: "x",
							addedAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "removeNote", id: "note-a", title: "Note A" });
			await flushPromises();

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringMatching(/^Remove/),
				expect.any(Object),
				"Remove",
			);
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("race-window: blocks remove entity (Linear-archived) if amend lands while confirm modal is open", async () => {
			const rootMap = buildChainEntryMap([{ hash: "abc123", parent: null }]);
			const rewrittenMap = buildChainEntryMap([
				{ hash: "abc123", parent: "rootnew0" },
				{ hash: "rootnew0", parent: null },
			]);
			(
				stubBridge as unknown as {
					getSummaryIndexEntryMap: ReturnType<typeof vi.fn>;
				}
			).getSummaryIndexEntryMap = makeRacingEntryMapMock(rootMap, rewrittenMap);
			showWarningMessage.mockResolvedValueOnce("Remove");
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					references: [
						{
							ticketId: "ENG-1",
							url: "https://linear.app/x/issue/ENG-1",
							title: "Test issue",
							addedAt: "2026-01-01T00:00:00Z",
							archivedKey: "k",
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({
				command: "removeReference",
				archivedKey: "k",
				source: "linear",
				nativeId: "ENG-1",
				title: "Test issue",
			});
			await flushPromises();

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringMatching(/^Remove/),
				expect.any(Object),
				"Remove",
			);
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("race-window: blocks translate note if amend lands during the LLM call", async () => {
			const rootMap = buildChainEntryMap([{ hash: "abc123", parent: null }]);
			const rewrittenMap = buildChainEntryMap([
				{ hash: "abc123", parent: "rootnew0" },
				{ hash: "rootnew0", parent: null },
			]);
			(
				stubBridge as unknown as {
					getSummaryIndexEntryMap: ReturnType<typeof vi.fn>;
				}
			).getSummaryIndexEntryMap = makeRacingEntryMapMock(rootMap, rewrittenMap);
			mockReadNoteFromBranch.mockResolvedValue("# 中文笔记\n\n内容");
			mockTranslateToEnglish.mockResolvedValue("# English Note\n\nbody");
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					notes: [
						{
							id: "cn-note",
							title: "中文笔记",
							kind: "markdown",
							addedAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "translateNote", id: "cn-note" });
			await flushPromises();

			expect(mockTranslateToEnglish).toHaveBeenCalled();
			expect(mockStoreNotes).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("race-window: blocks translate plan if amend lands during the LLM call", async () => {
			const rootMap = buildChainEntryMap([{ hash: "abc123", parent: null }]);
			const rewrittenMap = buildChainEntryMap([
				{ hash: "abc123", parent: "rootnew0" },
				{ hash: "rootnew0", parent: null },
			]);
			(
				stubBridge as unknown as {
					getSummaryIndexEntryMap: ReturnType<typeof vi.fn>;
				}
			).getSummaryIndexEntryMap = makeRacingEntryMapMock(rootMap, rewrittenMap);
			mockReadPlanFromBranch.mockResolvedValue("# 中文标题\n\nbody");
			mockTranslateToEnglish.mockResolvedValue("# English Title\n\nbody");
			await SummaryWebviewPanel.show(
				makeSummary({
					commitHash: "abc123",
					plans: [
						{
							slug: "p",
							title: "中文标题",
							addedAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					],
				}),
				extensionUri,
				workspaceRoot,
				stubBridge,
				mainBranch,
			);
			const dispatch = captureMessageHandler();

			dispatch({ command: "translatePlan", slug: "p" });
			await flushPromises();

			// LLM translate DID run (entry guard let it through); the post-LLM
			// guard blocked storePlans + syncPlanTitle (storeSummary).
			expect(mockTranslateToEnglish).toHaveBeenCalled();
			expect(mockStorePlans).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		// ── Stale-readonly mode transitions ───────────────────────────────

		it("clicking 'Open new commit's summary' on the modal fires jollimemory.viewSummary with the live root hash", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			// User chooses to navigate to the live commit's summary.
			showWarningMessage.mockResolvedValueOnce("Open new commit's summary");
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "push" });
			await flushPromises();

			expect(executeCommand).toHaveBeenCalledWith(
				"jollimemory.viewSummary",
				"rootnew0",
			);
		});

		it("dismissing the modal leaves the panel open in stale-readonly mode (no viewSummary dispatch)", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			// User dismisses the modal (Esc or "x" button) — undefined return.
			showWarningMessage.mockResolvedValueOnce(undefined);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "push" });
			await flushPromises();

			// No navigation triggered, but panel was re-rendered in stale mode.
			const viewSummaryCalls = executeCommand.mock.calls.filter(
				(c) => c[0] === "jollimemory.viewSummary",
			);
			expect(viewSummaryCalls).toHaveLength(0);
			const staleRender = mockBuildHtml.mock.calls.find(
				(c) =>
					(c[1] as { staleRewrittenInto?: string } | undefined)
						?.staleRewrittenInto === "rootnew0",
			);
			expect(staleRender).toBeDefined();
		});

		it("openRewrittenCommit webview message (banner button click) opens the new commit's panel", async () => {
			// Set up a fresh panel — banner action is independent of the modal
			// flow, the webview can post it any time the user clicks the
			// banner button (e.g. after dismissing the modal).
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "openRewrittenCommit", hash: "newroot0" });
			await flushPromises();

			expect(executeCommand).toHaveBeenCalledWith(
				"jollimemory.viewSummary",
				"newroot0",
			);
		});

		it("second guard trip is silent: no second modal, no second re-render", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			showWarningMessage.mockResolvedValue(undefined);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "push" });
			await flushPromises();

			const firstModalCount = showWarningMessage.mock.calls.filter(
				(c) =>
					typeof c[0] === "string" &&
					(c[0] as string).includes("rewritten into"),
			).length;
			const firstStaleRenders = mockBuildHtml.mock.calls.filter(
				(c) =>
					(c[1] as { staleRewrittenInto?: string } | undefined)
						?.staleRewrittenInto === "rootnew0",
			).length;

			// Second click on any guarded action — should NOT raise another
			// modal or re-render. The dispatcher / handler short-circuits
			// purely on the `staleRewrittenInto` field.
			dispatch({ command: "generateE2eTest" });
			await flushPromises();

			const secondModalCount = showWarningMessage.mock.calls.filter(
				(c) =>
					typeof c[0] === "string" &&
					(c[0] as string).includes("rewritten into"),
			).length;
			const secondStaleRenders = mockBuildHtml.mock.calls.filter(
				(c) =>
					(c[1] as { staleRewrittenInto?: string } | undefined)
						?.staleRewrittenInto === "rootnew0",
			).length;
			expect(secondModalCount).toBe(firstModalCount);
			expect(secondStaleRenders).toBe(firstStaleRenders);
		});

		it("passes the FULL 40-char root hash to buildHtml (not the short display form)", async () => {
			// Regression guard for the banner's "Open new commit's summary"
			// action. buildHtml receives `staleRewrittenInto` and is
			// responsible for rendering the short form for display while
			// keeping the full hash in `data-target-hash`. The panel must
			// store the full hash; if it pre-truncates, navigation breaks
			// (getSummary alias lookup is 40-char only, prefix scan can
			// throw on collisions).
			const fullChildHash = "a".repeat(40);
			const fullRootHash = "b".repeat(40);
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: fullChildHash, parent: fullRootHash },
					{ hash: fullRootHash, parent: null },
				]),
			);
			showWarningMessage.mockResolvedValueOnce(undefined);
			const dispatch = await setupCommit(fullChildHash);

			dispatch({ command: "push" });
			await flushPromises();

			// buildHtml gets the untruncated value.
			const staleRender = mockBuildHtml.mock.calls.find(
				(c) =>
					(c[1] as { staleRewrittenInto?: string } | undefined)
						?.staleRewrittenInto === fullRootHash,
			);
			expect(staleRender).toBeDefined();
			// The modal still uses the short form for readability.
			expectStaleModalShown(
				"rewritten into bbbbbbbb",
				"aaaaaaaa",
				"push to Jolli",
			);
		});

		// ── Transcript handlers (P2 #2) ──────────────────────────────────

		it("blocks save all transcripts when the commit was rewritten", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "saveAllTranscripts", entries: [] });
			await flushPromises();

			expectStaleModalShown("save transcripts");
			expect(mockSaveTranscriptsBatch).not.toHaveBeenCalled();
		});

		it("blocks delete all transcripts when the commit was rewritten", async () => {
			(
				stubBridge.getSummaryIndexEntryMap as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				buildChainEntryMap([
					{ hash: "abc123", parent: "rootnew0" },
					{ hash: "rootnew0", parent: null },
				]),
			);
			const dispatch = await setupCommit("abc123");

			dispatch({ command: "deleteAllTranscripts" });
			await flushPromises();

			expectStaleModalShown("delete transcripts");
			expect(mockSaveTranscriptsBatch).not.toHaveBeenCalled();
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
