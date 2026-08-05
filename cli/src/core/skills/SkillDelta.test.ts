import { describe, expect, it } from "vitest";
import type { SkillCommitRef, SkillEntry, SkillUsage } from "../../Types.js";
import { archivedTotalsOf, isLegacyArchived, mergeSkillRef, mergeSkillRefs, uncommittedDelta } from "./SkillDelta.js";

const usage = (input: number, cached: number, output: number, confidence: SkillUsage["confidence"]): SkillUsage => ({
	input,
	cached,
	output,
	confidence,
});

const entry = (over: Partial<SkillEntry> = {}): SkillEntry => ({
	source: "claude",
	skill: "superpowers:brainstorming",
	entryPaths: ["tool"],
	invocations: [],
	invocationCount: 3,
	firstUsedAt: "2026-07-30T06:00:00.000Z",
	lastUsedAt: "2026-07-30T07:00:00.000Z",
	sourcePath: "/tmp/x.md",
	commitHash: null,
	...over,
});

describe("uncommittedDelta", () => {
	it("reports the whole history for a row that was never archived", () => {
		expect(uncommittedDelta(entry({ usage: usage(5, 10, 2, "attributed") }))).toEqual({
			invocationCount: 3,
			usage: usage(5, 10, 2, "attributed"),
		});
	});

	it("reports nothing when the counters have not moved past the baseline", () => {
		const row = entry({ archivedTotals: { invocationCount: 3 } });
		expect(uncommittedDelta(row)).toBeUndefined();
	});

	it("subtracts the baseline from a plain total", () => {
		const row = entry({
			invocationCount: 5,
			usage: usage(9, 30, 8, "attributed"),
			archivedTotals: { invocationCount: 3, usage: usage(4, 10, 3, "attributed") },
		});
		expect(uncommittedDelta(row)).toEqual({ invocationCount: 2, usage: usage(5, 20, 5, "attributed") });
	});

	it("keeps the invocation count when a revised-down total leaves no new spend", () => {
		// Attribution recomputes a session from line 0 each pass, so a figure can shrink.
		// The skill did run again — dropping the count would deny that; a negative or
		// zero usage figure would claim the extra run was free.
		const row = entry({
			invocationCount: 4,
			usage: usage(2, 5, 1, "estimated"),
			archivedTotals: { invocationCount: 3, usage: usage(9, 30, 8, "attributed") },
		});
		expect(uncommittedDelta(row)).toEqual({ invocationCount: 1 });
	});

	it("reports only the sessions that ran since the baseline", () => {
		const row = entry({
			invocationCount: 5,
			usage: usage(9, 30, 8, "attributed"),
			usageBySession: {
				"claude:sess-a": usage(4, 10, 3, "attributed"),
				"claude:sess-b": usage(5, 20, 5, "attributed"),
			},
			archivedTotals: {
				invocationCount: 3,
				usageBySession: { "claude:sess-a": usage(4, 10, 3, "attributed") },
			},
		});
		expect(uncommittedDelta(row)).toEqual({
			invocationCount: 2,
			usage: usage(5, 20, 5, "attributed"),
			usageBySession: { "claude:sess-b": usage(5, 20, 5, "attributed") },
		});
	});

	it("subtracts within a session that spans two commits", () => {
		const row = entry({
			invocationCount: 5,
			usageBySession: { "claude:sess-a": usage(10, 40, 9, "attributed") },
			archivedTotals: {
				invocationCount: 3,
				usageBySession: { "claude:sess-a": usage(4, 10, 3, "attributed") },
			},
		});
		expect(uncommittedDelta(row)).toEqual({
			invocationCount: 2,
			usage: usage(6, 30, 6, "attributed"),
			usageBySession: { "claude:sess-a": usage(6, 30, 6, "attributed") },
		});
	});

	it("degrades the re-derived total to estimated when any surviving session was a guess", () => {
		const row = entry({
			invocationCount: 5,
			usageBySession: {
				"claude:sess-a": usage(4, 10, 3, "attributed"),
				"claude:sess-b": usage(5, 20, 5, "estimated"),
			},
			archivedTotals: { invocationCount: 3 },
		});
		expect(uncommittedDelta(row)?.usage?.confidence).toBe("estimated");
	});

	it("keeps the count with no figure when every session was already archived in full", () => {
		// "It ran, we cannot say what it cost" — the same shape a fully-detached row
		// degrades to. A zero would claim the run was free.
		const row = entry({
			invocationCount: 4,
			usageBySession: { "claude:sess-a": usage(4, 10, 3, "attributed") },
			archivedTotals: {
				invocationCount: 3,
				usageBySession: { "claude:sess-a": usage(4, 10, 3, "attributed") },
			},
		});
		expect(uncommittedDelta(row)).toEqual({ invocationCount: 1 });
	});

	it("carries the count alone for a row that records no usage at all", () => {
		expect(uncommittedDelta(entry())).toEqual({ invocationCount: 3 });
	});

	it("treats a row guarded before the baseline existed as fully accounted for", () => {
		// Otherwise the first commit after an upgrade republishes a whole history.
		const row = entry({ commitHash: "abc12345", contentHashAtCommit: "deadbeef" });
		expect(uncommittedDelta(row)).toBeUndefined();
	});

	it("treats a half-written guard as archived rather than fresh", () => {
		expect(uncommittedDelta(entry({ contentHashAtCommit: "deadbeef" }))).toBeUndefined();
	});

	it("prefers a real baseline over the legacy guard reading", () => {
		// Once a baseline exists the guard is no longer evidence of anything — this is
		// the row that used to be frozen out of every later commit.
		const row = entry({
			invocationCount: 5,
			commitHash: "abc12345",
			contentHashAtCommit: "deadbeef",
			archivedTotals: { invocationCount: 3 },
		});
		expect(uncommittedDelta(row)).toEqual({ invocationCount: 2 });
	});
});

