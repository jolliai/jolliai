/**
 * Tool-name classification and per-slice tallying, shared by every transcript
 * source that can report tool calls.
 *
 * ## Why this is per-source and not one function
 *
 * The hosts do not agree on how a tool is named, and the disagreement is not
 * cosmetic — it decides whether a call lands in the `mcp` bucket or the
 * `builtin` one. A single `mcp__`-prefix test (the shape Claude uses) is not a
 * neutral default: applied to a host with a different convention it does not
 * fail, it silently files every MCP call as a builtin. Zero MCP calls looks
 * exactly like "this person uses no MCP servers", so the error is invisible in
 * every surface that reads the result.
 *
 * The conventions, each read off a real transcript or off the envelope parser
 * that was written against one:
 *
 *   - `mcp__<server>__<tool>` — Claude, and Kimi verbatim (see
 *     `KimiEnvelopeParser`, which reuses Claude's match path for exactly this
 *     reason). Also cursor-agent and the Cline CLI, both of which speak the
 *     Anthropic block format.
 *   - `<namespace>` + bare `<name>` — Codex, whose MCP identity lives in a
 *     sibling field (`payload.namespace`, or `invocation.server`) rather than
 *     inside the name. Its builtin names are bare and undecorated
 *     (`exec_command`, `wait`, `apply_patch` — real 2026-07/08 rollouts).
 *   - bare names only — Gemini (`run_shell_command`, `read_file`, `grep_search`
 *     — real `~/.gemini/tmp/<project>/chats/session-*.json`) and OpenCode
 *     (`data.tool`, see `OpenCodeSkillScanner`). Neither corpus contains a name
 *     shape that could be recognised as MCP, so nothing may guess at one.
 *
 * A host whose convention is not known yet must NOT be run through a
 * near-enough classifier: file its calls as builtin and leave the host out of
 * `TOOL_RECORDING_SOURCES` until a real capture says otherwise.
 */

import type { ToolCallCount } from "../Types.js";

/** The separator Claude-shaped hosts put between `mcp`, the server and the tool. */
const MCP_UNDERSCORE_PREFIX = "mcp__";
const MCP_UNDERSCORE_SEP = "__";

/** A host builtin — the tool ships with the agent, no server behind it. */
export function builtinTool(name: string): ToolCallCount {
	return { name, kind: "builtin", calls: 0 };
}

/**
 * A skill invocation, re-attributed to the skill it ran rather than to the
 * generic tool that ran it. "Which skills does this person use" is the question
 * being asked; counting every invocation as one builtin named `Skill` answers
 * nothing.
 */
export function skillTool(name: string): ToolCallCount {
	return { name, kind: "skill", calls: 0 };
}

/**
 * An MCP call. `server` is kept as its own field (the dashboard groups on it)
 * and also folded into the display name, so two servers exposing a `search`
 * tool stay distinguishable in a flat list.
 */
export function mcpTool(server: string, tool: string): ToolCallCount {
	return { name: tool ? `${server}.${tool}` : server, kind: "mcp", server, calls: 0 };
}

/**
 * Classifies a raw tool name written in the `mcp__<server>__<tool>` dialect
 * (Claude, Kimi, cursor-agent, Cline CLI).
 *
 * The double underscore is the separator the MCP host itself uses, and a server
 * or tool name may contain single underscores, so the split is on `__` and only
 * the FIRST two segments are structural; anything after them is part of the tool
 * name.
 */
export function classifyToolName(raw: string): ToolCallCount {
	if (!raw.startsWith(MCP_UNDERSCORE_PREFIX)) return builtinTool(raw);
	const rest = raw.slice(MCP_UNDERSCORE_PREFIX.length);
	const sep = rest.indexOf(MCP_UNDERSCORE_SEP);
	// `mcp__server` with no tool segment is malformed; keep it attributed to
	// the server rather than dropping the call.
	if (sep === -1) return mcpTool(rest, "");
	return mcpTool(rest.slice(0, sep), rest.slice(sep + MCP_UNDERSCORE_SEP.length));
}

/**
 * Classifies a Codex tool call, whose MCP identity lives OUTSIDE the name.
 *
 * Two shapes reach here, both documented against real rollouts in
 * `CodexEnvelopeParser`:
 *
 *   - a `function_call` carrying `namespace: "mcp__codex_apps__<src>"` — the
 *     connector gateway. The user-meaningful server is the trailing segment
 *     (`<src>`, e.g. `linear`), not the gateway name shared by every connector.
 *   - an `mcp_tool_call_end` event carrying `invocation.server` directly, in
 *     which case the caller passes that server verbatim.
 *
 * Everything else — `exec_command`, `wait`, `apply_patch`, `update_plan` — is a
 * bare builtin name.
 */
export function classifyCodexToolName(name: string, namespace?: string): ToolCallCount {
	if (namespace === undefined || namespace.length === 0) return builtinTool(name);
	if (!namespace.startsWith(MCP_UNDERSCORE_PREFIX)) return mcpTool(namespace, name);
	const segments = namespace.slice(MCP_UNDERSCORE_PREFIX.length).split(MCP_UNDERSCORE_SEP);
	const server = segments[segments.length - 1] || segments[0] || namespace;
	return mcpTool(server, name);
}

/**
 * Accumulates one slice's tool calls into the `ToolCallCount[]` the readers
 * return.
 *
 * Two things it exists to get right, both of which were bugs waiting to happen
 * in per-reader ad-hoc code:
 *
 *   - **Bucketing is on `kind:name`, not on name.** A builtin and an MCP tool
 *     can share a display name; merging them would fabricate a count.
 *   - **De-duplication is opt-in and keyed by the call's own id.** Several
 *     transcripts write one logical call across several lines (Claude repeats a
 *     whole `message.content` per block; Codex writes a request row and a result
 *     row). Keying on anything coarser than the call id — a message id, the tool
 *     name — collapses distinct calls made in the same response into one.
 */
export class ToolUseTally {
	private readonly byKey = new Map<string, ToolCallCount>();
	private readonly seen = new Set<string>();

	/** Count one call. */
	add(call: ToolCallCount, calls = 1): void {
		const key = `${call.kind}:${call.name}`;
		const prev = this.byKey.get(key);
		this.byKey.set(key, prev ? { ...prev, calls: prev.calls + calls } : { ...call, calls });
	}

	/**
	 * Count one call, ignoring it if `id` has already been counted. An
	 * `undefined` id means the transcript gave us no identity, so the call is
	 * counted unconditionally — dropping it would lose a real call, while
	 * counting a repeat only inflates one bucket.
	 */
	addOnce(id: string | undefined, call: ToolCallCount): void {
		if (id !== undefined) {
			if (this.seen.has(id)) return;
			this.seen.add(id);
		}
		this.add(call);
	}

	/** Has `id` already been counted? Lets a caller skip building a call object. */
	hasSeen(id: string): boolean {
		return this.seen.has(id);
	}

	/**
	 * The slice's buckets. An EMPTY array is meaningful — it says the slice
	 * genuinely called no tools — and must be returned rather than dropped, or
	 * the source becomes indistinguishable from one that cannot report tools at
	 * all (see `TOOL_RECORDING_SOURCES`).
	 */
	values(): ToolCallCount[] {
		return [...this.byKey.values()];
	}
}
