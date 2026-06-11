import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./LlmClient.js", () => ({ callLlm: vi.fn() }));
vi.mock("./SourceTimeline.js", async (orig) => ({
	...(await orig<typeof import("./SourceTimeline.js")>()),
	listPendingSources: vi.fn(),
}));
vi.mock("./ProcessedSourceStore.js", async (orig) => ({
	...(await orig<typeof import("./ProcessedSourceStore.js")>()),
	readProcessedSet: vi.fn(),
	saveProcessedSet: vi.fn(),
}));
vi.mock("./TopicIndexStore.js", () => ({
	readTopicIndex: vi.fn(async () => ({ schemaVersion: 1, topics: [] })),
	saveTopicIndex: vi.fn(),
}));
vi.mock("./TopicPageStore.js", () => ({ readTopicPage: vi.fn(async () => null), saveTopicPage: vi.fn() }));
vi.mock("./SourceContent.js", () => ({
	loadSourceHeadline: vi.fn(async (r) => `headline ${r.id}`),
	loadSourceContent: vi.fn(async (r) => `content ${r.id}`),
}));
vi.mock("./IngestRunStore.js", () => ({ appendIngestRun: vi.fn() }));
// Without this mock, every `ingestPendingBatch("/tmp/x", …)` call that omits
// `opts.readStorage` runs the REAL createReadStorage → loadConfig reads the
// developer's actual ~/.jolli config → resolveKBPath claims a stub `x/` folder
// inside their real Memory Bank (`<localFolder>/x`). Same pattern as
// SourceTimeline.test.ts. All storage consumers above are mocked, so the
// dummy provider is never actually read.
vi.mock("./ReadStorageResolver.js", () => ({ createReadStorage: vi.fn(async () => ({})) }));

import { drainIngest, ingestPendingBatch } from "./IngestPipeline.js";
import { appendIngestRun } from "./IngestRunStore.js";
import { callLlm } from "./LlmClient.js";
import { emptyProcessedSet, readProcessedSet, saveProcessedSet } from "./ProcessedSourceStore.js";
import { loadSourceContent } from "./SourceContent.js";
import { listPendingSources } from "./SourceTimeline.js";
import type { StorageProvider } from "./StorageProvider.js";
import { readTopicIndex, saveTopicIndex } from "./TopicIndexStore.js";
import type { SourceRef, TopicPage } from "./TopicKBTypes.js";
import { readTopicPage, saveTopicPage } from "./TopicPageStore.js";

const cfg = { apiKey: "k" };
const llmText = (_action: string, text: string) => ({
	text,
	stopReason: "end_turn",
	inputTokens: 0,
	outputTokens: 0,
	apiLatencyMs: 0,
	source: "anthropic-config" as const,
});
const reconcileOut = (slug: string) =>
	`===TOPIC===\n---TITLE---\nT\n---STABLESLUG---\n${slug}\n---SUMMARY---\nsum\n---CONTENT---\nbody\n`;
const s = (id: string, ts: string): SourceRef => ({ type: "summary", id, timestamp: ts });
const sb = (id: string, ts: string, branch: string): SourceRef => ({ type: "summary", id, timestamp: ts, branch });

