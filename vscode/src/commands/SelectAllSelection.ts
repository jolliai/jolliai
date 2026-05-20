/**
 * SelectAllSelection — Select / Deselect All commands for the Conversations
 * and Plans & Notes panels.
 *
 * These mirror `FilesStore.toggleSelectAll()` / the existing
 * `jollimemory.selectAllFiles` command: if every visible row is currently
 * selected, the command deselects all; otherwise it selects all.
 *
 * Discriminating plan rows from note rows
 * ──────────────────────────────────────
 * `PlansTreeProvider.serialize()` returns `SerializedTreeItem[]` where the
 * `contextValue` field is `"plan"`, `"note"`, or `"linearissue"` (set by the
 * corresponding Item constructor in PlansTreeProvider). The `id` field carries
 * the raw plan slug (for plans) or note id (for notes) — no prefix. We switch
 * on `contextValue` to split the two groups. Linear-issue rows have no
 * exclusion key and are skipped. This is **Option B-variant (contextValue)**:
 * the discriminator already existed on SerializedTreeItem; no schema changes
 * were needed.
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
 * Flip selection state for all visible plans AND notes in one shot.
 * Linear-issue rows have no exclusion key and are ignored.
 * The "all selected" check spans both groups together (matching FilesStore
 * behaviour which considers the combined visible set).
 */
export async function selectAllPlansAndNotesCommand(
	ctx: SelectAllCtx,
): Promise<void> {
	// serialize() output: contextValue is "plan" | "note" | "linearissue";
	// id is the raw plan slug (for plans) or note id (for notes).
	const rows = ctx.plansProvider.serialize();
	const planRows = rows.filter((r) => r.contextValue === "plan");
	const noteRows = rows.filter((r) => r.contextValue === "note");
	const planKeys = planRows.map((r) => r.id);
	const noteKeys = noteRows.map((r) => r.id);

	const visibleSelectable = [...planRows, ...noteRows];
	// `isSelected !== false` because "absence of a record means included".
	const allCurrentlySelected =
		visibleSelectable.length > 0 &&
		visibleSelectable.every((r) => r.isSelected !== false);
	const target = allCurrentlySelected;

	await setAllExcluded(ctx.cwd, "plans", planKeys, target);
	await setAllExcluded(ctx.cwd, "notes", noteKeys, target);
	await ctx.plansProvider.refreshExclusions();
	await ctx.onChanged();
}
