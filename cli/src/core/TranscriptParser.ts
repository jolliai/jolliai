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
import { isTestCommand } from "./TestCommandDetect.js";
import {
	builtinTool,
	classifyCodexToolName,
	classifyToolName,
	mcpTool,
	skillTool,
	ToolUseTally,
} from "./ToolNameClassify.js";
import { parseTranscriptLine } from "./TranscriptReader.js";

/**
 * Epoch ms of an ISO timestamp, or undefined when there is none to read or it
 * does not parse. Undefined rather than `NaN`/0: the field it feeds is optional
 * and its absence means "this parser had no instant to offer", which a zero
 * would turn into the claim "called at the epoch".
 */
function parseIsoMs(iso: string | undefined): number | undefined {
	if (iso === undefined) return undefined;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The latest of some instants as a spreadable fragment, absent when none of
 * them is known. Same reason as `mergeLastCallAt` in `ToolNameClassify`: an
 * absent time must stay absent rather than be written as `undefined` over a
 * known one.
 */
function latestOf(...times: ReadonlyArray<number | undefined>): { lastCallAtMs?: number } {
	const known = times.filter((t): t is number => t !== undefined);
	return known.length > 0 ? { lastCallAtMs: Math.max(...known) } : {};
}

/**
 * How many `tool_result` blocks one record's content carries.
 *
 * Only the count matters, and only to decide whether the record's single
 * `toolUseResult.commandName` can be attributed to a specific block — see
 * `ClaudeTranscriptParser.parseToolUse`.
 */
function countToolResults(content: ReadonlyArray<unknown>): number {
	let n = 0;
	// Plain member access, matching how the tally loop reads the same blocks: a `?.`
	// here would add a null branch no transcript can produce and no test can reach.
	for (const block of content) if ((block as { type?: unknown }).type === "tool_result") n++;
	return n;
}

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
	/** Count of consumed rows whose conversation-schema shape this parser does not
	 *  recognize — the format-drift canary. Distinct from "a row we understood and
	 *  chose to drop" (injection, a tool-only turn): those are recognized. A slice
	 *  that produced zero conversation entries BUT carries unrecognized rows is the
	 *  JOLLI-2240 failure mode (Codex moved conversation text into a shape we can no
	 *  longer read) — the cursor must be withheld so a fixed build re-reads it,
	 *  where a legitimately empty tool-only slice (all rows recognized) must advance.
	 *  Absent method = the source has no schema this parser tracks drift against (0). */
	parseUnrecognizedRows?(lines: ReadonlyArray<string>): number;
	/** Epoch-ms instants of context compactions over a whole consumed slice,
	 *  de-duplicated and sorted. Absent method = the source's transcripts carry no
	 *  compaction event. */
	parseCompactions?(lines: ReadonlyArray<string>): number[];
	/** Epoch-ms instants of aborted turns over a whole consumed slice,
	 *  de-duplicated and sorted. Absent method = the source's transcripts carry no
	 *  turn-abort event. */
	parseTurnAborts?(lines: ReadonlyArray<string>): number[];
	/** Epoch-ms instants the agent invoked a test runner over a whole consumed
	 *  slice, de-duplicated and sorted. Absent method = the source's transcripts
	 *  carry no exec tool (or cannot be read), so "ran no tests" is never claimed. */
	parseTestRuns?(lines: ReadonlyArray<string>): number[];
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
			// Carried per line so the reader can date each response's model without
			// a second whole-slice pass. `parseUsageByModel` still exists for the
			// aggregate; both read `extractClaudeUsage`, so they cannot disagree.
			// Omitted rather than emitted empty when the line names no model — the
			// aggregate buckets those under an empty id, and inventing that value
			// here would put it in front of every caller instead of one.
			...(usage.model && { model: usage.model }),
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
	 * A `Skill` call is re-attributed to the skill it ran, since "which skills does
	 * this person use" is the question being asked; counting every skill invocation
	 * as one builtin named `Skill` would answer nothing.
	 *
	 * ## The skill's name comes from the RESULT record, not from the request
	 *
	 * `input.skill` is what the model asked for; `toolUseResult.commandName`, on the
	 * following `tool_result` record, is what the host actually launched — and for a
	 * plugin-provided skill the two differ by the plugin prefix (`brainstorming`
	 * against `superpowers:brainstorming`). `ClaudeSkillScanner` has always preferred
	 * the resolved name, so reporting the requested one here made the two halves of
	 * one skill's usage disagree: `mergeToolCalls` folds on `(kind, name)`, so a
	 * single invocation surfaced as TWO `session_tool_use` rows — one of them under a
	 * name the user never typed, with the call count split between them.
	 *
	 * That is why skill blocks are held back rather than tallied where they are seen:
	 * the result record arrives after the request, so the resolved name is not known
	 * yet. Everything else is tallied inline, and the held-back skills are folded in
	 * at the end (which is why they sort last). A call whose result never arrived —
	 * an incremental slice that split the pair, a session still mid-turn — falls back
	 * to the requested name, exactly as before.
	 */
	parseToolUse(lines: ReadonlyArray<string>): ToolCallCount[] {
		const tally = new ToolUseTally();
		/** Skill requests, awaiting whatever name their result record resolves to. */
		const pendingSkills: Array<{ readonly id?: string; readonly requested: string; readonly atMs?: number }> = [];
		/** `tool_use_id` → the skill id the host reported launching for it. */
		const resolved = new Map<string, string>();
		for (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const record = parsed as { message?: { content?: unknown }; toolUseResult?: { commandName?: unknown } };
			const content = record?.message?.content;
			if (!Array.isArray(content)) continue;
			// Read once per line: the resolved name lives on the RECORD, beside the
			// content, while the id it belongs to lives in the `tool_result` block below.
			//
			// An EMPTY string is treated as no answer rather than as the name. It would
			// otherwise win the `??` fallback below and file the invocation under a
			// nameless skill — a row the user cannot recognise and cannot merge with the
			// scanner's own, since `mergeToolCalls` folds on the name.
			//
			const rawCommandName = record.toolUseResult?.commandName;
			const commandName =
				typeof rawCommandName === "string" && rawCommandName.length > 0 ? rawCommandName : undefined;
			// `toolUseResult` is ONE object, so it can only describe one result — and
			// Claude Code writes each tool result as its own record, which is why every
			// real record here carries exactly one `tool_result` block. A record with
			// several would leave no way to tell which one the name belongs to, and
			// handing it to all of them would rename an unrelated skill: two parallel
			// skill calls answered in one record would both take the first one's name.
			//
			// So a multi-result record resolves NOTHING and every skill in it falls back
			// to what the model requested. That is the same outcome as a result record
			// that never arrived, which the fold below already handles. Defensive rather
			// than observed: no capture shows this shape, and the check costs one pass
			// over a handful of blocks.
			const namesOneResult = countToolResults(content) === 1;
			// The line's own instant, so the bucket can be windowed by when the call
			// happened rather than by when its session was last touched. Read per
			// line and not per file: one session's calls span hours.
			const atMs = parseIsoMs(this.parseTimestamp(line));
			for (const block of content) {
				const b = block as {
					type?: unknown;
					id?: unknown;
					tool_use_id?: unknown;
					name?: unknown;
					input?: { skill?: unknown };
				};
				if (b.type === "tool_result") {
					if (commandName !== undefined && namesOneResult && typeof b.tool_use_id === "string")
						resolved.set(b.tool_use_id, commandName);
					continue;
				}
				if (b.type !== "tool_use" || typeof b.name !== "string") continue;
				const id = typeof b.id === "string" ? b.id : undefined;
				if (b.name === "Skill" && typeof b.input?.skill === "string") {
					pendingSkills.push({
						...(id !== undefined ? { id } : {}),
						requested: b.input.skill,
						...(atMs !== undefined ? { atMs } : {}),
					});
					continue;
				}
				tally.addOnce(id, {
					...classifyToolName(b.name),
					...(atMs !== undefined && { lastCallAtMs: atMs }),
				});
			}
		}
		for (const pending of pendingSkills) {
			// De-duplication still rides on the block id, so a response repeated across
			// lines contributes one call however many times it was held back.
			tally.addOnce(pending.id, {
				...skillTool((pending.id !== undefined ? resolved.get(pending.id) : undefined) ?? pending.requested),
				...(pending.atMs !== undefined && { lastCallAtMs: pending.atMs }),
			});
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

	parseCompactions(lines: ReadonlyArray<string>): number[] {
		const times = new Set<number>();
		for (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if ((parsed as { isCompactSummary?: unknown }).isCompactSummary !== true) continue;
			const atMs = parseIsoMs(this.parseTimestamp(line));
			if (atMs !== undefined) times.add(atMs);
		}
		return [...times].sort((a, b) => a - b);
	}

	parseTestRuns(lines: ReadonlyArray<string>): number[] {
		const times = new Set<number>();
		for (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const content = (parsed as { message?: { content?: unknown } }).message?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				const b = block as { type?: unknown; name?: unknown; input?: { command?: unknown } };
				if (b.type !== "tool_use" || b.name !== "Bash") continue;
				if (typeof b.input?.command !== "string" || !isTestCommand(b.input.command)) continue;
				const atMs = parseIsoMs(this.parseTimestamp(line));
				if (atMs !== undefined) times.add(atMs);
			}
		}
		return [...times].sort((a, b) => a - b);
	}
}

/** Codex `payload.type` values that mark a context compaction. */
const CODEX_COMPACTION_EVENT_TYPES: ReadonlySet<string> = new Set(["compacted", "context_compacted"]);

/** Epoch-ms instants of Codex events whose `payload.type` is in `types`. */
function codexEventInstants(lines: ReadonlyArray<string>, types: ReadonlySet<string>): number[] {
	const times = new Set<number>();
	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const payload = (parsed as { payload?: unknown })?.payload;
		if (payload === null || typeof payload !== "object") continue;
		const type = (payload as { type?: unknown }).type;
		if (typeof type !== "string" || !types.has(type)) continue;
		const rawAt = (parsed as { timestamp?: unknown }).timestamp;
		const atMs = parseIsoMs(typeof rawAt === "string" ? rawAt : undefined);
		if (atMs !== undefined) times.add(atMs);
	}
	return [...times].sort((a, b) => a - b);
}

