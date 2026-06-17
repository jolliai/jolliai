import { beforeEach, describe, expect, it, vi } from "vitest";

const { callLlm } = vi.hoisted(() => ({ callLlm: vi.fn() }));
vi.mock("../core/LlmClient.js", () => ({ callLlm }));
vi.mock("../core/Summarizer.js", () => ({ resolveModelId: (m?: string) => m ?? "model" }));

import { type DistillInput, distillGraph } from "./GraphDistiller.js";

const CONFIG = { apiKey: "k", model: "haiku" };

const TWO_TOPICS: DistillInput = {
	topics: [
		{ slug: "t1", title: "Topic1", summary: "Topic one.", content: "body 1" },
		{ slug: "t2", title: "Topic2", summary: "Topic two.", content: "body 2" },
	],
};

interface Responses {
	categories: string;
	units: Record<string, string>;
	edges?: string;
	edgesStop?: string | null;
}

function setup(r: Responses): void {
	callLlm.mockImplementation(async (opts: { action: string; params: Record<string, string> }) => {
		if (opts.action === "graph-categories") return { text: r.categories };
		if (opts.action === "graph-units") return { text: r.units[opts.params.topicTitle] ?? '{"units":[]}' };
		if (opts.action === "graph-edges") return { text: r.edges ?? '{"edges":[]}', stopReason: r.edgesStop ?? null };
		throw new Error(`unexpected action ${opts.action}`);
	});
}

beforeEach(() => {
	callLlm.mockReset();
});

