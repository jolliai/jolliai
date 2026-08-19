/**
 * Directory-based session attribution: does a recorded working directory belong
 * to a given repository?
 *
 * Every hookless source needs this. Codex, Kimi, OpenCode, Copilot (CLI and
 * Chat), Cline, Devin and Antigravity read a machine-wide store at post-commit
 * time and must map each session's recorded working directory back to a repo.
 * Claude's DISK scan uses it too — its hook records against the resolved git
 * root directly, but the transcript sweep that back-fills history has only a
 * directory to go on.
 *
 * The question is about REPOSITORY MEMBERSHIP, and the repository is what the
 * dashboard counts: `repoIdentity` is one row per project, and a linked worktree
 * is deliberately folded into it (`registerRepo` anchors on the main worktree
 * root). So "which repo does this session belong to" has exactly one correct
 * answer per session, and every worktree of a project shares it.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readRepositoryKey } from "./GitFsLayout.js";
import { isPathInside, normalizePathForCompare } from "./PathUtils.js";

/**
 * Decides whether an agent session whose working directory is `sessionDir`
 * should be attributed to the repository whose main worktree is `repoRoot`.
 *
 * ## The rule: same repository, whichever worktree
 *
 * Asked of git via {@link readRepositoryKey}, which reads each side's shared git
 * directory off the filesystem (~0.1 ms, no subprocess). Every worktree of one
 * repository reports the same shared directory, so a session run in ANY of them
 * is attributed to that repository — and a session in a nested clone or a
 * submodule reports a different one and is excluded. Both answers fall out of one
 * comparison.
 *
 * That is the only rule consistent with what the dashboard stores. `repoIdentity`
 * is one row per project and `registerRepo` folds every linked worktree into it,
 * so a worktree is never a statistics unit of its own — there is no second row
 * for a session to belong to instead.
 *
 * ## Why the previous rule could not express it
 *
 * It was two path-shaped steps: containment (`isPathInside`), then a walk up from
 * `sessionDir` rejecting any intervening `.git`. Both steps mis-handle a worktree,
 * in opposite directions:
 *
 *   - A worktree added OUTSIDE the main one (`git worktree add ../feat-x`, the
 *     usual shape) fails containment outright.
 *   - A worktree added INSIDE it (`git worktree add .worktrees/foo`) passes
 *     containment and is then rejected by the `.git` walk — because a linked
 *     worktree's root carries a `.git` FILE, which that step reads as "a nested
 *     repository" when it in fact says "a worktree of THIS repository".
 *
 * The exclusion used to be documented as deliberate, on the grounds that such a
 * worktree "captures its sessions via its OWN post-commit — where its root is
 * `repoRoot`". That premise does not hold: `registerRepo` resolves every cwd
 * through `getProjectRootDir` (i.e. `dirname(--git-common-dir)`), so a linked
 * worktree's path is never recorded and never becomes a `repoRoot`. The sessions
 * were therefore attributed to nothing at all. Measured on one developer machine
 * with 18 worktrees: 24 of 107 sessions in a week reached no repository.
 *
 * ## The fallback, and what it is for
 *
 * `readRepositoryKey` answers null rather than guessing — for a `.git` git itself
 * would refuse, when the git location env vars redirect git away from `cwd`, and
 * for a directory that no longer exists. Those cases keep the two path-shaped
 * steps below, unchanged, so behaviour outside a readable repository is exactly
 * what it was: containment plus the nested-`.git` walk, and a recorded directory
 * that has since been deleted stays attributed to the repo it matches by path.
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
	// The session side first: it is the one that can be gone (a recorded directory
	// outlives the checkout), so failing here saves reading `repoRoot` at all. A
	// null on EITHER side means "unreadable", never "different" — fall through.
	const sessionRepo = readRepositoryKey(sessionDir);
	if (sessionRepo !== null) {
		const targetRepo = readRepositoryKey(repoRoot);
		if (targetRepo !== null) {
			return sessionRepo === targetRepo;
		}
	}
	// ── Fallback only, from here down: reached when at least one side's git layout
	// was unreadable. Kept verbatim so an unreadable repository behaves exactly as
	// it did before the key comparison above existed.
	if (!isPathInside(sessionDir, repoRoot)) {
		return false;
	}
	const repoNorm = normalizePathForCompare(repoRoot);
	// Exact match is unambiguous — skip the nested-repo walk.
	if (normalizePathForCompare(sessionDir) === repoNorm) {
		return true;
	}
	// Strict subdirectory: reject if an intervening `.git` marks a nested repo.
	// Cannot tell a nested clone from a linked worktree (both leave a `.git` at
	// that level) — which is why the key comparison above is the primary path.
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
