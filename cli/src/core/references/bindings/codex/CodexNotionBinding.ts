/**
 * CodexNotionBinding — Notion `codex_apps` connector normalizer.
 *
 * Reached through `_fetch` (shares the short name `_fetch` with Linear;
 * disambiguated by namespace suffix in the registry). The payload shape
 * (`{ metadata.type:"page", title, url, text }`) already matches the notion
 * `SourceDefinition`, so no reshaping. Only fetch is recognized — search/update/
 * write tools never reach extraction. When a Notion search/list shape is
 * observed, add its tool name + a collection key here, mirroring
 * CodexGitHubBinding.
 */

import type { CodexNormalizer } from "./CodexBinding.js";

export const notionCodexBinding: CodexNormalizer = {
	id: "notion",
	canonicalToolName: "mcp__claude_ai_Notion__notion-fetch",
	normalize: (business) => business,
};
