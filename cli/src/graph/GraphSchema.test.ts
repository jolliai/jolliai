import { describe, expect, it } from "vitest";
import {
	assembleGraph,
	type CategoriesDelta,
	type DistilledCategory,
	type DistilledGraph,
	type DistilledTopic,
	diffTopics,
	isFingerprintMap,
	mergeCategoryLayer,
	type TopicSourceMeta,
	toDistilled,
	UNCATEGORIZED_CATEGORY_ID,
	validateDistilledGraph,
} from "./GraphSchema.js";

function validGraph(): DistilledGraph {
	return {
		categories: [
			{ id: "cat-a", shortTitle: "Cat A", summary: "Category A." },
			{ id: "cat-b", shortTitle: "Cat B", summary: "Category B." },
		],
		topics: [
			{ slug: "t1", shortTitle: "T1", summary: "Topic 1.", title: "Topic One", categoryId: "cat-a" },
			{ slug: "t2", shortTitle: "T2", summary: "Topic 2.", title: "Topic Two", categoryId: "cat-b" },
		],
		units: [
			{
				id: "t1::u1",
				topicSlug: "t1",
				kind: "decision",
				shortTitle: "U1",
				summary: "Unit 1.",
				anchors: { files: [], commits: [] },
			},
			{
				id: "t1::u2",
				topicSlug: "t1",
				kind: "mechanism",
				shortTitle: "U2",
				summary: "Unit 2.",
				anchors: { files: [], commits: [] },
			},
			{
				id: "t2::u3",
				topicSlug: "t2",
				kind: "fix",
				shortTitle: "U3",
				summary: "Unit 3.",
				anchors: { files: [], commits: [] },
			},
		],
		edges: [
			{ from: "t1::u1", to: "t1::u2", type: "extends", confidence: 0.9, evidence: "intra-topic" },
			{ from: "t1::u1", to: "t2::u3", type: "caused-by", confidence: 0.8, evidence: "cross-category" },
		],
	};
}

describe("validateDistilledGraph", () => {
	it("accepts a referentially-sound graph", () => {
		expect(validateDistilledGraph(validGraph())).toEqual([]);
	});

	it("flags an unknown categoryId on a topic", () => {
		const g = validGraph();
		g.topics[0] = { ...g.topics[0], categoryId: "nope" };
		expect(validateDistilledGraph(g)).toContain("topic t1: unknown categoryId nope");
	});

	it("flags a duplicate unit id", () => {
		const g = validGraph();
		g.units.push({ ...g.units[0] });
		expect(validateDistilledGraph(g)).toContain("duplicate unit id t1::u1");
	});

	it("flags an unknown topicSlug on a unit", () => {
		const g = validGraph();
		g.units[0] = { ...g.units[0], topicSlug: "ghost" };
		expect(validateDistilledGraph(g)).toContain("unit t1::u1: unknown topicSlug ghost");
	});

	it("flags an invalid unit kind", () => {
		const g = validGraph();
		// biome-ignore lint/suspicious/noExplicitAny: deliberately bad data
		g.units[0] = { ...g.units[0], kind: "bogus" as any };
		expect(validateDistilledGraph(g)).toContain("unit t1::u1: invalid kind bogus");
	});

	it("flags dangling edge endpoints", () => {
		const g = validGraph();
		g.edges.push({ from: "ghost-a", to: "ghost-b", type: "related-to", confidence: 0.6, evidence: "x" });
		const errs = validateDistilledGraph(g);
		expect(errs).toContain("edge from unknown unit ghost-a");
		expect(errs).toContain("edge to unknown unit ghost-b");
	});

	it("flags an invalid edge type and duplicate edges", () => {
		const g = validGraph();
		// biome-ignore lint/suspicious/noExplicitAny: deliberately bad data
		g.edges.push({ from: "t1::u1", to: "t1::u2", type: "wat" as any, confidence: 0.6, evidence: "x" });
		g.edges.push({ ...g.edges[0] }); // duplicate of the first valid edge
		const errs = validateDistilledGraph(g);
		expect(errs.some((e) => e.includes("invalid type wat"))).toBe(true);
		expect(errs).toContain("duplicate edge t1::u1|t1::u2|extends");
	});
});

