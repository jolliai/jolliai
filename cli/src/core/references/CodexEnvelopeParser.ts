/**
 * CodexEnvelopeParser — the OpenAI Codex `codex_apps` connector envelope.
 *
 * Codex rollout JSONL encodes each MCP call across up to three line types
 * (all verified against real 2026-06-05 rollouts):
 *   - `function_call`        — request: { namespace:"mcp__codex_apps__<src>", name, call_id, arguments }
 *   - `function_call_output` — result : { call_id, output:"Wall time: …\nOutput:\n<JSON>" }
 *   - `mcp_tool_call_end`    — event  : { call_id, invocation:{tool}, result.Ok.content:[{type:"text",text:<JSON>}] }
 *
 * This parser correlates request+result by `call_id`. The `function_call_output`
 * path is PRIMARY because it carries the richest payload — crucially, for Jira
 * the tenant `webUrl` lives ONLY here (`{issues:{nodes:[{… webUrl …}]}}`); the
 * `mcp_tool_call_end` event gives a bare issue with no usable URL (`self` is the
 * `api.atlassian.com` gateway). The event is used only as a fallback for
 * call_ids that produced no `function_call_output`.
 *
 * Tool identity and per-source normalisation are NOT in this file — they live in
 * the `./bindings/codex` producer registry ({@link CodexBinding}). Each binding
 * declares the tool names it is reached through (fetch AND search), the canonical
 * tool name persisted as `sourceToolName`, and how to normalize its payload
 * (single entity or search/list collection) for the UNCHANGED adapters. This
 * parser only correlates lines and delegates identity + normalisation to that
 * registry.
 *
 * Shell CLI fallback: Codex also resolves entities via plain shell, e.g.
 * `gh issue view <n> --json …` (a `function_call` named `shell_command`, no
 * namespace, paired with a `function_call_output` whose body is prefixed
 * `Exit code: N\nWall time: …\nOutput:\n`). The command string is matched against
 * the agent-neutral `./bindings/cli` registry; a recognised, exit-0 result is
 * normalised and emitted just like an MCP pair. Recognition + normalisation live
 * in that registry, not here.
 *
 * Robustness: the `Wall time:`/`Exit code:` prefix is stripped only when present;
 * every parse is wrapped and a non-JSON output (e.g. `execution error: Io(...)`)
 * is skipped.
 */

import { createLogger } from "../../Logger.js";
import type { SourceId } from "../../Types.js";
import { type CliBinding, matchCliCommand } from "./bindings/cli/index.js";
import { codexBindingFromFunctionCall, codexBindingFromInvocationTool } from "./bindings/codex/index.js";
import type { SourceAdapter } from "./sources/SourceAdapter.js";
import type {
	EnvelopeParseResult,
	ExtractOptions,
	NormalizedToolResult,
	TranscriptEnvelopeParser,
} from "./TranscriptEnvelopeParser.js";

const log = createLogger("CodexEnvelopeParser");

const OUTPUT_MARKER = "\nOutput:\n";

interface FunctionCallRow {
	readonly namespace: string;
	readonly name: string;
	/** 0-based line index of the request — used to hold the cursor before an
	 *  in-flight (output-not-yet-written) fetch call so the next poll re-reads it. */
	readonly lineIndex: number;
}
interface FunctionOutputRow {
	readonly output: string;
	readonly lineNumber: number;
	readonly referencedAt: string;
}
interface ToolCallEndRow {
	readonly callId: string | undefined;
	readonly tool: string;
	readonly text: string;
	readonly lineNumber: number;
	readonly referencedAt: string;
}
interface ShellCallRow {
	readonly binding: CliBinding;
	/** 0-based line index of the request — holds the cursor before an in-flight
	 *  (output-not-yet-written) shell call, exactly like an MCP fetch. */
	readonly lineIndex: number;
}

