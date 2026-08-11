/**
 * The plugin-bundle cwd guard, kept as a LEAF module.
 *
 * Split out of [`McpServer.ts`](McpServer.ts) purely for import
 * cost: the proxy has to answer "should this directory be served at all?" before
 * it does anything, and reaching into `McpServer` for the answer would pull the
 * storage stack, the search index and the push client into a process whose whole
 * job is to forward bytes. `McpServer` re-exports it, so it remains one rule
 * with one definition.
 */

import { normalizePathForCompare } from "../core/PathUtils.js";

/**
 * Home-relative roots where AI hosts unpack installed plugin bundles. A server whose
 * cwd sits under one of these was launched from a bundle, not from a repository.
 *
 * Path-matching only, with NO "and it isn't a git repo" refinement on purpose: a
 * marketplace served over git leaves its cache as a real checkout, so the git test
 * would pass there and let exactly the case this guards against through. The
 * inverse mistake — a user keeping a working repository under `~/.codex/plugins/` —
 * is far less likely, and its cost is a refusal that names the directory and says
 * what to do, not a silent wrong answer.
 */
const PLUGIN_BUNDLE_PATH_MARKERS = ["/.codex/plugins/", "/.claude/plugins/"] as const;

/**
 * Whether `cwd` is inside an AI host's plugin-bundle cache rather than a repository.
 * Exported for tests; see the call in `startMcpServer` for why it matters.
 */
export function isPluginBundleCwd(cwd: string): boolean {
	const normalized = normalizePathForCompare(cwd);
	return PLUGIN_BUNDLE_PATH_MARKERS.some((marker) => normalized.includes(marker));
}
