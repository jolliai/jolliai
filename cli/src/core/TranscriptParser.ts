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
import {
	builtinTool,
	classifyCodexToolName,
	classifyToolName,
	mcpTool,
	skillTool,
	ToolUseTally,
} from "./ToolNameClassify.js";
import { parseTranscriptLine } from "./TranscriptReader.js";

// Re-exported for the callers that already imported it from here; the shared
// classifiers now live in ToolNameClassify.ts alongside the other dialects.
export { classifyToolName } from "./ToolNameClassify.js";

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
		const tally = new ToolUseTally();
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
				tally.addOnce(
					typeof b.id === "string" ? b.id : undefined,
					b.name === "Skill" && typeof b.input?.skill === "string"
						? skillTool(b.input.skill)
						: classifyToolName(b.name),
				);
			}
		}
		return tally.values();
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

	/**
	 * Tool calls over a slice of a Codex rollout.
	 *
	 * Codex writes a call across up to three rows sharing one `call_id`, so a call
	 * is resolved per id and counted once at the end — see
	 * {@link CODEX_TOOL_CALL_TYPES} for the row types and the evidence behind each.
	 *
	 * Identity is NOT read out of the name: Codex names its builtins bare
	 * (`exec_command`, `wait`, `write_stdin`, `update_plan`, `exec`,
	 * `apply_patch` — every name present across 40 real 2026-07/08 rollouts) and
	 * carries MCP identity in a sibling field instead. Running these through the
	 * Claude `mcp__` test would file every Codex MCP call as a builtin, so
	 * `classifyCodexToolName` takes the namespace explicitly.
	 *
	 * **The last row wins, not the first, and that ordering is load-bearing.** A
	 * real MCP call is written as a namespace-less `function_call` FIRST and an
	 * `mcp_tool_call_end` carrying `invocation.{server,tool}` after it — measured
	 * on a live rollout:
	 *
	 *   function_call      call_00_2Rw… name=list_mcp_resources namespace=∅
	 *   mcp_tool_call_end  call_00_2Rw… invocation={server:"codex", tool:"list_mcp_resources"}
	 *
	 * The request row alone is indistinguishable from a builtin, so a
	 * first-write-wins dedupe files every such call under `builtin` and the server
	 * is lost — the exact silent mis-bucketing this parser's name-agnostic
	 * classification exists to prevent. Later rows may only UPGRADE the identity:
	 * an `mcp_tool_call_end` replaces a builtin guess, and nothing downgrades an
	 * MCP identity back.
	 *
	 * A row missing `call_id` is counted immediately (an unidentifiable call is a
	 * real call); it just cannot be deduped or upgraded.
	 */
	parseToolUse(lines: ReadonlyArray<string>): ToolCallCount[] {
		const byCallId = new Map<string, ToolCallCount>();
		const anonymous: ToolCallCount[] = [];
		for (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const payload = (parsed as { payload?: unknown })?.payload;
			if (payload === null || typeof payload !== "object") continue;
			const p = payload as {
				type?: unknown;
				name?: unknown;
				namespace?: unknown;
				call_id?: unknown;
				invocation?: { server?: unknown; tool?: unknown };
			};
			if (typeof p.type !== "string" || !CODEX_TOOL_CALL_TYPES.has(p.type)) continue;

			// `mcp_tool_call_end` states the server outright — the one shape where
			// no namespace parsing is needed or wanted.
			const invocationTool = typeof p.invocation?.tool === "string" ? p.invocation.tool : undefined;
			const server = typeof p.invocation?.server === "string" ? p.invocation.server : "";
			let call: ToolCallCount;
			if (invocationTool !== undefined) {
				call = server ? mcpTool(server, invocationTool) : builtinTool(invocationTool);
			} else if (typeof p.name === "string" && p.name.length > 0) {
				call = classifyCodexToolName(p.name, typeof p.namespace === "string" ? p.namespace : undefined);
			} else {
				continue;
			}

			const callId = typeof p.call_id === "string" ? p.call_id : undefined;
			if (callId === undefined) {
				anonymous.push(call);
				continue;
			}
			const known = byCallId.get(callId);
			// Upgrade-only: a builtin guess yields to a resolved MCP identity, and a
			// later builtin row (the request written after an event, or a result row
			// echoing the bare name) never overwrites one.
			if (known === undefined || (known.kind !== "mcp" && call.kind === "mcp")) byCallId.set(callId, call);
		}
		const tally = new ToolUseTally();
		for (const call of [...byCallId.values(), ...anonymous]) tally.add(call);
		return tally.values();
	}
}

/**
 * The `payload.type` values that represent one Codex tool call.
 *
 * Counted from real rollouts under `~/.codex/sessions` (40 files, Jul–Aug 2026):
 * `custom_tool_call` (804) and `function_call` (415) are the bulk; `web_search_call`
 * (2) is rarer but is still the agent calling a tool. `mcp_tool_call_end` carries
 * `invocation.{server,tool}` and is the MCP shape `CodexEnvelopeParser` documents
 * against 2026-06 connector rollouts (that capture had no MCP traffic, hence no
 * local count).
 *
 * The `*_output` siblings are deliberately absent: they are the SAME call's result
 * row, and counting them would double every call. `mcp_tool_call_begin` is absent
 * for the same reason — it pairs with the `_end` row already listed.
 */
