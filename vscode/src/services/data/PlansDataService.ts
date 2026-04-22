/**
 * PlansDataService — merges plans + notes into a single display order.
 *
 * Zero VSCode imports, zero mutable state.
 */

import type { NoteInfo, PlanInfo } from "../../Types.js";

export type PlansOrNote =
	| { readonly kind: "plan"; readonly plan: PlanInfo }
	| { readonly kind: "note"; readonly note: NoteInfo };

// biome-ignore lint/complexity/noStaticOnlyClass: namespace of pure helpers
export class PlansDataService {
	/**
	 * Merge plans + notes into a single list sorted by `lastModified` descending.
	 * Ties are broken by kind ("plan" before "note") for deterministic output.
	 */
	static mergeByLastModified(
		plans: ReadonlyArray<PlanInfo>,
		notes: ReadonlyArray<NoteInfo>,
	): Array<PlansOrNote> {
		const items: Array<PlansOrNote> = [];
		for (const p of plans) {
			items.push({ kind: "plan", plan: p });
		}
		for (const n of notes) {
			items.push({ kind: "note", note: n });
		}
		items.sort((a, b) => {
			const aMod =
				a.kind === "plan" ? a.plan.lastModified : a.note.lastModified;
			const bMod =
				b.kind === "plan" ? b.plan.lastModified : b.note.lastModified;
			const d = new Date(bMod).getTime() - new Date(aMod).getTime();
			if (d !== 0) {
				return d;
			}
			// Deterministic tie-break
			if (a.kind !== b.kind) {
				return a.kind === "plan" ? -1 : 1;
			}
			return 0;
		});
		return items;
	}

	/** Returns true when neither plans nor notes exist. */
	static isEmpty(
		plans: ReadonlyArray<PlanInfo>,
		notes: ReadonlyArray<NoteInfo>,
	): boolean {
		return plans.length === 0 && notes.length === 0;
	}
}
