/**
 * Codex producer binding registry — resolves a `codex_apps` tool identity to its
 * {@link CodexBinding}. Two lookup paths mirror the two rollout shapes the parser
 * correlates:
 *   - `function_call`     → (namespace suffix + short `name`) via {@link codexBindingFromFunctionCall}
 *   - `mcp_tool_call_end` → (`invocation.tool`) via {@link codexBindingFromInvocationTool}
 *
 * Resolution is namespace-first then name-checked, so `_fetch` (shared by Linear
 * and Notion) is disambiguated by namespace, and a name that the source does not
 * expose (e.g. `github` + `_fetch`, which GitHub never emits) is rejected rather
 * than misrouted. Adding a source = one entry here plus its binding file.
 */

import type { CodexBinding } from "./CodexBinding.js";
import { githubCodexBinding } from "./CodexGitHubBinding.js";
import { jiraCodexBinding } from "./CodexJiraBinding.js";
import { linearCodexBinding } from "./CodexLinearBinding.js";
import { notionCodexBinding } from "./CodexNotionBinding.js";

/** `mcp__codex_apps__` — the shared connector namespace prefix for all sources. */
export const CODEX_APPS_NAMESPACE_PREFIX = "mcp__codex_apps__";

const CODEX_BINDINGS: readonly CodexBinding[] = [
	linearCodexBinding,
	notionCodexBinding,
	githubCodexBinding,
	jiraCodexBinding,
];

const BY_NAMESPACE_SUFFIX: ReadonlyMap<string, CodexBinding> = new Map(
	CODEX_BINDINGS.map((b) => [b.namespaceSuffix, b]),
);

const BY_INVOCATION_TOOL: ReadonlyMap<string, CodexBinding> = new Map(
	CODEX_BINDINGS.flatMap((b) => [...b.invocationTools].map((tool) => [tool, b] as const)),
);

/**
 * Resolve a `function_call`'s (`namespace`, short `name`) to its binding. Returns
 * null unless the namespace is a known `codex_apps` source AND the source
 * actually exposes that tool name.
 */
export function codexBindingFromFunctionCall(namespace: string, name: string): CodexBinding | null {
	if (!namespace.startsWith(CODEX_APPS_NAMESPACE_PREFIX)) return null;
	const suffix = namespace.slice(CODEX_APPS_NAMESPACE_PREFIX.length);
	const binding = BY_NAMESPACE_SUFFIX.get(suffix);
	if (binding === undefined) return null;
	return binding.functionCallNames.has(name) ? binding : null;
}

/** Resolve a `mcp_tool_call_end` event's `invocation.tool` to its binding, or null. */
export function codexBindingFromInvocationTool(tool: string): CodexBinding | null {
	return BY_INVOCATION_TOOL.get(tool) ?? null;
}

export type { CodexBinding } from "./CodexBinding.js";
