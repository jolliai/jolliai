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
});
