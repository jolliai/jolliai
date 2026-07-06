import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "../core/StorageProvider.js";

const { readTopicIndex, readTopicPage, distillGraph, distillGraphIncremental, writeGraphArtifacts, readGraph } =
	vi.hoisted(() => ({
		readTopicIndex: vi.fn(),
		readTopicPage: vi.fn(),
		distillGraph: vi.fn(),
		distillGraphIncremental: vi.fn(),
		writeGraphArtifacts: vi.fn(),
		readGraph: vi.fn(),
	}));
vi.mock("../core/TopicIndexStore.js", () => ({ readTopicIndex }));
vi.mock("../core/TopicPageStore.js", () => ({ readTopicPage }));
vi.mock("./GraphDistiller.js", () => ({ distillGraph, distillGraphIncremental }));
vi.mock("./GraphArtifactStore.js", () => ({ writeGraphArtifacts, readGraph }));

import { buildKnowledgeGraph, topicFingerprint, topicMetaFingerprint } from "./GraphBuilder.js";
import { GRAPH_SCHEMA_VERSION } from "./GraphSchema.js";

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
			kinds: ["decision"],
			shortTitle: "U1",
			summary: "s",
			anchors: { files: [], commits: [] },
		},
	],
	edges: [],
};

beforeEach(() => {
	for (const m of [
		readTopicIndex,
		readTopicPage,
		distillGraph,
		distillGraphIncremental,
		writeGraphArtifacts,
		readGraph,
	])
		m.mockReset();
	distillGraph.mockResolvedValue(validDistill);
	distillGraphIncremental.mockResolvedValue(validDistill);
	writeGraphArtifacts.mockResolvedValue({ graphJsonPath: "/kb/.jolli/graph/graph.json" });
	readGraph.mockResolvedValue(null); // default: no baseline → full path
});

