/**
 * CodexLinearBinding — Linear `codex_apps` connector binding.
 *
 * Single-entity `_fetch` only (no search shape observed yet). The payload needs
 * no reshaping: the ticket id is already in `id` (e.g. `JOLLI-1657`) and the URL
 * is `linear.app/…`, both read directly by the Linear adapter. When a Linear
 * search/list shape is observed, add its tool name + a collection key + (if
 * needed) a URL backfill here, mirroring CodexGitHubBinding.
 */

import type { CodexBinding } from "./CodexBinding.js";

export const linearCodexBinding: CodexBinding = {
	id: "linear",
	namespaceSuffix: "linear",
	functionCallNames: new Set(["_fetch"]),
	invocationTools: new Set(["linear_fetch"]),
	canonicalToolName: "mcp__linear__get_issue",
	normalize: (business) => business,
};
