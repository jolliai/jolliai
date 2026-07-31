import { describe, expect, it } from "vitest";
import type { NoteInfo, PlanInfo, ReferenceInfo, SkillInfo } from "../../Types.js";
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

	it("kind tie-break holds for both compare(plan,note) and compare(note,plan) call directions", () => {
		// The previous test only exercises the cmp(plan, note) call direction
		// — items=[p, n] is already in the desired order so sort never reverses
		// the pair. With ≥3 same-timestamp items, the insertion-sort path
		// inside Timsort triggers cmp(note, plan) when comparing the trailing
		// note against an earlier-inserted plan. Pins the `: 1` branch of the
		// `a.kind === "plan" ? -1 : 1` ternary so a future flip of that
		// fallback doesn't silently scramble equal-timestamp ordering.
		const ts = "2026-05-01T00:00:00Z";
		const merged = PlansDataService.mergeByLastModified(
			[makePlan(ts, "p1"), makePlan(ts, "p2")],
			[makeNote(ts, "n1")],
		);
		expect(merged.map((m) => m.kind)).toEqual(["plan", "plan", "note"]);
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
		// PlansOrNote is a 3-way union (plan / note / entity) since the
		// multi-source entity rewrite landed. This test only feeds plans
		// and notes, but TypeScript still narrows by `kind` rather than
		// the negation-of-plan implying note. Branch on each kind
		// explicitly; the entity arm is unreachable but required for
		// total-function narrowing.
		const order = merged.map((m) => {
			if (m.kind === "plan") return m.plan.slug;
			if (m.kind === "note") return m.note.id;
			return m.reference.mapKey;
		});
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

	it("returns false when only entities exist", () => {
		expect(
			PlansDataService.isEmpty(
				[],
				[],
				[makeEntity("2026-01-01T00:00:00Z")],
			),
		).toBe(false);
	});

	it("returns true when explicit empty entities array is passed", () => {
		expect(PlansDataService.isEmpty([], [], [])).toBe(true);
	});
});

function makeEntity(
	lastModified: string,
	nativeId = "PROJ-1",
	source: ReferenceInfo["source"] = "linear",
): ReferenceInfo {
	return {
		kind: "reference",
		source,
		nativeId,
		mapKey: `${source}:${nativeId}`,
		title: `Entity ${nativeId}`,
		url: `https://example.com/${nativeId}`,
		sourcePath: `/.jolli/.../${nativeId}.md`,
		branch: "main",
		addedAt: lastModified,
		updatedAt: lastModified,
		lastModified,
		commitHash: null,
		ignored: false,
		sourceToolName: "mcp__linear__get_issue",
	};
}

describe("PlansDataService.mergeByLastModified — three-way merge", () => {
	it("includes entities in the merged output", () => {
		const merged = PlansDataService.mergeByLastModified(
			[],
			[],
			[makeEntity("2026-05-14T06:00:00Z", "PROJ-1")],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].kind).toBe("reference");
	});

	it("interleaves all three kinds by lastModified descending", () => {
		const plans = [makePlan("2026-05-14T03:00:00Z", "plan-mid")];
		const notes = [makeNote("2026-05-14T05:00:00Z", "note-newest")];
		const entities = [
			makeEntity("2026-05-14T01:00:00Z", "PROJ-old"),
			makeEntity("2026-05-14T04:00:00Z", "PROJ-mid"),
		];

		const merged = PlansDataService.mergeByLastModified(plans, notes, entities);

		const order = merged.map((m) => {
			if (m.kind === "plan") return m.plan.slug;
			if (m.kind === "note") return m.note.id;
			return m.reference.nativeId;
		});
		expect(order).toEqual(["note-newest", "PROJ-mid", "plan-mid", "PROJ-old"]);
	});

	it("uses kind rank for deterministic tie-break (plan < note < entity)", () => {
		const same = "2026-05-14T00:00:00Z";
		const merged = PlansDataService.mergeByLastModified(
			[makePlan(same, "p")],
			[makeNote(same, "n")],
			[makeEntity(same, "PROJ-1")],
		);
		expect(merged.map((m) => m.kind)).toEqual(["plan", "note", "reference"]);
	});

	it("defaults entities to [] when omitted (backward compat)", () => {
		const merged = PlansDataService.mergeByLastModified(
			[makePlan("2026-01-01T00:00:00Z")],
			[],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].kind).toBe("plan");
	});

	it("interleaves entities from heterogeneous sources (Jira / GitHub / Notion / Linear)", () => {
		// The merge sort doesn't discriminate by source — every ReferenceInfo
		// participates uniformly. This regression-tests the multi-source
		// refactor: before ReferenceItem, only `linear` entities reached the
		// tree; now Jira / GitHub / Notion rows have to flow through the
		// same code path and land at the right sort position.
		const plans: ReadonlyArray<PlanInfo> = [];
		const notes: ReadonlyArray<NoteInfo> = [];
		const entities: ReadonlyArray<ReferenceInfo> = [
			makeEntity("2026-05-14T01:00:00Z", "PROJ-1", "linear"),
			makeEntity("2026-05-14T04:00:00Z", "KAN-7", "jira"),
			makeEntity("2026-05-14T03:00:00Z", "owner/repo#42", "github"),
			makeEntity("2026-05-14T02:00:00Z", "abc123def456", "notion"),
		];
		const merged = PlansDataService.mergeByLastModified(plans, notes, entities);
		const order = merged.map((m) =>
			m.kind === "reference" ? `${m.reference.source}:${m.reference.nativeId}` : "x",
		);
		expect(order).toEqual([
			"jira:KAN-7",
			"github:owner/repo#42",
			"notion:abc123def456",
			"linear:PROJ-1",
		]);
	});
});

