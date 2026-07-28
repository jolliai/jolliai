/**
 * jollimemory is an arguments-derived source: what is worth recording is that a
 * memory lookup HAPPENED and what was asked, both of which live in the tool
 * ARGUMENTS. The result — the recalled memories themselves — is deliberately
 * discarded, which is the point of a track-only self-reference: Jolli records that
 * it consulted its own memory without copying that memory back into itself.
 *
 * This reshaper turns the tool name + input into the flat object
 * `jolliMemoryDefinition` reads via `path` ops.
 *
 * Dispatch is on the TOOL NAME, never on the argument shape. A bare `recall()` and
 * a `list_branches()` both arrive as `{}`, so duck-typing cannot tell a captured
 * tool from an ignored one — which is why the Claude and Codex parsers thread the
 * name into the normalizer env.
 */
import { isObject } from "../guards.js";

/** The Claude MCP namespace for Jolli's own stdio server. */
/**
 * Claude's namespace prefix for these tools. Exported because the Codex binding
 * maps its BARE tool name back onto this spelling, so `sourceToolName` persists
 * identically whichever agent captured the lookup.
 */
export const CLAUDE_TOOL_PREFIX = "mcp__jollimemory__";

/**
 * Display titles, one per captured tool, carried in the normalizer output so the
 * definition reads `title` with a plain `path` op rather than a regex ladder over
 * the tool name. The key set doubles as the capture allow-list.
 */
const TOOL_TITLES = {
	recall: "Recall",
	search: "Search",
	get_decision_timeline: "Decision timeline",
} as const;

export type JolliMemoryTool = keyof typeof TOOL_TITLES;

/**
 * Recorded for a `recall()` with no `branch` argument. A literal, not the resolved
 * branch name: extraction runs at Stop-hook / post-commit time, so the branch then
 * is not necessarily the branch when the call was made, and a resolved-but-wrong
 * name is worse than an honest placeholder. Keeping it literal also keeps this
 * function pure — no repo state, no env — which matters because the Codex path
 * supplies a differently-shaped env.
 */
export const CURRENT_BRANCH_QUERY = "(current branch)";

export interface JolliMemoryLookup {
	/** Bare tool name; becomes `nativeId`, so one reference accumulates per tool. */
	readonly tool: JolliMemoryTool;
	readonly title: string;
	/** What was asked. Never the answer. */
	readonly query: string;
}

function readString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** One string argument, or undefined when the input is not an object / the key is absent or empty. */
function readArg(toolInput: unknown, key: string): string | undefined {
	return isObject(toolInput) ? readString(toolInput[key]) : undefined;
}

function lookup(tool: JolliMemoryTool, query: string): JolliMemoryLookup {
	return { tool, title: TOOL_TITLES[tool], query };
}

/**
 * Void when the tool's required argument could not be read. Shared by the two
 * argument-requiring tools so their identical guard is one branch, not two.
 */
function requireQuery(tool: JolliMemoryTool, query: string | undefined): JolliMemoryLookup | null {
	return query === undefined ? null : lookup(tool, query);
}

/**
 * Build the jollimemory reference shape from a memory tool call. Returns null —
 * voiding the reference — for every jollimemory tool outside the captured three.
 *
 * `toolName` may arrive prefixed (Claude: `mcp__jollimemory__search`) or bare; the
 * known Claude prefix is stripped and anything else is matched verbatim.
 */
export function normalizeJolliMemory(toolInput: unknown, toolName: string): JolliMemoryLookup | null {
	const tool = toolName.startsWith(CLAUDE_TOOL_PREFIX) ? toolName.slice(CLAUDE_TOOL_PREFIX.length) : toolName;
	switch (tool) {
		case "recall":
			// `recall()` legitimately takes NO arguments, so an unreadable input is its
			// normal shape rather than a failure — the tool name alone establishes that a
			// recall happened, which is the fact this source exists to record. Defaulting
			// beats voiding here: dropping the reference would lose the act itself.
			return lookup("recall", readArg(toolInput, "branch") ?? CURRENT_BRANCH_QUERY);
		case "search":
			// `query` and `slug` are required by their tool schemas; with neither readable
			// there is no act to describe, so the reference is voided.
			return requireQuery("search", readArg(toolInput, "query"));
		case "get_decision_timeline":
			return requireQuery("get_decision_timeline", readArg(toolInput, "slug"));
		default:
			// Every other tool on this server is deliberately out of scope: `list_branches`
			// (an enumeration with no query to record), the Space and workflow tools, and
			// `status`. The registry's `exact` allow-list already rejects them before this
			// point; this arm is the second, independent gate.
			return null;
	}
}
