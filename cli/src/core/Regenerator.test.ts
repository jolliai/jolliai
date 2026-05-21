import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, LlmConfig, StoredTranscript } from "../Types.js";
import * as GitOps from "./GitOps.js";
import { regenerateSummary } from "./Regenerator.js";
import * as Summarizer from "./Summarizer.js";
import * as SummaryStore from "./SummaryStore.js";
import * as TranscriptReader from "./TranscriptReader.js";

vi.mock("./Summarizer.js", () => ({ generateSummary: vi.fn() }));
vi.mock("./SummaryStore.js", () => ({
	readTranscript: vi.fn(),
	readLinearIssueFromBranch: vi.fn(),
	readPlanFromBranch: vi.fn(),
	readNoteFromBranch: vi.fn(),
}));
vi.mock("./GitOps.js", () => ({ getDiffContent: vi.fn() }));
vi.mock("./TranscriptReader.js", () => ({ buildMultiSessionContext: vi.fn() }));

const config: LlmConfig = { apiKey: "k", model: "haiku" } as LlmConfig;

const baseSummary: CommitSummary = {
	version: 4,
	commitHash: "abcdef1234567890",
	commitMessage: "Refactor X",
	commitAuthor: "tester",
	commitDate: "2026-05-21T00:00:00Z",
	branch: "main",
	generatedAt: "2026-05-21T00:01:00Z",
	diffStats: { filesChanged: 2, insertions: 10, deletions: 3 },
	topics: [{ title: "old topic", trigger: "t", response: "r", decisions: "d" }],
	recap: "old recap",
	e2eTestGuide: [{ name: "old e2e" } as never],
} as CommitSummary;

const storedTranscript: StoredTranscript = {
	sessions: [
		{
			sessionId: "s1",
			source: "claude",
			entries: [{ role: "human", content: "hi", timestamp: "2026-05-21T00:00:00Z" }],
		},
	],
};

const successResult = {
	transcriptEntries: 1,
	conversationTurns: 1,
	llm: {
		model: "haiku",
		inputTokens: 1,
		outputTokens: 1,
		apiLatencyMs: 1,
		stopReason: null,
		source: "anthropic-config",
	} as never,
	stats: { filesChanged: 2, insertions: 10, deletions: 3 },
	topics: [{ title: "new topic", trigger: "t2", response: "r2", decisions: "d2" }],
	recap: "new recap",
	ticketId: "JOLLI-9999",
};

