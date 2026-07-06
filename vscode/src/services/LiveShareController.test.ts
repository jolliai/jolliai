import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, PlanReference } from "../../../cli/src/Types.js";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
const { mockCreate, mockUpdate } = vi.hoisted(() => ({ mockCreate: vi.fn(), mockUpdate: vi.fn() }));
const { mockGetShare, mockPutShare } = vi.hoisted(() => ({
	mockGetShare: vi.fn(),
	mockPutShare: vi.fn(),
}));
const { mockLoad } = vi.hoisted(() => ({ mockLoad: vi.fn() }));
const { mockParseKey } = vi.hoisted(() => ({ mockParseKey: vi.fn() }));

vi.mock("./JolliPushOrchestrator.js", () => ({
	pushSummaryWithAttachments: mockPush,
	ShareBindingError: class ShareBindingError extends Error {
		constructor(readonly outcome: string) {
			super(outcome);
			this.name = "ShareBindingError";
		}
	},
}));
vi.mock("./JolliShareService.js", () => ({ createLiveShare: mockCreate, updateLiveShare: mockUpdate }));
vi.mock("../../../cli/src/core/BranchShareStore.js", () => ({
	getShare: mockGetShare,
	putBranchShare: mockPutShare,
}));
vi.mock("../views/BranchSummaryLoader.js", () => ({ loadBranchSummaries: mockLoad }));
vi.mock("../../../cli/src/core/GitOps.js", () => ({ getDefaultBranch: vi.fn().mockResolvedValue("main") }));
vi.mock("../util/GitRemoteUtils.js", async (importActual) => ({
	...(await importActual<typeof import("../util/GitRemoteUtils.js")>()),
	getCanonicalRepoUrl: vi.fn().mockResolvedValue("https://github.com/acme/repo"),
}));
vi.mock("../../../cli/src/core/KBPathResolver.js", () => ({ extractRepoName: () => "repo" }));
vi.mock("../../../cli/src/core/JolliApiUtils.js", () => ({ parseJolliApiKey: mockParseKey }));
vi.mock("../../../cli/src/core/SummaryStore.js", () => ({
	resolveEffectiveTopics: (s: CommitSummary) => s.topics ?? [],
	resolveEffectiveRecap: (s: CommitSummary) => s.recap,
}));
vi.mock("../views/SummaryUtils.js", () => ({ buildBranchRelativePath: (b: string) => b }));
vi.mock("../../../cli/src/core/SummaryExporter.js", () => ({ slugify: (b: string) => b.replace(/\//g, "-") }));
vi.mock("../util/Logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
	AttachmentPushError,
	BranchMismatchError,
	deriveShareDescription,
	generateLiveShare,
	NothingToShareError,
	pushBranchMemoriesToSpace,
	reconcileLiveShare,
	subjectFingerprint,
} from "./LiveShareController.js";
import { ShareBindingError } from "./JolliPushOrchestrator.js";
import { PluginOutdatedError } from "./JolliPushService.js";

// Maps a commit hash to a deterministic summary docId for assertions.
const SUMMARY_DOC = { A: 1001, B: 1002, C: 1003 } as const;

function plan(slug: string, updatedAt: string, jolliPlanDocId?: number): PlanReference {
	return { slug, title: "Plan", addedAt: updatedAt, updatedAt, ...(jolliPlanDocId && { jolliPlanDocId }) };
}

interface NoteFix {
	id: string;
	title: string;
	updatedAt: string;
	jolliNoteDocId?: number;
}
function note(id: string, updatedAt: string, jolliNoteDocId?: number): NoteFix {
	return { id, title: "Note", updatedAt, ...(jolliNoteDocId && { jolliNoteDocId }) };
}

function summary(
	commitHash: keyof typeof SUMMARY_DOC,
	plans: PlanReference[] = [],
	notes: NoteFix[] = [],
): CommitSummary {
	return {
		commitHash,
		branch: "feature/x",
		commitMessage: `commit ${commitHash}`,
		topics: [{ title: `t-${commitHash}` }],
		plans,
		notes,
	} as unknown as CommitSummary;
}

const storeSummarySpy = vi.fn().mockResolvedValue(undefined);
const deps = () => ({
	bridge: { storeSummary: storeSummarySpy } as never,
	workspaceRoot: "/repo",
	apiKey: "sk-jol-test",
	resolveBinding: vi.fn().mockResolvedValue({ status: "bound" }),
});

beforeEach(() => {
	vi.clearAllMocks();
	mockParseKey.mockReturnValue({ u: "https://acme.jolli.ai" });
	mockCreate.mockResolvedValue({
		shareId: 7,
		shareUrl: "https://acme.jolli.ai/b/x",
		expiresAt: "2026-09-01T00:00:00.000Z",
		visibility: "public",
		token: "tok_abcdefgh",
	});
	mockUpdate.mockResolvedValue({
		shareId: 7,
		shareUrl: "https://acme.jolli.ai/b/x",
		expiresAt: "2026-09-01T00:00:00.000Z",
		visibility: "public",
	});
	mockGetShare.mockResolvedValue(undefined);
	mockPutShare.mockResolvedValue(undefined);
	// Default push: echo a docId for the chosen plan/note attachments; summary doc per commit.
	type Att = { plans: PlanReference[]; notes: Array<{ id: string; title: string; jolliNoteDocId?: number }> };
	mockPush.mockImplementation((s: CommitSummary, _ctx: unknown, attachments?: Att) => {
		const plans = (attachments?.plans ?? []).map((p) => ({
			slug: p.slug,
			title: p.title,
			docId: p.jolliPlanDocId ?? 9000 + p.slug.length,
			url: "u",
		}));
		const notes = (attachments?.notes ?? []).map((n) => ({
			id: n.id,
			title: n.title,
			docId: n.jolliNoteDocId ?? 8000 + n.id.length,
			url: "u",
		}));
		return Promise.resolve({
			pushedDoc: {
				commitHash: s.commitHash,
				summaryDocId: SUMMARY_DOC[s.commitHash as keyof typeof SUMMARY_DOC],
				plans,
				notes,
			},
			updatedSummary: s,
			attachmentFailures: [],
			isUpdate: false,
			attachmentCount: plans.length + notes.length,
		});
	});
});

describe("subjectFingerprint", () => {
	it("moves when only the recap changes on a topics-less summary (share card stays fresh)", () => {
		const before = [{ ...summary("A"), topics: [], recap: "old recap" } as unknown as CommitSummary];
		const after = [{ ...summary("A"), topics: [], recap: "new recap" } as unknown as CommitSummary];
		expect(subjectFingerprint(after)).not.toBe(subjectFingerprint(before));
	});

	it("is stable when the content is unchanged", () => {
		const a = [{ ...summary("A"), recap: "same" } as unknown as CommitSummary];
		const b = [{ ...summary("A"), recap: "same" } as unknown as CommitSummary];
		expect(subjectFingerprint(a)).toBe(subjectFingerprint(b));
	});
});

describe("deriveShareDescription", () => {
	it("prefers the head commit's recap over its commit message", () => {
		const head = { ...summary("B"), recap: "Reworked the share flow." } as unknown as CommitSummary;
		expect(deriveShareDescription([summary("A"), head])).toBe("Reworked the share flow.");
	});

	it("falls back to the commit-message subject when the head has no recap", () => {
		const head = { ...summary("B"), commitMessage: "Fix share blurb\n\nBody text" } as unknown as CommitSummary;
		expect(deriveShareDescription([head])).toBe("Fix share blurb");
	});

	it("collapses whitespace and truncates to 200 chars with an ellipsis", () => {
		const head = { ...summary("B"), recap: `${"word ".repeat(60)}tail` } as unknown as CommitSummary;
		const blurb = deriveShareDescription([head]);
		expect(blurb).toHaveLength(200);
		expect(blurb?.endsWith("…")).toBe(true);
		expect(blurb).not.toContain("\n");
	});

	it("returns undefined for an empty subject or a blank head", () => {
		expect(deriveShareDescription([])).toBeUndefined();
		const blank = { ...summary("B"), commitMessage: "   " } as unknown as CommitSummary;
		expect(deriveShareDescription([blank])).toBeUndefined();
	});

	it("falls back to the commit subject when a unified-hoist head carries an empty recap", () => {
		// version>=4 makes resolveEffectiveRecap return the recap verbatim — `""` here — so a
		// `??` fallback would keep it; the truthy fallback must reach the commit subject.
		const head = {
			...summary("B"),
			version: 4,
			recap: "",
			commitMessage: "Fix share blurb\n\nBody",
		} as unknown as CommitSummary;
		expect(deriveShareDescription([head])).toBe("Fix share blurb");
	});
});

describe("generateLiveShare", () => {
	it("throws NothingToShareError when the subject has no summaries", async () => {
		mockLoad.mockResolvedValue({ summaries: [], missingCount: 0 });
		await expect(generateLiveShare({ ...deps(), branch: "feature/x", visibility: "public" })).rejects.toBeInstanceOf(
			NothingToShareError,
		);
	});

	it("pushes the newest plan revision once (by its owner) and links both commits to the same doc", async () => {
		// Same base plan "p" on commit A (old, docId 500 already minted) and B (newer revision, no docId yet).
		const a = summary("A", [plan("p-aaaaaaaa", "2026-01-01T00:00:00Z", 500)]);
		const b = summary("B", [plan("p-bbbbbbbb", "2026-02-01T00:00:00Z")]);
		mockLoad.mockResolvedValue({ summaries: [a, b], missingCount: 0 });

		await generateLiveShare({ ...deps(), branch: "feature/x", visibility: "public" });

		// A (older) owns nothing; B (newer) owns the winner, pushed with the seed docId 500 so it updates in place.
		const callA = mockPush.mock.calls.find((c) => c[0].commitHash === "A");
		const callB = mockPush.mock.calls.find((c) => c[0].commitHash === "B");
		expect(callA?.[2]).toEqual({ plans: [], notes: [] });
		expect(callB?.[2].plans).toEqual([
			expect.objectContaining({ slug: "p-bbbbbbbb", jolliPlanDocId: 500 }),
		]);

		// Both commits' covered reference the SAME live plan doc (500).
		const ref = mockCreate.mock.calls[0][2].ref;
		expect(ref.kind).toBe("branchCollection");
		expect(ref.covered).toEqual([
			{ commitHash: "A", summaryDocId: 1001, attachmentDocIds: [500] },
			{ commitHash: "B", summaryDocId: 1002, attachmentDocIds: [500] },
		]);
	});

	it("sends headCommitHash/commitHashes/decisionCount and records the share locally", async () => {
		const a = summary("A");
		const b = summary("B");
		mockLoad.mockResolvedValue({ summaries: [a, b], missingCount: 0 });

		await generateLiveShare({ ...deps(), branch: "feature/x", visibility: "org" });

		const payload = mockCreate.mock.calls[0][2];
		expect(payload.headCommitHash).toBe("B");
		expect(payload.commitHashes).toEqual(["A", "B"]);
		expect(payload.decisionCount).toBe(2); // one topic per commit
		expect(payload.visibility).toBe("org");
		// Blurb derived from the head commit (fixture has no recap → commit-message subject).
		expect(payload.description).toBe("commit B");

		const stored = mockPutShare.mock.calls[0][2];
		expect(stored.visibility).toBe("public"); // from the (mocked) create result
		expect(stored.recipients).toBeUndefined(); // recipients are session-only, never persisted
	});

	it("dedupes a recurring NOTE to its newest revision and links both commits to the same doc", async () => {
		// Note "n1" on A (old, docId 700) and B (newer revision, no docId).
		const a = summary("A", [], [note("n1", "2026-01-01T00:00:00Z", 700)]);
		const b = summary("B", [], [note("n1", "2026-02-01T00:00:00Z")]);
		mockLoad.mockResolvedValue({ summaries: [a, b], missingCount: 0 });

		await generateLiveShare({ ...deps(), branch: "feature/x", visibility: "public" });

		const callA = mockPush.mock.calls.find((c) => c[0].commitHash === "A");
		const callB = mockPush.mock.calls.find((c) => c[0].commitHash === "B");
		expect(callA?.[2].notes).toEqual([]);
		expect(callB?.[2].notes).toEqual([expect.objectContaining({ id: "n1", jolliNoteDocId: 700 })]);

		const ref = mockCreate.mock.calls[0][2].ref;
		expect(ref.covered).toEqual([
			{ commitHash: "A", summaryDocId: 1001, attachmentDocIds: [700] },
			{ commitHash: "B", summaryDocId: 1002, attachmentDocIds: [700] },
		]);
	});

	it("keeps an out-of-order older revision's docId as the seed (plan + note else-if)", async () => {
		// A (iterated first) has the NEWER updatedAt but no docId; B (iterated second) is
		// OLDER but carries a docId — the else-if must adopt B's docId as the seed.
		const a = summary("A", [plan("p-aaaaaaaa", "2026-02-01T00:00:00Z")], [note("n1", "2026-02-01T00:00:00Z")]);
		const b = summary("B", [plan("p-bbbbbbbb", "2026-01-01T00:00:00Z", 900)], [note("n1", "2026-01-01T00:00:00Z", 950)]);
		mockLoad.mockResolvedValue({ summaries: [a, b], missingCount: 0 });

		await generateLiveShare({ ...deps(), branch: "feature/x", visibility: "public" });

		// A owns the winners (newer updatedAt) but pushes them with B's seeded docIds.
		const callA = mockPush.mock.calls.find((c) => c[0].commitHash === "A");
		expect(callA?.[2].plans).toEqual([expect.objectContaining({ jolliPlanDocId: 900 })]);
		expect(callA?.[2].notes).toEqual([expect.objectContaining({ jolliNoteDocId: 950 })]);
	});

	it("invokes the push context's storeSummary passthrough", async () => {
		mockLoad.mockResolvedValue({ summaries: [summary("A")], missingCount: 0 });
		const d = deps();
		mockPush.mockImplementation((s: CommitSummary, ctx: { storeSummary: (x: unknown, b: boolean) => Promise<void> }) => {
			ctx.storeSummary(s, true); // exercise the buildPushContext passthrough
			return Promise.resolve({
				pushedDoc: { commitHash: s.commitHash, summaryDocId: 1, plans: [], notes: [] },
				updatedSummary: s,
				attachmentFailures: [],
				isUpdate: false,
				attachmentCount: 0,
			});
		});
		await generateLiveShare({ ...d, branch: "feature/x", visibility: "public" });
		expect(storeSummarySpy).toHaveBeenCalledWith(expect.objectContaining({ commitHash: "A" }), true);
	});

	it("throws when the API key yields no site URL", async () => {
		mockParseKey.mockReturnValue(undefined);
		await expect(generateLiveShare({ ...deps(), branch: "feature/x", visibility: "public" })).rejects.toThrow(
			/Jolli site URL could not be determined/,
		);
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("treats a summary with no plans/notes fields as an empty attachment set", async () => {
		// Older summaries can omit `plans`/`notes` entirely — both the winner pass and
		// the covered builder must fall back to empty lists instead of crashing.
		const bare = {
			commitHash: "A",
			branch: "feature/x",
			commitMessage: "commit A",
			topics: [],
		} as unknown as CommitSummary;
		mockLoad.mockResolvedValue({ summaries: [bare], missingCount: 0 });

		await generateLiveShare({ ...deps(), branch: "feature/x", visibility: "public" });

		expect(mockPush.mock.calls[0][2]).toEqual({ plans: [], notes: [] });
		const ref = mockCreate.mock.calls[0][2].ref;
		expect(ref.covered).toEqual([{ commitHash: "A", summaryDocId: 1001, attachmentDocIds: [] }]);
	});

	it("ignores an older revision that brings no docId (winner and seed both unchanged)", async () => {
		// A (newer, iterated first) wins; B's older revision has no docId to adopt, so
		// the loop keeps A's entry untouched and A pushes without a seeded docId.
		const a = summary("A", [plan("p-aaaaaaaa", "2026-02-01T00:00:00Z")], [note("n1", "2026-02-01T00:00:00Z")]);
		const b = summary("B", [plan("p-bbbbbbbb", "2026-01-01T00:00:00Z")], [note("n1", "2026-01-01T00:00:00Z")]);
		mockLoad.mockResolvedValue({ summaries: [a, b], missingCount: 0 });

		await generateLiveShare({ ...deps(), branch: "feature/x", visibility: "public" });

		const callA = mockPush.mock.calls.find((c) => c[0].commitHash === "A");
		const callB = mockPush.mock.calls.find((c) => c[0].commitHash === "B");
		expect(callA?.[2].plans).toEqual([expect.objectContaining({ slug: "p-aaaaaaaa" })]);
		expect(callA?.[2].plans[0].jolliPlanDocId).toBeUndefined();
		expect(callA?.[2].notes[0].jolliNoteDocId).toBeUndefined();
		expect(callB?.[2]).toEqual({ plans: [], notes: [] });

		// B's covered still references the docs pushed under A (same live docs).
		const ref = mockCreate.mock.calls[0][2].ref;
		expect(ref.covered[1].attachmentDocIds).toEqual(ref.covered[0].attachmentDocIds);
		expect(ref.covered[0].attachmentDocIds).toHaveLength(2);
	});

	it("groups two distinct plan winners owned by the same commit into one attachment list", async () => {
		const a = summary("A", [
			plan("p1-aaaaaaaa", "2026-01-01T00:00:00Z", 501),
			plan("p2-aaaaaaaa", "2026-01-01T00:00:00Z", 502),
		]);
		mockLoad.mockResolvedValue({ summaries: [a], missingCount: 0 });

		await generateLiveShare({ ...deps(), branch: "feature/x", visibility: "public" });

		const callA = mockPush.mock.calls[0];
		expect(callA[2].plans.map((p: PlanReference) => p.jolliPlanDocId)).toEqual([501, 502]);
	});

	it("covers a commit whose attachments produced no docs with an empty allowlist", async () => {
		// The push reports no plan/note docs (e.g. bodies unreadable → skipped), so the
		// covered builder finds no docId for either attachment and adds nothing.
		const a = summary("A", [plan("p-aaaaaaaa", "2026-01-01T00:00:00Z")], [note("n1", "2026-01-01T00:00:00Z")]);
		mockLoad.mockResolvedValue({ summaries: [a], missingCount: 0 });
		mockPush.mockResolvedValue({
			pushedDoc: { commitHash: "A", summaryDocId: 1001, plans: [], notes: [] },
			updatedSummary: a,
			attachmentFailures: [],
			isUpdate: false,
			attachmentCount: 0,
		});

		await generateLiveShare({ ...deps(), branch: "feature/x", visibility: "public" });

		const ref = mockCreate.mock.calls[0][2].ref;
		expect(ref.covered).toEqual([{ commitHash: "A", summaryDocId: 1001, attachmentDocIds: [] }]);
	});

	it("fails instead of creating a share when a plan/note upload failed", async () => {
		const a = summary("A", [plan("p-aaaaaaaa", "2026-01-01T00:00:00Z")], [note("n1", "2026-01-01T00:00:00Z")]);
		mockLoad.mockResolvedValue({ summaries: [a], missingCount: 0 });
		mockPush.mockResolvedValue({
			pushedDoc: { commitHash: "A", summaryDocId: 1001, plans: [], notes: [] },
			updatedSummary: a,
			attachmentFailures: [
				{ label: 'plan "Plan"', message: "Network error: socket hang up" },
				{ label: 'note "Note"', message: "permission denied (HTTP 403)" },
			],
			isUpdate: false,
			attachmentCount: 0,
		});

		const result = generateLiveShare({ ...deps(), branch: "feature/x", visibility: "public" });
		await expect(result).rejects.toThrow(
			/Could not sync shared plans\/notes: plan "Plan": Network error: socket hang up; note "Note": permission denied \(HTTP 403\)/,
		);
		await expect(result).rejects.toBeInstanceOf(AttachmentPushError);
		expect(mockCreate).not.toHaveBeenCalled();
		expect(mockPutShare).not.toHaveBeenCalled();
	});

	it("sends the people allowlist to the server and persists the echoed recipients", async () => {
		mockLoad.mockResolvedValue({ summaries: [summary("A")], missingCount: 0 });
		mockCreate.mockResolvedValue({
			shareId: 7,
			shareUrl: "https://acme.jolli.ai/b/x",
			expiresAt: "2026-09-01T00:00:00.000Z",
			visibility: "people",
			recipients: ["marta@jolli.ai"],
		});

		await generateLiveShare({
			...deps(),
			branch: "feature/x",
			visibility: "people",
			recipients: ["marta@jolli.ai"],
		});

		expect(mockCreate.mock.calls[0][2].recipients).toEqual(["marta@jolli.ai"]);
		const stored = mockPutShare.mock.calls[0][2];
		expect(stored.visibility).toBe("people");
		expect(stored.recipients).toEqual(["marta@jolli.ai"]);
	});

	it("builds a commitDocs ref for a single-commit share", async () => {
		const a = summary("A", [plan("p-aaaaaaaa", "2026-01-01T00:00:00Z", 500)]);
		mockLoad.mockResolvedValue({ summaries: [a], missingCount: 0 });

		await generateLiveShare({ ...deps(), branch: "feature/x", commitHash: "A", visibility: "public" });

		const ref = mockCreate.mock.calls[0][2].ref;
		expect(ref).toEqual({ kind: "commitDocs", summaryDocIds: [1001], attachmentDocIds: [500] });
	});

	it("commit share can use the provided open summary instead of filtering current base..HEAD", async () => {
		const openSummary = summary("A", [plan("p-aaaaaaaa", "2026-01-01T00:00:00Z", 500)]);
		mockLoad.mockResolvedValue({ summaries: [summary("B")], missingCount: 0 });

		await generateLiveShare({
			...deps(),
			branch: "feature/opened",
			commitHash: "A",
			commitSummary: openSummary,
			visibility: "public",
		});

		expect(mockLoad).not.toHaveBeenCalled();
		const ref = mockCreate.mock.calls[0][2].ref;
		expect(ref).toEqual({ kind: "commitDocs", summaryDocIds: [1001], attachmentDocIds: [500] });
		expect(mockPush.mock.calls[0][0]).toBe(openSummary);
	});
});

describe("reconcileLiveShare", () => {
	it("no-ops when there is no live branch-share record", async () => {
		mockGetShare.mockResolvedValue(undefined);
		await reconcileLiveShare(deps(), "feature/x");
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("no-ops for a commit-share record (only branchCollection reconciles)", async () => {
		mockGetShare.mockResolvedValue({
			shareId: "9",
			shareUrl: "u",
			visibility: "public",
			ref: { kind: "commitDocs", summaryDocIds: [1], attachmentDocIds: [] },
			expiresAt: "x",
			decisionCount: 1,
		});
		await reconcileLiveShare(deps(), "feature/x");
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("no-ops when the branch has no summaries (leaves the share untouched)", async () => {
		mockGetShare.mockResolvedValue({
			shareId: "7",
			shareUrl: "u",
			visibility: "public",
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] },
			expiresAt: "x",
			decisionCount: 0,
		});
		mockLoad.mockResolvedValue({ summaries: [], missingCount: 0 });
		await reconcileLiveShare(deps(), "feature/x");
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("short-circuits (no push, no PATCH) when the content fingerprint is unchanged", async () => {
		const summaries = [summary("A"), summary("B")];
		mockGetShare.mockResolvedValue({
			shareId: "7",
			shareUrl: "https://acme.jolli.ai/b/x",
			visibility: "public",
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [{ commitHash: "B", summaryDocId: 2, attachmentDocIds: [] }] },
			expiresAt: "2026-09-01T00:00:00.000Z",
			decisionCount: 2,
			headCommitHash: "B",
			contentHash: subjectFingerprint(summaries), // already at the current content
		});
		mockLoad.mockResolvedValue({ summaries, missingCount: 0 });

		await reconcileLiveShare(deps(), "feature/x");

		expect(mockPush).not.toHaveBeenCalled();
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(mockPutShare).not.toHaveBeenCalled();
	});

	it("re-pushes when a memory edit changed content but HEAD did not advance", async () => {
		const summaries = [summary("A"), summary("B")];
		mockGetShare.mockResolvedValue({
			shareId: "7",
			shareUrl: "https://acme.jolli.ai/b/x",
			visibility: "public",
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] },
			expiresAt: "2026-09-01T00:00:00.000Z",
			decisionCount: 2,
			headCommitHash: "B", // same tip…
			contentHash: "stale-different-hash", // …but content changed since last push
		});
		mockLoad.mockResolvedValue({ summaries, missingCount: 0 });

		await reconcileLiveShare(deps(), "feature/x");

		expect(mockPush).toHaveBeenCalled();
		expect(mockUpdate).toHaveBeenCalledOnce();
		const stored = mockPutShare.mock.calls.at(-1)?.[2];
		expect(stored.contentHash).toBe(subjectFingerprint(summaries));
	});

	it("rebuilds covered from the current base..HEAD and PATCHes (drops a removed commit)", async () => {
		mockGetShare.mockResolvedValue({
			shareId: "7",
			shareUrl: "https://acme.jolli.ai/b/x",
			visibility: "public",
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [{ commitHash: "A", summaryDocId: 1, attachmentDocIds: [] }, { commitHash: "B", summaryDocId: 2, attachmentDocIds: [] }] },
			expiresAt: "2026-09-01T00:00:00.000Z",
			decisionCount: 2,
		});
		// B was dropped from the branch — only A remains now.
		mockLoad.mockResolvedValue({ summaries: [summary("A")], missingCount: 0 });

		await reconcileLiveShare(deps(), "feature/x");

		expect(mockUpdate).toHaveBeenCalledOnce();
		const ref = mockUpdate.mock.calls[0][3].ref;
		expect(ref.covered).toEqual([{ commitHash: "A", summaryDocId: 1001, attachmentDocIds: [] }]);
	});

	it("refreshes the description from the current head on PATCH", async () => {
		mockGetShare.mockResolvedValue({
			shareId: "7",
			shareUrl: "https://acme.jolli.ai/b/x",
			visibility: "public",
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] },
			expiresAt: "2026-09-01T00:00:00.000Z",
			decisionCount: 1,
		});
		const head = { ...summary("B"), recap: "Now with a recap." } as unknown as CommitSummary;
		mockLoad.mockResolvedValue({ summaries: [summary("A"), head], missingCount: 0 });

		await reconcileLiveShare(deps(), "feature/x");

		expect(mockUpdate.mock.calls[0][3].description).toBe("Now with a recap.");
	});

	it("refreshes the cached decision count from the current base..HEAD (and writes no titles)", async () => {
		mockGetShare.mockResolvedValue({
			shareId: "7",
			shareUrl: "https://acme.jolli.ai/b/x",
			visibility: "public",
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] },
			expiresAt: "2026-09-01T00:00:00.000Z",
			decisionCount: 1, // stale
		});
		mockLoad.mockResolvedValue({ summaries: [summary("A"), summary("B")], missingCount: 0 });

		await reconcileLiveShare(deps(), "feature/x");

		const stored = mockPutShare.mock.calls.at(-1)?.[2];
		expect(stored.decisionCount).toBe(2); // one topic per commit
		expect(stored).not.toHaveProperty("titles");
	});

	it("fails reconcile instead of PATCHing covered when an attachment upload failed", async () => {
		const a = summary("A", [plan("p-aaaaaaaa", "2026-01-01T00:00:00Z")]);
		mockGetShare.mockResolvedValue({
			shareId: "7",
			shareUrl: "https://acme.jolli.ai/b/x",
			visibility: "public",
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] },
			expiresAt: "2026-09-01T00:00:00.000Z",
			decisionCount: 1,
		});
		mockLoad.mockResolvedValue({ summaries: [a], missingCount: 0 });
		mockPush.mockResolvedValue({
			pushedDoc: { commitHash: "A", summaryDocId: 1001, plans: [], notes: [] },
			updatedSummary: a,
			attachmentFailures: [{ label: 'plan "Plan"', message: "unauthorized (HTTP 401)" }],
			isUpdate: false,
			attachmentCount: 0,
		});

		await expect(reconcileLiveShare(deps(), "feature/x")).rejects.toThrow(
			/Could not sync shared plans\/notes: plan "Plan": unauthorized \(HTTP 401\)/,
		);
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(mockPutShare).not.toHaveBeenCalled();
	});

	it("keeps the cached visibility and shareUrl when the ref-only PATCH omits them", async () => {
		mockGetShare.mockResolvedValue({
			shareId: "7",
			shareUrl: "https://acme.jolli.ai/b/x",
			visibility: "org",
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] },
			expiresAt: "2026-09-01T00:00:00.000Z",
			decisionCount: 1,
		});
		mockLoad.mockResolvedValue({ summaries: [summary("A")], missingCount: 0 });
		// A ref-only PATCH response that echoes neither visibility nor shareUrl.
		mockUpdate.mockResolvedValue({ shareId: "7" });

		await reconcileLiveShare(deps(), "feature/x");

		const stored = mockPutShare.mock.calls.at(-1)?.[2];
		expect(stored.visibility).toBe("org"); // cached fallback
		expect(stored.shareUrl).toBe("https://acme.jolli.ai/b/x"); // cached fallback
	});

	it("preserves the cached shareUrl/expiry/recipients when the ref-only PATCH omits them", async () => {
		mockGetShare.mockResolvedValue({
			shareId: "7",
			shareUrl: "https://acme.jolli.ai/b/keep",
			visibility: "people",
			recipients: ["marta@jolli.ai"],
			ref: { kind: "branchCollection", relativePath: "feature/x", covered: [] },
			expiresAt: "2026-09-01T00:00:00.000Z",
			decisionCount: 2,
		});
		mockLoad.mockResolvedValue({ summaries: [summary("A")], missingCount: 0 });
		// A ref-only PATCH response: no shareUrl / expiresAt / recipients / token echoed back.
		mockUpdate.mockResolvedValue({ shareId: "7", visibility: "people" });

		await reconcileLiveShare(deps(), "feature/x");

		const stored = mockPutShare.mock.calls.at(-1)?.[2];
		expect(stored.shareUrl).toBe("https://acme.jolli.ai/b/keep");
		expect(stored.expiresAt).toBe("2026-09-01T00:00:00.000Z");
		expect(stored.recipients).toEqual(["marta@jolli.ai"]);
		expect(stored.visibility).toBe("people");
	});
});