describe("PlansDataService — skills", () => {
	const skill = (over: Partial<SkillInfo> = {}): SkillInfo => ({
		kind: "skill",
		mapKey: "claude:superpowers:brainstorming",
		source: "claude",
		skill: "superpowers:brainstorming",
		entryPaths: ["tool"],
		invocationCount: 2,
		firstUsedAt: "2026-07-30T06:00:00.000Z",
		lastUsedAt: "2026-07-30T07:00:00.000Z",
		sourcePath: "/tmp/s.md",
		lastModified: "2026-07-30T07:00:00.000Z",
		...over,
	});

	it("collapses every skill into ONE entry carrying them all", () => {
		// The Context list gets one aggregate row, not one row per skill — a session
		// routinely enters a dozen and they would crowd out the plans / notes /
		// references the work is actually about.
		const merged = PlansDataService.mergeByLastModified(
			[],
			[],
			[],
			[
				skill({ lastModified: "2026-07-30T09:00:00.000Z" }),
				skill({ mapKey: "claude:other", lastModified: "2026-07-30T05:00:00.000Z" }),
			],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].kind).toBe("skills");
		expect(merged[0].kind === "skills" ? merged[0].skills.map((s) => s.mapKey) : []).toEqual([
			"claude:superpowers:brainstorming",
			"claude:other",
		]);
	});

	it("emits NO entry when nothing was captured", () => {
		// An empty group must not produce a row that says "0 skills".
		expect(PlansDataService.mergeByLastModified([], [], [], [])).toHaveLength(0);
	});

	it("sorts the group by its NEWEST member, not its first", () => {
		// The group's timestamp is a reduction over members: a skill entered just now
		// pulls the row above an artifact touched an hour ago, even when an older
		// member happens to sit first in registry order. Reading [0] instead would
		// sink the row on stale data — hence a plan between the two timestamps.
		const merged = PlansDataService.mergeByLastModified(
			[makePlan("2026-07-30T12:00:00.000Z", "mid")],
			[],
			[],
			[
				skill({ mapKey: "claude:old", lastModified: "2026-07-30T01:00:00.000Z" }),
				skill({ mapKey: "claude:new", lastModified: "2026-07-30T23:00:00.000Z" }),
			],
		);
		expect(merged.map((m) => m.kind)).toEqual(["skills", "plan"]);
	});

	it("ranks the skills group after a reference on an exact timestamp tie", () => {
		// Skills are metadata about HOW the work happened; the artifacts it was about
		// come first. A shared rank would make the order depend on insertion.
		const at = "2026-07-30T09:00:00.000Z";
		const merged = PlansDataService.mergeByLastModified(
			[],
			[],
			[
				{
					kind: "reference",
					source: "linear",
					nativeId: "ENG-1",
					mapKey: "linear:ENG-1",
					title: "Fix",
					url: "https://l/ENG-1",
					sourcePath: "/tmp/r.md",
					addedAt: at,
					updatedAt: at,
					lastModified: at,
					sourceToolName: "mcp__linear__get_issue",
				},
			],
			[skill({ lastModified: at })],
		);
		expect(merged.map((m) => m.kind)).toEqual(["reference", "skills"]);
	});

	it("is not empty when only skills were captured", () => {
		expect(PlansDataService.isEmpty([], [], [], [skill()])).toBe(false);
		expect(PlansDataService.isEmpty([], [], [], [])).toBe(true);
	});
});
