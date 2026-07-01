import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../../../cli/src/Types.js";

const { mockPushToJolli, mockDeleteFromJolli } = vi.hoisted(() => ({
	mockPushToJolli: vi.fn(),
	mockDeleteFromJolli: vi.fn(),
}));
const { mockReadPlan, mockReadNote } = vi.hoisted(() => ({
	mockReadPlan: vi.fn(),
	mockReadNote: vi.fn(),
}));

// Stub only the network functions; keep BindingRequiredError / PluginOutdatedError real (instanceof).
vi.mock("./JolliPushService.js", async (importActual) => {
	const actual = await importActual<typeof import("./JolliPushService.js")>();
	return { ...actual, pushToJolli: mockPushToJolli, deleteFromJolli: mockDeleteFromJolli };
});
vi.mock("../../../cli/src/core/SummaryStore.js", () => ({
	readPlanFromBranch: mockReadPlan,
	readNoteFromBranch: mockReadNote,
}));
vi.mock("../views/SummaryMarkdownBuilder.js", () => ({ buildMarkdown: () => "# markdown" }));
vi.mock("../../../cli/src/core/Telemetry.js", () => ({ track: vi.fn() }));
vi.mock("../util/Logger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { BindingRequiredError, PluginOutdatedError } from "./JolliPushService.js";
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

	it("pushes only the caller-chosen attachments (empty selection → no plan/note pushes)", async () => {
		mockPushToJolli.mockResolvedValue({ docId: 100 });
		const summary = makeSummary({
			plans: [{ slug: "p-abc12345", title: "Plan", addedAt: "t", updatedAt: "t" }],
		});
		await pushSummaryWithAttachments(summary, makeContext(), { plans: [], notes: [] });
		// Only the summary doc is pushed — the summary's own plan is NOT, because the selection was empty.
		expect(mockPushToJolli).toHaveBeenCalledTimes(1);
		expect(mockPushToJolli).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ docType: "summary" }));
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
		expect(mockPushToJolli).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ docType: "plan", docId: 200 }));
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
			{ label: 'note "Snippet"', message: "Snippet note content for s1 is empty." },
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

describe("serializeSummaryJson", () => {
	it("strips jolliDocId/jolliDocUrl/orphanedDocIds and keeps content fields", () => {
		const json = serializeSummaryJson(
			makeSummary({ jolliDocId: 55, jolliDocUrl: "https://x", orphanedDocIds: [1], recap: "did things" }),
		);
		const parsed = JSON.parse(json ?? "");
		expect(parsed).toEqual(expect.objectContaining({ commitHash: "abc123", recap: "did things" }));
		expect(Object.keys(parsed)).not.toEqual(
			expect.arrayContaining(["jolliDocId", "jolliDocUrl", "orphanedDocIds"]),
		);
	});

	it("returns undefined for a summary that serializes over the byte cap", () => {
		expect(serializeSummaryJson(makeSummary({ recap: "x".repeat(1_600_000) }))).toBeUndefined();
	});
});
