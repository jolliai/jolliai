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
	mockGenerateSquashConsolidation,
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
	mockGenerateSquashConsolidation: vi.fn(),
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
	// handleAmendPipeline now file-filters a legacy oldSummary's transcript IDs
	// via getTranscriptHashes → OrphanBranchStorage.listFiles. Empty listing is
	// fine here — these tests don't assert on the resulting transcripts array.
	listFilesInBranch: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/SessionTracker.js", () => ({
	associatePlanWithCommit: mockAssociatePlanWithCommit,
	associateNoteWithCommit: vi.fn(),
	associateReferenceWithCommit: vi.fn(),
	detectUncommittedReferenceIds: vi.fn().mockResolvedValue([]),
	detectActivePlansForBranch: vi.fn().mockResolvedValue([]),
	detectActiveNotesForBranch: vi.fn().mockResolvedValue([]),
	getReferenceEntriesForBranch: vi.fn().mockResolvedValue([]),
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
	saveCursor: mockSaveCursor,
	savePlansRegistry: mockSavePlansRegistry,
}));

vi.mock("../core/references/ReferenceStore.js", () => ({
	referencePath: vi.fn(
		(c: string, source: string, key: string) => `${c}/.jolli/jollimemory/references/${source}/${key}.md`,
	),
	referenceDir: vi.fn((c: string, source: string) => `${c}/.jolli/jollimemory/references/${source}`),
	sanitizeNativeIdForPath: vi.fn((_source: string, id: string) => id),
	readReferenceMarkdown: vi.fn().mockResolvedValue(null),
	readReferenceMarkdownFromString: vi.fn().mockReturnValue(null),
	writeReferenceMarkdown: vi.fn().mockResolvedValue({ sourcePath: "/x", contentHash: "fake-content-hash" }),
	renameReferenceMarkdown: vi.fn().mockResolvedValue(undefined),
	hashReferenceContent: vi.fn(() => "fake-content-hash"),
}));

vi.mock("../core/PlanPromptFormatter.js", () => ({
	formatPlansBlock: vi.fn().mockResolvedValue(""),
}));

vi.mock("../core/NotePromptFormatter.js", () => ({
	formatNotesBlock: vi.fn().mockResolvedValue(""),
}));

vi.mock("../core/Locks.js", () => ({
	acquireWorkerLock: vi.fn(async () => true),
	releaseWorkerLock: vi.fn(),
	refreshWorkerLockMtime: vi.fn(),
	isWorkerLockHeld: vi.fn(),
}));

