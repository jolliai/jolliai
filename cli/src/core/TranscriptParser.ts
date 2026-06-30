/**
 * Transcript Parser — Strategy Pattern for Multi-Agent JSONL Parsing
 *
 * Defines a common interface for parsing transcript lines from different
 * AI coding agents (Claude Code, OpenAI Codex CLI). Each agent produces
 * JSONL files with different event schemas; this module normalizes them
 * into a unified TranscriptEntry format for downstream processing.
 *
 * Claude Code format: { message: { role, content }, timestamp?, isCompactSummary? }
 * Codex CLI format:   { timestamp, type, payload: { type, message, ... } }
 */

import { createLogger } from "../Logger.js";
import type { TranscriptEntry } from "../Types.js";
import { parseTranscriptLine } from "./TranscriptReader.js";

const log = createLogger("TranscriptParser");

/**
 * Strategy interface for parsing a single JSONL line into a TranscriptEntry.
 * Implementations handle agent-specific event schemas and filtering.
 */
export interface TranscriptParser {
	parseLine(line: string, lineNum: number): TranscriptEntry | null;
	parseUsageTokens?(line: string, lineNum: number): number;
}

/**
 * Claude Code transcript parser.
 * Delegates to the existing parseTranscriptLine() in TranscriptReader.ts.
 */
export class ClaudeTranscriptParser implements TranscriptParser {
	parseLine(line: string, lineNum: number): TranscriptEntry | null {
		return parseTranscriptLine(line, lineNum);
	}

	parseUsageTokens(line: string, _lineNum?: number): number {
		try {
			const o = JSON.parse(line) as {
				message?: { usage?: Record<string, unknown> };
				usage?: Record<string, unknown>;
			};
			const u = o.message?.usage ?? o.usage;
			if (!u || typeof u !== "object") return 0;
			const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
			// Per-turn token *delta* only — deliberately EXCLUDES cache_read_input_tokens.
			// Real Claude transcripts (~/.claude/projects/*/*.jsonl) emit a cumulative
			// cache_read_input_tokens on every assistant turn: it is the running total of
			// the cached prefix re-read so far, so it grows monotonically across turns
			// (e.g. 16036 → 26231 → 50109 → … within one session). Summing it across the
			// turns of a slice re-counts the cached prefix on every turn and inflates
			// conversationTokens by an order of magnitude. The genuine new spend per turn
			// is input (uncached input) + cache_creation (the portion newly written to the
			// cache this turn) + output; the cache *read* of an already-counted prefix is
			// not new work and must not be summed. See the fixture-backed test for the
			// observed cumulative shape.
			return n("input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
		} catch {
			return 0;
		}
	}
}

/**
 * OpenAI Codex CLI transcript parser.
 *
 * Extracts user and assistant messages from the Codex JSONL event stream.
 * Only parses `event_msg` events with `user_message` and `agent_message`
 * payload types — these contain clean conversation text without system
 * injections or duplicated content from `response_item` entries.
 *
 * Skipped event types: session_meta, turn_context, response_item/*,
 * compacted, token_count, task_started, task_complete, turn_aborted,
 * context_compacted, agent_reasoning.
 */
export class CodexTranscriptParser implements TranscriptParser {
	parseLine(line: string, lineNum: number): TranscriptEntry | null {
		try {
			const data = JSON.parse(line) as Record<string, unknown>;
			const timestamp = typeof data.timestamp === "string" ? data.timestamp : undefined;
			const type = data.type;

			// Only process event_msg events
			if (type !== "event_msg") {
				return null;
			}

			const payload = data.payload as Record<string, unknown> | undefined;
			if (!payload || typeof payload !== "object") {
				return null;
			}

			const payloadType = payload.type;

			if (payloadType === "user_message") {
				return parseCodexUserMessage(payload, timestamp);
			}

			if (payloadType === "agent_message") {
				return parseCodexAgentMessage(payload, timestamp);
			}

			// All other event_msg subtypes are skipped
			return null;
		} catch (error: unknown) {
			log.debug("Failed to parse Codex transcript line %d: %s", lineNum, (error as Error).message);
			return null;
		}
	}
}

/**
 * Extracts user text from a Codex `event_msg/user_message` payload.
 * Returns null if the message field is missing or empty.
 */
function parseCodexUserMessage(
	payload: Record<string, unknown>,
	timestamp: string | undefined,
): TranscriptEntry | null {
	const message = payload.message;
	if (typeof message !== "string" || message.trim().length === 0) {
		return null;
	}
	return { role: "human", content: message.trim(), timestamp };
}

/**
 * Extracts assistant text from a Codex `event_msg/agent_message` payload.
 * Both `commentary` (intermediate reasoning) and `final_answer` phases are
 * included — the downstream mergeConsecutiveEntries() will combine them.
 * Returns null if the message field is missing or empty.
 */
function parseCodexAgentMessage(
	payload: Record<string, unknown>,
	timestamp: string | undefined,
): TranscriptEntry | null {
	const message = payload.message;
	if (typeof message !== "string" || message.trim().length === 0) {
		return null;
	}
	return { role: "assistant", content: message.trim(), timestamp };
}

// ─── Singleton instances (stateless parsers, safe to share) ──────────────────

const claudeParser = new ClaudeTranscriptParser();
const codexParser = new CodexTranscriptParser();

/**
 * Factory function returning the appropriate JSONL parser for a given transcript source.
 * Gemini uses a dedicated JSON reader (readGeminiTranscript) instead of this line-based parser.
 * Parsers are stateless singletons — safe to reuse across sessions.
 */
export function getParserForSource(source: "claude" | "codex"): TranscriptParser {
	switch (source) {
		case "codex":
			return codexParser;
		case "claude":
			return claudeParser;
	}
}
