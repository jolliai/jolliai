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

	// ─── Lossless contract (added 2026-05-22 for v5 migration) ────────────────
	//
	// These cases pin the contract that callers other than Regenerator can rely
	// on the normalized result without separately rescuing topics/recap/stats.
	// The earlier behavior (root spread, no topic/recap collection) silently
	// dropped data for v3 squash/amend layouts; v5 migration cannot tolerate
	// that loss because it does not run an LLM call to repopulate.

	it("preserves topics from v3 squash root with topics-in-children layout", () => {
		// Legacy v3 squash root layout: root has no topics; topics live on the
		// individual source-commit children. Without lossless hoist, the strip
		// step would erase them and the migrated v4 root would have topics=[].
		const v3Squash: CommitSummary = {
			...baseNode,
			version: 3,
			topics: [],
			children: [
				{
					...baseNode,
					commitHash: "child-1",
					version: 3,
					topics: [{ title: "Child topic 1", trigger: "t1", response: "r1", decisions: "d1" }],
				} as CommitSummary,
				{
					...baseNode,
					commitHash: "child-2",
					version: 3,
					topics: [{ title: "Child topic 2", trigger: "t2", response: "r2", decisions: "d2" }],
				} as CommitSummary,
			],
		} as CommitSummary;
		const normalized = normalizeToV4(v3Squash);
		expect(normalized.topics).toHaveLength(2);
		const titles = (normalized.topics ?? []).map((t) => t.title);
		expect(titles).toContain("Child topic 1");
		expect(titles).toContain("Child topic 2");
	});

	it("preserves recap from v3 amend root with recap-in-children layout", () => {
		// v3 amend root may have its own delta recap on root OR may have none
		// (older pipelines). Pick newest descendant recap when root has none.
		// Discriminator is `getDisplayDate` which prefers `generatedAt` over
		// `commitDate`, so the fixture differentiates generatedAt on children.
		const v3AmendChildRecap: CommitSummary = {
			...baseNode,
			version: 3,
			children: [
				{
					...baseNode,
					commitHash: "older-amend",
					commitDate: "2026-05-18T00:00:00Z",
					generatedAt: "2026-05-18T00:01:00Z",
					version: 3,
					recap: "older recap",
				} as CommitSummary,
				{
					...baseNode,
					commitHash: "newer-amend",
					commitDate: "2026-05-20T00:00:00Z",
					generatedAt: "2026-05-20T00:01:00Z",
					version: 3,
					recap: "newest recap",
				} as CommitSummary,
			],
		} as CommitSummary;
		const normalized = normalizeToV4(v3AmendChildRecap);
		expect(normalized.recap).toBe("newest recap");
	});

	it("keeps v3 root recap when present (squash/amend pipelines write it there)", () => {
		const v3WithRootRecap: CommitSummary = {
			...baseNode,
			version: 3,
			recap: "root-level recap",
			children: [
				{
					...baseNode,
					commitHash: "c1",
					version: 3,
					recap: "child recap should not win",
				} as CommitSummary,
			],
		} as CommitSummary;
		const normalized = normalizeToV4(v3WithRootRecap);
		expect(normalized.recap).toBe("root-level recap");
	});

	it("migrates v3 `stats` → v4 `diffStats` when only the legacy field is set", () => {
		// v3 stored diff info on `stats`; v4 standardized on `diffStats`. After
		// lossless normalize the v4 root carries the canonical `diffStats` so
		// downstream code doesn't need the `?? stats` fallback forever.
		const v3WithStats: CommitSummary = {
			...baseNode,
			version: 3,
			stats: { filesChanged: 5, insertions: 10, deletions: 3 },
		} as CommitSummary;
		const normalized = normalizeToV4(v3WithStats);
		expect(normalized.diffStats).toEqual({ filesChanged: 5, insertions: 10, deletions: 3 });
	});

	it("does not overwrite v3 `diffStats` when both fields are present (rare but valid)", () => {
		const v3Both: CommitSummary = {
			...baseNode,
			version: 3,
			stats: { filesChanged: 1, insertions: 1, deletions: 1 },
			diffStats: { filesChanged: 9, insertions: 9, deletions: 9 },
		} as CommitSummary;
		const normalized = normalizeToV4(v3Both);
		expect(normalized.diffStats).toEqual({ filesChanged: 9, insertions: 9, deletions: 9 });
	});

	it("Regenerator-style overwrite path: caller can still freely replace topics/recap on the normalized result", () => {
		// Sanity check that the lossless behavior does not lock topics/recap.
		// Regenerator wraps normalize with `{ ...normalized, topics: result.topics }`
		// and that must still work — we only widened what normalize preserves
		// when the caller chooses to keep it.
		const v3: CommitSummary = {
			...baseNode,
			version: 3,
			children: [
				{
					...baseNode,
					commitHash: "c1",
					version: 3,
					topics: [{ title: "preserved", trigger: "t", response: "r", decisions: "d" }],
					recap: "preserved recap",
				} as CommitSummary,
			],
		} as CommitSummary;
		const normalized = normalizeToV4(v3);
		const overwritten: CommitSummary = {
			...normalized,
			topics: [{ title: "fresh", trigger: "T", response: "R", decisions: "D" }],
			recap: "fresh recap",
		} as CommitSummary;
		expect(overwritten.topics?.[0]?.title).toBe("fresh");
		expect(overwritten.recap).toBe("fresh recap");
		// And the original normalized object is unmodified — caller's spread is
		// the only place that swapped values.
		expect(normalized.topics?.[0]?.title).toBe("preserved");
		expect(normalized.recap).toBe("preserved recap");
	});
});
