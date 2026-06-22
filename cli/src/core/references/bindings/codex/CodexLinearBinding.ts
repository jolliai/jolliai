/**
 * CodexLinearBinding — Linear `codex_apps` connector binding.
 *
 * Recognizes the read tools that return issue-shaped payloads. `_fetch` /
 * `linear_fetch` are the original standalone-MCP names; `_get_issue` /
 * `_list_issues` / `_search` (and their dotted `linear.*` invocation forms) are
 * what the OpenAI-curated Codex Linear connector emits — verified live for
 * `_get_issue` / `linear.get_issue` (payload is a normal Linear issue object: the
 * ticket id is in `id` (e.g. `ABC-123`) and the URL is `linear.app/…`, read
 * directly by the Linear adapter; no reshaping → identity normalize). List/search
 * are added on the same recognition but their payload shape is NOT yet verified
 * live; the expectation is that entries wrap under a key in
 * `LinearAdapter.wrapperKeys` (`issues` / `results`) so the driver unwraps them and
 * `extractRef` validates each — if that guess is wrong they simply yield nothing
 * (never crash). Write tools (e.g. `_create_attachment`, `_delete_comment`) are
 * intentionally absent: they don't return an issue, so they'd be dropped anyway.
 */

import type { CodexBinding } from "./CodexBinding.js";

export const linearCodexBinding: CodexBinding = {
	id: "linear",
	namespaceSuffix: "linear",
	functionCallNames: new Set(["_fetch", "_get_issue", "_list_issues", "_search"]),
	invocationTools: new Set(["linear_fetch", "linear.get_issue", "linear.list_issues", "linear.search"]),
	canonicalToolName: "mcp__linear__get_issue",
	normalize: (business) => business,
};
