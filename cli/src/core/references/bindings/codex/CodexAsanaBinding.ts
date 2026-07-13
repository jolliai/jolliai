/**
 * CodexAsanaBinding — Asana `codex_apps` connector normalizer.
 *
 * Reached through `_get_task` (namespace `mcp__codex_apps__asana`), or the
 * `asana.get_task` invocation on the fallback path — match identity lives in
 * `asanaDefinition.match.codex`. The connector's `function_call_output` unwraps
 * to `{ data: { …task… } }`, byte-identical to the Claude Asana MCP payload the
 * asana `SourceDefinition` already reads (`wrapperKeys:["data"]`), so there is no
 * reshaping — `normalize` is identity, exactly like `CodexNotionBinding`. Only
 * `get_task` is recognized; enumeration/search/write tools never reach extraction.
 * When an Asana search/list shape is observed, add its tool name + a collection
 * key here, mirroring CodexGitHubBinding.
 */

import type { CodexNormalizer } from "./CodexBinding.js";

export const asanaCodexBinding: CodexNormalizer = {
	id: "asana",
	canonicalToolName: "mcp__claude_ai_Asana__get_task",
	normalize: (business) => business,
};
