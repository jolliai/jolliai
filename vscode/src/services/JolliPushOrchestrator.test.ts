import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../../../cli/src/Types.js";

const { mockPushToJolli, mockDeleteFromJolli } = vi.hoisted(() => ({
	mockPushToJolli: vi.fn(),
	mockDeleteFromJolli: vi.fn(),
}));
const { mockReadPlan, mockReadNote, mockReadReference, mockReadSkill, mockReadTranscriptsBatch } = vi.hoisted(
	() => ({
		mockReadPlan: vi.fn(),
		mockReadNote: vi.fn(),
		mockReadReference: vi.fn(),
		mockReadSkill: vi.fn(),
		mockReadTranscriptsBatch: vi.fn(),
	}),
);
// spec 306: the outbound-push gate. Default allowed; the fail-fast test flips it.
const { mockIsOutboundPushAllowed } = vi.hoisted(() => ({
	mockIsOutboundPushAllowed: vi.fn(async () => true),
}));
vi.mock("../../../cli/src/core/PushControl.js", () => ({
	isOutboundPushAllowed: mockIsOutboundPushAllowed,
}));

// Stub only the network functions; keep BindingRequiredError / PluginOutdatedError real (instanceof).
vi.mock("./JolliPushService.js", async (importActual) => {
	const actual = await importActual<typeof import("./JolliPushService.js")>();
	return { ...actual, pushToJolli: mockPushToJolli, deleteFromJolli: mockDeleteFromJolli };
});
vi.mock("../../../cli/src/core/SummaryStore.js", () => ({
	readPlanFromBranch: mockReadPlan,
	readNoteFromBranch: mockReadNote,
	readReferenceFromBranch: mockReadReference,
	readSkillFromBranch: mockReadSkill,
	readTranscriptsBatch: mockReadTranscriptsBatch,
}));
// Spy-wraps the real `collectTranscriptSessionMeta` (like the panel test wraps
// `pushSummaryWithAttachments`): every existing test keeps exercising the genuine
// enrichment, while one test can `mockRejectedValueOnce` to pin that a call-site
// failure here — not just a `readTranscriptsBatch` failure — still can't abort a push.
const { mockCollectTranscriptSessionMeta } = vi.hoisted(() => ({
	mockCollectTranscriptSessionMeta: vi.fn(),
}));
vi.mock("../../../cli/src/core/TranscriptSessionMeta.js", async (importActual) => {
	const actual = await importActual<typeof import("../../../cli/src/core/TranscriptSessionMeta.js")>();
	mockCollectTranscriptSessionMeta.mockImplementation(actual.collectTranscriptSessionMeta);
	return { ...actual, collectTranscriptSessionMeta: mockCollectTranscriptSessionMeta };
});
vi.mock("../views/SummaryMarkdownBuilder.js", () => ({ buildMarkdown: () => "# markdown" }));
vi.mock("../../../cli/src/core/Telemetry.js", () => ({ track: vi.fn() }));
vi.mock("../util/Logger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DocTypeNotAllowedError } from "../../../cli/src/core/JolliMemoryPushClient.js";
import {
	BindingRequiredError,
	PermissionDeniedError,
	PluginOutdatedError,
	PushDisabledError,
} from "./JolliPushService.js";
import {
	type BindingOutcome,
	type PushContext,
	pushSummaryWithAttachments,
	serializeSummaryJson,
	ShareBindingError,
} from "./JolliPushOrchestrator.js";

function makeSummary(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		schemaVersion: 1,
		commitHash: "abc123",
		branch: "feature/x",
		commitMessage: "A commit",
		summary: "body",
		topics: [],
		...overrides,
	} as unknown as CommitSummary;
}

/** Makes `readTranscriptsBatch` resolve every requested id to the same value. */
function mockTranscriptsBatch(value: unknown): void {
	mockReadTranscriptsBatch.mockImplementation(
		async (ids: readonly string[]) => new Map(ids.map((id) => [id, value])),
	);
}

function makeContext(overrides: Partial<PushContext> = {}): PushContext {
	return {
		baseUrl: "https://acme.jolli.ai/",
		apiKey: "sk-jol-test",
		repoUrl: "https://github.com/acme/repo",
		workspaceRoot: "/repo",
		storeSummary: vi.fn().mockResolvedValue(undefined),
		resolveBinding: vi.fn<[string], Promise<BindingOutcome>>().mockResolvedValue({ status: "cancelled" }),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockReadPlan.mockResolvedValue("plan body");
	mockReadNote.mockResolvedValue("note body");
	mockReadReference.mockResolvedValue(null);
	mockReadSkill.mockResolvedValue(null);
	mockTranscriptsBatch(null);
	mockIsOutboundPushAllowed.mockResolvedValue(true);
});