describe("archivedTotalsOf", () => {
	it("omits absent usage rather than writing zeros", () => {
		expect(archivedTotalsOf(entry())).toEqual({ invocationCount: 3 });
	});

	it("snapshots the total and the split together", () => {
		const row = entry({
			usage: usage(9, 30, 8, "attributed"),
			usageBySession: { "claude:sess-a": usage(9, 30, 8, "attributed") },
		});
		expect(archivedTotalsOf(row)).toEqual({
			invocationCount: 3,
			usage: usage(9, 30, 8, "attributed"),
			usageBySession: { "claude:sess-a": usage(9, 30, 8, "attributed") },
		});
	});
});

describe("isLegacyArchived", () => {
	it("is false for a row that was never archived", () => {
		expect(isLegacyArchived(entry())).toBe(false);
	});

	it("is true on either guard field alone", () => {
		expect(isLegacyArchived(entry({ commitHash: "abc12345" }))).toBe(true);
		expect(isLegacyArchived(entry({ contentHashAtCommit: "deadbeef" }))).toBe(true);
	});
});

describe("mergeSkillRefs", () => {
	// archivedKey is DERIVED, mirroring production: it is `<source>:<skill>-<shortHash>`,
	// so two refs can share it only when they are the same skill archived by the same
	// commit. A fixture that pinned it while varying source/skill described data the
	// archiver cannot produce, and hid the dedupe behaviour under test.
	const ref = (over: Partial<SkillCommitRef> & { hash?: string } = {}): SkillCommitRef => {
		const { hash = "424f5413", ...rest } = over;
		const source = rest.source ?? "claude";
		const skill = rest.skill ?? "superpowers:brainstorming";
		return {
			archivedKey: `${source}:${skill}-${hash}`,
			source,
			skill,
			entryPaths: ["tool"],
			invocationCount: 1,
			firstUsedAt: "2026-07-30T06:00:00.000Z",
			lastUsedAt: "2026-07-30T07:00:00.000Z",
			...rest,
		};
	};

	it("sums each commit's increment rather than keeping one of them", () => {
		// Every ref is one commit's delta, so a squash of three commits that each
		// entered the skill once has to report three entries.
		const merged = mergeSkillRefs([
			ref({ invocationCount: 1, usage: usage(1, 10, 2, "attributed") }),
			ref({
				archivedKey: "claude:superpowers:brainstorming-700be509",
				invocationCount: 2,
				usage: usage(3, 20, 4, "attributed"),
			}),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0].invocationCount).toBe(3);
		expect(merged[0].usage).toEqual(usage(4, 30, 6, "attributed"));
	});

	// Regression: the merge spread `...prev`, so a published article id present only
	// on the LATER ref was dropped. The next push then CREATEd a duplicate article
	// instead of updating the existing one.
	it("inherits a published article id the earlier ref lacks", () => {
		const merged = mergeSkillRefs([
			ref({ invocationCount: 1 }),
			ref({
				archivedKey: "claude:superpowers:brainstorming-700be509",
				invocationCount: 1,
				jolliDocId: 77,
				jolliDocUrl: "https://acme.jolli.ai/articles?doc=77",
			}),
		]);
		// The URL must travel WITH the id: the reuse gate reads its origin to decide
		// which backend the id belongs to.
		expect(merged[0]).toMatchObject({
			jolliDocId: 77,
			jolliDocUrl: "https://acme.jolli.ai/articles?doc=77",
		});
	});

	it("never overwrites an article id the earlier ref already has", () => {
		// Overwriting would push the merged content to the later ref's article and
		// orphan (leak) the one already recorded — the same rule plan inheritance follows.
		const merged = mergeSkillRefs([
			ref({ invocationCount: 1, jolliDocId: 11, jolliDocUrl: "https://acme.jolli.ai/articles?doc=11" }),
			ref({
				archivedKey: "claude:superpowers:brainstorming-700be509",
				invocationCount: 1,
				jolliDocId: 77,
				jolliDocUrl: "https://acme.jolli.ai/articles?doc=77",
			}),
		]);
		expect(merged[0].jolliDocId).toBe(11);
		expect(merged[0].jolliDocUrl).toBe("https://acme.jolli.ai/articles?doc=11");
	});

	// A skill article is one document per (skill, COMMIT), so the id the rule above
	// declines to adopt belongs to a REAL published article that this fold has just
	// made unreachable. Forgetting it leaves it on the Space forever, titled with a
	// hash8 the branch no longer has. Under the previous cross-commit baseKey only one
	// ref per skill was ever pushed, so the situation could not arise.
	it("banks the article id it declined to adopt, for cleanup", () => {
		const merged = mergeSkillRefs([
			ref({ invocationCount: 1, jolliDocId: 11, jolliDocUrl: "https://acme.jolli.ai/articles?doc=11" }),
			ref({
				archivedKey: "claude:superpowers:brainstorming-700be509",
				invocationCount: 1,
				jolliDocId: 77,
				jolliDocUrl: "https://acme.jolli.ai/articles?doc=77",
			}),
		]);
		expect(merged[0].supersededDocIds).toEqual([77]);
	});

	it("never banks the id the merged ref still points at", () => {
		// Would delete the live article. Reachable when the same ref is met from both
		// ends of a squash tree with an id already on it.
		const withId = ref({
			invocationCount: 1,
			jolliDocId: 11,
			jolliDocUrl: "https://acme.jolli.ai/articles?doc=11",
		});
		const merged = mergeSkillRef(withId, ref({ ...withId, hash: "700be509" }));
		expect(merged.jolliDocId).toBe(11);
		expect(merged.supersededDocIds).toBeUndefined();
	});

	it("carries an inner fold's banked ids up through an outer fold", () => {
		// Skills are folded at three levels on the way to a squash root
		// (collectChildSkills → QueueWorker's extraSkills pre-merge → buildSquashSummary),
		// so a fold that reported drops as a RETURN value would lose the inner ones.
		const inner = mergeSkillRef(
			ref({ invocationCount: 1, jolliDocId: 11, jolliDocUrl: "https://acme.jolli.ai/articles?doc=11" }),
			ref({ hash: "700be509", invocationCount: 1, jolliDocId: 77 }),
		);
		const outer = mergeSkillRef(inner, ref({ hash: "8f2c1a04", invocationCount: 1, jolliDocId: 88 }));
		expect(outer.supersededDocIds).toEqual([77, 88]);
	});

	it("drops a banked id that a later fold adopts as the survivor", () => {
		// `prev` has no id, so `next`'s is ADOPTED — and an id the incoming ref had
		// already banked must not then delete the article the merge just adopted.
		const banked = { ...ref({ hash: "700be509", invocationCount: 1, jolliDocId: 77 }), supersededDocIds: [77] };
		const merged = mergeSkillRef(ref({ invocationCount: 1 }), banked);
		expect(merged.jolliDocId).toBe(77);
		expect(merged.supersededDocIds).toBeUndefined();
	});

	it("leaves the field off entirely when nothing was superseded", () => {
		// No churn in stored JSON for the overwhelmingly common case.
		const merged = mergeSkillRefs([
			ref({ invocationCount: 1 }),
			ref({ archivedKey: "claude:superpowers:brainstorming-700be509", invocationCount: 1 }),
		]);
		expect(merged[0]).not.toHaveProperty("supersededDocIds");
	});

	it("counts one archived record once even when it is reached twice", () => {
		// A squash root carries its child's hoisted refs AND keeps the child in the
		// tree, so a recursive walk meets the same archivedKey twice. Accumulating that
		// inflated the count on every squash generation. archivedKey is unique per
		// (skill, archiving commit), so seeing it twice means one record seen twice.
		const merged = mergeSkillRefs([
			ref({ hash: "424f5413", invocationCount: 1 }),
			ref({ hash: "424f5413", invocationCount: 1 }),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0].invocationCount).toBe(1);
	});

	it("dedupes the repeat but still accumulates a genuinely different commit's increment", () => {
		const merged = mergeSkillRefs([
			ref({ hash: "424f5413", invocationCount: 1 }),
			ref({ hash: "424f5413", invocationCount: 1 }),
			ref({ hash: "796c6156", invocationCount: 2 }),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0].invocationCount).toBe(3);
	});

	it("keeps the earliest contributing commit's archivedKey so the pointer addresses a stored file", () => {
		const merged = mergeSkillRefs([ref({ hash: "424f5413" }), ref({ hash: "700be509" })]);
		expect(merged[0].archivedKey).toBe("claude:superpowers:brainstorming-424f5413");
	});

	it("keeps different skills apart, and different hosts apart within one skill id", () => {
		const merged = mergeSkillRefs([
			ref({ skill: "superpowers:brainstorming" }),
			ref({ skill: "j:specs-pr-review" }),
			ref({ source: "opencode", skill: "superpowers:brainstorming" }),
		]);
		expect(merged).toHaveLength(3);
	});

	it("degrades the total to estimated when any contributor was a guess", () => {
		const merged = mergeSkillRefs([
			ref({ hash: "424f5413", usage: usage(1, 10, 2, "attributed") }),
			ref({ hash: "700be509", usage: usage(1, 10, 2, "estimated") }),
		]);
		expect(merged[0].usage?.confidence).toBe("estimated");
	});

	it("degrades detection to heuristic when any contributor was inferred", () => {
		const merged = mergeSkillRefs([ref({ hash: "424f5413" }), ref({ hash: "700be509", detection: "heuristic" })]);
		expect(merged[0].detection).toBe("heuristic");
	});

	it("carries a lone usage figure through when the other side has none", () => {
		const merged = mergeSkillRefs([
			ref({ hash: "424f5413" }),
			ref({ hash: "700be509", usage: usage(1, 10, 2, "attributed") }),
		]);
		expect(merged[0].usage).toEqual(usage(1, 10, 2, "attributed"));
	});

	it("merges the per-session split alongside the total so detach can still correct it", () => {
		// Regression: the merge summed `usage` but kept only the FIRST ref's
		// `usageBySession`. subtractSkillUsage re-derives `usage` from the surviving
		// split rather than subtracting from the total, so detaching any one session
		// from such a root discarded the whole contribution of every ref whose split
		// had been dropped — an under-report, not merely a stale figure.
		const merged = mergeSkillRefs([
			ref({
				hash: "424f5413",
				usage: usage(1, 10, 2, "attributed"),
				usageBySession: { "claude:sess-a": usage(1, 10, 2, "attributed") },
			}),
			ref({
				hash: "700be509",
				usage: usage(3, 20, 4, "attributed"),
				usageBySession: { "claude:sess-b": usage(3, 20, 4, "attributed") },
			}),
		]);
		expect(merged[0].usageBySession).toEqual({
			"claude:sess-a": usage(1, 10, 2, "attributed"),
			"claude:sess-b": usage(3, 20, 4, "attributed"),
		});
		// The split must remain a faithful decomposition of the total.
		expect(merged[0].usage).toEqual(usage(4, 30, 6, "attributed"));
	});

	it("sums a session that contributed to two commits rather than letting one overwrite it", () => {
		// One conversation spanning two commits is archived into both, each ref holding
		// that session's share of its own commit. The same key in both is therefore two
		// real increments — overwriting would silently drop the earlier commit's share.
		const merged = mergeSkillRefs([
			ref({
				hash: "424f5413",
				usage: usage(1, 10, 2, "attributed"),
				usageBySession: { "claude:sess-a": usage(1, 10, 2, "attributed") },
			}),
			ref({
				hash: "700be509",
				usage: usage(3, 20, 4, "attributed"),
				usageBySession: { "claude:sess-a": usage(3, 20, 4, "attributed") },
			}),
		]);
		expect(merged[0].usageBySession).toEqual({ "claude:sess-a": usage(4, 30, 6, "attributed") });
		expect(merged[0].usage).toEqual(usage(4, 30, 6, "attributed"));
	});

	it("drops the split entirely when a contributor to the total brought none", () => {
		// A legacy ref carries `usage` with no split. Keeping the other side's split
		// would describe only part of the merged total, and detach would then re-derive
		// `usage` from that part. Absent is the honest answer: subtractSkillUsage's
		// forward-only guard leaves a split-less ref alone rather than corrupting it.
		const merged = mergeSkillRefs([
			ref({
				hash: "424f5413",
				usage: usage(1, 10, 2, "attributed"),
				usageBySession: { "claude:sess-a": usage(1, 10, 2, "attributed") },
			}),
			ref({ hash: "700be509", usage: usage(3, 20, 4, "attributed") }),
		]);
		expect(merged[0].usage).toEqual(usage(4, 30, 6, "attributed"));
		expect(merged[0].usageBySession).toBeUndefined();
	});

	it("keeps the split when the other side reports no usage at all", () => {
		// A heuristic ref contributes nothing to the total, so the one split that does
		// exist still decomposes it exactly and must survive.
		const merged = mergeSkillRefs([
			ref({
				hash: "424f5413",
				usage: usage(1, 10, 2, "attributed"),
				usageBySession: { "claude:sess-a": usage(1, 10, 2, "attributed") },
			}),
			ref({ hash: "700be509", detection: "heuristic" }),
		]);
		expect(merged[0].usageBySession).toEqual({ "claude:sess-a": usage(1, 10, 2, "attributed") });
	});

	it("degrades a merged session's confidence to estimated when either share was a guess", () => {
		const merged = mergeSkillRefs([
			ref({
				hash: "424f5413",
				usage: usage(1, 10, 2, "attributed"),
				usageBySession: { "claude:sess-a": usage(1, 10, 2, "attributed") },
			}),
			ref({
				hash: "700be509",
				usage: usage(1, 10, 2, "estimated"),
				usageBySession: { "claude:sess-a": usage(1, 10, 2, "estimated") },
			}),
		]);
		expect(merged[0].usageBySession?.["claude:sess-a"].confidence).toBe("estimated");
	});
});
