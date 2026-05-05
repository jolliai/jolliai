/**
 * Reads conversation turns from Copilot CLI's session-store SQLite database.
 *
 * Each `turns` row contains a (user_message, assistant_response) pair, ordered
 * by turn_index. We expand each row into two TranscriptEntry items, skipping
 * empty/null messages.
 *
 * Cursor tracks the row count of fully-consumed turns (zero-based index into the
 * ORDER BY turn_index result set). Equivalent to turn_index when Copilot's
 * UNIQUE(session_id, turn_index) constraint prevents gaps; if turns are ever
 * deleted leaving holes, a value-based resume query would be needed instead.
 */

import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { withSqliteDb } from "./SqliteHelpers.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

const log = createLogger("CopilotTranscriptReader");

export async function readCopilotTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const { dbPath, sessionId } = parseSyntheticPath(transcriptPath);
	const startIndex = cursor?.lineNumber ?? 0;
	const cutoffMs = beforeTimestamp ? Date.parse(beforeTimestamp) : undefined;

	try {
		const { rawEntries, totalTurns, lastConsumedIndex } = await withSqliteDb(dbPath, (db) => {
			const rows = db
				.prepare(
					`SELECT turn_index, user_message, assistant_response, timestamp
					 FROM turns
					 WHERE session_id = :sessionId
					 ORDER BY turn_index ASC`,
				)
				.all({ sessionId }) as ReadonlyArray<{
				turn_index: number;
				user_message: string | null;
				assistant_response: string | null;
				timestamp: string | null;
			}>;
			const newRows = rows.slice(startIndex);
			const out: TranscriptEntry[] = [];
			let consumed = startIndex;
			for (let i = 0; i < newRows.length; i++) {
				const r = newRows[i];
				if (cutoffMs !== undefined && r.timestamp) {
					const ts = Date.parse(r.timestamp);
					if (Number.isFinite(ts) && ts > cutoffMs) break;
				}
				const tsIso = r.timestamp && Number.isFinite(Date.parse(r.timestamp)) ? r.timestamp : undefined;
				if (typeof r.user_message === "string" && r.user_message.trim().length > 0) {
					out.push({ role: "human", content: r.user_message, timestamp: tsIso });
				}
				if (typeof r.assistant_response === "string" && r.assistant_response.trim().length > 0) {
					out.push({ role: "assistant", content: r.assistant_response, timestamp: tsIso });
				}
				consumed = startIndex + i + 1;
			}
			return { rawEntries: out, totalTurns: rows.length, lastConsumedIndex: consumed };
		});

		const entries = mergeConsecutiveEntries(rawEntries);
		const newCursor: TranscriptCursor = {
			transcriptPath,
			lineNumber: beforeTimestamp ? lastConsumedIndex : totalTurns,
			updatedAt: new Date().toISOString(),
		};
		const totalLinesRead = lastConsumedIndex - startIndex;
		log.info(
			"Read Copilot session %s: %d new turns, %d entries (index %d→%d)",
			sessionId.substring(0, 8),
			totalLinesRead,
			entries.length,
			startIndex,
			newCursor.lineNumber,
		);
		return { entries, newCursor, totalLinesRead };
	} catch (error: unknown) {
		log.error("Failed to read Copilot session %s: %s", sessionId.substring(0, 8), (error as Error).message);
		throw new Error(`Cannot read Copilot session: ${sessionId}`);
	}
}

function parseSyntheticPath(transcriptPath: string): { dbPath: string; sessionId: string } {
	const hashIndex = transcriptPath.lastIndexOf("#");
	if (hashIndex === -1) {
		throw new Error(`Invalid Copilot transcript path (missing #sessionId): ${transcriptPath}`);
	}
	const dbPath = transcriptPath.substring(0, hashIndex);
	const sessionId = transcriptPath.substring(hashIndex + 1);
	if (dbPath.length === 0 || sessionId.length === 0) {
		throw new Error(`Invalid Copilot transcript path (empty dbPath or sessionId): ${transcriptPath}`);
	}
	return { dbPath, sessionId };
}
