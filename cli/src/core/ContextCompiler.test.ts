import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, SummaryIndex } from "../Types.js";
import {
	buildRecallPayload,
	type CompiledContext,
	compileTaskContext,
	estimateTokens,
	listBranchCatalog,
	renderContextMarkdown,
} from "./ContextCompiler.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("./SummaryStore.js", () => ({
	getIndex: vi.fn(),
	getSummary: vi.fn(),
	getCatalogWithLazyBuild: vi.fn(async () => ({ version: 1, entries: [] })),
	readPlanFromBranch: vi.fn(),
	readNoteFromBranch: vi.fn(),
	readTranscript: vi.fn(),
}));

import {
	getCatalogWithLazyBuild,
	getIndex,
	getSummary,
	readNoteFromBranch,
	readPlanFromBranch,
} from "./SummaryStore.js";

const mockGetIndex = vi.mocked(getIndex);
const mockGetSummary = vi.mocked(getSummary);
const mockGetCatalog = vi.mocked(getCatalogWithLazyBuild);
const mockReadPlan = vi.mocked(readPlanFromBranch);
const mockReadNote = vi.mocked(readNoteFromBranch);

// ─── Test data helpers ───────────────────────────────────────────────────────

function makeSummary(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 3,
		commitHash: "abc12345def67890",
		commitMessage: "Add feature X",
		commitAuthor: "dev",
		commitDate: "2026-03-28T10:00:00.000Z",
		branch: "feature/test",
		generatedAt: "2026-03-28T10:01:00.000Z",
		stats: { filesChanged: 3, insertions: 100, deletions: 20 },
		topics: [
			{
				title: "Feature X implementation",
				trigger: "Need feature X",
				response: "Implemented feature X with new module",
				decisions: "Used factory pattern for extensibility",
				category: "feature",
				importance: "major",
				filesAffected: ["src/featureX.ts", "src/factory.ts"],
			},
		],
		...overrides,
	};
}

function makeIndex(entries: SummaryIndex["entries"]): SummaryIndex {
	return { version: 3, entries };
}

// ─── estimateTokens ──────────────────────────────────────────────────────────

describe("estimateTokens", () => {
	it("should estimate ASCII text at ~0.25 tokens/char", () => {
		const text = "Hello world, this is a test.";
		const tokens = estimateTokens(text);
		expect(tokens).toBe(Math.ceil(text.length * 0.25));
	});

	it("should estimate CJK text at ~1.5 tokens/char", () => {
		const text = "这是中文测试";
		const tokens = estimateTokens(text);
		expect(tokens).toBe(Math.ceil(6 * 1.5));
	});

	it("should handle mixed CJK and ASCII", () => {
		const text = "Hello 世界";
		// 6 ASCII chars (incl space) + 2 CJK chars
		const expected = Math.ceil(6 * 0.25 + 2 * 1.5);
		expect(estimateTokens(text)).toBe(expected);
	});

	it("should return 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});
});

// ─── listBranchCatalog ───────────────────────────────────────────────────────

describe("listBranchCatalog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: empty catalog so existing tests aren't influenced by topicTitles enrichment.
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
	});

	it("should return empty catalog when no index", async () => {
		mockGetIndex.mockResolvedValue(null);
		const catalog = await listBranchCatalog("/test");
		expect(catalog.type).toBe("catalog");
		expect(catalog.branches).toHaveLength(0);
	});

	it("should group entries by branch and sort by most recent", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First commit",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/auth",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second commit",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/auth",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
				{
					commitHash: "ccc",
					parentCommitHash: null,
					commitMessage: "Fix bug",
					commitDate: "2026-04-01T10:00:00.000Z",
					branch: "fix/bug-123",
					generatedAt: "2026-04-01T10:01:00.000Z",
				},
			]),
		);

		const catalog = await listBranchCatalog("/test");
		expect(catalog.branches).toHaveLength(2);
		// fix/bug-123 is more recent, should be first
		expect(catalog.branches[0].branch).toBe("fix/bug-123");
		expect(catalog.branches[0].commitCount).toBe(1);
		expect(catalog.branches[1].branch).toBe("feature/auth");
		expect(catalog.branches[1].commitCount).toBe(2);
		expect(catalog.branches[1].commitMessages).toEqual(["First commit", "Second commit"]);
	});

	it("should exclude child entries (parentCommitHash != null)", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "root",
					parentCommitHash: null,
					commitMessage: "Root commit",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/x",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "child",
					parentCommitHash: "root",
					commitMessage: "Child (should be excluded)",
					commitDate: "2026-03-27T10:00:00.000Z",
					branch: "feature/x",
					generatedAt: "2026-03-27T10:01:00.000Z",
				},
			]),
		);

		const catalog = await listBranchCatalog("/test");
		expect(catalog.branches).toHaveLength(1);
		expect(catalog.branches[0].commitCount).toBe(1);
		expect(catalog.branches[0].commitMessages).toEqual(["Root commit"]);
	});

	it("aggregates and dedupes topicTitles from catalog.json", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "h1",
					parentCommitHash: null,
					commitMessage: "msg",
					commitDate: "2026-04-01T10:00:00.000Z",
					branch: "feature/auth",
					generatedAt: "2026-04-01T10:01:00.000Z",
				},
				{
					commitHash: "h2",
					parentCommitHash: null,
					commitMessage: "msg2",
					commitDate: "2026-04-02T10:00:00.000Z",
					branch: "feature/auth",
					generatedAt: "2026-04-02T10:01:00.000Z",
				},
			]),
		);
		mockGetCatalog.mockResolvedValue({
			version: 1,
			entries: [
				{ commitHash: "h1", topics: [{ title: "JWT decision" }, { title: "shared" }] },
				{ commitHash: "h2", topics: [{ title: "Middleware" }, { title: "shared" }] },
			],
		});
		const catalog = await listBranchCatalog("/test");
		expect(catalog.branches).toHaveLength(1);
		expect(catalog.branches[0].topicTitles).toEqual(["JWT decision", "shared", "Middleware"]);
	});

	it("filters out empty topic titles when enriching", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "h1",
					parentCommitHash: null,
					commitMessage: "msg",
					commitDate: "2026-04-01T10:00:00.000Z",
					branch: "x",
					generatedAt: "2026-04-01T10:01:00.000Z",
				},
			]),
		);
		mockGetCatalog.mockResolvedValue({
			version: 1,
			entries: [{ commitHash: "h1", topics: [{ title: "" }, { title: "real" }] }],
		});
		const catalog = await listBranchCatalog("/test");
		expect(catalog.branches[0].topicTitles).toEqual(["real"]);
	});

	it("omits topicTitles entirely when no catalog entry contributes any", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "h1",
					parentCommitHash: null,
					commitMessage: "msg",
					commitDate: "2026-04-01T10:00:00.000Z",
					branch: "x",
					generatedAt: "2026-04-01T10:01:00.000Z",
				},
			]),
		);
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
		const catalog = await listBranchCatalog("/test");
		expect(catalog.branches[0].topicTitles).toBeUndefined();
	});
});

// ─── compileTaskContext ──────────────────────────────────────────────────────