describe("pushSummaryWithAttachments", () => {
	it("pushes the summary and persists it (first push → isUpdate false)", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const ctx = makeContext();
		const result = await pushSummaryWithAttachments(makeSummary(), ctx);

		expect(result.pushedDoc.summaryDocId).toBe(100);
		expect(result.pushedDoc.summaryUrl).toBe("https://acme.jolli.ai/articles?doc=100");
		expect(result.isUpdate).toBe(false);
		expect(result.attachmentCount).toBe(0);
		expect(ctx.storeSummary).toHaveBeenCalledWith(expect.objectContaining({ jolliDocId: 100 }), true);
	});

	it("fails fast with PushDisabledError and uploads nothing when the repo opted out (spec 306)", async () => {
		mockIsOutboundPushAllowed.mockResolvedValue(false);
		const ctx = makeContext();
		await expect(pushSummaryWithAttachments(makeSummary(), ctx)).rejects.toBeInstanceOf(PushDisabledError);
		// No attachment or summary push was attempted, and nothing was persisted.
		expect(mockPushToJolli).not.toHaveBeenCalled();
		expect(ctx.storeSummary).not.toHaveBeenCalled();
	});

	it("writes back a doc URL whose origin keys to the current push env", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const ctx = makeContext();
		await pushSummaryWithAttachments(makeSummary(), ctx);
		// No separate env tag — the written-back URL's origin IS the env.
		expect(ctx.storeSummary).toHaveBeenCalledWith(
			expect.objectContaining({ jolliDocId: 100, jolliDocUrl: "https://acme.jolli.ai/articles?doc=100" }),
			true,
		);
	});

	it("reuses the docId when the summary's stored URL origin matches the current env", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const summary = makeSummary({ jolliDocId: 7, jolliDocUrl: "https://acme.jolli.ai/articles?doc=7" });
		await pushSummaryWithAttachments(summary, makeContext());
		expect(mockPushToJolli).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ docType: "summary", docId: 7 }),
			expect.anything(),
		);
	});

	it("does NOT reuse the docId when the summary was pushed to a different backend", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const summary = makeSummary({ jolliDocId: 7, jolliDocUrl: "https://jolli-local.me/t/articles?doc=7" });
		await pushSummaryWithAttachments(summary, makeContext());
		const payload = mockPushToJolli.mock.calls[0][2] as { docId?: number };
		expect(payload.docId).toBeUndefined();
	});

	it("pushes only the caller-chosen attachments (empty selection → no plan/note pushes)", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const summary = makeSummary({
			plans: [{ slug: "p-abc12345", title: "Plan", addedAt: "t", updatedAt: "t" }],
		});
		await pushSummaryWithAttachments(summary, makeContext(), { plans: [], notes: [] });
		// Only the summary doc is pushed — the summary's own plan is NOT, because the selection was empty.
		expect(mockPushToJolli).toHaveBeenCalledTimes(1);
		expect(mockPushToJolli).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ docType: "summary" }), expect.anything());
	});

	it("pushes a chosen plan with its resolved docId and returns it keyed by slug", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) =>
			Promise.resolve({ docId: p.docType === "summary" ? 100 : 200 }),
		);
		const plan = { slug: "p-abc12345", title: "Plan", addedAt: "t", updatedAt: "t", jolliPlanDocId: 200 };
		const summary = makeSummary({ plans: [plan] });
		const result = await pushSummaryWithAttachments(summary, makeContext(), { plans: [plan], notes: [] });

		expect(result.pushedDoc.plans).toEqual([{ slug: "p-abc12345", title: "Plan", docId: 200, url: "https://acme.jolli.ai/articles?doc=200" }]);
		expect(result.attachmentCount).toBe(1);
		// The plan push reused the known docId so the Space doc updates in place.
		expect(mockPushToJolli).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ docType: "plan", docId: 200 }), expect.anything());
	});

	it("collects a per-attachment failure without aborting the summary push", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "plan") return Promise.reject(new Error("500 already exists"));
			return Promise.resolve({ docId: 100 });
		});
		const plan = { slug: "p-abc12345", title: "Plan", addedAt: "t", updatedAt: "t" };
		const result = await pushSummaryWithAttachments(makeSummary({ plans: [plan] }), makeContext(), {
			plans: [plan],
			notes: [],
		});
		expect(result.pushedDoc.summaryDocId).toBe(100);
		expect(result.attachmentFailures).toEqual([{ label: 'plan "Plan"', message: "500 already exists" }]);
	});

	it("collects a per-note failure without aborting the summary push", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "note") return Promise.reject(new Error("note 500"));
			return Promise.resolve({ docId: 100 });
		});
		const note = { id: "n1", title: "Note", format: "markdown" as const, addedAt: "t", updatedAt: "t" };
		const result = await pushSummaryWithAttachments(makeSummary(), makeContext(), { plans: [], notes: [note] });
		expect(result.pushedDoc.summaryDocId).toBe(100);
		expect(result.attachmentFailures).toEqual([{ label: 'note "Note"', message: "note 500" }]);
	});

	it("pushes a reference as a standalone `reference` article and returns it keyed by archivedKey", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) =>
			Promise.resolve({ docId: p.docType === "summary" ? 100 : 400 }),
		);
		const ref = {
			archivedKey: "linear:ENG-1-a1b2c3d4",
			source: "linear",
			nativeId: "ENG-1",
			title: "Fix bug",
			url: "https://linear.app/x",
			referencedAt: "t",
			sourceToolName: "Claude Code",
		};
		const summary = makeSummary({ references: [ref] });
		const result = await pushSummaryWithAttachments(summary, makeContext(), { plans: [], notes: [], references: [ref] });

		expect(mockPushToJolli).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ docType: "reference", title: "Linear · ENG-1 — Fix bug" }),
			expect.anything(),
		);
		expect(result.pushedDoc.references).toEqual([
			{ archivedKey: "linear:ENG-1-a1b2c3d4", baseKey: "linear:ENG-1", title: "Linear · ENG-1 — Fix bug", docId: 400, url: "https://acme.jolli.ai/articles?doc=400" },
		]);
		expect(result.updatedSummary.references?.[0].jolliReferenceDocId).toBe(400);
		expect(result.attachmentCount).toBe(1);
	});

	it("reuses a reference docId only when its env tag matches the current env", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) =>
			Promise.resolve({ docId: p.docType === "summary" ? 100 : 400 }),
		);
		const ref = {
			archivedKey: "linear:ENG-1-a1b2c3d4",
			source: "linear",
			nativeId: "ENG-1",
			title: "Fix bug",
			url: "https://linear.app/x",
			referencedAt: "t",
			sourceToolName: "Claude Code",
			jolliReferenceDocId: 400,
			jolliReferenceDocUrl: "https://jolli-local.me/t/articles?doc=400", // different backend
		};
		await pushSummaryWithAttachments(makeSummary({ references: [ref] }), makeContext(), {
			plans: [],
			notes: [],
			references: [ref],
		});
		const refCall = mockPushToJolli.mock.calls.find((c) => (c[2] as { docType: string }).docType === "reference");
		expect((refCall?.[2] as { docId?: number }).docId).toBeUndefined();
	});

	it("treats a reference push failure as best-effort — skipped, NOT a fatal attachment failure", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "reference") return Promise.reject(new Error("ref 500"));
			return Promise.resolve({ docId: 100 });
		});
		const ref = {
			archivedKey: "linear:ENG-1-a1b2c3d4",
			source: "linear",
			nativeId: "ENG-1",
			title: "Fix bug",
			url: "https://linear.app/x",
			referencedAt: "t",
			sourceToolName: "Claude Code",
		};
		const result = await pushSummaryWithAttachments(makeSummary({ references: [ref] }), makeContext(), {
			plans: [],
			notes: [],
			references: [ref],
		});
		expect(result.pushedDoc.summaryDocId).toBe(100);
		// The summary still succeeds; the failed reference is simply absent from the
		// pushed set and does NOT enter attachmentFailures (which the strict branch-share
		// path would turn into a fatal AttachmentPushError).
		expect(result.pushedDoc.references).toEqual([]);
		expect(result.attachmentFailures).toEqual([]);
	});

	// Same best-effort contract as a reference, and for the same reason: a skill record
	// is auto-extracted from a transcript, never attached by the user. Without it, one
	// transient failure would abort a whole strict live share over metadata about HOW
	// the work happened.
	it("treats a skill push failure as best-effort — skipped, NOT a fatal attachment failure", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "skill") return Promise.reject(new Error("skill 500"));
			return Promise.resolve({ docId: 100 });
		});
		const skill = {
			archivedKey: "claude:superpowers:brainstorming-a1b2c3d4",
			source: "claude" as const,
			skill: "superpowers:brainstorming",
			entryPaths: ["tool" as const],
			invocationCount: 1,
			firstUsedAt: "2026-08-01T10:00:00.000Z",
			lastUsedAt: "2026-08-05T10:00:00.000Z",
		};
		const result = await pushSummaryWithAttachments(
			makeSummary({ skills: [skill] }),
			makeContext(),
			new Map([["skill", [skill]]]),
			{ strictAttachments: true },
		);
		expect(result.pushedDoc.summaryDocId).toBe(100);
		expect(result.attachmentFailures).toEqual([]);
		expect(result.skippedAttachments).toHaveLength(1);
	});

	it("reports ONE skipped entry for a kind however many of its items failed", async () => {
		// The caller renders these into a notification. Per-item entries made a commit
		// with a dozen references produce a dozen titles in one toast.
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "reference") return Promise.reject(new Error("ref 500"));
			return Promise.resolve({ docId: 100 });
		});
		const references = ["ENG-1", "ENG-2", "ENG-3"].map((id) => ({
			archivedKey: `linear:${id}-a1b2c3d4`,
			source: "linear",
			nativeId: id,
			title: `Fix ${id}`,
			url: "https://linear.app/x",
			referencedAt: "t",
			sourceToolName: "Claude Code",
		}));
		const result = await pushSummaryWithAttachments(makeSummary({ references }), makeContext(), {
			plans: [],
			notes: [],
			references,
		});
		expect(result.skippedAttachments).toHaveLength(1);
		expect(result.skippedAttachments[0].label).toBe("3 reference article(s)");
		expect(result.attachmentFailures).toEqual([]);
	});

	it("publishes ONE aggregate article for a commit's whole skill set", async () => {
		// The mismatch this kind's `aggregate` exists to fix: the Context surfaces show a
		// commit's skills as ONE artifact (`skills--<hash8>.md` / a single "Skills used"
		// row), so a commit that entered three skills used to arrive at the backend as
		// three documents the user had no local counterpart for.
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) =>
			Promise.resolve({ docId: p.docType === "summary" ? 100 : 501 }),
		);
		const skills = ["one", "two", "three"].map((name) => ({
			archivedKey: `claude:${name}-a1b2c3d4`,
			source: "claude" as const,
			skill: name,
			entryPaths: ["tool" as const],
			invocationCount: 1,
			firstUsedAt: "2026-08-01T10:00:00.000Z",
			lastUsedAt: "2026-08-05T10:00:00.000Z",
		}));
		const result = await pushSummaryWithAttachments(
			makeSummary({ skills }),
			makeContext(),
			new Map([["skill", skills]]),
		);
		const skillCalls = mockPushToJolli.mock.calls.filter((c) => (c[2] as { docType: string }).docType === "skill");
		expect(skillCalls).toHaveLength(1);
		const payload = skillCalls[0][2] as { title: string; content: string };
		// One article, named for the commit, listing every skill in the shared table.
		expect(payload.title).toBe("Skills used — abc123");
		for (const name of ["one", "two", "three"]) expect(payload.content).toContain(name);
		// The id lands on the COMMIT, not on any skill entry — the article covers all of
		// them, so a re-push updates it no matter how the skill set changes.
		expect(result.updatedSummary.jolliSkillsDocId).toBe(501);
		expect(result.updatedSummary.skills?.some((s) => s.jolliDocId !== undefined)).toBe(false);
	});

	it("reports a docType refusal as skipped instead of only logging it", async () => {
		// The CLEAN refusal — the server naming the unsupported type in machine-readable
		// form — used to be the only path that told the user nothing at all, while a
		// server returning a generic error produced a warning. Same visibility now.
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "skill") return Promise.reject(new DocTypeNotAllowedError("skill", "not enabled"));
			return Promise.resolve({ docId: 100 });
		});
		const skills = ["one", "two"].map((name) => ({
			archivedKey: `claude:${name}-a1b2c3d4`,
			source: "claude" as const,
			skill: name,
			entryPaths: ["tool" as const],
			invocationCount: 1,
			firstUsedAt: "2026-08-01T10:00:00.000Z",
			lastUsedAt: "2026-08-05T10:00:00.000Z",
		}));
		const result = await pushSummaryWithAttachments(
			makeSummary({ skills }),
			makeContext(),
			new Map([["skill", skills]]),
		);
		// One call either way — the kind aggregates a commit's skills into a single
		// article — and the refusal short-circuits the rest of the kind.
		expect(mockPushToJolli.mock.calls.filter((c) => (c[2] as { docType: string }).docType === "skill")).toHaveLength(
			1,
		);
		expect(result.skippedAttachments).toEqual([
			{ label: "skill article(s)", message: 'The server does not have article type "skill" enabled.' },
		]);
		// The summary itself still publishes — a refusal is per KIND, never repo-wide.
		expect(result.pushedDoc.summaryDocId).toBe(100);
	});

	it("pushes a skill when the caller passes a kind-agnostic selection", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) =>
			Promise.resolve({ docId: p.docType === "summary" ? 100 : 501 }),
		);
		const skill = {
			archivedKey: "claude:superpowers:brainstorming-a1b2c3d4",
			source: "claude" as const,
			skill: "superpowers:brainstorming",
			entryPaths: ["tool" as const],
			invocationCount: 1,
			firstUsedAt: "2026-08-01T10:00:00.000Z",
			lastUsedAt: "2026-08-05T10:00:00.000Z",
		};
		const result = await pushSummaryWithAttachments(
			makeSummary({ skills: [skill] }),
			makeContext(),
			new Map([["skill", [skill]]]),
		);
		const skillCall = mockPushToJolli.mock.calls.find((c) => (c[2] as { docType: string }).docType === "skill");
		expect(skillCall).toBeDefined();
		expect(result.updatedSummary.jolliSkillsDocId).toBe(501);
	});

	it("skips a snippet note with no content and pushes a markdown note's body", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) =>
			Promise.resolve({ docId: p.docType === "summary" ? 100 : 300 }),
		);
		const empty = { id: "empty", title: "Empty", format: "snippet" as const, content: "", addedAt: "t", updatedAt: "t" };
		const md = { id: "md", title: "MD", format: "markdown" as const, addedAt: "t", updatedAt: "t" };
		const result = await pushSummaryWithAttachments(makeSummary(), makeContext(), { plans: [], notes: [empty, md] });
		expect(result.pushedDoc.notes).toEqual([{ id: "md", title: "MD", docId: 300, url: "https://acme.jolli.ai/articles?doc=300" }]);
	});

	it("retries once after a binding is established", async () => {
		mockPushToJolli.mockRejectedValueOnce(new BindingRequiredError("bind")).mockResolvedValue({ docId: 100 });
		const ctx = makeContext({ resolveBinding: vi.fn().mockResolvedValue({ status: "bound" }) });
		const result = await pushSummaryWithAttachments(makeSummary(), ctx);
		expect(ctx.resolveBinding).toHaveBeenCalledOnce();
		expect(result.pushedDoc.summaryDocId).toBe(100);
	});

	it("throws ShareBindingError when the chooser is cancelled", async () => {
		mockPushToJolli.mockRejectedValue(new BindingRequiredError("bind"));
		const ctx = makeContext({ resolveBinding: vi.fn().mockResolvedValue({ status: "cancelled" }) });
		await expect(pushSummaryWithAttachments(makeSummary(), ctx)).rejects.toMatchObject({
			name: "ShareBindingError",
			outcome: "cancelled",
		});
	});

	it("surfaces anotherOpen as a ShareBindingError", async () => {
		mockPushToJolli.mockRejectedValue(new BindingRequiredError("bind"));
		const ctx = makeContext({ resolveBinding: vi.fn().mockResolvedValue({ status: "anotherOpen" }) });
		await expect(pushSummaryWithAttachments(makeSummary(), ctx)).rejects.toBeInstanceOf(ShareBindingError);
	});

	it("propagates a binding-required failure from a plan push to the chooser", async () => {
		// Fatal binding errors inside the plan loop must NOT be collected as attachment
		// failures — they abort the push and drive the binding chooser.
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "plan") return Promise.reject(new BindingRequiredError("bind"));
			return Promise.resolve({ docId: 100 });
		});
		const plan = { slug: "p-abc12345", title: "Plan", addedAt: "t", updatedAt: "t" };
		const ctx = makeContext({ resolveBinding: vi.fn().mockResolvedValue({ status: "cancelled" }) });
		await expect(
			pushSummaryWithAttachments(makeSummary({ plans: [plan] }), ctx, { plans: [plan], notes: [] }),
		).rejects.toBeInstanceOf(ShareBindingError);
		expect(ctx.resolveBinding).toHaveBeenCalledOnce();
	});

	it("propagates a plugin-outdated failure from a note push unchanged", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "note") return Promise.reject(new PluginOutdatedError("update the plugin"));
			return Promise.resolve({ docId: 100 });
		});
		const note = { id: "n1", title: "Note", format: "markdown" as const, addedAt: "t", updatedAt: "t" };
		const ctx = makeContext();
		await expect(
			pushSummaryWithAttachments(makeSummary(), ctx, { plans: [], notes: [note] }),
		).rejects.toBeInstanceOf(PluginOutdatedError);
		// Not a binding problem — the chooser must not open.
		expect(ctx.resolveBinding).not.toHaveBeenCalled();
	});

	it("propagates a permission refusal from a plan push instead of collecting it", async () => {
		// `repo_not_allowlisted` / ownership mismatch is a REPO-WIDE verdict: the
		// summary and every remaining attachment would be refused identically.
		// Collecting it would label a repo-wide condition as 'plan "Plan" failed'
		// and then fire the doomed summary request anyway.
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "plan") return Promise.reject(new PermissionDeniedError("repo not allowlisted"));
			return Promise.resolve({ docId: 100 });
		});
		const plan = { slug: "p-abc12345", title: "Plan", addedAt: "t", updatedAt: "t" };
		const ctx = makeContext();
		await expect(
			pushSummaryWithAttachments(makeSummary({ plans: [plan] }), ctx, { plans: [plan], notes: [] }),
		).rejects.toBeInstanceOf(PermissionDeniedError);
		// Only the doomed plan was attempted — no summary push followed it.
		expect(mockPushToJolli).toHaveBeenCalledOnce();
		expect(ctx.resolveBinding).not.toHaveBeenCalled();
	});

	it("propagates a mid-push opt-out from a note push instead of collecting it", async () => {
		// The HTTP client re-reads the flag per call so a mid-push opt-out takes
		// effect immediately (spec 306). That makes PushDisabledError reachable in
		// the attachment loop even though pushSummaryWithAttachments fails fast on
		// entry — and when it fires it must abort, not become a note failure.
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "note") return Promise.reject(new PushDisabledError());
			return Promise.resolve({ docId: 100 });
		});
		const note = { id: "n1", title: "Note", format: "markdown" as const, addedAt: "t", updatedAt: "t" };
		await expect(
			pushSummaryWithAttachments(makeSummary(), makeContext(), { plans: [], notes: [note] }),
		).rejects.toBeInstanceOf(PushDisabledError);
	});

	it("stringifies a non-Error plan failure into the collected message", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "plan") return Promise.reject("wire failure");
			return Promise.resolve({ docId: 100 });
		});
		const plan = { slug: "p-abc12345", title: "Plan", addedAt: "t", updatedAt: "t" };
		const result = await pushSummaryWithAttachments(makeSummary({ plans: [plan] }), makeContext(), {
			plans: [plan],
			notes: [],
		});
		expect(result.attachmentFailures).toEqual([{ label: 'plan "Plan"', message: "wire failure" }]);
	});

	it("stringifies a non-Error note failure into the collected message", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) => {
			if (p.docType === "note") return Promise.reject(404);
			return Promise.resolve({ docId: 100 });
		});
		const note = { id: "n1", title: "Note", format: "markdown" as const, addedAt: "t", updatedAt: "t" };
		const result = await pushSummaryWithAttachments(makeSummary(), makeContext(), { plans: [], notes: [note] });
		expect(result.attachmentFailures).toEqual([{ label: 'note "Note"', message: "404" }]);
	});

	it("deletes orphaned docs and clears them from the persisted summary", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		mockDeleteFromJolli.mockResolvedValue(undefined);
		const ctx = makeContext();
		const result = await pushSummaryWithAttachments(makeSummary({ orphanedDocIds: [7, 8] }), ctx);
		expect(mockDeleteFromJolli).toHaveBeenCalledTimes(2);
		expect(result.updatedSummary.orphanedDocIds).toBeUndefined();
	});

	it("still resolves a successful push when best-effort orphan cleanup throws", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		mockDeleteFromJolli.mockResolvedValue(undefined);
		// First storeSummary (persisting jolliDocId) succeeds; the second (cleanup bookkeeping) throws.
		const storeSummary = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("disk full"));
		const ctx = makeContext({ storeSummary });

		const result = await pushSummaryWithAttachments(makeSummary({ orphanedDocIds: [7] }), ctx);

		// The push succeeded server-side, so it must not surface as a failure.
		expect(result.pushedDoc.summaryDocId).toBe(100);
		expect(result.updatedSummary.jolliDocId).toBe(100);
	});

	it("still resolves a successful push when orphan cleanup throws a non-Error value", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		mockDeleteFromJolli.mockResolvedValue(undefined);
		// A non-Error rejection (e.g. a bare string) must be stringified by the
		// best-effort cleanup catch without surfacing as a failed push.
		const storeSummary = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce("disk full");
		const ctx = makeContext({ storeSummary });

		const result = await pushSummaryWithAttachments(makeSummary({ orphanedDocIds: [7] }), ctx);

		expect(result.pushedDoc.summaryDocId).toBe(100);
		expect(result.updatedSummary.jolliDocId).toBe(100);
	});

	it("skips a plan whose body cannot be read", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		mockReadPlan.mockResolvedValue("");
		const plan = { slug: "p-abc12345", title: "Plan", addedAt: "t", updatedAt: "t" };
		const result = await pushSummaryWithAttachments(makeSummary({ plans: [plan] }), makeContext(), {
			plans: [plan],
			notes: [],
		});
		expect(result.pushedDoc.plans).toEqual([]);
		expect(mockPushToJolli).toHaveBeenCalledTimes(1); // summary only
	});

	it("strict mode reports unreadable attachment bodies as failures instead of silently treating stale docIds as current", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		mockReadPlan.mockResolvedValue("");
		mockReadNote.mockResolvedValue("");
		const plan = { slug: "p-abc12345", title: "Plan", addedAt: "t", updatedAt: "t", jolliPlanDocId: 200 };
		const note = { id: "n1", title: "Note", format: "markdown" as const, addedAt: "t", updatedAt: "t", jolliNoteDocId: 300 };
		const snippet = { id: "s1", title: "Snippet", format: "snippet" as const, content: "", addedAt: "t", updatedAt: "t" };

		const result = await pushSummaryWithAttachments(
			makeSummary({ plans: [plan], notes: [note, snippet] }),
			makeContext(),
			{ plans: [plan], notes: [note, snippet] },
			{ strictAttachments: true },
		);

		expect(result.attachmentFailures).toEqual([
			{ label: 'plan "Plan"', message: "Plan content for p-abc12345 could not be read." },
			{ label: 'note "Note"', message: "Note content for n1 could not be read." },
			// The generic attachment loop reports every unreadable body with one message
			// shape; the old snippet-specific wording ("Snippet note content … is empty")
			// was folded into it when the loop became kind-driven.
			{ label: 'note "Snippet"', message: "Note content for s1 could not be read." },
		]);
		expect(result.pushedDoc.plans).toEqual([]);
		expect(result.pushedDoc.notes).toEqual([]);
		expect(mockPushToJolli).toHaveBeenCalledTimes(1); // summary only
	});

	it("attaches the serialized summary JSON to the summary push — bookkeeping stripped, pushed plan URLs woven in", async () => {
		mockPushToJolli.mockImplementation((_b, _k, p: { docType: string }) =>
			Promise.resolve({ docId: p.docType === "summary" ? 100 : 200 }),
		);
		mockDeleteFromJolli.mockResolvedValue(undefined);
		const plan = { slug: "p-abc12345", title: "Plan", addedAt: "t", updatedAt: "t" };
		const summary = makeSummary({
			plans: [plan],
			jolliDocId: 55,
			jolliDocUrl: "https://acme.jolli.ai/articles?doc=55",
			orphanedDocIds: [7],
		});
		await pushSummaryWithAttachments(summary, makeContext(), { plans: [plan], notes: [] });

		const summaryCall = mockPushToJolli.mock.calls.find(c => (c[2] as { docType: string }).docType === "summary");
		const payload = summaryCall?.[2] as { summaryJson?: string };
		const parsed = JSON.parse(payload.summaryJson ?? "");
		expect(parsed.commitHash).toBe("abc123");
		// Client push-state never travels in the structured content.
		expect(parsed.jolliDocId).toBeUndefined();
		expect(parsed.jolliDocUrl).toBeUndefined();
		expect(parsed.orphanedDocIds).toBeUndefined();
		// The serialized copy is the ENRICHED one: this push's plan URL is woven in.
		expect(parsed.plans[0].jolliPlanDocId).toBe(200);
		expect(parsed.plans[0].jolliPlanDocUrl).toBe("https://acme.jolli.ai/articles?doc=200");
	});

	it("never attaches summaryJson to plan or note pushes", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const plan = { slug: "p-abc12345", title: "Plan", addedAt: "t", updatedAt: "t" };
		const note = { id: "n1", title: "Note", format: "markdown" as const, addedAt: "t", updatedAt: "t" };
		await pushSummaryWithAttachments(makeSummary(), makeContext(), { plans: [plan], notes: [note] });

		expect(mockPushToJolli).toHaveBeenCalledTimes(3);
		for (const call of mockPushToJolli.mock.calls) {
			const p = call[2] as { docType: string; summaryJson?: string };
			if (p.docType !== "summary") {
				expect(p.summaryJson).toBeUndefined();
			}
		}
	});

	it("omits summaryJson (and still pushes the markdown) when the summary serializes over the byte cap", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const huge = makeSummary({ recap: "x".repeat(1_600_000) });
		const result = await pushSummaryWithAttachments(huge, makeContext());

		expect(result.pushedDoc.summaryDocId).toBe(100);
		const payload = mockPushToJolli.mock.calls[0][2] as { summaryJson?: string };
		expect(payload.summaryJson).toBeUndefined();
	});
});

