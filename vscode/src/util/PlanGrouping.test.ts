/**
 * Tests for the panel-side plan annotation.
 *
 * `planBaseKey` / `byUpdatedAtDesc` / `latestPlanPerName` are NOT tested here: they
 * live in the CLI's `core/push/PlanGrouping` and are covered by the CLI suite. This
 * file used to test local copies of them, which is what kept two spellings of one
 * grouping rule alive after the push path moved to the context-kind registry.
 */

import { describe, expect, it } from "vitest";
import type { PlanReference } from "../../../cli/src/Types.js";
import { annotatePlans } from "./PlanGrouping.js";

function makePlan(overrides?: Partial<PlanReference>): PlanReference {
	return {
		slug: "test-plan",
		title: "Test Plan",
		addedAt: "2026-01-15T10:00:00Z",
		updatedAt: "2026-01-15T10:05:00Z",
		...overrides,
	};
}

describe("PlanGrouping", () => {
	describe("annotatePlans", () => {
		it("groups by the CLI's base key, so an archived snapshot and its base collapse", () => {
			// Pinned here (not just in the CLI suite) because this is the SEAM: the panel
			// must group by the same key the push path dedupes by, and the only way that
			// can now break is this file importing the wrong helper.
			const archived = makePlan({ slug: "refactor-auth-1a2b3c4d", updatedAt: "2026-01-12T00:00:00Z" });
			const base = makePlan({ slug: "refactor-auth", updatedAt: "2026-01-10T00:00:00Z" });
			const result = annotatePlans([base, archived]);
			expect(result[0]).toMatchObject({ isLatest: true });
			expect(result[1]).toMatchObject({ isSuperseded: true });
		});

		it("orders newest-first and flags exactly one Latest per multi-snapshot group", () => {
			const a = makePlan({ slug: "p-1111aaaa", updatedAt: "2026-01-10T00:00:00Z" });
			const b = makePlan({ slug: "p-2222bbbb", updatedAt: "2026-01-12T00:00:00Z" });
			const result = annotatePlans([a, b]);
			expect(result.map((r) => r.plan.slug)).toEqual(["p-2222bbbb", "p-1111aaaa"]);
			expect(result[0]).toMatchObject({ isLatest: true, isSuperseded: false });
			expect(result[1]).toMatchObject({ isLatest: false, isSuperseded: true });
		});

		it("flags no Latest for a singleton group", () => {
			const result = annotatePlans([makePlan({ slug: "solo-1111aaaa" })]);
			expect(result[0]).toMatchObject({ isLatest: false, isSuperseded: false });
		});

		it("keeps distinct-named plans independent", () => {
			const x = makePlan({ slug: "alpha-1111aaaa", updatedAt: "2026-01-10T00:00:00Z" });
			const y = makePlan({ slug: "beta-2222bbbb", updatedAt: "2026-01-12T00:00:00Z" });
			const result = annotatePlans([x, y]);
			expect(result.every((r) => !r.isLatest && !r.isSuperseded)).toBe(true);
		});

		it("breaks updatedAt ties deterministically by slug", () => {
			const same = "2026-01-10T00:00:00Z";
			const a = makePlan({ slug: "p-bbbbbbbb", updatedAt: same });
			const b = makePlan({ slug: "p-aaaaaaaa", updatedAt: same });
			// Input order reversed between the two runs — output must be identical.
			const r1 = annotatePlans([a, b]).map((r) => r.plan.slug);
			const r2 = annotatePlans([b, a]).map((r) => r.plan.slug);
			expect(r1).toEqual(r2);
			expect(r1).toEqual(["p-aaaaaaaa", "p-bbbbbbbb"]);
		});

		it("keeps identical entries (same slug + updatedAt) stable", () => {
			const p = makePlan({ slug: "dup-1111aaaa", updatedAt: "2026-01-10T00:00:00Z" });
			const result = annotatePlans([p, { ...p }]);
			// Same base key twice → a duplicate group; second occurrence superseded.
			expect(result.map((r) => r.plan.slug)).toEqual(["dup-1111aaaa", "dup-1111aaaa"]);
			expect(result[0]).toMatchObject({ isLatest: true, isSuperseded: false });
			expect(result[1]).toMatchObject({ isLatest: false, isSuperseded: true });
		});
	});
});