describe("buildKnowledgeGraph", () => {
	it("skips on orphan-only storage (no folder layer)", async () => {
		const r = await buildKnowledgeGraph("/cwd", orphanStorage, CONFIG);
		expect(r.built).toBe(false);
		expect(r.reason).toMatch(/orphan-only/);
		expect(readTopicIndex).not.toHaveBeenCalled();
	});

	it("skips when the topic index is empty and there is no prior graph", async () => {
		readTopicIndex.mockResolvedValue({ schemaVersion: 1, topics: [] });
		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG);
		expect(r.built).toBe(false);
		expect(r.reason).toBe("no topics");
		expect(distillGraph).not.toHaveBeenCalled();
		expect(writeGraphArtifacts).not.toHaveBeenCalled();
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
		// The full-build exit stamps the repo name (breadcrumb root) — basename("/kb") === "kb".
		expect(graphArg.repoName).toBe("kb");
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

	it("derives overview from the first non-heading paragraph (skips a leading markdown heading)", async () => {
		readTopicIndex.mockResolvedValue({
			schemaVersion: 1,
			topics: [{ stableSlug: "t1", title: "T1", summary: "s", lastUpdatedAt: "x" }],
		});
		readTopicPage.mockResolvedValue({
			schemaVersion: 1,
			stableSlug: "t1",
			title: "T1",
			content: "# Heading line\n\nreal first paragraph",
			lastUpdatedAt: "x",
		});
		await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });
		const [, graphArg] = writeGraphArtifacts.mock.calls[0];
		expect(graphArg.topics.find((t: { slug: string }) => t.slug === "t1").overview).toBe("real first paragraph");
	});

	// --- incremental path ---------------------------------------------------

	const ONE_TOPIC_INDEX = {
		schemaVersion: 1,
		topics: [{ stableSlug: "t1", title: "Topic1", summary: "s1", lastUpdatedAt: "x" }],
	};

	/** A minimal, field-valid prior graph.json (the incremental baseline). */
	function baselineGraph(
		topicFingerprints: Record<string, string>,
		topicMetaFingerprints: Record<string, string> = {},
	) {
		return {
			schemaVersion: GRAPH_SCHEMA_VERSION,
			generatedAt: "x",
			source: "x",
			topicFingerprints,
			topicMetaFingerprints,
			stats: {},
			categories: [],
			topics: [],
			units: [],
			edges: [],
		};
	}

	// Use the real fingerprint fns (not hand-copied formulas) so the skip / reassemble
	// tests cannot silently go green if the separator/algorithm ever changes.
	const fpOf = topicFingerprint;
	const metaOf = (sourceBranches: string[], sourceCommits: { hash: string; message: string }[]) =>
		topicMetaFingerprint({ sourceBranches, sourceCommits, overview: "", fullBody: "" });

	/** A field-valid baseline that actually carries a distilled t1 topic + unit, so a
	 *  no-LLM reassemble (metadata drift) and an empty-on-delete have something to act on. */
	function richBaseline(topicFingerprints: Record<string, string>, topicMetaFingerprints: Record<string, string>) {
		return {
			...baselineGraph(topicFingerprints, topicMetaFingerprints),
			categories: [{ id: "c", shortTitle: "C", summary: "c" }],
			topics: [{ slug: "t1", shortTitle: "T1", summary: "s", title: "Topic1", categoryId: "c" }],
			units: [
				{
					id: "t1::u1",
					topicSlug: "t1",
					kinds: ["decision"],
					shortTitle: "U1",
					summary: "s",
					anchors: { files: [], commits: [] },
				},
			],
			edges: [],
		};
	}

	it("takes the incremental path when a valid baseline exists with changed topics", async () => {
		readTopicIndex.mockResolvedValue(ONE_TOPIC_INDEX);
		readTopicPage.mockResolvedValue(null);
		readGraph.mockResolvedValue(baselineGraph({})); // empty baseline → t1 is "added"

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });

		expect(r.built).toBe(true);
		expect(r.mode).toBe("incremental");
		expect(distillGraphIncremental).toHaveBeenCalled();
		expect(distillGraph).not.toHaveBeenCalled();
		// The incremental-LLM exit shares assembleGraph with the full path — it must stamp
		// repoName too (basename("/kb") === "kb"), else a content change reverts the breadcrumb.
		const [, graphArg] = writeGraphArtifacts.mock.calls[0];
		expect(graphArg.repoName).toBe("kb");
	});

	it("skips entirely (no LLM, no write) when both content and metadata fingerprints are unchanged", async () => {
		readTopicIndex.mockResolvedValue(ONE_TOPIC_INDEX);
		readTopicPage.mockResolvedValue(null); // content = "", no branches/commits
		// Baseline matches the content fingerprint, the (empty) metadata one, AND the
		// build-stamped repoName — only then is it a true no-op. basename("/kb") === "kb".
		readGraph.mockResolvedValue({
			...baselineGraph({ t1: fpOf("Topic1", "s1", "") }, { t1: metaOf([], []) }),
			repoName: "kb",
		});

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });

		expect(r.built).toBe(false);
		expect(r.reason).toBe("no changes");
		expect(distillGraph).not.toHaveBeenCalled();
		expect(distillGraphIncremental).not.toHaveBeenCalled();
		expect(writeGraphArtifacts).not.toHaveBeenCalled();
	});

	it("reassembles without LLM when content is unchanged but source metadata drifted", async () => {
		readTopicIndex.mockResolvedValue(ONE_TOPIC_INDEX);
		// Page present with a NEW commit ref, but the content (→ content fingerprint) is
		// unchanged from the baseline. Only the join metadata moved.
		readTopicPage.mockResolvedValue({
			schemaVersion: 1,
			stableSlug: "t1",
			title: "Topic1",
			content: "",
			relatedBranches: [],
			sourceRefs: [{ type: "summary", id: "abcdef120000", timestamp: "x" }],
			lastUpdatedAt: "x",
		});
		// Baseline: same content fingerprint, but EMPTY (different) metadata fingerprint.
		readGraph.mockResolvedValue(richBaseline({ t1: fpOf("Topic1", "s1", "") }, { t1: metaOf([], []) }));

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });

		expect(r.built).toBe(true);
		expect(r.mode).toBe("incremental");
		// No LLM ran (neither distiller), but graph.json WAS rewritten with fresh metadata.
		expect(distillGraph).not.toHaveBeenCalled();
		expect(distillGraphIncremental).not.toHaveBeenCalled();
		expect(writeGraphArtifacts).toHaveBeenCalled();
		const [, graphArg] = writeGraphArtifacts.mock.calls[0];
		const t1 = graphArg.topics.find((t: { slug: string }) => t.slug === "t1");
		expect(t1.sourceCommits).toEqual([{ hash: "abcdef12", message: "" }]); // refreshed
		expect(t1.commitCount).toBe(1);
	});

	it("reassembles without LLM when the baseline metadata map has a different key set", async () => {
		readTopicIndex.mockResolvedValue(ONE_TOPIC_INDEX);
		readTopicPage.mockResolvedValue(null); // content unchanged
		// Content fingerprint matches, but the baseline meta map carries an extra stale
		// key — a size mismatch that must still trigger a refresh (never a false skip).
		readGraph.mockResolvedValue(
			richBaseline({ t1: fpOf("Topic1", "s1", "") }, { t1: metaOf([], []), tGhost: metaOf([], []) }),
		);

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });

		expect(r.built).toBe(true);
		expect(r.mode).toBe("incremental");
		expect(distillGraph).not.toHaveBeenCalled();
		expect(distillGraphIncremental).not.toHaveBeenCalled();
		expect(writeGraphArtifacts).toHaveBeenCalled();
	});

	it("reassembles without LLM when the baseline has no metadata fingerprints (older write heals once)", async () => {
		readTopicIndex.mockResolvedValue(ONE_TOPIC_INDEX);
		readTopicPage.mockResolvedValue(null);
		// schemaVersion matches, content fingerprint matches, but topicMetaFingerprints is
		// absent (corrupt primitive) → treated as drifted → one reassemble heals it.
		readGraph.mockResolvedValue({
			...richBaseline({ t1: fpOf("Topic1", "s1", "") }, {}),
			topicMetaFingerprints: "corrupt",
		});

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });

		expect(r.built).toBe(true);
		expect(r.mode).toBe("incremental");
		expect(writeGraphArtifacts).toHaveBeenCalled();
	});

	it("reassembles without LLM when content and metadata match but repoName is stale (heals repoName)", async () => {
		readTopicIndex.mockResolvedValue(ONE_TOPIC_INDEX);
		readTopicPage.mockResolvedValue(null); // content + metadata both unchanged
		// Content AND metadata fingerprints match, so the only drift is the build-stamped
		// repoName. Here it is stale ("old-name" from a rename); an absent field behaves the
		// same. Either way a no-LLM reassemble must run and stamp the current basename("/kb").
		readGraph.mockResolvedValue({
			...richBaseline({ t1: fpOf("Topic1", "s1", "") }, { t1: metaOf([], []) }),
			repoName: "old-name",
		});

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });

		expect(r.built).toBe(true);
		expect(r.mode).toBe("incremental");
		expect(distillGraph).not.toHaveBeenCalled();
		expect(distillGraphIncremental).not.toHaveBeenCalled();
		expect(writeGraphArtifacts).toHaveBeenCalled();
		const [, graphArg] = writeGraphArtifacts.mock.calls[0];
		expect(graphArg.repoName).toBe("kb"); // refreshed to basename("/kb")
	});

	it("rebuilds fully when the baseline schemaVersion does not match", async () => {
		readTopicIndex.mockResolvedValue(ONE_TOPIC_INDEX);
		readTopicPage.mockResolvedValue(null);
		readGraph.mockResolvedValue({ ...baselineGraph({}), schemaVersion: 1 }); // stale schema

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });
		expect(r.mode).toBe("full");
		expect(distillGraph).toHaveBeenCalled();
		expect(distillGraphIncremental).not.toHaveBeenCalled();
	});

	it("rebuilds fully (one-time heal) when the baseline topicFingerprints are malformed", async () => {
		readTopicIndex.mockResolvedValue(ONE_TOPIC_INDEX);
		readTopicPage.mockResolvedValue(null);
		// schemaVersion matches but topicFingerprints is a corrupt primitive → not a
		// usable baseline → full (never throws in diffTopics).
		readGraph.mockResolvedValue({ ...baselineGraph({}), topicFingerprints: "corrupt" });

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });
		expect(r.mode).toBe("full");
		expect(distillGraph).toHaveBeenCalled();
		expect(distillGraphIncremental).not.toHaveBeenCalled();
	});

	it("rebuilds fully when the baseline is structurally incompatible (toDistilled → null)", async () => {
		readTopicIndex.mockResolvedValue(ONE_TOPIC_INDEX);
		readTopicPage.mockResolvedValue(null);
		// schemaVersion matches but a unit is missing required fields → toDistilled null.
		readGraph.mockResolvedValue({ ...baselineGraph({}), units: [{ id: "x" }] });

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });
		expect(r.mode).toBe("full");
		expect(distillGraph).toHaveBeenCalled();
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

	it("writes an empty graph (no LLM) when the last topic is deleted, clearing the stale graph", async () => {
		readTopicIndex.mockResolvedValue({ schemaVersion: 1, topics: [] }); // all topics gone
		readGraph.mockResolvedValue(richBaseline({ t1: fpOf("Topic1", "s1", "") }, { t1: metaOf([], []) }));

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });

		expect(r.built).toBe(true);
		expect(r.mode).toBe("incremental");
		expect(r).toMatchObject({ topics: 0, units: 0, edges: 0 });
		// No LLM, but the stale graph IS overwritten with an empty one (no phantom topics).
		expect(distillGraph).not.toHaveBeenCalled();
		expect(distillGraphIncremental).not.toHaveBeenCalled();
		const [, graphArg] = writeGraphArtifacts.mock.calls[0];
		expect(graphArg.topics).toEqual([]);
		expect(graphArg.units).toEqual([]);
		expect(graphArg.categories).toEqual([]);
	});

	it("writes an empty graph on bump + empty index (stale-schema baseline is not stranded)", async () => {
		readTopicIndex.mockResolvedValue({ schemaVersion: 1, topics: [] }); // all topics gone
		// Prior graph exists but its schemaVersion no longer matches (a bump happened),
		// so prevDistill is null. The empty-write gate must key off the RAW prevGraph
		// (still non-empty) — otherwise this stale old-schema file would be stranded.
		readGraph.mockResolvedValue({ ...richBaseline({ t1: fpOf("Topic1", "s1", "") }, {}), schemaVersion: 1 });

		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });

		expect(r.built).toBe(true);
		expect(r).toMatchObject({ topics: 0, units: 0, edges: 0 });
		expect(distillGraph).not.toHaveBeenCalled();
		expect(distillGraphIncremental).not.toHaveBeenCalled();
		const [, graphArg] = writeGraphArtifacts.mock.calls[0];
		expect(graphArg.topics).toEqual([]);
		expect(graphArg.schemaVersion).toBe(GRAPH_SCHEMA_VERSION); // re-stamped to current
	});

	it("skips (no write) on empty index when there is no prior graph at all", async () => {
		readTopicIndex.mockResolvedValue({ schemaVersion: 1, topics: [] });
		readGraph.mockResolvedValue(null);
		const r = await buildKnowledgeGraph("/cwd", folderStorage, CONFIG, { nowIso: ISO });
		expect(r.built).toBe(false);
		expect(r.reason).toBe("no topics");
		expect(writeGraphArtifacts).not.toHaveBeenCalled();
	});
});
