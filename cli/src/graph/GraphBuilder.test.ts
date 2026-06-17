import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "../core/StorageProvider.js";

const { readTopicIndex, readTopicPage, distillGraph, writeGraphArtifacts } = vi.hoisted(() => ({
	readTopicIndex: vi.fn(),
	readTopicPage: vi.fn(),
	distillGraph: vi.fn(),
	writeGraphArtifacts: vi.fn(),
}));
vi.mock("../core/TopicIndexStore.js", () => ({ readTopicIndex }));
vi.mock("../core/TopicPageStore.js", () => ({ readTopicPage }));
vi.mock("./GraphDistiller.js", () => ({ distillGraph }));
vi.mock("./GraphArtifactStore.js", () => ({ writeGraphArtifacts }));

import { buildKnowledgeGraph } from "./GraphBuilder.js";

const ISO = "2026-06-15T00:00:00.000Z";
const CONFIG = { apiKey: "k" };
const folderStorage = { renderTopicWiki: async () => {}, kbRoot: "/kb" } as unknown as StorageProvider;
const orphanStorage = {} as unknown as StorageProvider;

const validDistill = {
	categories: [{ id: "c", shortTitle: "C", summary: "c" }],
	topics: [{ slug: "t1", shortTitle: "T1", summary: "s", title: "Topic1", categoryId: "c" }],
	units: [
		{
			id: "t1::u1",
			topicSlug: "t1",
			kind: "decision",
			shortTitle: "U1",
			summary: "s",
			anchors: { files: [], commits: [] },
		},
	],
	edges: [],
};

beforeEach(() => {
	for (const m of [readTopicIndex, readTopicPage, distillGraph, writeGraphArtifacts]) m.mockReset();
	distillGraph.mockResolvedValue(validDistill);
	writeGraphArtifacts.mockResolvedValue({ graphJsonPath: "/kb/.jolli/graph/graph.json" });
});

