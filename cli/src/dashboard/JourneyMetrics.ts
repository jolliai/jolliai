/**
 * The journey scoring and labelling rules, ported from the cloud's
 * `common/src/util/JourneyMetrics.ts` (JOLLI-2123).
 *
 * Structurally typed on purpose: these take the smallest shape each rule needs
 * rather than importing `LocalJourney`, so a rule can be tested without a
 * database row and the model can grow fields without touching this file.
 *
 * The three "unknown duration" answers differ, and the difference is the whole
 * point — the question is which direction of error hurts more. See each
 * function.
 *
 * Locally `friction` and `waitShare` are never measurable (no turn-level
 * signals reach the SoT), so the terms that would carry them are absent rather
 * than passed as zero. Restoring them means adding the term back here, not
 * changing the callers.
 */

export type JourneyShapeKind = "plan-first" | "straight-to-execute" | "chore" | "docs" | "blocked";

export interface JourneyShape {
	readonly kind: JourneyShapeKind;
	readonly label: string;
}

/** The smallest shape the scoring rules need. `LocalJourney` satisfies it. */
export interface JourneyMetricsInput {
	readonly planFirst: boolean;
	/** `null` when no session in this journey reported a duration. */
	readonly durationMinutes: number | null;
	/** `null` when `conversationTurns` was never reported for any commit in this journey. */
	readonly turns: number | null;
	readonly decisionCount: number;
	readonly shape: JourneyShape;
}

/**
 * Ceiling `frictionIndex`'s turns term is normalized against. Mirrors the
 * bar's own recalibration in `journeys.js` (§I3): the observed distribution's
 * p90 sits around 30, so 90 gives real headroom above typical work while still
 * being sensitive across the common range — this is a scoring term, not a
 * pixel width, so it does not need the bar's tighter ceiling.
 */
const TURNS_CEILING = 90;

/**
 * Feature-work floor, in ACTIVITY minutes — a multiple of the fifteen-minute
 * bucket, because any other value cannot be reached (`journeyActivityMinutes`
 * unions whole `session_activity` buckets).
 *
 * Re-derived against the corrected population (`durationMinutes` now comes
 * from Task 2's activity-bucket union, not `sessions.duration_ms`). Measured
 * against the live dashboard database, 2026-08-15, via:
 *
 * ```ts
 * import { withReadonlyDashboardDb } from "<repo>/cli/src/dashboard/DashboardDb.js";
 * import { buildJourneys } from "<repo>/cli/src/dashboard/JourneysQuery.js";
 * await withReadonlyDashboardDb(async (db) => {
 *   const m = buildJourneys(db, { kind: "all" }, 0, Date.now());
 *   const v = m.journeys.map((j) => j.durationMinutes).filter((x): x is number => x !== null).sort((a, b) => a - b);
 *   const q = (p: number) => v[Math.floor((v.length - 1) * p)];
 *   console.log("journeys total:", m.journeys.length, "| with measured activity:", v.length);
 *   console.log("p50", q(0.5), "| p75", q(0.75), "| p90", q(0.9), "| p95", q(0.95), "| max", v[v.length - 1]);
 * }, { dbPath: ... });
 * ```
 *
 * Output:
 * ```
 * journeys total: 229 | with measured activity: 13
 * p50 270 | p75 330 | p90 690 | p95 1035 | max 1275
 * ```
 *
 * `FEATURE_WORK_MINUTES` is the journey-level p50 (already a multiple of 15).
 * The old literal (45) was calibrated against `sessions.duration_ms`, which
 * overstated activity by 7.6-26x — 45 of those inflated minutes is roughly 3
 * real ones, so the threshold admitted essentially every measured journey.
 *
 * n=13 is a thin sample (13 of 229 journeys have any measured activity at
 * all) — re-derive this once duration coverage rises.
 */
export const FEATURE_WORK_MINUTES = 270;

/**
 * Ceiling `frictionIndex`'s duration term is normalized against, mirroring
 * `TURNS_CEILING` for the turns term. Set at the observed journey-level p90 so
 * the term spans its range on real journeys instead of hugging zero.
 *
 * Re-derived against the corrected population; see `FEATURE_WORK_MINUTES`'s
 * doc comment for the measurement script and its verbatim output (same run,
 * 2026-08-15, live dashboard database): p50 270 · p75 330 · p90 690 · p95
 * 1035 · max 1275, n=13 of 229 journeys.
 *
 * The old literal (600) turns out to sit close to this p90 of 690 — of the
 * three thresholds this file tuned against the inflated figure, this is the
 * one that barely moves.
 *
 * n=13 is a thin sample — re-derive this once duration coverage rises.
 */
