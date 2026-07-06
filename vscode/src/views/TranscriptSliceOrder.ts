import type { TranscriptEntry } from "../../../cli/src/Types.js";

/**
 * Epoch ms of the first parseable `timestamp` in a session slice, or undefined
 * when no entry carries one.
 *
 * A single conversation (`source:sessionId`) can be split across several
 * commits' transcript files. The transcript set for a consolidated memory is NOT
 * in time order, but each slice is internally time-ordered and a session's
 * slices occupy disjoint time ranges (the cursor consumes turns in order), so
 * ordering slices by their first known timestamp reconstructs the true
 * conversation order. Shared by the sidebar Working Memory card
 * (`SidebarWebviewProvider.readArchivedSessions`) and the summary panel's inline
 * Conversations list (`SummaryWebviewPanel.readGroupedArchivedSessions`) so both
 * surfaces reassemble the same order — the single copy is the point.
 *
 * Callers should sort with a stable comparator that returns 0 when either side
 * is undefined, so slices with no parseable timestamp (legacy data) keep their
 * first-seen order rather than jumping to the front.
 */
export function sliceStartTime(entries: ReadonlyArray<TranscriptEntry>): number | undefined {
	for (const entry of entries) {
		if (entry.timestamp === undefined) continue;
		const ms = Date.parse(entry.timestamp);
		if (Number.isFinite(ms)) return ms;
	}
	return undefined;
}