describe("distillGraph", () => {
	it("distills categories, namespaced units, and filtered edges end to end", async () => {
		setup({
			// Drops t2 from topics → must be backfilled into "uncategorized".
			categories: JSON.stringify({
				categories: [{ id: "cat-a", shortTitle: "A", summary: "a" }],
				topics: [{ slug: "t1", title: "Topic1", shortTitle: "T1", summary: "s1", categoryId: "cat-a" }],
			}),
			units: {
				// Duplicate local id "u1" → second becomes "u1-2"; missing anchors → [].
				Topic1: JSON.stringify({
					units: [
						{
							id: "u1",
							kind: "decision",
							shortTitle: "U1",
							summary: "s",
							anchors: { files: ["a.ts"], commits: [] },
						},
						{ id: "u1", kind: "fix", shortTitle: "U1b", summary: "s" },
					],
				}),
				Topic2: JSON.stringify({ units: [{ id: "u9", kind: "mechanism", shortTitle: "U9", summary: "s" }] }),
			},
			edges: JSON.stringify({
				edges: [
					{ from: "t1::u1", to: "t1::u1-2", type: "extends", confidence: 0.9, evidence: "ok" },
					{ from: "t1::u1", to: "t1::u1", type: "extends", confidence: 0.9, evidence: "self" },
					{ from: "t1::u1", to: "ghost", type: "extends", confidence: 0.9, evidence: "dangling" },
					{ from: "t1::u1", to: "t2::u9", type: "bogus", confidence: 0.9, evidence: "bad type" },
					{ from: "t1::u1", to: "t1::u1-2", type: "extends", confidence: 0.9, evidence: "dup" },
					{ from: "t1::u1", to: "t2::u9", type: "related-to", confidence: 5, evidence: "clamp" },
				],
			}),
		});

		const g = await distillGraph(TWO_TOPICS, CONFIG);

		// Backfill: t2 present, in an auto-created "uncategorized" category.
		expect(g.topics.map((t) => t.slug).sort()).toEqual(["t1", "t2"]);
		expect(g.topics.find((t) => t.slug === "t2")?.categoryId).toBe("uncategorized");
		expect(g.categories.some((c) => c.id === "uncategorized")).toBe(true);

		// Unit ids are namespaced per topic; the local collision was suffixed.
		expect(g.units.map((u) => u.id).sort()).toEqual(["t1::u1", "t1::u1-2", "t2::u9"]);
		expect(g.units.find((u) => u.id === "t1::u1")?.anchors.files).toEqual(["a.ts"]);
		expect(g.units.find((u) => u.id === "t1::u1-2")?.anchors).toEqual({ files: [], commits: [] });

		// Edge filtering: self / dangling / bad-type / duplicate dropped; confidence clamped.
		expect(g.edges).toHaveLength(2);
		const clamped = g.edges.find((e) => e.type === "related-to");
		expect(clamped?.confidence).toBe(1);
	});

	it("strips markdown code fences before parsing", async () => {
		setup({
			categories:
				"```json\n" +
				JSON.stringify({
					categories: [{ id: "c", shortTitle: "C", summary: "c" }],
					topics: [{ slug: "t1", title: "Topic1", shortTitle: "T1", summary: "s", categoryId: "c" }],
				}) +
				"\n```",
			units: { Topic1: '{"units":[]}', Topic2: '{"units":[]}' },
		});
		const g = await distillGraph({ topics: [TWO_TOPICS.topics[0]] }, CONFIG);
		expect(g.categories.map((c) => c.id)).toEqual(["c"]);
		expect(g.topics.find((t) => t.slug === "t1")?.categoryId).toBe("c");
	});

	it("is non-fatal when a topic's unit call throws", async () => {
		callLlm.mockImplementation(async (opts: { action: string; params: Record<string, string> }) => {
			if (opts.action === "graph-categories")
				return {
					text: JSON.stringify({
						categories: [{ id: "c", shortTitle: "C", summary: "c" }],
						topics: TWO_TOPICS.topics.map((t) => ({
							slug: t.slug,
							title: t.title,
							shortTitle: t.slug,
							summary: t.summary,
							categoryId: "c",
						})),
					}),
				};
			if (opts.action === "graph-units") {
				if (opts.params.topicTitle === "Topic2") throw new Error("boom");
				return {
					text: JSON.stringify({ units: [{ id: "u1", kind: "decision", shortTitle: "U1", summary: "s" }] }),
				};
			}
			return { text: '{"edges":[]}', stopReason: null };
		});

		const g = await distillGraph(TWO_TOPICS, CONFIG);
		expect(g.units.map((u) => u.id)).toEqual(["t1::u1"]); // t2 contributed nothing, no throw
	});

	it("skips the edge call when fewer than two units exist", async () => {
		setup({
			categories: JSON.stringify({
				categories: [{ id: "c", shortTitle: "C", summary: "c" }],
				topics: [{ slug: "t1", title: "Topic1", shortTitle: "T1", summary: "s", categoryId: "c" }],
			}),
			units: {
				Topic1: JSON.stringify({ units: [{ id: "u1", kind: "decision", shortTitle: "U1", summary: "s" }] }),
			},
		});
		const g = await distillGraph({ topics: [TWO_TOPICS.topics[0]] }, CONFIG);
		expect(g.edges).toEqual([]);
		expect(callLlm).not.toHaveBeenCalledWith(expect.objectContaining({ action: "graph-edges" }));
	});

	it("extracts a JSON span wrapped in prose, and tolerates a malformed span", async () => {
		setup({
			categories:
				'Sure! Here you go:\n{"categories":[{"id":"c","shortTitle":"C","summary":"c"}],' +
				'"topics":[{"slug":"t1","title":"Topic1","shortTitle":"T1","summary":"s","categoryId":"c"}]}\nDone.',
			units: { Topic1: "{bad json" }, // starts with { → JSON.parse throws → caught → no units
		});
		const g = await distillGraph({ topics: [TWO_TOPICS.topics[0]] }, CONFIG);
		expect(g.topics.find((t) => t.slug === "t1")?.categoryId).toBe("c");
		expect(g.units).toEqual([]);
	});

	it("reassigns bad categoryId, skips invalid units, coerces anchors/confidence, warns on truncated edges", async () => {
		setup({
			categories: JSON.stringify({
				categories: [{ id: "cat-a", shortTitle: "A", summary: "a" }],
				// categoryId not in the category list -> must be reassigned to uncategorized.
				topics: [{ slug: "t1", title: "Topic1", shortTitle: "T1", summary: "s", categoryId: "ghost-cat" }],
			}),
			units: {
				Topic1: JSON.stringify({
					units: [
						{
							id: "u1",
							kind: "decision",
							shortTitle: "U1",
							summary: "s",
							anchors: { files: "not-array", commits: ["c1"] },
						},
						{ id: "u2", kind: "mechanism", shortTitle: "U2", summary: "s" },
						{ id: "u3", kind: "not-a-kind", shortTitle: "Bad", summary: "s" },
					],
				}),
			},
			edges: JSON.stringify({
				edges: [{ from: "t1::u1", to: "t1::u2", type: "extends", confidence: "abc", evidence: "e" }],
			}),
			edgesStop: "max_tokens",
		});
		const g = await distillGraph({ topics: [TWO_TOPICS.topics[0]] }, CONFIG);

		expect(g.topics.find((t) => t.slug === "t1")?.categoryId).toBe("uncategorized");
		expect(g.categories.some((c) => c.id === "uncategorized")).toBe(true);
		// Invalid-kind unit dropped; non-array anchors coerced to [].
		expect(g.units.map((u) => u.id)).toEqual(["t1::u1", "t1::u2"]);
		expect(g.units[0].anchors.files).toEqual([]);
		expect(g.units[0].anchors.commits).toEqual(["c1"]);
		// Non-numeric confidence -> clamped default 0.7.
		expect(g.edges).toHaveLength(1);
		expect(g.edges[0].confidence).toBe(0.7);
	});

	it("handles undefined LLM text and skips units missing an id", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-categories") return {}; // text undefined -> parse null -> backfill
			if (opts.action === "graph-units")
				return {
					text: JSON.stringify({
						units: [
							{ id: "", kind: "decision", shortTitle: "no-id", summary: "s" },
							{ id: "ok", kind: "decision", shortTitle: "OK", summary: "s" },
						],
					}),
				};
			return { text: '{"edges":[]}', stopReason: null };
		});
		const g = await distillGraph({ topics: [TWO_TOPICS.topics[0]] }, CONFIG);
		expect(g.categories.some((c) => c.id === "uncategorized")).toBe(true);
		expect(g.units.map((u) => u.id)).toEqual(["t1::ok"]); // empty-id unit skipped
	});

	it("reports progress through each phase, counting units done/total across failures", async () => {
		callLlm.mockImplementation(async (opts: { action: string; params: Record<string, string> }) => {
			if (opts.action === "graph-categories")
				return {
					text: JSON.stringify({
						categories: [{ id: "c", shortTitle: "C", summary: "c" }],
						topics: TWO_TOPICS.topics.map((t) => ({
							slug: t.slug,
							title: t.title,
							shortTitle: t.slug,
							summary: t.summary,
							categoryId: "c",
						})),
					}),
				};
			if (opts.action === "graph-units") {
				if (opts.params.topicTitle === "Topic2") throw new Error("boom"); // onError still bumps the counter
				return {
					text: JSON.stringify({
						units: [
							{ id: "u1", kind: "decision", shortTitle: "U1", summary: "s" },
							{ id: "u2", kind: "fix", shortTitle: "U2", summary: "s" },
						],
					}),
				};
			}
			return { text: '{"edges":[]}', stopReason: null };
		});

		const messages: string[] = [];
		await distillGraph(TWO_TOPICS, CONFIG, (m) => messages.push(m));

		expect(messages[0]).toBe("categorizing 2 topic(s)");
		expect(messages).toContain("extracting units 0/2");
		expect(messages).toContain("extracting units 2/2"); // both topics counted, incl. the failed one
		expect(messages).toContain("linking edges across 2 unit(s)"); // the surviving topic's 2 units
	});

	it("drops hallucinated topic slugs, substitutes empty content, and tolerates unparseable edges", async () => {
		const input: DistillInput = {
			topics: [
				{ slug: "t1", title: "Topic1", summary: "one", content: "" }, // empty content → "(empty)"
				{ slug: "t2", title: "Topic2", summary: "two", content: "body 2" },
			],
		};
		let t1UnitContent: string | undefined;
		callLlm.mockImplementation(async (opts: { action: string; params: Record<string, string> }) => {
			if (opts.action === "graph-categories")
				return {
					text: JSON.stringify({
						categories: [{ id: "c", shortTitle: "C", summary: "c" }],
						topics: [
							{ slug: "t1", title: "Topic1", shortTitle: "T1", summary: "s", categoryId: "c" },
							{ slug: "t2", title: "Topic2", shortTitle: "T2", summary: "s", categoryId: "c" },
							// Slug not present in the input → hallucinated, must be skipped.
							{ slug: "ghost", title: "Ghost", shortTitle: "G", summary: "s", categoryId: "c" },
						],
					}),
				};
			if (opts.action === "graph-units") {
				if (opts.params.topicTitle === "Topic1") t1UnitContent = opts.params.content;
				return {
					text: JSON.stringify({ units: [{ id: "u1", kind: "decision", shortTitle: "U", summary: "s" }] }),
				};
			}
			return { text: "not json at all", stopReason: null }; // edges unparseable → parsed null → ?? []
		});

		const g = await distillGraph(input, CONFIG);
		// Hallucinated "ghost" slug dropped; only the two real topics survive.
		expect(g.topics.map((t) => t.slug).sort()).toEqual(["t1", "t2"]);
		// Empty content was substituted with the "(empty)" placeholder for the units call.
		expect(t1UnitContent).toBe("(empty)");
		// Two units exist so the edge phase runs, but its output is unparseable → no edges, no throw.
		expect(g.units).toHaveLength(2);
		expect(g.edges).toEqual([]);
	});

	it("deduplicates category ids (keeps first) and falls back a missing category title to its id", async () => {
		setup({
			categories: JSON.stringify({
				categories: [
					{ id: "dup", shortTitle: "First", summary: "first" },
					{ id: "dup", shortTitle: "Second", summary: "second" }, // duplicate id → dropped
					{ id: "no-title", shortTitle: "  ", summary: "untitled" }, // blank shortTitle → falls back to id
				],
				topics: [{ slug: "t1", title: "Topic1", shortTitle: "T1", summary: "s", categoryId: "dup" }],
			}),
			units: { Topic1: '{"units":[]}' },
		});
		const g = await distillGraph({ topics: [TWO_TOPICS.topics[0]] }, CONFIG);
		// Only one "dup" category survives, keeping the FIRST occurrence's title.
		expect(g.categories.filter((c) => c.id === "dup")).toHaveLength(1);
		expect(g.categories.find((c) => c.id === "dup")?.shortTitle).toBe("First");
		// Missing title falls back to the id (never a blank label).
		expect(g.categories.find((c) => c.id === "no-title")?.shortTitle).toBe("no-title");
		// Topic still resolves to the deduped category — assembly does not throw.
		expect(g.topics.find((t) => t.slug === "t1")?.categoryId).toBe("dup");
	});

	it("falls back a unit's missing title to its local id and its missing summary to the title", async () => {
		setup({
			categories: JSON.stringify({
				categories: [{ id: "c", shortTitle: "C", summary: "c" }],
				topics: [{ slug: "t1", title: "Topic1", shortTitle: "T1", summary: "s", categoryId: "c" }],
			}),
			// Unit with explicitly blank shortTitle and summary (LLM emitted "" / whitespace).
			units: {
				Topic1: JSON.stringify({ units: [{ id: "u1", kind: "decision", shortTitle: "", summary: " " }] }),
			},
		});
		const g = await distillGraph({ topics: [TWO_TOPICS.topics[0]] }, CONFIG);
		const u = g.units.find((x) => x.id === "t1::u1");
		expect(u?.shortTitle).toBe("u1"); // blank title fell back to the local id
		expect(u?.summary).toBe("u1"); // blank summary fell back to the (filled-in) shortTitle
	});

	it("sends a `(none)` placeholder when there are no topics to categorize", async () => {
		let categoriesTopicsBlock: string | undefined;
		callLlm.mockImplementation(async (opts: { action: string; params: Record<string, string> }) => {
			if (opts.action === "graph-categories") {
				categoriesTopicsBlock = opts.params.topics;
				return { text: '{"categories":[],"topics":[]}' };
			}
			return { text: '{"edges":[]}', stopReason: null };
		});
		const g = await distillGraph({ topics: [] }, CONFIG);
		expect(categoriesTopicsBlock).toBe("(none)");
		expect(g.topics).toEqual([]);
		expect(g.units).toEqual([]);
		expect(g.edges).toEqual([]);
	});

	it("tolerates unparseable LLM output (empty graph, no throw)", async () => {
		callLlm.mockResolvedValue({ text: "not json at all", stopReason: null });
		const g = await distillGraph({ topics: [TWO_TOPICS.topics[0]] }, CONFIG);
		// categories unparseable → topic backfilled into uncategorized; no units/edges.
		expect(g.topics.map((t) => t.slug)).toEqual(["t1"]);
		expect(g.categories.some((c) => c.id === "uncategorized")).toBe(true);
		expect(g.units).toEqual([]);
		expect(g.edges).toEqual([]);
	});
});