vi.mock("../core/SummaryStore.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/SummaryStore.js")>();
	return {
		...actual,
		getSummary: mockGetSummary,
		mergeManyToOne: vi.fn(),
		storePlans: mockStorePlans,
		storeSummary: mockStoreSummary,
		storeReferences: vi.fn().mockResolvedValue(undefined),
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
		// Mock LLM-touching squash consolidation; default null (set in beforeEach)
		// forces the caller into the (real) mechanicalConsolidate fallback. Exposed
		// as a hoisted mock so tests can assert call counts per amend path.
		generateSquashConsolidation: mockGenerateSquashConsolidation,
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

vi.mock("../core/CursorDetector.js", () => ({
	isCursorInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/CursorSessionDiscoverer.js", () => ({
	discoverCursorSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/CopilotDetector.js", () => ({
	isCopilotInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/CopilotSessionDiscoverer.js", () => ({
	discoverCopilotSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/CopilotChatDetector.js", () => ({
	isCopilotChatInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/CopilotChatSessionDiscoverer.js", () => ({
	discoverCopilotChatSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/CopilotChatTranscriptReader.js", () => ({
	readCopilotChatTranscript: vi.fn(),
}));

vi.mock("../core/CursorTranscriptReader.js", () => ({
	readCursorTranscript: vi.fn(),
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
		// Default to null so Full-path tests exercise the mechanicalConsolidate fallback,
		// matching the previous inline-mock behavior. Individual tests can override.
		mockGenerateSquashConsolidation.mockResolvedValue(null);
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
					"alpha-plan": { slug: "alpha-plan", commitHash: null, ignored: false, branch: "main" },
					"beta-plan": { slug: "beta-plan", commitHash: null, ignored: false, branch: "main" },
					"committed-plan": { slug: "committed-plan", commitHash: "abc123", ignored: false, branch: "main" },
					"ignored-plan": { slug: "ignored-plan", commitHash: null, ignored: true, branch: "main" },
				},
			});

			const slugs = await __test__.detectPlanSlugsFromRegistry("/repo", "main");
			expect([...slugs].sort()).toEqual(["alpha-plan", "beta-plan"]);
		});

		it("returns empty set when all plans are committed or ignored", async () => {
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {
					done: { slug: "done", commitHash: "abc", ignored: false, branch: "main" },
					skipped: { slug: "skipped", commitHash: null, ignored: true, branch: "main" },
				},
			});

			const slugs = await __test__.detectPlanSlugsFromRegistry("/repo", "main");
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
						branch: "main",
					},
					eligible: { slug: "eligible", commitHash: null, ignored: false, branch: "main" },
				},
			});

			const slugs = await __test__.detectPlanSlugsFromRegistry("/repo", "main");
			expect([...slugs]).toEqual(["eligible"]);
		});

		// Iterative-commit revival: user edits a previously-archived plan and commits
		// again. The guard entry's contentHashAtCommit no longer matches the file,
		// and we want the new content to be re-archived into the new commit (a fresh
		// `slug-<newShortHash>` entry plus an updated guard). Before this fix the
		// detect function skipped guards outright, leaving the plan visibly "stuck"
		// in the PLANS & NOTES panel pointing at the previous commit hash.
		it("includes revived guard plans whose source file no longer matches contentHashAtCommit", async () => {
			const { createHash } = await import("node:crypto");
			const oldHash = createHash("sha256").update("v1 content\n").digest("hex");
			const liveBody = "v2 content\n";
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {
					"revived-plan": {
						slug: "revived-plan",
						title: "Revived",
						sourcePath: "/repo/plans/revived-plan.md",
						commitHash: "deadbeefdeadbeef",
						contentHashAtCommit: oldHash,
						branch: "main",
						addedAt: "x",
						updatedAt: "y",
					},
				},
			});
			mockExistsSync.mockImplementation((p: string) => p === "/repo/plans/revived-plan.md");
			mockReadFileSync.mockImplementation((p: string) => {
				if (p === "/repo/plans/revived-plan.md") return liveBody;
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			});

			const slugs = await __test__.detectPlanSlugsFromRegistry("/repo", "main");
			expect([...slugs]).toEqual(["revived-plan"]);
		});

		it("excludes guard plans whose source file still matches contentHashAtCommit", async () => {
			const { createHash } = await import("node:crypto");
			const body = "v1 content\n";
			const hash = createHash("sha256").update(body).digest("hex");
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {
					"stable-plan": {
						slug: "stable-plan",
						title: "Stable",
						sourcePath: "/repo/plans/stable-plan.md",
						commitHash: "deadbeefdeadbeef",
						contentHashAtCommit: hash,
						branch: "main",
						addedAt: "x",
						updatedAt: "y",
					},
				},
			});
			mockExistsSync.mockImplementation((p: string) => p === "/repo/plans/stable-plan.md");
			mockReadFileSync.mockImplementation((p: string) => {
				if (p === "/repo/plans/stable-plan.md") return body;
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			});

			const slugs = await __test__.detectPlanSlugsFromRegistry("/repo", "main");
			expect(slugs.size).toBe(0);
		});

		it("excludes guard plans whose source file is missing on disk", async () => {
			// Source gone → panel already hides via the "file missing" branch in
			// toPlanInfo; we don't want to surface it as "uncommitted" and try to
			// re-archive a file we can't read.
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {
					"gone-plan": {
						slug: "gone-plan",
						title: "Gone",
						sourcePath: "/repo/plans/gone-plan.md",
						commitHash: "deadbeefdeadbeef",
						contentHashAtCommit: "anything",
						branch: "main",
						addedAt: "x",
						updatedAt: "y",
					},
				},
			});
			mockExistsSync.mockReturnValue(false);

			const slugs = await __test__.detectPlanSlugsFromRegistry("/repo", "main");
			expect(slugs.size).toBe(0);
		});

		it("excludes uncommitted plans whose branch differs from the target branch", async () => {
			// Regression guard for the cross-branch leak: before adding the branch
			// filter, plans on `feature/summarize-include-linear-issues` were being
			// associated with a commit on `feature/linear-issues-as-panel-item`,
			// polluting the orphan branch under the wrong branch directory and
			// generating phantom plan refs on the wrong commit's summary.
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {
					"current-branch": {
						slug: "current-branch",
						commitHash: null,
						ignored: false,
						branch: "feature/active",
					},
					"other-branch": {
						slug: "other-branch",
						commitHash: null,
						ignored: false,
						branch: "feature/idle",
					},
				},
			});

			const slugs = await __test__.detectPlanSlugsFromRegistry("/repo", "feature/active");
			expect([...slugs]).toEqual(["current-branch"]);
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
					},
					missing: {
						slug: "missing",
						title: "Missing",
						sourcePath: "/mock-home/.claude/plans/missing.md",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
						branch: "feature/test",
						commitHash: null,
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
						},
					},
				});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("plain plan content");

			const result = await __test__.associatePlansWithCommit(new Set(["sluggy"]), "deadbeefcafebabe", "/repo");

			expect(result.refs[0].title).toBe("sluggy");
		});

		it("reads the source file from entry.sourcePath for external plan paths (C2 regression)", async () => {
			// Guards the switch from `join(plansDir, slug + ".md")` to
			// `entry.sourcePath`. Old logic computed a synthetic ~/.claude/plans/
			// path; external plans (e.g. docs/foo.md) lived outside that dir and
			// would have failed existsSync silently. The new logic must read
			// directly from the registry's sourcePath.
			const externalPath = "/repo/docs/external-plan.md";
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {
					external: {
						slug: "external",
						title: "External",
						sourcePath: externalPath,
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
						branch: "feature/test",
						commitHash: null,
					},
				},
			});
			mockExistsSync.mockImplementation((p: string) => p === externalPath);
			mockReadFileSync.mockImplementation((p: string) => (p === externalPath ? "# External\nbody" : ""));

			const result = await __test__.associatePlansWithCommit(new Set(["external"]), "deadbeefcafebabe", "/repo");

			expect(result.refs[0].slug).toBe("external-deadbeef");
			expect(mockStorePlans).toHaveBeenCalledWith(
				[{ slug: "external-deadbeef", content: "# External\nbody" }],
				expect.stringContaining("deadbeef"),
				"/repo",
				undefined,
			);
		});
	});

	describe("associateLinearIssuesWithCommit (near-write reread merge)", () => {
		// Regression intent: the prior implementation re-read the registry
		// near the save but then wrote `linearIssues: updatedLinearIssues` —
		// overwriting the entire field with the stale map. The fix in
		// QueueWorker.ts merges entry-by-entry against the freshly-read
		// linearIssues map instead. Code: ~line 795.
		//
		// Unit-testing this branch in isolation requires standing up the full
		// storeReferences → ensureOrphanBranch → GitOps mock stack which
		// isn't worth the test surface area today. The behavior is covered by
		// the live integration path (the rebase data-loss we just witnessed
		// is the symptom and is reproducible by replaying any
		// associateLinearIssuesWithCommit under contention).
		it.todo("preserves concurrent linearIssues entries added between the initial load and the save");
	});

	describe("executePipeline", () => {
		it("stores plan references on the summary when transcript slug detection finds a plan", async () => {
			// Align the current-branch mock with the plan's branch so the
			// branch-filtered detectPlanSlugsFromRegistry picks it up. Without
			// this override the default "main" from beforeEach would suppress
			// the plan and silently drop the assertion target.
			mockGetCurrentBranch.mockResolvedValue("feature/test");
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
							sourcePath: planPath,
							addedAt: "2026-02-18T00:00:00Z",
							updatedAt: "2026-02-18T00:00:00Z",
							branch: "feature/test",
							commitHash: null,
						},
					},
				})
				.mockResolvedValueOnce({
					version: 1,
					plans: {
						sluggy: {
							slug: "sluggy",
							title: "Sluggy",
							sourcePath: planPath,
							addedAt: "2026-02-18T00:00:00Z",
							updatedAt: "2026-02-18T00:00:00Z",
							branch: "feature/test",
							commitHash: null,
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
			// Match the plan's branch (see sibling test rationale above).
			mockGetCurrentBranch.mockResolvedValue("feature/test");
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

			// Helper now passes (root, cwd, false, transcriptArtifact?) — match prefix only.
			expect(mockStoreSummary.mock.calls.length).toBeGreaterThanOrEqual(1);
			const [hoistedRoot, hoistedCwd] = mockStoreSummary.mock.calls[0];
			expect(hoistedCwd).toBe("/repo");
			expect(hoistedRoot).toEqual(
				expect.objectContaining({
					jolliDocId: 42,
					jolliDocUrl: "https://jolli.app/articles/42",
					orphanedDocIds: [10, 11],
					plans: [expect.objectContaining({ slug: "plan-1" })],
					e2eTestGuide: [expect.objectContaining({ title: "Scenario" })],
				}),
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
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
				e2eTestGuide: [{ title: "Scenario 2", steps: ["one"], expectedResults: ["done"] }],
			});
			mockLoadAllSessions.mockResolvedValue([]);
			mockLoadConfig.mockResolvedValue({});
			// Pre-LLM short-circuit fires when diff is small (≤ TRIVIAL_AMEND_DELTA_LINES = 50).
			// To exercise the LLM path here we need a non-trivial delta (> 50 lines).
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 100, deletions: 0 });
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

		// ── Two-tier amend dispatch coverage ──────────────────────────────────────
		// These tests pin the LLM call count of each branch so a regression that
		// silently demotes the pre-LLM / post-LLM short-circuit into the Full
		// path (and burns LLM tokens on a trivial amend) is caught at test time.
		// The 15/16-line boundary and the "transcript entries still short-circuits"
		// case are both exercised.

		const oldSummaryFixture = {
			version: 4 as const,
			commitHash: "oldhash",
			commitMessage: "Old commit",
			commitAuthor: "Test",
			commitDate: "2026-02-18T00:00:00Z",
			branch: "main",
			generatedAt: "2026-02-18T00:00:00Z",
			topics: [{ title: "Old topic", trigger: "T", response: "R", decisions: "D" }],
			recap: "old recap",
		};

		it("Pre-LLM short-circuit (0 LLM): trivial delta with no sessions skips both LLM steps", async () => {
			mockGetSummary.mockResolvedValue(oldSummaryFixture);
			mockLoadAllSessions.mockResolvedValue([]);
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 5, deletions: 3 });
			mockGetDiffContent.mockResolvedValue("diff");

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSummary).not.toHaveBeenCalled();
			expect(mockGenerateSquashConsolidation).not.toHaveBeenCalled();

			expect(mockStoreSummary.mock.calls.length).toBeGreaterThanOrEqual(1);
			const root = mockStoreSummary.mock.calls[0][0] as {
				topics: ReadonlyArray<{ title: string }>;
				recap?: string;
				llm?: unknown;
			};
			expect(root.topics).toEqual([{ title: "Old topic", trigger: "T", response: "R", decisions: "D" }]);
			expect(root.recap).toBe("old recap");
			expect(root.llm).toBeUndefined();
		});

		it("Pre-LLM short-circuit boundary: exactly 50 insertions+deletions still short-circuits", async () => {
			mockGetSummary.mockResolvedValue(oldSummaryFixture);
			mockLoadAllSessions.mockResolvedValue([]);
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 25, deletions: 25 });
			mockGetDiffContent.mockResolvedValue("diff");

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSummary).not.toHaveBeenCalled();
			expect(mockGenerateSquashConsolidation).not.toHaveBeenCalled();
		});

		it("Pre-LLM escape: 51 insertions+deletions falls through to LLM pipeline", async () => {
			mockGetSummary.mockResolvedValue(oldSummaryFixture);
			mockLoadAllSessions.mockResolvedValue([]);
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 26, deletions: 25 });
			mockGetDiffContent.mockResolvedValue("diff");

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
		});

		it("Pre-LLM short-circuit triggers even WITH transcript entries when delta ≤ 50 lines", async () => {
			mockGetSummary.mockResolvedValue(oldSummaryFixture);
			// 有 1 个 session 带 2 条 entries —— 旧逻辑会强制走 Full path，新逻辑应仍短路
			mockLoadAllSessions.mockResolvedValue([
				{
					sessionId: "sess-1",
					transcriptPath: "/tmp/s.jsonl",
					source: "claude",
					updatedAt: "2026-02-19T00:00:00Z",
				},
			]);
			mockReadTranscript.mockResolvedValue({
				entries: [
					{ role: "human", content: "hi" },
					{ role: "assistant", content: "hello" },
				],
				newCursor: { transcriptPath: "/tmp/s.jsonl", lineNumber: 2, updatedAt: "2026-02-19T00:00:00Z" },
				totalLinesRead: 2,
			});
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 5, deletions: 3 });
			mockGetDiffContent.mockResolvedValue("diff");

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSummary).not.toHaveBeenCalled();
			expect(mockGenerateSquashConsolidation).not.toHaveBeenCalled();

			// 短路路径也必须把 transcript artifact 传给 storeSummary
			expect(mockStoreSummary.mock.calls.length).toBeGreaterThanOrEqual(1);
			const storeArgs = mockStoreSummary.mock.calls[0];
			// Pin the force flag at position 2 — short-circuit must never overwrite
			// existing summaries (that's a Full-pipeline force semantic, not amend).
			expect(storeArgs[2]).toBe(false);
			// v5 artifact shape: `{ transcript: { id, data: { sessions: [...] } } }`.
			// `id` is the new transcript-ID minted by generateTranscriptId() that
			// also lands in `summary.transcripts`.
			const artifacts = storeArgs[3] as
				| { transcript?: { id: string; data: { sessions: ReadonlyArray<unknown> } } }
				| undefined;
			expect(artifacts?.transcript).toBeDefined();
			expect(typeof artifacts?.transcript?.id).toBe("string");
			expect(artifacts?.transcript?.data.sessions.length).toBeGreaterThanOrEqual(1);
		});

		it("Post-LLM short-circuit (1 LLM): non-trivial delta with empty topics skips step 2", async () => {
			mockGetSummary.mockResolvedValue(oldSummaryFixture);
			mockLoadAllSessions.mockResolvedValue([]);
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 100, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("diff");
			// Step 1 returns no topics → triggers post-LLM short-circuit
			mockGenerateSummary.mockResolvedValueOnce({
				transcriptEntries: 0,
				llm: { model: "test", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: "end_turn" },
				stats: { filesChanged: 1, insertions: 100, deletions: 0 },
				topics: [],
			});

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
			expect(mockGenerateSquashConsolidation).not.toHaveBeenCalled();

			expect(mockStoreSummary.mock.calls.length).toBeGreaterThanOrEqual(1);
			const root = mockStoreSummary.mock.calls[0][0] as {
				topics: ReadonlyArray<{ title: string }>;
				recap?: string;
				llm?: unknown;
			};
			expect(root.topics).toEqual([{ title: "Old topic", trigger: "T", response: "R", decisions: "D" }]);
			expect(root.recap).toBe("old recap");
			expect(root.llm).toBeUndefined();
		});

		it("No old summary + small diff + transcript entries: still writes fresh leaf with transcript artifact", async () => {
			// Edge case: user amends a commit that was never summarised (e.g. pre-install
			// commit, or summary not yet generated by the previous worker) AND has a small
			// diff (≤50 lines) AND had an active AI conversation during the amend.
			// The early return at "if (!oldSummary && ...)" must NOT fire when there are
			// transcript entries — otherwise the conversation bytes are lost. The fix is
			// to require `totalEntries === 0` in that early-return guard, so this case
			// falls through to step1 LLM and the fresh-leaf branch (which writes the
			// transcript artifact).
			mockGetSummary.mockResolvedValue(null);
			mockLoadAllSessions.mockResolvedValue([
				{
					sessionId: "sess-1",
					transcriptPath: "/tmp/s.jsonl",
					source: "claude",
					updatedAt: "2026-02-19T00:00:00Z",
				},
			]);
			mockReadTranscript.mockResolvedValue({
				entries: [
					{ role: "human", content: "explain this code" },
					{ role: "assistant", content: "here's an explanation" },
				],
				newCursor: { transcriptPath: "/tmp/s.jsonl", lineNumber: 2, updatedAt: "2026-02-19T00:00:00Z" },
				totalLinesRead: 2,
			});
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 5, deletions: 3 });
			mockGetDiffContent.mockResolvedValue("diff");

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			// step1 LLM ran (fresh leaf path needs delta topics/recap)
			expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
			// Fresh leaf was written WITH the transcript artifact — the conversation
			// must not be silently dropped.
			expect(mockStoreSummary.mock.calls.length).toBeGreaterThanOrEqual(1);
			const storeArgs = mockStoreSummary.mock.calls[0];
			// v5 artifact shape: `{ transcript: { id, data: { sessions: [...] } } }`.
			const artifacts = storeArgs[3] as
				| { transcript?: { id: string; data: { sessions: ReadonlyArray<unknown> } } }
				| undefined;
			expect(artifacts?.transcript).toBeDefined();
			expect(typeof artifacts?.transcript?.id).toBe("string");
			expect(artifacts?.transcript?.data.sessions.length).toBeGreaterThanOrEqual(1);
		});

		it("No old summary + diff fetch failure: skips entirely, no LLM call, no garbage summary", async () => {
			// Edge case: getDiffContent / getDiffStats throw (shallow clone where HEAD~1
			// doesn't resolve, corrupted repo, etc.) AND there's no oldSummary to fall
			// back on. The previous code would fall through to step1 LLM with the literal
			// "(Could not compute diff)" string and persist a low-quality fresh leaf.
			// Better: skip — we have no diff and no parent context, nothing useful to
			// summarise. The conversation transcript is also not persisted in this case
			// because there's nowhere meaningful to attach it.
			mockGetSummary.mockResolvedValue(null);
			mockLoadAllSessions.mockResolvedValue([]);
			mockGetDiffStats.mockRejectedValue(new Error("git diff failed"));
			mockGetDiffContent.mockRejectedValue(new Error("git diff failed"));

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSummary).not.toHaveBeenCalled();
			expect(mockGenerateSquashConsolidation).not.toHaveBeenCalled();
			expect(mockStoreSummary).not.toHaveBeenCalled();
		});

		it("Post-LLM short-circuit: step1 returns empty topics but non-empty recap → still skip step2", async () => {
			mockGetSummary.mockResolvedValue(oldSummaryFixture);
			mockLoadAllSessions.mockResolvedValue([]);
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 100, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("diff");
			// step1: topics 空 但 recap 非空 —— 旧逻辑进 Full path，新逻辑直接短路、丢弃 delta.recap
			mockGenerateSummary.mockResolvedValueOnce({
				transcriptEntries: 0,
				llm: { model: "test", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: "end_turn" },
				stats: { filesChanged: 1, insertions: 100, deletions: 0 },
				topics: [],
				recap: "delta 复述了 diff —— 应被丢弃",
			});

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
			expect(mockGenerateSquashConsolidation).not.toHaveBeenCalled();

			const root = mockStoreSummary.mock.calls[0][0] as {
				topics: ReadonlyArray<{ title: string }>;
				recap?: string;
			};
			// recap 应是 oldSummaryFixture.recap，不是 delta 的 recap
			expect(root.recap).toBe("old recap");
		});

		it("Full path (2 LLM): non-trivial delta with substantive content runs step 1 + step 2", async () => {
			mockGetSummary.mockResolvedValue(oldSummaryFixture);
			mockLoadAllSessions.mockResolvedValue([]);
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 100, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("diff");
			// Step 1 default (from beforeEach) returns a topic → bypasses post-LLM short-circuit.
			// Step 2 returns consolidated content with LLM metadata.
			mockGenerateSquashConsolidation.mockResolvedValueOnce({
				status: "ok",
				topics: [{ title: "Consolidated", trigger: "T", response: "R", decisions: "D" }],
				recap: "consolidated recap",
				llm: { model: "test", inputTokens: 10, outputTokens: 10, apiLatencyMs: 50, stopReason: "end_turn" },
			});

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
			expect(mockGenerateSquashConsolidation).toHaveBeenCalledTimes(1);

			expect(mockStoreSummary.mock.calls.length).toBeGreaterThanOrEqual(1);
			const root = mockStoreSummary.mock.calls[0][0] as {
				topics: ReadonlyArray<{ title: string }>;
				recap?: string;
				llm?: unknown;
			};
			expect(root.topics).toEqual([{ title: "Consolidated", trigger: "T", response: "R", decisions: "D" }]);
			expect(root.recap).toBe("consolidated recap");
			expect(root.llm).toBeDefined();
		});

		it("step-1 LLM failure with oldSummary Copy-Hoists topics and marks summaryError", async () => {
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
				topics: [{ title: "Old kept", trigger: "T", response: "R", decisions: "D" }],
				recap: "old recap",
			});
			mockLoadAllSessions.mockResolvedValue([]);
			mockLoadConfig.mockResolvedValue({});
			// Non-trivial delta so the pre-LLM short-circuit doesn't fire.
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 100, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("diff");
			mockGenerateSummary
				.mockRejectedValueOnce(new Error("403 boom"))
				.mockRejectedValueOnce(new Error("403 boom again"));

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSummary).toHaveBeenCalledTimes(2);
			expect(mockStoreSummary).toHaveBeenCalledTimes(1);
			const stored = mockStoreSummary.mock.calls[0][0] as {
				topics: ReadonlyArray<{ title: string }>;
				summaryError?: string;
			};
			expect(stored.topics).toEqual([{ title: "Old kept", trigger: "T", response: "R", decisions: "D" }]);
			expect(stored.summaryError).toBe("llm-failed");
		});

		it("step-1 LLM failure without oldSummary stores fresh leaf with empty topics + summaryError", async () => {
			mockGetSummary.mockResolvedValue(null);
			mockLoadAllSessions.mockResolvedValue([]);
			mockLoadConfig.mockResolvedValue({});
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 100, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("diff");
			mockGenerateSummary
				.mockRejectedValueOnce(new Error("network boom"))
				.mockRejectedValueOnce(new Error("network boom again"));

			await __test__.handleAmendPipeline(
				{ hash: "freshhash", message: "First amend", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSummary).toHaveBeenCalledTimes(2);
			expect(mockStoreSummary).toHaveBeenCalledTimes(1);
			const stored = mockStoreSummary.mock.calls[0][0] as {
				topics: ReadonlyArray<unknown>;
				summaryError?: string;
			};
			expect(stored.topics).toEqual([]);
			expect(stored.summaryError).toBe("llm-failed");
		});

		it("step-2 (consolidate) llm-error marks the amend root with summaryError", async () => {
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
			});
			mockLoadAllSessions.mockResolvedValue([]);
			mockLoadConfig.mockResolvedValue({});
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 100, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("diff");
			// Step 1 default (from beforeEach) returns a topic → bypasses post-LLM short-circuit.
			// Step 2 returns llm-error → mechanical fallback + summaryError marker.
			mockGenerateSquashConsolidation.mockResolvedValueOnce({ status: "llm-error" });

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSquashConsolidation).toHaveBeenCalledTimes(1);
			expect(mockStoreSummary).toHaveBeenCalledTimes(1);
			const stored = mockStoreSummary.mock.calls[0][0] as {
				topics: ReadonlyArray<unknown>;
				summaryError?: string;
			};
			expect(stored.topics.length).toBeGreaterThan(0); // mechanical preserved content
			expect(stored.summaryError).toBe("llm-failed");
		});

		it("step-2 (consolidate) no-content falls back to mechanical WITHOUT summaryError marker", async () => {
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
			});
			mockLoadAllSessions.mockResolvedValue([]);
			mockLoadConfig.mockResolvedValue({});
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 100, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("diff");
			mockGenerateSquashConsolidation.mockResolvedValueOnce({ status: "no-content" });

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockStoreSummary).toHaveBeenCalledTimes(1);
			const stored = mockStoreSummary.mock.calls[0][0] as {
				summaryError?: string;
			};
			expect(stored.summaryError).toBeUndefined();
		});

		it("full-path consolidate success inherits summaryError when oldSummary was degraded", async () => {
			// Source-state inheritance: step-2 consolidate merges existing topic
			// structures, it does NOT re-derive from raw diff + transcript like
			// Regenerator does. If oldSummary was a placeholder / Copy-Hoist /
			// mechanical merge from a prior failure, the consolidated output is
			// "delta + degraded old", not "regenerated". Only Regenerator should
			// clear the marker.
			mockGetSummary.mockResolvedValue({
				version: 3,
				commitHash: "oldhash",
				commitMessage: "Old commit (previously failed)",
				commitAuthor: "Test",
				commitDate: "2026-02-18T00:00:00Z",
				branch: "main",
				generatedAt: "2026-02-18T00:00:00Z",
				transcriptEntries: 1,
				stats: { filesChanged: 1, insertions: 1, deletions: 0 },
				topics: [{ title: "Placeholder", trigger: "T", response: "R", decisions: "D" }],
				summaryError: "llm-failed",
			});
			mockLoadAllSessions.mockResolvedValue([]);
			mockLoadConfig.mockResolvedValue({});
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 100, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("diff");
			// step-2 succeeds → would clear marker WITHOUT the inheritance fix.
			mockGenerateSquashConsolidation.mockResolvedValueOnce({
				status: "ok",
				topics: [{ title: "Consolidated", trigger: "T", response: "R", decisions: "D" }],
				recap: "consolidated recap",
				llm: { model: "x", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: "end_turn" },
			});

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockStoreSummary).toHaveBeenCalledTimes(1);
			const stored = mockStoreSummary.mock.calls[0][0] as {
				topics: ReadonlyArray<{ title: string }>;
				summaryError?: string;
			};
			expect(stored.topics).toEqual([{ title: "Consolidated", trigger: "T", response: "R", decisions: "D" }]);
			expect(stored.summaryError).toBe("llm-failed");
		});

		it("full-path consolidate success leaves no marker when oldSummary was healthy", async () => {
			// Regression guard for the inherited-marker fix above — a clean
			// amend on a clean parent must stay clean.
			mockGetSummary.mockResolvedValue({
				version: 3,
				commitHash: "oldhash",
				commitMessage: "Healthy old",
				commitAuthor: "Test",
				commitDate: "2026-02-18T00:00:00Z",
				branch: "main",
				generatedAt: "2026-02-18T00:00:00Z",
				transcriptEntries: 1,
				stats: { filesChanged: 1, insertions: 1, deletions: 0 },
				topics: [{ title: "Old", trigger: "T", response: "R", decisions: "D" }],
			});
			mockLoadAllSessions.mockResolvedValue([]);
			mockLoadConfig.mockResolvedValue({});
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 100, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("diff");
			mockGenerateSquashConsolidation.mockResolvedValueOnce({
				status: "ok",
				topics: [{ title: "Consolidated", trigger: "T", response: "R", decisions: "D" }],
				llm: { model: "x", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: "end_turn" },
			});

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "New commit", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockStoreSummary).toHaveBeenCalledTimes(1);
			const stored = mockStoreSummary.mock.calls[0][0] as {
				summaryError?: string;
			};
			expect(stored.summaryError).toBeUndefined();
		});

		it("pre-LLM trivial delta inherits summaryError from oldSummary (no Regenerate yet)", async () => {
			// A previously-failed amend wrote summaryError="llm-failed". A subsequent
			// trivial-delta amend (≤ TRIVIAL_AMEND_DELTA_LINES) short-circuits without
			// calling the LLM — the marker must persist so the banner stays visible.
			// Only a successful Regenerate should clear it.
			mockGetSummary.mockResolvedValue({
				version: 4,
				commitHash: "oldhash",
				commitMessage: "Old commit (previously failed)",
				commitAuthor: "Test",
				commitDate: "2026-02-18T00:00:00Z",
				branch: "main",
				generatedAt: "2026-02-18T00:00:00Z",
				transcriptEntries: 0,
				diffStats: { filesChanged: 1, insertions: 1, deletions: 0 },
				topics: [{ title: "Old", trigger: "T", response: "R", decisions: "D" }],
				summaryError: "llm-failed",
			});
			mockLoadAllSessions.mockResolvedValue([]);
			mockLoadConfig.mockResolvedValue({});
			// Trivial delta (1 line) triggers the pre-LLM short-circuit.
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 1, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("trivial diff");

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "Typo fix", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			// LLM must NOT have been called (pre-LLM short-circuit).
			expect(mockGenerateSummary).not.toHaveBeenCalled();
			expect(mockStoreSummary).toHaveBeenCalledTimes(1);
			const stored = mockStoreSummary.mock.calls[0][0] as {
				summaryError?: string;
			};
			expect(stored.summaryError).toBe("llm-failed");
		});

		it("post-LLM empty-topics short-circuit inherits summaryError from oldSummary", async () => {
			// step-1 LLM succeeded but returned no topics (genuine "nothing new" case);
			// step-2 is skipped. If oldSummary carried a marker from an earlier failure,
			// the new root must keep it — step-2 was not run, so the failure is still
			// unresolved.
			mockGetSummary.mockResolvedValue({
				version: 4,
				commitHash: "oldhash",
				commitMessage: "Old commit (previously failed)",
				commitAuthor: "Test",
				commitDate: "2026-02-18T00:00:00Z",
				branch: "main",
				generatedAt: "2026-02-18T00:00:00Z",
				transcriptEntries: 0,
				diffStats: { filesChanged: 1, insertions: 1, deletions: 0 },
				topics: [{ title: "Old", trigger: "T", response: "R", decisions: "D" }],
				summaryError: "llm-failed",
			});
			mockLoadAllSessions.mockResolvedValue([]);
			mockLoadConfig.mockResolvedValue({});
			// Non-trivial delta so pre-LLM short-circuit doesn't fire.
			mockGetDiffStats.mockResolvedValue({ filesChanged: 1, insertions: 100, deletions: 0 });
			mockGetDiffContent.mockResolvedValue("diff");
			// step-1 succeeds with empty topics → post-LLM short-circuit, deltaLlmFailed=false.
			mockGenerateSummary.mockResolvedValueOnce({
				transcriptEntries: 0,
				conversationTurns: 0,
				llm: { model: "test", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: "end_turn" },
				stats: { filesChanged: 1, insertions: 100, deletions: 0 },
				topics: [],
			});

			await __test__.handleAmendPipeline(
				{ hash: "newhash", message: "Refactor", author: "Test", date: "2026-02-19T00:00:00Z" },
				"oldhash",
				"/repo",
				0,
			);

			expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
			// step-2 (generateSquashConsolidation) NOT called — short-circuit fired.
			expect(mockGenerateSquashConsolidation).not.toHaveBeenCalled();
			expect(mockStoreSummary).toHaveBeenCalledTimes(1);
			const stored = mockStoreSummary.mock.calls[0][0] as {
				summaryError?: string;
			};
			expect(stored.summaryError).toBe("llm-failed");
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
