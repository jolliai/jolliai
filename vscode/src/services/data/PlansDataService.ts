/**
 * PlansDataService — merges plans + notes + multi-source references into a single display order.
 *
 * Zero VSCode imports, zero mutable state.
 */

import type { NoteInfo, PlanInfo, ReferenceInfo } from "../../Types.js";

export type PlansOrNote =
	| { readonly kind: "plan"; readonly plan: PlanInfo }
	| { readonly kind: "note"; readonly note: NoteInfo }
	| { readonly kind: "reference"; readonly reference: ReferenceInfo };

// biome-ignore lint/complexity/noStaticOnlyClass: namespace of pure helpers
export class PlansDataService {
	/**
	 * Merge plans + notes + references into a single list sorted by `lastModified` descending.
	 * Ties are broken by kind ("plan" → "note" → "reference") for deterministic output.
	 */
	static mergeByLastModified(
		plans: ReadonlyArray<PlanInfo>,
		notes: ReadonlyArray<NoteInfo>,
		references: ReadonlyArray<ReferenceInfo> = [],
	): Array<PlansOrNote> {
		const items: Array<PlansOrNote> = [];
		for (const p of plans) {
			items.push({ kind: "plan", plan: p });
		}
		for (const n of notes) {
			items.push({ kind: "note", note: n });
		}
		for (const e of references) {
			items.push({ kind: "reference", reference: e });
		}
		items.sort((a, b) => {
			const aMod = lastModifiedOf(a);
			const bMod = lastModifiedOf(b);
			const d = new Date(bMod).getTime() - new Date(aMod).getTime();
			if (d !== 0) {
				return d;
			}
			// Deterministic tie-break: plan < note < reference
			if (a.kind !== b.kind) {
				return kindRank(a.kind) - kindRank(b.kind);
			}
			return 0;
		});
		return items;
	}

	/** Returns true when no plans, notes, or references exist. */
	static isEmpty(
		plans: ReadonlyArray<PlanInfo>,
		notes: ReadonlyArray<NoteInfo>,
		references: ReadonlyArray<ReferenceInfo> = [],
	): boolean {
		return plans.length === 0 && notes.length === 0 && references.length === 0;
	}
}

function lastModifiedOf(item: PlansOrNote): string {
	if (item.kind === "plan") return item.plan.lastModified;
	if (item.kind === "note") return item.note.lastModified;
	return item.reference.lastModified;
}

function kindRank(kind: PlansOrNote["kind"]): number {
	if (kind === "plan") return 0;
	if (kind === "note") return 1;
	return 2;
}
