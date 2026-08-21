/**
 * Tests for the per-skill → per-commit skill-article migration.
 *
 * What matters here is that the OLD ids are neither honoured as-is nor silently
 * dropped: a shipped version published one article per (skill, commit), and the
 * only two ways to get that wrong are to keep pushing against them (which the
 * aggregate model cannot do — one article, many skills) or to abandon them (which
 * leaks every one of them, since `cleanupOrphanedDocs` only ever sees
 * `orphanedDocIds`).
 */

import { describe, expect, it } from "vitest";
import type { CommitSummary, SkillCommitRef } from "../../Types.js";
import { adoptLegacySkillDocIds } from "./LegacySkillDocIds.js";

function ref(overrides: Partial<SkillCommitRef> = {}): SkillCommitRef {
	return {
		archivedKey: "claude:a-a1b2c3d4",
		source: "claude",
		skill: "a",
		entryPaths: ["tool"],
		invocationCount: 1,
		firstUsedAt: "2026-08-01T10:00:00.000Z",
		lastUsedAt: "2026-08-05T10:00:00.000Z",
		...overrides,
	};
}

function summary(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return { commitHash: "a1b2c3d4e5f6", ...overrides } as CommitSummary;
}

describe("adoptLegacySkillDocIds", () => {
	it("adopts the newest legacy article and orphans the rest", () => {
		const out = adoptLegacySkillDocIds(
			summary({
				skills: [
					{ ...ref({ archivedKey: "claude:a-h", lastUsedAt: "2026-08-01T00:00:00.000Z" }), jolliDocId: 501 },
					{
						...ref({ archivedKey: "claude:b-h", skill: "b", lastUsedAt: "2026-08-05T00:00:00.000Z" }),
						jolliDocId: 502,
						jolliDocUrl: "https://acme.jolli.ai/articles?doc=502",
					},
				],
			}),
		);
		// N per-skill articles become 1 aggregate in a single push: the newest is
		// rewritten into the aggregate, the others are queued for deletion.
		expect(out.jolliSkillsDocId).toBe(502);
		expect(out.jolliSkillsDocUrl).toBe("https://acme.jolli.ai/articles?doc=502");
		expect(out.orphanedDocIds).toEqual([501]);
	});

	it("strips the legacy fields, so a second call cannot re-adopt them", () => {
		const once = adoptLegacySkillDocIds(summary({ skills: [{ ...ref(), jolliDocId: 501 }] }));
		expect(once.skills?.[0]).not.toHaveProperty("jolliDocId");
		// Deleted, not set to undefined: these refs are serialized as JSON, where a
		// `null` reads back as a field that exists.
		expect(JSON.stringify(once.skills?.[0])).not.toContain("jolliDocId");
		expect(adoptLegacySkillDocIds(once)).toBe(once);
	});

	it("drains ids a fold banked on a ref but never delivered", () => {
		// `supersededDocIds` was the per-skill model's own cleanup marker. Once the refs
		// stop carrying ids, nothing drains it — so this migration is its last reader.
		const out = adoptLegacySkillDocIds(
			summary({ skills: [{ ...ref(), jolliDocId: 501, supersededDocIds: [499] }] }),
		);
		expect(out.orphanedDocIds).toEqual([499]);
		expect(out.skills?.[0]).not.toHaveProperty("supersededDocIds");
	});

	it("never re-points a commit that already has an aggregate article", () => {
		// Adopting here would abandon the article the commit is actually published as.
		const already = summary({ jolliSkillsDocId: 900, skills: [{ ...ref(), jolliDocId: 501 }] });
		expect(adoptLegacySkillDocIds(already).jolliSkillsDocId).toBe(900);
	});

	it("reclaims legacy ids left on the refs of a commit that already has an aggregate", () => {
		// A mixed-vintage squash: the root got its aggregate id hoisted from one child
		// while `mergeSkillRef` KEPT a legacy child's per-ref id on the merged row. That
		// id is in no `supersededDocIds`, so skipping the whole function stranded the
		// per-skill article on the Space forever.
		const already = summary({
			jolliSkillsDocId: 900,
			skills: [{ ...ref(), jolliDocId: 501, supersededDocIds: [499] }],
		});
		const out = adoptLegacySkillDocIds(already);
		expect(out.jolliSkillsDocId).toBe(900);
		expect(out.orphanedDocIds).toEqual([501, 499]);
		expect(out.skills?.[0]).not.toHaveProperty("jolliDocId");
		// Idempotent: a second pass has nothing left to reclaim.
		expect(adoptLegacySkillDocIds(out)).toBe(out);
	});

	it("returns a summary with nothing to migrate by identity", () => {
		// Callers use `!==` to detect a rewrite, and an unpushed repo must not churn.
		const none = summary({ skills: [ref()] });
		expect(adoptLegacySkillDocIds(none)).toBe(none);
		expect(adoptLegacySkillDocIds(summary())).toBeDefined();
	});

	it("keeps ids the summary was already carrying", () => {
		const out = adoptLegacySkillDocIds(summary({ orphanedDocIds: [300], skills: [{ ...ref(), jolliDocId: 501 }] }));
		expect(out.orphanedDocIds).toEqual([300]);
		expect(out.jolliSkillsDocId).toBe(501);
	});

	it("strips a legacy jolliDocUrl even when there is nothing to adopt or reclaim", () => {
		// published.length === 0 AND banked.length === 0, but the ref still carries a
		// dangling jolliDocUrl — the early return must still strip it rather than leave
		// an ambiguous shape for the next pass.
		const withUrlOnly = summary({ skills: [{ ...ref(), jolliDocUrl: "https://acme.jolli.ai/articles?doc=1" }] });
		const out = adoptLegacySkillDocIds(withUrlOnly);
		expect(out).not.toBe(withUrlOnly);
		expect(out.skills?.[0]).not.toHaveProperty("jolliDocUrl");
	});

	it("reclaims only banked ids when nothing is published and there were no prior orphans", () => {
		// published.length === 0 but banked.length > 0, and no existing aggregate —
		// nothing to adopt, but the banked id must not leak.
		const out = adoptLegacySkillDocIds(summary({ skills: [{ ...ref(), supersededDocIds: [499] }] }));
		expect(out.jolliSkillsDocId).toBeUndefined();
		expect(out.orphanedDocIds).toEqual([499]);
		expect(out.skills?.[0]).not.toHaveProperty("supersededDocIds");
	});

	it("reclaims banked ids alongside orphans the summary already carried, with nothing published", () => {
		const out = adoptLegacySkillDocIds(
			summary({ orphanedDocIds: [300], skills: [{ ...ref(), supersededDocIds: [499] }] }),
		);
		expect(out.orphanedDocIds).toEqual([300, 499]);
	});

	it("leaves a ref with no legacy fields at all untouched by identity", () => {
		// A skills array can mix a legacy-vintage ref with one that never carried any
		// of the three fields — stripLegacyDocFields must return that ref UNCHANGED
		// (by identity), not a needlessly cloned copy.
		const clean: SkillCommitRef = ref({ archivedKey: "claude:b-1", skill: "b" });
		const legacy = { ...ref(), jolliDocId: 501 };
		const out = adoptLegacySkillDocIds(summary({ skills: [legacy, clean] }));
		expect(out.jolliSkillsDocId).toBe(501);
		expect(out.skills?.[1]).toBe(clean);
	});

	it("picks the newest article first regardless of which side of the pair it's on", () => {
		// Reversed order from the "adopts the newest" test above, to exercise the
		// opposite side of the `a.lastUsedAt < b.lastUsedAt` comparison.
		const out = adoptLegacySkillDocIds(
			summary({
				skills: [
					{
						...ref({ archivedKey: "claude:b-h", skill: "b", lastUsedAt: "2026-08-05T00:00:00.000Z" }),
						jolliDocId: 502,
					},
					{ ...ref({ archivedKey: "claude:a-h", lastUsedAt: "2026-08-01T00:00:00.000Z" }), jolliDocId: 501 },
				],
			}),
		);
		expect(out.jolliSkillsDocId).toBe(502);
		expect(out.orphanedDocIds).toEqual([501]);
	});

	it("breaks an exact lastUsedAt tie by archivedKey — lower key wins, either input order", () => {
		const sameTime = "2026-08-05T00:00:00.000Z";
		const lower = { ...ref({ archivedKey: "claude:a-1", skill: "a", lastUsedAt: sameTime }), jolliDocId: 501 };
		const higher = { ...ref({ archivedKey: "claude:z-1", skill: "z", lastUsedAt: sameTime }), jolliDocId: 503 };

		// Sort correctness cannot depend on which side of the pair the comparator
		// happens to be called with, so both input orders must resolve the same way —
		// this is what exercises the tie-break's comparator in both directions.
		const forward = adoptLegacySkillDocIds(summary({ skills: [lower, higher] }));
		expect(forward.jolliSkillsDocId).toBe(501);
		expect(forward.orphanedDocIds).toEqual([503]);

		const reversed = adoptLegacySkillDocIds(summary({ skills: [higher, lower] }));
		expect(reversed.jolliSkillsDocId).toBe(501);
		expect(reversed.orphanedDocIds).toEqual([503]);
	});

	it("breaks a lastUsedAt AND archivedKey tie without throwing, adopting exactly one side", () => {
		const sameTime = "2026-08-05T00:00:00.000Z";
		const dupA = { ...ref({ archivedKey: "claude:a-1", skill: "a", lastUsedAt: sameTime }), jolliDocId: 501 };
		const dupB = { ...ref({ archivedKey: "claude:a-1", skill: "a2", lastUsedAt: sameTime }), jolliDocId: 502 };

		const out = adoptLegacySkillDocIds(summary({ skills: [dupA, dupB] }));
		// A fully-tied pair has no deterministic winner by design (the comparator
		// returns 0), but exactly one side must be adopted and the other orphaned —
		// never both, and never neither.
		expect([501, 502]).toContain(out.jolliSkillsDocId);
		expect(out.orphanedDocIds).toEqual([out.jolliSkillsDocId === 501 ? 502 : 501]);
	});
});
