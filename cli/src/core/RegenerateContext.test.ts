import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, StoredTranscript } from "../Types.js";
import { loadRegenerateContext } from "./RegenerateContext.js";
import * as SummaryStore from "./SummaryStore.js";

vi.mock("./SummaryStore.js", async () => {
	const actual = await vi.importActual<typeof import("./SummaryStore.js")>("./SummaryStore.js");
	return {
		readTranscriptsForCommits: vi.fn(),
		// Use the real normalizeToV4 so v3 legacy plan/note/linear counts
		// surface from children — the regression the v3 → v4 normalize
		// targets surfaces here too.
		normalizeToV4: actual.normalizeToV4,
	};
});

const baseSummary: CommitSummary = {
	version: 4,
	commitHash: "abc1234567890",
	commitMessage: "Test commit",
	commitAuthor: "tester",
	commitDate: "2026-05-21T00:00:00Z",
	branch: "main",
	generatedAt: "2026-05-21T00:01:00Z",
} as CommitSummary;

function singleHashMap(hash: string, stored: StoredTranscript): Map<string, StoredTranscript> {
	return new Map([[hash, stored]]);
}

describe("loadRegenerateContext", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns counts and sources from the stored transcript on a leaf summary", async () => {
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
		vi.mocked(SummaryStore.readTranscriptsForCommits).mockResolvedValue(
			singleHashMap(baseSummary.commitHash, stored),
		);

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

	it("returns zero counts when no transcript is stored anywhere in the tree", async () => {
		vi.mocked(SummaryStore.readTranscriptsForCommits).mockResolvedValue(new Map());
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

	it("deduplicates source list across the tree", async () => {
		vi.mocked(SummaryStore.readTranscriptsForCommits).mockResolvedValue(
			singleHashMap(baseSummary.commitHash, {
				sessions: [
					{ sessionId: "a", source: "claude", entries: [] },
					{ sessionId: "b", source: "claude", entries: [] },
				],
			}),
		);
		const ctx = await loadRegenerateContext(baseSummary, "/repo");
		expect(ctx.sources).toEqual(["Claude"]);
	});

	it("dedups sessionCount by source:sessionId when the same session appears in multiple commit transcripts", async () => {
		// A single AI session can have its entries spliced across multiple
		// commit transcripts (squash slicing, amend rewriting). The webview's
		// All Conversations card collapses these via source:sessionId and we
		// must match — otherwise the confirm dialog over-reports session
		// count and confuses the user.
		const tree: CommitSummary = {
			...baseSummary,
			commitHash: "root",
			children: [
				{ ...baseSummary, commitHash: "leaf-1" } as CommitSummary,
				{ ...baseSummary, commitHash: "leaf-2" } as CommitSummary,
			],
		} as CommitSummary;

		vi.mocked(SummaryStore.readTranscriptsForCommits).mockResolvedValue(
			new Map([
				[
					"leaf-1",
					{
						sessions: [
							{
								sessionId: "shared-session",
								source: "claude",
								entries: [{ role: "human", content: "h1", timestamp: "2026-05-21T00:00:00Z" }],
							},
						],
					},
				],
				[
					"leaf-2",
					{
						sessions: [
							{
								sessionId: "shared-session",
								source: "claude",
								entries: [{ role: "human", content: "h2", timestamp: "2026-05-21T01:00:00Z" }],
							},
						],
					},
				],
			]),
		);

		const ctx = await loadRegenerateContext(tree, "/repo");
		// 2 entries (one per commit slice), but only 1 session (same source:sessionId).
		expect(ctx.entryCount).toBe(2);
		expect(ctx.sessionCount).toBe(1);
	});

	it("counts v3 child-only attachments via the normalizeToV4 step", async () => {
		// Before the normalize-then-operate refactor, plansCount/notesCount/
		// linearCount only saw root.fields — for legacy v3 summaries where the
		// attachments lived on a child, the confirm dialog reported 0 even
		// when the LLM was about to be re-run on those very attachments.
		// Now they're hoisted to root by normalizeToV4 before counting.
		const v3WithChildAttachments: CommitSummary = {
			...baseSummary,
			version: 3,
			plans: undefined,
			notes: undefined,
			linearIssues: undefined,
			children: [
				{
					...baseSummary,
					commitHash: "child-hash",
					version: 3,
					plans: [
						{
							slug: "p-c",
							title: "child plan",
							editCount: 1,
							addedAt: "2026-05-20T00:00:00Z",
							updatedAt: "2026-05-20T00:00:00Z",
						},
					],
					notes: [
						{
							id: "n-c",
							title: "child note",
							format: "snippet",
							addedAt: "2026-05-20T00:00:00Z",
							updatedAt: "2026-05-20T00:00:00Z",
						},
					],
					linearIssues: [
						{
							archivedKey: "JOLLI-1-abc",
							ticketId: "JOLLI-1",
							title: "T",
							url: "https://linear.app/x",
							referencedAt: "2026-05-20T00:00:00Z",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				},
			],
		} as CommitSummary;

		vi.mocked(SummaryStore.readTranscriptsForCommits).mockResolvedValue(new Map());

		const ctx = await loadRegenerateContext(v3WithChildAttachments, "/repo");
		expect(ctx.plansCount).toBe(1);
		expect(ctx.notesCount).toBe(1);
		expect(ctx.linearCount).toBe(1);
	});

	it("aggregates counts + sources across the whole summary tree (squash / amend case)", async () => {
		// The webview's All Conversations card shows transcripts for EVERY
		// commit hash in the tree. loadRegenerateContext must match that
		// total or the confirm dialog under-reports entries and misleads
		// users into thinking the regenerate has less input than it does.
		const tree: CommitSummary = {
			...baseSummary,
			commitHash: "root-squash",
			children: [
				{ ...baseSummary, commitHash: "leaf-1" } as CommitSummary,
				{ ...baseSummary, commitHash: "leaf-2" } as CommitSummary,
			],
		} as CommitSummary;

		vi.mocked(SummaryStore.readTranscriptsForCommits).mockResolvedValue(
			new Map([
				[
					"leaf-1",
					{
						sessions: [
							{
								sessionId: "s-leaf1",
								source: "claude",
								entries: [
									{ role: "human", content: "h1", timestamp: "2026-05-21T00:00:00Z" },
									{ role: "assistant", content: "a1", timestamp: "2026-05-21T00:00:01Z" },
								],
							},
						],
					},
				],
				[
					"leaf-2",
					{
						sessions: [
							{
								sessionId: "s-leaf2",
								source: "codex",
								entries: [{ role: "human", content: "h2", timestamp: "2026-05-21T00:01:00Z" }],
							},
						],
					},
				],
			]),
		);

		const ctx = await loadRegenerateContext(tree, "/repo");

		// All 3 entries (2 from leaf-1, 1 from leaf-2) counted across 2 sessions.
		expect(ctx.entryCount).toBe(3);
		expect(ctx.sessionCount).toBe(2);
		expect(ctx.humanTurns).toBe(2);
		expect(new Set(ctx.sources)).toEqual(new Set(["Claude", "Codex"]));

		// readTranscriptsForCommits should have been asked for every hash
		// in the tree, including the synthetic root with no own transcript.
		const requested = vi.mocked(SummaryStore.readTranscriptsForCommits).mock.calls[0][0];
		expect(new Set(requested)).toEqual(new Set(["root-squash", "leaf-1", "leaf-2"]));
	});
});
