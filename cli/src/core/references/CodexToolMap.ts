/**
 * CodexToolMap — explicit lookup tables mapping Codex `codex_apps` connector
 * tool identities to a logical `SourceId` + the canonical tool name the
 * (unchanged) adapter guards accept.
 *
 * Why hardcoded tables (not mechanical parsing) — all verified against real
 * 2026-06-05 rollouts:
 *   - namespace suffix ≠ source name: `atlassian_rovo` → jira.
 *   - tool names follow three different patterns: `_fetch` (linear/notion),
 *     `_fetch_issue` (github), `_getjiraissue` (jira, `get` not `fetch`).
 *   - `invocation.tool` can contain a SPACE: `atlassian rovo_getjiraissue`.
 *
 * Scope: ONLY "main fetch / get single entity" tools are whitelisted. The same
 * connectors expose list/create/search/comments tools (`linear_list_teams`,
 * `github_list_installations`, `atlassian rovo_search` / `_createjiraissue`,
 * `_fetch_issue_comments`, …) — those are intentionally excluded so they never
 * reach `extractRef`. Comment association is a later increment.
 */

import type { SourceId } from "../../Types.js";

/** `mcp__codex_apps__` — the shared connector namespace prefix for all sources. */
export const CODEX_APPS_NAMESPACE_PREFIX = "mcp__codex_apps__";

/**
 * `mcp_tool_call_end` path: `invocation.tool` → source. Exact-match only — note
 * `atlassian rovo_getjiraissue` carries an embedded space.
 */
const INVOCATION_TOOL_TO_SOURCE: ReadonlyMap<string, SourceId> = new Map([
	["linear_fetch", "linear"],
	["notion_fetch", "notion"],
	["github_fetch_issue", "github"],
	["atlassian rovo_getjiraissue", "jira"],
]);

/** `function_call` path: namespace suffix (after the shared prefix) → source. */
const NAMESPACE_SUFFIX_TO_SOURCE: ReadonlyMap<string, SourceId> = new Map([
	["linear", "linear"],
	["notion", "notion"],
	["github", "github"],
	["atlassian_rovo", "jira"],
]);

/**
 * `function_call` path: the EXACT main-fetch `name` each source emits — a paired
 * (source → allowed names) map, NOT a flat any-namespace × any-name allowlist.
 * Verified against 2026-06-05 rollouts: every source's main fetch maps 1:1
 * (linear/notion → `_fetch`, github → `_fetch_issue`, jira → `_getjiraissue`).
 * Pairing it this way rejects mismatches like `github` + `_fetch` or
 * `atlassian_rovo` + `_fetch_issue` that a flat name-set would wave through.
 * `_fetch` is shared by linear+notion (disambiguated by namespace suffix).
 * Exact-match excludes `_fetch_issue_comments`, `_list_*`, `_create*`, etc.
 */
const SOURCE_MAIN_FETCH_NAMES: ReadonlyMap<SourceId, ReadonlySet<string>> = new Map([
	["linear", new Set(["_fetch"])],
	["notion", new Set(["_fetch"])],
	["github", new Set(["_fetch_issue"])],
	["jira", new Set(["_getjiraissue"])],
]);

/**
 * Canonical tool name per source — chosen so each adapter's existing guard
 * accepts it unchanged: GitHub `includes("mcp__github__")`, Jira
 * `includes("mcp__claude_ai_Atlassian__")`, Notion `endsWith("notion-fetch")`.
 * Linear has no guard; a canonical name is supplied for consistency.
 */
const CANONICAL_TOOL_NAME: Readonly<Record<SourceId, string>> = {
	linear: "mcp__linear__get_issue",
	jira: "mcp__claude_ai_Atlassian__getJiraIssue",
	github: "mcp__github__issue_read",
	notion: "mcp__claude_ai_Notion__notion-fetch",
};

/**
 * Resolve the source for a `mcp_tool_call_end` event's `invocation.tool`.
 * Returns null for non-whitelisted (list/create/search/comments) tools.
 */
export function sourceFromInvocationTool(tool: string): SourceId | null {
	return INVOCATION_TOOL_TO_SOURCE.get(tool) ?? null;
}

/**
 * Resolve the source for a `function_call` (its `namespace` + short `name`).
 * Returns null unless namespace is a known `codex_apps` source AND `name` is the
 * main-fetch tool THAT source actually emits — mismatched pairs (e.g. github +
 * `_fetch`) are rejected.
 */
export function sourceFromFunctionCall(namespace: string, name: string): SourceId | null {
	if (!namespace.startsWith(CODEX_APPS_NAMESPACE_PREFIX)) return null;
	const suffix = namespace.slice(CODEX_APPS_NAMESPACE_PREFIX.length);
	const source = NAMESPACE_SUFFIX_TO_SOURCE.get(suffix);
	if (source === undefined) return null;
	return SOURCE_MAIN_FETCH_NAMES.get(source)?.has(name) ? source : null;
}

/** The canonical tool name for a source (satisfies the adapter's guard). */
export function canonicalToolName(source: SourceId): string {
	return CANONICAL_TOOL_NAME[source];
}
