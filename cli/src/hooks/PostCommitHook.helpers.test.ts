import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockSpawn,
	mockExistsSync,
	mockReadFileSync,
	mockStatSync,
	mockCreateReadStream,
	mockHomedir,
	mockCreateInterface,
	mockLoadPlansRegistry,
	mockSavePlansRegistry,
	mockAssociatePlanWithCommit,
	mockStorePlans,
	mockStoreSummary,
	mockLoadAllSessions,
	mockLoadCursorForTranscript,
	mockSaveCursor,
	mockLoadConfig,
	mockLoadPluginSource,
	mockDeletePluginSource,
	mockLoadSquashPending,
	mockLoadAmendPending,
	mockReadTranscript,
	mockBuildMultiSessionContext,
	mockGenerateSummary,
	mockGetHeadCommitInfo,
	mockGetCurrentBranch,
	mockGetDiffContent,
	mockGetDiffStats,
	mockGetSummary,
	mockDiscoverCodexSessions,
	mockGetLastReflogAction,
	mockEvaluatePlanProgress,
	mockFilterSessionsByEnabledIntegrations,
} = vi.hoisted(() => ({
	mockSpawn: vi.fn(),
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockStatSync: vi.fn(),
	mockCreateReadStream: vi.fn(),
	mockHomedir: vi.fn(),
	mockCreateInterface: vi.fn(),
	mockLoadPlansRegistry: vi.fn(),
	mockSavePlansRegistry: vi.fn(),
	mockAssociatePlanWithCommit: vi.fn(),
	mockStorePlans: vi.fn(),
	mockStoreSummary: vi.fn(),
	mockLoadAllSessions: vi.fn(),
	mockLoadCursorForTranscript: vi.fn(),
	mockSaveCursor: vi.fn(),
	mockLoadConfig: vi.fn(),
	mockLoadPluginSource: vi.fn(),
	mockDeletePluginSource: vi.fn(),
	mockLoadSquashPending: vi.fn(),
	mockLoadAmendPending: vi.fn(),
	mockReadTranscript: vi.fn(),
	mockBuildMultiSessionContext: vi.fn(),
	mockGenerateSummary: vi.fn(),
	mockGetHeadCommitInfo: vi.fn(),
	mockGetCurrentBranch: vi.fn(),
	mockGetDiffContent: vi.fn(),
	mockGetDiffStats: vi.fn(),
	mockGetSummary: vi.fn(),
	mockDiscoverCodexSessions: vi.fn(),
	mockGetLastReflogAction: vi.fn(),
	mockEvaluatePlanProgress: vi.fn(),
	/** Inline implementation matching filterSessionsByEnabledIntegrations —
	 *  importOriginal cannot be used because node:fs/node:os are fully mocked. */
	mockFilterSessionsByEnabledIntegrations: (
		sessions: Array<{ source?: string }>,
		config: Record<string, unknown>,
	) => {
		let filtered = [...sessions];
		if (config.claudeEnabled === false) {
			filtered = filtered.filter((s) => s.source !== undefined && s.source !== "claude");
		}
		if (config.geminiEnabled === false) {
			filtered = filtered.filter((s) => s.source !== "gemini");
		}
		return filtered;
	},
}));

vi.mock("node:child_process", () => ({
	spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
	existsSync: mockExistsSync,
	readFileSync: mockReadFileSync,
	statSync: mockStatSync,
	createReadStream: mockCreateReadStream,
}));

vi.mock("node:os", () => ({
	homedir: mockHomedir,
}));

vi.mock("node:readline", () => ({
	createInterface: mockCreateInterface,
}));

vi.mock("../core/StorageFactory.js", () => ({
	createStorage: vi.fn().mockResolvedValue({
		readFile: vi.fn().mockResolvedValue(null),
		writeFiles: vi.fn().mockResolvedValue(undefined),
		listFiles: vi.fn().mockResolvedValue([]),
		exists: vi.fn().mockResolvedValue(true),
		ensure: vi.fn().mockResolvedValue(undefined),
	}),
}));

