import { createLogger } from "../Logger.js";
import type { ConversationTokenBreakdown } from "../Types.js";
import { readTranscript } from "./TranscriptReader.js";

const log = createLogger("ConversationTokenTotals");

export interface ConversationTokenEntry {
	readonly source: string;
	readonly transcriptPath: string;
}

export interface ConversationTokenTotalsResult extends ConversationTokenBreakdown {
	readonly total: number;
	/** How many entries actually contributed a non-zero read (Claude only, read succeeded). */
	readonly reportingCount: number;
	readonly totalCount: number;
}

/**
 * Sums real per-conversation token usage for the Next Memory review panel's
 * token meter. Only Claude transcripts carry a `usage` field per turn (see
 * TranscriptParser.ts); other sources have no data to read, so they count
 * toward `totalCount` but never `reportingCount`. A read failure for one
 * entry (moved/deleted file, permission error) degrades that entry to zero
 * rather than failing the whole total — this is a best-effort meter, not a
 * billing figure.
 */
export async function sumConversationTokens(
	entries: ReadonlyArray<ConversationTokenEntry>,
): Promise<ConversationTokenTotalsResult> {
	let input = 0;
	let output = 0;
	let cached = 0;
	let reportingCount = 0;

	// Each transcript read is independent file I/O whose results are only summed,
	// so read them concurrently — a multi-conversation selection would otherwise
	// serialize N reads on every debounced token-meter refresh. Per-entry failures
	// still degrade to zero (the catch keeps a moved/deleted file from failing the
	// whole total); allSettled is unnecessary because nothing here can reject.
	const breakdowns = await Promise.all(
		entries
			.filter((entry) => entry.source === "claude")
			.map(async (entry) => {
				try {
					return (await readTranscript(entry.transcriptPath)).usageBreakdown;
				} catch (err) {
					log.warn("Failed to read transcript for token totals: %s", entry.transcriptPath, err);
					return undefined;
				}
			}),
	);

	for (const b of breakdowns) {
		// readTranscript always returns a usageBreakdown object, so only a non-zero
		// total counts as "actually contributed a read" — otherwise a tool-only /
		// empty-window transcript would inflate reportingCount.
		if (b && b.input + b.output + b.cached > 0) {
			input += b.input;
			output += b.output;
			cached += b.cached;
			reportingCount++;
		}
	}

	return { input, output, cached, total: input + output + cached, reportingCount, totalCount: entries.length };
}
