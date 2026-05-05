/**
 * Cursor Transcript Reader
 *
 * Reads Composer conversation messages from Cursor's global SQLite database
 * (state.vscdb) and returns transcript entries.
 *
 * Storage layout:
 *   - Table: `cursorDiskKV` with `key TEXT` and `value BLOB` columns.
 *   - `composerData:<composerId>` — JSON containing `fullConversationHeadersOnly`,
 *     an ordered list of `{ bubbleId, type }` objects representing the conversation
 *     message index.
 *   - `bubbleId:<composerId>:<bubbleId>` — JSON with the full bubble data:
 *     `{ type, text, createdAt, ... }`.
 *
 * Bubble type → role mapping (empirically confirmed on real Cursor installs):
 *   1 → "human"   (user messages)
 *   2 → "assistant" (Cursor AI responses)
 *   other → skipped (system messages, tool calls, etc.)
 *
 * Cursor reuses `TranscriptCursor.lineNumber` to track bubble index, matching
 * the pattern used by OpenCodeTranscriptReader and GeminiTranscriptReader.
 */

import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { withSqliteDb } from "./SqliteHelpers.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

const log = createLogger("CursorTranscriptReader");

/**
 * Maps Cursor bubble.type numeric values to transcript roles.
 * Centralized constant — update here when Cursor adds new bubble types.
 *
 *   1 → "human"     (user messages in the Composer chat)
 *   2 → "assistant" (AI-generated responses)
 */
const BUBBLE_TYPE_TO_ROLE: Readonly<Record<number, "human" | "assistant">> = {
	1: "human",
	2: "assistant",
};

interface ConversationHeader {
	readonly bubbleId: string;
	readonly type?: number;
}

interface ComposerDataRow {
	readonly fullConversationHeadersOnly?: ReadonlyArray<ConversationHeader>;
}

interface BubbleRow {
	readonly type?: number;
	readonly text?: string;
	readonly createdAt?: string;
}

/**
 * Reads messages from a Cursor Composer session and returns parsed transcript entries.
 * Supports cursor-based resumption by tracking the count of bubbles already processed.
 *
 * @param transcriptPath - Synthetic path: "<dbPath>#<composerId>"
 * @param cursor - Optional cursor indicating how many bubbles were already processed
 * @param beforeTimestamp - Optional ISO 8601 cutoff: only return entries with timestamp ≤ this value.
 *   Used by the queue-driven Worker to attribute transcript entries to the correct commit.
 *   When provided, the cursor advances only to the last consumed bubble (not EOF).
 * @returns Parsed entries and a new cursor for the next read
 */
export async function readCursorTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const { dbPath, composerId } = parseSyntheticPath(transcriptPath);
	const startIndex = cursor?.lineNumber ?? 0;
	const cutoffTime = beforeTimestamp ? Date.parse(beforeTimestamp) : undefined;

	try {
		const { rawEntries, totalBubbles, lastConsumedIndex } = await withSqliteDb(dbPath, (db) => {
			// Load the composer index — fullConversationHeadersOnly is an ordered list of bubbles
			const composerRow = db
				.prepare("SELECT value FROM cursorDiskKV WHERE key = ? LIMIT 1")
				.get(`composerData:${composerId}`) as { value: string } | undefined;

			if (!composerRow) {
				throw new Error(`Composer ${composerId} not found in database`);
			}

			let composer: ComposerDataRow;
			try {
				composer = JSON.parse(composerRow.value) as ComposerDataRow;
			} catch {
				throw new Error(`Failed to parse composerData JSON for ${composerId}`);
			}

			const headers: ReadonlyArray<ConversationHeader> = composer.fullConversationHeadersOnly ?? [];

			// Skip already-processed bubbles (cursor-based incremental read)
			const newHeaders = headers.slice(startIndex);
			const rawEntries: TranscriptEntry[] = [];
			let lastConsumedIndex = startIndex;

			for (let i = 0; i < newHeaders.length; i++) {
				const header = newHeaders[i];

				// Load the full bubble data for this header
				const bubbleRow = db
					.prepare("SELECT value FROM cursorDiskKV WHERE key = ? LIMIT 1")
					.get(`bubbleId:${composerId}:${header.bubbleId}`) as { value: string } | undefined;

				if (!bubbleRow) {
					// Bubble missing from DB — advance index but produce no entry
					lastConsumedIndex = startIndex + i + 1;
					continue;
				}

				let bubble: BubbleRow;
				try {
					bubble = JSON.parse(bubbleRow.value) as BubbleRow;
				} catch {
					log.debug("Failed to parse bubble JSON for %s:%s", composerId, header.bubbleId);
					lastConsumedIndex = startIndex + i + 1;
					continue;
				}

				const timestamp = bubble.createdAt;

				// If a time cutoff is specified, stop consuming when we hit bubbles after it
				if (cutoffTime !== undefined && timestamp !== undefined) {
					const bubbleTime = Date.parse(timestamp);
					if (Number.isFinite(bubbleTime) && bubbleTime > cutoffTime) {
						break;
					}
				}

				const type = bubble.type ?? header.type;
				const role = type !== undefined ? BUBBLE_TYPE_TO_ROLE[type] : undefined;
				const text = (bubble.text ?? "").trim();

				if (role !== undefined && text.length > 0) {
					rawEntries.push({ role, content: text, timestamp });
				}

				lastConsumedIndex = startIndex + i + 1;
			}

			return { rawEntries, totalBubbles: headers.length, lastConsumedIndex };
		});

		const entries = mergeConsecutiveEntries(rawEntries);

		// When beforeTimestamp is set, advance cursor only to the last consumed bubble.
		// Without beforeTimestamp (legacy/CLI path), advance to end for backward compatibility.
		const newCursor: TranscriptCursor = {
			transcriptPath,
			lineNumber: beforeTimestamp ? lastConsumedIndex : totalBubbles,
			updatedAt: new Date().toISOString(),
		};

		const totalLinesRead = lastConsumedIndex - startIndex;
		log.info(
			"Read Cursor session %s: %d new bubbles, %d entries extracted (index %d→%d)",
			composerId.substring(0, 8),
			totalLinesRead,
			entries.length,
			startIndex,
			newCursor.lineNumber,
		);

		return { entries, newCursor, totalLinesRead };
	} catch (error: unknown) {
		log.error("Failed to read Cursor session %s: %s", composerId.substring(0, 8), (error as Error).message);
		throw new Error(`Cannot read Cursor session: ${composerId}`);
	}
}

/**
 * Parses a synthetic transcript path into its DB path and composer ID components.
 * Format: "<dbPath>#<composerId>"
 */
function parseSyntheticPath(transcriptPath: string): { dbPath: string; composerId: string } {
	const hashIndex = transcriptPath.lastIndexOf("#");
	if (hashIndex === -1) {
		throw new Error(`Invalid Cursor transcript path (missing #composerId): ${transcriptPath}`);
	}
	const dbPath = transcriptPath.substring(0, hashIndex);
	const composerId = transcriptPath.substring(hashIndex + 1);
	if (dbPath.length === 0 || composerId.length === 0) {
		throw new Error(`Invalid Cursor transcript path (empty dbPath or composerId): ${transcriptPath}`);
	}
	return { dbPath, composerId };
}
