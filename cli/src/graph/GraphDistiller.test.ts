import { beforeEach, describe, expect, it, vi } from "vitest";

const { callLlm } = vi.hoisted(() => ({ callLlm: vi.fn() }));
vi.mock("../core/LlmClient.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/LlmClient.js")>()),
	callLlm,
}));
vi.mock("../core/Summarizer.js", () => ({ resolveModelId: (m?: string) => m ?? "model" }));

import { type DistillInput, distillGraph, distillGraphIncremental } from "./GraphDistiller.js";
import type { DistilledGraph, TopicDiff } from "./GraphSchema.js";

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

describe("distillGraphIncremental", () => {
	function baseline(): DistilledGraph {
		return {
			categories: [{ id: "c1", shortTitle: "C1", summary: "s" }],
			topics: [
				{ slug: "t1", shortTitle: "T1", summary: "s", title: "Topic1", categoryId: "c1" },
				{ slug: "t2", shortTitle: "T2old", summary: "old", title: "Topic2", categoryId: "c1" },
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
					id: "t2::uOld",
					topicSlug: "t2",
					kinds: ["fix"],
					shortTitle: "old",
					summary: "s",
					anchors: { files: [], commits: [] },
				},
			],
			edges: [{ from: "t1::u1", to: "t2::uOld", type: "related-to", confidence: 0.7, evidence: "old" }],
		};
	}

	it("reuses clean units, re-distills changed topics, re-categorizes, and recomputes edges in full", async () => {
		callLlm.mockImplementation(async (opts: { action: string; params: Record<string, string> }) => {
			if (opts.action === "graph-categories-delta")
				return {
					text: JSON.stringify({
						newCategories: [],
						topics: [
							{ slug: "t2", title: "Topic2", shortTitle: "T2new", summary: "new", categoryId: "c1" },
							{ slug: "t3", title: "Topic3", shortTitle: "T3", summary: "s", categoryId: "c1" },
						],
					}),
				};
			if (opts.action === "graph-units")
				return {
					text: JSON.stringify({ units: [{ id: "u", kind: "decision", shortTitle: "U", summary: "s" }] }),
				};
			if (opts.action === "graph-edges")
				return {
					text: JSON.stringify({
						edges: [{ from: "t1::u1", to: "t2::u", type: "extends", confidence: 0.9, evidence: "fresh" }],
					}),
					stopReason: null,
				};
			throw new Error(`unexpected ${opts.action}`);
		});

		const input: DistillInput = {
			topics: [
				{ slug: "t1", title: "Topic1", summary: "s", content: "c1" }, // clean
				{ slug: "t2", title: "Topic2", summary: "new", content: "c2" }, // dirty
				{ slug: "t3", title: "Topic3", summary: "s", content: "c3" }, // new
			],
		};
		const diff: TopicDiff = { clean: ["t1"], dirty: ["t2"], added: ["t3"], deleted: [] };
		const g = await distillGraphIncremental(input, baseline(), diff, CONFIG);

		// t1's unit reused verbatim; t2's old unit gone; t2/t3 re-distilled.
		expect(g.units.map((u) => u.id).sort()).toEqual(["t1::u1", "t2::u", "t3::u"]);
		expect(g.units).not.toContainEqual(expect.objectContaining({ id: "t2::uOld" }));
		// units NOT called for the clean topic.
		expect(callLlm).not.toHaveBeenCalledWith(
			expect.objectContaining({ params: expect.objectContaining({ topicTitle: "Topic1" }) }),
		);
		// dirty topic got the delta's refreshed shortTitle; categories merged.
		expect(g.topics.find((t) => t.slug === "t2")?.shortTitle).toBe("T2new");
		expect(g.topics.map((t) => t.slug).sort()).toEqual(["t1", "t2", "t3"]);
		// edges recomputed in full (old edge discarded, fresh one kept).
		expect(g.edges).toEqual([{ from: "t1::u1", to: "t2::u", type: "extends", confidence: 0.9, evidence: "fresh" }]);
	});

	it("admits a genuinely-new delta category while dropping empty / duplicate / existing-id proposals", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-categories-delta")
				return {
					text: JSON.stringify({
						newCategories: [
							{ id: "", shortTitle: "blank", summary: "x" }, // empty id → dropped
							{ id: "storage", shortTitle: "Storage", summary: "x" }, // genuinely new → kept
							{ id: "storage", shortTitle: "Dup", summary: "x" }, // duplicate id → dropped
							{ id: "c1", shortTitle: "Collide", summary: "x" }, // collides with existing → dropped
						],
						topics: [
							{ slug: "t3", title: "Topic3", shortTitle: "T3", summary: "s", categoryId: "storage" },
						],
					}),
				};
			if (opts.action === "graph-units")
				return {
					text: JSON.stringify({ units: [{ id: "u", kind: "decision", shortTitle: "U", summary: "s" }] }),
				};
			return { text: '{"edges":[]}', stopReason: null };
		});
		const input: DistillInput = {
			topics: [
				{ slug: "t1", title: "Topic1", summary: "s", content: "c1" },
				{ slug: "t2", title: "Topic2", summary: "old", content: "c2" },
				{ slug: "t3", title: "Topic3", summary: "s", content: "c3" },
			],
		};
		const diff: TopicDiff = { clean: ["t1", "t2"], dirty: [], added: ["t3"], deleted: [] };
		const g = await distillGraphIncremental(input, baseline(), diff, CONFIG);
		expect(g.categories.map((c) => c.id).sort()).toEqual(["c1", "storage"]);
		expect(g.topics.find((t) => t.slug === "t3")?.categoryId).toBe("storage");
	});

	it("sanitizes the categories-delta: empty-existing, blank fallbacks, hallucinated slug, invalid categoryId", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-categories-delta")
				return {
					text: JSON.stringify({
						newCategories: [{ id: "new1", shortTitle: "  ", summary: "x" }], // blank label → id fallback
						topics: [
							// blank shortTitle/summary → fall back to title/summary; bad categoryId → uncategorized.
							{ slug: "t1", title: "Topic1", shortTitle: "", summary: "", categoryId: "unknown" },
							{ slug: "ghost", title: "G", shortTitle: "G", summary: "s", categoryId: "new1" }, // dropped
						],
					}),
				};
			if (opts.action === "graph-units")
				return {
					text: JSON.stringify({ units: [{ id: "u", kind: "decision", shortTitle: "U", summary: "s" }] }),
				};
			return { text: '{"edges":[]}', stopReason: null };
		});
		const emptyBaseline: DistilledGraph = { categories: [], topics: [], units: [], edges: [] };
		const input: DistillInput = { topics: [{ slug: "t1", title: "Topic1", summary: "sum1", content: "c" }] };
		const diff: TopicDiff = { clean: [], dirty: [], added: ["t1"], deleted: [] };
		const g = await distillGraphIncremental(input, emptyBaseline, diff, CONFIG);

		expect(g.categories.find((c) => c.id === "new1")?.shortTitle).toBe("new1"); // blank → id
		const t1 = g.topics.find((t) => t.slug === "t1");
		expect(t1?.categoryId).toBe("uncategorized"); // unknown categoryId → uncategorized
		expect(t1?.shortTitle).toBe("Topic1"); // blank → src.title
		expect(t1?.summary).toBe("sum1"); // blank → src.summary
		expect(g.topics.find((t) => t.slug === "ghost")).toBeUndefined(); // hallucinated dropped
	});

	it("throws on an unparseable categories-delta (incremental fails closed, keeping the prior graph)", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-categories-delta") return { text: "garbage not json" };
			if (opts.action === "graph-units") return { text: '{"units":[]}' };
			return { text: '{"edges":[]}', stopReason: null };
		});
		const input: DistillInput = { topics: [{ slug: "t1", title: "Topic1", summary: "s", content: "c" }] };
		const diff: TopicDiff = { clean: [], dirty: [], added: ["t1"], deleted: [] };
		// Unparseable delta → throw (not a silent dump of the changed topic into
		// uncategorized over a still-good baseline). The outer non-fatal catch keeps
		// the last good graph. Contrast the full path, which tolerates this (no
		// baseline to protect).
		await expect(
			distillGraphIncremental(input, { categories: [], topics: [], units: [], edges: [] }, diff, CONFIG),
		).rejects.toThrow(/graph-categories-delta returned a malformed response/);
	});

	it("throws when the categories-delta is valid JSON but missing the topics array (incremental fails closed)", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-categories-delta") return { text: "{}" }; // parses, but no arrays
			if (opts.action === "graph-units") return { text: '{"units":[]}' };
			return { text: '{"edges":[]}', stopReason: null };
		});
		const input: DistillInput = { topics: [{ slug: "t1", title: "Topic1", summary: "s", content: "c" }] };
		const diff: TopicDiff = { clean: [], dirty: [], added: ["t1"], deleted: [] };
		// `{}` would otherwise dump t1 into uncategorized over a still-good baseline — strict
		// requires the contracted arrays, not merely parseable JSON.
		await expect(
			distillGraphIncremental(input, { categories: [], topics: [], units: [], edges: [] }, diff, CONFIG),
		).rejects.toThrow(/graph-categories-delta returned a malformed response/);
	});

	it("runs no LLM on a pure deletion: filters deleted units and dangling edges", async () => {
		const input: DistillInput = { topics: [{ slug: "t1", title: "Topic1", summary: "s", content: "c1" }] };
		const diff: TopicDiff = { clean: ["t1"], dirty: [], added: [], deleted: ["t2"] };
		const g = await distillGraphIncremental(input, baseline(), diff, CONFIG);

		expect(callLlm).not.toHaveBeenCalled();
		expect(g.units.map((u) => u.id)).toEqual(["t1::u1"]); // t2's unit dropped
		expect(g.edges).toEqual([]); // the t1→t2 edge dangled and was filtered
		expect(g.topics.map((t) => t.slug)).toEqual(["t1"]);
		expect(g.categories.map((c) => c.id)).toEqual(["c1"]);
	});

	it("backfills a changed topic the delta dropped (a valid-but-incomplete delta is tolerated)", async () => {
		callLlm.mockImplementation(async (opts: { action: string; params: Record<string, string> }) => {
			if (opts.action === "graph-categories-delta")
				return { text: JSON.stringify({ newCategories: [], topics: [] }) }; // valid JSON, just dropped t2
			if (opts.action === "graph-units")
				return {
					text: JSON.stringify({ units: [{ id: "u", kind: "decision", shortTitle: "U", summary: "s" }] }),
				};
			if (opts.action === "graph-edges") return { text: '{"edges":[]}', stopReason: null };
			throw new Error(`unexpected ${opts.action}`);
		});
		const input: DistillInput = { topics: [{ slug: "t2", title: "Topic2", summary: "new", content: "c2" }] };
		const diff: TopicDiff = { clean: [], dirty: ["t2"], added: [], deleted: ["t1"] };
		const g = await distillGraphIncremental(input, baseline(), diff, CONFIG, () => {});

		// A VALID delta that merely omitted t2 is not a failure — the merge backfills it
		// into uncategorized, and its units were still re-distilled successfully.
		expect(g.topics.find((t) => t.slug === "t2")?.categoryId).toBe("uncategorized");
		expect(g.units.map((u) => u.id)).toEqual(["t2::u"]);
	});

	it("throws when a changed topic's unit call fails (incremental fails closed)", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-units") throw new Error("boom"); // a thrown LLM error must propagate
			return { text: JSON.stringify({ newCategories: [], topics: [] }) };
		});
		const input: DistillInput = { topics: [{ slug: "t2", title: "Topic2", summary: "new", content: "c2" }] };
		const diff: TopicDiff = { clean: [], dirty: ["t2"], added: [], deleted: ["t1"] };
		// A dirty topic's failed unit re-distillation must abort the round (NOT emit a
		// unit-less topic over a baseline that had units). The full path swallows this;
		// the incremental path must not.
		await expect(distillGraphIncremental(input, baseline(), diff, CONFIG, () => {})).rejects.toThrow("boom");
	});

	it("throws when a changed topic's units return unparseable JSON (incremental fails closed)", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-units") return { text: "not json at all" };
			return { text: JSON.stringify({ newCategories: [], topics: [] }) };
		});
		const input: DistillInput = { topics: [{ slug: "t2", title: "Topic2", summary: "new", content: "c2" }] };
		const diff: TopicDiff = { clean: [], dirty: ["t2"], added: [], deleted: ["t1"] };
		await expect(distillGraphIncremental(input, baseline(), diff, CONFIG)).rejects.toThrow(
			/graph-units returned no units array/,
		);
	});

	it("throws when a changed topic's units are valid JSON but missing the units array (incremental)", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-units") return { text: "{}" }; // parses, but no units array
			return { text: JSON.stringify({ newCategories: [], topics: [] }) };
		});
		const input: DistillInput = { topics: [{ slug: "t2", title: "Topic2", summary: "new", content: "c2" }] };
		const diff: TopicDiff = { clean: [], dirty: ["t2"], added: [], deleted: ["t1"] };
		await expect(distillGraphIncremental(input, baseline(), diff, CONFIG)).rejects.toThrow(
			/graph-units returned no units array/,
		);
	});

	it("throws when graph-edges returns unparseable JSON (incremental fails closed)", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-categories-delta")
				return {
					text: JSON.stringify({
						newCategories: [],
						topics: [{ slug: "t2", title: "Topic2", shortTitle: "T2", summary: "s", categoryId: "c1" }],
					}),
				};
			if (opts.action === "graph-units")
				return {
					text: JSON.stringify({ units: [{ id: "u", kind: "decision", shortTitle: "U", summary: "s" }] }),
				};
			if (opts.action === "graph-edges") return { text: "not json at all", stopReason: null };
			throw new Error(`unexpected ${opts.action}`);
		});
		// Two final units (t1 reused + t2 fresh) → the edge call fires; its unparseable
		// output would otherwise wipe the whole edge layer, so it must throw instead.
		const input: DistillInput = {
			topics: [
				{ slug: "t1", title: "Topic1", summary: "s", content: "c1" },
				{ slug: "t2", title: "Topic2", summary: "new", content: "c2" },
			],
		};
		const diff: TopicDiff = { clean: ["t1"], dirty: ["t2"], added: [], deleted: [] };
		await expect(distillGraphIncremental(input, baseline(), diff, CONFIG)).rejects.toThrow(
			/graph-edges returned no edges array/,
		);
	});

	it("surfaces truncation in the thrown error when graph-edges is cut off at max_tokens (incremental)", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-categories-delta")
				return {
					text: JSON.stringify({
						newCategories: [],
						topics: [{ slug: "t2", title: "Topic2", shortTitle: "T2", summary: "s", categoryId: "c1" }],
					}),
				};
			if (opts.action === "graph-units")
				return {
					text: JSON.stringify({ units: [{ id: "u", kind: "decision", shortTitle: "U", summary: "s" }] }),
				};
			// Cut-off JSON that won't parse, flagged as a max_tokens truncation.
			if (opts.action === "graph-edges") return { text: '{"edges":[{"from":"t1', stopReason: "max_tokens" };
			throw new Error(`unexpected ${opts.action}`);
		});
		const input: DistillInput = {
			topics: [
				{ slug: "t1", title: "Topic1", summary: "s", content: "c1" },
				{ slug: "t2", title: "Topic2", summary: "new", content: "c2" },
			],
		};
		const diff: TopicDiff = { clean: ["t1"], dirty: ["t2"], added: [], deleted: [] };
		// fail-closed AND the reason (truncation) is named so a stuck graph is diagnosable.
		await expect(distillGraphIncremental(input, baseline(), diff, CONFIG)).rejects.toThrow(
			/graph-edges returned no edges array \(response truncated at max_tokens\)/,
		);
	});

	it("throws when graph-edges is valid JSON but missing the edges array (incremental fails closed)", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-categories-delta")
				return {
					text: JSON.stringify({
						newCategories: [],
						topics: [{ slug: "t2", title: "Topic2", shortTitle: "T2", summary: "s", categoryId: "c1" }],
					}),
				};
			if (opts.action === "graph-units")
				return {
					text: JSON.stringify({ units: [{ id: "u", kind: "decision", shortTitle: "U", summary: "s" }] }),
				};
			if (opts.action === "graph-edges") return { text: "{}", stopReason: null }; // parses, no edges array
			throw new Error(`unexpected ${opts.action}`);
		});
		const input: DistillInput = {
			topics: [
				{ slug: "t1", title: "Topic1", summary: "s", content: "c1" },
				{ slug: "t2", title: "Topic2", summary: "new", content: "c2" },
			],
		};
		const diff: TopicDiff = { clean: ["t1"], dirty: ["t2"], added: [], deleted: [] };
		await expect(distillGraphIncremental(input, baseline(), diff, CONFIG)).rejects.toThrow(
			/graph-edges returned no edges array/,
		);
	});
});