vi.mock("../core/GitOps.js", () => ({
	getHeadCommitInfo: mockGetHeadCommitInfo,
	getCommitInfo: mockGetHeadCommitInfo,
	getHeadHash: vi.fn(),
	getParentHash: vi.fn(),
	getDiffContent: mockGetDiffContent,
	getDiffStats: mockGetDiffStats,
	getCurrentBranch: mockGetCurrentBranch,
	getLastReflogAction: mockGetLastReflogAction,
}));

vi.mock("../core/SessionTracker.js", () => ({
	acquireLock: vi.fn(),
	associatePlanWithCommit: mockAssociatePlanWithCommit,
	deleteAmendPending: vi.fn(),
	deletePluginSource: mockDeletePluginSource,
	deleteSquashPending: vi.fn(),
	filterSessionsByEnabledIntegrations: mockFilterSessionsByEnabledIntegrations,
	loadAllSessions: mockLoadAllSessions,
	loadAmendPending: mockLoadAmendPending,
	loadConfig: mockLoadConfig,
	loadCursorForTranscript: mockLoadCursorForTranscript,
	loadPlansRegistry: mockLoadPlansRegistry,
	loadPluginSource: mockLoadPluginSource,
	loadSquashPending: mockLoadSquashPending,
	releaseLock: vi.fn(),
	saveCursor: mockSaveCursor,
	savePlansRegistry: mockSavePlansRegistry,
}));

vi.mock("../core/SummaryStore.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/SummaryStore.js")>();
	return {
		...actual,
		getSummary: mockGetSummary,
		mergeManyToOne: vi.fn(),
		storePlans: mockStorePlans,
		storeSummary: mockStoreSummary,
		setActiveStorage: vi.fn(),
	};
});

vi.mock("../core/TranscriptReader.js", () => ({
	buildMultiSessionContext: mockBuildMultiSessionContext,
	readTranscript: mockReadTranscript,
}));

vi.mock("../core/Summarizer.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/Summarizer.js")>();
	return {
		generateSummary: mockGenerateSummary,
		// Mock LLM-touching squash consolidation; default null forces the
		// caller into the (real) mechanicalConsolidate fallback.
		generateSquashConsolidation: vi.fn().mockResolvedValue(null),
		mechanicalConsolidate: actual.mechanicalConsolidate,
		extractTicketIdFromMessage: actual.extractTicketIdFromMessage,
		formatSourceCommitsForSquash: actual.formatSourceCommitsForSquash,
	};
});

vi.mock("../core/CodexSessionDiscoverer.js", () => ({
	discoverCodexSessions: mockDiscoverCodexSessions,
	isCodexInstalled: vi.fn(),
}));

vi.mock("../core/PlanProgressEvaluator.js", () => ({
	evaluatePlanProgress: mockEvaluatePlanProgress,
}));

vi.mock("../core/GeminiTranscriptReader.js", () => ({
	readGeminiTranscript: vi.fn(),
}));

vi.mock("../core/OpenCodeSessionDiscoverer.js", () => ({
	discoverOpenCodeSessions: vi.fn().mockResolvedValue([]),
	isOpenCodeInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/OpenCodeTranscriptReader.js", () => ({
	readOpenCodeTranscript: vi.fn(),
}));

vi.mock("../core/TranscriptParser.js", () => ({
	getParserForSource: vi.fn(),
}));

const { __test__ } = await import("./PostCommitHook.js");

