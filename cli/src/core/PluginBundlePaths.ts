/**
 * Which filesystem paths are an AI host's plugin-bundle cache rather than a
 * repository.
 *
 * A product rule, not presentation: it answers "does this directory identify a
 * repository we may serve / install into", and two independent surfaces need the same
 * answer — the MCP server (refusing to serve the wrong repo) and the Cursor plugin
 * bootstrap (refusing to install git hooks into the bundle it was launched from).
 * Both failures are silent-but-wrong rather than loud, which is why the predicate is
 * shared instead of restated.
 */

import { normalizePathForCompare } from "./PathUtils.js";

/**
 * Home-relative roots where AI hosts unpack installed plugin bundles. A process whose
 * cwd sits under one of these was launched from a bundle, not from a repository.
 *
 * Path-matching only, with NO "and it isn't a git repo" refinement on purpose: a
 * marketplace served over git leaves its cache as a real checkout, so the git test
 * would pass there and let exactly the case this guards against through. The
 * inverse mistake — a user keeping a working repository under `~/.codex/plugins/` —
 * is far less likely, and its cost is a refusal that names the directory and says
 * what to do, not a silent wrong answer.
 *
 * `/.cursor/plugins/` covers both of Cursor's layouts: the marketplace cache and the
 * `local/<name>` directory a developer points at by hand. It is the likeliest of the
 * three to be hit, because Cursor measurably runs a plugin's `sessionStart` hook with
 * the PLUGIN ROOT as its cwd (verified on Cursor 3.15.6) — so any code that falls back
 * to `process.cwd()` there lands here rather than in the user's workspace.
 */
const PLUGIN_BUNDLE_PATH_MARKERS = ["/.codex/plugins/", "/.claude/plugins/", "/.cursor/plugins/"] as const;

/** Whether `cwd` is inside an AI host's plugin-bundle cache rather than a repository. */
export function isPluginBundleCwd(cwd: string): boolean {
	const normalized = normalizePathForCompare(cwd);
	return PLUGIN_BUNDLE_PATH_MARKERS.some((marker) => normalized.includes(marker));
}
