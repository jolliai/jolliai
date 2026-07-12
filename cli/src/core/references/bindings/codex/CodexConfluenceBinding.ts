/**
 * CodexConfluenceBinding — Confluence `codex_apps` connector normalizer (reached
 * through the "Atlassian Rovo" app's `_getconfluencepage` tool; match identity
 * lives in `confluence`'s `SourceDefinition.match.codex`).
 *
 * Verified from a live rollout (2026-07-12): Rovo's `_getconfluencepage` output
 * is byte-identical in shape to Claude's `getConfluencePage` — the same
 * `{ content: { nodes: [ node ] } }` wrapper with `id` / `title` / `webUrl` /
 * `space` / `author` / `body`. So `normalize` is just `normalizeConfluence`, the
 * exact function the Claude path already runs (see `ClaudeEnvelopeParser`'s
 * context-normalizer registry); no Rovo-specific reshaping is needed.
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
