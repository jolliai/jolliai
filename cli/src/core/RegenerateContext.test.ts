import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, StoredTranscript } from "../Types.js";
import { loadRegenerateContext } from "./RegenerateContext.js";
import * as SummaryStore from "./SummaryStore.js";

vi.mock("./SummaryStore.js", () => ({
	readTranscript: vi.fn(),
}));

const baseSummary: CommitSummary = {
	version: 4,
	commitHash: "abc1234567890",
	commitMessage: "Test commit",
	commitAuthor: "tester",
	commitDate: "2026-05-21T00:00:00Z",
	branch: "main",
	generatedAt: "2026-05-21T00:01:00Z",
} as CommitSummary;

describe("loadRegenerateContext", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns counts and sources from the stored transcript", async () => {
		const stored: StoredTranscript = {
			sessions: [
				{
					sessionId: "s1",
					source: "claude",
					entries: [
						{ role: "human", content: "hi", timestamp: "2026-05-21T00:00:00Z" },
						{ role: "assistant", content: "hello", timestamp: "2026-05-21T00:00:01Z" },
					],
				},
				{
					sessionId: "s2",
					source: "codex",
					entries: [{ role: "human", content: "x", timestamp: "2026-05-21T00:00:02Z" }],
				},
			],
		};
		vi.mocked(SummaryStore.readTranscript).mockResolvedValue(stored);

		const ctx = await loadRegenerateContext(
			{
				...baseSummary,
				plans: [{ slug: "p1" } as never],
				notes: [],
				linearIssues: [{ archivedKey: "li-1" } as never],
			} as CommitSummary,
			"/repo",
		);

		expect(ctx).toEqual({
			entryCount: 3,
			sessionCount: 2,
			sources: ["Claude", "Codex"],
			humanTurns: 2,
			plansCount: 1,
			notesCount: 0,
			linearCount: 1,
		});
	});

	it("returns zero counts when transcript is missing (no special-case branch)", async () => {
		vi.mocked(SummaryStore.readTranscript).mockResolvedValue(null);
		const ctx = await loadRegenerateContext(baseSummary, "/repo");
		expect(ctx).toEqual({
			entryCount: 0,
			sessionCount: 0,
			sources: [],
			humanTurns: 0,
			plansCount: 0,
			notesCount: 0,
			linearCount: 0,
		});
	});

	it("deduplicates source list", async () => {
		vi.mocked(SummaryStore.readTranscript).mockResolvedValue({
			sessions: [
				{ sessionId: "a", source: "claude", entries: [] },
				{ sessionId: "b", source: "claude", entries: [] },
			],
		});
		const ctx = await loadRegenerateContext(baseSummary, "/repo");
		expect(ctx.sources).toEqual(["Claude"]);
	});

	it("preserves session-list source order (first occurrence wins)", async () => {
		vi.mocked(SummaryStore.readTranscript).mockResolvedValue({
			sessions: [
				{ sessionId: "a", source: "codex", entries: [] },
				{ sessionId: "b", source: "claude", entries: [] },
				{ sessionId: "c", source: "codex", entries: [] },
			],
		});
		const ctx = await loadRegenerateContext(baseSummary, "/repo");
		expect(ctx.sources).toEqual(["Codex", "Claude"]);
	});
});