describe("compileTaskContext", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should return empty context when no index", async () => {
		mockGetIndex.mockResolvedValue(null);
		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.commitCount).toBe(0);
		expect(ctx.summaries).toHaveLength(0);
	});

	it("should return empty context when branch has no records", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Other branch",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/other",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.commitCount).toBe(0);
	});

	it("should compile context with summaries and decisions", async () => {
		const summary = makeSummary();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "abc12345def67890",
					parentCommitHash: null,
					commitMessage: "Add feature X",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(summary);

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.commitCount).toBe(1);
		expect(ctx.summaries).toHaveLength(1);
		expect(ctx.keyDecisions).toHaveLength(1);
		expect(ctx.keyDecisions[0].text).toBe("Used factory pattern for extensibility");
		expect(ctx.totalFilesChanged).toBe(3);
		expect(ctx.totalInsertions).toBe(100);
		expect(ctx.totalDeletions).toBe(20);
	});

	it("should apply depth limit (keep most recent)", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "old",
					parentCommitHash: null,
					commitMessage: "Old commit",
					commitDate: "2026-03-26T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-26T10:01:00.000Z",
				},
				{
					commitHash: "mid",
					parentCommitHash: null,
					commitMessage: "Mid commit",
					commitDate: "2026-03-27T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-27T10:01:00.000Z",
				},
				{
					commitHash: "new",
					parentCommitHash: null,
					commitMessage: "New commit",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(makeSummary());

		await compileTaskContext({ branch: "feature/test", depth: 2 }, "/test");
		// Should only load 2 most recent
		expect(mockGetSummary).toHaveBeenCalledTimes(2);
	});

	it("should deduplicate plans by base slug", async () => {
		const summaryWithPlan1 = makeSummary({
			commitHash: "aaa11111",
			commitDate: "2026-03-28T10:00:00.000Z",
			generatedAt: "2026-03-28T10:01:00.000Z",
			plans: [
				{
					slug: "oauth-strategy-aaa11111",
					title: "OAuth Strategy",
					editCount: 1,
					addedAt: "2026-03-28T10:00:00.000Z",
					updatedAt: "2026-03-28T10:00:00.000Z",
				},
			],
		});
		const summaryWithPlan2 = makeSummary({
			commitHash: "bbb22222",
			commitDate: "2026-03-29T10:00:00.000Z",
			generatedAt: "2026-03-29T10:01:00.000Z",
			plans: [
				{
					slug: "oauth-strategy-bbb22222",
					title: "OAuth Strategy v2",
					editCount: 2,
					addedAt: "2026-03-28T10:00:00.000Z",
					updatedAt: "2026-03-29T10:00:00.000Z",
				},
			],
		});

		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa11111",
					parentCommitHash: null,
					commitMessage: "c1",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb22222",
					parentCommitHash: null,
					commitMessage: "c2",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValueOnce(summaryWithPlan1).mockResolvedValueOnce(summaryWithPlan2);
		mockReadPlan.mockResolvedValue("# Plan content");

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		// Should only have 1 plan (deduplicated, keeping the newer one)
		expect(ctx.plans).toHaveLength(1);
		expect(ctx.plans[0].title).toBe("OAuth Strategy v2");
	});

	it("should deduplicate notes that appear in multiple summaries", async () => {
		const sharedNoteRef = {
			id: "note-abc-1234abcd",
			title: "Shared Note",
			format: "snippet" as const,
			content: "Note content here",
			addedAt: "2026-03-28T10:00:00.000Z",
			updatedAt: "2026-03-28T10:00:00.000Z",
		};
		const summaryWithNote1 = makeSummary({
			commitHash: "aaa11111",
			commitDate: "2026-03-28T10:00:00.000Z",
			notes: [sharedNoteRef],
		});
		const summaryWithNote2 = makeSummary({
			commitHash: "bbb22222",
			commitDate: "2026-03-29T10:00:00.000Z",
			notes: [sharedNoteRef],
		});

		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa11111",
					parentCommitHash: null,
					commitMessage: "c1",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb22222",
					parentCommitHash: null,
					commitMessage: "c2",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValueOnce(summaryWithNote1).mockResolvedValueOnce(summaryWithNote2);

		const ctx = await compileTaskContext({ branch: "feature/test", includeNotes: true }, "/test");
		// The same note ID appears in both summaries, so it should be deduplicated to 1
		expect(ctx.notes).toHaveLength(1);
		expect(ctx.notes[0].id).toBe("note-abc-1234abcd");
		expect(ctx.notes[0].content).toBe("Note content here");
	});
});

// ─── renderContextMarkdown ───────────────────────────────────────────────────