describe("regenerateSummary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(SummaryStore.readTranscript).mockResolvedValue(storedTranscript);
		vi.mocked(GitOps.getDiffContent).mockResolvedValue("DIFF");
		vi.mocked(TranscriptReader.buildMultiSessionContext).mockReturnValue("CONV");
		vi.mocked(SummaryStore.readLinearIssueFromBranch).mockResolvedValue(null);
		vi.mocked(SummaryStore.readPlanFromBranch).mockResolvedValue(null);
		vi.mocked(SummaryStore.readNoteFromBranch).mockResolvedValue(null);
		vi.mocked(Summarizer.generateSummary).mockResolvedValue(successResult);
	});

	it("still runs generateSummary when no transcript is stored (empty conversation)", async () => {
		vi.mocked(SummaryStore.readTranscript).mockResolvedValue(null);
		await regenerateSummary(baseSummary, "/repo", config);
		expect(TranscriptReader.buildMultiSessionContext).toHaveBeenCalledWith([]);
		expect(Summarizer.generateSummary).toHaveBeenCalledWith(
			expect.objectContaining({ transcriptEntries: 0, conversation: "CONV" }),
		);
	});

	it("calls generateSummary with reconstructed inputs", async () => {
		await regenerateSummary(baseSummary, "/repo", config);

		expect(GitOps.getDiffContent).toHaveBeenCalledWith("abcdef1234567890~1", "abcdef1234567890", "/repo");
		expect(TranscriptReader.buildMultiSessionContext).toHaveBeenCalledWith([
			{
				sessionId: "s1",
				transcriptPath: "(stored)",
				source: "claude",
				entries: storedTranscript.sessions[0].entries,
			},
		]);
		expect(Summarizer.generateSummary).toHaveBeenCalledWith(
			expect.objectContaining({
				conversation: "CONV",
				diff: "DIFF",
				commitInfo: {
					hash: "abcdef1234567890",
					message: "Refactor X",
					author: "tester",
					date: "2026-05-21T00:00:00Z",
				},
				diffStats: { filesChanged: 2, insertions: 10, deletions: 3 },
				transcriptEntries: 1,
				config,
			}),
		);
	});

	it("replaces topics + recap; preserves ticketId, e2eTestGuide, and other fields", async () => {
		const baseWithTicket: CommitSummary = {
			...baseSummary,
			ticketId: "JOLLI-1111",
		} as CommitSummary;

		const { updated } = await regenerateSummary(baseWithTicket, "/repo", config);

		expect(updated.topics?.[0]?.title).toBe("new topic");
		expect(updated.recap).toBe("new recap");
		// ticketId must come from the old summary even though the LLM produced "JOLLI-9999"
		expect(updated.ticketId).toBe("JOLLI-1111");
		// e2eTestGuide must be preserved verbatim
		expect(updated.e2eTestGuide).toEqual(baseSummary.e2eTestGuide);
		expect(updated.commitMessage).toBe("Refactor X");
		expect(updated.commitHash).toBe("abcdef1234567890");
		// generatedAt should be refreshed to a now-ish ISO timestamp
		expect(updated.generatedAt).not.toBe(baseSummary.generatedAt);
		expect(new Date(updated.generatedAt).toString()).not.toBe("Invalid Date");
	});

	it("reads attached plans / notes / linear-issues from the orphan branch as prompt blocks", async () => {
		const withRefs: CommitSummary = {
			...baseSummary,
			plans: [{ slug: "p-1", title: "Plan 1" } as never, { slug: "p-2", title: "Plan 2" } as never],
			notes: [{ id: "n-1", title: "Note 1", format: "markdown" } as never],
			linearIssues: [
				{ archivedKey: "JOLLI-1-abc", ticketId: "JOLLI-1", title: "T", url: "https://linear.app/x" } as never,
			],
		} as CommitSummary;
		vi.mocked(SummaryStore.readPlanFromBranch)
			.mockResolvedValueOnce("# Plan 1\n\nplan body 1")
			.mockResolvedValueOnce("# Plan 2\n\nplan body 2");
		vi.mocked(SummaryStore.readNoteFromBranch).mockResolvedValueOnce("note body");
		vi.mocked(SummaryStore.readLinearIssueFromBranch).mockResolvedValueOnce(
			'---\nticketId: "JOLLI-1"\n---\nissue body',
		);

		await regenerateSummary(withRefs, "/repo", config);

		expect(SummaryStore.readPlanFromBranch).toHaveBeenCalledWith("p-1", "/repo");
		expect(SummaryStore.readPlanFromBranch).toHaveBeenCalledWith("p-2", "/repo");
		expect(SummaryStore.readNoteFromBranch).toHaveBeenCalledWith("n-1", "/repo");
		expect(SummaryStore.readLinearIssueFromBranch).toHaveBeenCalledWith("JOLLI-1-abc", "/repo");

		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.plans).toContain("plan body 1");
		expect(params.plans).toContain("plan body 2");
		expect(params.notes).toContain("note body");
		expect(params.linearIssues).toContain("issue body");
	});

	it("emits empty prompt blocks when no plans / notes / linear-issues are attached", async () => {
		await regenerateSummary(baseSummary, "/repo", config);
		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.plans).toBe("");
		expect(params.notes).toBe("");
		expect(params.linearIssues).toBe("");
		expect(SummaryStore.readPlanFromBranch).not.toHaveBeenCalled();
		expect(SummaryStore.readNoteFromBranch).not.toHaveBeenCalled();
		expect(SummaryStore.readLinearIssueFromBranch).not.toHaveBeenCalled();
	});

	it("skips refs whose archive content is missing from the orphan branch", async () => {
		const withRefs: CommitSummary = {
			...baseSummary,
			plans: [{ slug: "p-missing" } as never],
		} as CommitSummary;
		vi.mocked(SummaryStore.readPlanFromBranch).mockResolvedValueOnce(null);
		await regenerateSummary(withRefs, "/repo", config);
		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.plans).toBe("");
	});

	it("skips missing-archive notes the same way as missing-archive plans", async () => {
		const withRefs: CommitSummary = {
			...baseSummary,
			notes: [{ id: "n-missing" } as never],
		} as CommitSummary;
		vi.mocked(SummaryStore.readNoteFromBranch).mockResolvedValueOnce(null);
		await regenerateSummary(withRefs, "/repo", config);
		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.notes).toBe("");
	});

	it("skips missing-archive linear issues the same way as missing-archive plans", async () => {
		const withRefs: CommitSummary = {
			...baseSummary,
			linearIssues: [
				{
					archivedKey: "PROJ-1-deadbeef",
					ticketId: "PROJ-1",
					title: "T",
					url: "https://linear.app/x",
				} as never,
			],
		} as CommitSummary;
		vi.mocked(SummaryStore.readLinearIssueFromBranch).mockResolvedValueOnce(null);
		await regenerateSummary(withRefs, "/repo", config);
		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.linearIssues).toBe("");
	});

	it("preserves conversationTurns when generateSummary omits it from the result", async () => {
		vi.mocked(Summarizer.generateSummary).mockResolvedValueOnce({
			...successResult,
			conversationTurns: undefined,
		});
		const { updated } = await regenerateSummary(baseSummary, "/repo", config);
		// generateSummary did not return conversationTurns; updated should not
		// shadow the value with undefined (preserve baseSummary's behavior).
		expect("conversationTurns" in updated).toBe(false);
	});

	it("preserves recap when generateSummary omits it from the result", async () => {
		vi.mocked(Summarizer.generateSummary).mockResolvedValueOnce({
			...successResult,
			recap: undefined,
		});
		const { updated } = await regenerateSummary(baseSummary, "/repo", config);
		// generateSummary did not return recap — old summary's recap stays.
		expect(updated.recap).toBe("old recap");
	});

	it("falls back to summary.stats when summary.diffStats is absent (v3 legacy)", async () => {
		const legacy: CommitSummary = {
			...baseSummary,
			diffStats: undefined,
			stats: { filesChanged: 7, insertions: 70, deletions: 7 },
		} as CommitSummary;
		await regenerateSummary(legacy, "/repo", config);
		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.diffStats).toEqual({ filesChanged: 7, insertions: 70, deletions: 7 });
	});
});
