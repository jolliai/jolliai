/**
 * PlansDataService — merges plans + notes + linear issues into a single display order.
 *
 * Zero VSCode imports, zero mutable state.
 */

import type { LinearIssueInfo, NoteInfo, PlanInfo } from "../../Types.js";

export type PlansOrNote =
	| { readonly kind: "plan"; readonly plan: PlanInfo }
	| { readonly kind: "note"; readonly note: NoteInfo }
	| { readonly kind: "linearissue"; readonly linearIssue: LinearIssueInfo };

// biome-ignore lint/complexity/noStaticOnlyClass: namespace of pure helpers
export class PlansDataService {
	/**
	 * Merge plans + notes + linear issues into a single list sorted by `lastModified` descending.
	 * Ties are broken by kind ("plan" → "note" → "linearissue") for deterministic output.
	 */
	static mergeByLastModified(
		plans: ReadonlyArray<PlanInfo>,
		notes: ReadonlyArray<NoteInfo>,
		linearIssues: ReadonlyArray<LinearIssueInfo> = [],
	): Array<PlansOrNote> {
		const items: Array<PlansOrNote> = [];
		for (const p of plans) {
			items.push({ kind: "plan", plan: p });
		}
		for (const n of notes) {
			items.push({ kind: "note", note: n });
		}
		for (const l of linearIssues) {
			items.push({ kind: "linearissue", linearIssue: l });
		}
		items.sort((a, b) => {
			const aMod = lastModifiedOf(a);
			const bMod = lastModifiedOf(b);
			const d = new Date(bMod).getTime() - new Date(aMod).getTime();
			if (d !== 0) {
				return d;
			}
			// Deterministic tie-break: plan < note < linearissue
			if (a.kind !== b.kind) {
				return kindRank(a.kind) - kindRank(b.kind);
			}
			return 0;
		});
		return items;
	}

	/** Returns true when no plans, notes, or linear issues exist. */
	static isEmpty(
		plans: ReadonlyArray<PlanInfo>,
		notes: ReadonlyArray<NoteInfo>,
		linearIssues: ReadonlyArray<LinearIssueInfo> = [],
	): boolean {
		return (
			plans.length === 0 && notes.length === 0 && linearIssues.length === 0
		);
	}
}

function lastModifiedOf(item: PlansOrNote): string {
	if (item.kind === "plan") return item.plan.lastModified;
	if (item.kind === "note") return item.note.lastModified;
	return item.linearIssue.lastModified;
}

function kindRank(kind: PlansOrNote["kind"]): number {
	if (kind === "plan") return 0;
	if (kind === "note") return 1;
	return 2;
}
