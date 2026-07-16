import { describe, expect, it } from "vitest";
import {
	assembleGraph,
	type CategoriesDelta,
	type CoChangeTopicEdge,
	type DistilledCategory,
	type DistilledGraph,
	type DistilledTopic,
	diffTopics,
	dropSubsumedRelatedTo,
	GRAPH_SCHEMA_VERSION,
	type GraphEdge,
	isCanonicalKinds,
	isFingerprintMap,
	MAX_UNIT_KINDS,
	mergeCategoryLayer,
	normalizeKinds,
	normalizeSymmetricEdges,
	SYMMETRIC_EDGE_TYPES,
	type TopicSourceMeta,
	toDistilled,
	UNCATEGORIZED_CATEGORY_ID,
	UNIT_KINDS,
	validateCoChangeTopicEdges,
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
				kinds: ["decision"],
				shortTitle: "U1",
				summary: "Unit 1.",
				anchors: { files: [], commits: [] },
			},
			{
				id: "t1::u2",
				topicSlug: "t1",
				kinds: ["mechanism", "constraint"],
				shortTitle: "U2",
				summary: "Unit 2.",
				anchors: { files: [], commits: [] },
			},
			{
				id: "t2::u3",
				topicSlug: "t2",
				kinds: ["fix"],
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

	it("flags invalid unit kinds", () => {
		const g = validGraph();
		// biome-ignore lint/suspicious/noExplicitAny: deliberately bad data
		g.units[0] = { ...g.units[0], kinds: ["bogus"] as any };
		expect(validateDistilledGraph(g)).toContain('unit t1::u1: invalid kinds ["bogus"]');
	});

	it("flags an empty kinds array", () => {
		const g = validGraph();
		g.units[0] = { ...g.units[0], kinds: [] };
		expect(validateDistilledGraph(g)).toContain("unit t1::u1: invalid kinds []");
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

describe("normalizeSymmetricEdges", () => {
	const e = (from: string, to: string, type: GraphEdge["type"], confidence: number, evidence = ""): GraphEdge => ({
		from,
		to,
		type,
		confidence,
		evidence,
	});

	it("collapses a reversed symmetric pair to one edge, keeping the higher-confidence side", () => {
		const out = normalizeSymmetricEdges([
			e("a", "b", "related-to", 0.6, "lo"),
			e("b", "a", "related-to", 0.9, "hi"),
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ from: "b", to: "a", confidence: 0.9, evidence: "hi" });
	});

	it("keeps the first occurrence on a confidence tie", () => {
		const out = normalizeSymmetricEdges([
			e("a", "b", "related-to", 0.8, "first"),
			e("b", "a", "related-to", 0.8, "second"),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].evidence).toBe("first");
	});

	it("dedups every symmetric type but never directed ones", () => {
		expect([...SYMMETRIC_EDGE_TYPES].sort()).toEqual(["contradicts", "related-to"]);
		const out = normalizeSymmetricEdges([
			e("a", "b", "contradicts", 0.5),
			e("b", "a", "contradicts", 0.7),
			// Directed: A→B and B→A are genuinely distinct facts — both survive.
			e("a", "b", "extends", 0.9),
			e("b", "a", "extends", 0.9),
		]);
		expect(out.filter((x) => x.type === "contradicts")).toHaveLength(1);
		expect(out.filter((x) => x.type === "extends")).toHaveLength(2);
	});

	it("preserves the original order of kept edges", () => {
		const out = normalizeSymmetricEdges([
			e("a", "b", "extends", 0.9),
			e("c", "d", "related-to", 0.6),
			e("d", "c", "related-to", 0.4),
			e("e", "f", "supersedes", 0.8),
		]);
		expect(out.map((x) => `${x.from}->${x.to}:${x.type}`)).toEqual([
			"a->b:extends",
			"c->d:related-to",
			"e->f:supersedes",
		]);
	});

	it("keeps distinct symmetric pairs separate (different endpoints, same type)", () => {
		const out = normalizeSymmetricEdges([e("a", "b", "related-to", 0.6), e("a", "c", "related-to", 0.6)]);
		expect(out).toHaveLength(2);
	});

	it("keeps a reversed twin of a DIFFERENT symmetric type (type is part of the key)", () => {
		const out = normalizeSymmetricEdges([e("a", "b", "related-to", 0.7), e("b", "a", "contradicts", 0.7)]);
		expect(out).toHaveLength(2);
	});

	it("collapses three-plus duplicates of one pair to the single max-confidence edge", () => {
		const out = normalizeSymmetricEdges([
			e("a", "b", "related-to", 0.5, "first"),
			e("b", "a", "related-to", 0.9, "max"),
			e("a", "b", "related-to", 0.7, "third"),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].evidence).toBe("max");
	});

	it("returns an empty list unchanged", () => {
		expect(normalizeSymmetricEdges([])).toEqual([]);
	});
});

describe("dropSubsumedRelatedTo", () => {
	const e = (from: string, to: string, type: GraphEdge["type"], confidence = 0.7): GraphEdge => ({
		from,
		to,
		type,
		confidence,
		evidence: "",
	});

	it("drops a related-to when a directed edge links the same pair (either orientation)", () => {
		const out = dropSubsumedRelatedTo([
			e("a", "b", "related-to", 0.9), // generic, even at higher confidence
			e("b", "a", "extends", 0.5), // specific, reversed orientation — still subsumes
		]);
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe("extends");
	});

	it("drops related-to subsumed by any specific type (contradicts included)", () => {
		const out = dropSubsumedRelatedTo([e("a", "b", "related-to"), e("a", "b", "contradicts")]);
		expect(out.map((x) => x.type)).toEqual(["contradicts"]);
	});

	it("keeps a related-to with no competing specific edge on its pair", () => {
		const out = dropSubsumedRelatedTo([
			e("a", "b", "related-to"),
			e("c", "d", "extends"), // different pair — does not subsume a-b
		]);
		expect(out).toHaveLength(2);
	});

	it("keeps two genuinely-distinct specific edges on one pair (only related-to is ever dropped)", () => {
		const out = dropSubsumedRelatedTo([e("a", "b", "extends"), e("a", "b", "caused-by")]);
		expect(out).toHaveLength(2);
	});

	it("is order-preserving and a no-op on the empty list", () => {
		expect(dropSubsumedRelatedTo([])).toEqual([]);
		const edges = [e("a", "b", "extends"), e("c", "d", "related-to"), e("e", "f", "supersedes")];
		expect(dropSubsumedRelatedTo(edges).map((x) => `${x.from}${x.to}`)).toEqual(["ab", "cd", "ef"]);
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
		const graph = assembleGraph(validGraph(), sources, "2026-06-15T00:00:00.000Z", "");

		expect(graph.generatedAt).toBe("2026-06-15T00:00:00.000Z");
		expect(graph.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);

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
		});
	});

	it("counts a same-category cross-topic edge as crossTopic, and rolls up zero-unit topics", () => {
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
					kinds: ["decision"],
					shortTitle: "U1",
					summary: "s",
					anchors: { files: [], commits: [] },
				},
				{
					id: "t2::u2",
					topicSlug: "t2",
					kinds: ["fix"],
					shortTitle: "U2",
					summary: "s",
					anchors: { files: [], commits: [] },
				},
			],
			edges: [{ from: "t1::u1", to: "t2::u2", type: "related-to", confidence: 0.7, evidence: "same cat" }],
		};
		const graph = assembleGraph(distill, new Map(), "2026-06-15T00:00:00.000Z", "");
		expect(graph.stats.crossTopicEdges).toBe(1);
		// t3 has no units — the `?? 0` rollup path.
		expect(graph.topics.find((t) => t.slug === "t3")?.unitCount).toBe(0);
	});

	it("collapses a reversed symmetric edge pair before stats + emit", () => {
		const g = validGraph();
		// Reversed twins on a pair that has NO competing specific edge (u2↔u3), so the
		// symmetric collapse is isolated from the related-to subsumption rule.
		g.edges.push({ from: "t1::u2", to: "t2::u3", type: "related-to", confidence: 0.6, evidence: "fwd" });
		g.edges.push({ from: "t2::u3", to: "t1::u2", type: "related-to", confidence: 0.9, evidence: "rev" });
		const graph = assembleGraph(g, sources, "2026-06-15T00:00:00.000Z", "");
		// 2 original directed + 1 collapsed symmetric = 3 (not 4).
		expect(graph.stats.edges).toBe(3);
		expect(graph.edges).toHaveLength(3);
		const rel = graph.edges.filter((x) => x.type === "related-to");
		expect(rel).toHaveLength(1);
		expect(rel[0].evidence).toBe("rev"); // higher-confidence side won
	});

	it("drops a related-to subsumed by an existing extends on the same pair (the screenshot case)", () => {
		const g = validGraph(); // already has t1::u1 --extends--> t1::u2
		// Distiller also emitted a generic related-to for the same pair (reversed) at
		// higher confidence — it must be dropped in favor of the specific extends.
		g.edges.push({ from: "t1::u2", to: "t1::u1", type: "related-to", confidence: 0.95, evidence: "generic" });
		const graph = assembleGraph(g, sources, "2026-06-15T00:00:00.000Z", "");
		// extends (t1) + caused-by (cross) survive; the related-to is subsumed.
		expect(graph.stats.edges).toBe(2);
		expect(graph.edges.some((x) => x.type === "related-to")).toBe(false);
		expect(graph.edges.filter((x) => x.type === "extends")).toHaveLength(1);
	});

	it("throws on a graph that fails validation", () => {
		const g = validGraph();
		g.edges.push({ from: "ghost", to: "t1::u1", type: "extends", confidence: 0.6, evidence: "x" });
		expect(() => assembleGraph(g, sources, "2026-06-15T00:00:00.000Z", "")).toThrow(/validation failed/);
	});

	it("embeds the passed topicFingerprints / topicMetaFingerprints (and defaults both to {})", () => {
		const withFp = assembleGraph(
			validGraph(),
			sources,
			"2026-06-15T00:00:00.000Z",
			"",
			{ t1: "a", t2: "b" },
			{ t1: "m" },
		);
		expect(withFp.topicFingerprints).toEqual({ t1: "a", t2: "b" });
		expect(withFp.topicMetaFingerprints).toEqual({ t1: "m" });
		const withoutFp = assembleGraph(validGraph(), sources, "2026-06-15T00:00:00.000Z", "");
		expect(withoutFp.topicFingerprints).toEqual({});
		expect(withoutFp.topicMetaFingerprints).toEqual({});
	});

	it("stamps repoName when provided and omits the field for an empty name", () => {
		const withRepo = assembleGraph(validGraph(), sources, "2026-06-15T00:00:00.000Z", "jolli");
		expect(withRepo.repoName).toBe("jolli");
		// Empty repo name (e.g. an unexpected root basename) omits the field rather than stamping "".
		const withoutRepo = assembleGraph(validGraph(), sources, "2026-06-15T00:00:00.000Z", "");
		expect(withoutRepo.repoName).toBeUndefined();
	});

	it("prunes a category that ends up with zero topics", () => {
		const distill = validGraph();
		// Add an extra category no topic references → must be pruned by assembleGraph.
		distill.categories.push({ id: "orphan-cat", shortTitle: "Orphan", summary: "Nobody here." });
		const graph = assembleGraph(distill, sources, "2026-06-15T00:00:00.000Z", "");
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
		return assembleGraph(validGraph(), new Map(), "2026-06-15T00:00:00.000Z", "", { t1: "a", t2: "b" });
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
		const baseUnit = { id: "x::u", topicSlug: "x", kinds: ["decision"], shortTitle: "U", summary: "s" };
		expect(toDistilled({ ...g, units: [{ ...baseUnit /* no anchors */ }] })).toBeNull();
		expect(
			toDistilled({ ...g, units: [{ ...baseUnit, kinds: ["bogus"], anchors: { files: [], commits: [] } }] }),
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

describe("normalizeKinds", () => {
	it("keeps a valid kinds array in order", () => {
		expect(normalizeKinds({ kinds: ["mechanism", "constraint"] })).toEqual(["mechanism", "constraint"]);
	});

	it("coerces a legacy scalar kind to a single-element array", () => {
		expect(normalizeKinds({ kind: "fix" })).toEqual(["fix"]);
	});

	it("prefers kinds[] over a legacy scalar when both are present", () => {
		expect(normalizeKinds({ kinds: ["decision"], kind: "fix" })).toEqual(["decision"]);
	});

	it("dedupes preserving first-seen order (primary stays first)", () => {
		expect(normalizeKinds({ kinds: ["fix", "fix", "decision"] })).toEqual(["fix", "decision"]);
	});

	it("caps at MAX_UNIT_KINDS", () => {
		const many = ["decision", "mechanism", "fix", "constraint", "gotcha"];
		expect(normalizeKinds({ kinds: many })).toHaveLength(MAX_UNIT_KINDS);
		expect(normalizeKinds({ kinds: many })).toEqual(["decision", "mechanism", "fix"]);
	});

	it("filters out unknown and non-string members", () => {
		expect(normalizeKinds({ kinds: ["decision", "bogus", 7, null, "gotcha"] })).toEqual(["decision", "gotcha"]);
	});

	it("returns [] when nothing valid survives", () => {
		expect(normalizeKinds({ kinds: ["bogus", 5] })).toEqual([]);
		expect(normalizeKinds({ kind: "nope" })).toEqual([]);
		expect(normalizeKinds({})).toEqual([]);
		expect(normalizeKinds({ kinds: "bogus" })).toEqual([]); // scalar kinds, but not a known kind
	});

	it("coerces a stray scalar kinds into a single-element array", () => {
		expect(normalizeKinds({ kinds: "decision" })).toEqual(["decision"]);
		// a scalar kinds still wins over a legacy scalar kind
		expect(normalizeKinds({ kinds: "gotcha", kind: "fix" })).toEqual(["gotcha"]);
	});

	it("accepts all seven kinds", () => {
		for (const k of ["decision", "mechanism", "fix", "constraint", "gotcha", "non-goal", "convention"]) {
			expect(normalizeKinds({ kind: k })).toEqual([k]);
		}
	});

	it("pins UNIT_KINDS to exactly the seven-member closed vocabulary", () => {
		// The closed vocabulary is a red line (a stray add/remove would silently
		// break cross-build tag consistency): assert set identity, not just membership.
		expect([...UNIT_KINDS]).toEqual([
			"decision",
			"mechanism",
			"fix",
			"constraint",
			"gotcha",
			"non-goal",
			"convention",
		]);
	});
});

describe("isCanonicalKinds", () => {
	it("accepts a non-empty deduped array of valid kinds", () => {
		expect(isCanonicalKinds(["decision"])).toBe(true);
		expect(isCanonicalKinds(["decision", "constraint", "gotcha"])).toBe(true);
	});

	it("rejects empty, over-long, duplicated, non-array, or invalid-member values", () => {
		expect(isCanonicalKinds([])).toBe(false);
		expect(isCanonicalKinds(["decision", "mechanism", "fix", "constraint"])).toBe(false); // > MAX
		expect(isCanonicalKinds(["fix", "fix"])).toBe(false); // dupes
		expect(isCanonicalKinds(["decision", "bogus"])).toBe(false);
		expect(isCanonicalKinds("decision")).toBe(false);
		expect(isCanonicalKinds(undefined)).toBe(false);
		expect(isCanonicalKinds([1, 2])).toBe(false);
	});
});

describe("validateCoChangeTopicEdges", () => {
	const topics: DistilledTopic[] = [
		{ slug: "a", shortTitle: "A", summary: "s", title: "A", categoryId: "c1" },
		{ slug: "b", shortTitle: "B", summary: "s", title: "B", categoryId: "c2" },
		{ slug: "c", shortTitle: "C", summary: "s", title: "C", categoryId: "c1" },
	];
	const good: CoChangeTopicEdge = {
		fromTopic: "a",
		toTopic: "b",
		kind: "co-change",
		sharedFiles: ["x.ts"],
		sharedFileCount: 1,
	};

	it("accepts a well-formed cross-category edge", () => {
		expect(validateCoChangeTopicEdges([good], topics)).toEqual([]);
		expect(validateCoChangeTopicEdges([{ ...good, semanticType: "extends" }], topics)).toEqual([]);
	});

	it("flags an unknown endpoint (either side)", () => {
		expect(validateCoChangeTopicEdges([{ ...good, toTopic: "ghost" }], topics).join()).toMatch(
			/unknown toTopic ghost/,
		);
		// fromTopic unknown: use a slug that still sorts before toTopic so the only
		// error raised is the unknown-endpoint one (not a canonical-ordering one).
		expect(validateCoChangeTopicEdges([{ ...good, fromTopic: "aa-ghost" }], topics).join()).toMatch(
			/unknown fromTopic aa-ghost/,
		);
	});

	it("flags a non-array sharedFiles (count mismatch via the -1 sentinel)", () => {
		const bad = { ...good, sharedFiles: undefined as unknown as string[], sharedFileCount: 1 };
		const errs = validateCoChangeTopicEdges([bad], topics).join();
		expect(errs).toMatch(/sharedFiles must be non-empty/);
		expect(errs).toMatch(/sharedFileCount 1 != sharedFiles.length -1/);
	});

	it("flags a self-edge", () => {
		const errs = validateCoChangeTopicEdges([{ ...good, fromTopic: "a", toTopic: "a" }], topics);
		expect(errs.join()).toMatch(/self-edge/);
	});

	it("flags non-canonical ordering", () => {
		const errs = validateCoChangeTopicEdges([{ ...good, fromTopic: "b", toTopic: "a" }], topics);
		expect(errs.join()).toMatch(/not canonically ordered/);
	});

	it("flags two endpoints in the same category", () => {
		// a and c are both c1.
		const errs = validateCoChangeTopicEdges([{ ...good, fromTopic: "a", toTopic: "c" }], topics);
		expect(errs.join()).toMatch(/both endpoints in category c1/);
	});

	it("flags empty sharedFiles and a count mismatch", () => {
		expect(validateCoChangeTopicEdges([{ ...good, sharedFiles: [], sharedFileCount: 0 }], topics).join()).toMatch(
			/sharedFiles must be non-empty/,
		);
		expect(validateCoChangeTopicEdges([{ ...good, sharedFileCount: 5 }], topics).join()).toMatch(
			/sharedFileCount 5 != sharedFiles.length 1/,
		);
	});

	it("flags an invalid kind and an invalid semanticType", () => {
		expect(
			validateCoChangeTopicEdges([{ ...good, kind: "nope" as CoChangeTopicEdge["kind"] }], topics).join(),
		).toMatch(/invalid kind nope/);
		expect(
			validateCoChangeTopicEdges(
				[{ ...good, semanticType: "bogus" as CoChangeTopicEdge["semanticType"] }],
				topics,
			).join(),
		).toMatch(/invalid semanticType bogus/);
	});

	it("flags a duplicate pair", () => {
		const errs = validateCoChangeTopicEdges([good, good], topics);
		expect(errs.join()).toMatch(/duplicate pair/);
	});
});

describe("assembleGraph (co-change edges)", () => {
	const distill: DistilledGraph = {
		categories: [
			{ id: "c1", shortTitle: "C1", summary: "s" },
			{ id: "c2", shortTitle: "C2", summary: "s" },
		],
		topics: [
			{ slug: "a", shortTitle: "A", summary: "s", title: "A", categoryId: "c1" },
			{ slug: "b", shortTitle: "B", summary: "s", title: "B", categoryId: "c2" },
		],
		units: [],
		edges: [],
	};
	const coChange: CoChangeTopicEdge = {
		fromTopic: "a",
		toTopic: "b",
		kind: "co-change",
		sharedFiles: ["x.ts"],
		sharedFileCount: 1,
	};

	it("embeds co-change edges and counts them in stats", () => {
		const graph = assembleGraph(distill, new Map(), "t", "repo", {}, {}, [coChange]);
		expect(graph.coChangeTopicEdges).toEqual([coChange]);
		expect(graph.stats.coChangeTopicEdgeCount).toBe(1);
	});

	it("defaults to an empty co-change layer when none is passed", () => {
		const graph = assembleGraph(distill, new Map(), "t", "repo", {}, {});
		expect(graph.coChangeTopicEdges).toEqual([]);
		expect(graph.stats.coChangeTopicEdgeCount).toBe(0);
	});

	it("throws when a co-change edge is invalid", () => {
		expect(() =>
			assembleGraph(distill, new Map(), "t", "repo", {}, {}, [{ ...coChange, toTopic: "ghost" }]),
		).toThrow(/validation failed/);
	});
});