class CodexEnvelopeParser implements TranscriptEnvelopeParser {
	parse(lines: string[], opts: ExtractOptions, adapters: readonly SourceAdapter[]): EnvelopeParseResult {
		const fromLine = opts.fromLineNumber ?? 0;
		const adapterFor = (id: SourceId): SourceAdapter | undefined => adapters.find((a) => a.id === id);

		const calls = new Map<string, FunctionCallRow>();
		const shellCalls = new Map<string, ShellCallRow>();
		const outputs = new Map<string, FunctionOutputRow>();
		const events: ToolCallEndRow[] = [];
		// call_ids whose result row (a function_call_output OR an mcp_tool_call_end)
		// physically appeared in this scan window — recorded BEFORE the cutoff filter
		// and regardless of parse success. This drives cursor-hold (see below). It is
		// deliberately decoupled from `outputs`/`events` (which are cutoff-filtered
		// and parse-gated): a request whose result was dropped by `beforeTimestamp`
		// or failed to parse has still been answered, so it must not pin the cursor.
		const resultSeen = new Set<string>();
		let lastConsumed = fromLine;

		for (let i = fromLine; i < lines.length; i++) {
			const line = lines[i];
			lastConsumed = i + 1;
			if (line.length === 0) continue;
			// Substring pre-filter for the three line types we correlate:
			//   - function_call request  → carries the `mcp__codex_apps__<src>` namespace
			//   - mcp_tool_call_end event → carries `mcp_tool_call_end`
			//   - function_call_output    → carries ONLY call_id + output (NO namespace),
			//     so it must be matched on its own `function_call_output` type token.
			// Missing the last one silently drops the PRIMARY path's result rows
			// (the richest payload — e.g. Jira's tenant webUrl lives only there).
			if (
				!line.includes("mcp__codex_apps__") &&
				!line.includes("mcp_tool_call_end") &&
				!line.includes("function_call_output") &&
				// A `gh` shell request is a `function_call` with name `shell_command`
				// and NO `mcp__codex_apps__` namespace — it would be dropped by the
				// three needles above, losing the command string. Its paired output is
				// a `function_call_output` (already covered).
				!line.includes("shell_command")
			) {
				continue;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (err) {
				log.warn(
					"Skipping malformed Codex line %d: %s | preview=%s",
					i,
					(err as Error).message,
					line.slice(0, 200),
				);
				continue;
			}
			if (!isObject(parsed)) continue;
			const payload = parsed.payload;
			if (!isObject(payload)) continue;
			const referencedAt = readString(parsed.timestamp) ?? "";
			const callId = readString(payload.call_id);

			switch (payload.type) {
				case "function_call": {
					const namespace = readString(payload.namespace);
					const name = readString(payload.name);
					// Shell CLI fallback (e.g. `gh issue view … --json`): a shell request
					// is a `function_call` named `shell_command` with NO namespace. The
					// command lives in the JSON-string `arguments`. Recognised commands
					// go to a SEPARATE map (the namespace-keyed `calls` map can't hold them).
					if (callId !== undefined && name === "shell_command") {
						const command = readShellCommand(payload.arguments);
						if (command !== undefined) {
							const binding = matchCliCommand(command);
							if (binding !== null) shellCalls.set(callId, { binding, lineIndex: i });
						}
						break;
					}
					if (callId !== undefined && namespace !== undefined && name !== undefined) {
						calls.set(callId, { namespace, name, lineIndex: i });
					}
					break;
				}
				case "function_call_output": {
					const output = readString(payload.output);
					// Mark the request answered for cursor-hold purposes BEFORE any
					// cutoff/parse gate — otherwise a cutoff-dropped result would leave
					// its request looking in-flight and pin the cursor on it forever.
					if (callId !== undefined) resultSeen.add(callId);
					// Honour the parser-interface beforeTimestamp contract: drop results
					// whose timestamp is past the cutoff (same semantics as the Claude parser).
					if (afterCutoff(referencedAt, opts.beforeTimestamp)) break;
					if (callId !== undefined && output !== undefined) {
						outputs.set(callId, { output, lineNumber: i + 1, referencedAt });
					}
					break;
				}
				case "mcp_tool_call_end": {
					if (callId !== undefined) resultSeen.add(callId);
					if (afterCutoff(referencedAt, opts.beforeTimestamp)) break;
					const tool = readInvocationTool(payload.invocation);
					const text = readToolCallEndText(payload.result);
					if (tool !== undefined && text !== undefined) {
						events.push({ callId, tool, text, lineNumber: i + 1, referencedAt });
					}
					break;
				}
				default:
					break;
			}
		}

		const results: NormalizedToolResult[] = [];
		const emitted = new Set<string>();

		// PRIMARY: function_call + function_call_output pairs (richest payload).
		for (const [callId, out] of outputs) {
			const call = calls.get(callId);
			if (call === undefined) continue;
			const binding = codexBindingFromFunctionCall(call.namespace, call.name);
			if (binding === null) continue;
			const business = parseFunctionCallOutput(out.output);
			if (business === null) continue;
			const adapter = adapterFor(binding.id);
			/* v8 ignore next -- adapters always include all four sources; guarded for totality. */
			if (adapter === undefined) continue;
			results.push({
				adapter,
				toolName: binding.canonicalToolName,
				payload: binding.normalize(business),
				lineNumber: out.lineNumber,
				referencedAt: out.referencedAt,
			});
			emitted.add(callId);
		}

		// PRIMARY (CLI): shell_command + function_call_output pairs. Gated on
		// `Exit code: 0` — a failed command whose stdout happens to be valid issue
		// JSON must NOT be ingested. shell call_ids never overlap MCP ones and there
		// is no mcp_tool_call_end fallback for shell, so no `emitted` tracking.
		for (const [callId, shell] of shellCalls) {
			const out = outputs.get(callId);
			if (out === undefined) continue;
			if (readExitCode(out.output) !== 0) continue;
			const business = parseFunctionCallOutput(out.output);
			if (business === null) continue;
			const adapter = adapterFor(shell.binding.id);
			/* v8 ignore next -- adapters always include all four sources; guarded for totality. */
			if (adapter === undefined) continue;
			results.push({
				adapter,
				toolName: shell.binding.canonicalToolName,
				payload: shell.binding.normalize(business),
				lineNumber: out.lineNumber,
				referencedAt: out.referencedAt,
			});
		}

		// FALLBACK: mcp_tool_call_end events for call_ids without a paired output.
		for (const ev of events) {
			if (ev.callId !== undefined && emitted.has(ev.callId)) continue;
			const binding = codexBindingFromInvocationTool(ev.tool);
			if (binding === null) continue;
			let business = tryParse(ev.text);
			if (business === null) continue;
			// Recovery (NOT the main path): reaching the fallback for a call_id that
			// ALSO has a function_call output means that output failed to parse (a
			// successful parse would have emitted + marked it in PRIMARY). Some fields
			// live ONLY on that malformed output (e.g. Jira's tenant webUrl), so let
			// the binding stitch them onto this valid event payload. Bindings without
			// this brittle edge leave `recover` unset.
			if (binding.recover !== undefined && ev.callId !== undefined) {
				const rawOutput = outputs.get(ev.callId)?.output;
				if (rawOutput !== undefined) {
					const stitched = binding.recover(business, rawOutput);
					if (stitched !== null) business = stitched;
				}
			}
			const adapter = adapterFor(binding.id);
			/* v8 ignore next -- adapters always include all four sources; guarded for totality. */
			if (adapter === undefined) continue;
			results.push({
				adapter,
				toolName: binding.canonicalToolName,
				payload: binding.normalize(business),
				lineNumber: ev.lineNumber,
				referencedAt: ev.referencedAt,
			});
		}

		// Emit in transcript line order so the shared dedupe's tie-break is stable.
		results.sort((a, b) => a.lineNumber - b.lineNumber);

		// Hold the cursor before any in-flight fetch request (a `function_call`
		// whose result row hasn't been written yet). Time-based polling can fire
		// between a request and its `function_call_output`; advancing to EOF here
		// would strand that output next poll (the output row has no namespace/name,
		// so it can't be sourced without re-reading its request — Jira's tenant
		// webUrl lives only on that paired output). A request is "satisfied" once a
		// result row (output OR event) for its call_id has appeared, tracked in
		// `resultSeen` — note this is recorded pre-cutoff and pre-parse, so a result
		// that was cutoff-dropped or failed to parse still counts. (Using
		// `outputs`/`events` here instead would deadlock: a cutoff-dropped result
		// never lands in `outputs`, so the cursor would be pulled back to the same
		// request every poll and never reach EOF.) Unsatisfied requests resume from
		// their line so the next poll re-correlates them (re-scan is idempotent via
		// dedupe + upsert-by-mapKey). Non-fetch calls never hold the cursor.
		//
		// Invariant this relies on: advancing the cursor past a cutoff-dropped
		// result is safe ONLY while `beforeTimestamp` is monotonic non-decreasing
		// across polls (true today — no caller passes a time-varying cutoff; both
		// production callers pass none at all). If a later poll RELAXED the cutoff,
		// the now-emittable output would already be behind the cursor and, having
		// no namespace/name of its own, could not be re-sourced. Revisit this if a
		// shrinking/moving cutoff is ever introduced.
		const satisfied = resultSeen;
		let safeCursor = lastConsumed;
		for (const [callId, call] of calls) {
			if (satisfied.has(callId)) continue;
			if (codexBindingFromFunctionCall(call.namespace, call.name) === null) continue;
			if (call.lineIndex < safeCursor) safeCursor = call.lineIndex;
		}
		// Same hold for an in-flight shell CLI request (already a CLI match by
		// construction): its function_call_output marks `resultSeen` when it lands,
		// so an unanswered one pins the cursor on its request line.
		for (const [callId, shell] of shellCalls) {
			if (satisfied.has(callId)) continue;
			if (shell.lineIndex < safeCursor) safeCursor = shell.lineIndex;
		}
		return { results, lastLineNumberScanned: safeCursor };
	}
}

/** True when `referencedAt` is a non-empty timestamp strictly after `cutoff`. */
function afterCutoff(referencedAt: string, cutoff: string | undefined): boolean {
	return cutoff !== undefined && referencedAt !== "" && referencedAt > cutoff;
}

export const codexEnvelopeParser: TranscriptEnvelopeParser = new CodexEnvelopeParser();

// ─── payload extraction ──────────────────────────────────────────────────────

/**
 * function_call_output → business object. Strips the human-readable
 * `Wall time: …\nOutput:\n` prefix when present, parses, and unwraps the
 * `[{type:"text",text:<JSON>}]` double-string form (Linear/Notion) to its inner
 * object. Returns null on any non-JSON / malformed output (e.g. exec errors).
 */
function parseFunctionCallOutput(output: string): unknown {
	let text = output;
	// MCP outputs are prefixed `Wall time: …\nOutput:\n`; shell outputs add a
	// leading `Exit code: …\n` before it. Strip from either marker.
	if (text.startsWith("Wall time:") || text.startsWith("Exit code:")) {
		const idx = text.indexOf(OUTPUT_MARKER);
		if (idx >= 0) text = text.slice(idx + OUTPUT_MARKER.length);
	}
	const parsed = tryParse(text);
	if (parsed === null) return null;
	return unwrapTextArray(parsed);
}

/** Parse the `command` field from a shell `function_call`'s JSON-string `arguments`. */
function readShellCommand(args: unknown): string | undefined {
	if (typeof args !== "string") return undefined;
	const parsed = tryParse(args);
	if (!isObject(parsed)) return undefined;
	return readString(parsed.command);
}

/**
 * Exit code from a shell `function_call_output`'s `Exit code: N\n…` prefix.
 * Returns undefined when absent (format drift) — the caller treats that as
 * "not 0" and skips, the conservative choice for a false-positive guard.
 */
function readExitCode(output: string): number | undefined {
	const m = /^Exit code:\s*(-?\d+)/.exec(output);
	return m ? Number(m[1]) : undefined;
}

/** Try JSON.parse; return null (not throw) on failure. */
function tryParse(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/**
 * If `value` is the `[{type:"text",text:"<JSON>"}]` form, parse the first text
 * block's JSON and return it; otherwise return `value` unchanged.
 */
function unwrapTextArray(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	const first = value[0];
	if (isObject(first) && first.type === "text" && typeof first.text === "string") {
		const inner = tryParse(first.text);
		return inner === null ? value : inner;
	}
	return value;
}

// ─── field readers ───────────────────────────────────────────────────────────

function readString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function readInvocationTool(invocation: unknown): string | undefined {
	if (!isObject(invocation)) return undefined;
	return readString(invocation.tool);
}

/** Extract `result.Ok.content[0].text` (the business JSON string) defensively. */
function readToolCallEndText(result: unknown): string | undefined {
	if (!isObject(result)) return undefined;
	const ok = result.Ok;
	if (!isObject(ok)) return undefined;
	const content = ok.content;
	if (!Array.isArray(content)) return undefined;
	const first = content[0];
	if (!isObject(first)) return undefined;
	return first.type === "text" ? readString(first.text) : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
