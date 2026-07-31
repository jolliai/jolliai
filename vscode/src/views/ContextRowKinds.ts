/**
 * ContextRowKinds — the per-kind decision table for a Context row, shared by both
 * webviews that render one.
 *
 * Every per-kind decision a Context row makes — badge, checkbox class, id
 * attribute, the message the checkbox posts, what a plain click opens, which
 * inline buttons exist, and what the edit button is called — is resolved from
 * here.
 *
 * This replaced a chain of ternaries that ended in 'plan'. That default silently
 * rendered any newly added kind as a plan: wrong badge, a jm-plan-check checkbox,
 * and a click that posted togglePlanSelection carrying the new kind's key — so the
 * user's exclusion landed in the WRONG set and had no effect, while looking like it
 * worked. An unknown kind now resolves to null and simply gets no checkbox, which
 * is visible rather than silently wrong.
 *
 * It lives in its own module, injected into both script builders as JSON the same
 * way `SOURCE_META` is, because the two surfaces had *independent* ternary chains
 * with independent defaults: the sidebar's ended in 'plan', the Next Memory
 * panel's ended in 'reference'. The skills row shipped hitting both — an 'Edit
 * Plan' tooltip on one surface, and on the other a checkbox posting
 * `branch:toggleReferenceSelection` with the `__skills__` sentinel as a mapKey.
 * Adding a kind must be a one-line change HERE, not a hunt through two files and
 * seven chains.
 *
 * 'skills' is the aggregate row standing for every skill this session (one row,
 * not one per skill — a session routinely enters a dozen). It carries no artifact
 * id, so idKey/attr are null and the dispatcher skips the id field; and it has no
 * inline actions, because there is no single document to edit, pin, or remove —
 * the checkbox is the only write.
 *
 * Fields not every surface consumes are still declared for every kind: the Next
 * Memory panel ignores `cls` / `attr` / `pinKind`, but a kind that omitted them
 * would break the sidebar the moment someone reused the table there.
 */
export interface ContextRowKind {
	/** Badge variant — drives the letter and the `.mem-ctx-badge--<kind>` hue. */
	readonly badge: string;
	/** Sidebar checkbox class. */
	readonly cls: string;
	/** Sidebar row id attribute; null for a kind with no artifact id. */
	readonly attr: string | null;
	/** Message posted by the include/exclude checkbox. */
	readonly msg: string;
	/** Field name carrying the id on `msg`; null when the kind has no id. */
	readonly idKey: string | null;
	/** Message posted by a plain row click. */
	readonly openMsg: string;
	/** Field name carrying the id on `openMsg`; null when the kind has no id. */
	readonly openIdKey: string | null;
	/** Inline hover actions, in order. Empty for a kind with nothing to act on. */
	readonly actions: ReadonlyArray<"pin" | "edit" | "remove">;
	readonly editLabel: string | null;
	readonly editCmd: string | null;
	readonly editMsg: string | null;
	readonly removeCmd: string | null;
	readonly pinKind: string | null;
}

export const CONTEXT_ROW_KINDS: Readonly<Record<string, ContextRowKind>> = {
	plan: {
		badge: "plan",
		cls: "jm-plan-check",
		attr: "data-plan-id",
		msg: "branch:togglePlanSelection",
		idKey: "planId",
		openMsg: "branch:openPlan",
		openIdKey: "planId",
		actions: ["pin", "edit", "remove"],
		editLabel: "Edit Plan",
		editCmd: "jollimemory.editPlan",
		editMsg: null,
		removeCmd: "jollimemory.removePlan",
		pinKind: "plan",
	},
	note: {
		badge: "note",
		cls: "jm-note-check",
		attr: "data-note-id",
		msg: "branch:toggleNoteSelection",
		idKey: "noteId",
		openMsg: "branch:openNote",
		openIdKey: "noteId",
		actions: ["pin", "edit", "remove"],
		editLabel: "Edit Note",
		editCmd: "jollimemory.editNote",
		editMsg: null,
		removeCmd: "jollimemory.removeNote",
		pinKind: "note",
	},
	reference: {
		badge: "reference",
		cls: "jm-reference-check",
		attr: "data-reference-key",
		msg: "branch:toggleReferenceSelection",
		idKey: "mapKey",
		openMsg: "branch:openReferencePreview",
		openIdKey: "mapKey",
		actions: ["pin", "edit", "remove"],
		editLabel: "Edit Markdown",
		editCmd: null,
		editMsg: "branch:openReferenceMarkdown",
		removeCmd: "jollimemory.ignoreReference",
		pinKind: "reference",
	},
	skills: {
		badge: "skill",
		cls: "jm-skill-check",
		attr: null,
		msg: "branch:toggleSkillSelection",
		idKey: null,
		openMsg: "branch:openSkillsAggregate",
		openIdKey: null,
		actions: [],
		editLabel: null,
		editCmd: null,
		editMsg: null,
		removeCmd: null,
		pinKind: null,
	},
};
