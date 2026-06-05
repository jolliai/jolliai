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
 * Normalisation (§3.4) makes each payload digestible by the UNCHANGED adapters:
 *   - toolName → a canonical name the adapter's guard accepts (CodexToolMap).
 *   - GitHub   → unwrap `issue.*`, `issue_number`→`number`, `url`→`html_url`,
 *                flatten object-array `labels`/`assignees` to string arrays.
 *   - Linear/Notion/Jira → pass through (Linear ticket id is already in `id`;
 *     Jira `issues.nodes[]` carries `webUrl` and the adapter's wrapperKeys
 *     descend into it; Notion shape already matches).
 *
 * Robustness: the `Wall time:` prefix is stripped only when present; every parse
 * is wrapped and a non-JSON output (e.g. `execution error: Io(...)`) is skipped.
 */

import { createLogger } from "../../Logger.js";
import type { SourceId } from "../../Types.js";
import { canonicalToolName, sourceFromFunctionCall, sourceFromInvocationTool } from "./CodexToolMap.js";
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

class CodexEnvelopeParser implements TranscriptEnvelopeParser {
	parse(lines: string[], opts: ExtractOptions, adapters: readonly SourceAdapter[]): EnvelopeParseResult {
		const fromLine = opts.fromLineNumber ?? 0;
		const adapterFor = (id: SourceId): SourceAdapter | undefined => adapters.find((a) => a.id === id);

		const calls = new Map<string, FunctionCallRow>();
		const outputs = new Map<string, FunctionOutputRow>();
		const events: ToolCallEndRow[] = [];
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
				!line.includes("function_call_output")
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
					if (callId !== undefined && namespace !== undefined && name !== undefined) {
						calls.set(callId, { namespace, name, lineIndex: i });
					}
					break;
				}
				case "function_call_output": {
					const output = readString(payload.output);
					// Honour the parser-interface beforeTimestamp contract: drop results
					// whose timestamp is past the cutoff (same semantics as the Claude parser).
					if (afterCutoff(referencedAt, opts.beforeTimestamp)) break;
					if (callId !== undefined && output !== undefined) {
						outputs.set(callId, { output, lineNumber: i + 1, referencedAt });
					}
					break;
				}
				case "mcp_tool_call_end": {
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
			const source = sourceFromFunctionCall(call.namespace, call.name);
			if (source === null) continue;
			const business = parseFunctionCallOutput(out.output);
			if (business === null) continue;
			const adapter = adapterFor(source);
			/* v8 ignore next -- adapters always include all four sources; guarded for totality. */
			if (adapter === undefined) continue;
			results.push({
				adapter,
				toolName: canonicalToolName(source),
				payload: normalizeForSource(source, business),
				lineNumber: out.lineNumber,
				referencedAt: out.referencedAt,
			});
			emitted.add(callId);
		}

		// FALLBACK: mcp_tool_call_end events for call_ids without a paired output.
		for (const ev of events) {
			if (ev.callId !== undefined && emitted.has(ev.callId)) continue;
			const source = sourceFromInvocationTool(ev.tool);
			if (source === null) continue;
			const business = tryParse(ev.text);
			if (business === null) continue;
			const adapter = adapterFor(source);
			/* v8 ignore next -- adapters always include all four sources; guarded for totality. */
			if (adapter === undefined) continue;
			results.push({
				adapter,
				toolName: canonicalToolName(source),
				payload: normalizeForSource(source, business),
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
		// webUrl lives only on that paired output). A request is "satisfied" if its
		// call_id has an output OR an event in this window; otherwise we resume from
		// its line so the next poll re-correlates it (re-scan is idempotent via
		// dedupe + upsert-by-mapKey). Non-fetch calls never hold the cursor.
		const satisfied = new Set<string>(outputs.keys());
		for (const ev of events) {
			if (ev.callId !== undefined) satisfied.add(ev.callId);
		}
		let safeCursor = lastConsumed;
		for (const [callId, call] of calls) {
			if (satisfied.has(callId)) continue;
			if (sourceFromFunctionCall(call.namespace, call.name) === null) continue;
			if (call.lineIndex < safeCursor) safeCursor = call.lineIndex;
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
	if (text.startsWith("Wall time:")) {
		const idx = text.indexOf(OUTPUT_MARKER);
		if (idx >= 0) text = text.slice(idx + OUTPUT_MARKER.length);
	}
	const parsed = tryParse(text);
	if (parsed === null) return null;
	return unwrapTextArray(parsed);
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

// ─── per-source normalisation (§3.4) ─────────────────────────────────────────

function normalizeForSource(source: SourceId, business: unknown): unknown {
	if (source === "github") return reshapeGitHub(business);
	// linear / notion / jira pass through unchanged.
	return business;
}

/**
 * Reshape the Codex GitHub payload into the shape `GitHubAdapter.extractRef`
 * reads: unwrap `issue.*` to top level, rename `issue_number`→`number` and
 * `url`→`html_url`, and flatten the object-array `labels`/`assignees` into the
 * string arrays the adapter's `readStringList` expects. Non-object input is
 * returned as-is (the adapter will reject it).
 */
function reshapeGitHub(business: unknown): unknown {
	if (!isObject(business)) return business;
	const issue = isObject(business.issue) ? business.issue : business;
	const out: Record<string, unknown> = {};

	const num = issue.issue_number ?? issue.number;
	if (typeof num === "number") out.number = num;
	if (typeof issue.title === "string") out.title = issue.title;
	const url = issue.url ?? issue.html_url;
	if (typeof url === "string") out.html_url = url;
	if (typeof issue.body === "string") out.body = issue.body;
	if (typeof issue.state === "string") out.state = issue.state;

	const labels = flattenNamed(issue.labels, "name");
	if (labels !== undefined) out.labels = labels;
	const assignees = flattenNamed(issue.assignees, "login");
	if (assignees !== undefined) out.assignees = assignees;

	const fullName = issue.repository_full_name ?? business.repository_full_name;
	if (typeof fullName === "string") out.repository = { full_name: fullName };

	return out;
}

/**
 * Flatten an array of `{[key]: string}` objects (or bare strings) into a string
 * array. Returns undefined when the input is not a non-empty usable array.
 */
function flattenNamed(value: unknown, key: "name" | "login"): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.length > 0) {
			out.push(item);
		} else if (isObject(item)) {
			const v = item[key];
			if (typeof v === "string" && v.length > 0) out.push(v);
		}
	}
	return out.length > 0 ? out : undefined;
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