/**
 * OpenAI Codex transcript parser.
 *
 * Extracts user and assistant messages from `response_item/message` entries
 * in the Codex JSONL rollout stream (role `user` or `assistant`; the injected
 * `developer` role — `<app-context>`, `<skills_instructions>` — is excluded).
 * Codex retired the older `event_msg/{user_message,agent_message}` shape;
 * `response_item` is a complete superset of it in every era (2214-rollout
 * scan, zero counterexamples), so reading only `response_item` covers all
 * history and never double-counts the transition-era rollouts that carry
 * BOTH shapes for the same turns. `event_msg` conversation events are no
 * longer parsed at all.
 *
 * `parseToolUse` is unaffected by this — it reads its own event types
 * independently of this method. (Codex implements no `parseUsageByModel`;
 * `token_count` rows are not consumed for Codex, so usageTokens is
 * effectively 0.)
 *
 * Skipped event types: event_msg/*, session_meta, turn_context,
 * response_item/{function_call,function_call_output,reasoning}, compacted.
 */
export class CodexTranscriptParser implements TranscriptParser {
	parseLine(line: string, lineNum: number): TranscriptEntry | null {
		try {
			const data = JSON.parse(line) as Record<string, unknown>;
			const timestamp = typeof data.timestamp === "string" ? data.timestamp : undefined;

			// Conversation turns now arrive as response_item/message (Codex retired the
			// event_msg/{user_message,agent_message} shape). response_item is a complete
			// superset of event_msg in every era (2214-rollout scan, zero counterexamples),
			// so reading only it covers all history and never double-counts the transition-
			// era rollouts that carry BOTH shapes for the same turns. See TranscriptParser
			// class docstring / JOLLI-2240.
			if (data.type !== "response_item") return null;

			const payload = data.payload as Record<string, unknown> | undefined;
			if (!payload || typeof payload !== "object") return null;
			if (payload.type !== "message") return null;

			// developer-role messages are pure injection (<app-context>, <skills_instructions>).
			const role = payload.role;
			if (role !== "user" && role !== "assistant") return null;

			const rawText = extractCodexMessageText(payload.content);
			if (rawText === null) return null;

			// Codex appends its own memory-citation trailer to genuine turns; strip it
			// so the captured conversation keeps only what was actually said. A turn
			// that is nothing but the trailer carries no conversation and is dropped.
			const text = stripCodexMemCitation(rawText);
			if (text.length === 0) return null;

			if (role === "user") {
				if (isCodexInjectedUserText(text)) return null;
				return { role: "human", content: text, timestamp };
			}
			return { role: "assistant", content: text, timestamp };
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

			// Stamped on every row, INCLUDING the ones the upgrade rule discards
			// below: a call's rows (request, then `mcp_tool_call_end`) are written
			// at different instants, and the identity that wins is not necessarily
			// the row that happened last. Carrying the later of the two keeps the
			// bucket's time honest regardless of which row won.
			// Read off the envelope rather than through a `parseTimestamp` method:
			// this parser has none, and adding one would also change which lines the
			// incremental cutoff can see — a separate decision from this one.
			const rawAt = (parsed as { timestamp?: unknown }).timestamp;
			const atMs = parseIsoMs(typeof rawAt === "string" ? rawAt : undefined);
			const timed: ToolCallCount = { ...call, ...(atMs !== undefined && { lastCallAtMs: atMs }) };

			const callId = typeof p.call_id === "string" ? p.call_id : undefined;
			if (callId === undefined) {
				anonymous.push(timed);
				continue;
			}
			const known = byCallId.get(callId);
			// Upgrade-only: a builtin guess yields to a resolved MCP identity, and a
			// later builtin row (the request written after an event, or a result row
			// echoing the bare name) never overwrites one.
			const winner = known === undefined || (known.kind !== "mcp" && timed.kind === "mcp") ? timed : known;
			byCallId.set(callId, {
				...winner,
				...(known ? latestOf(known.lastCallAtMs, timed.lastCallAtMs) : latestOf(timed.lastCallAtMs)),
			});
		}
		const tally = new ToolUseTally();
		for (const call of [...byCallId.values(), ...anonymous]) tally.add(call);
		return tally.values();
	}

