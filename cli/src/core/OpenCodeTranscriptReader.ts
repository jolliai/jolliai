/**
 * OpenCode Transcript Reader
 *
 * Reads messages from an OpenCode SQLite session and returns transcript entries.
 * Follows the GeminiTranscriptReader pattern: a dedicated async reader that
 * bypasses the JSONL TranscriptParser interface.
 *
 * OpenCode stores data in a global SQLite database at ~/.local/share/opencode/opencode.db.
 * Messages are in the `message` table with a `data` JSON column containing the role.
 * Parts are in a separate `part` table, each with a `data` JSON column.
 *
 * Only "text" type parts are extracted. Tool calls/results, patches, reasoning,
 * and finish parts are skipped.
 *
 * Cursor tracks by message count (reuses TranscriptCursor.lineNumber field),
 * same pattern as GeminiTranscriptReader.
 */

import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { withSqliteDb } from "./SqliteHelpers.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

const log = createLogger("OpenCodeTranscriptReader");

/** A single part row's parsed data from the `part` table */
interface OpenCodePartData {
	readonly type: string;
	readonly text?: string;
	readonly [key: string]: unknown;
}

/**
 * Reads messages from an OpenCode SQLite session and returns parsed transcript entries.
 * Supports cursor-based resumption by tracking the count of messages already processed.
 *
 * @param transcriptPath - Synthetic path: "<dbPath>#<sessionId>"
 * @param cursor - Optional cursor indicating how many messages were already processed
 * @param beforeTimestamp - Optional ISO 8601 cutoff: only return entries with timestamp ≤ this value.
 *   Used by the queue-driven Worker to attribute transcript entries to the correct commit.
 *   When provided, the cursor advances only to the last consumed message (not EOF).
 * @returns Parsed entries and a new cursor for the next read
 */
export async function readOpenCodeTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const { dbPath, sessionId } = parseSyntheticPath(transcriptPath);
	const startIndex = cursor?.lineNumber ?? 0;
	const cutoffTime = beforeTimestamp ? new Date(beforeTimestamp).getTime() : undefined;

	try {
		const { rawEntries, totalMessages, lastConsumedIndex } = await withSqliteDb(dbPath, (db) => {
			// Query messages with their parts via JOIN
			const rows = db
				.prepare(
					`SELECT m.id as msg_id, m.data as msg_data, m.time_created,
					        p.data as part_data
					 FROM message m
					 LEFT JOIN part p ON p.message_id = m.id
					 WHERE m.session_id = :sessionId
					 ORDER BY m.time_created ASC, p.time_created ASC`,
				)
				.all({ sessionId }) as ReadonlyArray<{
				msg_id: string;
				msg_data: string;
				time_created: number;
				part_data: string | null;
			}>;

			// Group rows by message ID
			const messageMap = new Map<string, { msgData: string; timeCreated: number; parts: string[] }>();
			const messageOrder: string[] = [];

			for (const row of rows) {
				if (!messageMap.has(row.msg_id)) {
					messageMap.set(row.msg_id, { msgData: row.msg_data, timeCreated: row.time_created, parts: [] });
					messageOrder.push(row.msg_id);
				}

				if (row.part_data) {
					messageMap.get(row.msg_id)?.parts.push(row.part_data);
				}
			}

			// Skip already-processed messages (cursor-based incremental read)
			const newMessageIds = messageOrder.slice(startIndex);
			const rawEntries: TranscriptEntry[] = [];
			let lastConsumedIndex = startIndex;

			for (let i = 0; i < newMessageIds.length; i++) {
				const msg = messageMap.get(newMessageIds[i]) as {
					msgData: string;
					timeCreated: number;
					parts: string[];
				};

				// If a time cutoff is specified, stop consuming when we hit messages after it
				if (cutoffTime && msg.timeCreated > cutoffTime) {
					break;
				}

				const entry = parseOpenCodeMessage(msg.msgData, msg.parts, msg.timeCreated);
				if (entry) {
					rawEntries.push(entry);
				}
				lastConsumedIndex = startIndex + i + 1;
			}

			return { rawEntries, totalMessages: messageOrder.length, lastConsumedIndex };
		});

		const entries = mergeConsecutiveEntries(rawEntries);

		// When beforeTimestamp is set, advance cursor only to the last consumed message.
		// Without beforeTimestamp (legacy/CLI path), advance to end for backward compatibility.
		const newCursor: TranscriptCursor = {
			transcriptPath,
			lineNumber: beforeTimestamp ? lastConsumedIndex : totalMessages,
			updatedAt: new Date().toISOString(),
		};

		const totalLinesRead = lastConsumedIndex - startIndex;
		log.info(
			"Read OpenCode session %s: %d new messages, %d entries extracted (index %d→%d)",
			sessionId.substring(0, 8),
			totalLinesRead,
			entries.length,
			startIndex,
			newCursor.lineNumber,
		);

		return { entries, newCursor, totalLinesRead };
	} catch (error: unknown) {
		log.error("Failed to read OpenCode session %s: %s", sessionId.substring(0, 8), (error as Error).message);
		throw new Error(`Cannot read OpenCode session: ${sessionId}`);
	}
}

