/**
 * Small pure helpers that derive coarse signal-size metrics from a
 * {@link StoredTranscript}. Shared by the two thin generateSummary compositions —
 * {@link file://./CommitSummarizer.ts} (durable per-commit) and
 * {@link file://./CheckpointCapture.ts} (volatile pre-commit) — which both need
 * the same entry/turn counts and branch probe. Extracted so the role-detection
 * heuristic lives in exactly one place and the two siblings can't drift.
 */

import type { StoredTranscript } from "../Types.js";

/** Counts every entry across every session — the input-signal size handed to the LLM. */
export function countTranscriptEntries(t: StoredTranscript): number {
	let n = 0;
	for (const s of t.sessions) n += s.entries.length;
	return n;
}

/** Counts human-role entries (a rough proxy for how many turns the user typed).
 *  `TranscriptEntry.role` is normalised to `"human" | "assistant"` upstream, so
 *  human turns are exactly the `"human"` entries. */
export function countConversationTurns(t: StoredTranscript): number {
	let n = 0;
	for (const s of t.sessions) {
		for (const e of s.entries) {
			if (e.role === "human") n++;
		}
	}
	return n;
}

/** First non-empty branch across the transcript sessions, if any. */
export function firstBranch(t: StoredTranscript): string | undefined {
	for (const s of t.sessions) {
		if (s.gitBranch) return s.gitBranch;
	}
	return undefined;
}