const CODEX_TOOL_CALL_TYPES: ReadonlySet<string> = new Set([
	"function_call",
	"custom_tool_call",
	"local_shell_call",
	"web_search_call",
	"mcp_tool_call_end",
]);

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

	/**
	 * Tool calls over a slice of a Kimi `wire.jsonl`.
	 *
	 * The signal is a `tool.call` event inside the `context.append_loop_event`
	 * envelope, correlated elsewhere by `toolCallId` — the same shape
	 * {@link KimiEnvelopeParser} and {@link KimiSkillScanner} are pinned to
	 * against real `~/.kimi-code` captures. Only the CALL is counted; the paired
	 * `tool.result` is the same call's answer and would double it.
	 *
	 * Kimi names MCP tools Claude-style (`mcp__<server>__<tool>`), which is why
	 * `KimiEnvelopeParser` reuses Claude's registry match path verbatim — so the
	 * Claude classifier is correct here rather than merely close. `Skill` calls
	 * are re-attributed to `args.skill`, the first-class skill tool
	 * `KimiSkillScanner` reads.
	 */
	parseToolUse(lines: ReadonlyArray<string>): ToolCallCount[] {
		const tally = new ToolUseTally();
		for (const line of lines) {
			// Cheap pre-filter: only the loop-event envelope carries tool activity.
			if (!line.includes(KIMI_LOOP_EVENT_TYPE)) continue;
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (parsed.type !== KIMI_LOOP_EVENT_TYPE) continue;
			const event = parsed.event as
				| { type?: unknown; name?: unknown; toolCallId?: unknown; args?: { skill?: unknown } }
				| undefined;
			if (event === null || typeof event !== "object") continue;
			if (event.type !== "tool.call" || typeof event.name !== "string") continue;
			tally.addOnce(
				typeof event.toolCallId === "string" ? event.toolCallId : undefined,
				event.name === KIMI_SKILL_TOOL_NAME && typeof event.args?.skill === "string"
					? skillTool(event.args.skill)
					: classifyToolName(event.name),
			);
		}
		return tally.values();
	}

	parseTimestamp(line: string, _lineNum?: number): string | undefined {
		try {
			return kimiFrameTimestamp(JSON.parse(line) as Record<string, unknown>);
		} catch {
			return undefined;
		}
	}
}

/** Kimi's envelope for every loop event, including tool activity. */
const KIMI_LOOP_EVENT_TYPE = "context.append_loop_event";
/** Kimi's first-class skill tool — its `args.skill` names the skill that ran. */
const KIMI_SKILL_TOOL_NAME = "Skill";

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

/**
 * The sources this module has a parser for. Others use dedicated readers.
 *
 * MUST list every case `getParserForSource` accepts. It is the domain the
 * capability probe below iterates, so a source missing here can never enter
 * {@link TOOL_RECORDING_SOURCES} no matter what its parser implements — the
 * probe would report the parser's `parseToolUse` as if it did not exist. `kimi`
 * was missing for exactly that reason; the compile-time annotation now ties the
 * list to the factory's parameter type, so adding a parser without extending it
 * fails to build.
 */
const PARSER_BACKED_SOURCES: ReadonlyArray<Parameters<typeof getParserForSource>[0]> = [
	"claude",
	"codex",
	"kimi",
] as const;

/**
 * Sources whose tool calls come from a DEDICATED READER rather than a
 * `TranscriptParser`, and whose reader is known to populate
 * `TranscriptReadResult.toolUse`.
 *
 * This half of the set cannot be probed the way the parser half is: a reader is
 * a bare async function, not an object with an optional method, so there is
 * nothing to feature-test. The list is therefore hand-maintained, and the bar
 * for joining it is deliberately high — **a source belongs here only once its
 * reader has been written against a real capture of that host's transcripts.**
 *
 * Listing a source whose reader silently extracts nothing is strictly worse than
 * omitting it: every slice would report `toolUse: []`, and the consumers read
 * that as the positive claim "this agent called no tools" (see the `with_tools`
 * filters in `DashboardQuery` / `MemoriesQuery`). Omission degrades to
 * "unavailable", which is merely incomplete rather than false.
 *
 * Two layers of test hold this honest, and neither alone would: the membership
 * of this list is pinned in `TranscriptParserToolUse.test.ts` (which also pins
 * the sources deliberately kept OUT), while the evidence that each reader really
 * extracts something lives in that reader's own test file, asserting a non-empty
 * extraction over a real capture. Adding a source here means adding both.
 */
const READER_BACKED_TOOL_SOURCES = ["gemini", "opencode", "antigravity", "cursor-cli", "cline-cli", "devin"] as const;

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
 * The parser half is derived by probing, so adding `parseToolUse` to one of them
 * cannot leave this behind — provided the source is in
 * {@link PARSER_BACKED_SOURCES}, which is what makes that list's completeness
 * load-bearing. The reader half cannot be probed and is listed explicitly; see
 * {@link READER_BACKED_TOOL_SOURCES} for why the bar for joining it is a real
 * capture rather than a plausible-looking extractor.
 */
export const TOOL_RECORDING_SOURCES: ReadonlySet<string> = new Set<string>([
	...PARSER_BACKED_SOURCES.filter((source) => getParserForSource(source).parseToolUse !== undefined),
	...READER_BACKED_TOOL_SOURCES,
]);
