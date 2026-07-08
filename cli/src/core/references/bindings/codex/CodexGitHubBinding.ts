/**
 * CodexGitHubBinding — GitHub `codex_apps` connector normalizer.
 *
 * Reached through EITHER `_fetch_issue` (single issue) OR `_search_issues`
 * (`{ issues: [ … ] }`, the connector's URL-resolution path) — match identity for
 * both lives in the registry. Payload reshaping (unwrap, rename, flatten, derive
 * number from URL) is the GitHub-domain normalizer `reshapeGitHubIssue`, shared
 * with future GitHub producers (e.g. the `gh` CLI).
 */

import { reshapeGitHubIssue } from "../../sources/GitHubNormalize.js";
import { normalizeEntities } from "../shared.js";
import type { CodexNormalizer } from "./CodexBinding.js";

export const githubCodexBinding: CodexNormalizer = {
	id: "github",
	// Synthetic tool name persisted as `sourceToolName`; kept stable for byte-equ
	// identical output. (The purified engine no longer inspects tool names.)
	canonicalToolName: "mcp__github__issue_read",
	normalize: (business) => normalizeEntities(business, ["issues"], reshapeGitHubIssue),
};