describe("session enrichment on pushSummaryWithAttachments", () => {
	const ONE_SESSION = {
		sessions: [
			{
				sessionId: "s1",
				source: "claude" as const,
				entries: [
					{ role: "human" as const, content: "a", timestamp: "2026-08-01T09:00:00.000Z" },
					{ role: "assistant" as const, content: "b", timestamp: "2026-08-01T10:10:00.000Z" },
				],
			},
		],
	};

	function summaryText(): { calls: unknown[][] } {
		return { calls: mockPushToJolli.mock.calls };
	}

	function summaryPayload(): { summaryJson?: string } {
		const call = summaryText().calls.find((c) => (c[2] as { docType: string }).docType === "summary");
		return call?.[2] as { summaryJson?: string };
	}

	it("weaves transcriptSessions into the pushed summaryJson when a transcript is readable", async () => {
		mockTranscriptsBatch(ONE_SESSION);
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const summary = makeSummary({ transcripts: ["t1"] });

		await pushSummaryWithAttachments(summary, makeContext());

		const parsed = JSON.parse(summaryPayload().summaryJson ?? "{}");
		expect(parsed.transcriptSessions).toEqual([
			{
				sessionId: "s1",
				source: "claude",
				messageCount: 2,
				startedAt: "2026-08-01T09:00:00.000Z",
				endedAt: "2026-08-01T10:10:00.000Z",
			},
		]);
	});

	it("still pushes without transcriptSessions when the enrichment itself rejects (call-site defense)", async () => {
		// Regression: `collectTranscriptSessionMeta` used to be awaited unguarded here.
		// Any throw inside it (not just a `readTranscriptsBatch` failure — e.g. id
		// resolution over a malformed summary tree) aborted the whole push before
		// `pushToJolli` was ever reached. The enrichment is an optional extra, so a
		// rejection here must degrade to "no sessions", never abort the push.
		mockCollectTranscriptSessionMeta.mockRejectedValueOnce(new Error("enrichment boom"));
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const summary = makeSummary({ transcripts: ["t1"] });

		const result = await pushSummaryWithAttachments(summary, makeContext());

		expect(result.pushedDoc.summaryDocId).toBe(100);
		expect(mockPushToJolli).toHaveBeenCalled();
		const parsed = JSON.parse(summaryPayload().summaryJson ?? "{}");
		expect(parsed).not.toHaveProperty("transcriptSessions");
	});

	it("omits transcriptSessions entirely when no session is derivable", async () => {
		mockTranscriptsBatch(null);
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const summary = makeSummary({ transcripts: ["t1"] });

		await pushSummaryWithAttachments(summary, makeContext());

		const parsed = JSON.parse(summaryPayload().summaryJson ?? "{}");
		expect(parsed).not.toHaveProperty("transcriptSessions");
	});

	it("never persists the enrichment on the stored summary", async () => {
		mockTranscriptsBatch(ONE_SESSION);
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const summary = makeSummary({ transcripts: ["t1"] });
		const ctx = makeContext();

		await pushSummaryWithAttachments(summary, ctx);

		const stored = (ctx.storeSummary as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as CommitSummary;
		expect(stored).not.toHaveProperty("transcriptSessions");
	});
});

describe("serializeSummaryJson", () => {
	it("strips jolliDocId/jolliDocUrl/orphanedDocIds and keeps content fields", () => {
		const json = serializeSummaryJson(
			makeSummary({
				jolliDocId: 55,
				jolliDocUrl: "https://x",
				orphanedDocIds: [1],
				recap: "did things",
			}),
		);
		const parsed = JSON.parse(json ?? "");
		expect(parsed).toEqual(expect.objectContaining({ commitHash: "abc123", recap: "did things" }));
		expect(Object.keys(parsed)).not.toEqual(
			expect.arrayContaining(["jolliDocId", "jolliDocUrl", "orphanedDocIds"]),
		);
	});

	it("strips the skill-article publish state too (the skill push runs first and weaves it on)", () => {
		const json = serializeSummaryJson(
			makeSummary({
				jolliSkillsDocId: 42,
				jolliSkillsDocUrl: "https://acme.jolli.ai/articles?doc=42",
				skills: [{ source: "claude", skill: "jolli-recall", uses: 2 }],
			} as unknown as Partial<CommitSummary>),
		);
		const parsed = JSON.parse(json ?? "");
		expect(parsed.jolliSkillsDocId).toBeUndefined();
		expect(parsed.jolliSkillsDocUrl).toBeUndefined();
		// The skill rows themselves are commit content and stay.
		expect(parsed.skills).toHaveLength(1);
	});

	it("keeps nested plan/note/reference docId/url (needed to render the article links)", () => {
		const json = serializeSummaryJson(
			makeSummary({
				plans: [{ slug: "p1", jolliPlanDocId: 9, jolliPlanDocUrl: "pu" }],
				notes: [{ id: "n1", jolliNoteDocId: 8, jolliNoteDocUrl: "nu" }],
				references: [{ archivedKey: "linear:E-1-abcd1234", jolliReferenceDocId: 7, jolliReferenceDocUrl: "ru" }],
			} as unknown as Partial<CommitSummary>),
		);
		const parsed = JSON.parse(json ?? "");
		expect(parsed.plans[0].jolliPlanDocId).toBe(9);
		expect(parsed.plans[0].jolliPlanDocUrl).toBe("pu");
		expect(parsed.notes[0].jolliNoteDocUrl).toBe("nu");
		expect(parsed.references[0].jolliReferenceDocUrl).toBe("ru");
	});

	it("returns undefined for a summary that serializes over the byte cap", () => {
		expect(serializeSummaryJson(makeSummary({ recap: "x".repeat(1_600_000) }))).toBeUndefined();
	});
});

describe("serializeSummaryJson session enrichment", () => {
	it("carries transcriptSessions through when the payload fits", () => {
		const json = serializeSummaryJson({
			...makeSummary({ recap: "x".repeat(10) }),
			transcriptSessions: [
				{
					sessionId: "s1",
					source: "claude",
					messageCount: 3,
					startedAt: "2026-08-01T09:00:00.000Z",
					endedAt: "2026-08-01T10:10:00.000Z",
				},
			],
		});

		expect(json).toBeDefined();
		expect(JSON.parse(json as string).transcriptSessions).toEqual([
			{
				sessionId: "s1",
				source: "claude",
				messageCount: 3,
				startedAt: "2026-08-01T09:00:00.000Z",
				endedAt: "2026-08-01T10:10:00.000Z",
			},
		]);
	});

	it("drops only the enrichment when it is what pushes the payload over the cap", () => {
		// 1.5 MB is 1_572_864 bytes; leave under 400 bytes of headroom so a handful
		// of session rows is the difference between fitting and not.
		const base = makeSummary({ recap: "x".repeat(1_572_500) });
		const withoutEnrichment = serializeSummaryJson(base);
		expect(withoutEnrichment).toBeDefined();

		const json = serializeSummaryJson({
			...base,
			transcriptSessions: Array.from({ length: 20 }, (_, i) => ({
				sessionId: `session-${i}`,
				source: "claude",
				messageCount: 10,
				startedAt: "2026-08-01T09:00:00.000Z",
				endedAt: "2026-08-01T10:10:00.000Z",
			})),
		});

		// The sidecar survives; only the enrichment is gone.
		expect(json).toBe(withoutEnrichment);
		expect(JSON.parse(json as string)).not.toHaveProperty("transcriptSessions");
	});

	it("still returns undefined when the payload is oversized without any enrichment", () => {
		expect(serializeSummaryJson(makeSummary({ recap: "x".repeat(2_000_000) }))).toBeUndefined();
	});
});
