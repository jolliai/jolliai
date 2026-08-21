import { describe, expect, it } from "vitest";
import {
	CHORE_MAX_MINUTES,
	deriveJourneyShape,
	FEATURE_WORK_MINUTES,
	FRICTION_DURATION_CEILING,
	frictionIndex,
	isFeatureWork,
	type JourneyMetricsInput,
	pickHardest,
	pickSmoothest,
} from "./JourneyMetrics.js";

const journey = (over: Partial<JourneyMetricsInput> = {}): JourneyMetricsInput => ({
	planFirst: false,
	durationMinutes: 60,
	turns: null,
	decisionCount: 0,
	shape: { kind: "plan-first", label: "plan-first · clean land" },
	...over,
});

describe("frictionIndex", () => {
	it("adds nothing for an unknown duration or unknown turns", () => {
		// Not zero-as-a-value: scoring an unmeasured journey would let the
		// featured "hardest" card promote work we know nothing about.
		expect(frictionIndex(journey({ durationMinutes: null, turns: null }))).toBe(0);
	});

	it("grows with duration", () => {
		expect(frictionIndex(journey({ durationMinutes: 600 }))).toBeGreaterThan(frictionIndex(journey()));
	});

	it("grows with turns", () => {
		// Turns is included alongside duration (I1(a)): duration alone is
		// measurable on a small minority of journeys, so a duration-only score
		// silently ties almost everything at 0.
		expect(frictionIndex(journey({ durationMinutes: null, turns: 90 }))).toBeGreaterThan(
			frictionIndex(journey({ durationMinutes: null, turns: 1 })),
		);
	});

	it("combines both terms when both are measured", () => {
		const both = frictionIndex(journey({ durationMinutes: 60, turns: 30 }));
		const durationOnly = frictionIndex(journey({ durationMinutes: 60, turns: null }));
		expect(both).toBeGreaterThan(durationOnly);
	});
});

describe("isFeatureWork", () => {
	it("is false when the duration is unknown", () => {
		expect(isFeatureWork(journey({ durationMinutes: null }))).toBe(false);
	});

	it("is false below the feature-work floor, and for a chore", () => {
		expect(isFeatureWork(journey({ durationMinutes: FEATURE_WORK_MINUTES - 15 }))).toBe(false);
		expect(isFeatureWork(journey({ shape: { kind: "chore", label: "chore · clean land" } }))).toBe(false);
	});

	it("is true for landed feature work", () => {
		expect(isFeatureWork(journey({ durationMinutes: FEATURE_WORK_MINUTES }))).toBe(true);
	});
});

describe("the derived constants", () => {
	// The numbers, not just their relationships. Every other case here is
	// written in terms of the constants, so reverting them to the pre-activity
	// values (45 and 600) leaves this file green — `frictionIndex` at the
	// ceiling is `x/x === 1` for any ceiling. These are the values the measured
	// journey-level distribution produced (n=13: p50 270, p90 690), and a change
	// to them should be a deliberate re-derivation, not a silent edit.
	it("pins the constants to the distribution they were derived from", () => {
		expect(FEATURE_WORK_MINUTES).toBe(270);
		expect(FRICTION_DURATION_CEILING).toBe(690);
		expect(CHORE_MAX_MINUTES).toBe(30);
	});
});

