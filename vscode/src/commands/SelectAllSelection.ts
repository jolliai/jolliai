/**
 * SelectAllSelection — Select / Deselect All commands for the Conversations
 * and Plans & Notes panels.
 *
 * These mirror `FilesStore.toggleSelectAll()` / the existing
 * `jollimemory.selectAllFiles` command: if every visible row is currently
 * selected, the command deselects all; otherwise it selects all.
 *
 * Discriminating plan / note / reference rows
 * ───────────────────────────────────────────
 * `PlansTreeProvider.serialize()` returns `SerializedTreeItem[]` where the
 * `contextValue` field is `"plan"`, `"note"`, or `"reference"` (set by the
 * corresponding Item constructor in PlansTreeProvider). The `id` field carries
 * the raw plan slug (for plans), note id (for notes), or reference mapKey
 * `<source>:<nativeId>` (for references) — no prefix. We switch on
 * `contextValue` to split the three groups. This is
 * **Option B-variant (contextValue)**: the discriminator already existed on
 * SerializedTreeItem; no schema changes were needed.
 */

import {
	conversationKey,
	setAllExcluded,
} from "../../../cli/src/core/CommitSelectionStore.js";
import type { PlansTreeProvider } from "../providers/PlansTreeProvider.js";
import type { ActiveSessionsProvider } from "../services/ActiveSessionsProvider.js";

export interface SelectAllCtx {
	readonly cwd: string;
	readonly activeSessions: Pick<ActiveSessionsProvider, "listWithDiagnostics">;
	readonly plansProvider: Pick<
		PlansTreeProvider,
		"serialize" | "refreshExclusions"
	>;
	readonly onChanged: () => Promise<void> | void;
}

/**
 * Flip selection state for all visible conversations.
 * Matches `FilesStore.toggleSelectAll()` / the design spec: only when every
 * visible row is currently selected does the click deselect all; in every
 * other state (none selected, or mixed) it selects all.
 */
export async function selectAllConversationsCommand(
	ctx: SelectAllCtx,
): Promise<void> {
	const { items } = await ctx.activeSessions.listWithDiagnostics();
	const keys = items.map((it) => conversationKey(it.source, it.sessionId));
	// `isSelected !== false` because "absence of a record means included"
	// — undefined/true both count as selected.
	const allCurrentlySelected =
		items.length > 0 && items.every((it) => it.isSelected !== false);
	// Flip: only all-selected → exclude all; otherwise → clear exclusions.
	await setAllExcluded(ctx.cwd, "conversations", keys, allCurrentlySelected);
	await ctx.onChanged();
}

/**
 * Flip selection state for all visible plans, notes AND references in one shot.
 * The "all selected" check spans all three groups together (matching FilesStore
 * behaviour which considers the combined visible set). Name kept as
 * `selectAllPlansAndNotesCommand` for callsite stability — the panel header
 * label is "Plans & Notes" and renaming would ripple through command IDs.
 */
export async function selectAllPlansAndNotesCommand(
	ctx: SelectAllCtx,
): Promise<void> {
	// serialize() output: contextValue is "plan" | "note" | "reference";
	// id is the raw plan slug (plans), note id (notes), or mapKey (references).
	const rows = ctx.plansProvider.serialize();
	const planRows = rows.filter((r) => r.contextValue === "plan");
	const noteRows = rows.filter((r) => r.contextValue === "note");
	const referenceRows = rows.filter((r) => r.contextValue === "reference");
	const planKeys = planRows.map((r) => r.id);
	const noteKeys = noteRows.map((r) => r.id);
	const referenceKeys = referenceRows.map((r) => r.id);

	const visibleSelectable = [...planRows, ...noteRows, ...referenceRows];
	// `isSelected !== false` because "absence of a record means included".
	const allCurrentlySelected =
		visibleSelectable.length > 0 &&
		visibleSelectable.every((r) => r.isSelected !== false);
	const target = allCurrentlySelected;

	await setAllExcluded(ctx.cwd, "plans", planKeys, target);
	await setAllExcluded(ctx.cwd, "notes", noteKeys, target);
	await setAllExcluded(ctx.cwd, "references", referenceKeys, target);
	await ctx.plansProvider.refreshExclusions();
	await ctx.onChanged();
}
