/**
 * Gemini Transcript Reader
 *
 * Parses Gemini CLI session files (single JSON, not JSONL).
 * Sessions are stored at: ~/.gemini/tmp/<project_hash>/chats/session-*.json
 *
 * Each file is a JSON object (ConversationRecord) with a `messages[]` array.
 * Message types: "user", "gemini", "info", "error", "warning".
 * Only "user" and "gemini" messages are extracted as transcript entries.
 *
 * Content format (PartListUnion):
 *   - String: plain text content
 *   - Array of Part objects: [{ text: "..." }, ...]
 *
 * Cursor tracks by message index (reuses TranscriptCursor.lineNumber field)
 * to support incremental reading across multiple AfterAgent hook invocations.
 */

import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

const log = createLogger("GeminiTranscriptReader");

/** Gemini message record structure (subset of fields we care about) */
interface GeminiMessageRecord {
	readonly id: string;
	readonly type: string;
	readonly timestamp: string;
	readonly content: GeminiContent;
}

/** Gemini content can be a string, an array of parts, or absent */
type GeminiContent = string | ReadonlyArray<GeminiPart> | undefined;

/** A single content part in a Gemini message */
interface GeminiPart {
	readonly text?: string;
}

/** Gemini ConversationRecord structure (subset of fields we care about) */
interface GeminiConversationRecord {
	readonly sessionId: string;
	readonly messages: ReadonlyArray<GeminiMessageRecord>;
}

/**
 * Reads a Gemini CLI session JSON file and returns parsed transcript entries.
 * Supports cursor-based resumption by tracking the number of messages already processed.
 *
 * @param transcriptPath - Absolute path to the session JSON file
 * @param cursor - Optional cursor indicating how many messages were already processed
 * @param beforeTimestamp - Optional ISO 8601 cutoff: only return entries with timestamp ≤ this value.
 *   Used by the queue-driven Worker to attribute transcript entries to the correct commit.
 *   When provided, the cursor advances only to the last consumed message (not EOF).
 * @returns Parsed entries and a new cursor for the next read
 */
export async function readGeminiTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const startIndex = cursor?.lineNumber ?? 0;

	let content: string;
	try {
		content = await readFile(transcriptPath, "utf-8");
	} catch (error: unknown) {
		log.error("Failed to read Gemini session file: %s", (error as Error).message);
		throw new Error(`Cannot read Gemini session: ${transcriptPath}`);
	}

	let record: GeminiConversationRecord;
	try {
		record = JSON.parse(content) as GeminiConversationRecord;
	} catch (error: unknown) {
		log.error("Failed to parse Gemini session JSON: %s", (error as Error).message);
		throw new Error(`Invalid Gemini session JSON: ${transcriptPath}`);
	}

	const messages = record.messages ?? [];
	const newMessages = messages.slice(startIndex);
	const rawEntries: TranscriptEntry[] = [];
	const cutoffTime = beforeTimestamp ? new Date(beforeTimestamp).getTime() : undefined;
	let lastConsumedIndex = startIndex;

	for (let i = 0; i < newMessages.length; i++) {
		const msg = newMessages[i];

		// If a time cutoff is specified, stop consuming when we hit messages after it
		if (cutoffTime && msg.timestamp) {
			const msgTime = new Date(msg.timestamp).getTime();
			if (msgTime > cutoffTime) {
				break;
			}
		}

		const entry = parseGeminiMessage(msg);
		if (entry) {
			rawEntries.push(entry);
		}
		lastConsumedIndex = startIndex + i + 1;
	}

	// Merge consecutive same-role entries (Gemini may split responses across messages)
	const entries = mergeConsecutiveEntries(rawEntries);

	// When beforeTimestamp is set, advance cursor only to the last consumed message.
	// Without beforeTimestamp (legacy/CLI path), advance to end for backward compatibility.
	const newCursor: TranscriptCursor = {
		transcriptPath,
		lineNumber: beforeTimestamp ? lastConsumedIndex : messages.length,
		updatedAt: new Date().toISOString(),
	};

	const totalLinesRead = lastConsumedIndex - startIndex;
	log.info(
		"Read Gemini session: %d new messages, %d entries extracted (index %d→%d)",
		totalLinesRead,
		entries.length,
		startIndex,
		newCursor.lineNumber,
	);

	return { entries, newCursor, totalLinesRead };
}

/** Returns null for non-conversational message types (info, error, warning). */
function parseGeminiMessage(msg: GeminiMessageRecord): TranscriptEntry | null {
	const timestamp = msg.timestamp;

	if (msg.type === "user") {
		const text = extractTextContent(msg.content);
		return text ? { role: "human", content: text, timestamp } : null;
	}

	if (msg.type === "gemini") {
		const text = extractTextContent(msg.content);
		return text ? { role: "assistant", content: text, timestamp } : null;
	}

	// Skip info, error, warning, and other message types
	return null;
}

/**
 * Extracts text content from Gemini's PartListUnion format.
 *
 * Handles three formats:
 *   - String: returned directly
 *   - Array of Part objects: text fields are joined with newlines
 *   - Undefined/null: returns null
 */
function extractTextContent(content: GeminiContent): string | null {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	if (Array.isArray(content)) {
		const textParts: string[] = [];
		for (const part of content) {
			if (part !== null && typeof part === "object" && typeof part.text === "string") {
				const trimmed = part.text.trim();
				if (trimmed.length > 0) {
					textParts.push(trimmed);
				}
			}
		}
		return textParts.length > 0 ? textParts.join("\n") : null;
	}

	return null;
}
