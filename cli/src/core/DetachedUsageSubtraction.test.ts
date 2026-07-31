import { describe, expect, it } from "vitest";
import type { CommitSummary, ModelTokenUsage, SkillCommitRef } from "../Types.js";
import { CURRENT_SCHEMA_VERSION } from "../Types.js";
import { type DetachedSessionUsage, subtractDetachedUsage } from "./DetachedUsageSubtraction.js";
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

const removed = (
	transcriptId: string,
	sessions: ReadonlyArray<DetachedSessionUsage>,
): Map<string, ReadonlyArray<DetachedSessionUsage>> => new Map([[transcriptId, sessions]]);

describe("subtractDetachedUsage", () => {
	it("is a no-op with an empty removal map", () => {
		const summary = node({ transcripts: ["t1"], conversationTokens: 100 });
		const result = subtractDetachedUsage(summary, new Map());
		expect(result.summary).toBe(summary);
		expect(result.changed).toBe(false);
		expect(result.unattributed).toEqual([]);
	});

	it("subtracts the detached session's share and re-derives cost from the remaining models", () => {
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 1000,
			conversationTokenBreakdown: { input: 100, output: 200, cached: 700 },
			conversationModels: [opus(100, 200, 700)],
			estimatedCostUsd: 9.875,
			pricesAsOf: PRICES_AS_OF,
		});
		const result = subtractDetachedUsage(
			summary,
			removed("t1", [{ usage: { input: 40, output: 50, cached: 200 }, usageByModel: [opus(40, 50, 200)] }]),
		);

		expect(result.changed).toBe(true);
		expect(result.unattributed).toEqual([]);
		expect(result.summary.conversationTokens).toBe(710);
		expect(result.summary.conversationTokenBreakdown).toEqual({ input: 60, output: 150, cached: 500 });
		expect(result.summary.conversationModels).toEqual([opus(60, 150, 500)]);
		// Re-priced from what's left at the Opus 5 rates (5 / 25 / 6.25 per MTok):
		// 60·5e-6 + 150·25e-6 + 500·6.25e-6 = 0.0000003 + 0.00000375 + ...
		const expected = (60 * 5 + 150 * 25 + 500 * 6.25) / 1_000_000;
		expect(result.summary.estimatedCostUsd).toBeCloseTo(expected, 12);
		expect(result.summary.pricesAsOf).toBe(PRICES_AS_OF);
	});

	it("strips the whole usage group rather than storing zeros when nothing is left", () => {
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 300,
			conversationTokenBreakdown: { input: 100, output: 100, cached: 100 },
			conversationModels: [opus(100, 100, 100)],
			estimatedCostUsd: 0.003,
			pricesAsOf: PRICES_AS_OF,
		});
		const result = subtractDetachedUsage(
			summary,
			removed("t1", [{ usage: { input: 100, output: 100, cached: 100 }, usageByModel: [opus(100, 100, 100)] }]),
		);

		expect(result.changed).toBe(true);
		// Absent, not zero: the display contract reads "absent" as "reports no usage",
		// while a stored 0 renders as a real measurement of nothing.
		expect(result.summary).not.toHaveProperty("conversationTokens");
		expect(result.summary).not.toHaveProperty("conversationTokenBreakdown");
		expect(result.summary).not.toHaveProperty("conversationModels");
		expect(result.summary).not.toHaveProperty("estimatedCostUsd");
		expect(result.summary).not.toHaveProperty("pricesAsOf");
		// Everything else survives.
		expect(result.summary.commitMessage).toBe("test commit");
	});

	it("floors at zero when the subtrahend exceeds a pre-dedup-fix inflated total", () => {
		// A memory written before the per-line de-duplication fix carries an inflated
		// aggregate, while the detached session's recorded usage is not inflated in the
		// same proportion — so the subtraction can overshoot. It must not go negative.
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 50,
			conversationTokenBreakdown: { input: 10, output: 10, cached: 30 },
			conversationModels: [opus(10, 10, 30)],
		});
		const result = subtractDetachedUsage(
			summary,
			removed("t1", [{ usage: { input: 999, output: 999, cached: 999 } }]),
		);
		expect(result.changed).toBe(true);
		expect(result.summary.conversationTokens).toBeUndefined();
	});

	it("subtracts from the child that owns the transcript, not the amend root", () => {
		// Root and child carry their own token fields and SummaryTree aggregates both, so
		// a detach must land on the node that actually counted the tokens. Disjoint id
		// lists here; the next test covers the real amend shape, where the root re-lists
		// the child's id.
		const child = node({
			commitHash: "b".repeat(40),
			transcripts: ["t-child"],
			conversationTokens: 500,
			conversationTokenBreakdown: { input: 50, output: 50, cached: 400 },
			conversationModels: [opus(50, 50, 400)],
		});
		const summary = node({
			transcripts: ["t-root"],
			conversationTokens: 100,
			conversationTokenBreakdown: { input: 10, output: 10, cached: 80 },
			conversationModels: [opus(10, 10, 80)],
			children: [child],
		});

		const result = subtractDetachedUsage(
			summary,
			removed("t-child", [{ usage: { input: 20, output: 20, cached: 100 }, usageByModel: [opus(20, 20, 100)] }]),
		);

		expect(result.changed).toBe(true);
		// Root untouched.
		expect(result.summary.conversationTokens).toBe(100);
		expect(result.summary.conversationTokenBreakdown).toEqual({ input: 10, output: 10, cached: 80 });
		// Child corrected.
		expect(result.summary.children?.[0].conversationTokens).toBe(360);
		expect(result.summary.children?.[0].conversationTokenBreakdown).toEqual({
			input: 30,
			output: 30,
			cached: 300,
		});
	});

	it("subtracts ONCE on a real amend root, which re-lists its child's transcript id", () => {
		// The shape production actually writes (QueueWorker `amendTranscripts` =
		// `[...inheritedAmendIds, deltaId]`, buildHoistedAmendRoot `children:
		// [oldSummary]`): the root's `transcripts` array is the tree-wide authoritative
		// INDEX — every id `getTranscriptIds` must find — while its token fields cover
		// the DELTA only. The child keeps both its own id and its own tokens.
		//
		// Matching an id against every node that lists it therefore hits root AND child
		// for one detach: the child's correction is right, the root's is a subtraction of
		// tokens it never carried. Floored at 0, that wiped the root's whole delta and the
		// tree total (root + child, per SummaryTree.aggregateConversationTokens) came out
		// short by it.
		const child = node({
			commitHash: "b".repeat(40),
			transcripts: ["t-child"],
			conversationTokens: 500,
			conversationTokenBreakdown: { input: 50, output: 50, cached: 400 },
			conversationModels: [opus(50, 50, 400)],
		});
		const summary = node({
			transcripts: ["t-child", "t-root-delta"],
			conversationTokens: 100,
			conversationTokenBreakdown: { input: 10, output: 10, cached: 80 },
			conversationModels: [opus(10, 10, 80)],
			children: [child],
		});

		const result = subtractDetachedUsage(
			summary,
			removed("t-child", [{ usage: { input: 20, output: 20, cached: 100 }, usageByModel: [opus(20, 20, 100)] }]),
		);

		expect(result.changed).toBe(true);
		expect(result.unattributed).toEqual([]);
		// Root's delta figures survive intact — it re-lists the id but does not own it.
		expect(result.summary.conversationTokens).toBe(100);
		expect(result.summary.conversationTokenBreakdown).toEqual({ input: 10, output: 10, cached: 80 });
		expect(result.summary.conversationModels).toEqual([opus(10, 10, 80)]);
		// Child corrected exactly once.
		expect(result.summary.children?.[0].conversationTokens).toBe(360);
		expect(result.summary.children?.[0].conversationTokenBreakdown).toEqual({
			input: 30,
			output: 30,
			cached: 300,
		});
	});

	it("subtracts at the DEEPEST owner down an amend chain that re-lists the id twice", () => {
		// Amend-of-an-amend: each root inherits the ids below it, so the grandchild's id
		// appears on all three nodes. Only the grandchild's token fields cover it.
		const grandchild = node({
			commitHash: "c".repeat(40),
			transcripts: ["t-g"],
			conversationTokens: 300,
			conversationTokenBreakdown: { input: 100, output: 100, cached: 100 },
		});
		const child = node({
			commitHash: "b".repeat(40),
			transcripts: ["t-g", "t-child-delta"],
			conversationTokens: 200,
			conversationTokenBreakdown: { input: 100, output: 50, cached: 50 },
			children: [grandchild],
		});
		const summary = node({
			transcripts: ["t-g", "t-child-delta", "t-root-delta"],
			conversationTokens: 100,
			conversationTokenBreakdown: { input: 50, output: 25, cached: 25 },
			children: [child],
		});

		const result = subtractDetachedUsage(summary, removed("t-g", [{ usage: { input: 40, output: 0, cached: 0 } }]));

		expect(result.summary.conversationTokens).toBe(100);
		expect(result.summary.children?.[0].conversationTokens).toBe(200);
		expect(result.summary.children?.[0].children?.[0].conversationTokens).toBe(260);
	});

	it("reports an id two siblings both claim rather than subtracting it from both", () => {
		// Ambiguous ownership: `mergeManyToOne` dedups ids at the squash root but cannot
		// stop two source commits from carrying the same id (its own comment allows for
		// legacy migrated-from-v3 hashes colliding). Neither sibling is a descendant of
		// the other, so there is no deepest owner — and subtracting from both is the very
		// double-count this module must not produce. Same treatment as an id no node
		// claims: correct nothing, report it.
		const a = node({ commitHash: "b".repeat(40), transcripts: ["t-dup"], conversationTokens: 100 });
		const b = node({ commitHash: "c".repeat(40), transcripts: ["t-dup"], conversationTokens: 100 });
		const summary = node({ transcripts: ["t-dup"], children: [a, b] });

		const result = subtractDetachedUsage(
			summary,
			removed("t-dup", [{ usage: { input: 10, output: 0, cached: 0 } }]),
		);

		expect(result.changed).toBe(false);
		expect(result.summary).toBe(summary);
		expect(result.unattributed).toEqual(["t-dup"]);
	});

	it("keeps untouched subtrees by reference so callers can compare identity", () => {
		const untouched = node({ commitHash: "c".repeat(40), transcripts: ["t-other"], conversationTokens: 7 });
		const target = node({
			commitHash: "d".repeat(40),
			transcripts: ["t-target"],
			conversationTokens: 100,
			conversationTokenBreakdown: { input: 100, output: 0, cached: 0 },
		});
		const summary = node({ transcripts: ["t-root"], children: [untouched, target] });

		const result = subtractDetachedUsage(
			summary,
			removed("t-target", [{ usage: { input: 40, output: 0, cached: 0 } }]),
		);
		expect(result.summary.children?.[0]).toBe(untouched);
		expect(result.summary.children?.[1]).not.toBe(target);
		expect(result.summary.children?.[1].conversationTokens).toBe(60);
	});

	it("reports a session with no recorded usage as unattributed and changes nothing", () => {
		// Forward-only: memories written before StoredSession.usage existed have no
		// subtrahend, so their totals must be left alone rather than guessed at.
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 1000,
			conversationTokenBreakdown: { input: 100, output: 200, cached: 700 },
		});
		const result = subtractDetachedUsage(summary, removed("t1", [{}]));

		expect(result.changed).toBe(false);
		expect(result.summary).toBe(summary);
		expect(result.unattributed).toEqual(["t1"]);
	});

	it("reports a PARTIALLY attributable transcript even though it also corrects the total", () => {
		// Two sessions removed from one transcript, only one with recorded usage. The
		// subtraction can account for 100 of the 1000 but not the other session's share,
		// so the remaining figure is short. Reporting only the all-missing case would
		// leave this silently wrong — the caller logs nothing and the bar looks settled.
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 1000,
			conversationTokenBreakdown: { input: 100, output: 200, cached: 700 },
		});
		const result = subtractDetachedUsage(
			summary,
			removed("t1", [{ usage: { input: 100, output: 0, cached: 0 } }, {}]),
		);

		expect(result.changed).toBe(true);
		expect(result.summary.conversationTokens).toBe(900);
		expect(result.unattributed).toEqual(["t1"]);
	});

	it("reports a transcript id no node claims as unattributed", () => {
		const summary = node({ transcripts: ["t1"], conversationTokens: 100 });
		const result = subtractDetachedUsage(
			summary,
			removed("t-unknown", [{ usage: { input: 5, output: 0, cached: 0 } }]),
		);

		expect(result.changed).toBe(false);
		expect(result.unattributed).toEqual(["t-unknown"]);
	});

	it("leaves a pre-v5 node (no transcripts array) untouched and reports it", () => {
		const summary = node({
			conversationTokens: 1000,
			conversationTokenBreakdown: { input: 1000, output: 0, cached: 0 },
		});
		const result = subtractDetachedUsage(summary, removed("t1", [{ usage: { input: 400, output: 0, cached: 0 } }]));

		expect(result.changed).toBe(false);
		expect(result.summary.conversationTokens).toBe(1000);
		expect(result.unattributed).toEqual(["t1"]);
	});

	it("sums several detached sessions removed from the same transcript", () => {
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 1000,
			conversationTokenBreakdown: { input: 300, output: 300, cached: 400 },
			conversationModels: [opus(300, 300, 400)],
		});
		const result = subtractDetachedUsage(
			summary,
			removed("t1", [
				{ usage: { input: 100, output: 100, cached: 100 }, usageByModel: [opus(100, 100, 100)] },
				{ usage: { input: 50, output: 50, cached: 50 }, usageByModel: [opus(50, 50, 50)] },
			]),
		);
		expect(result.summary.conversationTokens).toBe(550);
		expect(result.summary.conversationTokenBreakdown).toEqual({ input: 150, output: 150, cached: 250 });
	});

	it("drops a model whose tokens are fully detached while keeping the others", () => {
		const haiku: ModelTokenUsage = {
			model: "claude-haiku-4-5",
			provider: "anthropic",
			input: 100,
			output: 100,
			cached: 0,
		};
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 600,
			conversationTokenBreakdown: { input: 200, output: 200, cached: 200 },
			conversationModels: [opus(100, 100, 200), haiku],
		});
		const result = subtractDetachedUsage(
			summary,
			removed("t1", [{ usage: { input: 100, output: 100, cached: 0 }, usageByModel: [haiku] }]),
		);
		expect(result.summary.conversationModels).toEqual([opus(100, 100, 200)]);
	});

	it("subtracts from the scalar on a node that has tokens but no breakdown", () => {
		// Older memories recorded `conversationTokens` without the per-segment split.
		// Treating the missing breakdown as zeros would compute 0 remaining and wipe
		// usage the memory still legitimately has — here 1000 - 290 must leave 710,
		// rendered as the meter's total-only single segment.
		const summary = node({ transcripts: ["t1"], conversationTokens: 1000 });
		const result = subtractDetachedUsage(
			summary,
			removed("t1", [{ usage: { input: 40, output: 50, cached: 200 } }]),
		);

		expect(result.changed).toBe(true);
		expect(result.summary.conversationTokens).toBe(710);
		expect(result.summary.conversationTokenBreakdown).toBeUndefined();
	});

	it("keeps a scalar-only node's per-model split and re-derives its cost", () => {
		// `conversationModels` / `estimatedCostUsd` are independent of the breakdown, so a
		// node can carry a cost without one. The strip-then-restore had only restored them
		// on the breakdown path, silently deleting a cost the surviving models still earn.
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 1000,
			conversationModels: [opus(400, 300, 300)],
			estimatedCostUsd: 12.5,
			pricesAsOf: "2026-01-01",
		});
		const result = subtractDetachedUsage(
			summary,
			removed("t1", [{ usage: { input: 100, output: 0, cached: 0 }, usageByModel: [opus(100, 0, 0)] }]),
		);

		expect(result.summary.conversationTokens).toBe(900);
		expect(result.summary.conversationTokenBreakdown).toBeUndefined();
		expect(result.summary.conversationModels).toEqual([opus(300, 300, 300)]);
		// Re-derived from the remaining models, not carried over: opus-5 at $5/$25/$6.25
		// per MTok → 300 * (5 + 25 + 6.25) / 1e6.
		expect(result.summary.estimatedCostUsd).toBeCloseTo(0.010875, 9);
		expect(result.summary.pricesAsOf).toBe(PRICES_AS_OF);
	});

	it("strips a scalar-only node's usage when the detached share covers all of it", () => {
		const summary = node({ transcripts: ["t1"], conversationTokens: 100 });
		const result = subtractDetachedUsage(
			summary,
			removed("t1", [{ usage: { input: 100, output: 50, cached: 0 } }]),
		);
		expect(result.summary).not.toHaveProperty("conversationTokens");
	});

	it("treats an explicitly empty children array like a leaf", () => {
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 100,
			conversationTokenBreakdown: { input: 100, output: 0, cached: 0 },
			children: [],
		});
		const result = subtractDetachedUsage(summary, removed("t1", [{ usage: { input: 30, output: 0, cached: 0 } }]));
		expect(result.summary.conversationTokens).toBe(70);
		expect(result.summary.children).toEqual([]);
	});

	it("leaves a node that carries no token fields alone", () => {
		// Squash containers hold children but no usage of their own.
		const summary = node({ transcripts: ["t1"] });
		const result = subtractDetachedUsage(
			summary,
			removed("t1", [{ usage: { input: 10, output: 10, cached: 10 } }]),
		);
		expect(result.changed).toBe(false);
		expect(result.summary).toBe(summary);
	});

	it("omits cost when every remaining model is unpriced", () => {
		const unpriced: ModelTokenUsage = {
			model: "some-future-model",
			provider: "unknown",
			input: 100,
			output: 0,
			cached: 0,
		};
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 200,
			conversationTokenBreakdown: { input: 200, output: 0, cached: 0 },
			conversationModels: [unpriced],
			estimatedCostUsd: 1,
			pricesAsOf: PRICES_AS_OF,
		});
		const result = subtractDetachedUsage(summary, removed("t1", [{ usage: { input: 50, output: 0, cached: 0 } }]));
		expect(result.summary.conversationTokens).toBe(150);
		// Unpriced usage keeps its models but carries no cost, so the reader shows
		// "unknown" instead of a misleading $0.00.
		expect(result.summary.estimatedCostUsd).toBeUndefined();
		expect(result.summary.pricesAsOf).toBeUndefined();
	});
});

