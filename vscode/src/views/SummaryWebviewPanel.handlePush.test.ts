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
	withProgressMock,
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
	withProgressMock: vi.fn((_opts: unknown, work: () => unknown) => work()),
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
		withProgress: withProgressMock,
	},
	ProgressLocation: { Notification: 15 },
	env: {
		clipboard: { writeText: clipboardWriteText },
		openExternal,
	},
	Uri: {
		parse: vi.fn((s: string) => ({
			scheme: (s.match(/^([a-z][a-z0-9+.-]*):/i)?.[1] ?? "").toLowerCase(),
			toString: () => s,
		})),
		file: vi.fn((s: string) => ({ fsPath: s, toString: () => s })),
		joinPath: vi.fn((...args: Array<unknown>) => ({
			toString: () => String(args.join("/")),
		})),
	},
	ViewColumn: { One: 1 },
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

// plans.lock passthrough — run the RMW body inline (no real lock file I/O on the
// synthetic CWD). The lock contract is covered in cli/src/core/Locks.test.ts.
vi.mock("../../../cli/src/core/Locks.js", () => ({
	withPlansLock: (_cwd: string | undefined, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadPlansRegistry: mockLoadPlansRegistry,
	savePlansRegistry: mockSavePlansRegistry,
	saveConfig: mockSaveConfig,
}));

vi.mock("../util/WorkspaceUtils.js", () => ({
	loadGlobalConfig: mockLoadConfig,
}));

const {
	mockOpenShareModal,
	mockCopyShareLinkModal,
	mockSetShareAccessModal,
	mockSendInviteModal,
	mockRemoveRecipientModal,
	mockListOrgMembers,
} = vi.hoisted(() => ({
	mockOpenShareModal: vi.fn().mockResolvedValue(undefined),
	mockCopyShareLinkModal: vi.fn().mockResolvedValue(undefined),
	mockSetShareAccessModal: vi.fn().mockResolvedValue(undefined),
	mockSendInviteModal: vi.fn().mockResolvedValue(undefined),
	mockRemoveRecipientModal: vi.fn().mockResolvedValue(undefined),
	mockListOrgMembers: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/BranchShareModal.js", () => ({
	openShareModal: mockOpenShareModal,
	copyShareLinkModal: mockCopyShareLinkModal,
	setShareAccessModal: mockSetShareAccessModal,
	sendInviteModal: mockSendInviteModal,
	removeRecipientModal: mockRemoveRecipientModal,
}));

vi.mock("../services/JolliShareService.js", () => ({
	listOrgMembers: mockListOrgMembers,
}));

const { mockGetRepoContributors } = vi.hoisted(() => ({
	mockGetRepoContributors: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../cli/src/core/GitOps.js", async (importActual) => {
	const actual = await importActual<typeof import("../../../cli/src/core/GitOps.js")>();
	return { ...actual, getRepoContributors: mockGetRepoContributors };
});

// Wrap the real push orchestrator in a spy so the happy-path push tests keep
// exercising the genuine `pushSummaryWithAttachments` (it drives the mocked
// `pushToJolli`), while a single test can `mockRejectedValueOnce` a
// `ShareBindingError("failed")` to reach the generic bind-failure branch —
// the panel's own `resolveBinding` only ever yields bound/anotherOpen/cancelled,
// so "failed" is unreachable through the real integration.
vi.mock("../services/JolliPushOrchestrator.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../services/JolliPushOrchestrator.js")>();
	return { ...actual, pushSummaryWithAttachments: vi.fn(actual.pushSummaryWithAttachments) };
});

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
	mockReadEntityFromBranch,
	mockReadNoteFromBranch,
	mockReadPlanFromBranch,
	mockReadTranscriptsForCommits,
	mockSaveTranscriptsBatch,
	mockStoreEntities,
	mockStoreNotes,
	mockStorePlans,
	mockStoreSummary,
} = vi.hoisted(() => ({
	mockGetTranscriptHashes: vi.fn().mockResolvedValue(new Set<string>()),
	mockReadEntityFromBranch: vi.fn().mockResolvedValue(null),
	mockReadNoteFromBranch: vi.fn().mockResolvedValue(null),
	mockReadPlanFromBranch: vi.fn().mockResolvedValue(null),
	mockReadTranscriptsForCommits: vi.fn().mockResolvedValue(new Map()),
	mockSaveTranscriptsBatch: vi.fn().mockResolvedValue(undefined),
	mockStoreEntities: vi.fn().mockResolvedValue(undefined),
	mockStoreNotes: vi.fn().mockResolvedValue(undefined),
	mockStorePlans: vi.fn().mockResolvedValue(undefined),
	mockStoreSummary: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../cli/src/core/SummaryStore.js", () => ({
	getTranscriptHashes: mockGetTranscriptHashes,
	readReferenceFromBranch: mockReadEntityFromBranch,
	readNoteFromBranch: mockReadNoteFromBranch,
	readPlanFromBranch: mockReadPlanFromBranch,
	readTranscriptsForCommits: mockReadTranscriptsForCommits,
	saveTranscriptsBatch: mockSaveTranscriptsBatch,
	storeReferences: mockStoreEntities,
	storeNotes: mockStoreNotes,
	storePlans: mockStorePlans,
	storeSummary: mockStoreSummary,
	resolveEffectiveTopics: vi.fn(() => []),
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
import { ShareBindingError, pushSummaryWithAttachments } from "../services/JolliPushOrchestrator.js";
import { clearContributorsCache, SummaryWebviewPanel } from "./SummaryWebviewPanel.js";

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
	// Share path reads the current branch here (the snapshot content is sourced
	// from the current checkout, so the share's branch label/key follows it).
	// Defaults to the branch the share tests open the panel on.
	getCurrentBranch: vi.fn().mockResolvedValue("feature/share"),
	// Share popover flags the Owner collaborator row by matching this against the
	// repo contributors' emails; the name falls back to git user.name.
	getCurrentUserEmail: vi.fn().mockResolvedValue("dev@example.com"),
	getCurrentUserName: vi.fn().mockResolvedValue("Dev"),
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
		clearContributorsCache();
		mockGetRepoContributors.mockReset();
		mockGetRepoContributors.mockResolvedValue([]);
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

		it("re-reads the freshest summary from disk before pushing so a concurrent share can't mint a duplicate article", async () => {
			// Regression: this panel captured `currentSummary` with NO jolliDocId,
			// but another surface (the Create PR pane's branch share, or a second
			// summary panel) has since pushed this same commit and written a
			// jolliDocId back to disk. Pushing the stale in-memory copy would omit
			// `docId` → the server mints a DUPLICATE article. The push must carry the
			// disk copy's jolliDocId so the server updates the existing doc in place.
			mockLoadConfig.mockResolvedValue({ apiKey: "test", jolliApiKey: "jk_valid" });
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockPushToJolli.mockResolvedValue({ docId: 500 });
			// Disk holds the freshest copy of the SAME commit — now with a jolliDocId.
			// `Once` (not a persistent mock): the shared stubBridge is cleared with
			// vi.clearAllMocks() between tests, which keeps mockResolvedValue
			// implementations — a persistent value would leak into later push tests
			// that rely on getSummary defaulting to undefined. The push reads it
			// exactly once, so a single Once is both sufficient and self-cleaning.
			(stubBridge.getSummary as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				makeSummary({
					commitHash: "abc123",
					jolliDocId: 500,
					jolliDocUrl: "https://my.jolli.app/articles?doc=500",
				}),
			);
			// Panel's in-memory summary is stale: same commit, but no jolliDocId.
			const dispatch = await setupPanel({ commitHash: "abc123" });

			dispatch({ command: "push" });
			await flushPromises();

			// The push re-read the disk copy by commit hash...
			expect(stubBridge.getSummary).toHaveBeenCalledWith("abc123");
			// ...and the summary upload carried the disk docId, so the server updates
			// in place instead of minting a duplicate.
			const summaryCall = mockPushToJolli.mock.calls.find(
				(c: Array<unknown>) => (c[2] as { docType?: string }).docType === "summary",
			);
			expect((summaryCall?.[2] as { docId?: number }).docId).toBe(500);
		});

		it("uploads only the latest snapshot when same-named plans accumulate after squash", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockReadPlanFromBranch.mockResolvedValue("# Refactor auth\n\nbody");
			mockPushToJolli.mockResolvedValue({ docId: 7 });
			const dispatch = await setupPanel({
				plans: [
					{
						slug: "refactor-auth-1111aaaa",
						title: "Refactor auth",
						addedAt: "2026-01-10T00:00:00Z",
						updatedAt: "2026-01-10T00:00:00Z",
					},
					{
						slug: "refactor-auth-2222bbbb",
						title: "Refactor auth",
						addedAt: "2026-01-12T00:00:00Z",
						updatedAt: "2026-01-12T00:00:00Z",
					},
				],
			});

			dispatch({ command: "push" });
			await flushPromises();

			// Exactly one plan-type upload — the two same-named snapshots collapse
			// to the latest, instead of creating a duplicate document per commit.
			const planCalls = mockPushToJolli.mock.calls.filter(
				(c: Array<unknown>) =>
					(c[2] as { docType?: string }).docType === "plan",
			);
			expect(planCalls).toHaveLength(1);
			// The single upload reads the latest snapshot's content (push reads
			// with the 2-arg signature; the translate-set refresh uses 3 args).
			expect(mockReadPlanFromBranch).toHaveBeenCalledWith(
				"refactor-auth-2222bbbb",
				workspaceRoot,
			);
			// The pushed summary markdown is built from the deduped plans, so the
			// article's Plans & Notes list doesn't repeat the superseded snapshot.
			const mdSummary = mockBuildMarkdown.mock.calls.at(-1)?.[0] as {
				plans: Array<{ slug: string }>;
			};
			expect(mdSummary.plans).toHaveLength(1);
			expect(mdSummary.plans[0].slug).toBe("refactor-auth-2222bbbb");
		});

		it("does not abort the push when a single plan fails — pushes the summary and warns", async () => {
			mockLoadConfig.mockResolvedValue({
				apiKey: "test",
				jolliApiKey: "jk_valid",
			});
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			mockReadPlanFromBranch.mockResolvedValue("# Plan body\n\nbody");
			// Plan upload 500s (server already has the doc); summary upload succeeds.
			mockPushToJolli.mockImplementation(
				(_base: unknown, _key: unknown, payload: { docType?: string }) =>
					payload.docType === "plan"
						? Promise.reject(new Error("Push failed (HTTP 500)"))
						: Promise.resolve({ docId: 55 }),
			);
			const dispatch = await setupPanel({
				plans: [
					{
						slug: "stuck-plan-1111aaaa",
						title: "Stuck plan",
						addedAt: "2026-01-10T00:00:00Z",
						updatedAt: "2026-01-10T00:00:00Z",
					},
				],
			});

			dispatch({ command: "push" });
			await flushPromises();

			// The summary still uploaded despite the plan failure.
			const summaryCalls = mockPushToJolli.mock.calls.filter(
				(c: Array<unknown>) =>
					(c[2] as { docType?: string }).docType === "summary",
			);
			expect(summaryCalls).toHaveLength(1);
			// The user gets a MODAL warning (not a missable toast) naming the
			// failed attachment in its detail.
			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("attachment(s) failed"),
				expect.objectContaining({
					modal: true,
					detail: expect.stringContaining('plan "Stuck plan"'),
				}),
			);
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

	describe("SummaryWebviewPanel share modal", () => {
		beforeEach(() => {
			vi.clearAllMocks();
			clearContributorsCache();
			(SummaryWebviewPanel as unknown as { currentMemoryPanel: undefined }).currentMemoryPanel = undefined;
			(SummaryWebviewPanel as unknown as { commitPanels: Map<string, unknown> }).commitPanels.clear();
			mockLoadConfig.mockResolvedValue({ apiKey: "test", jolliApiKey: "jk_valid" });
			mockGetRepoContributors.mockReset();
			mockGetRepoContributors.mockResolvedValue([]);
			// Reset per-test so a "detached HEAD" case can't leak into later branch shares.
			(stubBridge.getCurrentBranch as ReturnType<typeof vi.fn>).mockResolvedValue("feature/share");
		});

		it("routes shareBranch to the modal state machine", async () => {
			const dispatch = await setupPanel({ branch: "feature/share" });

			dispatch({ command: "shareBranch" });
			await flushPromises();
			expect(mockOpenShareModal).toHaveBeenCalledTimes(1);
			const [, ctx] = mockOpenShareModal.mock.calls[0];
			expect(ctx).toMatchObject({ workspaceRoot, branch: "feature/share", apiKey: "jk_valid" });
		});

		it("routes copy/org/invite/remove/stop share messages to the current modal actions", async () => {
			const dispatch = await setupPanel({ branch: "feature/share" });

			dispatch({ command: "shareCopyLink", visibility: "public", shareKind: "commit" });
			dispatch({ command: "shareSetAccess", visibility: "org" });
			dispatch({
				command: "shareSendInvite",
				recipients: ["Ext@GMAIL.com", "bad", "ext@gmail.com"],
				message: "hello",
				visibility: "org",
			});
			dispatch({ command: "shareRemoveRecipient", email: "Ext@GMAIL.com" });
			await flushPromises();

			expect(mockCopyShareLinkModal).toHaveBeenCalledWith(expect.anything(), expect.anything(), "public");
			expect(mockCopyShareLinkModal.mock.calls[0][1]).toMatchObject({ commitHash: expect.any(String) });
			expect(mockSetShareAccessModal).toHaveBeenCalledWith(expect.anything(), expect.anything(), "org");
			expect(mockSendInviteModal).toHaveBeenCalledWith(expect.anything(), expect.anything(), ["ext@gmail.com"], "hello", "org");
			expect(mockRemoveRecipientModal).toHaveBeenCalledWith(expect.anything(), expect.anything(), "Ext@GMAIL.com");
		});

		it("caches repo contributors across share interactions (one git log per workspace)", async () => {
			const dispatch = await setupPanel({ branch: "feature/share" });
			// Each interaction re-resolves the share context, but the full-history
			// `git log` runs once — subsequent (sequential) clicks hit the cache.
			dispatch({ command: "shareCopyLink", visibility: "public", shareKind: "commit" });
			await flushPromises();
			dispatch({ command: "shareSetAccess", visibility: "org" });
			await flushPromises();
			dispatch({ command: "shareRemoveRecipient", email: "a@b.com" });
			await flushPromises();
			expect(mockGetRepoContributors).toHaveBeenCalledTimes(1);
		});

		it("rejects invalid share messages before they reach the modal services", async () => {
			const dispatch = await setupPanel({ branch: "feature/share" });
			dispatch({ command: "shareCopyLink", visibility: "banana" });
			dispatch({ command: "shareSetAccess", visibility: "banana" });
			await flushPromises();
			expect(mockCopyShareLinkModal).not.toHaveBeenCalled();
			expect(mockSetShareAccessModal).not.toHaveBeenCalled();
			expect(showErrorMessage).toHaveBeenCalledTimes(2);
		});

		it("resolves the owner name and splits account members from git collaborators", async () => {
			mockGetRepoContributors.mockResolvedValueOnce([
				{ name: "Dev Eloper", email: "dev@example.com" },
				{ name: "Ext User", email: "ext@example.com" },
			]);
			mockListOrgMembers.mockResolvedValueOnce([
				{ name: "Dev Eloper", email: "dev@example.com" },
				{ name: "Dup", email: "DEV@example.com" },
			]);
			const dispatch = await setupPanel({ branch: "feature/share" });
			dispatch({ command: "shareBranch" });
			await flushPromises();
			const [, ctx] = mockOpenShareModal.mock.calls[0];
			expect(ctx.owner).toEqual({ name: "Dev Eloper", email: "dev@example.com" });
			expect(ctx.accountMembers).toEqual([
				{ name: "Dev Eloper", email: "dev@example.com" },
				{ name: "Dup", email: "DEV@example.com" },
			]);
			expect(ctx.gitCollaborators).toEqual([{ name: "Ext User", email: "ext@example.com" }]);
		});

		it("skips the org-member fetch when there is no API key", async () => {
			mockLoadConfig.mockResolvedValue({});
			const dispatch = await setupPanel({ branch: "feature/share" });
			dispatch({ command: "shareBranch" });
			await flushPromises();
			expect(mockListOrgMembers).not.toHaveBeenCalled();
			const [, ctx] = mockOpenShareModal.mock.calls[0];
			expect(ctx.apiKey).toBeUndefined();
		});

		it("branch share is labeled with the CURRENT branch, not the opened summary's branch", async () => {
			// Panel opened on feature/a, but the user has since checked out feature/b.
			// The snapshot content comes from the current checkout, so the share must be
			// labeled/keyed feature/b — otherwise it'd publish feature/b's content under
			// a feature/a label.
			const dispatch = await setupPanel({ branch: "feature/a" });
			(stubBridge.getCurrentBranch as ReturnType<typeof vi.fn>).mockResolvedValue("feature/b");

			dispatch({ command: "shareBranch" });
			await flushPromises();
			const [, ctx] = mockOpenShareModal.mock.calls[0];
			expect(ctx).toMatchObject({ branch: "feature/b" });
		});

		it("commit share stays bound to the opened summary when the current branch changed", async () => {
			const dispatch = await setupPanel({ branch: "feature/a", commitHash: "abc123" });
			(stubBridge.getCurrentBranch as ReturnType<typeof vi.fn>).mockResolvedValue("feature/b");

			dispatch({ command: "shareBranch", shareKind: "commit" });
			await flushPromises();
			const [, ctx] = mockOpenShareModal.mock.calls[0];
			expect(ctx).toMatchObject({ branch: "feature/a", commitHash: "abc123" });
			expect(ctx.commitSummary).toMatchObject({ branch: "feature/a", commitHash: "abc123" });
		});

		it("blocks a branch share in detached HEAD (warns, opens nothing)", async () => {
			const dispatch = await setupPanel({ branch: "feature/a" });
			(stubBridge.getCurrentBranch as ReturnType<typeof vi.fn>).mockResolvedValue("HEAD");

			dispatch({ command: "shareBranch" });
			await flushPromises();
			expect(mockOpenShareModal).not.toHaveBeenCalled();
			expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("HEAD is detached"));
			// The webview optimistically showed the loading pane; an error state must be
			// posted so the popover doesn't spin forever.
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ command: "shareState", state: expect.objectContaining({ kind: "error" }) }),
			);
		});

		it("does NOT clobber the popover with an error for a NON-open action in detached HEAD", async () => {
			const dispatch = await setupPanel({ branch: "feature/a" });
			(stubBridge.getCurrentBranch as ReturnType<typeof vi.fn>).mockResolvedValue("HEAD");

			// A copy on the already-open main pane: no ctx (detached), but the error
			// state is open-only — posting it here would tear down the visible popover.
			dispatch({ command: "shareCopyLink", visibility: "public" });
			await flushPromises();
			expect(mockCopyShareLinkModal).not.toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ command: "shareState", state: expect.objectContaining({ kind: "error" }) }),
			);
		});

		it("commit share still works in detached HEAD (bound to the memory's own commit)", async () => {
			const dispatch = await setupPanel({ branch: "feature/a", commitHash: "abc123" });
			(stubBridge.getCurrentBranch as ReturnType<typeof vi.fn>).mockResolvedValue("HEAD");

			dispatch({ command: "shareBranch", shareKind: "commit" });
			await flushPromises();
			const [, ctx] = mockOpenShareModal.mock.calls[0];
			expect(ctx).toMatchObject({ branch: "feature/a", commitHash: "abc123" });
		});

		it("builds a VS Code-backed IO (postState, copy, notifications)", async () => {
			const dispatch = await setupPanel({ branch: "feature/share" });
			dispatch({ command: "shareBranch" });
			await flushPromises();
			const [io] = mockOpenShareModal.mock.calls[0];

			io.postState({ kind: "needsApiKey" });
			expect(postMessage).toHaveBeenCalledWith({ command: "shareState", state: { kind: "needsApiKey" } });

			await expect(io.copyToClipboard("https://acme.jolli.ai/b/x")).resolves.toBe(true);
			expect(clipboardWriteText).toHaveBeenCalledWith("https://acme.jolli.ai/b/x");
			clipboardWriteText.mockRejectedValueOnce(new Error("clipboard denied"));
			await expect(io.copyToClipboard("https://acme.jolli.ai/b/y")).resolves.toBe(false);
			io.postCopyResult({ ok: true });
			expect(postMessage).toHaveBeenCalledWith({ command: "shareCopyResult", ok: true });

			io.notifyError("boom");
			expect(showErrorMessage).toHaveBeenCalledWith("boom");
			io.notifyInfo("done");
			expect(showInformationMessage).toHaveBeenCalledWith("done");
		});

		it("maps binding chooser outcomes through the share context resolver", async () => {
			mockLoadConfig.mockResolvedValue({ apiKey: "test", jolliApiKey: "jk_valid" });
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app/", o: "org_1" });
			const dispatch = await setupPanel({ branch: "feature/share" });
			dispatch({ command: "shareBranch" });
			await flushPromises();
			const [, ctx] = mockOpenShareModal.mock.calls[0];

			mockBindingChooserOpen
				.mockResolvedValueOnce({ kind: "selected" })
				.mockResolvedValueOnce({ kind: "anotherOpen" })
				.mockResolvedValueOnce({ kind: "cancelled" });

			await expect(ctx.resolveBinding("https://github.com/example/repo")).resolves.toEqual({ status: "bound" });
			await expect(ctx.resolveBinding("https://github.com/example/repo")).resolves.toEqual({ status: "anotherOpen" });
			await expect(ctx.resolveBinding("https://github.com/example/repo")).resolves.toEqual({ status: "cancelled" });
			expect(mockBindingChooserOpen).toHaveBeenCalledWith(
				expect.objectContaining({
					baseUrl: "https://my.jolli.app",
					apiKey: "jk_valid",
					repoUrl: "https://github.com/example/repo",
					suggestedRepoName: "repo",
				}),
			);
		});

		it("shows a generic bind-failure error when the orchestrator reports outcome 'failed'", async () => {
			mockLoadConfig.mockResolvedValue({ apiKey: "test", jolliApiKey: "jk_valid" });
			mockParseJolliApiKey.mockReturnValue({ u: "https://my.jolli.app" });
			// The panel's own resolveBinding only maps to bound/anotherOpen/cancelled,
			// so drive the "failed" outcome by having the orchestrator itself reject
			// with ShareBindingError("failed") — the else branch of the outcome fan-out.
			(pushSummaryWithAttachments as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new ShareBindingError("failed"),
			);
			const dispatch = await setupPanel();

			dispatch({ command: "push" });
			await flushPromises();

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("could not bind a Memory space"),
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ command: "pushToJolliResult", success: false }),
			);
		});
	});