describe("renderContextMarkdown", () => {
	it("should render markdown with all sections", () => {
		const summary = makeSummary();
		const ctx = {
			branch: "feature/test",
			period: { start: "2026-03-28T10:00:00.000Z", end: "2026-03-28T10:00:00.000Z" },
			commitCount: 1,
			totalFilesChanged: 3,
			totalInsertions: 100,
			totalDeletions: 20,
			summaries: [summary],
			plans: [],
			notes: [],
			keyDecisions: [{ text: "Used factory pattern", commitHash: "abc12345" }],
			stats: {
				topicCount: 1,
				planCount: 0,
				noteCount: 0,
				decisionCount: 1,
				topicTokens: 50,
				planTokens: 0,
				noteTokens: 0,
				decisionTokens: 10,
				transcriptTokens: 0,
				totalTokens: 60,
			},
		};

		const md = renderContextMarkdown(ctx);
		expect(md).toContain("# Task Context: feature/test");
		expect(md).toContain("**Branch:** feature/test");
		expect(md).toContain("## Key Decisions");
		expect(md).toContain("Used factory pattern");
		expect(md).toContain("## Commit History (chronological)");
		expect(md).toContain("Feature X implementation");
		expect(md).toContain("Generated by Jolli Memory");
	});

	it("should omit decisions section when no decisions", () => {
		const ctx = {
			branch: "feature/test",
			period: { start: "2026-03-28T10:00:00.000Z", end: "2026-03-28T10:00:00.000Z" },
			commitCount: 1,
			totalFilesChanged: 0,
			totalInsertions: 0,
			totalDeletions: 0,
			summaries: [makeSummary({ topics: [] })],
			plans: [],
			notes: [],
			keyDecisions: [],
			stats: {
				topicCount: 0,
				planCount: 0,
				noteCount: 0,
				decisionCount: 0,
				topicTokens: 0,
				planTokens: 0,
				noteTokens: 0,
				decisionTokens: 0,
				transcriptTokens: 0,
				totalTokens: 0,
			},
		};

		const md = renderContextMarkdown(ctx);
		expect(md).not.toContain("## Key Decisions");
	});

	it("should render plans section when plans are present", () => {
		const ctx = {
			branch: "feature/test",
			period: { start: "2026-03-28T10:00:00.000Z", end: "2026-03-28T10:00:00.000Z" },
			commitCount: 1,
			totalFilesChanged: 3,
			totalInsertions: 100,
			totalDeletions: 20,
			summaries: [makeSummary()],
			plans: [{ slug: "my-plan", title: "My Plan", content: "Plan content here" }],
			notes: [],
			keyDecisions: [],
			stats: {
				topicCount: 1,
				planCount: 1,
				noteCount: 0,
				decisionCount: 0,
				topicTokens: 50,
				planTokens: 20,
				noteTokens: 0,
				decisionTokens: 0,
				transcriptTokens: 0,
				totalTokens: 70,
			},
		};

		const md = renderContextMarkdown(ctx);
		expect(md).toContain("## Plans");
		expect(md).toContain("### My Plan");
		expect(md).toContain("Plan content here");
	});

	it("should render notes section when notes are present", () => {
		const ctx = {
			branch: "feature/test",
			period: { start: "2026-03-28T10:00:00.000Z", end: "2026-03-28T10:00:00.000Z" },
			commitCount: 1,
			totalFilesChanged: 3,
			totalInsertions: 100,
			totalDeletions: 20,
			summaries: [makeSummary()],
			plans: [],
			notes: [{ id: "note-1", title: "My Note", content: "Note content here" }],
			keyDecisions: [],
			stats: {
				topicCount: 1,
				planCount: 0,
				noteCount: 1,
				decisionCount: 0,
				topicTokens: 50,
				planTokens: 0,
				noteTokens: 20,
				decisionTokens: 0,
				transcriptTokens: 0,
				totalTokens: 70,
			},
		};

		const md = renderContextMarkdown(ctx);
		expect(md).toContain("## Notes");
		expect(md).toContain("### My Note");
		expect(md).toContain("Note content here");
	});

	it("should truncate when decisions alone exceed budget", () => {
		// Create many large decisions to exceed a tiny budget
		const manyDecisions = Array.from({ length: 100 }, (_, i) => ({
			text: `Decision ${i}: ${"x".repeat(200)}`,
			commitHash: `hash${i}`,
		}));

		const ctx = {
			branch: "feature/test",
			period: { start: "2026-03-28T10:00:00.000Z", end: "2026-03-28T10:00:00.000Z" },
			commitCount: 1,
			totalFilesChanged: 1,
			totalInsertions: 10,
			totalDeletions: 5,
			summaries: [makeSummary()],
			plans: [{ slug: "plan", title: "Plan", content: "Plan content" }],
			notes: [],
			keyDecisions: manyDecisions,
			stats: {
				topicCount: 1,
				planCount: 1,
				noteCount: 0,
				decisionCount: 100,
				topicTokens: 50,
				planTokens: 20,
				noteTokens: 0,
				decisionTokens: 5000,
				transcriptTokens: 0,
				totalTokens: 5070,
			},
		};

		// Use a very small budget that the decisions header alone will exceed
		const md = renderContextMarkdown(ctx, 10);
		expect(md).toContain("decisions exceeded budget");
		// Plans and summaries should be dropped
		expect(md).not.toContain("## Plans");
		expect(md).not.toContain("## Commit History");
	});

	it("should truncate plans and summaries when over budget", () => {
		// Create large summaries to exceed budget
		const largeSummary = makeSummary({
			commitMessage: "A".repeat(500),
			topics: Array.from({ length: 20 }, (_, i) => ({
				title: `Topic ${i} ${"detail".repeat(50)}`,
				trigger: "trigger".repeat(30),
				response: "response".repeat(30),
				decisions: "decision".repeat(30),
				category: "feature",
				importance: "major" as const,
				filesAffected: ["src/file1.ts", "src/file2.ts"],
			})),
		});

		const ctx = {
			branch: "feature/test",
			period: { start: "2026-03-28T10:00:00.000Z", end: "2026-03-28T10:00:00.000Z" },
			commitCount: 1,
			totalFilesChanged: 3,
			totalInsertions: 100,
			totalDeletions: 20,
			summaries: [largeSummary],
			plans: [{ slug: "plan", title: "Plan", content: "x".repeat(2000) }],
			notes: [],
			keyDecisions: [],
			stats: {
				topicCount: 20,
				planCount: 1,
				noteCount: 0,
				decisionCount: 0,
				topicTokens: 5000,
				planTokens: 500,
				noteTokens: 0,
				decisionTokens: 0,
				transcriptTokens: 0,
				totalTokens: 5500,
			},
		};

		// Use a budget small enough that truncation will occur
		const md = renderContextMarkdown(ctx, 100);
		expect(md).toContain("truncated due to token budget");
	});

	it("should render topic without optional fields (category, importance, filesAffected)", () => {
		const summary = makeSummary({
			topics: [
				{
					title: "Minimal topic",
					trigger: "",
					response: "",
					decisions: "",
				},
			],
		});
		const ctx = {
			branch: "feature/test",
			period: { start: "2026-03-28T10:00:00.000Z", end: "2026-03-28T10:00:00.000Z" },
			commitCount: 1,
			totalFilesChanged: 0,
			totalInsertions: 0,
			totalDeletions: 0,
			summaries: [summary],
			plans: [],
			notes: [],
			keyDecisions: [],
			stats: {
				topicCount: 1,
				planCount: 0,
				noteCount: 0,
				decisionCount: 0,
				topicTokens: 10,
				planTokens: 0,
				noteTokens: 0,
				decisionTokens: 0,
				transcriptTokens: 0,
				totalTokens: 10,
			},
		};

		const md = renderContextMarkdown(ctx);
		expect(md).toContain("#### Minimal topic");
		// Should not have category brackets or importance
		expect(md).not.toContain("[feature]");
		expect(md).not.toContain("[major]");
	});

	it("should handle formatDate with empty string", () => {
		const ctx = {
			branch: "feature/test",
			period: { start: "", end: "" },
			commitCount: 1,
			totalFilesChanged: 0,
			totalInsertions: 0,
			totalDeletions: 0,
			summaries: [makeSummary()],
			plans: [],
			notes: [],
			keyDecisions: [],
			stats: {
				topicCount: 0,
				planCount: 0,
				noteCount: 0,
				decisionCount: 0,
				topicTokens: 0,
				planTokens: 0,
				noteTokens: 0,
				decisionTokens: 0,
				transcriptTokens: 0,
				totalTokens: 0,
			},
		};

		const md = renderContextMarkdown(ctx);
		expect(md).toContain("unknown to unknown");
	});
});

// ─── compileTaskContext: additional coverage ─────────────────────────────────

