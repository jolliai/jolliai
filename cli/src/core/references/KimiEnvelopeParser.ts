/**
 * KimiEnvelopeParser — the Moonshot Kimi Code CLI (`@kimi-code/cli`) wire envelope.
 *
 * Kimi's transcript (`~/.kimi-code/sessions/<workDirKey>/<sessionId>/agents/main/
 * wire.jsonl`) writes one JSON event per line. Tool activity is nested inside a
 * `context.append_loop_event` envelope (verified against real ~/.kimi-code
 * captures):
 *
 *   tool.call:   {"type":"context.append_loop_event",
 *                 "event":{"type":"tool.call","toolCallId":"<id>","name":"<tool>","args":{…}},
 *                 "time":<ms-epoch>}
 *   tool.result: {"type":"context.append_loop_event",
 *                 "event":{"type":"tool.result","toolCallId":"<id>","result":{"output":"<STRING>","isError":true?}},
 *                 "time":<ms-epoch>}
 *
 * `toolCallId` correlates a call to its result. `time` is a millisecond epoch on
 * the OUTER envelope (not the inner event), converted to ISO with
 * `new Date(time).toISOString()`.
 *
 * Kimi names MCP tools Claude-style — `mcp__<server>__<tool>` (e.g.
 * `mcp__jollimemory__search`) — so identity resolution reuses the CLAUDE match
 * path verbatim (`getRegistry().match("claude", name)`); there is no `match.kimi`
 * and no new `SourceAgent`. For an MCP `tool.result`, `event.result.output` is a
 * JSON **string** — it is `JSON.parse`d to recover the business payload, which is
 * then normalised through the shared {@link normalizeMcpBusiness} (identity for
 * most sources; the context-normalizers for slack / zoom-doc / confluence /
 * monday / context7 / jollimemory, which read the tool INPUT = `event.args`).
 *
 * Built-in tools (Read/Bash/Glob) also appear as `tool.call` with those bare
 * names — no `mcp__` prefix — so they never match and are ignored.
 *
 * Kimi transcripts carry no Claude-style pasted Slack permalinks, so the
 * permalink map passed to the shared normalizer is always EMPTY; a Slack
 * reference still gets its URL from `opts.slackWorkspaceUrl` when configured.
 *
 * Cursor semantics: an MCP `tool.call` in the TRAILING suffix (after the last
 * paired result) whose result has not yet appeared rewinds the cursor to that
 * call's line, so the next pass re-reads from there and can correlate it (re-scan
 * is idempotent via the shared dedupe + upsert-by-mapKey). The rewind is scoped to
 * that suffix, NOT the global-minimum unpaired call: an earlier call that never
 * gets a result (tool cancelled, session killed) sits before the last paired
 * result and must not pin the cursor. Every other case advances to EOF.
 */

import { createLogger } from "../../Logger.js";
import { isObject } from "./guards.js";
import { normalizeMcpBusiness } from "./McpBusinessNormalize.js";
import type { SourceDefinition } from "./SourceDefinition.js";
import { getRegistry } from "./SourceDefinitionRegistry.js";
import type {
	EnvelopeParseResult,
	ExtractOptions,
	NormalizedToolResult,
	TranscriptEnvelopeParser,
} from "./TranscriptEnvelopeParser.js";

const log = createLogger("KimiEnvelopeParser");

const LOOP_EVENT_TYPE = "context.append_loop_event";
const MCP_PREFIX = "mcp__";

interface PendingCall {
	readonly def: SourceDefinition;
	readonly toolName: string;
	/** The tool call's `args` object — the tool INPUT a context-normalizer reads. */
	readonly args: unknown;
	/** ISO timestamp of the tool.call envelope, "" when the call carried no `time`. */
	readonly timestamp: string;
	/** 0-based line index of the tool.call — the cursor rewinds here if it stays unpaired. */
	readonly lineIndex: number;
}

