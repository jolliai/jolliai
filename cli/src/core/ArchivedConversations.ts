/**
 * ArchivedConversations — how a memory's archived transcripts collapse into
 * the conversation rows a surface displays.
 *
 * This is a product rule, not presentation: it decides what counts as ONE
 * conversation (`source:sessionId`, merged across the transcript files of an
 * amend/squash chain), what order its turns are in, which stored sessions are
 * not conversations at all (the usage-only carriers), and therefore what the
 * message count is. It lived only in the VS Code webview
 * (`SummaryWebviewPanel.readGroupedArchivedSessions`), which is why the
 * dashboard — reading `transcript_sessions ⋈ sessions` instead — showed the
 * same conversation three times for a three-commit amend chain and counted the
 * whole LIVE session's messages rather than the slice archived into the memory.
 *
 * Both surfaces now call this, so "how many conversations does this memory
 * have" has one answer.
 */

import type { StoredSession, StoredTranscript, TranscriptEntry } from "../Types.js";

/**
 * Epoch ms of the first parseable `timestamp` in a session slice, or undefined
 * when no entry carries one.
 *
 * A single conversation (`source:sessionId`) can be split across several
 * commits' transcript files. The transcript set for a consolidated memory is NOT
 * in time order, but each slice is internally time-ordered and a session's
 * slices occupy disjoint time ranges (the cursor consumes turns in order), so
 * ordering slices by their first known timestamp reconstructs the true
 * conversation order.
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

/** One conversation of a memory: a session, its owning commit, and its merged turns. */
export interface GroupedArchivedSession {
	readonly session: StoredSession;
	/** First-seen owning commit hash — the row's `data-hash` in the webview. */
	readonly hash: string;
	readonly entries: ReadonlyArray<TranscriptEntry>;
}

export interface GroupedArchivedSessions {
	/** `source:sessionId` keys in first-seen order; every key resolves in `grouped`. */
	readonly order: ReadonlyArray<string>;
	readonly grouped: ReadonlyMap<string, GroupedArchivedSession>;
}

/** The identity two slices must share to be the same conversation. */
export function archivedSessionKey(session: Pick<StoredSession, "sessionId" | "source">): string {
	// The "claude" default mirrors the reader's back-compat for a source-less
	// stored session (matches getSourceLabel + the detach match key).
	return `${session.source ?? "claude"}:${session.sessionId}`;
}

/**
 * Collapses a memory's transcript files into one entry per `source:sessionId`,
 * keeping first-seen order and the first-seen owning commit hash.
 *
 * @param transcripts commitHash → the archived transcript stored for it.
 */
export function groupArchivedSessions(
	transcripts: Iterable<readonly [string, StoredTranscript]>,
): GroupedArchivedSessions {
	const order: string[] = [];
	// Collect each session's slices separately first; a consolidated memory's
	// transcript set is NOT in time order, so appending slices as they arrive
	// would interleave turns wrong. We sort the slices chronologically below.
	const collected = new Map<string, { session: StoredSession; hash: string; parts: TranscriptEntry[][] }>();
	for (const [commitHash, transcript] of transcripts) {
		for (const session of transcript.sessions) {
			const key = archivedSessionKey(session);
			const slice = [...(session.entries ?? [])];
			const existing = collected.get(key);
			if (existing) {
				existing.parts.push(slice);
			} else {
				order.push(key);
				collected.set(key, { session, hash: commitHash, parts: [slice] });
			}
		}
	}

	// Reassemble each session by ordering its slices by first-known timestamp,
	// then flattening — so the conversation list and its row-click transcript
	// show turns in true chronological order (slices with no parseable timestamp
	// keep first-seen order via the 0-return comparator).
	const grouped = new Map<string, GroupedArchivedSession>();
	for (const key of order) {
		const g = collected.get(key) as NonNullable<ReturnType<typeof collected.get>>;
		const sorted = [...g.parts].sort((a, b) => {
			const ta = sliceStartTime(a);
			const tb = sliceStartTime(b);
			if (ta === undefined || tb === undefined) return 0;
			return ta - tb;
		});
		const entries = sorted.flat();
		// Hide every zero-turn conversation, uniformly. Two disk shapes produce one:
		// a usage-only carrier (empty entries + recorded usage) the queue worker
		// persists so `detach` has a per-session subtrahend, and an overlay-emptied
		// shell (empty entries + no usage) a "Mark All as Deleted" edit left behind
		// on memories written before the storage-layer drop (buildStoredTranscript)
		// existed. Neither has a readable turn, so a row for either would render as
		// an empty `0 msgs` conversation — noise the user asked us to suppress. This
		// also cleans up already-generated memories with no data migration.
		//
		// Filtered on the MERGED entries, not per slice: a conversation split across
		// commits can legitimately be entry-less in one transcript and real in
		// another, and that one must still show. Detach reads `transcript.sessions`
		// directly and is deliberately NOT filtered — the record stays subtractable.
		if (entries.length === 0) continue;
		grouped.set(key, { session: g.session, hash: g.hash, entries });
	}
	// Keep `order` in sync with `grouped` so callers can zip the two without
	// hitting a key that was just filtered out.
	return { order: order.filter((key) => grouped.has(key)), grouped };
}
