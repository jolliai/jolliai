import { describe, expect, it } from "vitest";
import type { PlanReference } from "../../../cli/src/Types.js";
import { annotatePlans, latestPlanPerName, planBaseKey } from "./PlanGrouping.js";

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
	describe("planBaseKey", () => {
		it("strips an 8-hex archived commit-hash suffix", () => {
			expect(planBaseKey("refactor-auth-1a2b3c4d")).toBe("refactor-auth");
		});

		it("leaves a base slug ending in real words alone", () => {
			expect(planBaseKey("refactor-auth")).toBe("refactor-auth");
			// 7 or 9 hex chars (not exactly 8) are not a hash suffix.
			expect(planBaseKey("plan-1a2b3c4")).toBe("plan-1a2b3c4");
			expect(planBaseKey("plan-1a2b3c4d5")).toBe("plan-1a2b3c4d5");
			// A trailing word that is not hex is untouched.
			expect(planBaseKey("plan-feature")).toBe("plan-feature");
		});
	});

	describe("annotatePlans", () => {
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

	describe("latestPlanPerName", () => {
		it("returns one plan per base name — the latest", () => {
			const a = makePlan({ slug: "p-1111aaaa", updatedAt: "2026-01-10T00:00:00Z" });
			const b = makePlan({ slug: "p-2222bbbb", updatedAt: "2026-01-12T00:00:00Z" });
			const c = makePlan({ slug: "other-3333cccc", updatedAt: "2026-01-09T00:00:00Z" });
			const result = latestPlanPerName([a, b, c]);
			expect(result.map((p) => p.slug)).toEqual(["p-2222bbbb", "other-3333cccc"]);
		});

		it("returns the input unchanged when all names are distinct", () => {
			const result = latestPlanPerName([makePlan({ slug: "only-1111aaaa" })]);
			expect(result.map((p) => p.slug)).toEqual(["only-1111aaaa"]);
		});

		it("inherits a pushed sibling's docId onto the latest snapshot so the push updates, not duplicates", () => {
			const older = makePlan({
				slug: "p-1111aaaa",
				updatedAt: "2026-01-10T00:00:00Z",
				jolliPlanDocId: 42,
				jolliPlanDocUrl: "https://jolli.ai/articles?doc=42",
			});
			const latest = makePlan({ slug: "p-2222bbbb", updatedAt: "2026-01-12T00:00:00Z" });
			const result = latestPlanPerName([older, latest]);
			expect(result).toHaveLength(1);
			expect(result[0].slug).toBe("p-2222bbbb");
			expect(result[0].jolliPlanDocId).toBe(42);
			expect(result[0].jolliPlanDocUrl).toBe("https://jolli.ai/articles?doc=42");
		});

		it("keeps the latest snapshot's own docId when it already has one", () => {
			const older = makePlan({ slug: "p-1111aaaa", updatedAt: "2026-01-10T00:00:00Z", jolliPlanDocId: 42 });
			const latest = makePlan({ slug: "p-2222bbbb", updatedAt: "2026-01-12T00:00:00Z", jolliPlanDocId: 99 });
			const result = latestPlanPerName([older, latest]);
			expect(result[0].jolliPlanDocId).toBe(99);
		});
	});
});
