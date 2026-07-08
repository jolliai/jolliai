/**
 * CodexLinearBinding — Linear `codex_apps` connector normalizer.
 *
 * Reached through the read tools that return issue-shaped payloads: `_fetch` /
 * `linear_fetch` (the original standalone-MCP names) and `_get_issue` /
 * `_list_issues` / `_search` (and their dotted `linear.*` invocation forms,
 * emitted by the OpenAI-curated Codex Linear connector) — match identity for all
 * of these lives in the registry. Verified live for `_get_issue` /
 * `linear.get_issue` (payload is a normal Linear issue object: the ticket id is
 * in `id` (e.g. `ABC-123`) and the URL is `linear.app/…`, read directly by the
 * linear `SourceDefinition`; no reshaping → identity normalize). List/search are
 * added on the same recognition but their payload shape is NOT yet verified
 * live; the expectation is that entries wrap under a key in the definition's
 * wrapper keys (`issues` / `results`) so the driver unwraps them and `extractRef`
 * validates each — if that guess is wrong they simply yield nothing (never
 * crash). Write tools (e.g. `_create_attachment`, `_delete_comment`) are
 * intentionally not recognized: they don't return an issue, so they'd be dropped
 * anyway.
 */

import type { CodexNormalizer } from "./CodexBinding.js";

export const linearCodexBinding: CodexNormalizer = {
	id: "linear",
	canonicalToolName: "mcp__linear__get_issue",
	normalize: (business) => business,
};
