/**
 * Display-side grouping for plans that share a logical name across commit
 * snapshots.
 *
 * A plan committed to a commit is archived under a slug that embeds the commit
 * hash (`<base-slug>-<shortHash>`, shortHash = commitHash.substring(0,8) — see
 * QueueWorker.associatePlansWithCommit). Squash consolidation hoists every
 * source commit's plans into the consolidated commit, so the same logical plan
 * appears once per source commit — same title, different slug. {@link annotatePlans}
 * flags which of those snapshots the detail panel should present as the latest.
 *
 * **The grouping RULE is not defined here.** `planBaseKey` and `byUpdatedAtDesc`
 * are imported from the CLI's `core/push/PlanGrouping`, which is the single source
 * of truth the push path (`latestPlanPerName`, and the `plan` context kind's
 * `baseKey`/`tiebreak`) also uses. This file used to carry its own copies plus a
 * `latestPlanPerName` of its own; once the push path moved to the shared context-kind
 * registry those copies had no production caller left and were two divergeable
 * spellings of one rule — a drift would have the panel group snapshots the push path
 * keeps apart. Only the panel-specific annotation lives here now.
 */

import { byUpdatedAtDesc, planBaseKey } from "../../../cli/src/core/push/PlanGrouping.js";
import type { PlanReference } from "../../../cli/src/Types.js";

/** A plan plus its standing among its same-named siblings. */
export interface AnnotatedPlan {
	readonly plan: PlanReference;
	/** True only when this plan is the newest of a group with more than one snapshot. */
	readonly isLatest: boolean;
	/** True when this plan belongs to a multi-snapshot group but is NOT the latest. */
	readonly isSuperseded: boolean;
}

/**
 * Sorts plans newest-first and flags the latest snapshot of each same-named
 * group. `isLatest` is set only when the group has more than one snapshot, so a
 * lone plan never gets a "Latest" badge.
 */
export function annotatePlans(plans: ReadonlyArray<PlanReference>): ReadonlyArray<AnnotatedPlan> {
	const sorted = [...plans].sort(byUpdatedAtDesc);
	const seenOnce = new Set<string>();
	const duplicatedKeys = new Set<string>();
	for (const p of sorted) {
		const key = planBaseKey(p.slug);
		if (seenOnce.has(key)) {
			duplicatedKeys.add(key);
		}
		seenOnce.add(key);
	}
	const latestSeen = new Set<string>();
	return sorted.map((plan) => {
		const key = planBaseKey(plan.slug);
		const isFirstOfGroup = !latestSeen.has(key);
		latestSeen.add(key);
		const hasSiblings = duplicatedKeys.has(key);
		const isLatest = isFirstOfGroup && hasSiblings;
		const isSuperseded = !isFirstOfGroup && hasSiblings;
		return { plan, isLatest, isSuperseded };
	});
}
