/**
 * Transcript Reader Module
 *
 * Parses Claude Code JSONL transcript files.
 * Transcripts are stored at: ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
 *
 * Each line is a JSON object. Only two entry types are recognized:
 *   - User messages: {"message":{"role":"user","content":"..."},"timestamp":"..."}
 *   - Assistant messages: {"message":{"role":"assistant","content":[{"type":"text","text":"..."}]},...}
 *
 * The JSONL file also contains many other entry types (system events, tool calls,
 * tool results, compaction summaries, streaming duplicates, etc.) that are silently
 * skipped. User messages are further cleaned by stripping IDE-injected tags and
 * filtering out system-generated noise (see SKIP_USER_PREFIXES).
 *
 * Consecutive entries with the same role (from streaming chunks of a single API
 * response) are merged into one entry to reduce noise and save token budget.
 *
 * The reader supports cursor-based resumption to only process new entries since the last read.
 */

import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult, TranscriptSource } from "../Types.js";
import type { TranscriptParser } from "./TranscriptParser.js";
import { ClaudeTranscriptParser } from "./TranscriptParser.js";

const log = createLogger("TranscriptReader");

/**
 * Maximum characters for the conversation context sent to the AI. Sized for the
 * summarizer's model (sonnet-class, ~200K-token window): at ~50K the older
 * sessions of a large multi-session squash were dropped entirely (only the
 * newest session's recent turns survived). 150K lets the full conversation of
 * almost any commit through while leaving headroom for the diff + plans AND
 * keeping the assembled prompt inside the direct-call wall-clock budget — a
 * whole-tree squash regenerate at the old 200K conversation + 200K diff was
 * overrunning the timeout and aborting. Exported so a regression test can pin
 * the value.
 */
export const DEFAULT_MAX_CHARS = 150000;

/**
 * User messages whose content starts with any of these prefixes are
 * system-generated noise, not real user input. They are silently skipped.
 *
 * - Skill injections: verbose plugin instructions injected by Claude Code
 * - Interruptions: system marker when user cancels mid-response
 */
const SKIP_USER_PREFIXES = ["Base directory for this skill:", "[Request interrupted by user"];

/**
 * Regex pattern matching IDE context tags injected by Claude Code.
 * These tags are metadata for the AI assistant, not real user input.
 *
 * Tags stripped:
 *   <system-reminder>, <ide_opened_file>, <ide_selection>,
 *   <local-command-caveat>, <command-name>, <command-message>,
 *   <command-args>, <local-command-stdout>
 *
 * Example — before:
 *   '<ide_opened_file>The user opened PostCommitHook.ts in the IDE.</ide_opened_file>\n'
 *   'I'm refactoring parseTranscriptLine and wondering if it parses toolUseResult.'
 *
 * After:
 *   'I'm refactoring parseTranscriptLine and wondering if it parses toolUseResult.'
 */