describe("thresholds are stated in activity minutes", () => {
	it("treats a journey one bucket below the feature-work floor as not feature work", () => {
		expect(
			isFeatureWork({
				planFirst: false,
				durationMinutes: FEATURE_WORK_MINUTES - 15,
				turns: 10,
				decisionCount: 0,
				shape: { kind: "straight-to-execute", label: "straight to execute" },
			}),
		).toBe(false);
	});

	it("treats a journey at the feature-work floor as feature work", () => {
		expect(
			isFeatureWork({
				planFirst: false,
				durationMinutes: FEATURE_WORK_MINUTES,
				turns: 10,
				decisionCount: 0,
				shape: { kind: "straight-to-execute", label: "straight to execute" },
			}),
		).toBe(true);
	});

	it("reaches exactly 1.0 from the duration term at the ceiling", () => {
		// An identity (`x/x === 1` for any ceiling) — it proves the duration term
		// hits the same 1.0 a journey at TURNS_CEILING gets from turns, not that
		// the ceiling sits near the observed population. The population claim is
		// pinned separately, in "the derived constants" above.
		expect(
			frictionIndex({
				planFirst: false,
				durationMinutes: FRICTION_DURATION_CEILING,
				turns: 0,
				decisionCount: 0,
				shape: { kind: "straight-to-execute", label: "straight to execute" },
			}),
		).toBe(1);
	});
});

describe("deriveJourneyShape", () => {
	const shapeInput = {
		planFirst: false,
		// At the feature-work floor — well above CHORE_MAX_MINUTES (30), so the
		// duration-based chore check below does not fire on its own; tests that
		// want a chore-by-duration override this.
		durationMinutes: FEATURE_WORK_MINUTES,
		ticket: null,
		title: "add a feature",
		commitTitles: ["add a feature"],
	};

	it("does NOT call an unknown duration a chore", () => {
		// Labels are read by people; defaulting real work to "chore" is a slur,
		// not a conservative guess.
		expect(deriveJourneyShape({ ...shapeInput, durationMinutes: null }).kind).not.toBe("chore");
	});

	it("labels docs and chores from the title, for a single-commit journey", () => {
		expect(
			deriveJourneyShape({ ...shapeInput, title: "update the README", commitTitles: ["update the README"] }).kind,
		).toBe("docs");
		expect(
			deriveJourneyShape({ ...shapeInput, title: "bump the lockfile", commitTitles: ["bump the lockfile"] }).kind,
		).toBe("chore");
	});

	it("splits plan-first from straight-to-execute", () => {
		expect(deriveJourneyShape({ ...shapeInput, planFirst: true }).kind).toBe("plan-first");
		expect(deriveJourneyShape(shapeInput).kind).toBe("straight-to-execute");
	});

	it("calls a short journey a chore", () => {
		expect(deriveJourneyShape({ ...shapeInput, durationMinutes: 20 }).kind).toBe("chore");
	});

	// Round-1 review fix: the chore rule used to share FEATURE_WORK_MINUTES
	// (270, the journey-level p50) with isFeatureWork, so a journey below that
	// median was hard-labeled "chore · clean land" regardless of title — a
	// user-visible assertion, not the quiet median-omission isFeatureWork's
	// floor performs. CHORE_MAX_MINUTES (30, exclusive) is the separate,
	// narrower bound: it must admit only the shortest possible journey (one
	// fifteen-minute bucket) and reject everything above it, including a
	// journey well below the feature-work floor. This pair pins the split.
	it("does not call a journey below the feature-work floor a chore purely on duration", () => {
		const shape = deriveJourneyShape({ ...shapeInput, durationMinutes: FEATURE_WORK_MINUTES - 15 });
		expect(shape.kind).not.toBe("chore");
	});

	it("calls a single-bucket (15-minute) journey a chore", () => {
		const shape = deriveJourneyShape({ ...shapeInput, durationMinutes: 15 });
		expect(shape.kind).toBe("chore");
	});

	it("treats CHORE_MAX_MINUTES as an exclusive bound — the 30-minute journey is a real fix, not a chore", () => {
		const shape = deriveJourneyShape({ ...shapeInput, durationMinutes: CHORE_MAX_MINUTES });
		expect(shape.kind).not.toBe("chore");
	});

	// I4 regression: `title` alone is the newest commit's subject, which used to
	// be read as a claim about the WHOLE journey — a twelve-commit feature
	// branch ending in "bump lockfile" rendered "chore · clean land".
	describe("a multi-commit journey's trailing title (I4)", () => {
		it("does not call the whole journey a chore just because its LAST commit is chore-shaped", () => {
			const shape = deriveJourneyShape({
				...shapeInput,
				title: "bump lockfile",
				commitTitles: ["add the feature", "wire it up", "bump lockfile"],
			});
			expect(shape.kind).not.toBe("chore");
		});

		it("does not call the whole journey docs just because its LAST commit is docs-shaped", () => {
			const shape = deriveJourneyShape({
				...shapeInput,
				title: "update the README",
				commitTitles: ["add the feature", "wire it up", "update the README"],
			});
			expect(shape.kind).not.toBe("docs");
		});

		it("DOES call it a chore when EVERY commit's title is chore-shaped", () => {
			const shape = deriveJourneyShape({
				...shapeInput,
				title: "bump the other lockfile",
				commitTitles: ["bump a lockfile", "bump the other lockfile"],
			});
			expect(shape.kind).toBe("chore");
		});
	});
});

