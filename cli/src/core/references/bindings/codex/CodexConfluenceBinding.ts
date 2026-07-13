/**
 * CodexConfluenceBinding — Confluence `codex_apps` connector normalizer (reached
 * through the "Atlassian Rovo" app's `_getconfluencepage` tool; match identity
 * lives in `confluence`'s `SourceDefinition.match.codex`).
 *
 * Verified from live rollouts (2026-07): Rovo's `_getconfluencepage` result is
 * the full MCP CallToolResult, and the Codex envelope layer extracts its
 * `content[0].text` — which is a FLAT page node (`id` / `title` / `webUrl` /
 * `body` / `spaceId` / `authorId`), NOT Claude's `{ content: { nodes: [ node ] } }`
 * wrapper. That wrapped twin exists only in the sibling `structuredContent`, which
 * the envelope discards. `normalizeConfluence` now accepts BOTH shapes, so this
 * binding still reuses it verbatim — but the two paths are NOT byte-identical, and
 * the flat node has no `space` / `author` objects (only IDs), so those fields come
 * back undefined here.
 */

import { normalizeConfluence } from "../../sources/ConfluenceNormalize.js";
import type { CodexNormalizer } from "./CodexBinding.js";

export const confluenceCodexBinding: CodexNormalizer = {
	id: "confluence",
	canonicalToolName: "mcp__claude_ai_Atlassian__getConfluencePage",
	// normalizeConfluence returns null on structurally unparseable input; the
	// definition's `require` regexes void the reference either way.
	normalize: (business) => normalizeConfluence(business),
};
