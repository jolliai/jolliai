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
		readReferenceFromBranch: vi.fn(),
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
		vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValue(null);
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

	it("clears summaryError marker on successful regenerate", async () => {
		const stale: CommitSummary = {
			...baseSummary,
			summaryError: "llm-failed",
			topics: [],
		};
		const { updated } = await regenerateSummary(stale, "/repo", config);
		expect(updated.summaryError).toBeUndefined();
		expect(updated.topics).toEqual(successResult.topics);
	});

	it("also clears summaryError when the regenerate input had legacy stopReason='error' but no marker", async () => {
		// Legacy summaries written before the summaryError field existed
		// still surface in the banner via isSummaryError(stopReason==="error").
		// Regenerate replaces `llm` wholesale with the new successResult,
		// which has stopReason=null, so isSummaryError naturally returns
		// false on the updated summary even though summaryError was never
		// set on the input. This test pins that observable behavior.
		const legacy: CommitSummary = {
			...baseSummary,
			llm: { model: "x", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, stopReason: "error" },
			topics: [],
		};
		const { updated } = await regenerateSummary(legacy, "/repo", config);
		expect(updated.summaryError).toBeUndefined();
		expect(updated.llm?.stopReason).not.toBe("error");
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
			references: [
				{
					archivedKey: "linear:JOLLI-1-abc",
					source: "linear",
					nativeId: "JOLLI-1",
					title: "T",
					url: "https://linear.app/x",
					referencedAt: "2026-05-21T00:00:00Z",
					sourceToolName: "mcp__linear__get_issue",
				} as never,
			],
		} as CommitSummary;
		vi.mocked(SummaryStore.readPlanFromBranch)
			.mockResolvedValueOnce("# Plan 1\n\nplan body 1")
			.mockResolvedValueOnce("# Plan 2\n\nplan body 2");
		vi.mocked(SummaryStore.readNoteFromBranch).mockResolvedValueOnce("note body");
		// v3 legacy linearIssues fall through legacyLinearIssuesToEntityCommitRefs,
		// which adds the `linear:` prefix; readReferenceFromBranch is called with the
		// prefixed form. The mocked content is v1 legacy frontmatter (ticketId
		// only) so the ReferenceStore parser synthesises source: "linear".
		vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(
			'---\nticketId: "JOLLI-1"\ntitle: "T"\nurl: "https://linear.app/x"\nreferencedAt: "2026-05-21T00:00:00Z"\nsourceToolName: "mcp__linear__get_issue"\n---\nissue body',
		);

		await regenerateSummary(withRefs, "/repo", config);

		// Third arg is the optional StorageProvider; tests pass undefined,
		// production code routes through bridge.regenerateSummary which supplies it.
		expect(SummaryStore.readPlanFromBranch).toHaveBeenCalledWith("p-1", "/repo", undefined);
		expect(SummaryStore.readPlanFromBranch).toHaveBeenCalledWith("p-2", "/repo", undefined);
		expect(SummaryStore.readNoteFromBranch).toHaveBeenCalledWith("n-1", "/repo", undefined);
		expect(SummaryStore.readReferenceFromBranch).toHaveBeenCalledWith(
			"linear",
			"linear:JOLLI-1-abc",
			"/repo",
			undefined,
		);

		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.plans).toContain("plan body 1");
		expect(params.plans).toContain("plan body 2");
		expect(params.notes).toContain("note body");
		expect(params.referenceBlocks).toContain("issue body");
		expect(params.referenceBlocks).toContain("<linear-issues>");
	});

	it("emits empty prompt blocks when no plans / notes / linear-issues are attached", async () => {
		await regenerateSummary(baseSummary, "/repo", config);
		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.plans).toBe("");
		expect(params.notes).toBe("");
		expect(params.referenceBlocks).toBe("");
		expect(SummaryStore.readPlanFromBranch).not.toHaveBeenCalled();
		expect(SummaryStore.readNoteFromBranch).not.toHaveBeenCalled();
		expect(SummaryStore.readReferenceFromBranch).not.toHaveBeenCalled();
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
			references: [
				{
					archivedKey: "linear:PROJ-1-deadbeef",
					source: "linear",
					nativeId: "PROJ-1",
					title: "T",
					url: "https://linear.app/x",
					referencedAt: "2026-05-21T00:00:00Z",
					sourceToolName: "mcp__linear__get_issue",
				} as never,
			],
		} as CommitSummary;
		vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(null);
		await regenerateSummary(withRefs, "/repo", config);
		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.referenceBlocks).toBe("");
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
			references: undefined,
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
					references: [
						{
							archivedKey: "linear:JOLLI-1-leafhash",
							source: "linear",
							nativeId: "JOLLI-1",
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
		expect(updated.references?.[0]?.archivedKey).toBe("linear:JOLLI-1-leafhash");
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
			references: undefined,
			children: [
				{
					...baseSummary,
					commitHash: "leafabcdef000000",
					version: 3,
					plans: [
						{
							slug: "p-child",
							title: "Child plan",
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
					references: [
						{
							archivedKey: "linear:JOLLI-7-leafhash",
							source: "linear",
							nativeId: "JOLLI-7",
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
		// Raw legacy markdown — readEntityMarkdownFromString returns null (no
		// frontmatter), so the renderer falls back to embedding the raw body
		// in the synthesised Reference.description.
		vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce("linear body for JOLLI-7");

		await regenerateSummary(v3ChildOnlyRefs, "/repo", config);

		// The reads went through under the hoisted slug / id / archivedKey.
		expect(SummaryStore.readPlanFromBranch).toHaveBeenCalledWith("p-child", "/repo", undefined);
		expect(SummaryStore.readNoteFromBranch).toHaveBeenCalledWith("n-child", "/repo", undefined);
		// legacyLinearIssuesToEntityCommitRefs prepends `linear:` to the
		// archivedKey before dispatch, so readReferenceFromBranch sees the
		// prefixed form. readReferenceFromBranch's own fallback path strips
		// `linear:` and reads the legacy on-disk path.
		expect(SummaryStore.readReferenceFromBranch).toHaveBeenCalledWith(
			"linear",
			"linear:JOLLI-7-leafhash",
			"/repo",
			undefined,
		);

		// And the bodies landed in the prompt.
		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.plans).toContain("plan body for p-child");
		expect(params.notes).toContain("note body for n-child");
		expect(params.referenceBlocks).toContain("linear body for JOLLI-7");
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

	it("truncates oversized plan bodies at PLAN_MAX_CHARS (20000) so a pathological plan can't blow out the prompt", async () => {
		// Without per-item truncation, a 100KB plan body would be embedded
		// verbatim in the <plan> block and dominate the LLM call cost.
		const withBigPlan: CommitSummary = {
			...baseSummary,
			plans: [
				{
					slug: "huge",
					title: "Huge",
					addedAt: "2026-05-20T00:00:00Z",
					updatedAt: "2026-05-20T00:00:00Z",
				} as never,
			],
		} as CommitSummary;
		const big = "x".repeat(50000);
		vi.mocked(SummaryStore.readPlanFromBranch).mockResolvedValueOnce(big);

		await regenerateSummary(withBigPlan, "/repo", config);

		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		// Truncation marker present, body cut to ~20000 chars (plus the
		// truncation tail) rather than the full 50000.
		expect(params.plans).toContain("[truncated,");
		expect((params.plans ?? "").length).toBeLessThan(30000);
	});

	it("truncates oversized linear-issue bodies at LINEAR_MAX_CHARS (4000)", async () => {
		const withBigLinear: CommitSummary = {
			...baseSummary,
			references: [
				{
					archivedKey: "linear:JOLLI-1-abc",
					source: "linear",
					nativeId: "JOLLI-1",
					title: "T",
					url: "https://linear.app/x",
					referencedAt: "2026-05-21T00:00:00Z",
					sourceToolName: "mcp__linear__get_issue",
				} as never,
			],
		} as CommitSummary;
		const big = "y".repeat(10000);
		vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(big);

		await regenerateSummary(withBigLinear, "/repo", config);

		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.referenceBlocks).toContain("[truncated,");
	});

	it("caps the total <linear-issues> block at LINEAR_TOTAL_CHARS (30000) by dropping the oldest", async () => {
		const mkRef = (key: string, referencedAt: string) =>
			({
				archivedKey: `linear:${key}`,
				source: "linear",
				nativeId: key,
				title: key,
				url: "https://linear.app/x",
				referencedAt,
				sourceToolName: "mcp__linear__get_issue",
			}) as never;
		const withMany: CommitSummary = {
			...baseSummary,
			references: [
				mkRef("oldest", "2026-05-18T00:00:00Z"),
				mkRef("middle", "2026-05-19T00:00:00Z"),
				mkRef("newer", "2026-05-20T00:00:00Z"),
				mkRef("newest", "2026-05-21T00:00:00Z"),
				mkRef("freshest", "2026-05-22T00:00:00Z"),
				mkRef("future", "2026-05-23T00:00:00Z"),
				mkRef("further", "2026-05-24T00:00:00Z"),
				mkRef("furthest", "2026-05-25T00:00:00Z"),
				mkRef("beyond", "2026-05-26T00:00:00Z"),
			],
		} as CommitSummary;
		const big = "y".repeat(4000);
		vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValue(big);

		await regenerateSummary(withMany, "/repo", config);

		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		// Newest selected; oldest dropped under greedy newest-first.
		expect(params.referenceBlocks).toContain('id="beyond"');
		expect(params.referenceBlocks).not.toContain('id="oldest"');
	});

	it("truncates oversized note bodies at NOTE_MAX_CHARS (4000) and caps total at NOTE_TOTAL_CHARS (12000)", async () => {
		const mkNote = (id: string, updatedAt: string) =>
			({
				id,
				title: id,
				format: "snippet",
				addedAt: updatedAt,
				updatedAt,
			}) as never;
		const withManyNotes: CommitSummary = {
			...baseSummary,
			notes: [
				mkNote("oldest-note", "2026-05-18T00:00:00Z"),
				mkNote("middle-note", "2026-05-19T00:00:00Z"),
				mkNote("newer-note", "2026-05-20T00:00:00Z"),
				mkNote("newest-note", "2026-05-21T00:00:00Z"),
				mkNote("freshest-note", "2026-05-22T00:00:00Z"),
			],
		} as CommitSummary;
		const big = "n".repeat(8000);
		vi.mocked(SummaryStore.readNoteFromBranch).mockResolvedValue(big);

		await regenerateSummary(withManyNotes, "/repo", config);

		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		// 4000-char per-note hits truncate; total cap kicks in around 3 notes.
		expect(params.notes).toContain("[truncated,");
		expect(params.notes).toContain('id="freshest-note"');
		expect(params.notes).not.toContain('id="oldest-note"');
	});

	it("preserves transcript session.source when stored session has a source set", async () => {
		// And omits the `source` key when StoredSession.source is undefined —
		// the conditional spread covers the optional-field shape that the
		// SessionTranscript consumer (buildMultiSessionContext) expects.
		vi.mocked(SummaryStore.readTranscriptsForCommits).mockResolvedValue(
			new Map([
				[
					baseSummary.commitHash,
					{
						sessions: [
							// One with source, one without — exercises both branches
							// of the `s.source !== undefined ? ... : {}` spread.
							{ sessionId: "with-src", source: "claude", entries: [] },
							{ sessionId: "no-src", entries: [] },
						],
					},
				],
			]),
		);

		await regenerateSummary(baseSummary, "/repo", config);

		const sessionsArg = vi.mocked(TranscriptReader.buildMultiSessionContext).mock.calls[0][0];
		expect(sessionsArg[0]).toMatchObject({ sessionId: "with-src", source: "claude" });
		expect(sessionsArg[1]).toMatchObject({ sessionId: "no-src" });
		expect(sessionsArg[1]).not.toHaveProperty("source");
	});

	it("preserves transcript transcriptPath when stored session carries it (vs the '(stored)' fallback)", async () => {
		// Default fixture uses no transcriptPath → we fall back to "(stored)".
		// This case feeds a real one through so the ?? branch the other side
		// of that nullish-coalesce gets exercised.
		vi.mocked(SummaryStore.readTranscriptsForCommits).mockResolvedValue(
			new Map([
				[
					baseSummary.commitHash,
					{
						sessions: [
							{
								sessionId: "with-path",
								source: "claude",
								transcriptPath: "/abs/path/to/transcript.jsonl",
								entries: [],
							},
						],
					},
				],
			]),
		);

		await regenerateSummary(baseSummary, "/repo", config);

		const sessionsArg = vi.mocked(TranscriptReader.buildMultiSessionContext).mock.calls[0][0];
		expect(sessionsArg[0]?.transcriptPath).toBe("/abs/path/to/transcript.jsonl");
	});

	it("falls back to summary.stats when diffStats is absent (v3 legacy)", async () => {
		// normalizeToV4 doesn't touch diffStats / stats, so a v3 legacy
		// commit whose original summary only carried `.stats` still needs
		// the `?? normalized.stats` fallback before generateSummary sees it.
		const v3Stats: CommitSummary = {
			...baseSummary,
			version: 3,
			diffStats: undefined,
			stats: { filesChanged: 7, insertions: 9, deletions: 11 },
		} as CommitSummary;

		await regenerateSummary(v3Stats, "/repo", config);

		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.diffStats).toEqual({ filesChanged: 7, insertions: 9, deletions: 11 });
	});

	it("falls back to zero diffStats when both diffStats and stats are absent", async () => {
		const noStats: CommitSummary = {
			...baseSummary,
			diffStats: undefined,
			stats: undefined,
		} as CommitSummary;

		await regenerateSummary(noStats, "/repo", config);

		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.diffStats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
	});

	it("omits conversationTurns from the updated summary when generateSummary returns it undefined", async () => {
		vi.mocked(Summarizer.generateSummary).mockResolvedValueOnce({
			...successResult,
			conversationTurns: undefined,
		});

		const { updated } = await regenerateSummary(baseSummary, "/repo", config);

		expect("conversationTurns" in updated).toBe(false);
	});

	it("does not crash when linearIssues / notes refs lack their timestamp fields (legacy v3)", async () => {
		// Defensive `?? ""` against legacy data with no referencedAt /
		// updatedAt / title / sourceToolName. Two refs each so the Array.sort
		// comparator actually runs (a single-element array short-circuits the
		// comparator). All four optional ref fields are set undefined so every
		// `?? ""` falsy branch in rebuildReferenceBlocks fires.
		const legacyTimestamps: CommitSummary = {
			...baseSummary,
			references: [
				{
					archivedKey: "linear:L-1",
					source: "linear",
					nativeId: "T1",
					title: undefined,
					url: undefined,
					referencedAt: undefined,
					sourceToolName: undefined,
				} as never,
				{
					archivedKey: "linear:L-2",
					source: "linear",
					nativeId: "T2",
					title: undefined,
					url: undefined,
					referencedAt: undefined,
					sourceToolName: undefined,
				} as never,
			],
			notes: [
				{ id: "n-1", title: "n1", format: "snippet", updatedAt: undefined } as never,
				{ id: "n-2", title: "n2", format: "snippet", updatedAt: undefined } as never,
			],
		} as CommitSummary;
		vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValue("LB");
		vi.mocked(SummaryStore.readNoteFromBranch).mockResolvedValue("NB");

		await expect(regenerateSummary(legacyTimestamps, "/repo", config)).resolves.toBeDefined();
		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.referenceBlocks).toContain("LB");
		expect(params.notes).toContain("NB");
	});

	it("omits the <url> line when ReferenceCommitRef.url is missing", async () => {
		// Legacy/corrupt ReferenceCommitRef may lack the url field — the
		// adapter's renderPromptBlock receives a Reference whose url is "" so
		// escapeForText doesn't choke. renderOne omits the <url> line entirely
		// for an empty/undefined url rather than emitting `<url></url>`.
		const noUrl: CommitSummary = {
			...baseSummary,
			references: [
				{
					archivedKey: "linear:JOLLI-9-abc",
					source: "linear",
					nativeId: "JOLLI-9",
					title: "T",
					url: undefined,
					referencedAt: "2026-05-21T00:00:00Z",
					sourceToolName: "mcp__linear__get_issue",
				} as never,
			],
		} as CommitSummary;
		vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce("body");

		await regenerateSummary(noUrl, "/repo", config);

		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.referenceBlocks).not.toContain("<url>");
		expect(params.referenceBlocks).toContain('<issue id="JOLLI-9">');
	});

	it("caps the total <plans> block at PLAN_TOTAL_CHARS (60000) and drops the oldest plan when exceeded", async () => {
		// 4 plans, each at PLAN_MAX_CHARS — fits 3 within 60000 budget,
		// drops the 4th (oldest). Confirms greedy-newest-first selection.
		const mkPlan = (slug: string, updatedAt: string) =>
			({
				slug,
				title: slug,
				addedAt: updatedAt,
				updatedAt,
			}) as never;
		const withManyPlans: CommitSummary = {
			...baseSummary,
			plans: [
				mkPlan("oldest", "2026-05-18T00:00:00Z"),
				mkPlan("middle", "2026-05-19T00:00:00Z"),
				mkPlan("newer", "2026-05-20T00:00:00Z"),
				mkPlan("newest", "2026-05-21T00:00:00Z"),
			],
		} as CommitSummary;
		const big = "x".repeat(20000);
		vi.mocked(SummaryStore.readPlanFromBranch).mockResolvedValue(big);

		await regenerateSummary(withManyPlans, "/repo", config);

		const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
		expect(params.plans).toContain("newest");
		expect(params.plans).toContain("newer");
		// The 4th (oldest) plan is the one dropped under greedy newest-first.
		expect(params.plans).not.toContain('slug="oldest"');
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

	describe("rebuildReferenceBlocks — multi-source v5+", () => {
		it("rebuilds blocks for v5+ summary with entities[] field (Linear only) via readReferenceFromBranch", async () => {
			// v5+ summaries carry an `entities` field with the `<source>:<bareKey>`
			// archive form. Regenerator dispatches via readReferenceFromBranch and
			// the LinearAdapter renders the <linear-issues> block exactly like
			// the first-run extractor path would.
			const v5Linear: CommitSummary = {
				...baseSummary,
				references: [
					{
						archivedKey: "linear:PROJ-1-abc12345",
						source: "linear",
						nativeId: "PROJ-1",
						title: "Linear ticket",
						url: "https://linear.app/x",
						referencedAt: "2026-05-21T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				],
			} as CommitSummary;
			vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-1"',
					'title: "Linear ticket"',
					'url: "https://linear.app/x"',
					'referencedAt: "2026-05-21T00:00:00Z"',
					'sourceToolName: "mcp__linear__get_issue"',
					"---",
					"linear description body",
				].join("\n"),
			);

			await regenerateSummary(v5Linear, "/repo", config);

			expect(SummaryStore.readReferenceFromBranch).toHaveBeenCalledWith(
				"linear",
				"linear:PROJ-1-abc12345",
				"/repo",
				undefined,
			);
			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			expect(params.referenceBlocks).toContain("<linear-issues>");
			expect(params.referenceBlocks).toContain('id="PROJ-1"');
			expect(params.referenceBlocks).toContain("linear description body");
		});

		it("falls back to legacy linearIssues projection when entities is absent (v3/v4)", async () => {
			// archivedKey on legacy is bare (no `linear:` prefix); the projection
			// helper adds it before calling readReferenceFromBranch. The fallback
			// inside readReferenceFromBranch strips it back to read the legacy
			// `linear-issues/<bareKey>.md` path on disk — verified by the call
			// argument including the `linear:` prefix, exactly as the projection
			// specifies.
			const v3Legacy: CommitSummary = {
				...baseSummary,
				version: 4,
				references: [
					{
						archivedKey: "linear:PROJ-1-abc12345",
						source: "linear",
						nativeId: "PROJ-1",
						title: "Legacy ticket",
						url: "https://linear.app/x",
						referencedAt: "2026-05-21T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				],
			} as CommitSummary;
			vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(
				[
					"---",
					'ticketId: "PROJ-1"',
					'title: "Legacy ticket"',
					'url: "https://linear.app/x"',
					'referencedAt: "2026-05-21T00:00:00Z"',
					'sourceToolName: "mcp__linear__get_issue"',
					"---",
					"legacy body",
				].join("\n"),
			);

			await regenerateSummary(v3Legacy, "/repo", config);

			expect(SummaryStore.readReferenceFromBranch).toHaveBeenCalledWith(
				"linear",
				"linear:PROJ-1-abc12345",
				"/repo",
				undefined,
			);
			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			expect(params.referenceBlocks).toContain("<linear-issues>");
			expect(params.referenceBlocks).toContain("legacy body");
		});

		it("returns empty string when references is absent / empty", async () => {
			const empty: CommitSummary = {
				...baseSummary,
				references: [],
			} as CommitSummary;
			await regenerateSummary(empty, "/repo", config);
			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			expect(params.referenceBlocks).toBe("");
			expect(SummaryStore.readReferenceFromBranch).not.toHaveBeenCalled();
		});

		it("skips entities whose orphan-branch markdown is missing but still completes (warn-and-continue)", async () => {
			// Mix of present + missing — the present one still renders, the
			// missing one is silently dropped (warn-only). Mirrors the first-run
			// extractor behavior where a deleted MCP entity doesn't break the
			// commit pipeline.
			const mixed: CommitSummary = {
				...baseSummary,
				references: [
					{
						archivedKey: "linear:PROJ-1-abc12345",
						source: "linear",
						nativeId: "PROJ-1",
						title: "Present",
						url: "https://linear.app/x",
						referencedAt: "2026-05-22T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
					{
						archivedKey: "linear:PROJ-2-deadbeef",
						source: "linear",
						nativeId: "PROJ-2",
						title: "Missing",
						url: "https://linear.app/y",
						referencedAt: "2026-05-21T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				],
			} as CommitSummary;
			vi.mocked(SummaryStore.readReferenceFromBranch)
				.mockResolvedValueOnce(
					[
						"---",
						'source: "linear"',
						'nativeId: "PROJ-1"',
						'title: "Present"',
						'url: "https://linear.app/x"',
						'referencedAt: "2026-05-22T00:00:00Z"',
						'sourceToolName: "mcp__linear__get_issue"',
						"---",
						"present body",
					].join("\n"),
				)
				.mockResolvedValueOnce(null);

			await regenerateSummary(mixed, "/repo", config);

			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			expect(params.referenceBlocks).toContain('id="PROJ-1"');
			expect(params.referenceBlocks).toContain("present body");
			expect(params.referenceBlocks).not.toContain('id="PROJ-2"');
		});

		it("forwards optional status / priority / labels from the ReferenceCommitRef into the rendered block", async () => {
			// These optional fields are conditionally spread into the synthesised
			// Reference passed to the adapter; the adapter then renders them as
			// XML attrs on the issue tag. Drift here would silently strip them
			// from regenerate-time prompts, leading to LLM output that differs
			// from the first-run path on the same commit.
			const withMeta: CommitSummary = {
				...baseSummary,
				references: [
					{
						archivedKey: "linear:PROJ-9-feedabcd",
						source: "linear",
						nativeId: "PROJ-9",
						title: "Meta ticket",
						url: "https://linear.app/x",
						referencedAt: "2026-05-22T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
						fields: [
							{ key: "status", label: "Status", value: "In Review", icon: "circle-large-filled" },
							{ key: "priority", label: "Priority", value: "High", icon: "flame" },
							{ key: "labels", label: "Labels", value: "backend, auth", icon: "tag" },
						],
					},
				],
			} as CommitSummary;
			vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-9"',
					'title: "Meta ticket"',
					'url: "https://linear.app/x"',
					'referencedAt: "2026-05-22T00:00:00Z"',
					'sourceToolName: "mcp__linear__get_issue"',
					"---",
					"meta body",
				].join("\n"),
			);

			await regenerateSummary(withMeta, "/repo", config);

			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			expect(params.referenceBlocks).toContain('status="In Review"');
			expect(params.referenceBlocks).toContain('priority="High"');
			expect(params.referenceBlocks).toContain('labels="backend, auth"');
		});

		it("forwards the full fields bag for GitHub (assignees / milestone / entity-type) — regression guard for the pre-bag drop", async () => {
			// The pre-bag Regenerator only copied status/priority/labels, silently
			// dropping GitHub's assignees / milestone / entityType at regenerate
			// time. The opaque fields bag carries the whole set verbatim; this pins
			// it so a regression to hardcoded-key copying is caught.
			const ghSummary: CommitSummary = {
				...baseSummary,
				references: [
					{
						archivedKey: "github:jolliai/jolli#9-feedabcd",
						source: "github",
						nativeId: "jolliai/jolli#9",
						title: "GH issue",
						url: "https://github.com/jolliai/jolli/issues/9",
						referencedAt: "2026-05-22T00:00:00Z",
						sourceToolName: "mcp__github__issue_read",
						fields: [
							{ key: "status", label: "Status", value: "open", icon: "circle-large-filled" },
							{ key: "labels", label: "Labels", value: "bug, p1", icon: "tag" },
							{ key: "assignees", label: "Assignees", value: "alice, bob", icon: "account" },
							{ key: "milestone", label: "Milestone", value: "v1.0", icon: "milestone" },
							{ key: "entity-type", label: "Type", value: "Bug", icon: "symbol-class" },
						],
					},
				],
			} as CommitSummary;
			vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(
				[
					"---",
					'source: "github"',
					'nativeId: "jolliai/jolli#9"',
					'title: "GH issue"',
					'url: "https://github.com/jolliai/jolli/issues/9"',
					'referencedAt: "2026-05-22T00:00:00Z"',
					'sourceToolName: "mcp__github__issue_read"',
					"---",
					"gh body",
				].join("\n"),
			);

			await regenerateSummary(ghSummary, "/repo", config);

			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			expect(params.referenceBlocks).toContain('assignees="alice, bob"');
			expect(params.referenceBlocks).toContain('milestone="v1.0"');
			expect(params.referenceBlocks).toContain('entity-type="Bug"');
		});

		it("truncates an oversized description exactly once (regenerate matches first-run, no double-cut)", async () => {
			// The pre-bag path truncated the description up-front AND again inside
			// the adapter, double-cutting an oversized body and emitting a wrong
			// "…[truncated, N more chars]" count. With the single adapter-side
			// truncation, the count reflects the true overflow (5000 - 4000 = 1000).
			const bigBody = "A".repeat(5000); // linear per-reference cap is 4000
			const bigSummary: CommitSummary = {
				...baseSummary,
				references: [
					{
						archivedKey: "linear:PROJ-7-feedabcd",
						source: "linear",
						nativeId: "PROJ-7",
						title: "Big",
						url: "https://linear.app/x",
						referencedAt: "2026-05-22T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				],
			} as CommitSummary;
			vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-7"',
					'title: "Big"',
					'url: "https://linear.app/x"',
					'referencedAt: "2026-05-22T00:00:00Z"',
					'sourceToolName: "mcp__linear__get_issue"',
					"---",
					bigBody,
				].join("\n"),
			);

			await regenerateSummary(bigSummary, "/repo", config);

			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			expect(params.referenceBlocks).toContain("…[truncated, 1000 more chars]");
		});

		it("fallback (unparseable frontmatter) also truncates exactly once", async () => {
			// When the orphan markdown can't be parsed as frontmatter, the raw body
			// is embedded as description. It must flow through untruncated so the
			// adapter truncates it exactly once — same correct count as the parsed
			// path (no double-cut on corrupt data either).
			const bigRaw = "Z".repeat(5000); // not valid frontmatter (no leading ---)
			const corruptSummary: CommitSummary = {
				...baseSummary,
				references: [
					{
						archivedKey: "linear:PROJ-8-feedabcd",
						source: "linear",
						nativeId: "PROJ-8",
						title: "Corrupt",
						url: "https://linear.app/x",
						referencedAt: "2026-05-22T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				],
			} as CommitSummary;
			vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(bigRaw);

			await regenerateSummary(corruptSummary, "/repo", config);

			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			expect(params.referenceBlocks).toContain("…[truncated, 1000 more chars]");
		});

		it("groups two entities of the same source into a single block (existing-bucket push path)", async () => {
			// Two linear refs in one summary must share a single <linear-issues>
			// wrapper — the `if (bucket) bucket.push(...)` branch (existing
			// bucket, append) is otherwise unhit when every test feeds one entity
			// per source.
			const twoLinear: CommitSummary = {
				...baseSummary,
				references: [
					{
						archivedKey: "linear:A-1-aaa11111",
						source: "linear",
						nativeId: "A-1",
						title: "A1",
						url: "https://linear.app/a",
						referencedAt: "2026-05-22T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
					{
						archivedKey: "linear:A-2-bbb22222",
						source: "linear",
						nativeId: "A-2",
						title: "A2",
						url: "https://linear.app/b",
						referencedAt: "2026-05-21T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				],
			} as CommitSummary;
			const md = (id: string, body: string) =>
				[
					"---",
					'source: "linear"',
					`nativeId: "${id}"`,
					`title: "${id}"`,
					`url: "https://linear.app/${id}"`,
					'referencedAt: "2026-05-22T00:00:00Z"',
					'sourceToolName: "mcp__linear__get_issue"',
					"---",
					body,
				].join("\n");
			vi.mocked(SummaryStore.readReferenceFromBranch)
				.mockResolvedValueOnce(md("A-1", "body-A1"))
				.mockResolvedValueOnce(md("A-2", "body-A2"));

			await regenerateSummary(twoLinear, "/repo", config);

			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			// Single <linear-issues> wrapper holds both <issue> entries.
			const opens = (params.referenceBlocks?.match(/<linear-issues>/g) ?? []).length;
			expect(opens).toBe(1);
			expect(params.referenceBlocks).toContain('id="A-1"');
			expect(params.referenceBlocks).toContain('id="A-2"');
		});

		it("synthesises a minimal Reference when the orphan-branch markdown is unparseable, including optional status/priority/labels", async () => {
			// Markdown without `---` frontmatter falls through readEntityMarkdownFromString
			// (returns null) — the renderer then builds a minimal Reference using
			// the commit-time ref metadata and embeds the raw body as description.
			// Optional status/priority/labels on the ReferenceCommitRef must still
			// flow into the synthesised ref so the adapter renders them.
			const v5Unparseable: CommitSummary = {
				...baseSummary,
				references: [
					{
						archivedKey: "linear:PROJ-42-deadbeef",
						source: "linear",
						nativeId: "PROJ-42",
						title: "Bare",
						url: "https://linear.app/x",
						referencedAt: "2026-05-22T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
						fields: [
							{ key: "status", label: "Status", value: "Done", icon: "circle-large-filled" },
							{ key: "priority", label: "Priority", value: "Low", icon: "flame" },
							{ key: "labels", label: "Labels", value: "chore", icon: "tag" },
						],
					},
				],
			} as CommitSummary;
			// Raw body — no `---` frontmatter, parser returns null.
			vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(
				"raw legacy body without frontmatter",
			);

			await regenerateSummary(v5Unparseable, "/repo", config);

			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			expect(params.referenceBlocks).toContain('status="Done"');
			expect(params.referenceBlocks).toContain('priority="Low"');
			expect(params.referenceBlocks).toContain('labels="chore"');
			expect(params.referenceBlocks).toContain("raw legacy body without frontmatter");
		});

		it("omits the description block when parsed markdown body is empty (parsed.description undefined branch)", async () => {
			// Frontmatter-only markdown (no body): ReferenceStore.parseMarkdown
			// returns a Reference without `description`. Regenerator's
			// description-truncate ternary must skip — otherwise the adapter
			// receives `description: undefined` which would crash truncate().
			const v5NoDesc: CommitSummary = {
				...baseSummary,
				references: [
					{
						archivedKey: "linear:PROJ-100-feedface",
						source: "linear",
						nativeId: "PROJ-100",
						title: "NoBody",
						url: "https://linear.app/x",
						referencedAt: "2026-05-22T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				],
			} as CommitSummary;
			vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-100"',
					'title: "NoBody"',
					'url: "https://linear.app/x"',
					'referencedAt: "2026-05-22T00:00:00Z"',
					'sourceToolName: "mcp__linear__get_issue"',
					"---",
				].join("\n"),
			);

			await regenerateSummary(v5NoDesc, "/repo", config);

			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			expect(params.referenceBlocks).toContain('id="PROJ-100"');
			expect(params.referenceBlocks).not.toContain("<description>");
		});

		it("renders one block per source in registry order (currently linear-only referenced)", async () => {
			// The registry-driven render loop (`getRegistry().all()` +
			// `SourceEngine.renderBlock`) is order-stable; with only a linear
			// reference present, only the linear block is produced. This test
			// pins the iteration shape so a future jira entity in the same
			// summary won't change the linear block's byte position.
			const linearOnly: CommitSummary = {
				...baseSummary,
				references: [
					{
						archivedKey: "linear:PROJ-1-abc12345",
						source: "linear",
						nativeId: "PROJ-1",
						title: "L1",
						url: "https://linear.app/x",
						referencedAt: "2026-05-22T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				],
			} as CommitSummary;
			vi.mocked(SummaryStore.readReferenceFromBranch).mockResolvedValueOnce(
				[
					"---",
					'source: "linear"',
					'nativeId: "PROJ-1"',
					'title: "L1"',
					'url: "https://linear.app/x"',
					'referencedAt: "2026-05-22T00:00:00Z"',
					'sourceToolName: "mcp__linear__get_issue"',
					"---",
					"L1 body",
				].join("\n"),
			);

			await regenerateSummary(linearOnly, "/repo", config);

			const params = vi.mocked(Summarizer.generateSummary).mock.calls[0][0];
			// Only one block, leading with `<linear-issues>`.
			expect(params.referenceBlocks?.startsWith("<linear-issues>")).toBe(true);
		});
	});
});
