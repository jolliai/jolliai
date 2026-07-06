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
import type { ConversationTokenBreakdown, ModelTokenUsage, TranscriptEntry } from "../Types.js";
import { parseTranscriptLine } from "./TranscriptReader.js";

const log = createLogger("TranscriptParser");

/**
 * Strategy interface for parsing a single JSONL line into a TranscriptEntry.
 * Implementations handle agent-specific event schemas and filtering.
 */
export interface TranscriptParser {
	parseLine(line: string, lineNum: number): TranscriptEntry | null;
	/** Per-turn token usage split into input / output / cached segments. The
	 *  reader sums these into the scalar `usageTokens` total. Absent method =
	 *  source exposes no usage (all downstream sums default to 0). */
	parseUsageTokens?(line: string, lineNum: number): ConversationTokenBreakdown;
	/** Per-model token usage over a whole consumed slice, one bucket per model
	 *  the transcript attributed tokens to. Whole-slice (not per-line) because a
	 *  source may record the model on a *different* line than the usage (e.g.
	 *  Codex `turn_context` vs `token_count`), needing cross-line state that is
	 *  cleanest kept local to one call. The summed segments equal the sum of
	 *  {@link parseUsageTokens} over the same lines. Absent method = no per-model
	 *  usage (cost estimate is simply skipped for that source). */
	parseUsageByModel?(lines: ReadonlyArray<string>): ModelTokenUsage[];
	/** ISO timestamp of a raw line even when {@link parseLine} yields no entry
	 *  (e.g. a tool-only assistant turn — no text content, but a real timestamp
	 *  and usage). The reader needs this so the `beforeTimestamp` cutoff can gate
	 *  token accumulation / cursor advance on such lines, not only on entry-bearing
	 *  ones. Absent method = the cutoff falls back to entry timestamps only. */
	parseTimestamp?(line: string, lineNum: number): string | undefined;
}

/**
 * Claude Code transcript parser.
 * Delegates to the existing parseTranscriptLine() in TranscriptReader.ts.
 */
export class ClaudeTranscriptParser implements TranscriptParser {
	parseLine(line: string, lineNum: number): TranscriptEntry | null {
		return parseTranscriptLine(line, lineNum);
	}

	parseUsageTokens(line: string, _lineNum?: number): ConversationTokenBreakdown {
		const usage = extractClaudeUsage(line);
		if (!usage) return { input: 0, output: 0, cached: 0 };
		return { input: usage.input, output: usage.output, cached: usage.cached };
	}

	/**
	 * Per-model split: one bucket per distinct `message.model`, summed over the
	 * slice. Reuses {@link extractClaudeUsage} so the segment values can never
	 * drift from {@link parseUsageTokens}. Lines with usage but no model string
	 * are bucketed under an empty model id (provider "anthropic") — they still
	 * count toward tokens; pricing will treat an unknown id as unpriced.
	 */
	parseUsageByModel(lines: ReadonlyArray<string>): ModelTokenUsage[] {
		const byModel = new Map<string, ModelTokenUsage>();
		for (const line of lines) {
			const usage = extractClaudeUsage(line);
			if (!usage) continue;
			const existing = byModel.get(usage.model);
			if (existing) {
				byModel.set(usage.model, {
					...existing,
					input: existing.input + usage.input,
					output: existing.output + usage.output,
					cached: existing.cached + usage.cached,
				});
			} else {
				byModel.set(usage.model, {
					model: usage.model,
					provider: "anthropic",
					input: usage.input,
					output: usage.output,
					cached: usage.cached,
				});
			}
		}
		return [...byModel.values()];
	}

	parseTimestamp(line: string, _lineNum?: number): string | undefined {
		try {
			const o = JSON.parse(line) as { timestamp?: unknown };
			return typeof o.timestamp === "string" ? o.timestamp : undefined;
		} catch {
			return undefined;
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

/**
 * Extracts one Claude assistant turn's model + token segments from a JSONL line.
 * Returns null for lines with no `usage` block (user turns, tool results, etc.).
 *
 * Segment semantics (the single source of truth for both `parseUsageTokens` and
 * `parseUsageByModel`): the per-turn delta only, deliberately EXCLUDING
 * `cache_read_input_tokens`. Real Claude transcripts emit `cache_read_input_tokens`
 * as a cumulative running total per turn (it grows monotonically across turns), so
 * summing it across a slice re-counts the cached prefix every turn and inflates the
 * total by an order of magnitude. Genuine new spend per turn is `input` (uncached
 * input) plus `cache_creation` (newly written to cache this turn) plus `output`; a
 * cache read of an already-counted prefix is not new work. `cached` therefore
 * carries `cache_creation_input_tokens` only. See the fixture-backed test.
 *
 * `model` is `message.model` (falling back to a top-level `model`), or an empty
 * string when absent; the turn still counts toward tokens and pricing treats an
 * empty/unknown id as unpriced.
 */
function extractClaudeUsage(line: string): { model: string; input: number; output: number; cached: number } | null {
	try {
		const o = JSON.parse(line) as {
			message?: { usage?: Record<string, unknown>; model?: unknown };
			usage?: Record<string, unknown>;
			model?: unknown;
		};
		const u = o.message?.usage ?? o.usage;
		if (!u || typeof u !== "object") return null;
		const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
		const rawModel = o.message?.model ?? o.model;
		const model = typeof rawModel === "string" ? rawModel : "";
		return {
			model,
			input: n("input_tokens"),
			output: n("output_tokens"),
			cached: n("cache_creation_input_tokens"),
		};
	} catch {
		return null;
	}
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