describe("pickSmoothest / pickHardest", () => {
	it("prefers a journey with substance over a smoother trivial one", () => {
		const trivial = journey({ durationMinutes: 5, decisionCount: 0, planFirst: false });
		const substantial = journey({ durationMinutes: 200, decisionCount: 3 });
		expect(pickSmoothest([trivial, substantial])).toBe(substantial);
	});

	it("falls back to plain friction-minimum when nothing has substance", () => {
		const only = journey({ durationMinutes: 5 });
		expect(pickSmoothest([only])).toBe(only);
	});

	it("returns undefined for an empty list", () => {
		expect(pickSmoothest([])).toBeUndefined();
		expect(pickHardest([])).toBeUndefined();
	});

	it("picks the middle journey when it has lowest friction among substantial items", () => {
		// Three substantial journeys: winner is in the middle, not first or last.
		// This forces the reduce to compare and KEEP a non-winning item.
		const first = journey({ durationMinutes: 300, decisionCount: 1 });
		const middle = journey({ durationMinutes: 60, decisionCount: 1 }); // friction ≈ 0.087
		const last = journey({ durationMinutes: 200, decisionCount: 1 });
		expect(pickSmoothest([first, middle, last])).toBe(middle);
	});

	it("picks the middle journey when it has highest friction overall", () => {
		// Three journeys: winner is in the middle.
		// This forces pickHardest's reduce to keep a non-winning candidate.
		const first = journey({ durationMinutes: 60 }); // friction ≈ 0.087
		const middle = journey({ durationMinutes: FRICTION_DURATION_CEILING }); // friction = 1.0 (WINNER)
		const last = journey({ durationMinutes: 120 }); // friction ≈ 0.174
		expect(pickHardest([first, middle, last])).toBe(middle);
	});

	it("breaks friction ties toward the first journey (strict compare)", () => {
		// Both reducers compare with strict `<` / `>`, so a tie KEEPS the
		// earlier item — a flip to `<=` / `>=` (last wins) or a re-sort would
		// silently change which journey a tie crowns.
		const first = journey({ durationMinutes: 60, decisionCount: 2 });
		const second = journey({ durationMinutes: 60, decisionCount: 2 });
		expect(pickSmoothest([first, second])).toBe(first);
		expect(pickHardest([first, second])).toBe(first);
	});

	it("crowns the same journey when every candidate ties (the featured de-dup precondition)", () => {
		// A one-candidate window makes a journey BOTH smoothest and hardest, and
		// a fully tied window does the same for the first item. `featured()` in
		// journeys.js de-dups its cards on id because of this coincidence — pin
		// it here so the de-dup's precondition cannot drift.
		const only = journey({ durationMinutes: 45, decisionCount: 2 });
		expect(pickSmoothest([only])).toBe(pickHardest([only]));
		const tied = [
			journey({ durationMinutes: 45, decisionCount: 2 }),
			journey({ durationMinutes: 45, decisionCount: 2 }),
		];
		expect(pickSmoothest(tied)).toBe(pickHardest(tied));
	});
});
