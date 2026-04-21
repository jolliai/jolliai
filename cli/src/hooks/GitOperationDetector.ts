/**
 * GitOperationDetector — Centralized Git Operation Type Detection
 *
 * Detects what type of git operation triggered the current post-commit hook.
 * This is a critical decision point: the detected type determines whether
 * the operation is handled by post-commit (enqueue + spawn) or deferred to
 * post-rewrite (amend/rebase).
 *
 * Detection methods by operation type:
 *
 * | Operation    | Method                         | Why                                    |
 * |-------------|--------------------------------|----------------------------------------|
 * | rebase      | GIT_REFLOG_ACTION env + filesystem | Git sets env reliably during rebase   |
 * | squash      | squash-pending.json file       | Our own file, 100% certainty           |
 * | amend       | reflog startsWith()            | GIT_REFLOG_ACTION is empty for amend   |
 * | cherry-pick | GIT_REFLOG_ACTION env          | Git sets env reliably for cherry-pick  |
 * | revert      | GIT_REFLOG_ACTION env          | Git sets env reliably for revert       |
 * | commit      | Default fallback               | If nothing else matches                |
 *
 * IMPORTANT — reflog matching rules:
 *   Always use `startsWith()` to match the reflog action prefix, NEVER `includes()`.
 *   The reflog subject (`git reflog -1 --format=%gs`) includes the commit message
 *   after the action prefix. Using `includes("amend")` would match any commit whose
 *   message contains "amend" (e.g., "fix amend-pending bug"). This caused a real
 *   production bug where squash operations were misdetected as amends.
 *
 * Reflog subject formats:
 *   "commit: <message>"            — normal commit
 *   "commit (amend): <message>"    — amend
 *   "commit (initial): <message>"  — first commit in repo
 *   "reset: moving to <ref>"       — reset
 *   "rebase (pick): <message>"     — rebase pick
 *   "cherry-pick: <message>"       — cherry-pick
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getCommitRange, getHeadHash, getLastReflogAction, isAncestor, readOrigHead } from "../core/GitOps.js";
import { loadSquashPending, saveSquashPending } from "../core/SessionTracker.js";
import { createLogger } from "../Logger.js";

const log = createLogger("GitOperationDetector");

// ─── Git directory resolution ────────────────────────────────────────────────

/**
 * Resolves the actual git directory for a repository.
 * In a regular repo, .git is a directory and is returned directly.
 * In a git worktree, .git is a file containing "gitdir: <path>", which
 * points to the real gitdir (e.g. .git/worktrees/<name>/). We parse that
 * file so rebase-merge / rebase-apply can be found at the correct path.
 */
export function resolveGitDir(cwd: string): string {
	const dotGit = join(cwd, ".git");
	try {
		if (statSync(dotGit).isFile()) {
			const content = readFileSync(dotGit, "utf8");
			const match = /^gitdir:\s*(.+)$/m.exec(content);
			if (match?.[1]) {
				const gitDir = match[1].trim();
				return isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
			}
		}
	} catch {
		// ignore — fall through to default
	}
	return dotGit;
}

/**
 * Returns true if a rebase is currently in progress in the given repo.
 * Checks for rebase-merge (interactive rebase) and rebase-apply
 * (non-interactive rebase / git am) inside the resolved gitdir.
 * Used as a fallback for GUI clients that do not set GIT_REFLOG_ACTION.
 * Works correctly for both regular repos and git worktrees.
 */
export function isRebaseInProgress(cwd: string): boolean {
	const gitDir = resolveGitDir(cwd);
	return existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"));
}

// ─── Reflog reading ──────────────────────────────────────────────────────────

/**
 * Reads the latest reflog entry subject.
 *
 * Uses `git reflog -1 --format=%gs` which returns the reflog subject:
 *   "commit: <message>"          — normal commit
 *   "commit (amend): <message>"  — amend
 *   "commit (initial): <message>" — first commit
 *   "reset: moving to <ref>"     — reset
 *   "rebase (pick): <message>"   — rebase pick
 *   "cherry-pick: <message>"     — cherry-pick
 *
 * @returns The reflog subject string, or null if the reflog cannot be read.
 */
export function readLastReflogSubject(cwd: string): string | null {
	try {
		return execSync("git reflog -1 --format=%gs", { cwd, encoding: "utf-8" }).trim();
	} catch {
		log.debug("Failed to read git reflog");
		return null;
	}
}

// ─── Main detection function ─────────────────────────────────────────────────

/** Result of operation detection */
export interface DetectedOperation {
	/** The detected operation type */
	readonly type: "commit" | "amend" | "squash" | "rebase" | "cherry-pick" | "revert";
	/** Path to squash-pending.json (only set when type is "squash") */
	readonly squashPendingPath?: string;
}

/**
 * Detects what type of git operation triggered the current post-commit hook.
 *
 * Detection order matters — earlier checks take precedence:
 *
 * 1. **Rebase**: Uses GIT_REFLOG_ACTION (set by git) + .git/rebase-merge filesystem check.
 *    Must be first because rebase triggers N post-commit hooks and we must skip all of them.
 *
 * 2. **Squash**: Uses squash-pending.json (written by our prepare-commit-msg or VSCode Bridge).
 *    Checked before amend because squash uses `git reset --soft` + `git commit` which
 *    produces a normal reflog entry. Our own file is 100% certain.
 *
 * 3. **Amend**: Uses git reflog subject with `startsWith("commit (amend)")`.
 *    GIT_REFLOG_ACTION is empty for amend, so reflog is the only signal.
 *    Checked after squash to avoid false positives from commit messages.
 *
 * 4. **Cherry-pick / Revert**: Uses GIT_REFLOG_ACTION (set reliably by git).
 *
 * 5. **Commit**: Default fallback if nothing else matches.
 */
