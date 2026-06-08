/**
 * CodexNotionBinding — Notion `codex_apps` connector binding.
 *
 * Single-entity `_fetch` only (shares the short name `_fetch` with Linear;
 * disambiguated by namespace suffix). The payload shape
 * (`{ metadata.type:"page", title, url, text }`) already matches the Notion
 * adapter, so no reshaping. Only fetch is whitelisted — search/update/write tools
 * never reach the adapter. When a Notion search/list shape is observed, add its
 * tool name + a collection key here, mirroring CodexGitHubBinding.
 */

import type { CodexBinding } from "./CodexBinding.js";

export const notionCodexBinding: CodexBinding = {
	id: "notion",
	namespaceSuffix: "notion",
	functionCallNames: new Set(["_fetch"]),
	invocationTools: new Set(["notion_fetch"]),
	canonicalToolName: "mcp__claude_ai_Notion__notion-fetch",
	normalize: (business) => business,
};