const IDE_TAG_PATTERN =
	/<(?:system-reminder|ide_opened_file|ide_selection|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>[\s\S]*?<\/(?:system-reminder|ide_opened_file|ide_selection|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>/g;

/**
 * Reads a transcript file and returns parsed entries since the cursor position.
 * If no cursor is provided, reads from the beginning.
 *
 * @param transcriptPath - Absolute path to the JSONL transcript file
 * @param cursor - Optional cursor indicating where to resume reading
 * @param parser - Optional strategy for parsing lines (defaults to Claude format)
 * @param beforeTimestamp - Optional ISO 8601 cutoff: only return entries with timestamp ≤ this value.
 *   Used by the queue-driven Worker to attribute transcript entries to the correct commit
 *   based on the queue entry's createdAt. When provided, the cursor advances only to the
 *   last consumed line (not EOF), so subsequent calls can read the remaining lines.
 * @returns Parsed entries and a new cursor for the next read
 */
export async function readTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	parser?: TranscriptParser,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const startLine = cursor?.lineNumber ?? 0;
	const activeParser = parser ?? new ClaudeTranscriptParser();
	const parseFn = (line: string, num: number) => activeParser.parseLine(line, num);

	let content: string;
	try {
		content = await readFile(transcriptPath, "utf-8");
	} catch (error: unknown) {
		log.error("Failed to read transcript file: %s", (error as Error).message);
		throw new Error(`Cannot read transcript: ${transcriptPath}`);
	}

	const lines = content.split("\n").filter((line) => line.trim().length > 0);

	// Process only new lines since cursor
	const newLines = lines.slice(startLine);
	const rawEntries: TranscriptEntry[] = [];
	const cutoffTime = beforeTimestamp ? new Date(beforeTimestamp).getTime() : undefined;
	let lastConsumedLineIndex = startLine; // Track how far we actually consumed
	let usageTokens = 0;

	for (let i = 0; i < newLines.length; i++) {
		const lineNum = startLine + i;
		const entry = parseFn(newLines[i], lineNum);
		if (entry) {
			// If a time cutoff is specified, stop consuming when we hit an entry after it.
			// Entries without timestamps are conservatively included (they were written
			// before the next timestamped entry, so they belong to the current window).
			if (cutoffTime && entry.timestamp) {
				const entryTime = new Date(entry.timestamp).getTime();
				if (entryTime > cutoffTime) {
					break; // Remaining lines belong to a later commit
				}
			}
			rawEntries.push(entry);
		}
		// Accumulate per-line token usage from the parser
		usageTokens += activeParser.parseUsageTokens?.(newLines[i], lineNum) ?? 0;
		// Only advance cursor for lines we actually processed (not past the break point)
		lastConsumedLineIndex = startLine + i + 1;
	}

	// Merge consecutive entries with the same role (streaming chunks from a single API response)
	const entries = mergeConsecutiveEntries(rawEntries);

	// When beforeTimestamp is set, advance cursor only to the last consumed line.
	// Without beforeTimestamp (legacy/CLI path), advance to EOF for backward compatibility.
	const newCursor: TranscriptCursor = {
		transcriptPath,
		lineNumber: beforeTimestamp ? lastConsumedLineIndex : lines.length,
		updatedAt: new Date().toISOString(),
	};

	return { entries, newCursor, totalLinesRead: lastConsumedLineIndex - startLine, usageTokens };
}

/**
 * Parses a single JSONL line into a TranscriptEntry.
 * Returns null for lines that can't be parsed or aren't relevant.
 *
 * Cleaning pipeline for user messages:
 *   1. Skip compaction summaries (isCompactSummary flag)
 *   2. Extract text content
 *   3. Strip IDE-injected tags (<system-reminder>, <ide_opened_file>, etc.)
 *   4. Skip skill injection prompts ("Base directory for this skill:")
 *
 * Assistant messages only keep text blocks — tool_use blocks are discarded
 * because the git diff already captures all code changes.
 */
export function parseTranscriptLine(line: string, lineNum: number): TranscriptEntry | null {
	try {
		const data = JSON.parse(line) as Record<string, unknown>;

		// Skip context compaction summary messages — these are injected by Claude Code
		// when the conversation is compressed and contain a lengthy session recap
		if (data.isCompactSummary === true) {
			log.debug("Skipping compaction summary at line %d", lineNum);
			return null;
		}

		// All recognized entries require a message object with a role
		if (!data.message || typeof data.message !== "object") {
			return null;
		}

		const msg = data.message as Record<string, unknown>;
		const role = msg.role;
		const timestamp = typeof data.timestamp === "string" ? data.timestamp : undefined;

		if (role === "user") {
			return parseUserMessage(msg, timestamp, lineNum);
		}

		if (role === "assistant") {
			const content = extractContent(msg.content)?.trim();
			return content ? { role: "assistant", content, timestamp } : null;
		}

		// Unknown role — skip
		return null;
	} catch (error: unknown) {
		log.debug("Failed to parse transcript line %d: %s", lineNum, (error as Error).message);
		return null;
	}
}

/**
 * Parses a user message with cleaning: strips IDE tags and filters noise.
 * Messages matching any SKIP_USER_PREFIXES prefix are silently dropped.
 */
function parseUserMessage(
	msg: Record<string, unknown>,
	timestamp: string | undefined,
	lineNum: number,
): TranscriptEntry | null {
	const rawContent = extractContent(msg.content);
	if (!rawContent) return null;

	const content = stripIdeTags(rawContent);
	if (content.length === 0) return null;

	// Skip system-generated messages (skill injections, interruptions, etc.)
	if (SKIP_USER_PREFIXES.some((prefix) => content.startsWith(prefix))) {
		log.debug("Skipping filtered user message at line %d", lineNum);
		return null;
	}

	return { role: "human", content, timestamp };
}

/**
 * Strips IDE context tags injected by Claude Code from message content.
 * See IDE_TAG_PATTERN for the full list of tags and a before/after example.
 */
function stripIdeTags(text: string): string {
	return text.replace(IDE_TAG_PATTERN, "").trim();
}

/**
 * Extracts text content from a message content field.
 * Handles both string content and array content formats.
 * Only extracts "text" type blocks — tool_use and other block types are ignored.
 *
 * Defensive: validates each block's type and text property before use,
 * avoiding "Cannot read properties of undefined" errors on malformed entries.
 */
function extractContent(content: unknown): string | null {
	if (typeof content === "string") {
		return content.length > 0 ? content : null;
	}

	if (Array.isArray(content)) {
		const textParts: string[] = [];
		for (const block of content) {
			if (block !== null && typeof block === "object") {
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") {
					textParts.push(b.text);
				}
			}
		}
		return textParts.length > 0 ? textParts.join("\n") : null;
	}

	return null;
}

