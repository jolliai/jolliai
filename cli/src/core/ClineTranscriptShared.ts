import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

/** Structured scan error shared by the Cline CLI + extension sources (non-SQLite). */
export interface ClineScanError {
	readonly kind: "parse" | "fs" | "schema" | "unknown";
	readonly message: string;
}

/** A source message after file-shape + text extraction has been normalized away. */
export interface NormalizedMessage {
	readonly role: "human" | "assistant" | undefined;
	readonly content: string;
	readonly ts?: number;
}

/** Map a raw Cline role string to a TranscriptEntry role (unknown → undefined → dropped). */
export function mapClineRole(role: string | undefined): "human" | "assistant" | undefined {
	if (role === "assistant") return "assistant";
	if (role === "user") return "human";
	return undefined;
}

/**
 * Shared read logic for both Cline sources. `messages` are already normalized
 * (role mapped, text extracted, `<user_input>` unwrapped by the caller as needed).
 * Cursor.lineNumber is repurposed as a message index. When `beforeTimestamp` is
 * set, stops at the first message past the cutoff and advances the cursor only to
 * the last consumed index (commit-attribution mode); otherwise advances to end.
 */
export function buildClineReadResult(
	transcriptPath: string,
	messages: ReadonlyArray<NormalizedMessage>,
	cursor: TranscriptCursor | null | undefined,
	beforeTimestamp: string | undefined,
): TranscriptReadResult {
	const startIndex = cursor?.lineNumber ?? 0;
	const beforeMs = beforeTimestamp ? Date.parse(beforeTimestamp) : undefined;

	const rawEntries: TranscriptEntry[] = [];
	let lastConsumedIndex = startIndex;
	for (let i = startIndex; i < messages.length; i++) {
		const msg = messages[i];
		if (beforeMs !== undefined && typeof msg.ts === "number" && msg.ts > beforeMs) break;
		lastConsumedIndex = i + 1;
		if (msg.role === undefined || msg.content.length === 0) continue;
		const timestamp = typeof msg.ts === "number" ? new Date(msg.ts).toISOString() : undefined;
		rawEntries.push(
			timestamp ? { role: msg.role, content: msg.content, timestamp } : { role: msg.role, content: msg.content },
		);
	}

	const entries = mergeConsecutiveEntries(rawEntries);
	const newCursor: TranscriptCursor = {
		transcriptPath,
		lineNumber: beforeTimestamp ? lastConsumedIndex : messages.length,
		updatedAt: new Date().toISOString(),
	};
	return { entries, newCursor, totalLinesRead: lastConsumedIndex - startIndex };
}

/** Empty result preserving the caller's cursor index (used on unreadable file). */
export function emptyClineReadResult(transcriptPath: string, cursor?: TranscriptCursor | null): TranscriptReadResult {
	return {
		entries: [],
		newCursor: { transcriptPath, lineNumber: cursor?.lineNumber ?? 0, updatedAt: new Date().toISOString() },
		totalLinesRead: 0,
	};
}