	/**
	 * Counts consumed `response_item` rows this build cannot read as conversation,
	 * at BOTH drift levels: an unknown `payload.type` (see
	 * {@link KNOWN_CODEX_RESPONSE_ITEM_TYPES}), and a `message` whose type is known
	 * but whose inner role/content shape changed underneath ({@link
	 * isDriftedCodexMessage}). A non-zero count on a slice that yielded no
	 * conversation entries is the format-drift signal that keeps the read cursor
	 * withheld — {@link parseToolUse} is computed independently of {@link parseLine},
	 * so without this a tool-heavy session whose message rows changed shape (renamed
	 * role, renamed text content type) would still report tool calls, advance the
	 * cursor, and strand its unread conversation (the JOLLI-2240 failure mode, one
	 * shape further along). Deliberately NOT counted: a message we understood and
	 * dropped (injection/citation filtering) or an image-only turn — see
	 * {@link isDriftedCodexMessage} for why each is drop-but-not-drift.
	 */
	parseUnrecognizedRows(lines: ReadonlyArray<string>): number {
		let unknown = 0;
		for (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if ((parsed as { type?: unknown })?.type !== "response_item") continue;
			const payload = (parsed as { payload?: unknown }).payload;
			if (payload === null || typeof payload !== "object") continue;
			const type = (payload as { type?: unknown }).type;
			if (typeof type !== "string") continue;
			// Outer drift: a payload.type introduced after this build.
			if (!KNOWN_CODEX_RESPONSE_ITEM_TYPES.has(type)) {
				unknown++;
				continue;
			}
			// Inner drift: a `message` whose payload.type we still know but whose role /
			// content shape changed underneath — the same silent-strand failure one
			// level deeper. Counted here so a tool-heavy slice whose message rows
			// changed shape still withholds its cursor (parseToolUse is independent of
			// parseLine, so it would otherwise report tools and advance past unread text).
			if (type === "message" && isDriftedCodexMessage(payload as { role?: unknown; content?: unknown })) {
				unknown++;
			}
		}
		return unknown;
	}