describe("assembleGraph", () => {
	const sources = new Map<string, TopicSourceMeta>([
		[
			"t1",
			{
				sourceBranches: ["main", "feature/x"],
				sourceCommits: [
					{ hash: "abc12345", message: "" },
					{ hash: "def67890", message: "" },
				],
				overview: "T1 overview",
				fullBody: "# body 1",
			},
		],
		// t2 deliberately absent → empty source metadata
	]);

	it("joins source metadata, computes rollups + stats", () => {
		const graph = assembleGraph(validGraph(), sources, "2026-06-15T00:00:00.000Z");

		expect(graph.generatedAt).toBe("2026-06-15T00:00:00.000Z");
		expect(graph.schemaVersion).toBe(2);

		const t1 = graph.topics.find((t) => t.slug === "t1");
		expect(t1?.sourceBranches).toEqual(["main", "feature/x"]);
		expect(t1?.fullBody).toBe("# body 1");
		expect(t1?.wikiFile).toBe("topic--t1.md");
		expect(t1?.unitCount).toBe(2);
		expect(t1?.commitCount).toBe(2);

		const t2 = graph.topics.find((t) => t.slug === "t2");
		expect(t2?.sourceBranches).toEqual([]);
		expect(t2?.fullBody).toBe("");
		expect(t2?.unitCount).toBe(1);
		expect(t2?.commitCount).toBe(0);

		const catA = graph.categories.find((c) => c.id === "cat-a");
		expect(catA?.topicCount).toBe(1);
		expect(catA?.unitCount).toBe(2);
		expect(catA?.commitCount).toBe(2);

		expect(graph.stats).toMatchObject({
			categories: 2,
			topics: 2,
			units: 3,
			edges: 2,
			intraTopicEdges: 1,
			crossTopicEdges: 1,
			crossCategoryEdges: 1,
		});
	});

	it("counts a same-category cross-topic edge as crossTopic but not crossCategory, and rolls up zero-unit topics", () => {
		const distill: DistilledGraph = {
			categories: [{ id: "cat-a", shortTitle: "A", summary: "A." }],
			topics: [
				{ slug: "t1", shortTitle: "T1", summary: "s", title: "T1", categoryId: "cat-a" },
				{ slug: "t2", shortTitle: "T2", summary: "s", title: "T2", categoryId: "cat-a" },
				{ slug: "t3", shortTitle: "T3", summary: "s", title: "T3", categoryId: "cat-a" },
			],
			units: [
				{
					id: "t1::u1",
					topicSlug: "t1",
					kind: "decision",
					shortTitle: "U1",
					summary: "s",
					anchors: { files: [], commits: [] },
				},
				{
					id: "t2::u2",
					topicSlug: "t2",
					kind: "fix",
					shortTitle: "U2",
					summary: "s",
					anchors: { files: [], commits: [] },
				},
			],
			edges: [{ from: "t1::u1", to: "t2::u2", type: "related-to", confidence: 0.7, evidence: "same cat" }],
		};
		const graph = assembleGraph(distill, new Map(), "2026-06-15T00:00:00.000Z");
		expect(graph.stats.crossTopicEdges).toBe(1);
		expect(graph.stats.crossCategoryEdges).toBe(0);
		// t3 has no units — the `?? 0` rollup path.
		expect(graph.topics.find((t) => t.slug === "t3")?.unitCount).toBe(0);
	});

	it("throws on a graph that fails validation", () => {
		const g = validGraph();
		g.edges.push({ from: "ghost", to: "t1::u1", type: "extends", confidence: 0.6, evidence: "x" });
		expect(() => assembleGraph(g, sources, "2026-06-15T00:00:00.000Z")).toThrow(/validation failed/);
	});

	it("embeds the passed topicFingerprints / topicMetaFingerprints (and defaults both to {})", () => {
		const withFp = assembleGraph(
			validGraph(),
			sources,
			"2026-06-15T00:00:00.000Z",
			{ t1: "a", t2: "b" },
			{ t1: "m" },
		);
		expect(withFp.topicFingerprints).toEqual({ t1: "a", t2: "b" });
		expect(withFp.topicMetaFingerprints).toEqual({ t1: "m" });
		const withoutFp = assembleGraph(validGraph(), sources, "2026-06-15T00:00:00.000Z");
		expect(withoutFp.topicFingerprints).toEqual({});
		expect(withoutFp.topicMetaFingerprints).toEqual({});
	});

	it("prunes a category that ends up with zero topics", () => {
		const distill = validGraph();
		// Add an extra category no topic references → must be pruned by assembleGraph.
		distill.categories.push({ id: "orphan-cat", shortTitle: "Orphan", summary: "Nobody here." });
		const graph = assembleGraph(distill, sources, "2026-06-15T00:00:00.000Z");
		expect(graph.categories.map((c) => c.id).sort()).toEqual(["cat-a", "cat-b"]);
		expect(graph.stats.categories).toBe(2);
	});
});

