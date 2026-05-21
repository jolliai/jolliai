import { describe, expect, it } from "vitest";
import type { CommitSummary } from "../Types.js";
import { normalizeToV4 } from "./SummaryStore.js";

const baseNode = {
	commitHash: "abc1234567890",
	commitMessage: "x",
	commitAuthor: "tester",
	commitDate: "2026-05-21T00:00:00Z",
	branch: "main",
	generatedAt: "2026-05-21T00:01:00Z",
} as const;

describe("normalizeToV4", () => {
	it("returns the same reference for v4 input (no-op fast path)", () => {
		const v4: CommitSummary = { ...baseNode, version: 4 } as CommitSummary;
		expect(normalizeToV4(v4)).toBe(v4);
	});

	it("treats any version >= 4 as no-op (future-proofs the fast path against v5)", () => {
		// The implementation gate is `version >= 4`, not `=== 4`. A future v5
		// would still be a unified-Hoist superset; pre-normalize would be
		// wrong because v5 might add semantics this helper doesn't know
		// about. Pin the >= behavior so a future refactor doesn't tighten
		// to === and silently double-normalize newer summaries.
		const v5: CommitSummary = { ...baseNode, version: 5 } as CommitSummary;
		expect(normalizeToV4(v5)).toBe(v5);
		expect(normalizeToV4(v5).version).toBe(5);
	});

	it("returns a NEW object reference (not the input) when normalize actually ran on v3", () => {
		// Counterpart to the v4 fast-path identity assertion above. Without
		// this, a future refactor that accidentally mutated the input in
		// place would still pass all the other tests (they assert outcomes,
		// not non-mutation). Important because callers may hold the v3
		// reference and expect it unchanged until they explicitly persist.
		const v3Leaf: CommitSummary = { ...baseNode, version: 3 } as CommitSummary;
		const normalized = normalizeToV4(v3Leaf);
		expect(normalized).not.toBe(v3Leaf);
		// And the input still reports version 3 — we didn't mutate it.
		expect(v3Leaf.version).toBe(3);
	});

	it("bumps version to 4 on a v3 leaf with no children", () => {
		const v3Leaf: CommitSummary = { ...baseNode, version: 3 } as CommitSummary;
		const normalized = normalizeToV4(v3Leaf);
		expect(normalized.version).toBe(4);
		expect(normalized.children).toBeUndefined();
	});

	it("hoists child-only plans / notes / linearIssues / e2eTestGuide / jolliDoc to root", () => {
		const v3WithChildMeta: CommitSummary = {
			...baseNode,
			version: 3,
			children: [
				{
					...baseNode,
					commitHash: "child-hash",
					version: 3,
					plans: [
						{
							slug: "feature-x",
							title: "Feature X",
							editCount: 1,
							addedAt: "2026-05-20T00:00:00Z",
							updatedAt: "2026-05-20T00:00:00Z",
						},
					],
					notes: [
						{
							id: "note-1",
							title: "N1",
							format: "snippet",
							addedAt: "2026-05-20T00:00:00Z",
							updatedAt: "2026-05-20T00:00:00Z",
						},
					],
					linearIssues: [
						{
							archivedKey: "PROJ-1-abc",
							ticketId: "PROJ-1",
							title: "T",
							url: "https://linear.app/x",
							referencedAt: "2026-05-20T00:00:00Z",
							sourceToolName: "mcp__linear__get_issue",
						},
					],
					e2eTestGuide: [
						{
							title: "Scenario 1",
							preconditions: "",
							steps: ["step"],
							expectedResults: ["ok"],
						} as never,
					],
					jolliDocId: 42,
					jolliDocUrl: "https://jolli.ai/d/42",
				},
			],
		} as CommitSummary;

		const normalized = normalizeToV4(v3WithChildMeta);

		expect(normalized.version).toBe(4);
		expect(normalized.plans?.[0]?.slug).toBe("feature-x");
		expect(normalized.notes?.[0]?.id).toBe("note-1");
		expect(normalized.linearIssues?.[0]?.archivedKey).toBe("PROJ-1-abc");
		expect(normalized.e2eTestGuide?.[0]?.title).toBe("Scenario 1");
		expect(normalized.jolliDocId).toBe(42);
		expect(normalized.jolliDocUrl).toBe("https://jolli.ai/d/42");
		// Child stripped.
		expect(normalized.children?.[0]?.plans).toBeUndefined();
		expect(normalized.children?.[0]?.notes).toBeUndefined();
		expect(normalized.children?.[0]?.jolliDocId).toBeUndefined();
	});

	it("strips descendants recursively through grandchildren", () => {
		const v3Nested: CommitSummary = {
			...baseNode,
			version: 3,
			children: [
				{
					...baseNode,
					commitHash: "child-hash",
					version: 3,
					plans: [
						{
							slug: "p-c",
							title: "child plan",
							editCount: 1,
							addedAt: "2026-05-20T00:00:00Z",
							updatedAt: "2026-05-20T00:00:00Z",
						},
					],
					children: [
						{
							...baseNode,
							commitHash: "grandchild-hash",
							version: 3,
							plans: [
								{
									slug: "p-g",
									title: "grandchild plan",
									editCount: 1,
									addedAt: "2026-05-20T00:00:00Z",
									updatedAt: "2026-05-20T00:00:00Z",
								},
							],
						},
					],
				},
			],
		} as CommitSummary;

		const normalized = normalizeToV4(v3Nested);
		// Both plans hoisted to root (dedup-by-slug union).
		const slugs = (normalized.plans ?? []).map((p) => p.slug).sort();
		expect(slugs).toEqual(["p-c", "p-g"]);
		// Grandchild stripped too.
		expect(normalized.children?.[0]?.children?.[0]?.plans).toBeUndefined();
	});

	it("preserves topics, recap, ticketId on root (regenerate decides whether to overwrite)", () => {
		const v3WithRootContent: CommitSummary = {
			...baseNode,
			version: 3,
			topics: [{ title: "kept", trigger: "t", response: "r", decisions: "d" }],
			recap: "kept recap",
			ticketId: "PROJ-9",
		} as CommitSummary;
		const normalized = normalizeToV4(v3WithRootContent);
		expect(normalized.topics?.[0]?.title).toBe("kept");
		expect(normalized.recap).toBe("kept recap");
		expect(normalized.ticketId).toBe("PROJ-9");
	});

	it("recursively collects orphanedDocIds from every descendant and dedups", () => {
		const v3WithChildOrphans: CommitSummary = {
			...baseNode,
			version: 3,
			orphanedDocIds: [1, 2],
			children: [
				{
					...baseNode,
					commitHash: "c1",
					version: 3,
					orphanedDocIds: [2, 3],
					children: [
						{
							...baseNode,
							commitHash: "g1",
							version: 3,
							orphanedDocIds: [4],
						},
					],
				},
			],
		} as CommitSummary;
		const normalized = normalizeToV4(v3WithChildOrphans);
		expect(new Set(normalized.orphanedDocIds ?? [])).toEqual(new Set([1, 2, 3, 4]));
	});

	it("dedups duplicated plans (by slug) by picking the newest updatedAt", () => {
		const v3WithDuplicatePlans: CommitSummary = {
			...baseNode,
			version: 3,
			plans: [
				{
					slug: "shared",
					title: "Old (root)",
					editCount: 1,
					addedAt: "2026-05-20T00:00:00Z",
					updatedAt: "2026-05-20T00:00:00Z",
				},
			],
			children: [
				{
					...baseNode,
					commitHash: "c1",
					version: 3,
					plans: [
						{
							slug: "shared",
							title: "New (child)",
							editCount: 2,
							addedAt: "2026-05-20T00:00:00Z",
							updatedAt: "2026-05-21T00:00:00Z",
						},
					],
				},
			],
		} as CommitSummary;
		const normalized = normalizeToV4(v3WithDuplicatePlans);
		expect(normalized.plans).toHaveLength(1);
		expect(normalized.plans?.[0]?.title).toBe("New (child)");
	});

	it("omits Copy-Hoist field keys entirely when no node in the tree carried them", () => {
		const v3Bare: CommitSummary = { ...baseNode, version: 3 } as CommitSummary;
		const normalized = normalizeToV4(v3Bare);
		expect(normalized.plans).toBeUndefined();
		expect(normalized.notes).toBeUndefined();
		expect(normalized.linearIssues).toBeUndefined();
		expect(normalized.e2eTestGuide).toBeUndefined();
		expect(normalized.jolliDocId).toBeUndefined();
		expect(normalized.orphanedDocIds).toBeUndefined();
	});
});
