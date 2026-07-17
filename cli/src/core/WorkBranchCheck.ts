/**
 * Deterministic work-branch cross-check for the local-run publish step.
 *
 * A local run's file writes must be published on the *server-derived* work branch
 * (`writeTarget.workBranch` from `start_local_run`) so the backend can link the run
 * to the pull request and auto-merge/apply it. If the host LLM drops the branch when
 * it runs `docs pull --branch <workBranch>`, space-cli falls back to generating its
 * own `jolli-<hex>` branch and opens the PR there instead — the run→PR link silently
 * breaks (nothing merges, articles never publish), yet the run can still report
 * success. `docs publish --json` returns the branch the PR was actually opened on as
 * `headBranch` (present on both the public and the private/withheld paths), so the
 * host can catch the mismatch deterministically by comparing two strings it already
 * holds — instead of asking the same LLM that dropped the branch to compare them.
 */

/** Result of comparing the expected server work branch to the published head branch. */
export interface WorkBranchCheckResult {
	/** True only when both branches are non-empty and equal (after trimming). */
	readonly match: boolean;
	/** The expected server-derived work branch (`writeTarget.workBranch`), trimmed. */
	readonly expected: string;
	/** The branch the PR was actually opened on (`headBranch`), trimmed. */
	readonly actual: string;
}

/**
 * Compares the expected server work branch to the branch the publish landed on.
 * A missing/empty `actual` (no `headBranch` reported) can NOT be verified as correct,
 * so it is treated as a non-match — the caller stops rather than assuming success.
 */
export function checkPublishBranch(expected: string, actual: string): WorkBranchCheckResult {
	const trimmedExpected = expected.trim();
	const trimmedActual = actual.trim();
	const match = trimmedExpected.length > 0 && trimmedActual.length > 0 && trimmedExpected === trimmedActual;
	return { match, expected: trimmedExpected, actual: trimmedActual };
}