describe("compileTaskContext — additional coverage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should skip summaries that fail to load", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa11111",
					parentCommitHash: null,
					commitMessage: "Good commit",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb22222",
					parentCommitHash: null,
					commitMessage: "Bad commit",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValueOnce(makeSummary({ commitHash: "aaa11111" }));
		mockGetSummary.mockResolvedValueOnce(null);

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.commitCount).toBe(1);
	});

	it("should return empty context when all summaries fail to load", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa11111",
					parentCommitHash: null,
					commitMessage: "Broken commit",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(null);

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.commitCount).toBe(0);
	});

	it("should skip decisions with empty text", async () => {
		const summary = makeSummary({
			topics: [
				{
					title: "No decisions topic",
					trigger: "Some trigger",
					response: "Some response",
					decisions: "",
				},
				{
					title: "Whitespace decisions",
					trigger: "Some trigger",
					response: "Some response",
					decisions: "   ",
				},
			],
		});
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "abc12345def67890",
					parentCommitHash: null,
					commitMessage: "Test",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(summary);

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.keyDecisions).toHaveLength(0);
	});

	it("should exclude plans when includePlans is false", async () => {
		const summaryWithPlan = makeSummary({
			plans: [
				{ slug: "my-plan", title: "My Plan", editCount: 1, addedAt: "2026-03-28", updatedAt: "2026-03-28" },
			],
		});
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "abc12345def67890",
					parentCommitHash: null,
					commitMessage: "With plan",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(summaryWithPlan);

		const ctx = await compileTaskContext({ branch: "feature/test", includePlans: false }, "/test");
		expect(ctx.plans).toHaveLength(0);
		expect(mockReadPlan).not.toHaveBeenCalled();
	});

	it("should skip plans that cannot be read from branch", async () => {
		const summaryWithPlan = makeSummary({
			plans: [
				{
					slug: "missing-plan",
					title: "Missing Plan",
					editCount: 1,
					addedAt: "2026-03-28",
					updatedAt: "2026-03-28",
				},
			],
		});
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "abc12345def67890",
					parentCommitHash: null,
					commitMessage: "With missing plan",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(summaryWithPlan);
		mockReadPlan.mockResolvedValue(null);

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.plans).toHaveLength(0);
	});

	it("should deduplicate plans using 7-char hash suffix", async () => {
		const summary1 = makeSummary({
			commitHash: "aaa1111100000000",
			commitDate: "2026-03-28T10:00:00.000Z",
			generatedAt: "2026-03-28T10:01:00.000Z",
			plans: [
				{
					slug: "oauth-plan-aaa1111",
					title: "OAuth Plan v1",
					editCount: 1,
					addedAt: "2026-03-28",
					updatedAt: "2026-03-28",
				},
			],
		});
		const summary2 = makeSummary({
			commitHash: "bbb2222200000000",
			commitDate: "2026-03-29T10:00:00.000Z",
			generatedAt: "2026-03-29T10:01:00.000Z",
			plans: [
				{
					slug: "oauth-plan-bbb22222",
					title: "OAuth Plan v2",
					editCount: 2,
					addedAt: "2026-03-28",
					updatedAt: "2026-03-29",
				},
			],
		});

		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa1111100000000",
					parentCommitHash: null,
					commitMessage: "c1",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb2222200000000",
					parentCommitHash: null,
					commitMessage: "c2",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValueOnce(summary1).mockResolvedValueOnce(summary2);
		mockReadPlan.mockResolvedValue("# Plan");

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		// Both plans have base slug "oauth-plan", deduplicated to 1
		expect(ctx.plans).toHaveLength(1);
		expect(ctx.plans[0].title).toBe("OAuth Plan v2");
	});

	it("should keep newer plan when older duplicate comes second (dedup false branch)", async () => {
		// Newer plan first, then older plan with same base slug — older should be dropped
		const summary1 = makeSummary({
			commitHash: "bbb2222200000000",
			commitDate: "2026-03-29T10:00:00.000Z",
			generatedAt: "2026-03-29T10:01:00.000Z",
			plans: [
				{
					slug: "my-plan-bbb22222",
					title: "Plan v2 (newer)",
					editCount: 2,
					addedAt: "2026-03-28",
					updatedAt: "2026-03-29",
				},
			],
		});
		const summary2 = makeSummary({
			commitHash: "aaa1111100000000",
			commitDate: "2026-03-28T10:00:00.000Z",
			generatedAt: "2026-03-28T10:01:00.000Z",
			plans: [
				{
					slug: "my-plan-aaa11111",
					title: "Plan v1 (older)",
					editCount: 1,
					addedAt: "2026-03-28",
					updatedAt: "2026-03-28",
				},
			],
		});

		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "bbb2222200000000",
					parentCommitHash: null,
					commitMessage: "c1",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
				{
					commitHash: "aaa1111100000000",
					parentCommitHash: null,
					commitMessage: "c2",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValueOnce(summary1).mockResolvedValueOnce(summary2);
		mockReadPlan.mockResolvedValue("# Plan");

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.plans).toHaveLength(1);
		// Newer plan should be kept
		expect(ctx.plans[0].title).toBe("Plan v2 (newer)");
	});

	it("should include snippet notes in compiled context", async () => {
		const summaryWithNote = makeSummary({
			commitHash: "aaa11111",
			notes: [
				{
					id: "note-1-abc",
					title: "My Note",
					format: "snippet",
					content: "Some snippet content",
					addedAt: "2026-03-28T10:00:00.000Z",
					updatedAt: "2026-03-28T10:00:00.000Z",
				},
			],
		});

		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa11111",
					parentCommitHash: null,
					commitMessage: "With note",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(summaryWithNote);

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.notes).toHaveLength(1);
		expect(ctx.notes[0].id).toBe("note-1-abc");
		expect(ctx.notes[0].title).toBe("My Note");
		expect(ctx.notes[0].content).toBe("Some snippet content");
		expect(ctx.stats.noteCount).toBe(1);
		expect(ctx.stats.noteTokens).toBeGreaterThan(0);
		// readNoteFromBranch should NOT be called for snippet notes
		expect(mockReadNote).not.toHaveBeenCalled();
	});

	it("should load markdown notes via readNoteFromBranch", async () => {
		const summaryWithMarkdownNote = makeSummary({
			commitHash: "bbb22222",
			notes: [
				{
					id: "note-md-1",
					title: "Markdown Note",
					format: "markdown",
					addedAt: "2026-03-28T10:00:00.000Z",
					updatedAt: "2026-03-28T10:00:00.000Z",
				},
			],
		});

		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "bbb22222",
					parentCommitHash: null,
					commitMessage: "With markdown note",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(summaryWithMarkdownNote);
		mockReadNote.mockResolvedValue("# Markdown content from branch");

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.notes).toHaveLength(1);
		expect(ctx.notes[0].content).toBe("# Markdown content from branch");
		expect(mockReadNote).toHaveBeenCalledWith("note-md-1", "/test");
	});

	it("should skip notes that cannot be read from branch", async () => {
		const summaryWithMissingNote = makeSummary({
			commitHash: "ccc33333",
			notes: [
				{
					id: "note-missing",
					title: "Missing Note",
					format: "markdown",
					addedAt: "2026-03-28T10:00:00.000Z",
					updatedAt: "2026-03-28T10:00:00.000Z",
				},
			],
		});

		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "ccc33333",
					parentCommitHash: null,
					commitMessage: "With missing note",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(summaryWithMissingNote);
		mockReadNote.mockResolvedValue(null);

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.notes).toHaveLength(0);
	});

	it("should filter entries with parentCommitHash === undefined as root entries", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "abc12345def67890",
					parentCommitHash: undefined as unknown as null,
					commitMessage: "Commit with undefined parent",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(makeSummary());

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.commitCount).toBe(1);
	});
});

// ─── buildRecallPayload ──────────────────────────────────────────────────────