describe("isFingerprintMap", () => {
	it("accepts a plain string→string object (incl. empty)", () => {
		expect(isFingerprintMap({})).toBe(true);
		expect(isFingerprintMap({ a: "h1", b: "h2" })).toBe(true);
	});

	it("rejects null, arrays, primitives, and non-string values", () => {
		expect(isFingerprintMap(null)).toBe(false);
		expect(isFingerprintMap(undefined)).toBe(false);
		expect(isFingerprintMap(["h"])).toBe(false);
		expect(isFingerprintMap("hash")).toBe(false);
		expect(isFingerprintMap(5)).toBe(false);
		expect(isFingerprintMap({ a: 123 })).toBe(false);
	});
});

describe("diffTopics", () => {
	it("partitions into clean / dirty / added / deleted", () => {
		const prev = { keep: "h1", change: "h2", gone: "h3" };
		const cur = { keep: "h1", change: "h2-NEW", fresh: "h4" };
		expect(diffTopics(prev, cur)).toEqual({
			clean: ["keep"],
			dirty: ["change"],
			added: ["fresh"],
			deleted: ["gone"],
		});
	});

	it("is all-empty when nothing changed", () => {
		const fp = { a: "1", b: "2" };
		expect(diffTopics(fp, { ...fp })).toEqual({ clean: ["a", "b"], dirty: [], added: [], deleted: [] });
	});
});

describe("toDistilled", () => {
	function priorGraph(): unknown {
		// A real emitted KnowledgeGraph (the incremental baseline shape).
		return assembleGraph(validGraph(), new Map(), "2026-06-15T00:00:00.000Z", { t1: "a", t2: "b" });
	}

	it("strips derived fields and restores the DistilledGraph subset", () => {
		const restored = toDistilled(priorGraph());
		expect(restored).not.toBeNull();
		// Derived fields gone from categories/topics; units/edges verbatim.
		const cat = restored?.categories[0] as unknown as Record<string, unknown>;
		expect(Object.keys(cat).sort()).toEqual(["id", "shortTitle", "summary"]);
		const topic = restored?.topics[0] as unknown as Record<string, unknown>;
		expect(Object.keys(topic).sort()).toEqual(["categoryId", "shortTitle", "slug", "summary", "title"]);
		expect(restored?.units).toHaveLength(3);
		expect(restored?.edges).toHaveLength(2);
		// anchors arrays are copied (not the same reference).
		expect(restored?.units[0].anchors.files).toEqual([]);
	});

	it("returns null for a non-object / missing top-level arrays", () => {
		expect(toDistilled(null)).toBeNull();
		expect(toDistilled("nope")).toBeNull();
		expect(toDistilled({ categories: [], topics: [], units: [] })).toBeNull(); // edges missing
		expect(toDistilled({ categories: {}, topics: [], units: [], edges: [] })).toBeNull(); // categories non-array
	});

	it("returns null on a structurally-incompatible category / topic", () => {
		const g = priorGraph() as Record<string, unknown>;
		expect(toDistilled({ ...g, categories: [{ id: "c" /* missing shortTitle/summary */ }] })).toBeNull();
		expect(toDistilled({ ...g, topics: [{ slug: "t", shortTitle: "T", summary: "s", title: "T" }] })).toBeNull();
	});

	it("returns null on a unit missing a field, a bad kind, or bad anchors", () => {
		const g = priorGraph() as Record<string, unknown>;
		const baseUnit = { id: "x::u", topicSlug: "x", kind: "decision", shortTitle: "U", summary: "s" };
		expect(toDistilled({ ...g, units: [{ ...baseUnit /* no anchors */ }] })).toBeNull();
		expect(
			toDistilled({ ...g, units: [{ ...baseUnit, kind: "bogus", anchors: { files: [], commits: [] } }] }),
		).toBeNull();
		expect(toDistilled({ ...g, units: [{ ...baseUnit, anchors: { files: "no", commits: [] } }] })).toBeNull();
		expect(toDistilled({ ...g, units: [{ ...baseUnit, anchors: null }] })).toBeNull();
		expect(
			toDistilled({ ...g, units: [{ ...baseUnit, summary: 5, anchors: { files: [], commits: [] } }] }),
		).toBeNull();
	});

	it("returns null on a structurally-incompatible edge", () => {
		const g = priorGraph() as Record<string, unknown>;
		expect(toDistilled({ ...g, edges: [{ from: "a", to: "b", type: "extends", confidence: 0.9 }] })).toBeNull();
		expect(
			toDistilled({ ...g, edges: [{ from: "a", to: "b", type: "nope", confidence: 0.9, evidence: "e" }] }),
		).toBeNull();
	});

	it("returns null when an array element is a non-object (null / primitive)", () => {
		const g = priorGraph() as Record<string, unknown>;
		expect(toDistilled({ ...g, categories: [null] })).toBeNull();
		expect(toDistilled({ ...g, topics: ["nope"] })).toBeNull();
		expect(toDistilled({ ...g, units: [42] })).toBeNull();
		expect(toDistilled({ ...g, edges: [null] })).toBeNull();
	});
});