describe("kinds multi-label handling", () => {
	const oneTopic = { topics: [{ slug: "t1", title: "Topic1", summary: "s", content: "b" }] };
	const cats = JSON.stringify({
		categories: [{ id: "c", shortTitle: "C", summary: "c" }],
		topics: [{ slug: "t1", title: "Topic1", shortTitle: "T1", summary: "s", categoryId: "c" }],
	});

	it("preserves a canonical kinds[] and dedupes + caps at three, order preserved", async () => {
		setup({
			categories: cats,
			units: {
				Topic1: JSON.stringify({
					units: [
						{
							id: "u1",
							kinds: ["fix", "fix", "gotcha", "decision", "constraint"],
							shortTitle: "U1",
							summary: "s",
						},
					],
				}),
			},
		});
		const g = await distillGraph(oneTopic, CONFIG);
		expect(g.units.find((u) => u.id === "t1::u1")?.kinds).toEqual(["fix", "gotcha", "decision"]);
	});

	it("coerces a legacy scalar kind into a single-element kinds[]", async () => {
		setup({
			categories: cats,
			units: {
				Topic1: JSON.stringify({ units: [{ id: "u1", kind: "mechanism", shortTitle: "U", summary: "s" }] }),
			},
		});
		const g = await distillGraph(oneTopic, CONFIG);
		expect(g.units.find((u) => u.id === "t1::u1")?.kinds).toEqual(["mechanism"]);
	});

	it("full path drops a unit with no valid kind but keeps its valid siblings", async () => {
		setup({
			categories: cats,
			units: {
				Topic1: JSON.stringify({
					units: [
						{ id: "bad", kinds: ["bogus"], shortTitle: "B", summary: "s" },
						{ id: "ok", kinds: ["decision", "non-goal"], shortTitle: "OK", summary: "s" },
					],
				}),
			},
		});
		const g = await distillGraph(oneTopic, CONFIG);
		expect(g.units.map((u) => u.id)).toEqual(["t1::ok"]);
		expect(g.units[0].kinds).toEqual(["decision", "non-goal"]);
	});

	it("incremental (strict) throws when a dirty topic's units are ALL invalid-kind (fail closed)", async () => {
		callLlm.mockImplementation(async (opts: { action: string }) => {
			if (opts.action === "graph-categories-delta")
				return {
					text: JSON.stringify({
						newCategories: [],
						topics: [{ slug: "t1", shortTitle: "T1", summary: "s", categoryId: "c" }],
					}),
				};
			if (opts.action === "graph-units")
				return {
					text: JSON.stringify({ units: [{ id: "u1", kinds: ["bogus"], shortTitle: "U", summary: "s" }] }),
				};
			return { text: '{"edges":[]}', stopReason: null };
		});
		const prev: DistilledGraph = {
			categories: [{ id: "c", shortTitle: "C", summary: "s" }],
			topics: [],
			units: [],
			edges: [],
		};
		const diff: TopicDiff = { clean: [], dirty: ["t1"], added: [], deleted: [] };
		await expect(distillGraphIncremental(oneTopic, prev, diff, CONFIG)).rejects.toThrow(
			/none had a valid id \+ kinds/,
		);
	});

	it("full path degrades an all-invalid topic to [] (onError) without aborting the build", async () => {
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
				if (opts.params.topicTitle === "Topic1")
					return {
						text: JSON.stringify({
							units: [{ id: "u1", kinds: ["bogus"], shortTitle: "U", summary: "s" }],
						}),
					};
				return {
					text: JSON.stringify({ units: [{ id: "u9", kinds: ["fix"], shortTitle: "U9", summary: "s" }] }),
				};
			}
			return { text: '{"edges":[]}', stopReason: null };
		});
		const g = await distillGraph(TWO_TOPICS, CONFIG);
		// Topic1 threw (all-invalid) → swallowed to []; Topic2 survives.
		expect(g.units.map((u) => u.id)).toEqual(["t2::u9"]);
	});
});