/**
 * Builds a conversation context string from transcript entries.
 * Truncates to maxChars, prioritizing the most recent entries.
 * Entries are separated by blank lines for better LLM readability.
 *
 * Output format:
 *   [Human]: What the user said
 *
 *   [Assistant]: What the AI responded
 *
 * @param entries - Parsed transcript entries
 * @param maxChars - Maximum character budget for the output
 * @returns Formatted conversation string
 */
export function buildConversationContext(
	entries: ReadonlyArray<TranscriptEntry>,
	maxChars = DEFAULT_MAX_CHARS,
): string {
	// Format each entry with role prefix
	const formatted = entries.map((entry) => formatEntry(entry));

	// Build from most recent, adding entries until we hit the budget
	let totalChars = 0;
	const selected: string[] = [];

	for (let i = formatted.length - 1; i >= 0; i--) {
		const entryLen = formatted[i].length + 2; // +2 for "\n\n" separator
		if (totalChars + entryLen > maxChars) {
			break;
		}
		selected.unshift(formatted[i]);
		totalChars += entryLen;
	}

	const result = selected.join("\n\n");
	return result;
}

/** A session's transcript entries with metadata for multi-session merging */
export interface SessionTranscript {
	readonly sessionId: string;
	readonly transcriptPath: string;
	/**
	 * Source integration this transcript came from. Carried on the transcript
	 * itself (not looked up by `sessionId`) so downstream persistence does not
	 * collapse two sources that coincidentally share an `sessionId`.
	 */
	readonly source?: TranscriptSource;
	readonly entries: ReadonlyArray<TranscriptEntry>;
}

/**
 * Builds conversation context from multiple sessions.
 *
 * Strategy (fair round-robin within a shared budget):
 *   1. Sort each session's entries newest-first.
 *   2. Round-robin across sessions: each round takes the next-newest unused
 *      entry from every session in turn, within `maxChars`, so every session
 *      contributes its most recent turns before any session's older turns —
 *      a single large recent session can't fill the budget and starve the rest
 *      (see {@link selectFairlyAcrossSessions}).
 *   3. Group selected entries back by session and format each group
 *      chronologically inside `<session>` XML tags.
 *
 * The result is NOT wrapped in `<transcript>` tags — the summarize prompt
 * template wraps `{{conversation}}` itself; wrapping here too double-wrapped it.
 * If only one session has entries, the output still uses `<session>` tags.
 *
 * @param sessions - Array of session transcripts to merge
 * @param maxChars - Maximum character budget (default: {@link DEFAULT_MAX_CHARS})
 * @returns Formatted multi-session conversation string (bare `<session>` blocks)
 */
