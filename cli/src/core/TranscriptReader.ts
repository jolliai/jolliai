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
import { createLogger, isEnoent, type Logger } from "../Logger.js";
import type {
	ConversationTokenBreakdown,
	ModelTokenUsage,
	SessionUsageEvent,
	ToolCallCount,
	TranscriptCursor,
	TranscriptEntry,
	TranscriptReadResult,
	TranscriptSource,
} from "../Types.js";
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
 * True when a transcript-read rejection was "the file is gone" rather than a real
 * read failure. Callers that already treat a vanished transcript as normal (a
 * session whose host rotated its JSONL still counts as a session) use this to keep
 * the terminal quiet while a genuine I/O fault still gets reported.
 *
 * TWO shapes carry the ENOENT, because the per-source readers disagree on how they
 * rethrow: the SQLite-backed readers copy the original `.code` straight onto their
 * wrapper (their callers branch on `.code`), and every rethrow that goes through
 * {@link throwTranscriptReadError} additionally carries the original as `cause`.
 * Inspecting only one shape is exactly the gap that left ten of thirteen sources
 * logging a rotated transcript as a fault every poll.
 *
 * One reader is bound to the `.code` shape and cannot be moved onto the other:
 * `CopilotChatTranscriptReader`'s `cause` is its own structured scan payload, which
 * `CopilotChatSessionDiscoverer` reads as `error.cause.kind`. So do not "simplify"
 * this to the `cause` branch alone.
 *
 * The predicate itself is {@link isEnoent} — the repo-wide one, ~25 call sites — and
 * not a local restatement of it. The local copy this replaces differed by dropping
 * `isEnoent`'s `instanceof Error` guard, which is a difference no producer here can
 * exercise (every shape above wraps a real `fs` rejection) and a trap for whoever
 * next has to decide which of two ENOENT tests to reach for.
 */
export function isMissingTranscriptError(error: unknown): boolean {
	return isEnoent(error) || isEnoent((error as { cause?: unknown } | null)?.cause);
}

/**
 * Logs a transcript-read failure at the level its NATURE deserves: a vanished file
 * (ENOENT) is the graceful-degradation contract working, so it stays at `debug` and
 * out of the terminal, while every other failure keeps its `error` line. The single
 * home of that branch, so a reader cannot get the level wrong and so the caller's
 * own {@link isMissingTranscriptError}-gated level (in `loadUnreadTranscript` etc.)
 * is not preceded by a contradicting `error` line from the reader itself.
 */
export function logTranscriptReadFailure(log: Logger, message: string, error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error);
	(isEnoent(error) ? log.debug : log.error)("%s (%s)", message, detail);
}

/**
 * The rethrow every per-source reader funnels its file-read catch through. Logs via
 * {@link logTranscriptReadFailure}, then throws a wrapper that carries the original
 * BOTH ways {@link isMissingTranscriptError} inspects: `.code` copied when present
 * (so `.code`-branching callers keep working, and an absent code is NOT invented),
 * and the original as `cause`. Returns `never` so a reader can `throwTranscriptReadError(...)`
 * as its last statement without a dead `throw`/`return` after it.
 */
export function throwTranscriptReadError(log: Logger, message: string, error: unknown): never {
	logTranscriptReadFailure(log, message, error);
	const wrapped = new Error(message) as NodeJS.ErrnoException;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code !== undefined) wrapped.code = code;
	throw Object.assign(wrapped, { cause: error });
}

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
	let content: string;
	try {
		content = await readFile(transcriptPath, "utf-8");
	} catch (error: unknown) {
		// Through the shared rethrow, like every per-source reader: a transcript the
		// agent host rotated or deleted is an ordinary condition each caller already
		// degrades on, so it logs at `debug` and stays out of the terminal while a
		// genuine read failure keeps its `error` line — and the wrapper carries the
		// original BOTH ways `isMissingTranscriptError` inspects. The hand-rolled
		// version here attached only `cause`, so a caller that branched on `.code`
		// (the shape the SQLite-backed readers produce) read a vanished transcript as
		// an I/O fault. No caller does today; both go through that predicate. It was
		// the next reader's trap, not a live bug.
		throwTranscriptReadError(log, `Cannot read transcript: ${transcriptPath}`, error);
	}
	return parseTranscriptContent(transcriptPath, content, cursor, parser, beforeTimestamp);
}

/**
 * A JSONL transcript's non-blank lines, as every reader here counts them.
 *
 * Exported because line NUMBERS cross module boundaries: a scanner handed these
 * lines reports a cursor position against them, and the incremental cursors in
 * `discovery-cursors.json` are monotonic — a mark advanced past a line is never
 * re-read. So a second filter that disagreed by even one blank line would not
 * fail loudly; it would silently strand records on one side of the boundary.
 * One function, one definition of "line N".
 */