class KimiEnvelopeParser implements TranscriptEnvelopeParser {
	parse(lines: string[], opts: ExtractOptions): EnvelopeParseResult {
		const fromLine = opts.fromLineNumber ?? 0;
		const registry = getRegistry();
		const pending = new Map<string, PendingCall>();
		const results: NormalizedToolResult[] = [];
		let lastConsumed = fromLine;
		// 0-based line index of the last tool.result that paired with a pending call.
		// The cursor rewind below is scoped to calls AFTER this line, so a call that
		// never gets a result (tool cancelled, session killed) sitting BEFORE a later
		// paired result cannot pin the cursor forever — mirrors ClaudeEnvelopeParser's
		// `lastResultLineIndex` scoping (a bug it documents having fixed).
		let lastResultLineIndex = fromLine - 1;

		for (let i = fromLine; i < lines.length; i++) {
			const line = lines[i];
			lastConsumed = i + 1;
			if (line.length === 0) continue;
			// Cheap pre-filter: only the loop-event envelope carries tool activity.
			if (!line.includes(LOOP_EVENT_TYPE)) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (err) {
				log.warn(
					"Skipping malformed Kimi line %d: %s | preview=%s",
					i,
					(err as Error).message,
					line.slice(0, 200),
				);
				continue;
			}
			if (!isObject(parsed) || parsed.type !== LOOP_EVENT_TYPE) continue;
			const event = parsed.event;
			if (!isObject(event)) continue;
			const timestamp = isoFromTime(parsed.time);

			if (event.type === "tool.call") {
				const name = readString(event.name);
				const toolCallId = readString(event.toolCallId);
				if (name === undefined || toolCallId === undefined) continue;
				// Built-in tools (Read/Bash/Glob) carry no `mcp__` prefix — ignore them.
				if (!name.startsWith(MCP_PREFIX)) continue;
				// Honour the beforeTimestamp cutoff on the CALL (mirrors the Claude
				// parser's tool_use cutoff): a call past the cutoff is not stashed, so
				// its result later finds no pending entry and is dropped too.
				if (afterCutoff(timestamp, opts.beforeTimestamp)) continue;
				const def = registry.match("claude", name);
				if (def === undefined) continue;
				pending.set(toolCallId, { def, toolName: name, args: event.args, timestamp, lineIndex: i });
				continue;
			}

			if (event.type === "tool.result") {
				const toolCallId = readString(event.toolCallId);
				if (toolCallId === undefined) continue;
				const call = pending.get(toolCallId);
				if (call === undefined) continue;
				// A result for a tracked call landed at line i: this is the tail boundary.
				lastResultLineIndex = i;
				// Drop a result past the cutoff, but delete the pending entry first so it
				// does not pin the cursor as an in-flight call forever.
				if (afterCutoff(timestamp, opts.beforeTimestamp)) {
					pending.delete(toolCallId);
					continue;
				}
				const result = isObject(event.result) ? event.result : undefined;
				const output = result === undefined ? undefined : readString(result.output);
				if (output === undefined) {
					pending.delete(toolCallId);
					continue;
				}
				let business = tryParse(output);
				if (business === null) {
					// An arguments-derived source (context7) returns PROSE, not JSON — its
					// reference is built from the tool INPUT, so an unparseable result is
					// expected. Hand the normalizer an empty payload rather than dropping it
					// (mirrors ClaudeEnvelopeParser / CodexEnvelopeParser); without this every
					// context7 reference from Kimi is silently lost. Every other source
					// genuinely needs its payload, so those still drop. Either way the call
					// has been answered, so the pending entry is removed and the cursor advances.
					if (call.def.argumentsDerived === true) {
						business = {};
					} else {
						pending.delete(toolCallId);
						continue;
					}
				}
				const payload = normalizeMcpBusiness(call.def, call.toolName, call.args, business, {
					permalinks: EMPTY_PERMALINKS,
					opts,
				});
				pending.delete(toolCallId);
				if (payload === null) continue;
				results.push({
					def: call.def,
					toolName: call.toolName,
					payload,
					lineNumber: i + 1,
					referencedAt: timestamp,
				});
			}
		}

		// Emit in transcript line order so the shared dedupe's tie-break is stable.
		results.sort((a, b) => a.lineNumber - b.lineNumber);

		// Hold the cursor before the earliest unpaired MCP call in the TRAILING suffix —
		// after the last paired result (an in-flight fetch, or a tail flushed mid-pair):
		// advancing past it would strand its result next pass. Scoping to
		// `> lastResultLineIndex` (not the global minimum) is load-bearing: an earlier
		// call that never gets a result (tool cancelled, session killed) sits before the
		// last paired result and must NOT drag the cursor back — otherwise it pins the
		// cursor forever and the whole tail is re-scanned every tick. Same fix, and same
		// rationale, as ClaudeEnvelopeParser's tail-rewind.
		let safeCursor = lastConsumed;
		let earliestTailUnpaired = Number.POSITIVE_INFINITY;
		for (const call of pending.values()) {
			if (call.lineIndex > lastResultLineIndex && call.lineIndex < earliestTailUnpaired) {
				earliestTailUnpaired = call.lineIndex;
			}
		}
		if (earliestTailUnpaired !== Number.POSITIVE_INFINITY) safeCursor = earliestTailUnpaired;
		return { results, lastLineNumberScanned: safeCursor };
	}
}

/** Kimi transcripts carry no pasted Slack permalinks — the shared normalizer gets an empty map. */
const EMPTY_PERMALINKS: Map<string, string> = new Map();

export const kimiEnvelopeParser: TranscriptEnvelopeParser = new KimiEnvelopeParser();

/** True when `timestamp` is a non-empty ISO string strictly after `cutoff`. */
function afterCutoff(timestamp: string, cutoff: string | undefined): boolean {
	return cutoff !== undefined && timestamp !== "" && timestamp > cutoff;
}

/** Convert a millisecond-epoch `time` field to an ISO string, or "" when absent/out-of-range. */
function isoFromTime(time: unknown): string {
	if (typeof time !== "number") return "";
	const d = new Date(time);
	// A finite-but-absurd epoch (|t| > 8.64e15 ms) makes `getTime()` NaN; guarding it
	// here keeps `toISOString()` from throwing RangeError on malformed wire data.
	if (Number.isNaN(d.getTime())) return "";
	return d.toISOString();
}

function readString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/** Try JSON.parse; return null (not throw) on failure. */
function tryParse(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}
