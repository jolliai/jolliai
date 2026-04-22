import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, SummaryIndex } from "../Types.js";
import { compileTaskContext, estimateTokens, listBranchCatalog, renderContextMarkdown } from "./ContextCompiler.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("./SummaryStore.js", () => ({
	getIndex: vi.fn(),
	getSummary: vi.fn(),
	readPlanFromBranch: vi.fn(),
	readNoteFromBranch: vi.fn(),
	readTranscript: vi.fn(),
}));

import { getIndex, getSummary, readNoteFromBranch, readPlanFromBranch } from "./SummaryStore.js";

const mockGetIndex = vi.mocked(getIndex);
const mockGetSummary = vi.mocked(getSummary);
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
