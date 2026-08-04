import { describe, expect, it } from "vitest";
import type { CommitSummary, ModelTokenUsage } from "../Types.js";
import { CURRENT_SCHEMA_VERSION } from "../Types.js";
import { type RecomputeSession, recomputeConversationUsage } from "./ConversationUsageRecompute.js";
import { PRICES_AS_OF } from "./Pricing.js";

const node = (over: Partial<CommitSummary> = {}): CommitSummary => ({
	version: CURRENT_SCHEMA_VERSION,
	commitHash: "a".repeat(40),
	commitMessage: "test commit",
	commitAuthor: "Tester",
	commitDate: "2026-07-29T00:00:00.000Z",
	branch: "feature/x",
	generatedAt: "2026-07-29T00:00:01.000Z",
	topics: [],
	...over,
});

const opus = (input: number, output: number, cached: number): ModelTokenUsage => ({
	model: "claude-opus-5",
	provider: "anthropic",
	input,
	output,
	cached,
});

const evidence = (
	entries: Record<string, ReadonlyArray<RecomputeSession>>,
): Map<string, ReadonlyArray<RecomputeSession>> => new Map(Object.entries(entries));

const opusCost = (input: number, output: number, cached: number): number =>
	(input * 5 + output * 25 + cached * 6.25) / 1_000_000;

