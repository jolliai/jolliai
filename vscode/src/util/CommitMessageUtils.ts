/**
 * Shared utilities for merging commit messages.
 *
 * Used by both Amend (merge HEAD message + new AI message) and
 * Squash (merge N commit messages into one).
 *
 * The merge logic itself lives in `cli/src/core/CommitMessageMerge.ts` (the
 * `jolli generate squash-message` bridge command uses it as the no-provider /
 * LLM-failure fallback, so `cli/src` is its single home). It is re-exported
 * here so extension-side importers keep their existing paths; the cross-package
 * import resolves at esbuild bundle time like every other `cli/src` module.
 */

export { mergeCommitMessages, TICKET_PATTERN } from "../../../cli/src/core/CommitMessageMerge.js";

/**
 * Reference-row ticket pattern — anchored to the START and case-sensitive.
 *
 * `findTicketInContext` scans arbitrary reference titles, so the loose,
 * unanchored, case-insensitive `TICKET_PATTERN` would misread any
 * `LETTERS-DIGITS` fragment inside a title as a ticket (e.g. "Migrate to UTF-8
 * encoding" → "UTF-8"). Real Linear/Jira ids (`KAN-5`, `PROJ-123`) are
 * upper-case and sit at the FRONT of the `<nativeId> — <title>` label, so we
 * anchor to the leading id segment and require ≥2 upper-case letters.
 */
const REFERENCE_TICKET_PATTERN = /^[A-Z]{2,}-\d+\b/;

/**
 * Finds a ticket identifier among the currently included Context rows, for
 * the Next Memory review panel's "Detected ticket" line. Only looks at
 * reference rows (not plans/notes), and skips a row only when it is
 * explicitly deselected (`isSelected === false`) — when selection mode is off
 * every row has `isSelected` undefined and counts as included. This is a
 * lookup over already-curated context, not a new detection mechanism.
 */
export function findTicketInContext(
	items: ReadonlyArray<{ readonly label: string; readonly contextValue?: string; readonly isSelected?: boolean }>,
): string | undefined {
	for (const item of items) {
		if (item.contextValue !== "reference" || item.isSelected === false) continue;
		// Reference labels are `<nativeId> — <title>`; only the leading id segment
		// can be a ticket. Matching the whole label (or the free-text title) would
		// misread a fragment like "UTF-8" as a ticket, so test only the id segment
		// with the anchored pattern.
		const idSegment = item.label.split(" — ")[0];
		const match = REFERENCE_TICKET_PATTERN.exec(idSegment);
		if (match) return match[0].toUpperCase();
	}
	return undefined;
}
