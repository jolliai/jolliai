import { describe, expect, it } from "vitest";
import type { NoteInfo, PlanInfo } from "../../Types.js";
import { PlansDataService } from "./PlansDataService.js";

function makePlan(lastModified: string, slug = "plan"): PlanInfo {
	return {
		slug,
		filename: `${slug}.md`,
		filePath: `/${slug}.md`,
		title: slug,
		lastModified,
		addedAt: lastModified,
		updatedAt: lastModified,
		branch: "main",
		editCount: 0,
		commitHash: null,
	};
}

function makeNote(lastModified: string, id = "note"): NoteInfo {
	return {
		id,
		title: id,
		format: "markdown",
		lastModified,
		addedAt: lastModified,
		updatedAt: lastModified,
		branch: "main",
		commitHash: null,
	};
}

describe("PlansDataService.mergeByLastModified", () => {
	it("returns empty when both lists are empty", () => {
		expect(PlansDataService.mergeByLastModified([], [])).toEqual([]);
	});

	it("sorts by lastModified descending (newest first)", () => {
		const plans = [makePlan("2026-01-01T00:00:00Z", "old")];
		const notes = [makeNote("2026-02-01T00:00:00Z", "new")];
		const merged = PlansDataService.mergeByLastModified(plans, notes);
		expect(merged[0]).toEqual({
			kind: "note",
			note: expect.objectContaining({ id: "new" }),
		});
		expect(merged[1]).toEqual({
			kind: "plan",
			plan: expect.objectContaining({ slug: "old" }),
		});
	});

	it("breaks ties by kind (plan before note)", () => {
		const ts = "2026-03-01T00:00:00Z";
		const plans = [makePlan(ts, "p1")];
		const notes = [makeNote(ts, "n1")];
		const merged = PlansDataService.mergeByLastModified(plans, notes);
		expect(merged[0].kind).toBe("plan");
		expect(merged[1].kind).toBe("note");
	});

	it("handles only-plans and only-notes inputs", () => {
		const plans = [makePlan("2026-01-01T00:00:00Z", "p1")];
		const onlyPlans = PlansDataService.mergeByLastModified(plans, []);
		expect(onlyPlans).toHaveLength(1);
		expect(onlyPlans[0].kind).toBe("plan");

		const notes = [makeNote("2026-01-01T00:00:00Z", "n1")];
		const onlyNotes = PlansDataService.mergeByLastModified([], notes);
		expect(onlyNotes).toHaveLength(1);
		expect(onlyNotes[0].kind).toBe("note");
	});

	it("sorts plan-vs-plan and note-vs-note pairs by lastModified", () => {
		// Exercises the b.kind === "plan" / b.kind === "note" branches in the
		// comparator's lastModified lookups, which are skipped when the input
		// only ever pairs (plan, note) at the boundary.
		const plans = [
			makePlan("2026-01-01T00:00:00Z", "p-old"),
			makePlan("2026-04-01T00:00:00Z", "p-new"),
		];
		const notes = [
			makeNote("2026-02-01T00:00:00Z", "n-old"),
			makeNote("2026-03-01T00:00:00Z", "n-new"),
		];
		const merged = PlansDataService.mergeByLastModified(plans, notes);
		const order = merged.map((m) =>
			m.kind === "plan" ? m.plan.slug : m.note.id,
		);
		expect(order).toEqual(["p-new", "n-new", "n-old", "p-old"]);
	});
});

describe("PlansDataService.isEmpty", () => {
	it("returns true when both lists are empty", () => {
		expect(PlansDataService.isEmpty([], [])).toBe(true);
	});

	it("returns false when only plans exist", () => {
		expect(
			PlansDataService.isEmpty([makePlan("2026-01-01T00:00:00Z")], []),
		).toBe(false);
	});

	it("returns false when only notes exist", () => {
		expect(
			PlansDataService.isEmpty([], [makeNote("2026-01-01T00:00:00Z")]),
		).toBe(false);
	});
});
