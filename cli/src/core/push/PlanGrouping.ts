/**
 * PlanGrouping — same-name plan-snapshot collapsing, shared by the plan context
 * kind and by `JolliMemoryPushOrchestrator` (which re-exports these so its
 * existing importers, including the ide-bridge, are unaffected).
 *
 * Moved out of the orchestrator when the push path became table-driven: the plan
 * definition (in `kinds/index.ts`) needs them, and the orchestrator imports the
 * registry, so leaving them in the orchestrator would close an import cycle.
 * Behaviour is unchanged — these are the original implementations verbatim.
 */

import type { PlanReference } from "../../Types.js";
import { REF_HASH_SUFFIX } from "../RefMerge.js";

/**
 * Strips a trailing archived commit-hash suffix (`-<8 hex>`) to get the base
 * name. Committed snapshots (`refactor-auth-a1b2c3d4`) and an uncommitted base
 * (`refactor-auth`) collapse to the same key.
 *
 * Shares `REF_HASH_SUFFIX` with RefMerge's `baseKeyOf.plan` rather than re-spelling
 * the pattern: this is the same base key the amend hoist dedupes by, and a drift
 * between the two would have the push path group snapshots the summary kept apart.
 */
export function planBaseKey(slug: string): string {
	return slug.replace(REF_HASH_SUFFIX, "");
}

/**
 * Compares two plans newest-first by `updatedAt`, tiebroken by `slug` so the
 * order is deterministic across repeated calls.
 */
export function byUpdatedAtDesc(a: PlanReference, b: PlanReference): number {
	if (a.updatedAt !== b.updatedAt) {
		return a.updatedAt < b.updatedAt ? 1 : -1;
	}
	return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
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
	// Newest already-pushed docId/url per base name (first hit wins = newest). The
	// URL rides with the docId so the reuse gate downstream (`canReuseDocId`, which
	// reads the URL's origin) can tell which backend the inherited id belongs to.
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
				result.push({
					...plan,
					jolliPlanDocId: inherited.docId,
					jolliPlanDocUrl: inherited.url,
				});
				continue;
			}
		}
		result.push(plan);
	}
	return result;
}