export function buildMultiSessionContext(
	sessions: ReadonlyArray<SessionTranscript>,
	maxChars = DEFAULT_MAX_CHARS,
): string {
	const totalEntries = sessions.reduce((sum, s) => sum + s.entries.length, 0);
	if (totalEntries === 0) return "";

	// Select entries fairly across sessions (round-robin, newest-first per
	// session) so a single large recent session cannot consume the whole budget
	// and starve the others — every session contributes its newest turns first.
	const selected = selectFairlyAcrossSessions(sessions, maxChars);
	if (selected.length === 0) return "";

	// Visibility for the "conversation too big for the model budget" failure
	// mode: a large squash-commit regenerate aggregates the whole tree's
	// transcripts, and silently dropping the oldest turns here used to leave no
	// trace in debug.log. Logged only when entries were actually dropped.
	if (selected.length < totalEntries) {
		const usedChars = selected.reduce((sum, t) => sum + formatEntry(t.entry).length + 2, 0);
		log.info(
			"Conversation budget reached: kept %d/%d transcript entries (~%d/%d chars); older turns dropped",
			selected.length,
			totalEntries,
			usedChars,
			maxChars,
		);
	}

	// Group selected entries into <session> blocks. The <transcript> wrapper is
	// NOT added here: the summarize prompt template already wraps {{conversation}}
	// in <transcript> tags, so wrapping here too produced a double wrapper.
	return formatSessionBlocks(selected, sessions);
}

// --- Multi-session internal helpers ---

/** An entry tagged with its source session for grouping after selection */
interface TaggedEntry {
	readonly sessionId: string;
	readonly entry: TranscriptEntry;
}

/**
 * Comparator: sorts transcript entries by timestamp descending (newest first).
 * Entries without timestamps are placed last (treated as oldest).
 */
function compareEntryByTimestampDesc(a: TranscriptEntry, b: TranscriptEntry): number {
	const tsA = a.timestamp;
	const tsB = b.timestamp;

	// Both have timestamps: compare descending
	if (tsA && tsB) return tsB.localeCompare(tsA);
	// Only one has timestamp: the one with timestamp comes first
	if (tsA && !tsB) return -1;
	/* v8 ignore next -- symmetric comparator branch; whether sort invokes this operand order is engine-dependent */
	if (!tsA && tsB) return 1;
	// Neither has timestamp: preserve original order
	return 0;
}

/**
 * Selects entries across sessions in round-robin, newest-first order within a
 * shared character budget. Each round pulls the next-newest unused entry from
 * every session in turn, so every session contributes its most recent turns
 * before any session's older turns are considered — a single large recent
 * session can no longer fill the whole budget and starve the others. Once a
 * session's next-newest entry no longer fits the remaining budget, that session
 * stops contributing (its remaining entries are older, and we keep each
 * session's slice contiguous-newest). For a single session this is identical to
 * plain newest-first selection. `formatSessionBlocks` regroups + re-orders the
 * result, so the round-robin interleaving here does not affect output ordering.
 */
function selectFairlyAcrossSessions(sessions: ReadonlyArray<SessionTranscript>, maxChars: number): TaggedEntry[] {
	const queues = sessions
		.map((s) => ({ sessionId: s.sessionId, entries: [...s.entries].sort(compareEntryByTimestampDesc), cursor: 0 }))
		.filter((q) => q.entries.length > 0);

	const selected: TaggedEntry[] = [];
	let totalChars = 0;
	let madeProgress = true;
	while (madeProgress) {
		madeProgress = false;
		for (const q of queues) {
			if (q.cursor >= q.entries.length) continue;
			const entry = q.entries[q.cursor];
			const entryLen = formatEntry(entry).length + 2; // +2 for the "\n\n" separator
			if (totalChars + entryLen > maxChars) {
				// Next-newest entry no longer fits — stop pulling from this session.
				q.cursor = q.entries.length;
				continue;
			}
			selected.push({ sessionId: q.sessionId, entry });
			totalChars += entryLen;
			q.cursor++;
			madeProgress = true;
		}
	}

	return selected;
}

