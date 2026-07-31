/**
 * PlansDataService — merges plans + notes + multi-source references into a single display order.
 *
 * Zero VSCode imports, zero mutable state.
 */

import type { NoteInfo, PlanInfo, ReferenceInfo, SkillInfo } from "../../Types.js";

export type PlansOrNote =
	| { readonly kind: "plan"; readonly plan: PlanInfo }
	| { readonly kind: "note"; readonly note: NoteInfo }
	| { readonly kind: "reference"; readonly reference: ReferenceInfo }
	| { readonly kind: "skills"; readonly skills: ReadonlyArray<SkillInfo> };

// biome-ignore lint/complexity/noStaticOnlyClass: namespace of pure helpers
export class PlansDataService {
	/**
	 * Merge plans + notes + references + skills into one list sorted by
	 * `lastModified` descending. Ties break by kind ("plan" → "note" →
	 * "reference" → "skills") for deterministic output. Skills rank last: they are
	 * metadata about how the work happened, while the other kinds are what it was
	 * about.
	 *
	 * **Skills collapse into AT MOST ONE entry**, unlike the other three kinds.
	 * The Context list is a fixed-height panel that plans, notes and references
	 * already compete for, and a session routinely enters a dozen skills — one row
	 * each would crowd out the artifacts the work is actually about. This mirrors
	 * the same call already made for the Memory Bank's visible layer, which stores
	 * one `skills--<hash8>.md` aggregate per commit rather than one file per skill.
	 * The group sorts by its NEWEST member so a skill entered just now pulls the
	 * row up, the same way any other freshly-touched artifact rises.
	 */
	static mergeByLastModified(
		plans: ReadonlyArray<PlanInfo>,
		notes: ReadonlyArray<NoteInfo>,
		references: ReadonlyArray<ReferenceInfo> = [],
		skills: ReadonlyArray<SkillInfo> = [],
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
		if (skills.length > 0) {
			items.push({ kind: "skills", skills: [...skills] });
		}
		items.sort((a, b) => {
			const aMod = lastModifiedOf(a);
			const bMod = lastModifiedOf(b);
			const d = new Date(bMod).getTime() - new Date(aMod).getTime();
			if (d !== 0) {
				return d;
			}
			// Deterministic tie-break: plan < note < reference < skills
			if (a.kind !== b.kind) {
				return kindRank(a.kind) - kindRank(b.kind);
			}
			return 0;
		});
		return items;
	}

	/** Returns true when no plans, notes, references or skills exist. */
	static isEmpty(
		plans: ReadonlyArray<PlanInfo>,
		notes: ReadonlyArray<NoteInfo>,
		references: ReadonlyArray<ReferenceInfo> = [],
		skills: ReadonlyArray<SkillInfo> = [],
	): boolean {
		return (
			plans.length === 0 &&
			notes.length === 0 &&
			references.length === 0 &&
			skills.length === 0
		);
	}
}

// Both helpers below switch EXHAUSTIVELY rather than falling through to a default.
// They used to end in a bare `return item.reference…` / `return 2`, which silently
// mis-read any newly added kind as a reference — the wrong timestamp field (so
// `undefined` at runtime) and the wrong sort rank, with nothing failing to compile.
function lastModifiedOf(item: PlansOrNote): string {
	switch (item.kind) {
		case "plan":
			return item.plan.lastModified;
		case "note":
			return item.note.lastModified;
		case "reference":
			return item.reference.lastModified;
		// The group's own timestamp is its newest member's — see the collapse note
		// on mergeByLastModified. Reduced rather than indexed at [0] because the
		// incoming array's order is the registry's, not a sorted one.
		case "skills":
			return item.skills.reduce((newest, s) => (s.lastModified > newest ? s.lastModified : newest), "");
	}
}

function kindRank(kind: PlansOrNote["kind"]): number {
	switch (kind) {
		case "plan":
			return 0;
		case "note":
			return 1;
		case "reference":
			return 2;
		case "skills":
			return 3;
	}
}