describe("pushBranchMemoriesToSpace", () => {
	const deps = (currentBranch = "feature/x") => ({
		bridge: { storeSummary: vi.fn(), getCurrentBranch: vi.fn().mockResolvedValue(currentBranch) } as never,
		workspaceRoot: "/repo",
		apiKey: "sk-jol-x",
		resolveBinding: vi.fn(),
	});

	beforeEach(() => {
		mockParseKey.mockReturnValue({ u: "https://acme.jolli.ai" });
	});

	it("pushes every branch summary and returns aggregate counts", async () => {
		mockLoad.mockResolvedValue({ summaries: [summary("A", [plan("p", "2026-01-01")]), summary("B")] });
		mockPush
			.mockResolvedValueOnce({
				pushedDoc: { summaryDocId: 1001, plans: [{ slug: "p", docId: 7, url: "u" }], notes: [] },
				attachmentFailures: [],
				attachmentCount: 1,
			})
			.mockResolvedValueOnce({
				pushedDoc: { summaryDocId: 1002, plans: [], notes: [] },
				attachmentFailures: [],
				attachmentCount: 0,
			});

		const result = await pushBranchMemoriesToSpace(deps(), "feature/x");

		expect(mockPush).toHaveBeenCalledTimes(2);
		expect(result.pushedCount).toBe(2);
		expect(result.attachmentCount).toBe(1);
		expect(result.attachmentFailures).toEqual([]);
	});

	it("dedupes a plan recurring across commits to one owner push (latest revision)", async () => {
		// Same plan slug on both commits; the newer updatedAt wins and is pushed under its owner only.
		mockLoad.mockResolvedValue({
			summaries: [summary("A", [plan("p", "2026-01-01")]), summary("B", [plan("p", "2026-02-01")])],
		});
		mockPush.mockResolvedValue({
			pushedDoc: { summaryDocId: 0, plans: [], notes: [] },
			attachmentFailures: [],
			attachmentCount: 0,
		});

		await pushBranchMemoriesToSpace(deps(), "feature/x");

		// Exactly one of the two summary pushes carries the plan, and it must be commit B's
		// push (the latest-revision owner) — not A's.
		const callA = mockPush.mock.calls.find((c) => c[0].commitHash === "A");
		const callB = mockPush.mock.calls.find((c) => c[0].commitHash === "B");
		expect(callA?.[2].plans).toEqual([]);
		expect(callB?.[2].plans).toHaveLength(1);
	});

	it("is non-strict: omits strictAttachments so attachment failures are collected, not thrown", async () => {
		mockLoad.mockResolvedValue({ summaries: [summary("A")] });
		mockPush.mockResolvedValue({
			pushedDoc: { summaryDocId: 1001, plans: [], notes: [] },
			attachmentFailures: [{ label: 'plan "x"', message: "unreadable" }],
			attachmentCount: 0,
		});

		const result = await pushBranchMemoriesToSpace(deps(), "feature/x");

		// options arg (4th param) must NOT set strictAttachments.
		const optionsArg = mockPush.mock.calls[0][3] as { strictAttachments?: boolean } | undefined;
		expect(optionsArg?.strictAttachments).toBeUndefined();
		expect(result.attachmentFailures).toHaveLength(1);
		expect(result.pushedCount).toBe(1);
	});

	it("throws NothingToShareError when the branch has no summaries", async () => {
		mockLoad.mockResolvedValue({ summaries: [] });
		await expect(pushBranchMemoriesToSpace(deps(), "feature/x")).rejects.toThrow(NothingToShareError);
	});

	it("aborts (BranchMismatchError) without loading or pushing when HEAD has moved off the requested branch", async () => {
		// HEAD is now "other" but the caller asked to share "feature/x". Since the
		// loader reads the current HEAD's base..HEAD, pushing would publish the
		// wrong branch's memories — so it must abort before loading or pushing.
		mockLoad.mockResolvedValue({ summaries: [summary("A")] });
		await expect(pushBranchMemoriesToSpace(deps("other"), "feature/x")).rejects.toBeInstanceOf(BranchMismatchError);
		expect(mockLoad).not.toHaveBeenCalled();
		expect(mockPush).not.toHaveBeenCalled();
	});

	it("stops and propagates when a summary push throws (e.g. binding cancelled)", async () => {
		mockLoad.mockResolvedValue({ summaries: [summary("A"), summary("B")] });
		mockPush.mockRejectedValueOnce(new ShareBindingError("cancelled"));

		await expect(pushBranchMemoriesToSpace(deps(), "feature/x")).rejects.toBeInstanceOf(ShareBindingError);
		expect(mockPush).toHaveBeenCalledTimes(1);
	});

	it("collects a transient summary-push failure and keeps going (does not lose earlier successes)", async () => {
		// A fails with a transient error, B succeeds. The batch must not abort — the
		// success is recorded and the failure is surfaced via summaryFailures.
		mockLoad.mockResolvedValue({ summaries: [summary("A"), summary("B")] });
		mockPush.mockRejectedValueOnce(new Error("HTTP 500")).mockResolvedValueOnce({
			pushedDoc: { summaryDocId: 1002, plans: [], notes: [] },
			attachmentFailures: [],
			attachmentCount: 0,
		});

		const result = await pushBranchMemoriesToSpace(deps(), "feature/x");

		expect(mockPush).toHaveBeenCalledTimes(2);
		expect(result.pushedCount).toBe(1);
		expect(result.summaryFailures).toHaveLength(1);
		expect(result.summaryFailures[0].label).toContain("commit A");
		expect(result.summaryFailures[0].message).toContain("HTTP 500");
	});

	it("propagates a fatal PluginOutdatedError instead of collecting it", async () => {
		mockLoad.mockResolvedValue({ summaries: [summary("A"), summary("B")] });
		mockPush.mockRejectedValueOnce(new PluginOutdatedError("outdated"));

		await expect(pushBranchMemoriesToSpace(deps(), "feature/x")).rejects.toBeInstanceOf(PluginOutdatedError);
		expect(mockPush).toHaveBeenCalledTimes(1);
	});
});
