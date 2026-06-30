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
 * Narrow view of FilesStore used by the unified Current-Memory select-all:
 * `selectionSummary()` to read the visible-file selection state without
 * mutating it, `selectAll(target)` to apply one explicit target.
 */
export interface FilesSelectAll {
	selectionSummary(): { total: number; allSelected: boolean };
	selectAll(target: boolean): void;
}

export interface SelectAllCurrentMemoryCtx extends SelectAllCtx {
	readonly filesStore: FilesSelectAll;
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

/**
 * Unified select / deselect for the whole "Current Memory" block — flips
 * Conversations, Context (plans / notes / references) AND Files together so the
 * three sub-sections stay in sync from a single header button.
 *
 * The target is computed once across all three groups BEFORE any mutation:
 * only when every existing item in every group is currently selected does the
 * click deselect everything; in every other state (none, or mixed across
 * groups) it selects everything. This is what makes the combined button
 * deterministic — firing the three per-group toggle commands instead would let
 * each group flip on its own state and desync (e.g. conversations deselect
 * while files select). An empty group never blocks the all-selected verdict.
 */
export async function selectAllCurrentMemoryCommand(
	ctx: SelectAllCurrentMemoryCtx,
): Promise<void> {
	const { items: conversations } =
		await ctx.activeSessions.listWithDiagnostics();
	const conversationKeys = conversations.map((it) =>
		conversationKey(it.source, it.sessionId),
	);
	// `isSelected !== false` because "absence of a record means included".
	const conversationsAllSelected = conversations.every(
		(it) => it.isSelected !== false,
	);

	const rows = ctx.plansProvider.serialize();
	const planKeys = rows.filter((r) => r.contextValue === "plan").map((r) => r.id);
	const noteKeys = rows.filter((r) => r.contextValue === "note").map((r) => r.id);
	const referenceKeys = rows
		.filter((r) => r.contextValue === "reference")
		.map((r) => r.id);
	const contextAllSelected = rows.every((r) => r.isSelected !== false);

	const files = ctx.filesStore.selectionSummary();

	// All-selected only when every NON-empty group is fully selected and at
	// least one group has items (so the button is a no-op on a fully empty
	// Current Memory rather than flipping an imaginary "all").
	const total = conversations.length + rows.length + files.total;
	const allSelected =
		total > 0 &&
		(conversations.length === 0 || conversationsAllSelected) &&
		(rows.length === 0 || contextAllSelected) &&
		(files.total === 0 || files.allSelected);
	// excluded = allSelected → deselect everything; otherwise select everything.
	const target = allSelected;

	await setAllExcluded(ctx.cwd, "conversations", conversationKeys, target);
	await setAllExcluded(ctx.cwd, "plans", planKeys, target);
	await setAllExcluded(ctx.cwd, "notes", noteKeys, target);
	await setAllExcluded(ctx.cwd, "references", referenceKeys, target);
	await ctx.plansProvider.refreshExclusions();
	// Files use the inverse boolean — selectAll(true) = "select", whereas
	// setAllExcluded(true) = "exclude / deselect".
	ctx.filesStore.selectAll(!target);
	await ctx.onChanged();
}