	parseCompactions(lines: ReadonlyArray<string>): number[] {
		return codexEventInstants(lines, CODEX_COMPACTION_EVENT_TYPES);
	}

	parseTurnAborts(lines: ReadonlyArray<string>): number[] {
		return codexEventInstants(lines, new Set(["turn_aborted"]));
	}

	parseTestRuns(lines: ReadonlyArray<string>): number[] {
		const times = new Set<number>();
		for (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const payload = (parsed as { payload?: unknown })?.payload;
			if (payload === null || typeof payload !== "object") continue;
			const p = payload as { type?: unknown; name?: unknown; arguments?: unknown };
			if (p.type !== "function_call" || p.name !== "exec_command") continue;
			let cmd: unknown;
			try {
				const args = typeof p.arguments === "string" ? (JSON.parse(p.arguments) as { cmd?: unknown }) : {};
				cmd = args.cmd;
			} catch {
				continue;
			}
			if (typeof cmd !== "string" || !isTestCommand(cmd)) continue;
			const rawAt = (parsed as { timestamp?: unknown }).timestamp;
			const atMs = parseIsoMs(typeof rawAt === "string" ? rawAt : undefined);
			if (atMs !== undefined) times.add(atMs);
		}
		return [...times].sort((a, b) => a - b);
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
 * Every `response_item` payload.type this build knows how to handle — whether it
 * becomes a conversation entry (`message`), a tool call, or is deliberately
 * ignored (`reasoning`, the `*_output` result rows). Enumerated from all 2026
 * rollouts under `~/.codex/sessions` and kept deliberately GENEROUS: a value here
 * that never occurs costs nothing, while a real value MISSING would misread a
 * healthy slice as drift. The point is the complement — a `response_item` whose
 * payload.type is NOT in this set is a shape Codex introduced after this build,
 * the JOLLI-2240 canary (see {@link CodexTranscriptParser.parseUnrecognizedRows}).
 * Only `response_item` is policed: other top-level `type`s (session_meta,
 * event_msg, turn_context, token_count, …) are legitimately not conversation
 * carriers and parseLine ignores them by design.
 */
const KNOWN_CODEX_RESPONSE_ITEM_TYPES: ReadonlySet<string> = new Set([
	"message",
	"reasoning",
	"function_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
	"local_shell_call",
	"local_shell_call_output",
	"tool_search_call",
	"tool_search_output",
	"web_search_call",
	"mcp_tool_call_begin",
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
			// Every Kimi wire event carries a millisecond-epoch `time`; `parseTimestamp`
			// is the one place that shape is decoded.
			const atMs = parseIsoMs(this.parseTimestamp(line));
			tally.addOnce(typeof event.toolCallId === "string" ? event.toolCallId : undefined, {
				...(event.name === KIMI_SKILL_TOOL_NAME && typeof event.args?.skill === "string"
					? skillTool(event.args.skill)
					: classifyToolName(event.name)),
				...(atMs !== undefined && { lastCallAtMs: atMs }),
			});
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
 * Concatenated text of a Codex `response_item/message` payload's content array.
 * User turns carry `input_text` items, assistant turns `output_text`; both are
 * joined with newlines. Non-text items (images, etc.) are ignored. Returns null
 * when no text survives trimming.
 */
/**
 * True for a `response_item/message` payload whose INNER shape Codex changed in a
 * way that costs conversation — the drift one level deeper than a renamed
 * `payload.type`, which {@link CodexTranscriptParser.parseUnrecognizedRows} counts
 * on its own. Two axes, each measured against a genuine drop that is NOT drift:
 *
 *   - `role` is a string Codex now emits that maps to neither speaker. A user or
 *     assistant turn we understand-and-drop (injection/citation filtering) still
 *     carries `user`/`assistant`, so this never fires on those; a missing role is
 *     left uncounted deliberately (malformed, not a new encoding).
 *   - a content item carries a string `text` under a `type` this build does not
 *     read (e.g. `output_text` renamed). An image-only item carries no string
 *     `text`, so an image-only turn — legitimately unrepresentable as text, and
 *     dropped by {@link extractCodexMessageText} for that reason — is NOT drift and
 *     must not withhold its slice's cursor forever.
 */
function isDriftedCodexMessage(payload: { role?: unknown; content?: unknown }): boolean {
	const role = payload.role;
	if (typeof role === "string" && role !== "user" && role !== "assistant") return true;
	const content = payload.content;
	if (Array.isArray(content)) {
		for (const item of content) {
			if (!item || typeof item !== "object") continue;
			const type = (item as { type?: unknown }).type;
			const text = (item as { text?: unknown }).text;
			if (typeof text === "string" && type !== "input_text" && type !== "output_text") return true;
		}
	}
	return false;
}

function extractCodexMessageText(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const type = (item as { type?: unknown }).type;
		const text = (item as { text?: unknown }).text;
		if ((type === "input_text" || type === "output_text") && typeof text === "string") {
			parts.push(text);
		}
	}
	const joined = parts.join("\n").trim();
	return joined.length > 0 ? joined : null;
}

/**
 * True for user-role `response_item/message` text that is Codex-injected context
 * rather than a genuine user submission. The `event_msg/user_message` stream
 * excluded exactly these; the raw `response_item` stream does not. Prefixes are
 * derived from real rollouts (JOLLI-2240 Observed Reality) and guarded by the
 * captured fixture in TranscriptParserFixtures.test.ts. The `# Files mentioned by
 * the user:` wrapper is deliberately NOT here — it is a real submission.
 */
// Each Codex injection is recognized by its opening token PLUS a structural
// companion signal, never by the opening token alone. The companion is what keeps
// a GENUINE user turn that merely quotes or asks about one of these tokens (e.g.
// "what does <turn_aborted> mean?", "# AGENTS.md instructions are confusing") from
// being dropped wholesale — the P2 false-positive of a bare-prefix match. All
// signatures are derived and verified against 2214 real codex-tui/codex_vscode
// rollouts (JOLLI-2240): the structural form drops the identical 2631 injected
// user turns the bare-prefix form did, with zero genuine turns lost.
//
//   - `<recommended_plugins>` / `<environment_context>` / `<skill>` / `<turn_aborted>`:
//     wrapped blocks Codex injects as a user turn. The companion is the matching
//     CLOSE tag — a real injection always closes, a user quoting the open tag does
//     not. `<skill>` carries a full SKILL.md body (name/path/--- frontmatter/…);
//     across 157 real rollouts none carried a `## My request` payload, so dropping
//     the whole turn is safe.
//   - `# AGENTS.md instructions[ for <cwd>]`: the AGENTS.md file injected as a user
//     turn. Joined, it starts with the header rather than a tag (which is how a
//     38 KB dump reached the conversation), so the companion is its injected body —
//     an `<INSTRUCTIONS>` or `<environment_context>` block.
//   - `The following is the Codex agent history`: the approval-reviewer wrapper
//     ("untrusted evidence", not a user utterance); the companion is that framing.
//
// `# Context from my IDE setup:` / `# Review findings:` / `# Files mentioned by the
// user:` are deliberately NOT injections — each ends with a real `## My request for
// Codex:` submission, so dropping it would delete the user's actual ask.
const CODEX_INJECTED_WRAPPED_TAGS: ReadonlyArray<string> = [
	"recommended_plugins",
	"environment_context",
	"skill",
	"turn_aborted",
];
function isCodexInjectedUserText(text: string): boolean {
	const t = text.trimStart();
	for (const tag of CODEX_INJECTED_WRAPPED_TAGS) {
		if (t.startsWith(`<${tag}>`) && text.includes(`</${tag}>`)) return true;
	}
	// Companion is a fully-CLOSED injected block, not a bare mention: the real
	// injection always carries one, while a genuine turn that opens with the header
	// and merely quotes `<environment_context>`/`<INSTRUCTIONS>` in prose does not —
	// so a bare `includes` here would drop that real submission.
	if (
		t.startsWith("# AGENTS.md instructions") &&
		(/<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>/.test(text) ||
			/<environment_context>[\s\S]*<\/environment_context>/.test(text))
	) {
		return true;
	}
	if (t.startsWith("The following is the Codex agent history") && text.includes("untrusted evidence")) {
		return true;
	}
	// Image-only placeholder messages carry no real text once the tags are removed.
	const withoutImages = text.replace(/<image\b[^>]*\/?>|<\/image>/g, "").trim();
	return withoutImages.length === 0;
}

/**
 * Codex's memory feature APPENDS an `<oai-mem-citation>…</oai-mem-citation>` block
 * to a genuine turn (measured on 220 real assistant turns, JOLLI-2240: always a
 * clean, fully-closed block at the very end, `\n\n`-separated from the real text).
 * It is injected metadata — the citations Codex resolved for its own memory tool,
 * not part of what the user or the model said — so unlike the injected user turns
 * above it must NOT drop the whole turn (that would delete the entire assistant
 * response); the trailer is stripped and the content before it is kept. Each block
 * body is TEMPERED (`(?!</oai-mem-citation>)`) so one block cannot span across an
 * intermediate close tag, and the group repeats over a `$`-anchored run — so a run
 * of trailing blocks is removed in one pass while genuine text that happens to sit
 * BETWEEN two citation blocks (which a single greedy `[\s\S]*`, or even a lazy
 * `[\s\S]*?` backtracking to reach `$`, would have swallowed) is kept.
 */
const CODEX_MEM_CITATION_TRAILER =
	/(?:\s*<oai-mem-citation>(?:(?!<\/oai-mem-citation>)[\s\S])*<\/oai-mem-citation>)+\s*$/;
function stripCodexMemCitation(text: string): string {
	return text.replace(CODEX_MEM_CITATION_TRAILER, "").trimEnd();
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
export const PARSER_BACKED_SOURCES: ReadonlyArray<Parameters<typeof getParserForSource>[0]> = [
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
 *
 * `cursor` joined once its conversations started being READ from the same
 * `agent-transcripts` JSONL `cursor-cli` uses, which is where its `tool_use` blocks
 * live — the composer store it used to be read from drops them, which is why it sat
 * in the excluded list before. One residual is deliberate: a composer with no JSONL
 * is still read from that store, and reports NO `toolUse` rather than an empty one,
 * so it degrades to "unavailable" per-conversation instead of claiming zero calls.
 */
const READER_BACKED_TOOL_SOURCES = [
	"gemini",
	"opencode",
	"antigravity",
	"cursor",
	"cursor-cli",
	"cline-cli",
	"devin",
] as const;

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
