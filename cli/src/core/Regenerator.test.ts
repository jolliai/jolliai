import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, LlmConfig, StoredTranscript } from "../Types.js";
import * as GitOps from "./GitOps.js";
import { regenerateSummary } from "./Regenerator.js";
import * as Summarizer from "./Summarizer.js";
import * as SummaryStore from "./SummaryStore.js";
import * as TranscriptReader from "./TranscriptReader.js";

vi.mock("./Summarizer.js", () => ({ generateSummary: vi.fn() }));
// Mock the four orphan-branch / transcript IO entry points but route
// stripFunctionalMetadata to the REAL implementation. A hand-written stub
// would only strip a single level (the test author's level) — the real impl
// recurses through children at every step, and the regenerate v3 → v4
// migration depends on that recursion (grandchildren in squash-over-amend
// trees would otherwise leak own-hoist fields).
vi.mock("./SummaryStore.js", async () => {
	const actual = await vi.importActual<typeof import("./SummaryStore.js")>("./SummaryStore.js");
	return {
		readTranscriptsForCommits: vi.fn(),
		readLinearIssueFromBranch: vi.fn(),
		readPlanFromBranch: vi.fn(),
		readNoteFromBranch: vi.fn(),
		// Use the real normalizeToV4 — these tests exercise the full
		// regenerate path including the v3 → v4 migration step, so a mock
		// would defeat the regression coverage for child-only attachments.
		normalizeToV4: actual.normalizeToV4,
	};
});
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
		// Default: one stored transcript under the root commit hash.
		vi.mocked(SummaryStore.readTranscriptsForCommits).mockResolvedValue(
			new Map([[baseSummary.commitHash, storedTranscript]]),
		);
		vi.mocked(GitOps.getDiffContent).mockResolvedValue("DIFF");
		vi.mocked(TranscriptReader.buildMultiSessionContext).mockReturnValue("CONV");
		vi.mocked(SummaryStore.readLinearIssueFromBranch).mockResolvedValue(null);
		vi.mocked(SummaryStore.readPlanFromBranch).mockResolvedValue(null);
		vi.mocked(SummaryStore.readNoteFromBranch).mockResolvedValue(null);
		vi.mocked(Summarizer.generateSummary).mockResolvedValue(successResult);
	});

	it("still runs generateSummary when no transcript is stored (empty conversation)", async () => {
		vi.mocked(SummaryStore.readTranscriptsForCommits).mockResolvedValue(new Map());
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

	it("aggregates transcripts across the entire tree (root + children + grandchildren)", async () => {
		// Squash-over-amend tree: root has no transcript of its own (the
		// squash commit is synthetic), each leaf has its own conversation.
		// Regenerator must union every session so the LLM sees what the
		// webview's All Conversations card already showed the user.
		const tree: CommitSummary = {
			...baseSummary,
			commitHash: "rootsquash",
			children: [
				{
					...baseSummary,
					commitHash: "amend-root",
					children: [
						{
							...baseSummary,
							commitHash: "original-leaf",
						},
					],
				},
				{
					...baseSummary,
					commitHash: "other-leaf",
				},
			],
		} as CommitSummary;
		vi.mocked(SummaryStore.readTranscriptsForCommits).mockResolvedValue(
			new Map([
				// Root itself has no AI conversation (synthetic squash).
				[
					"amend-root",
					{
						sessions: [
							{
								sessionId: "amend-session",
								source: "claude",
								entries: [
									{ role: "human", content: "fix bug", timestamp: "2026-05-21T01:00:00Z" },
									{ role: "assistant", content: "done", timestamp: "2026-05-21T01:00:01Z" },
								],
							},
						],
					},
				],
				[
					"original-leaf",
					{
						sessions: [
							{
								sessionId: "leaf-session",
								source: "codex",
								entries: [{ role: "human", content: "first cut", timestamp: "2026-05-21T00:30:00Z" }],
							},
						],
					},
				],
				[
					"other-leaf",
					{
						sessions: [
							{
								sessionId: "other-session",
								source: "claude",
								entries: [{ role: "human", content: "side fix", timestamp: "2026-05-21T00:45:00Z" }],
							},
						],
					},
				],
			]),
		);

		await regenerateSummary(tree, "/repo", config);

		// readTranscriptsForCommits should be asked for the full tree hash set.
		const requestedHashes = vi.mocked(SummaryStore.readTranscriptsForCommits).mock.calls[0][0];
		expect(new Set(requestedHashes)).toEqual(new Set(["rootsquash", "amend-root", "original-leaf", "other-leaf"]));

		// buildMultiSessionContext receives a SessionTranscript[] union of all
		// three commits' sessions — one per leaf, 4 entries total.
		const sessionsArg = vi.mocked(TranscriptReader.buildMultiSessionContext).mock.calls[0][0];
		expect(sessionsArg).toHaveLength(3);
		const sessionIds = sessionsArg.map((s) => s.sessionId).sort();
		expect(sessionIds).toEqual(["amend-session", "leaf-session", "other-session"]);

		const totalEntries = sessionsArg.reduce((sum, s) => sum + s.entries.length, 0);
		expect(totalEntries).toBe(4);

		// generateSummary sees the aggregated transcriptEntries count.
		expect(Summarizer.generateSummary).toHaveBeenCalledWith(expect.objectContaining({ transcriptEntries: 4 }));
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

	it("clears recap when generateSummary omits it from the result (always-overwrite semantics)", async () => {
		// Confirm dialog promises Recap is OVERWRITTEN — when the LLM produces
		// no recap (e.g. commit has no major topics), the old recap must NOT
		// silently survive. Empty string explicitly communicates "no recap".
		vi.mocked(Summarizer.generateSummary).mockResolvedValueOnce({
			...successResult,
			recap: undefined,
		});
		const { updated } = await regenerateSummary(baseSummary, "/repo", config);
		expect(updated.recap).toBe("");
	});

	it("upgrades v3 legacy summaries to v4 and strips own-hoist fields from children", async () => {
		// Regression for the v3-with-children fallthrough: collectDisplayTopics
		// recurses into children when version < 4, which would merge stale
		// children topics with the freshly-regenerated root topics. Regenerator
		// upgrades to v4 (root-authoritative display) AND strips children so
		// countTopics / index entries also report the right value.
		const v3Legacy: CommitSummary = {
			...baseSummary,
			version: 3,
			topics: [{ title: "old root topic", trigger: "t", response: "r", decisions: "d" }],
			recap: "old root recap",
			children: [
				{
					...baseSummary,
					commitHash: "child000000000000",
					version: 3,
					topics: [{ title: "stale child topic", trigger: "t", response: "r", decisions: "d" }],
					recap: "stale child recap",
				},
			],
		} as CommitSummary;

		const { updated } = await regenerateSummary(v3Legacy, "/repo", config);

		expect(updated.version).toBe(4);
		expect(updated.topics?.[0]?.title).toBe("new topic");
		expect(updated.children).toHaveLength(1);
		// stripFunctionalMetadata removes the own-hoist fields from the child.
		expect(updated.children?.[0]?.topics).toBeUndefined();
		expect(updated.children?.[0]?.recap).toBeUndefined();
		// Identity fields are preserved on the stripped child.
		expect(updated.children?.[0]?.commitHash).toBe("child000000000000");
	});

	it("strips own-hoist fields recursively through grandchildren (squash-over-amend tree)", async () => {
		// Regression for the recursive-strip claim: a v3 squash-over-amend
		// shape carries topics/recap two levels deep. Regenerator must
		// flatten the entire subtree to root-authoritative or the index's
		// countTopics (which recurses) would still surface stale data.
		const v3Nested: CommitSummary = {
			...baseSummary,
			version: 3,
			children: [
				{
					...baseSummary,
					commitHash: "child000000000000",
					version: 3,
					topics: [{ title: "stale child topic", trigger: "t", response: "r", decisions: "d" }],
					recap: "stale child recap",
					children: [
						{
							...baseSummary,
							commitHash: "grandchild0000000",
							version: 3,
							topics: [
								{
									title: "stale grandchild topic",
									trigger: "t",
									response: "r",
									decisions: "d",
								},
							],
							recap: "stale grandchild recap",
						},
					],
				},
			],
		} as CommitSummary;

		const { updated } = await regenerateSummary(v3Nested, "/repo", config);

		expect(updated.version).toBe(4);
		// Child stripped.
		expect(updated.children?.[0]?.topics).toBeUndefined();
		expect(updated.children?.[0]?.recap).toBeUndefined();
		// Grandchild stripped too — proves recursion.
		expect(updated.children?.[0]?.children?.[0]?.topics).toBeUndefined();
		expect(updated.children?.[0]?.children?.[0]?.recap).toBeUndefined();
		// Identity fields preserved at every level.
		expect(updated.children?.[0]?.commitHash).toBe("child000000000000");
		expect(updated.children?.[0]?.children?.[0]?.commitHash).toBe("grandchild0000000");
	});

	it("bumps version to 4 even on a v3 LEAF summary with no children", async () => {
		// Guards against accidentally conditioning the version bump on the
		// `summary.children !== undefined` branch — leaf summaries must
		// upgrade too. (collectDisplayTopics still gates on version, so a v3
		// leaf without a bump would keep walking the legacy recursive path
		// even though there's nothing to recurse into.)
		const v3Leaf: CommitSummary = {
			...baseSummary,
			version: 3,
			children: undefined,
		} as CommitSummary;

		const { updated } = await regenerateSummary(v3Leaf, "/repo", config);

		expect(updated.version).toBe(4);
		expect(updated.children).toBeUndefined();
	});

	it("hoists v3 legacy child-only plans / notes / linearIssues / e2e / jolliDoc to root BEFORE stripping children", async () => {
		// v3 legacy regression: pre-Hoist amend / squash put attachments and
		// push doc IDs on the child node, not root. Without the hoist step,
		// stripFunctionalMetadata would erase the only copy and lose:
		//   - plan + note + linear-issue references (user attachments)
		//   - jolliDocId / jolliDocUrl (the next push would create a duplicate
		//     article instead of updating the existing one)
		//   - e2eTestGuide (user-generated test scenarios)
		const v3WithChildOnlyMeta: CommitSummary = {
			...baseSummary,
			version: 3,
			// root has none of these — they live only on the child below.
			plans: undefined,
			notes: undefined,
			linearIssues: undefined,
			e2eTestGuide: undefined,
			jolliDocId: undefined,
			jolliDocUrl: undefined,
			children: [
				{
					...baseSummary,
					commitHash: "leafabcdef000000",
					version: 3,
					plans: [
						{
							slug: "feature-x",
							title: "Feature X",
							editCount: 1,
							addedAt: "2026-05-20T00:00:00Z",
							updatedAt: "2026-05-20T00:00:00Z",
						},
					],
					notes: [
						{
							id: "note-1",
							title: "Note 1",
							format: "snippet",
							addedAt: "2026-05-20T00:00:00Z",
							updatedAt: "2026-05-20T00:00:00Z",
						},
					],
					linearIssues: [
						{
							archivedKey: "JOLLI-1-leaf",
							ticketId: "JOLLI-1",
							title: "Ticket 1",
							url: "https://linear.app/x",
							referencedAt: "2026-05-20T00:00:00Z",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
					e2eTestGuide: [
						{
							title: "Scenario 1",
							preconditions: "",
							steps: ["step 1"],
							expectedResults: ["ok"],
						} as never,
					],
					jolliDocId: 42,
					jolliDocUrl: "https://jolli.ai/d/42",
				},
			],
		} as CommitSummary;

		const { updated } = await regenerateSummary(v3WithChildOnlyMeta, "/repo", config);

		// Tree upgraded to v4 + children stripped (H1 invariant still holds).
		expect(updated.version).toBe(4);
		expect(updated.children?.[0]?.plans).toBeUndefined();
		expect(updated.children?.[0]?.notes).toBeUndefined();
		expect(updated.children?.[0]?.jolliDocId).toBeUndefined();

		// AND child-only metadata is hoisted to root — the rescue this test guards.
		expect(updated.plans?.[0]?.slug).toBe("feature-x");
		expect(updated.notes?.[0]?.id).toBe("note-1");
		expect(updated.linearIssues?.[0]?.archivedKey).toBe("JOLLI-1-leaf");
		expect(updated.e2eTestGuide?.[0]?.title).toBe("Scenario 1");
		expect(updated.jolliDocId).toBe(42);
		expect(updated.jolliDocUrl).toBe("https://jolli.ai/d/42");
	});

	it("feeds v3 child-only plans / notes / linear-issues into the LLM prompt (normalize before rebuild*Block)", async () => {
		// Regression for the H1 ordering bug: rebuild*Block used to read
		// summary.plans / .notes / .linearIssues directly, so v3 legacy
		// commits with attachments only on a child got an empty prompt
		// even though hoist later rescued the field for storage. After the
		// normalize-then-operate refactor, normalizeToV4 runs first, so
		// rebuild*Block sees the union root and the LLM sees the body.
		const v3ChildOnlyRefs: CommitSummary = {
			...baseSummary,
			version: 3,
			plans: undefined,
			notes: undefined,
			linearIssues: undefined,
			children: [
				{
					...baseSummary,
					commitHash: "leafabcdef000000",
					version: 3,
					plans: [
						{
							slug: "p-child",
							title: "Child plan",
							editCount: 1,
							addedAt: "2026-05-20T00:00:00Z",
							updatedAt: "2026-05-20T00:00:00Z",
						},
					],
					notes: [
						{
							id: "n-child",
							title: "Child note",
							format: "snippet",
							addedAt: "2026-05-20T00:00:00Z",
							updatedAt: "2026-05-20T00:00:00Z",
						},
					],
					linearIssues: [
						{
							archivedKey: "JOLLI-7-leaf",
							ticketId: "JOLLI-7",
							title: "T",
							url: "https://linear.app/y",
							referencedAt: "2026-05-20T00:00:00Z",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
				},
			],
		} as CommitSummary;
		vi.mocked(SummaryStore.readPlanFromBranch).mockResolvedValueOnce("plan body for p-child");
		vi.mocked(SummaryStore.readNoteFromBranch).mockResolvedValueOnce("note body for n-child");
		vi.mocked(SummaryStore.readLinearIssueFromBranch).mockResolvedValueOnce("linear body for JOLLI-7");

		await regenerateSummary(v3ChildOnlyRefs, "/repo", config);

		// The reads went through under the hoisted slug / id / archivedKey.
		expect(SummaryStore.readPlanFromBranch).toHaveBeenCalledWith("p-child", "/repo");
		expect(SummaryStore.readNoteFromBranch).toHaveBeenCalledWith("n-child", "/repo");
		expect(SummaryStore.readLinearIssueFromBranch).toHaveBeenCalledWith("JOLLI-7-leaf", "/repo");

		// And the bodies landed in the prompt.
		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.plans).toContain("plan body for p-child");
		expect(params.notes).toContain("note body for n-child");
		expect(params.linearIssues).toContain("linear body for JOLLI-7");
	});

	it("rescues child-only orphanedDocIds before stripping descendants", async () => {
		// Regression: prior to the normalize-then-operate refactor, the
		// updated summary picked up root.orphanedDocIds + jolliMeta's new
		// orphans, but stripFunctionalMetadata then dropped child-level
		// orphanedDocIds before they could be merged. Now normalizeToV4
		// unions everything to root first.
		const v3WithChildOrphans: CommitSummary = {
			...baseSummary,
			version: 3,
			orphanedDocIds: [1],
			children: [
				{
					...baseSummary,
					commitHash: "c-1",
					version: 3,
					orphanedDocIds: [2, 3],
				},
			],
		} as CommitSummary;

		const { updated } = await regenerateSummary(v3WithChildOrphans, "/repo", config);

		expect(new Set(updated.orphanedDocIds ?? [])).toEqual(new Set([1, 2, 3]));
		// Child stripped of its own copy.
		expect(updated.children?.[0]?.orphanedDocIds).toBeUndefined();
	});

	it("rescues orphanedDocIds from grandchildren too (3-level squash-over-squash)", async () => {
		// The shape that motivates M2 is squash-of-squash — the orphan IDs
		// can sit at depth 2, never depth 1. Confirms collectDescendantOrphaned
		// DocIds inside normalizeToV4 walks past the first hop, not just the
		// immediate children. Without recursion this test would fail (only
		// id 1 would surface, missing 4).
		const v3DeepOrphans: CommitSummary = {
			...baseSummary,
			version: 3,
			orphanedDocIds: [1],
			children: [
				{
					...baseSummary,
					commitHash: "c-1",
					version: 3,
					// No own orphans at depth 1 — proves we don't stop here.
					children: [
						{
							...baseSummary,
							commitHash: "g-1",
							version: 3,
							orphanedDocIds: [4, 5],
						},
					],
				},
			],
		} as CommitSummary;

		const { updated } = await regenerateSummary(v3DeepOrphans, "/repo", config);

		expect(new Set(updated.orphanedDocIds ?? [])).toEqual(new Set([1, 4, 5]));
		expect(updated.children?.[0]?.children?.[0]?.orphanedDocIds).toBeUndefined();
	});

	it("dedups same-slug plans across the v3 tree by picking the newer updatedAt", async () => {
		// normalizeToV4 runs on v3 input only (v4 fast-paths because the
		// invariant is already established — children shouldn't carry own
		// plans). On v3 legacy data where the same plan slug appears on
		// both root and a child, collectChildPlans picks the newer.
		const v3RootAndChildSame: CommitSummary = {
			...baseSummary,
			version: 3,
			plans: [
				{
					slug: "shared-plan",
					title: "Shared (root, older)",
					editCount: 1,
					addedAt: "2026-05-20T00:00:00Z",
					updatedAt: "2026-05-20T00:00:00Z",
				},
			],
			children: [
				{
					...baseSummary,
					commitHash: "child000",
					version: 3,
					plans: [
						{
							slug: "shared-plan",
							title: "Shared (child, newer)",
							editCount: 2,
							addedAt: "2026-05-20T00:00:00Z",
							updatedAt: "2026-05-21T00:00:00Z",
						},
					],
				},
			],
		} as CommitSummary;

		const { updated } = await regenerateSummary(v3RootAndChildSame, "/repo", config);

		expect(updated.plans).toHaveLength(1);
		expect(updated.plans?.[0]?.title).toBe("Shared (child, newer)");
	});

	it("is a no-op for the v4 + already-stripped children case (idempotent)", async () => {
		const v4Tree: CommitSummary = {
			...baseSummary,
			version: 4,
			children: [
				{
					...baseSummary,
					commitHash: "child111111111111",
					version: 4,
					// Children already stripped — no topics / recap.
					topics: undefined,
					recap: undefined,
				} as CommitSummary,
			],
		};

		const { updated } = await regenerateSummary(v4Tree, "/repo", config);

		expect(updated.version).toBe(4);
		expect(updated.children).toHaveLength(1);
		expect(updated.children?.[0]?.commitHash).toBe("child111111111111");
		expect(updated.children?.[0]?.topics).toBeUndefined();
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