describe("buildKnowledgeGraph", () => {
	it("skips on orphan-only storage (no folder layer)", async () => {
		const r = await buildKnowledgeGraph("/cwd", orphanStorage, CONFIG);
		expect(r.built).toBe(false);
		expect(r.reason).toMatch(/orphan-only/);
		expect(readTopicIndex).not.toHaveBeenCalled();
	});

	it("skips when the topic index is empty", async () => {
		readTopicIndex.mockResolvedValue({ schemaVersion: 1, topics: [] });
		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG);
		expect(r.built).toBe(false);
		expect(r.reason).toBe("no topics");
		expect(distillGraph).not.toHaveBeenCalled();
	});

	it("forwards onProgress to the distiller and reports the write step", async () => {
		readTopicIndex.mockResolvedValue({
			schemaVersion: 1,
			topics: [{ stableSlug: "t1", title: "T1", summary: "s", lastUpdatedAt: "x" }],
		});
		readTopicPage.mockResolvedValue(null);
		const messages: string[] = [];

		await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { onProgress: (m) => messages.push(m) });

		// The reporter is handed to the distiller (which emits its own phase lines)…
		expect(distillGraph).toHaveBeenCalledWith(expect.anything(), CONFIG, expect.any(Function));
		// …and the builder reports the post-distill write step itself.
		expect(messages).toContain("writing graph.json");
	});

	it("builds the graph from topic pages and writes artifacts to kbRoot", async () => {
		readTopicIndex.mockResolvedValue({
			schemaVersion: 1,
			topics: [
				{
					stableSlug: "t1",
					title: "Topic1",
					summary: "s1",
					relatedBranches: ["main"],
					sourceRefs: [{ type: "summary", id: "abcdef123456", timestamp: "x", branch: "main" }],
					lastUpdatedAt: "x",
				},
			],
		});
		readTopicPage.mockResolvedValue({
			schemaVersion: 1,
			stableSlug: "t1",
			title: "Topic1",
			content: "page body\n\nsecond para",
			relatedBranches: ["main"],
			// A note ref (skipped) and a duplicate summary ref (deduped) exercise commitRefs.
			sourceRefs: [
				{ type: "summary", id: "abcdef123456", timestamp: "x", branch: "main" },
				{ type: "note", id: "note-1", timestamp: "x" },
				{ type: "summary", id: "abcdef123456", timestamp: "y", branch: "main" },
			],
			lastUpdatedAt: "x",
		});

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });

		expect(r.built).toBe(true);
		expect(r).toMatchObject({ topics: 1, units: 1, edges: 0, graphJsonPath: "/kb/.jolli/graph/graph.json" });

		// The distiller is fed structured page content, not re-parsed markdown.
		expect(distillGraph).toHaveBeenCalledWith(
			{ topics: [{ slug: "t1", title: "Topic1", summary: "s1", content: "page body\n\nsecond para" }] },
			CONFIG,
			undefined, // no onProgress passed in this test
		);

		// Source metadata is joined onto the assembled graph; artifacts go to kbRoot.
		const [rootArg, graphArg] = writeGraphArtifacts.mock.calls[0];
		expect(rootArg).toBe("/kb");
		const t1 = graphArg.topics.find((t: { slug: string }) => t.slug === "t1");
		expect(t1.fullBody).toBe("page body\n\nsecond para");
		expect(t1.overview).toBe("page body"); // first non-heading paragraph
		expect(t1.sourceBranches).toEqual(["main"]);
		expect(t1.sourceCommits).toEqual([{ hash: "abcdef12", message: "" }]);
	});

	it("uses the real clock when nowIso is omitted and falls back to cwd when storage has no kbRoot", async () => {
		const noKbStorage = { renderTopicWiki: async () => {} } as unknown as StorageProvider;
		// Index entry deliberately omits relatedBranches/sourceRefs (malformed/legacy)
		// so both the page-level and entry-level lookups fall through to the `?? []`.
		readTopicIndex.mockResolvedValue({
			schemaVersion: 1,
			topics: [{ stableSlug: "t1", title: "T1", summary: "s", lastUpdatedAt: "x" }],
		});
		readTopicPage.mockResolvedValue(null);

		const r = await buildKnowledgeGraph("/cwd", noKbStorage, CONFIG); // no opts -> real clock
		expect(r.built).toBe(true);
		const [rootArg, graphArg] = writeGraphArtifacts.mock.calls[0];
		expect(rootArg).toBe("/cwd"); // storage.kbRoot undefined -> cwd
		expect(typeof graphArg.generatedAt).toBe("string");
		expect(graphArg.generatedAt.length).toBeGreaterThan(0);
	});

	it("dedups source commits on the full hash (8-char prefix collisions count separately)", async () => {
		readTopicIndex.mockResolvedValue({
			schemaVersion: 1,
			topics: [
				{
					stableSlug: "t1",
					title: "T1",
					summary: "s",
					relatedBranches: [],
					sourceRefs: [],
					lastUpdatedAt: "x",
				},
			],
		});
		readTopicPage.mockResolvedValue({
			schemaVersion: 1,
			stableSlug: "t1",
			title: "T1",
			content: "body",
			relatedBranches: [],
			// Same 8-char prefix, different full hashes -> must NOT collapse.
			sourceRefs: [
				{ type: "summary", id: "abcdef12aaaa", timestamp: "x" },
				{ type: "summary", id: "abcdef12bbbb", timestamp: "y" },
			],
			lastUpdatedAt: "x",
		});
		await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });
		const [, graphArg] = writeGraphArtifacts.mock.calls[0];
		const t1 = graphArg.topics.find((t: { slug: string }) => t.slug === "t1");
		expect(t1.sourceCommits).toHaveLength(2);
		expect(t1.commitCount).toBe(2);
	});

	it("falls back to index branches/refs when a present page omits those fields", async () => {
		readTopicIndex.mockResolvedValue({
			schemaVersion: 1,
			topics: [
				{
					stableSlug: "t1",
					title: "T1",
					summary: "s",
					relatedBranches: ["main"],
					sourceRefs: [{ type: "summary", id: "cafebabe0000", timestamp: "x" }],
					lastUpdatedAt: "x",
				},
			],
		});
		// Page present (has content) but WITHOUT relatedBranches / sourceRefs.
		readTopicPage.mockResolvedValue({
			schemaVersion: 1,
			stableSlug: "t1",
			title: "T1",
			content: "body",
			lastUpdatedAt: "x",
		});
		await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });
		const [, graphArg] = writeGraphArtifacts.mock.calls[0];
		const t1 = graphArg.topics.find((t: { slug: string }) => t.slug === "t1");
		expect(t1.sourceBranches).toEqual(["main"]);
		expect(t1.sourceCommits).toEqual([{ hash: "cafebabe", message: "" }]);
	});

	it("falls back to index metadata when a topic page is missing", async () => {
		readTopicIndex.mockResolvedValue({
			schemaVersion: 1,
			topics: [
				{
					stableSlug: "t1",
					title: "Topic1",
					summary: "s1",
					relatedBranches: ["release/1.x"],
					sourceRefs: [{ type: "summary", id: "deadbeef0000", timestamp: "x" }],
					lastUpdatedAt: "x",
				},
			],
		});
		readTopicPage.mockResolvedValue(null);

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });
		expect(r.built).toBe(true);
		expect(distillGraph).toHaveBeenCalledWith(
			{ topics: [{ slug: "t1", title: "Topic1", summary: "s1", content: "" }] },
			CONFIG,
			undefined, // no onProgress passed in this test
		);
		const [, graphArg] = writeGraphArtifacts.mock.calls[0];
		const t1 = graphArg.topics.find((t: { slug: string }) => t.slug === "t1");
		expect(t1.sourceBranches).toEqual(["release/1.x"]);
		expect(t1.sourceCommits).toEqual([{ hash: "deadbeef", message: "" }]);
	});
});
