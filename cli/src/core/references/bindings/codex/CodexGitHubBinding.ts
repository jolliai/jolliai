/**
 * CodexGitHubBinding — GitHub `codex_apps` connector binding.
 *
 * Resolves an issue through EITHER `_fetch_issue` (single issue) OR
 * `_search_issues` (`{ issues: [ … ] }`, the connector's URL-resolution path).
 * Payload reshaping (unwrap, rename, flatten, derive number from URL) is the
 * GitHub-domain normalizer `reshapeGitHubIssue`, shared with future GitHub
 * producers (e.g. the `gh` CLI).
 */

import { reshapeGitHubIssue } from "../../sources/GitHubNormalize.js";
import { normalizeEntities } from "../shared.js";
import type { CodexBinding } from "./CodexBinding.js";

export const githubCodexBinding: CodexBinding = {
	id: "github",
	namespaceSuffix: "github",
	functionCallNames: new Set(["_fetch_issue", "_search_issues"]),
	invocationTools: new Set(["github_fetch_issue", "github_search_issues"]),
	// Synthetic tool name persisted as `sourceToolName`; kept stable for byte-equ
	// identical output. (The purified GitHubAdapter no longer inspects tool names.)
	canonicalToolName: "mcp__github__issue_read",
	normalize: (business) => normalizeEntities(business, ["issues"], reshapeGitHubIssue),
};