describe("ingestPendingBatch", () => {
	beforeEach(() => {
		vi.mocked(readProcessedSet).mockResolvedValue(emptyProcessedSet());
		vi.mocked(saveProcessedSet).mockReset();
		vi.mocked(saveTopicPage).mockReset();
		vi.mocked(callLlm).mockReset();
		vi.mocked(listPendingSources).mockReset();
		vi.mocked(readTopicIndex).mockResolvedValue({ schemaVersion: 1, topics: [] });
		vi.mocked(readTopicPage).mockResolvedValue(null);
		vi.mocked(saveTopicIndex).mockReset();
		vi.mocked(loadSourceContent).mockReset();
		// biome-ignore lint/suspicious/noExplicitAny: minimal SourceRef stub for the default body loader
		vi.mocked(loadSourceContent).mockImplementation(async (r: any) => `content ${r.id}`);
	});

	it("no-ops on empty pending", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([]);
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r).toEqual({
			ingested: 0,
			touchedSlugs: [],
			done: true,
			pendingCount: 0,
			reconcileCalls: 0,
			topicFailures: [],
		});
		expect(vi.mocked(callLlm)).not.toHaveBeenCalled();
	});

	it("issues the route call with forceStreaming so it takes LlmClient's streaming path", async () => {
		// The route call can run long; it must take the streaming path (no fixed
		// 180s direct-call cap) via an explicit flag, not by padding maxTokens
		// above a threshold that could later be retuned out from under it.
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm).mockResolvedValueOnce(llmText("route", JSON.stringify({ updates: [], newTopics: [] })));
		await ingestPendingBatch("/tmp/x", cfg);
		const routeCall = vi.mocked(callLlm).mock.calls[0]?.[0];
		expect(routeCall?.action).toBe("route");
		expect(routeCall?.forceStreaming).toBe(true);
	});

	it("feeds reconcile source bodies in chronological order (old -> new)", async () => {
		// pending given out of order; the pipeline must sort assigned bodies old->new.
		vi.mocked(listPendingSources).mockResolvedValue([
			s("cNew", "2026-02-01T00:00:00Z"),
			s("cOld", "2026-01-01T00:00:00Z"),
		]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({
						updates: [],
						newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0, 1] }],
					}),
				),
			)
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("t")));
		await ingestPendingBatch("/tmp/x", cfg);
		const reconcileCall = vi.mocked(callLlm).mock.calls[1]?.[0];
		const sources = reconcileCall?.params.sources ?? "";
		expect(sources.indexOf("content cOld")).toBeLessThan(sources.indexOf("content cNew"));
	});

	it("routes + reconciles + marks all sources on the happy path", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({
						updates: [],
						newTopics: [{ stableSlug: "auth", title: "Auth", sourceIndexes: [0] }],
					}),
				),
			)
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("auth")));
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.ingested).toBe(1);
		expect(r.touchedSlugs).toEqual(["auth"]);
		expect(vi.mocked(saveTopicPage)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(saveProcessedSet)).toHaveBeenCalledTimes(1);
	});

	it("threads the injected readStorage into processed-set / topic-index / topic-page reads", async () => {
		// In dual-write mode these reads must hit the SAME folder view as listPendingSources
		// and loadSource*, or route and reconcile work off split snapshots. An `updates`
		// route (not newTopics) is used so the non-new branch reaches readTopicPage.
		const readStorage = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
		} as unknown as StorageProvider;
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({ updates: [{ stableSlug: "auth", sourceIndexes: [0] }], newTopics: [] }),
				),
			)
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("auth")));

		await ingestPendingBatch("/tmp/x", cfg, { readStorage });

		expect(vi.mocked(readProcessedSet)).toHaveBeenCalledWith("/tmp/x", readStorage);
		expect(vi.mocked(readTopicIndex)).toHaveBeenCalledWith("/tmp/x", readStorage);
		expect(vi.mocked(readTopicPage)).toHaveBeenCalledWith("auth", "/tmp/x", readStorage);
	});

	it("derives relatedBranches from the contributing sources, ignoring the LLM's advisory output", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([
			sb("c0", "2026-01-01T00:00:00Z", "signin-oauth-code"),
			sb("c1", "2026-01-02T00:00:00Z", "fix-oauth-copy-url"),
		]);
		// reconcile emits a misleading RELATEDBRANCHES (the field is advisory only).
		const reconcileWithBogusBranches =
			"===TOPIC===\n---TITLE---\nT\n---STABLESLUG---\nauth\n---SUMMARY---\nsum\n---CONTENT---\nbody\n---RELATEDBRANCHES---\n(unknown), bogus-branch\n";
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({
						updates: [],
						newTopics: [{ stableSlug: "auth", title: "Auth", sourceIndexes: [0, 1] }],
					}),
				),
			)
			.mockResolvedValueOnce(llmText("reconcile", reconcileWithBogusBranches));
		await ingestPendingBatch("/tmp/x", cfg);
		const page = vi.mocked(saveTopicPage).mock.calls[0]?.[0];
		expect(page?.relatedBranches).toEqual(["signin-oauth-code", "fix-oauth-copy-url"]);
		expect(page?.relatedBranches).not.toContain("(unknown)");
		expect(page?.relatedBranches).not.toContain("bogus-branch");
	});

	it("aborts and marks nothing when route truncates", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm).mockResolvedValueOnce({
			text: "{partial",
			stopReason: "max_tokens",
			inputTokens: 0,
			outputTokens: 0,
			apiLatencyMs: 0,
			source: "anthropic-config",
		});
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.ingested).toBe(0);
		expect(vi.mocked(saveProcessedSet)).not.toHaveBeenCalled();
	});

	it("holds back a source whose one of two target pages fails", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({
						updates: [
							{ stableSlug: "auth", sourceIndexes: [0] },
							{ stableSlug: "storage", sourceIndexes: [0] },
						],
						newTopics: [],
					}),
				),
			)
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("auth"))) // auth ok
			.mockResolvedValueOnce({
				text: "",
				stopReason: "max_tokens",
				inputTokens: 0,
				outputTokens: 0,
				apiLatencyMs: 0,
				source: "anthropic-config",
			}); // storage fails
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.ingested).toBe(0); // c0 targeted both; storage failed -> not marked
		expect(vi.mocked(saveTopicPage)).toHaveBeenCalledTimes(1); // auth still written
		expect(vi.mocked(saveProcessedSet)).not.toHaveBeenCalled();
	});

	it("reports done=false when more than N pending", async () => {
		const many = Array.from({ length: 3 }, (_, i) => s(`c${i}`, `2026-01-0${i + 1}T00:00:00Z`));
		vi.mocked(listPendingSources).mockResolvedValue(many);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({
						updates: [],
						newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0, 1] }],
					}),
				),
			)
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("t")));
		const r = await ingestPendingBatch("/tmp/x", cfg, { batchSize: 2 });
		expect(r.done).toBe(false);
	});

	it("holds a topic and reports RECONCILE_TRUNCATED without marking its sources", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c1", "2026-01-01T00:00:00Z")]);
		const truncated = { ...llmText("reconcile", ""), stopReason: "max_tokens" as const };
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({ updates: [], newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0] }] }),
				),
			)
			.mockResolvedValueOnce(truncated);
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.ingested).toBe(0);
		expect(r.topicFailures).toEqual([{ slug: "t", code: "RECONCILE_TRUNCATED" }]);
		expect(r.reconcileCalls).toBe(1);
		expect(vi.mocked(saveProcessedSet)).not.toHaveBeenCalled();
	});

	it("reports RECONCILE_PARSE_FAILED when the block is unparseable", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c1", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({ updates: [], newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0] }] }),
				),
			)
			.mockResolvedValueOnce(llmText("reconcile", "garbage with no topic block"));
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.topicFailures).toEqual([{ slug: "t", code: "RECONCILE_PARSE_FAILED" }]);
		expect(r.reconcileCalls).toBe(1);
	});

	it("returns ROUTE_FAILED and marks nothing when route output is invalid", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c1", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm).mockResolvedValueOnce(llmText("route", "not json at all"));
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.errorCode).toBe("ROUTE_FAILED");
		expect(r.ingested).toBe(0);
		expect(vi.mocked(saveProcessedSet)).not.toHaveBeenCalled();
	});

	it("marks only the fully-successful source in a mixed batch (one topic ok, one held)", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([
			s("good", "2026-01-01T00:00:00Z"),
			s("bad", "2026-01-02T00:00:00Z"),
		]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({
						updates: [],
						newTopics: [
							{ stableSlug: "ok", title: "Ok", sourceIndexes: [0] },
							{ stableSlug: "held", title: "Held", sourceIndexes: [1] },
						],
					}),
				),
			)
			// reconcile order is concurrency-dependent; return by topicTitle, not call order
			.mockImplementation(async (req) => {
				if (req.action === "reconcile") {
					return req.params.topicTitle === "Ok"
						? llmText("reconcile", reconcileOut("ok"))
						: { ...llmText("reconcile", ""), stopReason: "max_tokens" as const };
				}
				return llmText("route", "");
			});
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.touchedSlugs).toEqual(["ok"]);
		expect(r.topicFailures.map((f) => f.slug)).toEqual(["held"]);
		const marked = vi.mocked(saveProcessedSet).mock.calls[0]?.[0];
		expect(marked?.processed.summary).toEqual(["good"]);
	});

	it("skips a vanished source body but still reconciles from the surviving sources", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([
			s("gone", "2026-01-01T00:00:00Z"),
			s("here", "2026-01-02T00:00:00Z"),
		]);
		// `gone` has no loadable body (deleted upstream); `here` survives.
		// biome-ignore lint/suspicious/noExplicitAny: minimal SourceRef stub
		vi.mocked(loadSourceContent).mockImplementation(async (r: any) => (r.id === "gone" ? null : `content ${r.id}`));
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({
						updates: [],
						newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0, 1] }],
					}),
				),
			)
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("t")));
		await ingestPendingBatch("/tmp/x", cfg);
		const reconcileCall = vi.mocked(callLlm).mock.calls[1]?.[0];
		const sources = reconcileCall?.params.sources ?? "";
		expect(sources).toContain("content here");
		expect(sources).not.toContain("content gone");
		// only the surviving ref is folded into the page's sourceRefs
		const page = vi.mocked(saveTopicPage).mock.calls[0]?.[0];
		expect(page?.sourceRefs.map((r) => r.id)).toEqual(["here"]);
	});

	it("reports NO_SOURCE_CONTENT and skips the LLM when every source body vanished", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("gone", "2026-01-01T00:00:00Z")]);
		vi.mocked(loadSourceContent).mockResolvedValue(null);
		vi.mocked(callLlm).mockResolvedValueOnce(
			llmText(
				"route",
				JSON.stringify({ updates: [], newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0] }] }),
			),
		);
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.topicFailures).toEqual([{ slug: "t", code: "NO_SOURCE_CONTENT" }]);
		// NO_SOURCE_CONTENT short-circuits before callLlm -> not counted as a reconcile call
		expect(r.reconcileCalls).toBe(0);
		expect(vi.mocked(callLlm)).toHaveBeenCalledTimes(1); // route only
		expect(vi.mocked(saveProcessedSet)).not.toHaveBeenCalled();
	});

	it("degrades a thrown reconcile task to a held RECONCILE_CALL_FAILED (not a parse failure)", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm).mockImplementation(async (req) => {
			if (req.action === "reconcile") throw new Error("network blew up");
			return llmText(
				"route",
				JSON.stringify({ updates: [], newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0] }] }),
			);
		});
		const r = await ingestPendingBatch("/tmp/x", cfg);
		// A transport throw is a CALL failure, not a deterministic content (parse) failure.
		expect(r.topicFailures).toEqual([{ slug: "t", code: "RECONCILE_CALL_FAILED" }]);
		expect(r.reconcileCalls).toBe(1); // the throwing call still counts as issued
		expect(vi.mocked(saveProcessedSet)).not.toHaveBeenCalled();
	});

	it("marks an un-filed source (routed to no topic) as processed", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		// route returns an empty plan: c0 is routed nowhere.
		vi.mocked(callLlm).mockResolvedValueOnce(llmText("route", JSON.stringify({ updates: [], newTopics: [] })));
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.ingested).toBe(1);
		expect(r.touchedSlugs).toEqual([]);
		expect(vi.mocked(callLlm)).toHaveBeenCalledTimes(1); // route only, no reconcile
		expect(vi.mocked(saveTopicIndex)).not.toHaveBeenCalled(); // no page changed
		const marked = vi.mocked(saveProcessedSet).mock.calls[0]?.[0];
		expect(marked?.processed.summary).toEqual(["c0"]);
	});

	it("formats a non-empty topic index into the route prompt and merges/dedups refs on an existing page", async () => {
		const existingRef = s("c0", "2026-01-01T00:00:00Z");
		const newRef = s("c1", "2026-01-02T00:00:00Z");
		vi.mocked(listPendingSources).mockResolvedValue([existingRef, newRef]);
		// index already lists the topic -> formatIndexForRoute emits the bullet, and the
		// serial apply phase takes the upsert UPDATE branch (slug already present).
		vi.mocked(readTopicIndex).mockResolvedValue({
			schemaVersion: 1,
			topics: [
				{
					stableSlug: "auth",
					title: "Auth",
					summary: "existing summary",
					relatedBranches: [],
					sourceRefs: [existingRef],
					lastUpdatedAt: "2026-01-01T00:00:00Z",
				},
			],
		});
		// existing page already folded c0 -> mergeRefs must dedup it and append only c1.
		const existingPage: TopicPage = {
			schemaVersion: 1,
			stableSlug: "auth",
			title: "Auth",
			content: "old body",
			relatedBranches: [],
			sourceRefs: [existingRef],
			lastUpdatedAt: "2026-01-01T00:00:00Z",
		};
		vi.mocked(readTopicPage).mockResolvedValue(existingPage);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({ updates: [{ stableSlug: "auth", sourceIndexes: [0, 1] }], newTopics: [] }),
				),
			)
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("auth")));
		const r = await ingestPendingBatch("/tmp/x", cfg);
		const routeCall = vi.mocked(callLlm).mock.calls[0]?.[0];
		expect(routeCall?.params.topicIndex).toContain("- auth -- Auth: existing summary");
		expect(r.touchedSlugs).toEqual(["auth"]);
		// c0 deduped, c1 appended -> exactly two refs, no duplicate.
		const page = vi.mocked(saveTopicPage).mock.calls[0]?.[0];
		expect(page?.sourceRefs.map((x) => x.id)).toEqual(["c0", "c1"]);
		// index updated in place (not appended) -> still a single topic entry.
		const savedIndex = vi.mocked(saveTopicIndex).mock.calls[0]?.[0];
		expect(savedIndex?.topics).toHaveLength(1);
		expect(savedIndex?.topics[0].stableSlug).toBe("auth");
	});

	it("treats a null-text route response as invalid JSON (ROUTE_FAILED)", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm).mockResolvedValueOnce({
			text: undefined,
			stopReason: "end_turn",
			inputTokens: 0,
			outputTokens: 0,
			apiLatencyMs: 0,
			source: "anthropic-config",
		});
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.errorCode).toBe("ROUTE_FAILED");
	});

	it("treats a null-text reconcile response as an unparseable page (RECONCILE_PARSE_FAILED)", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({ updates: [], newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0] }] }),
				),
			)
			.mockResolvedValueOnce({
				text: undefined,
				stopReason: "end_turn",
				inputTokens: 0,
				outputTokens: 0,
				apiLatencyMs: 0,
				source: "anthropic-config",
			});
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.topicFailures).toEqual([{ slug: "t", code: "RECONCILE_PARSE_FAILED" }]);
	});
});