describe("buildRecallPayload", () => {
	function makeCtx(overrides: Partial<CompiledContext> = {}): CompiledContext {
		return {
			branch: "feature/test",
			period: { start: "2026-03-01", end: "2026-03-15" },
			commitCount: 1,
			totalFilesChanged: 3,
			totalInsertions: 100,
			totalDeletions: 20,
			summaries: [makeSummary()],
			plans: [],
			notes: [],
			keyDecisions: [],
			stats: {
				topicCount: 1,
				planCount: 0,
				noteCount: 0,
				decisionCount: 0,
				topicTokens: 50,
				planTokens: 0,
				noteTokens: 0,
				decisionTokens: 0,
				transcriptTokens: 0,
				totalTokens: 50,
			},
			...overrides,
		};
	}

	it("projects each summary into a SearchHit and ships full payload at wide budget", () => {
		const payload = buildRecallPayload(makeCtx(), 100_000);
		expect(payload.type).toBe("recall");
		expect(payload.commits).toHaveLength(1);
		expect(payload.commits[0].fullHash).toBe("abc12345def67890");
		expect(payload.commits[0].topics[0].decisions).toBe("Used factory pattern for extensibility");
		expect(payload.truncated).toBeUndefined();
	});

	it("ships plans and notes top-level with content when budget allows", () => {
		const payload = buildRecallPayload(
			makeCtx({
				plans: [{ slug: "p1", title: "P1", content: "plan body" }],
				notes: [{ id: "n1", title: "N1", content: "note body" }],
			}),
			100_000,
		);
		expect(payload.plans[0]).toEqual({ slug: "p1", title: "P1", content: "plan body" });
		expect(payload.notes[0]).toEqual({ id: "n1", title: "N1", content: "note body" });
	});

	it("under tight budget drops topic.response first (preserves trigger and decisions)", () => {
		// Build a 4-commit ctx where the response field carries most of the bytes.
		const summaries = [1, 2, 3, 4].map((i) =>
			makeSummary({
				commitHash: `aaaaaaaa00000000000000000000000000000000${i}`.slice(0, 40),
				topics: [
					{
						title: `T${i}`,
						trigger: `trig-${i}`,
						response: "X".repeat(2000),
						decisions: `dec-${i}`,
					},
				],
			}),
		);
		const payload = buildRecallPayload(makeCtx({ summaries, commitCount: 4 }), 1500);
		expect(payload.truncated).toBe(true);
		// Older commits should have lost response first; decisions stays.
		const oldest = payload.commits[0];
		expect(oldest.topics[0].response).toBeUndefined();
		expect(oldest.topics[0].decisions).toBeDefined();
	});

	it("escalates to dropping topic.trigger after response is gone", () => {
		const summaries = [1, 2].map((i) =>
			makeSummary({
				commitHash: `bbbbbbbb00000000000000000000000000000000${i}`.slice(0, 40),
				topics: [
					{
						title: `T${i}`,
						trigger: "Y".repeat(1500),
						response: "X".repeat(1500),
						decisions: `dec-${i}`,
					},
				],
			}),
		);
		const payload = buildRecallPayload(makeCtx({ summaries, commitCount: 2 }), 600);
		expect(payload.truncated).toBe(true);
		const oldest = payload.commits[0];
		// Both verbose fields are gone; decisions remains.
		expect(oldest.topics[0].response).toBeUndefined();
		expect(oldest.topics[0].trigger).toBeUndefined();
		expect(oldest.topics[0].decisions).toBeDefined();
	});

	it("drops plans[].content (keeps slug + title) before evicting commits", () => {
		const payload = buildRecallPayload(
			makeCtx({
				plans: [{ slug: "p1", title: "P1", content: "Z".repeat(4000) }],
			}),
			500,
		);
		expect(payload.truncated).toBe(true);
		// Plan entry survives as a citation anchor without content.
		expect(payload.plans).toHaveLength(1);
		expect(payload.plans[0]).toEqual({ slug: "p1", title: "P1" });
	});

	it("drops notes[].content (keeps id + title) under similar pressure", () => {
		const payload = buildRecallPayload(
			makeCtx({
				notes: [{ id: "n1", title: "N1", content: "Z".repeat(4000) }],
			}),
			500,
		);
		expect(payload.truncated).toBe(true);
		expect(payload.notes).toHaveLength(1);
		expect(payload.notes[0]).toEqual({ id: "n1", title: "N1" });
	});

	it("evicts oldest commits wholesale when budget can't fit decisions", () => {
		// Make every commit's decisions field huge so trim steps 1-4 don't help.
		const summaries = [1, 2, 3].map((i) =>
			makeSummary({
				commitHash: `cccccccc00000000000000000000000000000000${i}`.slice(0, 40),
				topics: [
					{
						title: `T${i}`,
						trigger: `t${i}`,
						response: `r${i}`,
						decisions: "D".repeat(2000),
					},
				],
			}),
		);
		const payload = buildRecallPayload(makeCtx({ summaries, commitCount: 3 }), 1200);
		expect(payload.truncated).toBe(true);
		expect(payload.commits.length).toBeLessThan(3);
		// Every kept commit still has decisions on every topic — type contract honored.
		for (const hit of payload.commits) {
			for (const t of hit.topics) {
				expect(t.decisions).toBeDefined();
			}
		}
	});

	// Coverage for the defensive early-return inside the response/trigger trim
	// loops: when buildHit projection emits a topic without response/trigger
	// (e.g. corrupt input where TopicSummary.response is missing), the trim step
	// must skip it instead of double-counting `truncated`.
	it("skips topics that already lack response when trim Step 1 runs", () => {
		// Craft a summary whose topic genuinely lacks response/trigger by casting.
		// buildHit's conditional spread propagates the absence to the SearchHit.
		const summary = makeSummary({
			commitHash: "ffffffff00000000000000000000000000000000",
			topics: [
				{
					title: "T1",
					// biome-ignore lint/suspicious/noExplicitAny: deliberately omitting required field for trim coverage
					trigger: undefined as any,
					// biome-ignore lint/suspicious/noExplicitAny: deliberately omitting required field for trim coverage
					response: undefined as any,
					decisions: "D".repeat(8000),
				},
				{ title: "T2", trigger: "tt", response: "X".repeat(8000), decisions: "dd" },
			],
		});
		const payload = buildRecallPayload(makeCtx({ summaries: [summary], commitCount: 1 }), 2500);
		expect(payload.truncated).toBe(true);
		expect(payload.commits).toHaveLength(1);
		// T2's response was the long field — it should be the one stripped, while
		// T1 (which had no response in the first place) is left alone (early-return).
		expect(payload.commits[0].topics[0].response).toBeUndefined();
		expect(payload.commits[0].topics[1].response).toBeUndefined();
	});

	it("skips topics that already lack trigger when trim Step 2 runs", () => {
		// Force both Step 1 and Step 2 to fire on the same commit. Topic 1 has no
		// trigger, so Step 2's early-return branch fires for it; topic 2's
		// trigger is the long field that must be stripped to fit budget.
		const summary = makeSummary({
			commitHash: "ffffeeee00000000000000000000000000000000",
			topics: [
				{
					title: "T1",
					// biome-ignore lint/suspicious/noExplicitAny: deliberately omitting required field for trim coverage
					trigger: undefined as any,
					response: "X".repeat(8000),
					decisions: "A".repeat(1500),
				},
				{
					title: "T2",
					trigger: "B".repeat(2000),
					response: "Y".repeat(8000),
					decisions: "A".repeat(1500),
				},
			],
		});
		// Budget chosen so Step 1 (drop response) leaves us still over budget,
		// forcing Step 2 (drop trigger) to fire.
		const payload = buildRecallPayload(makeCtx({ summaries: [summary], commitCount: 1 }), 1100);
		expect(payload.truncated).toBe(true);
		expect(payload.commits).toHaveLength(1);
		expect(payload.commits[0].topics[0].response).toBeUndefined();
		expect(payload.commits[0].topics[1].response).toBeUndefined();
		expect(payload.commits[0].topics[0].trigger).toBeUndefined();
		expect(payload.commits[0].topics[1].trigger).toBeUndefined();
	});

	// Same defensive guard for the plan/note content trim steps. When a plan
	// arrives without content (e.g. the orphan branch read returned empty),
	// the trim step must skip it without flipping `truncated` for nothing.
	it("skips plans/notes that already lack content when trim Step 3/4 runs", () => {
		// Build a heavy ctx so we deterministically reach steps 3 and 4. Mix one
		// content-bearing plan with one already-empty plan; same for notes.
		const summary = makeSummary({
			commitHash: "ffffffff10000000000000000000000000000000",
			topics: [{ title: "T", trigger: "t", response: "r", decisions: "d" }],
		});
		const payload = buildRecallPayload(
			makeCtx({
				summaries: [summary],
				commitCount: 1,
				plans: [
					{ slug: "p1", title: "P1", content: "Z".repeat(2000) },
					// biome-ignore lint/suspicious/noExplicitAny: deliberately omitting content for trim coverage
					{ slug: "p2", title: "P2", content: undefined as any },
				],
				notes: [
					{ id: "n1", title: "N1", content: "Y".repeat(2000) },
					// biome-ignore lint/suspicious/noExplicitAny: deliberately omitting content for trim coverage
					{ id: "n2", title: "N2", content: undefined as any },
				],
			}),
			500,
		);
		expect(payload.truncated).toBe(true);
		// Both plans survive, both with content stripped (p2 was already absent).
		expect(payload.plans).toHaveLength(2);
		expect(payload.plans.find((p) => p.slug === "p1")?.content).toBeUndefined();
		expect(payload.plans.find((p) => p.slug === "p2")?.content).toBeUndefined();
		// Same for notes.
		expect(payload.notes).toHaveLength(2);
		expect(payload.notes.find((n) => n.id === "n1")?.content).toBeUndefined();
		expect(payload.notes.find((n) => n.id === "n2")?.content).toBeUndefined();
	});

	// Pathological budgets used to evict every commit, leaving the ambiguous
	// `commits=[]` state. Step 5 now stops at one commit — the empty array
	// is reserved for "genuinely no records", and the skill template can keep
	// its empty-handling rule simple. Pathological budgets accept a minor
	// overage (estimatedTokens > budget) instead.
	it("evicts oldest commits but always keeps at least one (avoids commits=[] ambiguity)", () => {
		const summaries = [1, 2].map((i) =>
			makeSummary({
				commitHash: `dddddddd00000000000000000000000000000000${i}`.slice(0, 40),
				topics: [{ title: `T${i}`, trigger: "t", response: "r", decisions: "D".repeat(1500) }],
			}),
		);
		const payload = buildRecallPayload(makeCtx({ summaries, commitCount: 2 }), 50);
		expect(payload.truncated).toBe(true);
		// One commit kept (the most recent) — the older one is evicted.
		expect(payload.commits).toHaveLength(1);
		// Pathological budget: payload exceeds it. Truncation is signaled but
		// the LLM still gets meaningful data instead of a misleading empty array.
		expect(payload.estimatedTokens).toBeGreaterThan(50);
	});

	it("guarantees commits=[] iff commitCount=0 (empty-state invariant)", () => {
		// Branch with no records at all → ctx.summaries empty → commits=[].
		const empty = buildRecallPayload(makeCtx({ summaries: [], commitCount: 0 }), 100_000);
		expect(empty.commits).toHaveLength(0);
		expect(empty.commitCount).toBe(0);

		// Branch with records but pathological budget → commits=[1], not [].
		const tight = buildRecallPayload(
			makeCtx({
				summaries: [makeSummary({ topics: [{ title: "T", trigger: "t", response: "r", decisions: "D" }] })],
				commitCount: 1,
			}),
			1,
		);
		expect(tight.commits.length).toBeGreaterThanOrEqual(1);
		expect(tight.commitCount).toBe(1);
	});

	it("uses default DEFAULT_TOKEN_BUDGET (20K) when no budget is passed", () => {
		const payload = buildRecallPayload(makeCtx());
		// Default 20K easily fits a 1-commit fixture; nothing is truncated.
		expect(payload.truncated).toBeUndefined();
		expect(payload.commits).toHaveLength(1);
	});

	it("sets estimatedTokens to a positive number reflecting payload size", () => {
		const payload = buildRecallPayload(makeCtx());
		expect(payload.estimatedTokens).toBeGreaterThan(0);
	});

	// Stubs on commits must always resolve to a top-level entry. When a
	// summary references a plan whose body couldn't be loaded (orphan-branch
	// miss), the stub on the commit must be filtered out so the contract holds.
	it("filters out plan stubs whose body did not load (no dangling stub)", () => {
		const summary = makeSummary({
			commitHash: "ee00000000000000000000000000000000000000",
			plans: [
				{
					slug: "live-plan",
					title: "Live",
					editCount: 1,
					addedAt: "2026-01-01",
					updatedAt: "2026-01-01",
				},
				{
					slug: "missing-plan",
					title: "Missing",
					editCount: 1,
					addedAt: "2026-01-01",
					updatedAt: "2026-01-01",
				},
			],
		});
		// ctx.plans only contains the resolved one — simulates readPlanFromBranch
		// returning null for "missing-plan".
		const payload = buildRecallPayload(
			makeCtx({
				summaries: [summary],
				plans: [{ slug: "live-plan", title: "Live", content: "live body" }],
			}),
			100_000,
		);
		// Top-level has only the loaded plan.
		expect(payload.plans.map((p) => p.slug)).toEqual(["live-plan"]);
		// Commit's plan stubs are filtered to only the live one — no dangling stub.
		expect(payload.commits[0].plans).toEqual([{ slug: "live-plan", title: "Live" }]);
	});

	it("filters out note stubs whose body did not load", () => {
		const summary = makeSummary({
			commitHash: "ee10000000000000000000000000000000000000",
			notes: [
				{ id: "live-note", title: "Live", format: "markdown", addedAt: "2026-01-01", updatedAt: "2026-01-01" },
				{
					id: "missing-note",
					title: "Missing",
					format: "markdown",
					addedAt: "2026-01-01",
					updatedAt: "2026-01-01",
				},
			],
		});
		const payload = buildRecallPayload(
			makeCtx({
				summaries: [summary],
				notes: [{ id: "live-note", title: "Live", content: "live body" }],
			}),
			100_000,
		);
		expect(payload.notes.map((n) => n.id)).toEqual(["live-note"]);
		expect(payload.commits[0].notes).toEqual([{ id: "live-note", title: "Live" }]);
	});

	it("strips ALL plan stubs when --no-plans leaves the top-level array empty", () => {
		const summary = makeSummary({
			commitHash: "ee20000000000000000000000000000000000000",
			plans: [
				{
					slug: "p1",
					title: "P1",
					editCount: 1,
					addedAt: "2026-01-01",
					updatedAt: "2026-01-01",
				},
			],
		});
		const payload = buildRecallPayload(makeCtx({ summaries: [summary], plans: [] }), 100_000);
		// No top-level entries → no commit stubs at all (the field is dropped).
		expect(payload.plans).toEqual([]);
		expect(payload.commits[0].plans).toBeUndefined();
	});

	it("strips ALL note stubs when --no-notes leaves the top-level array empty", () => {
		const summary = makeSummary({
			commitHash: "ee30000000000000000000000000000000000000",
			notes: [{ id: "n1", title: "N1", format: "markdown", addedAt: "2026-01-01", updatedAt: "2026-01-01" }],
		});
		const payload = buildRecallPayload(makeCtx({ summaries: [summary], notes: [] }), 100_000);
		expect(payload.notes).toEqual([]);
		expect(payload.commits[0].notes).toBeUndefined();
	});

	// estimatedTokens / measure() must reflect the FULL JSON output, including
	// the envelope (type/branch/period/stats/...) — not just commits/plans/notes.
	// Otherwise tight budgets get a meaningfully under-counted figure.
	it("estimatedTokens accounts for the envelope, not just commits/plans/notes", () => {
		const payload = buildRecallPayload(makeCtx());
		// The reported estimate should be at least as large as the bare commit
		// JSON's tokens (envelope adds non-zero cost on top).
		const justCommits = JSON.stringify(payload.commits);
		// estimateTokens is char-len/4 for ASCII; envelope is ~150 chars → ~38
		// extra tokens. Verify the gap so we know the envelope is in the count.
		const bareLen = Math.max(1, Math.floor(justCommits.length / 4));
		expect(payload.estimatedTokens).toBeGreaterThan(bareLen);
	});

	it("preserves branch-level aggregates verbatim", () => {
		const payload = buildRecallPayload(
			makeCtx({
				branch: "feature/x",
				commitCount: 7,
				totalFilesChanged: 24,
				totalInsertions: 312,
				totalDeletions: 89,
				period: { start: "2026-04-10", end: "2026-04-15" },
			}),
		);
		expect(payload.branch).toBe("feature/x");
		expect(payload.commitCount).toBe(7);
		expect(payload.totalFilesChanged).toBe(24);
		expect(payload.totalInsertions).toBe(312);
		expect(payload.totalDeletions).toBe(89);
		expect(payload.period).toEqual({ start: "2026-04-10", end: "2026-04-15" });
	});

	it('drops topics with importance === "minor" from the payload', () => {
		const summary = makeSummary({
			topics: [
				{
					title: "Major work",
					trigger: "t1",
					response: "r1",
					decisions: "d1",
					importance: "major",
				},
				{
					title: "Minor tweak",
					trigger: "t2",
					response: "r2",
					decisions: "d2",
					importance: "minor",
				},
			],
		});
		const payload = buildRecallPayload(makeCtx({ summaries: [summary] }), 100_000);
		expect(payload.commits).toHaveLength(1);
		expect(payload.commits[0].topics).toHaveLength(1);
		expect(payload.commits[0].topics[0].title).toBe("Major work");
		expect(payload.truncated).toBe(true);
	});

	it("drops the whole commit when every topic on it is minor", () => {
		const major = makeSummary({
			commitHash: "aaaaaaaa00000000000000000000000000000001",
			topics: [
				{
					title: "Real work",
					trigger: "t",
					response: "r",
					decisions: "d",
					importance: "major",
				},
			],
		});
		const allMinor = makeSummary({
			commitHash: "bbbbbbbb00000000000000000000000000000002",
			topics: [
				{
					title: "Nit 1",
					trigger: "t",
					response: "r",
					decisions: "d",
					importance: "minor",
				},
				{
					title: "Nit 2",
					trigger: "t",
					response: "r",
					decisions: "d",
					importance: "minor",
				},
			],
		});
		const payload = buildRecallPayload(makeCtx({ summaries: [major, allMinor], commitCount: 2 }), 100_000);
		expect(payload.commits).toHaveLength(1);
		expect(payload.commits[0].fullHash).toBe(major.commitHash);
		expect(payload.truncated).toBe(true);
		// Envelope commitCount reflects what was loaded (still 2), not what was kept (1).
		expect(payload.commitCount).toBe(2);
	});

	it("keeps all topics when filtering minors would leave commits[] empty (pathological branch)", () => {
		const onlyMinor = makeSummary({
			topics: [
				{
					title: "Only nit",
					trigger: "t",
					response: "r",
					decisions: "d",
					importance: "minor",
				},
			],
		});
		const payload = buildRecallPayload(makeCtx({ summaries: [onlyMinor] }), 100_000);
		// Filter would have evicted everything; safety guard keeps the topic so
		// the downstream "commits=[] means no records" invariant is preserved.
		expect(payload.commits).toHaveLength(1);
		expect(payload.commits[0].topics).toHaveLength(1);
		expect(payload.truncated).toBeUndefined();
	});

	it("does not drop minor topics when called with verbose: true", () => {
		const summary = makeSummary({
			topics: [
				{
					title: "Major",
					trigger: "t",
					response: "r",
					decisions: "d",
					importance: "major",
				},
				{
					title: "Minor",
					trigger: "t",
					response: "r",
					decisions: "d",
					importance: "minor",
				},
			],
		});
		const payload = buildRecallPayload(makeCtx({ summaries: [summary] }), 100_000, { verbose: true });
		expect(payload.commits[0].topics).toHaveLength(2);
		expect(payload.truncated).toBeUndefined();
	});

	it("keeps topic.response for branches with at most 8 commits", () => {
		const summaries = Array.from({ length: 8 }, (_, i) =>
			makeSummary({
				commitHash: `cccccccc00000000000000000000000000000${String(i).padStart(3, "0")}`.slice(0, 40),
				topics: [
					{
						title: `T${i}`,
						trigger: `trig-${i}`,
						response: `resp-${i}`,
						decisions: `dec-${i}`,
						importance: "major",
					},
				],
			}),
		);
		const payload = buildRecallPayload(makeCtx({ summaries, commitCount: 8 }), 100_000);
		expect(payload.commits).toHaveLength(8);
		expect(payload.commits.every((c) => c.topics[0].response !== undefined)).toBe(true);
		expect(payload.truncated).toBeUndefined();
	});

	it("drops topic.response from every commit when the branch has more than 8 commits", () => {
		const summaries = Array.from({ length: 9 }, (_, i) =>
			makeSummary({
				commitHash: `dddddddd00000000000000000000000000000${String(i).padStart(3, "0")}`.slice(0, 40),
				topics: [
					{
						title: `T${i}`,
						trigger: `trig-${i}`,
						response: `resp-${i}`,
						decisions: `dec-${i}`,
						importance: "major",
					},
				],
			}),
		);
		const payload = buildRecallPayload(makeCtx({ summaries, commitCount: 9 }), 100_000);
		expect(payload.commits).toHaveLength(9);
		expect(payload.commits.every((c) => c.topics[0].response === undefined)).toBe(true);
		// trigger and decisions both survive — only response is targeted at this tier.
		expect(payload.commits[0].topics[0].trigger).toBe("trig-0");
		expect(payload.commits[0].topics[0].decisions).toBe("dec-0");
		expect(payload.truncated).toBe(true);
	});

	it("keeps topic.response on >8 commits when called with verbose: true", () => {
		const summaries = Array.from({ length: 12 }, (_, i) =>
			makeSummary({
				commitHash: `eeeeeeee00000000000000000000000000000${String(i).padStart(3, "0")}`.slice(0, 40),
				topics: [
					{
						title: `T${i}`,
						trigger: `trig-${i}`,
						response: `resp-${i}`,
						decisions: `dec-${i}`,
						importance: "major",
					},
				],
			}),
		);
		const payload = buildRecallPayload(makeCtx({ summaries, commitCount: 12 }), 100_000, { verbose: true });
		expect(payload.commits.every((c) => c.topics[0].response !== undefined)).toBe(true);
		expect(payload.truncated).toBeUndefined();
	});

	it("applies the >8-commit response-drop tier after minor-topic filtering, not before", () => {
		// Build 10 commits but 3 of them are all-minor → after minor filter we have 7 commits.
		// 7 ≤ 8, so the tier MUST NOT fire even though the raw count was >8.
		const majorCommits = Array.from({ length: 7 }, (_, i) =>
			makeSummary({
				commitHash: `ffffffff00000000000000000000000000000${String(i).padStart(3, "0")}`.slice(0, 40),
				topics: [
					{
						title: `T${i}`,
						trigger: "t",
						response: `resp-${i}`,
						decisions: "d",
						importance: "major",
					},
				],
			}),
		);
		const minorOnlyCommits = Array.from({ length: 3 }, (_, i) =>
			makeSummary({
				commitHash: `99999999000000000000000000000000000${String(i).padStart(4, "0")}`.slice(0, 40),
				topics: [
					{
						title: `M${i}`,
						trigger: "t",
						response: "r",
						decisions: "d",
						importance: "minor",
					},
				],
			}),
		);
		const payload = buildRecallPayload(
			makeCtx({
				summaries: [...majorCommits, ...minorOnlyCommits],
				commitCount: 10,
			}),
			100_000,
		);
		// 7 commits survived the minor filter; that's ≤8, so response stays.
		expect(payload.commits).toHaveLength(7);
		expect(payload.commits.every((c) => c.topics[0].response !== undefined)).toBe(true);
	});
});

