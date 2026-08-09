import type { ToolCallCount, TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { ToolUseTally } from "./ToolNameClassify.js";
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
	/**
	 * Tool calls this message made, already classified by the caller — the shape
	 * of a tool record is per-source, so extraction stays in the reader that
	 * knows the file format. Aggregated over the CONSUMED slice only, which is
	 * why it rides on the message rather than being returned separately.
	 */
	readonly tools?: ReadonlyArray<ToolCallCount>;
}

/** Per-source knobs for {@link buildClineReadResult}. */
export interface ClineReadOptions {
	/**
	 * Whether this source's transcripts can express tool calls at all.
	 *
	 * Opt-in rather than inferred from `messages`, because the two Cline sources
	 * genuinely differ and the difference is invisible in the data: the CLI
	 * writes Anthropic `tool_use` blocks, while the VS Code extension replays
	 * tool results as PROSE inside `role:"user"` text (`[execute_command …]
	 * Result:` — the `TOOL_RESULT_RE` the extension reader strips). Prose is a
	 * heuristic signal, so the extension reports nothing and is deliberately
	 * absent from `TOOL_RECORDING_SOURCES`. Inferring capability from "no tools
	 * found" would turn that into the false claim "called no tools".
	 */
	readonly recordsTools?: boolean;
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
	options?: ClineReadOptions,
): TranscriptReadResult {
	const startIndex = cursor?.lineNumber ?? 0;
	const beforeMs = beforeTimestamp ? Date.parse(beforeTimestamp) : undefined;

	const rawEntries: TranscriptEntry[] = [];
	const tally = new ToolUseTally();
	let lastConsumedIndex = startIndex;
	for (let i = startIndex; i < messages.length; i++) {
		const msg = messages[i];
		if (beforeMs !== undefined && typeof msg.ts === "number" && msg.ts > beforeMs) break;
		lastConsumedIndex = i + 1;
		// Before the role/content skip: a message that is nothing but tool calls
		// produces no entry, and its calls would be lost below.
		for (const tool of msg.tools ?? []) tally.add(tool, tool.calls);
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
	return {
		entries,
		newCursor,
		totalLinesRead: lastConsumedIndex - startIndex,
		...(options?.recordsTools ? { toolUse: tally.values() } : {}),
	};
}

/** Empty result preserving the caller's cursor index (used on unreadable file). */
export function emptyClineReadResult(transcriptPath: string, cursor?: TranscriptCursor | null): TranscriptReadResult {
	return {
		entries: [],
		newCursor: { transcriptPath, lineNumber: cursor?.lineNumber ?? 0, updatedAt: new Date().toISOString() },
		totalLinesRead: 0,
	};
}