export const FRICTION_DURATION_CEILING = 690;

/**
 * Chore cutoff for `deriveJourneyShape`'s duration-based rule, in ACTIVITY
 * minutes. EXCLUSIVE bound (`durationMinutes < CHORE_MAX_MINUTES`) over a
 * quantity that is always a multiple of 15, so only a single fifteen-minute
 * bucket — the shortest a journey can measure — actually qualifies.
 *
 * This is a SEPARATE constant from `FEATURE_WORK_MINUTES` on purpose, and is
 * not "the same floor read from the other end." The two call sites fail in
 * opposite directions: `isFeatureWork`'s floor silently EXCLUDES a sub-floor
 * journey from a median (a quiet omission), while `deriveJourneyShape`'s
 * chore rule AFFIRMATIVELY RENDERS "chore · clean land" for one (a
 * user-visible claim). Sharing one constant between an omission and an
 * assertion let `FEATURE_WORK_MINUTES` (270, the journey-level p50) leak into
 * the chore label, which mislabelled real work — do not "tidy" these back
 * into one constant later; the failure modes are why they must stay apart.
 *
 * Full ordered list of every journey on the live database carrying measured
 * activity, 2026-08-15 (same run as `FEATURE_WORK_MINUTES`'s measurement),
 * in minutes:
 *
 * ```
 * 15, 30, 45, 75, 105, 105, 255, 270, 300, 300, 330, 690, 1035, 1275
 * ```
 *
 * At the old shared floor of 270, the chore rule labelled the first SIX of
 * these a chore — including a 45-minute "Add the coaching journey model,
 * dashboards and review axis," clearly real engaged work. The only one that
 * reads as a genuine chore is the 15-minute "Bump vscode extension version to
 * 0.99.5," and `CHORE_TITLE` already catches that one on the word "bump" —
 * this rule is a backstop for a short journey whose title happens not to
 * match, not the primary signal. The 30-minute journey in the list above
 * ("Fix child position keying and dedupe transcript link") is a real fix, not
 * trivia, which is why the bound sits at 30 (exclusive) rather than 45 or
 * higher — it must admit 15 and reject everything above it.
 */
export const CHORE_MAX_MINUTES = 30;

/**
 * Ranks JOURNEYS by how rough they were. Deliberately has no per-person variant
 * and no aggregate caller: rolling this up to a person number would be the
 * composite score the coaching contract forbids, arriving by the side door.
 *
 * Turns is included alongside duration for the same reason `journeys.js`'s
 * work bar encodes turns instead of minutes (§5 of the spec): duration is
 * measurable on a small minority of journeys, turns on the majority, so a
 * duration-only score is silently blind on almost every journey it ranks. An
 * unknown value — for either term — contributes nothing rather than zero. The
 * score alone cannot say whether a low number means "smooth" or "unmeasured",
 * so every caller pairs it with the availability descriptors when presenting
 * a result.
 */
export function frictionIndex(journey: JourneyMetricsInput): number {
	return (journey.durationMinutes ?? 0) / FRICTION_DURATION_CEILING + (journey.turns ?? 0) / TURNS_CEILING;
}

const NON_FEATURE_SHAPES: ReadonlySet<JourneyShapeKind> = new Set<JourneyShapeKind>(["chore", "docs"]);

/**
 * Feature work: `FEATURE_WORK_MINUTES` or more of activity, and not a chore or
 * docs pass. Raw medians over everything would crown the typo fixes.
 *
 * An unknown duration FAILS the test. The threshold exists to keep trivia out
 * of medians, so a journey that cannot be shown to clear it must not count.
 * Locally that is most journeys (13 of 229 have any measured activity at
 * all), which is the honest reading and not a bug — see the spec's §3.2 for
 * the way out.
 */
export function isFeatureWork(journey: JourneyMetricsInput): boolean {
	if (journey.durationMinutes === null) return false;
	return journey.durationMinutes >= FEATURE_WORK_MINUTES && !NON_FEATURE_SHAPES.has(journey.shape.kind);
}