describe("mergeCategoryLayer", () => {
	const prevCategories: DistilledCategory[] = [
		{ id: "build", shortTitle: "Build Tooling", summary: "build stuff" },
		{ id: "auth", shortTitle: "Auth", summary: "auth stuff" },
	];
	const prevTopics: DistilledTopic[] = [
		{ slug: "t-clean", shortTitle: "Clean", summary: "clean s", title: "Clean Topic", categoryId: "build" },
		{ slug: "t-dirty", shortTitle: "OldDirty", summary: "old s", title: "Dirty Topic", categoryId: "auth" },
	];
	const current = [
		{ slug: "t-clean", title: "Clean Topic", summary: "clean s" },
		{ slug: "t-dirty", title: "Dirty Topic", summary: "new s" },
		{ slug: "t-new", title: "New Topic", summary: "fresh s" },
	];

	it("keeps clean topics, applies delta to changed, reuses existing category on id collision", () => {
		const delta: CategoriesDelta = {
			// id collides with existing "auth" → dropped, existing wins.
			newCategories: [{ id: "auth", shortTitle: "Auth v2", summary: "x" }],
			topics: [
				{ slug: "t-dirty", title: "Dirty Topic", shortTitle: "NewDirty", summary: "new s", categoryId: "auth" },
				{ slug: "t-new", title: "New Topic", shortTitle: "New", summary: "fresh s", categoryId: "build" },
			],
		};
		const { categories, topics } = mergeCategoryLayer(
			prevCategories,
			prevTopics,
			delta,
			current,
			new Set(["t-dirty", "t-new"]),
		);
		// No new category added (collision); existing metadata kept.
		expect(categories.map((c) => c.id).sort()).toEqual(["auth", "build"]);
		expect(categories.find((c) => c.id === "auth")?.shortTitle).toBe("Auth");
		// Clean topic kept verbatim; dirty got delta's shortTitle.
		expect(topics.find((t) => t.slug === "t-clean")?.shortTitle).toBe("Clean");
		expect(topics.find((t) => t.slug === "t-dirty")?.shortTitle).toBe("NewDirty");
		expect(topics.find((t) => t.slug === "t-new")?.categoryId).toBe("build");
	});

	it("folds a new category whose shortTitle duplicates an existing one into that existing id", () => {
		const delta: CategoriesDelta = {
			// New id but shortTitle "build tooling" (case-insensitive) duplicates "build".
			newCategories: [{ id: "tooling", shortTitle: "build tooling", summary: "x" }],
			topics: [
				{ slug: "t-new", title: "New Topic", shortTitle: "New", summary: "fresh s", categoryId: "tooling" },
			],
		};
		const { categories, topics } = mergeCategoryLayer(
			prevCategories,
			prevTopics,
			delta,
			current,
			new Set(["t-new"]),
		);
		// "tooling" folded away; topic remapped to "build".
		expect(categories.map((c) => c.id).sort()).toEqual(["auth", "build"]);
		expect(topics.find((t) => t.slug === "t-new")?.categoryId).toBe("build");
	});

	it("adds a genuinely-new category", () => {
		const delta: CategoriesDelta = {
			newCategories: [{ id: "storage", shortTitle: "Storage", summary: "x" }],
			topics: [
				{ slug: "t-new", title: "New Topic", shortTitle: "New", summary: "fresh s", categoryId: "storage" },
			],
		};
		const { categories } = mergeCategoryLayer(prevCategories, prevTopics, delta, current, new Set(["t-new"]));
		expect(categories.map((c) => c.id)).toContain("storage");
	});

	it("falls a changed topic missing from the delta into uncategorized (and adds the category)", () => {
		const delta: CategoriesDelta = { newCategories: [], topics: [] }; // delta dropped t-new
		const onlyNew = [{ slug: "t-new", title: "New Topic", summary: "fresh s" }];
		const { categories, topics } = mergeCategoryLayer([], [], delta, onlyNew, new Set(["t-new"]));
		expect(topics[0].categoryId).toBe(UNCATEGORIZED_CATEGORY_ID);
		expect(categories.map((c) => c.id)).toContain(UNCATEGORIZED_CATEGORY_ID);
	});

	it("reassigns a topic pointing at an unknown category to uncategorized", () => {
		const delta: CategoriesDelta = {
			newCategories: [],
			topics: [{ slug: "t-new", title: "New Topic", shortTitle: "N", summary: "s", categoryId: "ghost" }],
		};
		const onlyNew = [{ slug: "t-new", title: "New Topic", summary: "fresh s" }];
		const { topics } = mergeCategoryLayer(prevCategories, prevTopics, delta, onlyNew, new Set(["t-new"]));
		expect(topics[0].categoryId).toBe(UNCATEGORIZED_CATEGORY_ID);
	});

	it("indexes only the first of two baseline categories sharing a shortTitle", () => {
		// Two distinct ids, same label: the shortTitle index keeps the first; a delta
		// new category with that label folds into the first id.
		const prev: DistilledCategory[] = [
			{ id: "a1", shortTitle: "Same", summary: "1" },
			{ id: "a2", shortTitle: "Same", summary: "2" },
		];
		const prevT: DistilledTopic[] = [{ slug: "k", shortTitle: "K", summary: "s", title: "K", categoryId: "a2" }];
		const delta: CategoriesDelta = {
			newCategories: [{ id: "a3", shortTitle: "same", summary: "3" }],
			topics: [{ slug: "n", title: "N", shortTitle: "N", summary: "s", categoryId: "a3" }],
		};
		const { categories, topics } = mergeCategoryLayer(
			prev,
			prevT,
			delta,
			[
				{ slug: "k", title: "K", summary: "s" },
				{ slug: "n", title: "N", summary: "s" },
			],
			new Set(["n"]),
		);
		// "a3" folds into the first-indexed "a1".
		expect(categories.map((c) => c.id).sort()).toEqual(["a1", "a2"]);
		expect(topics.find((t) => t.slug === "n")?.categoryId).toBe("a1");
	});

	it("keep-firsts a duplicated baseline category id", () => {
		const dupPrev: DistilledCategory[] = [
			{ id: "x", shortTitle: "First", summary: "1" },
			{ id: "x", shortTitle: "Second", summary: "2" },
		];
		const { categories } = mergeCategoryLayer(
			dupPrev,
			[{ slug: "t", shortTitle: "T", summary: "s", title: "T", categoryId: "x" }],
			{ newCategories: [], topics: [] },
			[{ slug: "t", title: "T", summary: "s" }],
			new Set(),
		);
		expect(categories.filter((c) => c.id === "x")).toHaveLength(1);
		expect(categories.find((c) => c.id === "x")?.shortTitle).toBe("First");
	});
});