describe("drainIngest", () => {
	beforeEach(() => {
		vi.mocked(readProcessedSet).mockResolvedValue(emptyProcessedSet());
		vi.mocked(saveProcessedSet).mockReset();
		vi.mocked(callLlm).mockReset();
		vi.mocked(listPendingSources).mockReset();
	});

	it("loops across batches until pending is empty", async () => {
		vi.mocked(listPendingSources)
			.mockResolvedValueOnce([s("c0", "2026-01-01T00:00:00Z"), s("c1", "2026-01-02T00:00:00Z")])
			.mockResolvedValueOnce([s("c1", "2026-01-02T00:00:00Z")]);
		vi.mocked(callLlm).mockImplementation(async (o) =>
			o.action === "route"
				? llmText(
						"route",
						JSON.stringify({
							updates: [],
							newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0] }],
						}),
					)
				: llmText("reconcile", reconcileOut("t")),
		);
		const r = await drainIngest("/tmp/x", cfg, { batchSize: 1 });
		expect(r.batches).toBe(2);
		expect(r.ingested).toBe(2);
	});

	it("trips the adaptive iteration guard when the pipeline never drains", async () => {
		// 2 pending, batchSize 1 -> guard = ceil(2/1)+2 = 4. Every reconcile fails, so
		// nothing is marked and `done` is always false -> the guard must stop the loop.
		vi.mocked(listPendingSources).mockResolvedValue([
			s("c0", "2026-01-01T00:00:00Z"),
			s("c1", "2026-01-02T00:00:00Z"),
		]);
		vi.mocked(callLlm).mockImplementation(async (o) =>
			o.action === "route"
				? llmText(
						"route",
						JSON.stringify({
							updates: [],
							newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0] }],
						}),
					)
				: {
						text: "",
						stopReason: "max_tokens",
						inputTokens: 0,
						outputTokens: 0,
						apiLatencyMs: 0,
						source: "anthropic-config" as const,
					},
		);
		const r = await drainIngest("/tmp/x", cfg, { batchSize: 1 });
		expect(r.batches).toBe(4);
		expect(r.ingested).toBe(0);
	});

	it("records one OK run with aggregated counts", async () => {
		vi.mocked(appendIngestRun).mockReset();
		vi.mocked(listPendingSources)
			.mockResolvedValueOnce([s("c1", "2026-01-01T00:00:00Z")])
			.mockResolvedValueOnce([]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({ updates: [], newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0] }] }),
				),
			)
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("t")));
		const out = await drainIngest("/tmp/x", cfg, { triggeredBy: "post-merge", nowIso: "2026-06-05T00:00:00.000Z" });
		expect(out.outcome).toBe("OK");
		const rec = vi.mocked(appendIngestRun).mock.calls[0]?.[1];
		expect(rec).toMatchObject({
			triggeredBy: "post-merge",
			outcome: "OK",
			ingested: 1,
			touchedSlugs: 1,
			reconcileCalls: 1,
			startedAt: "2026-06-05T00:00:00.000Z",
		});
		expect(typeof rec?.durationMs).toBe("number");
	});

	it("records NO_PENDING when nothing is pending", async () => {
		vi.mocked(appendIngestRun).mockReset();
		vi.mocked(listPendingSources).mockResolvedValue([]);
		const out = await drainIngest("/tmp/x", cfg);
		expect(out.outcome).toBe("NO_PENDING");
		expect(vi.mocked(appendIngestRun).mock.calls[0]?.[1].triggeredBy).toBe("manual");
	});

	it("stops the loop and surfaces the batch errorCode when route fails", async () => {
		vi.mocked(appendIngestRun).mockReset();
		vi.mocked(listPendingSources).mockResolvedValue([s("c0", "2026-01-01T00:00:00Z")]);
		// route output is unparseable -> batch returns errorCode ROUTE_FAILED.
		vi.mocked(callLlm).mockResolvedValue(llmText("route", "not json"));
		const out = await drainIngest("/tmp/x", cfg);
		expect(out.outcome).toBe("ROUTE_FAILED");
		expect(out.batches).toBe(1); // loop broke on the first batch's errorCode
		expect(vi.mocked(appendIngestRun).mock.calls[0]?.[1].outcome).toBe("ROUTE_FAILED");
	});
});