export function splitTranscriptLines(content: string): string[] {
	return content.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Everything {@link readTranscript} does once the file is in hand — same result,
 * same rules, no disk access.
 *
 * Split out for a caller that has ALREADY read the file, so one read can serve both
 * it and this parse — by extraction rather than by a second implementation, which is
 * what keeps "what counts as a turn, a token, a tool call" in exactly one place.
 *
 * **No such caller exists today**, and the reason is worth knowing before adding one.
 * The Claude disk scan was it: it reads each transcript whole for the working
 * directories a `cd` scattered through the file, and handing that text over here
 * removed a second read (measured 464 ms across 64 transcripts, paid twice). It was
 * reverted because the parse then had to be CARRIED for the whole run, which made a
 * back-fill's resident set grow with its window — see `acceptFacts` in
 * `ClaudeSessionDiscoverer`. So the seam is kept, and a future caller may use it, but
 * only one that consumes the result immediately rather than holding it.
 *
 * `transcriptPath` is still required: it is not read, but it is what the returned
 * cursor names.
 */
export function parseTranscriptContent(
	transcriptPath: string,
	content: string,
	cursor?: TranscriptCursor | null,
	parser?: TranscriptParser,
	beforeTimestamp?: string,
): TranscriptReadResult {
	const startLine = cursor?.lineNumber ?? 0;
	const activeParser = parser ?? new ClaudeTranscriptParser();
	const parseFn = (line: string, num: number) => activeParser.parseLine(line, num);

	const lines = splitTranscriptLines(content);

	// Process only new lines since cursor
	const newLines = lines.slice(startLine);
	const rawEntries: TranscriptEntry[] = [];
	const cutoffTime = beforeTimestamp ? new Date(beforeTimestamp).getTime() : undefined;
	let lastConsumedLineIndex = startLine; // Track how far we actually consumed
	let usageInput = 0;
	let usageOutput = 0;
	let usageCached = 0;
	// Response ids already counted in this read. One API response is written
	// across several lines (one per content block) and every line repeats that
	// response's whole `usage` object, so counting per line multiplied real usage
	// by the block count — 2.2×–10× on measured transcripts. See ParsedTurnUsage.
	//
	// Scoped to this read, which closes the inflation within a slice but not the
	// rarer cross-slice case: if `beforeTimestamp` cuts between two blocks of one
	// response, this commit counts it and the next commit counts it again (each
	// read starts with an empty set). Bounded to one duplicated response per
	// commit boundary — closing it fully means persisting the last counted id in
	// the cursor, which is not worth the schema change at that magnitude.
	const countedUsageKeys = new Set<string>();
	// One entry per counted response, each with its own instant. Built in the same
	// pass as the totals above rather than by a second scan: a separate pass would
	// be a second place that decides what "a counted response" means, and it would
	// have to re-resolve the same timestamps.
	const usageEvents: SessionUsageEvent[] = [];

	// The entry's own timestamp, else the parser's raw-line one.
	//
	// ⚠ Called only where the answer is actually used, never once per line up
	// front. `ClaudeTranscriptParser.parseTimestamp` is a whole-line `JSON.parse`,
	// this loop runs over every line of every transcript, and the collector re-reads
	// each transcript WHOLE on every tick — so the fallback is charged only to the
	// lines the cutoff or a usage event asks about, not to the entry-less lines
	// (tool-only turns, meta records) that neither will look at. Hoisted rather
	// than closed over `i` so resolving costs a call and not an allocation per line.
	const timestampOf = (entry: TranscriptEntry | null, index: number): string | undefined =>
		entry?.timestamp ?? activeParser.parseTimestamp?.(newLines[index], startLine + index);

	for (let i = 0; i < newLines.length; i++) {
		const lineNum = startLine + i;
		const entry = parseFn(newLines[i], lineNum);
		// Resolved here only when there IS a cutoff; reused below so a line that
		// needs it for both purposes still pays once.
		const cutoffTimestamp = cutoffTime ? timestampOf(entry, i) : undefined;

		// Apply the time cutoff per LINE, not only per produced entry. A tool-only
		// assistant turn yields no entry (extractContent keeps only text) yet carries
		// a real timestamp and usage; gating only on entry-bearing lines let such a
		// turn past the cutoff still have its tokens summed here and the cursor
		// advanced over it, so the commit that owns it could never read those tokens.
		// Lines with no resolvable timestamp are conservatively included (they were
		// written before the next timestamped line, so they belong to this window).
		if (cutoffTime && cutoffTimestamp && new Date(cutoffTimestamp).getTime() > cutoffTime) {
			break; // Remaining lines (this one included) belong to a later commit
		}
		if (entry) {
			rawEntries.push(entry);
		}
		// Accumulate per-response token usage (per segment) from the parser. A line
		// whose response was already counted contributes nothing; a line with no
		// `dedupKey` always counts (sources that report usage once per line).
		const usage = activeParser.parseUsageTokens?.(newLines[i], lineNum);
		if (usage && !(usage.dedupKey && countedUsageKeys.has(usage.dedupKey))) {
			if (usage.dedupKey) countedUsageKeys.add(usage.dedupKey);
			usageInput += usage.input;
			usageOutput += usage.output;
			usageCached += usage.cached;
			// Same response, now with its instant. A line the parser cannot date is
			// DROPPED from the events rather than dated by guesswork: these rows are
			// what a per-day figure is built from, and a wrong day is worse than a
			// missing one. It still counts toward the totals above, so the session's
			// own numbers stay whole — the two disagree only by what could not be
			// dated, which is what `token_coverage` is for.
			const lineTimestamp = cutoffTime ? cutoffTimestamp : timestampOf(entry, i);
			const respondedAtMs = lineTimestamp ? new Date(lineTimestamp).getTime() : Number.NaN;
			// A zero-token line is NOT a response worth recording, and the filter is
			// the same one `parseUsageByModel` already applies to its buckets, for the
			// same reason spelled out there.
			//
			// ⚠ Without it this pushes a row for EVERY line, not just for a response:
			// `parseUsageTokens` answers `{input:0,output:0,cached:0}` rather than
			// `undefined` when a line records no usage, so the `usage &&` guard above
			// is true for user turns, tool results and meta records alike. Measured on
			// a real database: 10,625 of 16,815 stored rows were zero-token, 63% of
			// the table, all of them `model: ''` — and they were not inert. They
			// carried an empty `series_key` into `stats_daily`, which the Spend card's
			// legend renders as a NAMELESS swatch at $0.00 taking the first palette
			// colour and shifting every real model's colour by one; with a fifth model
			// present it would push a real one into "Other", which is exactly what
			// `parseUsageByModel`'s filter exists to prevent. They also inflate a
			// synced table and worsen the same-millisecond keyset pressure
			// `SyncColumns.KEYSET_COLUMNS` measures.
			//
			// Filtered HERE rather than by changing `parseUsageTokens` to answer
			// `undefined`: the totals above deliberately add a zero and do not care,
			// the six real responses that reported zero usage still dedupe by id, and
			// the interface keeps one return shape.
			if (Number.isFinite(respondedAtMs) && usage.input + usage.output + usage.cached > 0) {
				usageEvents.push({
					respondedAtMs,
					model: usage.model ?? "",
					input: usage.input,
					output: usage.output,
					cached: usage.cached,
					...(usage.dedupKey && { dedupKey: usage.dedupKey }),
				});
			}
		}
		// Only advance cursor for lines we actually processed (not past the break point)
		lastConsumedLineIndex = startLine + i + 1;
	}

	// Merge consecutive entries with the same role (streaming chunks from a single API response)
	const entries = mergeConsecutiveEntries(rawEntries);

	// Per-model usage over exactly the lines we consumed (respecting the cutoff
	// break). Whole-slice, not per-line, because a source may record the model on
	// a different line than the usage — see TranscriptParser.parseUsageByModel.
	const consumedLines = newLines.slice(0, lastConsumedLineIndex - startLine);
	const usageByModel = activeParser.parseUsageByModel?.(consumedLines);
	// Tool calls over the same consumed lines. Absent (not empty) for a source
	// whose parser cannot see them, so downstream can tell "this agent used no
	// tools" apart from "this agent's transcripts do not record tools".
	const toolUse = activeParser.parseToolUse?.(consumedLines);

	// When beforeTimestamp is set, advance cursor only to the last consumed line.
	// Without beforeTimestamp (legacy/CLI path), advance to EOF for backward compatibility.
	const newCursor: TranscriptCursor = {
		transcriptPath,
		lineNumber: beforeTimestamp ? lastConsumedLineIndex : lines.length,
		updatedAt: new Date().toISOString(),
	};

	return {
		entries,
		newCursor,
		totalLinesRead: lastConsumedLineIndex - startLine,
		usageTokens: usageInput + usageOutput + usageCached,
		usageBreakdown: { input: usageInput, output: usageOutput, cached: usageCached },
		...(usageByModel && usageByModel.length > 0 && { usageByModel }),
		// Present-but-empty when this source's parser can report usage at all: a
		// re-read that sees no datable responses must be able to CLEAR rows a
		// better read left behind (agents compact and rewrite their transcripts),
		// and `undefined` — the one thing a consumer can distinguish from an
		// empty set — is what "this source records none" means. Only the Claude
		// parser defines `parseUsageTokens` today.
		...(activeParser.parseUsageTokens ? { usageEvents } : {}),
		// Kept even when empty: an empty array is the positive fact "this slice
		// called no tools", which absence cannot express.
		...(toolUse && { toolUse }),
	};
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
	/** This session's own share of the commit's conversation tokens, attached by
	 *  the queue worker after overlay reconciliation so `buildStoredTranscript`
	 *  can persist it (see {@link StoredSession.usage} for why it must survive
	 *  the write). Absent for sources whose transcript carries no usage. */
	readonly usage?: ConversationTokenBreakdown;
	/** Per-model split of {@link usage}. */
	readonly usageByModel?: ReadonlyArray<ModelTokenUsage>;
	/** Tool/MCP/skill calls made in this commit's slices, attached alongside
	 *  {@link usage} and persisted as {@link StoredSession.toolUse}. Absent for
	 *  sources whose parser cannot report tool calls. */
	readonly toolUse?: ReadonlyArray<ToolCallCount>;
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
