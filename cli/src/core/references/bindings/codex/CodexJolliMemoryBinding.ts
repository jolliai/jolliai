import { CLAUDE_TOOL_PREFIX, normalizeJolliMemory } from "../../sources/JolliMemoryNormalize.js";
import type { CodexNormalizer } from "./CodexBinding.js";

/**
 * Jolli's own memory tools, as seen from Codex.
 *
 * Jolli registers as a LOCAL MCP server (`~/.codex/config.toml`), which Codex
 * models differently from both Claude and its own `codex_apps` connectors —
 * captured verbatim from a live rollout (2026-07-28), see the plan's Step 5
 * Task 1 for the full record:
 *
 *   - the namespace (`mcp__jollimemory`) appears ONLY in `tool_search_output`,
 *     never in the call envelope;
 *   - `function_call.name` is the BARE tool (`recall`), with no namespace prefix,
 *     and therefore matches none of the parser's four line needles — the request
 *     line is dropped before it is ever parsed;
 *   - so only the `mcp_tool_call_end` FALLBACK sees these calls, and its
 *     `invocation` conveniently carries server + tool + already-parsed arguments
 *     together. Nothing is lost: the source is `argumentsDerived`.
 *
 * Two shapes make the result unusable anyway, both avoided by never reading it:
 * `result` is wrapped in a Rust-flavoured `Ok`, and `function_call_output.output`
 * prefixes the JSON with a `Wall time: …` preamble.
 */
export const jolliMemoryCodexBinding: CodexNormalizer = {
	id: "jollimemory",
	// This source owns THREE tools, so the persisted name has to be per-call. The
	// bare Codex tool is mapped back onto its Claude spelling, which keeps
	// `sourceToolName` identical no matter which agent captured the lookup — the
	// same contract every single-tool binding here satisfies with a literal.
	canonicalToolName: (rawToolName) => `${CLAUDE_TOOL_PREFIX}${rawToolName}`,
	// `normalizeJolliMemory` already accepts a bare or Claude-prefixed tool name, so
	// the FALLBACK's `invocation.tool` needs no adaptation. The business payload is
	// ignored entirely; `env.toolName` is what distinguishes the three tools, since
	// a bare `recall` and a bare `list_branches` both arrive with empty arguments.
	normalize: (_business, toolInput, env) => normalizeJolliMemory(toolInput, env?.toolName ?? ""),
};