describe("PostCommitHook helpers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockHomedir.mockReturnValue("/mock-home");
		mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {} });
		mockSavePlansRegistry.mockResolvedValue(undefined);
		mockStorePlans.mockResolvedValue(undefined);
		mockStoreSummary.mockResolvedValue(undefined);
		mockLoadAllSessions.mockResolvedValue([]);
		mockLoadCursorForTranscript.mockResolvedValue(null);
		mockSaveCursor.mockResolvedValue(undefined);
		mockLoadConfig.mockResolvedValue({});
		mockLoadPluginSource.mockResolvedValue(false);
		mockDeletePluginSource.mockResolvedValue(undefined);
		mockLoadSquashPending.mockResolvedValue(null);
		mockLoadAmendPending.mockResolvedValue(null);
		mockReadTranscript.mockResolvedValue({
			entries: [{ role: "human", content: "hello" }],
			newCursor: { transcriptPath: "/tmp/session.jsonl", lineNumber: 1, updatedAt: "2026-02-19T00:00:00Z" },
			totalLinesRead: 1,
		});
		mockBuildMultiSessionContext.mockReturnValue("[Human]: hello");
		mockGenerateSummary.mockResolvedValue({
			transcriptEntries: 1,
			llm: { model: "test", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: "end_turn" },
			stats: { filesChanged: 1, insertions: 1, deletions: 0 },
			topics: [{ title: "Topic", trigger: "Trigger", response: "Response", decisions: "Decision" }],
		});
		mockGetHeadCommitInfo.mockResolvedValue({
			hash: "deadbeefcafebabe",
			message: "Test commit",
			author: "Test",
			date: "2026-02-19T00:00:00Z",
		});
		mockGetCurrentBranch.mockResolvedValue("main");
		mockGetDiffContent.mockResolvedValue("diff");
		mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 1, deletions: 0 });
		mockGetSummary.mockResolvedValue(null);
		mockDiscoverCodexSessions.mockResolvedValue([]);
		mockGetLastReflogAction.mockResolvedValue("commit: Test commit");
		mockEvaluatePlanProgress.mockResolvedValue(null);
	});

	describe("resolveGitDir", () => {
		it("returns the resolved relative gitdir from a worktree .git file", () => {
			mockStatSync.mockReturnValue({ isFile: () => true } as ReturnType<typeof mockStatSync>);
			mockReadFileSync.mockReturnValue("gitdir: ../main/.git/worktrees/feature\n");

			expect(__test__.resolveGitDir("/repo/worktree")).toBe(
				join("/repo/worktree", "../main/.git/worktrees/feature"),
			);
		});

		it("returns the absolute gitdir when the .git file contains an absolute path", () => {
			mockStatSync.mockReturnValue({ isFile: () => true } as ReturnType<typeof mockStatSync>);
			mockReadFileSync.mockReturnValue("gitdir: /repo/.git/worktrees/feature\n");

			expect(__test__.resolveGitDir("/repo/worktree")).toBe("/repo/.git/worktrees/feature");
		});

		it("falls back to cwd/.git when the .git metadata cannot be read", () => {
			mockStatSync.mockImplementation(() => {
				throw new Error("boom");
			});

			expect(__test__.resolveGitDir("/repo/worktree")).toBe(join("/repo/worktree", ".git"));
		});
	});

	describe("isRebaseInProgress", () => {
		it("returns true when rebase-merge exists in the resolved gitdir", () => {
			mockStatSync.mockReturnValue({ isFile: () => false } as ReturnType<typeof mockStatSync>);
			mockExistsSync.mockImplementation((path: string) => path.endsWith("rebase-merge"));

			expect(__test__.isRebaseInProgress("/repo/worktree")).toBe(true);
		});

		it("returns true when rebase-apply exists in the resolved gitdir", () => {
			mockStatSync.mockReturnValue({ isFile: () => false } as ReturnType<typeof mockStatSync>);
			mockExistsSync.mockImplementation((path: string) => path.endsWith("rebase-apply"));

			expect(__test__.isRebaseInProgress("/repo/worktree")).toBe(true);
		});
	});

	describe("detectPlanSlugsFromRegistry", () => {
		it("returns uncommitted, non-ignored plan slugs from the registry", async () => {
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {
					"alpha-plan": { slug: "alpha-plan", commitHash: null, ignored: false },
					"beta-plan": { slug: "beta-plan", commitHash: null, ignored: false },
					"committed-plan": { slug: "committed-plan", commitHash: "abc123", ignored: false },
					"ignored-plan": { slug: "ignored-plan", commitHash: null, ignored: true },
				},
			});

			const slugs = await __test__.detectPlanSlugsFromRegistry("/repo");
			expect([...slugs].sort()).toEqual(["alpha-plan", "beta-plan"]);
		});

		it("returns empty set when all plans are committed or ignored", async () => {
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {
					done: { slug: "done", commitHash: "abc", ignored: false },
					skipped: { slug: "skipped", commitHash: null, ignored: true },
				},
			});

			const slugs = await __test__.detectPlanSlugsFromRegistry("/repo");
			expect(slugs.size).toBe(0);
		});

		it("excludes plans with contentHashAtCommit set", async () => {
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {
					snapshotted: {
						slug: "snapshotted",
						commitHash: null,
						ignored: false,
						contentHashAtCommit: "hash123",
					},
					eligible: { slug: "eligible", commitHash: null, ignored: false },
				},
			});

			const slugs = await __test__.detectPlanSlugsFromRegistry("/repo");
			expect([...slugs]).toEqual(["eligible"]);
		});
	});

	describe("associatePlansWithCommit", () => {
		it("archives eligible plans and stores their backed-up files", async () => {
			mockLoadPlansRegistry
				.mockResolvedValueOnce({
					version: 1,
					plans: {
						alpha: {
							slug: "alpha",
							title: "Alpha",
							sourcePath: "/mock-home/.claude/plans/alpha.md",
							addedAt: "2026-02-18T00:00:00Z",
							updatedAt: "2026-02-18T00:00:00Z",
							branch: "feature/test",
							commitHash: null,
							editCount: 2,
						},
					},
				})
				.mockResolvedValueOnce({
					version: 1,
					plans: {
						alpha: {
							slug: "alpha",
							title: "Alpha",
							sourcePath: "/mock-home/.claude/plans/alpha.md",
							addedAt: "2026-02-18T00:00:00Z",
							updatedAt: "2026-02-18T00:00:00Z",
							branch: "feature/test",
							commitHash: null,
							editCount: 2,
						},
					},
				});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Alpha plan\n\nDo the work");

			const result = await __test__.associatePlansWithCommit(new Set(["alpha"]), "deadbeefcafebabe", "/repo");

			expect(result.refs).toHaveLength(1);
			expect(result.refs[0].slug).toBe("alpha-deadbeef");
			expect(result.refs[0].title).toBe("Alpha plan");
			expect(result.markdownBySlug.get("alpha-deadbeef")).toBe("# Alpha plan\n\nDo the work");
			expect(result.originalSlugBySlug.get("alpha-deadbeef")).toBe("alpha");
			expect(mockSavePlansRegistry).toHaveBeenCalledTimes(1);
			expect(mockSavePlansRegistry.mock.calls[0][0].plans.alpha.contentHashAtCommit).toBeTruthy();
			expect(mockSavePlansRegistry.mock.calls[0][0].plans["alpha-deadbeef"]).toEqual(
				expect.objectContaining({
					slug: "alpha-deadbeef",
					commitHash: "deadbeefcafebabe",
				}),
			);
			expect(mockStorePlans).toHaveBeenCalledWith(
				[{ slug: "alpha-deadbeef", content: "# Alpha plan\n\nDo the work" }],
				"Archive 1 plan(s) for commit deadbeef",
				"/repo",
				undefined,
			);
		});

		it("skips plans that are absent, ignored, archived, already associated, or missing on disk", async () => {
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {
					ignored: {
						slug: "ignored",
						title: "Ignored",
						sourcePath: "/mock-home/.claude/plans/ignored.md",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
						branch: "feature/test",
						commitHash: null,
						editCount: 1,
						ignored: true,
					},
					archived: {
						slug: "archived",
						title: "Archived",
						sourcePath: "/mock-home/.claude/plans/archived.md",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
						branch: "feature/test",
						commitHash: null,
						editCount: 1,
						contentHashAtCommit: "abc123",
					},
					associated: {
						slug: "associated",
						title: "Associated",
						sourcePath: "/mock-home/.claude/plans/associated.md",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
						branch: "feature/test",
						commitHash: "12345678",
						editCount: 1,
					},
					missing: {
						slug: "missing",
						title: "Missing",
						sourcePath: "/mock-home/.claude/plans/missing.md",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
						branch: "feature/test",
						commitHash: null,
						editCount: 1,
					},
				},
			});
			mockExistsSync.mockReturnValue(false);

			const result = await __test__.associatePlansWithCommit(
				new Set(["unknown", "ignored", "archived", "associated", "missing"]),
				"deadbeefcafebabe",
				"/repo",
			);

			expect(result.refs).toEqual([]);
			expect(mockSavePlansRegistry).not.toHaveBeenCalled();
			expect(mockStorePlans).not.toHaveBeenCalled();
		});

		it("falls back to the slug when the plan markdown has no heading", async () => {
			mockLoadPlansRegistry
				.mockResolvedValueOnce({
					version: 1,
					plans: {
						sluggy: {
							slug: "sluggy",
							title: "Sluggy",
							sourcePath: "/mock-home/.claude/plans/sluggy.md",
							addedAt: "2026-02-18T00:00:00Z",
							updatedAt: "2026-02-18T00:00:00Z",
							branch: "feature/test",
							commitHash: null,
							editCount: 1,
						},
					},
				})
				.mockResolvedValueOnce({
					version: 1,
					plans: {
						sluggy: {
							slug: "sluggy",
							title: "Sluggy",
							sourcePath: "/mock-home/.claude/plans/sluggy.md",
							addedAt: "2026-02-18T00:00:00Z",
							updatedAt: "2026-02-18T00:00:00Z",
							branch: "feature/test",
							commitHash: null,
							editCount: 1,
						},
					},
				});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("plain plan content");

			const result = await __test__.associatePlansWithCommit(new Set(["sluggy"]), "deadbeefcafebabe", "/repo");

			expect(result.refs[0].title).toBe("sluggy");
		});
	});

	describe("executePipeline", () => {
		it("stores plan references on the summary when transcript slug detection finds a plan", async () => {
			mockLoadAllSessions.mockResolvedValue([
				{
					sessionId: "sess-1",
					transcriptPath: "/tmp/session.jsonl",
					updatedAt: "2026-02-19T00:00:00Z",
					source: "claude",
				},
			]);
			const planPath = join("/mock-home", ".claude", "plans", "sluggy.md");
			mockExistsSync.mockImplementation((path: string) => path === "/tmp/session.jsonl" || path === planPath);
			mockCreateReadStream.mockReturnValue({} as never);
			mockCreateInterface.mockReturnValue(
				(async function* () {
					yield '{"slug":"sluggy"}';
				})(),
			);
			mockReadFileSync.mockImplementation((path: string) =>
				path === planPath ? "plan body without heading" : "",
			);
			mockLoadPlansRegistry
				.mockResolvedValueOnce({
					version: 1,
					plans: {
						sluggy: {
							slug: "sluggy",
							title: "Sluggy",
							sourcePath: "/mock-home/.claude/plans/sluggy.md",
							addedAt: "2026-02-18T00:00:00Z",
							updatedAt: "2026-02-18T00:00:00Z",
							branch: "feature/test",
							commitHash: null,
							editCount: 3,
						},
					},
				})
				.mockResolvedValueOnce({
					version: 1,
					plans: {
						sluggy: {
							slug: "sluggy",
							title: "Sluggy",
							sourcePath: "/mock-home/.claude/plans/sluggy.md",
							addedAt: "2026-02-18T00:00:00Z",
							updatedAt: "2026-02-18T00:00:00Z",
							branch: "feature/test",
							commitHash: null,
							editCount: 3,
						},
					},
				});

			await __test__.executePipeline(
				"/repo",
				{
					type: "commit",
					commitHash: "deadbeef",
					createdAt: new Date().toISOString(),
				},
				false,
			);

			expect(mockStoreSummary).toHaveBeenCalledWith(
				expect.objectContaining({
					plans: [expect.objectContaining({ slug: "sluggy-deadbeef", title: "sluggy" })],
				}),
				"/repo",
				false,
				expect.anything(),
			);
		});

		it("stores plan progress artifacts with correct commit metadata when evaluator returns a result", async () => {
			mockLoadAllSessions.mockResolvedValue([
				{
					sessionId: "sess-1",
					transcriptPath: "/tmp/session.jsonl",
					updatedAt: "2026-02-19T00:00:00Z",
					source: "claude",
				},
			]);
			const planPath = join("/mock-home", ".claude", "plans", "sluggy.md");
			mockExistsSync.mockImplementation((path: string) => path === "/tmp/session.jsonl" || path === planPath);
			mockCreateReadStream.mockReturnValue({} as never);
			mockCreateInterface.mockReturnValue(
				(async function* () {
					yield '{"slug":"sluggy"}';
				})(),
			);
			mockReadFileSync.mockImplementation((path: string) =>
				path === planPath ? "# My Plan\n\n1. Step one\n2. Step two" : "",
			);
			mockLoadPlansRegistry
				.mockResolvedValueOnce({
					version: 1,
					plans: {
						sluggy: {
							slug: "sluggy",
							title: "My Plan",
							sourcePath: planPath,
							addedAt: "2026-02-18T00:00:00Z",
							updatedAt: "2026-02-18T00:00:00Z",
							branch: "feature/test",
							commitHash: null,
							editCount: 2,
						},
					},
				})
				.mockResolvedValueOnce({
					version: 1,
					plans: {
						sluggy: {
							slug: "sluggy",
							title: "My Plan",
							sourcePath: planPath,
							addedAt: "2026-02-18T00:00:00Z",
							updatedAt: "2026-02-18T00:00:00Z",
							branch: "feature/test",
							commitHash: null,
							editCount: 2,
						},
					},
				});

			// Return a non-null eval result so the artifact path is exercised
			mockEvaluatePlanProgress.mockResolvedValueOnce({
				summary: "Implemented step one of the plan.",
				steps: [
					{ id: "1", description: "Step one", status: "completed", note: "Fully done." },
					{ id: "2", description: "Step two", status: "not_started", note: null },
				],
				llm: {
					model: "claude-haiku-4-5-20251001",
					inputTokens: 500,
					outputTokens: 200,
					apiLatencyMs: 350,
					stopReason: "end_turn",
				},
			});

			await __test__.executePipeline(
				"/repo",
				{
					type: "commit",
					commitHash: "deadbeef",
					createdAt: new Date().toISOString(),
				},
				false,
			);

			// Verify evaluator was called with the plan markdown and diff
			expect(mockEvaluatePlanProgress).toHaveBeenCalledWith(
				"# My Plan\n\n1. Step one\n2. Step two",
				"diff",
				expect.any(Array),
				expect.any(String),
				expect.any(Object),
			);

			// Verify storeSummary received planProgress artifacts with correct commit metadata
			const storeCall = mockStoreSummary.mock.calls[0];
			const artifacts = storeCall[3] as { planProgress?: ReadonlyArray<Record<string, unknown>> };
			expect(artifacts.planProgress).toHaveLength(1);

			const progress = artifacts.planProgress?.[0];
			expect(progress?.version).toBe(1);
			expect(progress?.commitHash).toBe("deadbeefcafebabe");
			expect(progress?.commitMessage).toBe("Test commit");
			expect(progress?.planSlug).toBe("sluggy-deadbeef");
			expect(progress?.originalSlug).toBe("sluggy");
			expect(progress?.summary).toBe("Implemented step one of the plan.");
			expect(progress?.steps).toHaveLength(2);
		});
	});

	describe("handleAmendPipeline", () => {
		it("hoists old summary metadata during no-content amend migration", async () => {
			mockGetSummary.mockResolvedValue({
				version: 3,
				commitHash: "oldhash",
				commitMessage: "Old commit",
				commitAuthor: "Test",
				commitDate: "2026-02-18T00:00:00Z",
				branch: "main",
				generatedAt: "2026-02-18T00:00:00Z",
				transcriptEntries: 1,
				stats: { filesChanged: 1, insertions: 1, deletions: 0 },
				topics: [{ title: "Old", trigger: "T", response: "R", decisions: "D" }],
				jolliDocId: 42,
				jolliDocUrl: "https://jolli.app/articles/42",
				orphanedDocIds: [10, 11],
				plans: [
					{
						slug: "plan-1",
						title: "Plan 1",
						editCount: 1,
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
				e2eTestGuide: [{ title: "Scenario", steps: ["one"], expectedResults: ["done"] }],
			});
			mockLoadAllSessions.mockResolvedValue([]);
			mockLoadConfig.mockResolvedValue({});
			mockGetDiffStats.mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("");

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockStoreSummary).toHaveBeenCalledWith(
				expect.objectContaining({
					jolliDocId: 42,
					jolliDocUrl: "https://jolli.app/articles/42",
					orphanedDocIds: [10, 11],
					plans: [expect.objectContaining({ slug: "plan-1" })],
					e2eTestGuide: [expect.objectContaining({ title: "Scenario" })],
				}),
				"/repo",
			);
		});

		it("hoists old summary metadata onto the amended summary when new content exists", async () => {
			mockGetSummary.mockResolvedValue({
				version: 3,
				commitHash: "oldhash",
				commitMessage: "Old commit",
				commitAuthor: "Test",
				commitDate: "2026-02-18T00:00:00Z",
				branch: "main",
				generatedAt: "2026-02-18T00:00:00Z",
				transcriptEntries: 1,
				stats: { filesChanged: 1, insertions: 1, deletions: 0 },
				topics: [{ title: "Old", trigger: "T", response: "R", decisions: "D" }],
				jolliDocId: 52,
				jolliDocUrl: "https://jolli.app/articles/52",
				orphanedDocIds: [21],
				plans: [
					{
						slug: "plan-2",
						title: "Plan 2",
						editCount: 2,
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
				e2eTestGuide: [{ title: "Scenario 2", steps: ["one"], expectedResults: ["done"] }],
			});
			mockLoadAllSessions.mockResolvedValue([]);
			mockLoadConfig.mockResolvedValue({});
			// Short-circuit A fires when transcript is empty AND diff is small.
			// To exercise the LLM path here we need a non-trivial delta (>10 lines).
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 50, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("diff");

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			// With non-trivial delta, the pipeline runs step 1 (summarize) and writes the
			// new root via storeSummary. transcript artifact is undefined (no sessions),
			// so the 4th arg is omitted -- match on the prefix the test cares about.
			const calls = vi.mocked(mockStoreSummary).mock.calls;
			expect(calls.length).toBeGreaterThanOrEqual(1);
			const [root, cwdArg] = calls[0];
			expect(cwdArg).toBe("/repo");
			expect(root).toEqual(
				expect.objectContaining({
					jolliDocId: 52,
					jolliDocUrl: "https://jolli.app/articles/52",
					orphanedDocIds: [21],
					plans: [expect.objectContaining({ slug: "plan-2" })],
					e2eTestGuide: [expect.objectContaining({ title: "Scenario 2" })],
				}),
			);
		});
	});

	describe("buildStoredTranscript", () => {
		it("falls back to the session transcript path when the session metadata is missing", () => {
			const stored = __test__.buildStoredTranscript([
				{
					sessionId: "sess-1",
					transcriptPath: "/tmp/from-transcript.jsonl",
					entries: [{ role: "human", content: "hi" }],
				},
			]);

			expect(stored.sessions[0].transcriptPath).toBe("/tmp/from-transcript.jsonl");
		});
	});
});