/**
 * Parses a synthetic transcript path into its DB path and session ID components.
 * Format: "<dbPath>#<sessionId>"
 */
function parseSyntheticPath(transcriptPath: string): { dbPath: string; sessionId: string } {
	const hashIndex = transcriptPath.lastIndexOf("#");
	if (hashIndex === -1) {
		throw new Error(`Invalid OpenCode transcript path (missing #sessionId): ${transcriptPath}`);
	}
	const dbPath = transcriptPath.substring(0, hashIndex);
	const sessionId = transcriptPath.substring(hashIndex + 1);
	if (dbPath.length === 0 || sessionId.length === 0) {
		throw new Error(`Invalid OpenCode transcript path (empty dbPath or sessionId): ${transcriptPath}`);
	}
	return { dbPath, sessionId };
}

/**
 * Parses a single OpenCode message into a TranscriptEntry.
 * Extracts role from message.data JSON, text from part.data JSONs.
 * Returns null for non-conversational roles (system, tool).
 */
function parseOpenCodeMessage(
	msgDataJson: string,
	partDataJsons: string[],
	createdAtMs: number,
): TranscriptEntry | null {
	// Guard against schema drift: a non-finite time_created would make
	// new Date().toISOString() throw RangeError and abort the whole session read.
	if (!Number.isFinite(createdAtMs)) {
		log.debug("Skipping OpenCode message with non-finite time_created");
		return null;
	}
	let msgData: { role?: string };
	try {
		msgData = JSON.parse(msgDataJson) as { role?: string };
	} catch {
		log.debug("Failed to parse message data JSON");
		return null;
	}

	const role = msgData.role;
	let mappedRole: "human" | "assistant";
	if (role === "user") {
		mappedRole = "human";
	} else if (role === "assistant") {
		mappedRole = "assistant";
	} else {
		return null;
	}

	const text = extractTextFromParts(partDataJsons);
	if (!text) {
		return null;
	}

	const timestamp = new Date(createdAtMs).toISOString();
	return { role: mappedRole, content: text, timestamp };
}

/**
 * Extracts text content from OpenCode part data JSON strings.
 *
 * Each part row has a `data` column with JSON like:
 *   { "type": "text", "text": "..." }
 *
 * Only "text" type parts are extracted. Tool, patch, reasoning, finish,
 * and image_url parts are skipped.
 */
function extractTextFromParts(partDataJsons: string[]): string | null {
	const textParts: string[] = [];

	for (const json of partDataJsons) {
		let partData: OpenCodePartData;
		try {
			partData = JSON.parse(json) as OpenCodePartData;
		} catch {
			log.debug("Failed to parse part data JSON");
			continue;
		}

		if (partData.type === "text" && typeof partData.text === "string") {
			const trimmed = partData.text.trim();
			if (trimmed.length > 0) {
				textParts.push(trimmed);
			}
		}
	}

	return textParts.length > 0 ? textParts.join("\n") : null;
}
