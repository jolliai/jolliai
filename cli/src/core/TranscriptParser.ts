/**
 * Transcript Parser — Strategy Pattern for Multi-Agent JSONL Parsing
 *
 * Defines a common interface for parsing transcript lines from different
 * AI coding agents (Claude Code, OpenAI Codex). Each agent produces
 * JSONL files with different event schemas; this module normalizes them
 * into a unified TranscriptEntry format for downstream processing.
 *
 * Claude Code format: { message: { role, content }, timestamp?, isCompactSummary? }
 * Codex format:   { timestamp, type, payload: { type, message, ... } }
 */

import { createLogger } from "../Logger.js";
import type { ModelTokenUsage, ParsedTurnUsage, ToolCallCount, TranscriptEntry } from "../Types.js";
import { parseTranscriptLine } from "./TranscriptReader.js";

const log = createLogger("TranscriptParser");

/**
 * Strategy interface for parsing a single JSONL line into a TranscriptEntry.
 * Implementations handle agent-specific event schemas and filtering.
 */
export interface TranscriptParser {
	parseLine(line: string, lineNum: number): TranscriptEntry | null;
	/** Per-turn token usage split into input / output / cached segments. The
	 *  reader sums these into the scalar `usageTokens` total, skipping any line
	 *  whose `dedupKey` it has already counted — see {@link ParsedTurnUsage} for
	 *  why one response can arrive on several lines. Absent method = source
	 *  exposes no usage (all downstream sums default to 0). */
	parseUsageTokens?(line: string, lineNum: number): ParsedTurnUsage;
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
	/** Tool calls over a whole consumed slice, one bucket per distinct tool.
	 *  Whole-slice for the same reason as {@link parseUsageByModel}: one API
	 *  response is written across several lines and a `tool_use` block must be
	 *  counted once, which needs cross-line dedupe state. Absent method = the
	 *  source's transcripts expose no tool records, and every consumer must
	 *  report that source as UNCOVERED rather than as "used no tools". */
	parseToolUse?(lines: ReadonlyArray<string>): ToolCallCount[];
}

/**
 * Classifies a raw tool name from a transcript.
 *
 * MCP tools arrive as `mcp__<server>__<tool>` — the wire name, which is what
 * makes the server extractable at all. The double underscore is the separator
 * the MCP host itself uses, and a server or tool name may contain single
 * underscores, so the split is on `__` and only the FIRST two segments are
 * structural; anything after them is part of the tool name.
 */
export function classifyToolName(raw: string): ToolCallCount {
	if (raw.startsWith("mcp__")) {
		const rest = raw.slice("mcp__".length);
		const sep = rest.indexOf("__");
		// `mcp__server` with no tool segment is malformed; keep it attributed to
		// the server rather than dropping the call.
		const server = sep === -1 ? rest : rest.slice(0, sep);
		const tool = sep === -1 ? "" : rest.slice(sep + 2);
		return { name: tool ? `${server}.${tool}` : server, kind: "mcp", server, calls: 0 };
	}
	return { name: raw, kind: "builtin", calls: 0 };
}

/**
 * Claude Code transcript parser.
 * Delegates to the existing parseTranscriptLine() in TranscriptReader.ts.
 */
export class ClaudeTranscriptParser implements TranscriptParser {
	parseLine(line: string, lineNum: number): TranscriptEntry | null {
		return parseTranscriptLine(line, lineNum);
	}

	parseUsageTokens(line: string, _lineNum?: number): ParsedTurnUsage {
		const usage = extractClaudeUsage(line);
		if (!usage) return { input: 0, output: 0, cached: 0 };
		return {
			input: usage.input,
			output: usage.output,
			cached: usage.cached,
			// `message.id` identifies the API response, not the line. Several lines
			// (one per content block) repeat the same id and the same usage object;
			// the reader counts only the first. Omitted when the id is absent so the
			// line still counts rather than being silently dropped.
			...(usage.id && { dedupKey: usage.id }),
		};
	}