describe("recomputeConversationUsage", () => {
	it("derives a node's figures from the sessions in the transcripts it owns", () => {
		// The stored figures are inflated (pre-dedup history); the transcripts are the
		// evidence, so the derived total replaces them outright rather than adjusting them.
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 5000,
			conversationTokenBreakdown: { input: 1000, output: 2000, cached: 2000 },
			conversationModels: [opus(1000, 2000, 2000)],
			estimatedCostUsd: 99,
			pricesAsOf: "2026-01-01",
		});

		const result = recomputeConversationUsage(
			summary,
			evidence({
				t1: [
					{ usage: { input: 10, output: 20, cached: 30 }, usageByModel: [opus(10, 20, 30)] },
					{ usage: { input: 1, output: 2, cached: 3 }, usageByModel: [opus(1, 2, 3)] },
				],
			}),
		);

		expect(result.changed).toBe(true);
		expect(result.skipped).toEqual([]);
		expect(result.summary.conversationTokens).toBe(66);
		expect(result.summary.conversationTokenBreakdown).toEqual({ input: 11, output: 22, cached: 33 });
		expect(result.summary.conversationModels).toEqual([opus(11, 22, 33)]);
		expect(result.summary.estimatedCostUsd).toBeCloseTo(opusCost(11, 22, 33), 12);
		expect(result.summary.pricesAsOf).toBe(PRICES_AS_OF);
	});

	it("is idempotent: a second pass over already-derived figures changes nothing", () => {
		const stored = node({
			transcripts: ["t1"],
			conversationTokens: 66,
			conversationTokenBreakdown: { input: 11, output: 22, cached: 33 },
			conversationModels: [opus(11, 22, 33)],
			estimatedCostUsd: opusCost(11, 22, 33),
			pricesAsOf: PRICES_AS_OF,
		});
		const files = evidence({
			t1: [{ usage: { input: 11, output: 22, cached: 33 }, usageByModel: [opus(11, 22, 33)] }],
		});

		const result = recomputeConversationUsage(stored, files);

		expect(result.changed).toBe(false);
		expect(result.summary).toBe(stored);
	});

	it("strips the whole usage group when the owned transcripts hold no sessions any more", () => {
		// Detach removed the last session, so the file is gone — the honest figure is
		// "this memory reports no usage", not a stored zero (see the display contract).
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 300,
			conversationTokenBreakdown: { input: 100, output: 100, cached: 100 },
			conversationModels: [opus(100, 100, 100)],
			estimatedCostUsd: opusCost(100, 100, 100),
			pricesAsOf: PRICES_AS_OF,
		});

		const result = recomputeConversationUsage(summary, evidence({ t1: [] }));

		expect(result.changed).toBe(true);
		expect(result.summary.conversationTokens).toBeUndefined();
		expect(result.summary.conversationTokenBreakdown).toBeUndefined();
		expect(result.summary.conversationModels).toBeUndefined();
		expect(result.summary.estimatedCostUsd).toBeUndefined();
		expect(result.summary.pricesAsOf).toBeUndefined();
	});

	it("skips a node when a session in an owned transcript carries no usage", () => {
		// Forward-only. A pre-v5 file (or a source that reports no usage) would sum to
		// less than the memory legitimately has, so deriving there destroys real data.
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 1000,
			conversationTokenBreakdown: { input: 100, output: 200, cached: 700 },
		});

		const result = recomputeConversationUsage(
			summary,
			evidence({ t1: [{ usage: { input: 1, output: 2, cached: 3 } }, {}] }),
		);

		expect(result.changed).toBe(false);
		expect(result.summary).toBe(summary);
		expect(result.skipped).toEqual(["t1"]);
	});

	it("skips a node when one of its owned transcripts is missing from the evidence", () => {
		// Partial evidence is the dangerous case: summing only the readable file would
		// silently under-report, which reads exactly like a settled figure.
		const summary = node({
			transcripts: ["t1", "t2"],
			conversationTokens: 1000,
			conversationTokenBreakdown: { input: 100, output: 200, cached: 700 },
		});

		const result = recomputeConversationUsage(
			summary,
			evidence({ t1: [{ usage: { input: 1, output: 2, cached: 3 }, usageByModel: [opus(1, 2, 3)] }] }),
		);

		expect(result.changed).toBe(false);
		expect(result.summary).toBe(summary);
		expect(result.skipped).toEqual(["t2"]);
	});

	it("recomputes the child that owns the id and leaves the indexing root alone", () => {
		const child = node({
			commitHash: "c".repeat(40),
			transcripts: ["t-child"],
			conversationTokens: 900,
			conversationTokenBreakdown: { input: 300, output: 300, cached: 300 },
		});
		const root = node({
			transcripts: ["t-child", "t-root"],
			children: [child],
			conversationTokens: 60,
			conversationTokenBreakdown: { input: 20, output: 20, cached: 20 },
		});

		const result = recomputeConversationUsage(
			root,
			evidence({
				"t-child": [{ usage: { input: 1, output: 2, cached: 3 }, usageByModel: [opus(1, 2, 3)] }],
				"t-root": [{ usage: { input: 20, output: 20, cached: 20 }, usageByModel: [opus(20, 20, 20)] }],
			}),
		);

		expect(result.changed).toBe(true);
		expect(result.summary.children?.[0].conversationTokens).toBe(6);
		// The root's own delta figures already matched its own transcript, so they stay.
		expect(result.summary.conversationTokens).toBe(60);
	});

	it("attributes a v5-migrated tree's ids to the child that counted them", () => {
		// upgradeOneSummary indexes every descendant hash at the ROOT and leaves the
		// child without a `transcripts` field. Deriving at the root would move the
		// child's tokens up while the child kept its own — double-counted on every
		// surface that aggregates the tree.
		const childHash = "c".repeat(40);
		const child = node({
			commitHash: childHash,
			conversationTokens: 900,
			conversationTokenBreakdown: { input: 300, output: 300, cached: 300 },
		});
		const root = node({ transcripts: [childHash], children: [child] });

		const result = recomputeConversationUsage(
			root,
			evidence({ [childHash]: [{ usage: { input: 1, output: 2, cached: 3 }, usageByModel: [opus(1, 2, 3)] }] }),
		);

		expect(result.summary.children?.[0].conversationTokens).toBe(6);
		expect(result.summary.conversationTokens).toBeUndefined();
	});

	it("reports an id with ambiguous ownership and changes nothing", () => {
		const left = node({ commitHash: "1".repeat(40), transcripts: ["t1"], conversationTokens: 10 });
		const right = node({ commitHash: "2".repeat(40), transcripts: ["t1"], conversationTokens: 10 });
		const root = node({ transcripts: ["t1"], children: [left, right] });

		const result = recomputeConversationUsage(
			root,
			evidence({ t1: [{ usage: { input: 1, output: 1, cached: 1 }, usageByModel: [opus(1, 1, 1)] }] }),
		);

		expect(result.changed).toBe(false);
		expect(result.summary).toBe(root);
		expect(result.skipped).toEqual(["t1"]);
	});

	it("keeps a partial per-model split, matching what the write path stores", () => {
		// Only one of the two sessions reported models. `conversationUsageFields` (the
		// write path) stores that partial split and prices it; deriving must agree, or
		// the first press of the recompute button would DELETE a cost the write path had
		// legitimately stored. The under-statement is a property of the evidence, not of
		// this function.
		const summary = node({ transcripts: ["t1"] });

		const result = recomputeConversationUsage(
			summary,
			evidence({
				t1: [
					{ usage: { input: 10, output: 10, cached: 10 }, usageByModel: [opus(10, 10, 10)] },
					{ usage: { input: 5, output: 5, cached: 5 } },
				],
			}),
		);

		expect(result.changed).toBe(true);
		expect(result.summary.conversationTokens).toBe(45);
		expect(result.summary.conversationTokenBreakdown).toEqual({ input: 15, output: 15, cached: 15 });
		expect(result.summary.conversationModels).toEqual([opus(10, 10, 10)]);
		expect(result.summary.estimatedCostUsd).toBeCloseTo(opusCost(10, 10, 10), 12);
	});

	it("is idempotent on a node whose stored figures carry a partial per-model split", () => {
		// The regression the case above protects: a healthy mixed-source memory must not
		// be rewritten (and must not lose its cost) just because one session reported no
		// model.
		const stored = node({
			transcripts: ["t1"],
			conversationTokens: 45,
			conversationTokenBreakdown: { input: 15, output: 15, cached: 15 },
			conversationModels: [opus(10, 10, 10)],
			estimatedCostUsd: opusCost(10, 10, 10),
			pricesAsOf: PRICES_AS_OF,
		});

		const result = recomputeConversationUsage(
			stored,
			evidence({
				t1: [
					{ usage: { input: 10, output: 10, cached: 10 }, usageByModel: [opus(10, 10, 10)] },
					{ usage: { input: 5, output: 5, cached: 5 } },
				],
			}),
		);

		expect(result.changed).toBe(false);
		expect(result.summary).toBe(stored);
	});

	it("treats a stored breakdown with a different key order as unchanged", () => {
		// A stored breakdown is JSON parsed off disk, so its key order is the writer's.
		// Comparing the objects whole would rewrite the node on every pass — one
		// orphan-branch write per button press, against an idempotence contract.
		const reordered = { cached: 33, output: 22, input: 11 };
		const stored = node({
			transcripts: ["t1"],
			conversationTokens: 66,
			conversationTokenBreakdown: reordered,
			conversationModels: [opus(11, 22, 33)],
			estimatedCostUsd: opusCost(11, 22, 33),
			pricesAsOf: PRICES_AS_OF,
		});

		const result = recomputeConversationUsage(
			stored,
			evidence({ t1: [{ usage: { input: 11, output: 22, cached: 33 }, usageByModel: [opus(11, 22, 33)] }] }),
		);

		expect(result.changed).toBe(false);
		expect(result.summary).toBe(stored);
	});

	it("derives a child that only the child itself lists, with no entry in the root index", () => {
		// The malformed-index shape the panel's evidence gathering must cover: the root's
		// authoritative array is empty while a child still claims its transcript. The
		// interest set walks every node, so the child is attributed and derived.
		const child = node({
			commitHash: "b".repeat(40),
			transcripts: ["t1"],
			conversationTokens: 5000,
			conversationTokenBreakdown: { input: 2000, output: 2000, cached: 1000 },
		});
		const root = node({ transcripts: [], children: [child] });

		const result = recomputeConversationUsage(
			root,
			evidence({ t1: [{ usage: { input: 1, output: 2, cached: 3 }, usageByModel: [opus(1, 2, 3)] }] }),
		);

		expect(result.changed).toBe(true);
		expect(result.summary.conversationTokens).toBeUndefined();
		expect(result.summary.children?.[0].conversationTokens).toBe(6);
		expect(result.skipped).toEqual([]);
	});

	it("merges per-model usage across sessions and files owned by the same node", () => {
		const sonnet: ModelTokenUsage = {
			model: "claude-sonnet-5",
			provider: "anthropic",
			input: 4,
			output: 8,
			cached: 0,
		};
		const summary = node({ transcripts: ["t1", "t2"] });

		const result = recomputeConversationUsage(
			summary,
			evidence({
				t1: [{ usage: { input: 10, output: 20, cached: 30 }, usageByModel: [opus(10, 20, 30)] }],
				t2: [{ usage: { input: 14, output: 28, cached: 30 }, usageByModel: [opus(10, 20, 30), sonnet] }],
			}),
		);

		expect(result.summary.conversationModels).toEqual([opus(20, 40, 60), sonnet]);
		expect(result.summary.conversationTokens).toBe(132);
	});

	it("leaves a node with no owned transcript untouched", () => {
		const summary = node({ transcripts: [], conversationTokens: 42 });

		const result = recomputeConversationUsage(summary, new Map());

		expect(result.changed).toBe(false);
		expect(result.summary).toBe(summary);
		expect(result.skipped).toEqual([]);
	});
});
