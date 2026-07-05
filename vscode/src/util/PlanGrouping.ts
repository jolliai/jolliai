/**
 * Grouping helpers for plans that share a logical name across commit snapshots.
 *
 * A plan committed to a commit is archived under a slug that embeds the commit
 * hash (`<base-slug>-<shortHash>`, shortHash = commitHash.substring(0,8) — see
 * QueueWorker.associatePlansWithCommit). Squash consolidation hoists every
 * source commit's plans into the consolidated commit, so the same logical plan
 * appears once per source commit — same title, different slug. These helpers
 * collapse those snapshots by base name and pick the latest, and are the single
 * source of truth shared by the detail-panel display (annotatePlans) and the
 * push-to-Jolli path (latestPlanPerName) so the two never drift.
 */

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
 * Strips a trailing archived commit-hash suffix (`-<8 hex>`) to get the base
 * name. Committed snapshots (`refactor-auth-a1b2c3d4`) and an uncommitted base
 * (`refactor-auth`) collapse to the same key.
 */
export function planBaseKey(slug: string): string {
	return slug.replace(/-[0-9a-f]{8}$/, "");
}

/**
 * Compares two plans newest-first by `updatedAt`, tiebroken by `slug` so the
 * order is deterministic across the standalone re-renders the panel performs.
 * Exported so the cross-commit dedup in LiveShareController picks the same
 * "latest" snapshot this module's display + push paths do — a disagreement drops
 * a plan's markdown link on an equal-timestamp tie.
 */
export function byUpdatedAtDesc(a: PlanReference, b: PlanReference): number {
	if (a.updatedAt !== b.updatedAt) {
		return a.updatedAt < b.updatedAt ? 1 : -1;
	}
	return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
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

/**
 * Returns exactly one plan per base name — the latest snapshot — preserving the
 * newest-first order. Used to avoid pushing duplicate same-named documents to
 * Jolli.
 *
 * Same-named plans share an identical server push identity (same title, branch,
 * relativePath, commit — the slug is NOT sent), so `jolliPlanDocId` is the only
 * thing that tells the server to UPDATE rather than CREATE. When a previously
 * pushed older snapshot carries the docId but the latest snapshot does not, the
 * latest inherits that docId/url so the push updates the existing article
 * instead of creating a duplicate (which the server rejects → push failure).
 */
export function latestPlanPerName(plans: ReadonlyArray<PlanReference>): ReadonlyArray<PlanReference> {
	const sorted = [...plans].sort(byUpdatedAtDesc);
	// Newest already-pushed docId/url per base name (first hit wins = newest).
	const pushedDoc = new Map<string, { docId: number; url: string | undefined }>();
	for (const plan of sorted) {
		const key = planBaseKey(plan.slug);
		if (plan.jolliPlanDocId !== undefined && !pushedDoc.has(key)) {
			pushedDoc.set(key, { docId: plan.jolliPlanDocId, url: plan.jolliPlanDocUrl });
		}
	}
	const seen = new Set<string>();
	const result: PlanReference[] = [];
	for (const plan of sorted) {
		const key = planBaseKey(plan.slug);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		if (plan.jolliPlanDocId === undefined) {
			const inherited = pushedDoc.get(key);
			if (inherited) {
				result.push({ ...plan, jolliPlanDocId: inherited.docId, jolliPlanDocUrl: inherited.url });
				continue;
			}
		}
		result.push(plan);
	}
	return result;
}
