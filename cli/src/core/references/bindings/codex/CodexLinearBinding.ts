/**
 * CodexLinearBinding — Linear `codex_apps` connector normalizer.
 *
 * Reached through the single-entity read tools that return an issue-shaped
 * payload: `_fetch` / `linear_fetch` (the original standalone-MCP names) and
 * `_get_issue` / `linear.get_issue` (the OpenAI-curated Codex Linear connector) —
 * match identity for these lives in the registry. Verified live for `_get_issue` /
 * `linear.get_issue` (payload is a normal Linear issue object: the ticket id is in
 * `id` (e.g. `ABC-123`) and the URL is `linear.app/…`, read directly by the linear
 * `SourceDefinition`; no reshaping → identity normalize).
 *
 * Enumeration tools (`_list_issues` / `_search` and their dotted `linear.*`
 * forms) are intentionally NOT recognized: a list/search result carries many
 * issues the user is not working on, and capturing each one floods Working
 * Memory → Context (JOLLI-1921). Write tools (e.g. `_create_attachment`,
 * `_delete_comment`) are likewise not recognized — they don't return an issue.
 */

import type { CodexNormalizer } from "./CodexBinding.js";

export const linearCodexBinding: CodexNormalizer = {
	id: "linear",
	canonicalToolName: "mcp__linear__get_issue",
	normalize: (business) => business,
};
