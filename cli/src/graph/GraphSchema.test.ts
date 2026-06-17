import { describe, expect, it } from "vitest";
import { assembleGraph, type DistilledGraph, type TopicSourceMeta, validateDistilledGraph } from "./GraphSchema.js";

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
		expect(graph.schemaVersion).toBe(1);

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
});