// ─── compileTaskContext: plan/note recursion + base-slug normalization ──────

describe("compileTaskContext — recursive plan/note collection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("collects plans referenced from nested children (v3 legacy data)", async () => {
		mockGetIndex.mockResolvedValueOnce(
			makeIndex([
				{
					commitHash: "rootroot12345678",
					parentCommitHash: null,
					commitMessage: "root",
					commitDate: "2026-03-28T10:00:00Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(
			makeSummary({
				commitHash: "rootroot12345678",
				plans: undefined,
				children: [
					makeSummary({
						commitHash: "childchild0011223344",
						plans: [
							{
								slug: "nested-plan",
								title: "Nested Plan",
								editCount: 1,
								addedAt: "2026-03-28",
								updatedAt: "2026-03-28",
							},
						],
					}),
				],
			}),
		);
		mockReadPlan.mockResolvedValueOnce("nested plan content");

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.plans).toHaveLength(1);
		expect(ctx.plans[0].slug).toBe("nested-plan");
		expect(ctx.plans[0].content).toBe("nested plan content");
	});

	it("collects notes referenced from nested children", async () => {
		mockGetIndex.mockResolvedValueOnce(
			makeIndex([
				{
					commitHash: "rootroot12345678",
					parentCommitHash: null,
					commitMessage: "root",
					commitDate: "2026-03-28T10:00:00Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(
			makeSummary({
				commitHash: "rootroot12345678",
				notes: undefined,
				children: [
					makeSummary({
						commitHash: "childchild0011223344",
						notes: [
							{
								id: "nested-note",
								title: "Nested Note",
								format: "markdown",
								addedAt: "2026-03-28",
								updatedAt: "2026-03-28",
							},
						],
					}),
				],
			}),
		);
		mockReadNote.mockResolvedValueOnce("nested note content");

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.notes).toHaveLength(1);
		expect(ctx.notes[0].id).toBe("nested-note");
		expect(ctx.notes[0].content).toBe("nested note content");
	});

	it("normalizes plan slug to base slug when archive suffix is present", async () => {
		// Commit hash starts with "06d0f729..."; plan slug ends with the same
		// 8-char prefix. Top-level plans entry should expose the base slug.
		mockGetIndex.mockResolvedValueOnce(
			makeIndex([
				{
					commitHash: "06d0f7299912345abcdef0123456789abcdef012",
					parentCommitHash: null,
					commitMessage: "archived",
					commitDate: "2026-03-28T10:00:00Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:01:00Z",
				},
			]),
		);
		mockGetSummary.mockResolvedValue(
			makeSummary({
				commitHash: "06d0f7299912345abcdef0123456789abcdef012",
				plans: [
					{
						slug: "auth-redesign-06d0f729",
						title: "Auth Redesign",
						editCount: 1,
						addedAt: "2026-03-28",
						updatedAt: "2026-03-28",
					},
				],
			}),
		);
		mockReadPlan.mockResolvedValueOnce("plan body");

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		expect(ctx.plans).toHaveLength(1);
		// Top-level slug is the canonical base form.
		expect(ctx.plans[0].slug).toBe("auth-redesign");
		// Reading the body still goes through the original (archived) path.
		expect(mockReadPlan).toHaveBeenCalledWith("auth-redesign-06d0f729", "/test");
	});

	it("dedupes the same logical plan across pre-archive and post-archive commits", async () => {
		mockGetIndex.mockResolvedValueOnce(
			makeIndex([
				{
					commitHash: "preeeeee0011223344556677889900112233445566",
					parentCommitHash: null,
					commitMessage: "pre",
					commitDate: "2026-03-27T10:00:00Z",
					branch: "feature/test",
					generatedAt: "2026-03-27T10:00:00Z",
				},
				{
					commitHash: "06d0f7299912345abcdef0123456789abcdef012",
					parentCommitHash: null,
					commitMessage: "post",
					commitDate: "2026-03-28T10:00:00Z",
					branch: "feature/test",
					generatedAt: "2026-03-28T10:00:00Z",
				},
			]),
		);
		mockGetSummary.mockImplementation(async (hash: string) => {
			if (hash === "preeeeee0011223344556677889900112233445566") {
				return makeSummary({
					commitHash: "preeeeee0011223344556677889900112233445566",
					plans: [
						{
							slug: "auth-redesign",
							title: "Auth Redesign",
							editCount: 1,
							addedAt: "2026-03-26",
							updatedAt: "2026-03-26",
						},
					],
				});
			}
			return makeSummary({
				commitHash: "06d0f7299912345abcdef0123456789abcdef012",
				plans: [
					{
						slug: "auth-redesign-06d0f729",
						title: "Auth Redesign",
						editCount: 1,
						addedAt: "2026-03-26",
						updatedAt: "2026-03-28",
					},
				],
			});
		});
		mockReadPlan.mockResolvedValue("plan body");

		const ctx = await compileTaskContext({ branch: "feature/test" }, "/test");
		// Both commits referenced the same logical plan — dedup yields one entry,
		// keyed by base slug.
		expect(ctx.plans).toHaveLength(1);
		expect(ctx.plans[0].slug).toBe("auth-redesign");
	});
});