	/**
	 * Per-model split: one bucket per distinct `message.model`, summed over the
	 * slice. Reuses {@link extractClaudeUsage} so the segment values can never
	 * drift from {@link parseUsageTokens}. Lines with usage but no model string —
	 * absent, or a sentinel such as `"<synthetic>"` (see {@link isSentinelModel})
	 * — are bucketed under an empty model id (provider "anthropic"); they still
	 * count toward tokens, and pricing will treat an unknown id as unpriced.
	 *
	 * De-duplicates by `message.id` for the same reason the reader does (see
	 * {@link ParsedTurnUsage}) — and it must dedupe on the SAME identity, or the
	 * per-model buckets would drift from the breakdown and the cost estimate
	 * would be priced off a larger token count than the bar displays.
	 */
	parseUsageByModel(lines: ReadonlyArray<string>): ModelTokenUsage[] {
		const byModel = new Map<string, ModelTokenUsage>();
		const seen = new Set<string>();
		for (const line of lines) {
			const usage = extractClaudeUsage(line);
			if (!usage) continue;
			if (usage.id) {
				if (seen.has(usage.id)) continue;
				seen.add(usage.id);
			}
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
		// A bucket whose three segments are all zero cannot move a token total or a
		// cost, so keeping it only costs a legend slot in the dashboard's spend card
		// — which is exactly what the normalised sentinel turns above would produce
		// (an empty-id bucket of 0/0/0), pushing out a real low-spend model.
		return [...byModel.values()].filter((m) => m.input + m.output + m.cached > 0);
	}

	/**
	 * Counts `tool_use` blocks across a slice.
	 *
	 * Deduped on the block's own `toolu_…` id, not on the message id: one API
	 * response can contain several distinct tool calls, so keying on the message
	 * would collapse them to one, while the same response repeated across lines
	 * would otherwise count each call several times. The block id is unique per
	 * call and stable across those repeats — exactly the identity needed.
	 *
	 * A `Skill` call is re-attributed to the skill it ran (`input.skill`), since
	 * "which skills does this person use" is the question being asked; counting
	 * every skill invocation as one builtin named `Skill` would answer nothing.
	 */
	parseToolUse(lines: ReadonlyArray<string>): ToolCallCount[] {
		const byName = new Map<string, ToolCallCount>();
		const seen = new Set<string>();
		for (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const content = (parsed as { message?: { content?: unknown } })?.message?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: { skill?: unknown } };
				if (b.type !== "tool_use" || typeof b.name !== "string") continue;
				if (typeof b.id === "string") {
					if (seen.has(b.id)) continue;
					seen.add(b.id);
				}
				const classified =
					b.name === "Skill" && typeof b.input?.skill === "string"
						? ({ name: b.input.skill, kind: "skill", calls: 0 } as ToolCallCount)
						: classifyToolName(b.name);
				const key = `${classified.kind}:${classified.name}`;
				const existing = byName.get(key);
				byName.set(key, existing ? { ...existing, calls: existing.calls + 1 } : { ...classified, calls: 1 });
			}
		}
		return [...byName.values()];
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
 * OpenAI Codex transcript parser.
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
 * Kimi Code CLI transcript parser.
 *
 * Kimi Code (`@kimi-code/cli`, `~/.kimi-code`) records the main agent's
 * conversation to `agents/main/wire.jsonl` — its own JSON-lines wire protocol
 * (NOT raw ACP), one event per line, each tagged with a top-level `type` and a
 * millisecond-epoch `time`. Pinned to a real capture (kimi-code, Aug 2026), only
 * two event kinds carry conversation text:
 *
 *   - USER turn — `turn.prompt`, whose `input` is an array of `{type:"text",text}`
 *     content blocks (or a bare string):
 *       {"type":"turn.prompt","input":[{"type":"text","text":"…"}],"origin":{"kind":"user"},"time":…}
 *   - ASSISTANT turn — a `content.part` of `part.type:"text"`, delivered inside a
 *     `context.append_loop_event` envelope (streamed, one part per line — merged
 *     downstream by mergeConsecutiveEntries, exactly like Claude's streamed blocks):
 *       {"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"…"}},"time":…}
 *
 * Deliberately skipped: `content.part` of `part.type:"think"` (the model's
 * reasoning — noise, like Claude's thinking blocks), `context.append_message`
 * (a replayed copy of the user prompt plus injected `<system-reminder>` blocks —
 * parsing `turn.prompt` instead keeps the genuine input and drops the noise),
 * `step.*`, `usage.record`, `llm.*`, `tools.*`, `config.update`, `metadata`,
 * `permission.set_mode`. This mirrors the Claude/Codex rule: keep only human +
 * assistant text; the git diff already captures the code. Parsing is defensive
 * (unknown shapes → no entry, never a throw). Token/cost accounting is not
 * attempted — the same gap OpenCode/Cursor carry.
 *
 * NOTE: the working directory is NOT in wire.jsonl at all — it lives in the
 * session's sibling `state.json` (`workDir`), which is where
 * {@link discoverKimiSessions} recovers it.
 */
export class KimiTranscriptParser implements TranscriptParser {
	parseLine(line: string, lineNum: number): TranscriptEntry | null {
		try {
			const data = JSON.parse(line) as Record<string, unknown>;
			const type = data.type;
			const timestamp = kimiFrameTimestamp(data);

			if (type === "turn.prompt") {
				const text = extractKimiText(data.input)?.trim();
				return text ? { role: "human", content: text, timestamp } : null;
			}

			// Assistant text arrives as a `content.part` (part.type "text"), normally
			// wrapped in a `context.append_loop_event`. Accept the unwrapped form too.
			const part = kimiContentPart(data);
			if (part && part.type === "text") {
				const text = typeof part.text === "string" ? part.text.trim() : "";
				return text ? { role: "assistant", content: text, timestamp } : null;
			}

			return null;
		} catch (error: unknown) {
			log.debug("Failed to parse Kimi transcript line %d: %s", lineNum, (error as Error).message);
			return null;
		}
	}

	parseTimestamp(line: string, _lineNum?: number): string | undefined {
		try {
			return kimiFrameTimestamp(JSON.parse(line) as Record<string, unknown>);
		} catch {
			return undefined;
		}
	}
}

/**
 * Extracts the `content.part` object from a Kimi wire event, whether it arrives
 * wrapped in a `context.append_loop_event` (the observed shape) or as a bare
 * top-level `content.part`. Returns null for any other event.
 */
function kimiContentPart(data: Record<string, unknown>): Record<string, unknown> | null {
	if (data.type === "context.append_loop_event") {
		const event = data.event as Record<string, unknown> | undefined;
		if (event?.type === "content.part" && event.part && typeof event.part === "object") {
			return event.part as Record<string, unknown>;
		}
		return null;
	}
	if (data.type === "content.part" && data.part && typeof data.part === "object") {
		return data.part as Record<string, unknown>;
	}
	return null;
}

/**
 * Extracts an ISO timestamp from a Kimi wire event. Every event carries a `time`
 * field as a millisecond epoch; a string `timestamp` is also accepted. Returns
 * undefined when neither is present — the reader then conservatively includes the
 * line under a `beforeTimestamp` cutoff.
 */
function kimiFrameTimestamp(data: Record<string, unknown>): string | undefined {
	const t = data.time ?? data.timestamp;
	if (typeof t === "number" && Number.isFinite(t)) {
		return new Date(t).toISOString();
	}
	return typeof t === "string" && t.length > 0 ? t : undefined;
}

/**
 * Normalises a Kimi content value to plain text. Handles a bare string, a single
 * `{ type: "text", text }` block, and an array of either (joining with newlines,
 * mirroring the Claude reader's block join). Non-text blocks (image/resource) are
 * dropped. Returns null when nothing textual is present.
 */
export function extractKimiText(value: unknown): string | null {
	if (typeof value === "string") {
		return value.length > 0 ? value : null;
	}
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (const block of value) {
			const text = extractKimiText(block);
			if (text) parts.push(text);
		}
		return parts.length > 0 ? parts.join("\n") : null;
	}
	if (value !== null && typeof value === "object") {
		const b = value as Record<string, unknown>;
		if ((b.type === "text" || b.type === undefined) && typeof b.text === "string" && b.text.length > 0) {
			return b.text;
		}
	}
	return null;
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
 * string when absent or a sentinel (see {@link isSentinelModel}); the turn still
 * counts toward tokens and pricing treats an empty/unknown id as unpriced.
 *
 * `id` is `message.id` — the API response's identity, used to collapse the
 * several lines one response is written across (see `ParsedTurnUsage`). Empty
 * when absent, which makes the caller count the line unconditionally.
 */
function extractClaudeUsage(line: string): ClaudeTurnUsage | null {
	try {
		return extractClaudeUsageFromRecord(JSON.parse(line));
	} catch {
		return null;
	}
}

/** One Claude turn's spend plus the identity used to collapse its repeated lines. */
export interface ClaudeTurnUsage {
	/** `message.id`, or "" when absent — an empty id means "always count this line". */
	readonly id: string;
	readonly model: string;
	readonly input: number;
	readonly output: number;
	readonly cached: number;
}

/**
 * The record-level half of {@link extractClaudeUsage}, exported so a consumer that
 * has ALREADY parsed the line can reuse these semantics without parsing twice.
 *
 * This is the single definition of what a Claude turn cost and of what identifies
 * it. Both rules it encodes are easy to get subtly wrong in a second
 * implementation, and both fail silently:
 *
 *   - excluding `cache_read_input_tokens` (a cumulative counter — summing it
 *     re-counts the cached prefix on every turn), and
 *   - keying dedupe on `message.id` (one response spans several lines, each
 *     repeating the whole usage object).
 *
 * Any per-segment consumer — the commit-level reader, the per-model split, and
 * per-skill attribution — must come through here, or its numbers will drift from
 * the others' for the same transcript.
 */
/**
 * True for a placeholder the agent CLI writes where a model id would go.
 *
 * Claude Code fabricates an assistant line for turns that never reached a model
 * (context overflow, `API Error: 529`, a dropped connection, an expired session)
 * and stamps it `"<synthetic>"`. Angle brackets are the CLI telling downstream
 * "this is not a model id", so the shape — not the one literal — is what is
 * recognised here; a future sentinel of the same form is covered.
 *
 * Such a line still carries a `usage` object, all zeros, so the existence check
 * above cannot reject it. Left alone it becomes its own per-model bucket: zero
 * tokens, zero cost, and one legend slot in the dashboard's spend card taken
 * from a real low-spend model. It is normalised to the same empty id an absent
 * `model` produces, so the turn keeps counting toward tokens and stays unpriced.
 */
function isSentinelModel(model: string): boolean {
	return model.startsWith("<") && model.endsWith(">");
}

export function extractClaudeUsageFromRecord(record: unknown): ClaudeTurnUsage | null {
	const o = record as {
		message?: { usage?: Record<string, unknown>; model?: unknown; id?: unknown };
		usage?: Record<string, unknown>;
		model?: unknown;
	} | null;
	const u = o?.message?.usage ?? o?.usage;
	if (!u || typeof u !== "object") return null;
	const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
	const rawModel = o?.message?.model ?? o?.model;
	const rawId = o?.message?.id;
	return {
		id: typeof rawId === "string" ? rawId : "",
		model: typeof rawModel === "string" && !isSentinelModel(rawModel) ? rawModel : "",
		input: n("input_tokens"),
		output: n("output_tokens"),
		cached: n("cache_creation_input_tokens"),
	};
}

// ─── Singleton instances (stateless parsers, safe to share) ──────────────────

const claudeParser = new ClaudeTranscriptParser();
const codexParser = new CodexTranscriptParser();
const kimiParser = new KimiTranscriptParser();

/**
 * Factory function returning the appropriate JSONL parser for a given transcript source.
 * Gemini uses a dedicated JSON reader (readGeminiTranscript) instead of this line-based parser.
 * Parsers are stateless singletons — safe to reuse across sessions.
 */
export function getParserForSource(source: "claude" | "codex" | "kimi"): TranscriptParser {
	switch (source) {
		case "codex":
			return codexParser;
		case "kimi":
			return kimiParser;
		case "claude":
			return claudeParser;
	}
}

/** The sources this module has a parser for. Others use dedicated readers. */
const PARSER_BACKED_SOURCES = ["claude", "codex"] as const;

/**
 * Sources whose transcripts can report tool calls at all — i.e. whose parser
 * implements {@link TranscriptParser.parseToolUse}.
 *
 * A per-SOURCE capability, never a per-session fact. Consumers need it to tell
 * "this agent used no tools" (source present, no records) from "this agent's
 * transcripts cannot express tool calls" (source absent) — the distinction the
 * reader preserves by keeping an empty `toolUse` array rather than dropping the
 * field. Zero records look identical without it.
 *
 * Derived by probing the parsers instead of listing source names, so adding
 * `parseToolUse` to one of them cannot leave this behind. Sources served by a
 * dedicated reader rather than a `TranscriptParser` are absent, which is correct
 * today: none of them extracts tool calls.
 */
export const TOOL_RECORDING_SOURCES: ReadonlySet<string> = new Set(
	PARSER_BACKED_SOURCES.filter((source) => getParserForSource(source).parseToolUse !== undefined),
);
