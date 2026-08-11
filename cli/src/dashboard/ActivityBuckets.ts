/**
 * Quarter-hour activity bucketing — the one place a transcript's per-message
 * timestamps become the rows behind the concurrency figure.
 *
 * Kept apart from the collector because it is pure and is the only piece of
 * this feature with arithmetic worth pinning on its own.
 */

import type { TranscriptEntry } from "../Types.js";

/** Bucket width. 15 minutes: coarse enough that a pause mid-thought does not
 *  fragment a session, fine enough that "the same bucket" still reads as "at
 *  the same time" to a person. */
export const ACTIVITY_BUCKET_MS = 15 * 60 * 1000;

/**
 * The quarter-hour bucket starts a slice of transcript touched, deduped and
 * ascending.
 *
 * An EMPTY result means no entry carried a parseable timestamp — the caller
 * must turn that into an ABSENT `activityBuckets` field, never `[]`, so that a
 * source whose reader emits no timestamps is reported as uncovered rather than
 * as "used no agents". Entries without a timestamp are skipped individually, so
 * one malformed line cannot cost the rest of the session its buckets.
 */
export function bucketsFrom(entries: ReadonlyArray<TranscriptEntry>): ReadonlyArray<number> {
	const seen = new Set<number>();
	for (const e of entries) {
		if (!e.timestamp) continue;
		const at = Date.parse(e.timestamp);
		if (!Number.isFinite(at)) continue;
		seen.add(Math.floor(at / ACTIVITY_BUCKET_MS) * ACTIVITY_BUCKET_MS);
	}
	return [...seen].sort((a, b) => a - b);
}