/**
 * Groups selected entries by session and formats them into <session> XML blocks.
 * Within each block, entries are ordered chronologically (oldest first).
 * Session blocks are ordered by most recent entry (session with newest entry first).
 */
function formatSessionBlocks(selected: ReadonlyArray<TaggedEntry>, sessions: ReadonlyArray<SessionTranscript>): string {
	// Build a lookup for transcript paths
	const pathMap = new Map<string, string>();
	for (const s of sessions) {
		pathMap.set(s.sessionId, s.transcriptPath);
	}

	// Group entries by sessionId, preserving insertion order
	const groups = new Map<string, TaggedEntry[]>();
	for (const tagged of selected) {
		const existing = groups.get(tagged.sessionId);
		if (existing) {
			existing.push(tagged);
		} else {
			groups.set(tagged.sessionId, [tagged]);
		}
	}

	// For each group, find the newest entry timestamp (for ordering session blocks)
	const sessionOrder: { sessionId: string; newestTimestamp: string }[] = [];
	for (const [sessionId, entries] of groups) {
		const newest = entries.reduce((best, e) => {
			const ts = e.entry.timestamp ?? "";
			return ts > best ? ts : best;
		}, "");
		sessionOrder.push({ sessionId, newestTimestamp: newest });
	}
	// Sort session blocks by newest entry descending
	sessionOrder.sort((a, b) => b.newestTimestamp.localeCompare(a.newestTimestamp));

	// Build the output
	const blocks: string[] = [];
	for (const { sessionId } of sessionOrder) {
		const entries = groups.get(sessionId);
		/* v8 ignore start -- impossible: sessionOrder is derived from groups, so every sessionId here exists in groups and sessions */
		if (!entries) continue;
		/* v8 ignore stop */
		/* v8 ignore start -- pathMap always contains all sessionIds from sessionOrder */
		const transcriptPath = pathMap.get(sessionId) ?? "unknown";
		/* v8 ignore stop */

		// Sort entries within session chronologically (oldest first)
		entries.sort((a, b) => {
			const tsA = a.entry.timestamp ?? "";
			const tsB = b.entry.timestamp ?? "";
			return tsA.localeCompare(tsB);
		});

		const formatted = entries.map((e) => formatEntry(e.entry)).join("\n\n");
		blocks.push(`<session id="${sessionId}" transcript="${transcriptPath}">\n${formatted}\n</session>`);
	}

	return blocks.join("\n\n");
}

/**
 * Merges consecutive entries that share the same role into a single entry.
 *
 * Claude Code streams a single API response as multiple JSONL lines (each sharing
 * the same message.id). Without merging, one assistant turn appears as 3-6 separate
 * [Assistant]: entries, wasting token budget and confusing the summarizer LLM.
 *
 * The merged entry keeps the earliest timestamp and joins content with blank lines.
 */
export function mergeConsecutiveEntries(entries: ReadonlyArray<TranscriptEntry>): TranscriptEntry[] {
	if (entries.length <= 1) return [...entries];

	const merged: TranscriptEntry[] = [];
	let current: TranscriptEntry = entries[0];

	for (let i = 1; i < entries.length; i++) {
		if (entries[i].role === current.role) {
			current = {
				role: current.role,
				content: `${current.content}\n\n${entries[i].content}`,
				timestamp: current.timestamp ?? entries[i].timestamp,
			};
		} else {
			merged.push(current);
			current = entries[i];
		}
	}
	merged.push(current);

	return merged;
}

/**
 * Formats a single transcript entry with its role prefix.
 */
function formatEntry(entry: TranscriptEntry): string {
	switch (entry.role) {
		case "human":
			return `[Human]: ${entry.content}`;
		case "assistant":
			return `[Assistant]: ${entry.content}`;
	}
}