export function detectCommitOperation(cwd: string): DetectedOperation {
	const reflogAction = process.env.GIT_REFLOG_ACTION ?? "";

	// 1. Rebase — GIT_REFLOG_ACTION is the most reliable signal (git sets it actively).
	//    Also check filesystem as fallback for GUI clients that don't set the env var.
	if (reflogAction.includes("rebase") || isRebaseInProgress(cwd)) {
		return { type: "rebase" };
	}

	// 2. Squash — our own file, 100% certainty. Check BEFORE amend because:
	//    - Squash uses `git reset --soft` + `git commit` which has a normal reflog
	//    - Reflog-based amend detection has proven fragile (commit message pollution)
	//    - Our own file is guaranteed to be correct
	const squashPendingPath = join(cwd, ".jolli", "jollimemory", "squash-pending.json");
	if (existsSync(squashPendingPath)) {
		return { type: "squash", squashPendingPath };
	}

	// 3. Amend — reflog is the only reliable signal (GIT_REFLOG_ACTION is empty for amend).
	//    MUST use startsWith("commit (amend)"), NEVER includes("amend").
	//    The reflog subject contains the commit message, so includes() would match
	//    any commit whose message happens to contain "amend".
	const reflogSubject = readLastReflogSubject(cwd);
	if (reflogSubject?.startsWith("commit (amend)")) {
		return { type: "amend" };
	}

	// 4. Cherry-pick / revert — GIT_REFLOG_ACTION is reliable for these
	if (reflogAction === "cherry-pick") return { type: "cherry-pick" };
	if (reflogAction === "revert") return { type: "revert" };

	// 5. Default: normal commit
	return { type: "commit" };
}

// ─── Reset-squash detection (runs in prepare-commit-msg) ─────────────────────

/**
 * Detects a reset-squash scenario: `git reset --soft HEAD~N && git commit`.
 *
 * This runs during the prepare-commit-msg hook (before the commit is created),
 * which is the only time the detection signals are reliable:
 *   - reflog's latest entry is still "reset: moving to ..." (will be overwritten after commit)
 *   - ORIG_HEAD contains the pre-reset HEAD (may be changed by subsequent operations)
 *
 * Uses 5 layers of validation to minimize false positives:
 *   0. squash-pending.json must not already exist (VSCode plugin may have pre-written it)
 *   1. Reflog's latest entry must start with "reset:" (filters normal commits, merges, rebases)
 *   2. ORIG_HEAD must exist (written by git reset with the pre-reset HEAD hash)
 *   3. Current HEAD must be an ancestor of ORIG_HEAD (confirms backward reset, not branch switch)
 *   4. rev-list HEAD..ORIG_HEAD must return non-empty (at least one squashed commit)
 *
 * @returns true if reset-squash was detected and squash-pending was saved
 */
export async function detectResetSquash(cwd: string): Promise<boolean> {
	// Step 0: If squash-pending.json already exists (e.g., VSCode plugin pre-wrote it),
	// skip detection to avoid overwriting.
	const existing = await loadSquashPending(cwd);
	if (existing) {
		log.debug("squash-pending.json already exists — skipping reset-squash detection");
		return false;
	}

	// Step 1: Check reflog — latest entry must start with "reset:"
	const reflogAction = await getLastReflogAction(cwd);
	if (!reflogAction.startsWith("reset:")) {
		log.debug("Reflog latest entry is not a reset (%s) — skipping reset-squash detection", reflogAction);
		return false;
	}

	// Step 2: Read ORIG_HEAD (written by git reset with the pre-reset HEAD hash)
	const origHead = await readOrigHead(cwd);
	if (!origHead) {
		log.debug("ORIG_HEAD not found — skipping reset-squash detection");
		return false;
	}

	// Step 3: Verify HEAD is an ancestor of ORIG_HEAD (backward reset, not branch switch)
	const headHash = await getHeadHash(cwd);
	const ancestorCheck = await isAncestor(headHash, origHead, cwd);
	if (!ancestorCheck) {
		log.debug(
			"HEAD (%s) is not an ancestor of ORIG_HEAD (%s) — skipping reset-squash detection",
			headHash.slice(0, 8),
			origHead.slice(0, 8),
		);
		return false;
	}

	// Step 4: Get the list of squashed commits (HEAD..ORIG_HEAD)
	const squashedHashes = await getCommitRange(headHash, origHead, cwd);
	if (squashedHashes.length === 0) {
		log.debug("No commits in range HEAD..ORIG_HEAD — skipping reset-squash detection");
		return false;
	}

	log.info(
		"Reset-squash detected: %d commits (%s..%s)",
		squashedHashes.length,
		headHash.slice(0, 8),
		origHead.slice(0, 8),
	);
	await saveSquashPending([...squashedHashes], headHash, cwd);
	return true;
}
