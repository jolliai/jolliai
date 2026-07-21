/**
 * Directory-based session attribution for hookless sources.
 *
 * Devin, OpenCode, and Copilot have no agent hook: at post-commit time the
 * discoverer reads a global session DB and must map each session's recorded
 * working directory back to the committing repo itself. Hook-backed sources
 * (Claude/Gemini) don't need this — their hook resolves the git root when the
 * session ends and records against it directly.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPathInside, normalizePathForCompare } from "./PathUtils.js";

/**
 * Decides whether an agent session whose working directory is `sessionDir`
 * should be attributed to the git worktree rooted at `repoRoot`.
 *
 * The match is prefix/containment (see {@link isPathInside}): a session run
 * from a subdirectory of the worktree — common in a monorepo, e.g.
 * `cd packages/foo && devin …` — still belongs to the repo. This replaced the
 * previous exact-equality match, which silently dropped every subdirectory
 * session (JOLLI-2015).
 *
 * Containment alone would double-capture a session that actually lives in a
 * NESTED git repo or submodule inside the worktree: it would be attributed to
 * BOTH the inner repo (its own post-commit) and this outer one. To prevent
 * that, a strict-subdirectory match is rejected when any directory between
 * `sessionDir` and `repoRoot` (including `sessionDir`, excluding `repoRoot`)
 * carries its own `.git` — a directory for a nested clone, a file for a
 * submodule/linked worktree. This deliberately also excludes a linked worktree
 * created inside the tree (e.g. `git worktree add .worktrees/foo`, whose root
 * carries a `.git` file): that worktree is its own working context on its own
 * branch, so its sessions are attributed by *its* post-commit — where its root
 * is `repoRoot` and the intervening-`.git` walk never fires — not swept up by a
 * sibling/parent worktree's commit, which would be cross-context bleed. The
 * check is filesystem `existsSync` only (no `git` subprocess) and runs solely
 * for the strict-subdirectory case; an exact `sessionDir === repoRoot` match
 * skips it. `repoRoot`'s own `.git` is never inspected, so a normal repo's
 * subdirectory sessions are always kept. If an
 * intermediate directory no longer exists, no `.git` is found and the session
 * is kept (best-effort: the recorded dir is gone, so attribute it to the repo
 * that matched by path).
 *
 * Both paths are absolute; comparison folds separators and (on Windows/macOS)
 * case via {@link normalizePathForCompare}.
 */
export function sessionDirBelongsToRepo(sessionDir: string, repoRoot: string): boolean {
	// SQLite-backed sources (Copilot CLI, OpenCode) expose a nullable working-dir
	// column: a session started outside any project stores it as NULL. Such a
	// session can't be attributed to a repo, and — critically — must not throw:
	// the discoverer maps this over every row in one flatMap, so a single null
	// row would otherwise poison the whole scan and drop every session (the
	// Copilot capture regression). Guard before the path helpers, which call
	// `.replace()` and would blow up on a falsy value.
	if (!sessionDir) {
		return false;
	}
	if (!isPathInside(sessionDir, repoRoot)) {
		return false;
	}
	const repoNorm = normalizePathForCompare(repoRoot);
	// Exact match is unambiguous — skip the nested-repo walk.
	if (normalizePathForCompare(sessionDir) === repoNorm) {
		return true;
	}
	// Strict subdirectory: reject if an intervening `.git` marks a nested repo.
	let current = sessionDir;
	while (normalizePathForCompare(current) !== repoNorm) {
		if (existsSync(join(current, ".git"))) {
			return false;
		}
		const parent = dirname(current);
		/* v8 ignore start -- defensive: isPathInside already guaranteed containment, so
		   walking up via dirname always meets repoRoot before the filesystem root. This
		   only trips on an exotic path shape; it prevents an infinite loop rather than
		   encoding reachable behavior. */
		if (parent === current) {
			break;
		}
		/* v8 ignore stop */
		current = parent;
	}
	return true;
}