// ─── Skill usage subtraction ─────────────────────────────────────────────────

describe("subtractDetachedUsage — skill figures", () => {
	const skill = (over: Partial<SkillCommitRef> = {}): SkillCommitRef => ({
		archivedKey: "claude:superpowers:brainstorming-abc12345",
		source: "claude",
		skill: "superpowers:brainstorming",
		entryPaths: ["tool"],
		invocationCount: 2,
		firstUsedAt: "2026-07-29T00:00:00.000Z",
		lastUsedAt: "2026-07-29T01:00:00.000Z",
		usage: { input: 30, cached: 300, output: 3000, confidence: "attributed" },
		usageBySession: {
			"claude:sessA": { input: 10, cached: 100, output: 1000, confidence: "attributed" },
			"claude:sessB": { input: 20, cached: 200, output: 2000, confidence: "attributed" },
		},
		...over,
	});

	/** A detached session carrying both its commit-level share and its identity. */
	const detached = (sessionKey: string, usage?: { input: number; output: number; cached: number }) => [
		{ ...(usage !== undefined ? { usage } : {}), sessionKey },
	];

	it("removes only the detached session's share and re-totals", () => {
		const summary = node({
			transcripts: ["t1"],
			conversationTokens: 3330,
			conversationTokenBreakdown: { input: 30, output: 3000, cached: 300 },
			skills: [skill()],
		});
		const result = subtractDetachedUsage(
			summary,
			removed("t1", detached("claude:sessA", { input: 10, output: 1000, cached: 100 })),
		);

		const [remaining] = result.summary.skills ?? [];
		expect(remaining.usageBySession).toEqual({
			"claude:sessB": { input: 20, cached: 200, output: 2000, confidence: "attributed" },
		});
		expect(remaining.usage).toEqual({ input: 20, cached: 200, output: 2000, confidence: "attributed" });
	});

	it("is idempotent, unlike the aggregate figures", () => {
		// A skill's split is an explicit per-session map, so removing a key twice lands
		// on the same result. The scalar conversation total is not — which is why that
		// one needs single-owner resolution and this does not.
		const summary = node({ transcripts: ["t1"], conversationTokens: 3330, skills: [skill()] });
		const once = subtractDetachedUsage(
			summary,
			removed("t1", detached("claude:sessA", { input: 10, output: 1000, cached: 100 })),
		);
		const twice = subtractDetachedUsage(
			once.summary,
			removed("t1", detached("claude:sessA", { input: 10, output: 1000, cached: 100 })),
		);
		expect(twice.summary.skills?.[0].usage).toEqual(once.summary.skills?.[0].usage);
	});

	it("keeps the skill row when its last session is detached, but drops the figure", () => {
		// The skill DID run — the invocations recorded it. What is gone is the evidence
		// of what it cost, and an absent usage says exactly that. A zero would claim
		// the skill was free, and deleting the row would claim it never ran.
		const summary = node({
			transcripts: ["t1"],
			skills: [
				skill({
					usage: { input: 10, cached: 100, output: 1000, confidence: "attributed" },
					usageBySession: {
						"claude:sessA": { input: 10, cached: 100, output: 1000, confidence: "attributed" },
					},
				}),
			],
		});
		const result = subtractDetachedUsage(
			summary,
			removed("t1", detached("claude:sessA", { input: 10, output: 1000, cached: 100 })),
		);
		const [remaining] = result.summary.skills ?? [];
		expect(remaining.skill).toBe("superpowers:brainstorming");
		expect(remaining.invocationCount).toBe(2);
		expect(remaining.usage).toBeUndefined();
		expect(remaining.usageBySession).toBeUndefined();
	});

	it("leaves a skill alone when the detached session never contributed to it", () => {
		const summary = node({ transcripts: ["t1"], skills: [skill()] });
		const result = subtractDetachedUsage(
			summary,
			removed("t1", detached("claude:sessZ", { input: 1, output: 1, cached: 1 })),
		);
		expect(result.summary.skills?.[0]).toEqual(skill());
	});

	it("leaves a pre-split skill row untouched", () => {
		// Forward-only, matching how the aggregate path treats a memory written before
		// per-session usage existed: there is nothing to subtract, so nothing is
		// invented. Zeroing it would replace a known-stale number with a wrong one.
		const legacy = skill({ usageBySession: undefined });
		const summary = node({ transcripts: ["t1"], skills: [legacy] });
		const result = subtractDetachedUsage(
			summary,
			removed("t1", detached("claude:sessA", { input: 10, output: 1000, cached: 100 })),
		);
		expect(result.summary.skills?.[0]).toEqual(legacy);
	});

	it("corrects every node that recorded the session, not just the owner", () => {
		// Amend hoists a child's skills onto the root, so the same session's
		// contribution is recorded in both places. Both must be corrected — and can be,
		// because removing a map key cannot double-subtract.
		const child = node({ commitHash: "b".repeat(40), transcripts: ["t1"], skills: [skill()] });
		const summary = node({ transcripts: ["t1"], children: [child], skills: [skill()] });
		const result = subtractDetachedUsage(
			summary,
			removed("t1", detached("claude:sessA", { input: 10, output: 1000, cached: 100 })),
		);

		expect(result.summary.skills?.[0].usage?.output).toBe(2000);
		expect(result.summary.children?.[0].skills?.[0].usage?.output).toBe(2000);
	});

	it("recomputes confidence from the sessions that remain", () => {
		// Dropping the estimated session leaves a total that IS fully attributed, so it
		// should stop being labelled an estimate.
		const summary = node({
			transcripts: ["t1"],
			skills: [
				skill({
					usage: { input: 30, cached: 300, output: 3000, confidence: "estimated" },
					usageBySession: {
						"claude:sessA": { input: 10, cached: 100, output: 1000, confidence: "estimated" },
						"claude:sessB": { input: 20, cached: 200, output: 2000, confidence: "attributed" },
					},
				}),
			],
		});
		const result = subtractDetachedUsage(
			summary,
			removed("t1", detached("claude:sessA", { input: 10, output: 1000, cached: 100 })),
		);
		expect(result.summary.skills?.[0].usage?.confidence).toBe("attributed");
	});

	it("reports changed when only skill figures moved", () => {
		// A memory can carry skill usage without any aggregate figure to correct; the
		// caller still has to persist the summary.
		const summary = node({ transcripts: ["t1"], skills: [skill()] });
		const result = subtractDetachedUsage(
			summary,
			removed("t1", detached("claude:sessA", { input: 10, output: 1000, cached: 100 })),
		);
		expect(result.changed).toBe(true);
	});

	it("does nothing to skills when the detached session carries no identity", () => {
		// A detach recorded before session keys existed cannot be matched to a split.
		const summary = node({ transcripts: ["t1"], skills: [skill()] });
		const result = subtractDetachedUsage(
			summary,
			removed("t1", [{ usage: { input: 10, output: 1000, cached: 100 } }]),
		);
		expect(result.summary.skills?.[0]).toEqual(skill());
	});
});