export interface JourneyShapeInput {
	readonly planFirst: boolean;
	readonly durationMinutes: number | null;
	readonly ticket: string | null;
	readonly title: string;
	/**
	 * Every commit's own title in this journey, including the one `title` was
	 * taken from (`title` is always the NEWEST commit's — see the query's "the
	 * newest commit names the journey" rule). Reading one commit's title as a
	 * claim about a whole multi-commit journey mislabels it: measured, ~12% of
	 * multi-commit branch-grouped journeys end in a docs/chore-shaped subject
	 * ("bump lockfile") while the rest of the branch is real feature work, and
	 * that trailing commit is exactly the one the "newest names it" rule
	 * surfaces. So the docs/chore TITLE match below only fires when EVERY
	 * commit's title agrees — which already covers the single-commit case,
	 * since there is then only one title, and it trivially agrees with itself.
	 */
	readonly commitTitles: ReadonlyArray<string>;
}

const CHORE_TITLE = /\b(bump|bumps|lockfile|dedupe|pin|pins|tidy|sweep|audit fix|release notes)\b/i;
const DOCS_TITLE = /\b(docs?|readme|changelog)\b/i;

function everyTitleMatches(pattern: RegExp, titles: ReadonlyArray<string>): boolean {
	return titles.length > 0 && titles.every((title) => pattern.test(title));
}

/**
 * Derives the journey's shape label. Kept here rather than stored so the query
 * and the UI cannot disagree about what a journey is.
 *
 * Shapes label journeys, never people.
 */
export function deriveJourneyShape(input: JourneyShapeInput): JourneyShape {
	// The cloud's `blocked` branch keys off `waitShare`, which is never
	// measurable locally, so it cannot fire here. The kind stays in the union
	// so a future wait signal is a population and not a redesign.
	if (everyTitleMatches(DOCS_TITLE, input.commitTitles)) {
		return { kind: "docs", label: "docs pass" };
	}
	// An unknown duration does NOT downgrade a journey to a chore: the title is
	// the only evidence left, and guessing "chore" from silence mislabels real
	// work as trivia. The duration-based chore rule is independent of the
	// title check above — a genuinely short journey is a chore regardless of
	// what any one commit's subject says. It deliberately uses
	// CHORE_MAX_MINUTES, not FEATURE_WORK_MINUTES: this rule AFFIRMS a
	// user-visible "chore" label, while isFeatureWork's floor only OMITS a
	// journey from a median — an assertion and an omission must not share one
	// threshold, or a floor picked for the omission (the journey-level p50)
	// ends up asserting "chore" on real work far above what "short" means.
	if (
		everyTitleMatches(CHORE_TITLE, input.commitTitles) ||
		(input.durationMinutes !== null && input.durationMinutes < CHORE_MAX_MINUTES)
	) {
		return { kind: "chore", label: "chore · clean land" };
	}
	return input.planFirst
		? { kind: "plan-first", label: "plan-first · clean land" }
		: { kind: "straight-to-execute", label: "straight to execute · clean land" };
}

/** A journey worth featuring has something to learn from: a plan or a decision. */
function hasSubstance(journey: JourneyMetricsInput): boolean {
	return journey.planFirst || journey.decisionCount > 0;
}

function lowestFriction<T extends JourneyMetricsInput>(list: ReadonlyArray<T>): T | undefined {
	return list.reduce<T | undefined>(
		(best, journey) => (best === undefined || frictionIndex(journey) < frictionIndex(best) ? journey : best),
		undefined,
	);
}

/**
 * The featured "smoothest" journey: friction-minimum among journeys WITH
 * SUBSTANCE, falling back to plain friction-minimum only when nothing
 * qualifies. Pure friction-min crowns a 5-minute typo fix, which is smooth the
 * way an empty road is smooth.
 */
export function pickSmoothest<T extends JourneyMetricsInput>(list: ReadonlyArray<T>): T | undefined {
	return lowestFriction(list.filter(hasSubstance)) ?? lowestFriction(list);
}

/** The featured "hardest" journey. */
export function pickHardest<T extends JourneyMetricsInput>(list: ReadonlyArray<T>): T | undefined {
	return list.reduce<T | undefined>(
		(worst, journey) => (worst === undefined || frictionIndex(journey) > frictionIndex(worst) ? journey : worst),
		undefined,
	);
}
