import { isAncestor, orphanBranchExists } from "../../../cli/src/core/GitOps.js";

/**
 * Decision for whether a "Create PR" action may proceed for a given summary,
 * and which branch the PR should be scoped to.
 *
 * Background: a summary records the branch it was created on (`summary.branch`),
 * captured once at commit time and never refreshed. A `git branch -m` (rename)
 * or `git branch -D` (delete) makes that stored name stale while the actual work
 * lives on the current branch. The old equality guard (`summary.branch !==
 * currentBranch`) could not tell a genuine cross-branch view ("the summary's
 * branch still exists, you're just looking at it from another branch") apart
 * from a rename/delete ("the old branch no longer exists; the current branch is
 * where the work is"), so it blocked the rename case with a dead-end "Checkout
 * <old> to create its PR" message even though `<old>` was gone.
 *
 * The distinguishing signal is whether the summary's branch still exists as a
 * local ref: `branch -m` / `-D` delete the old ref; `git checkout` elsewhere
 * does not. When the old ref is gone we additionally require the current branch
 * to actually contain the summary's commit before attributing the PR to it.
 */
export type CreatePrBranchDecision =
	/** `summary.branch === currentBranch`, or no summary branch context. */
	| { kind: "ok"; effectiveBranch: string }
	/** Old ref is gone and the current branch contains the commit (rename / delete-to-successor). */
	| { kind: "okAsCurrent"; effectiveBranch: string }
	/** Current branch could not be determined (detached HEAD or git error, normalized to "HEAD"). */
	| { kind: "detachedHead" }
	/** `summary.branch !== currentBranch` and the old ref still exists (genuine cross-branch view). */
	| { kind: "crossBranch"; summaryBranch: string }
	/** Old ref is gone and the commit is not on the current branch (deleted + unrelated, or rename+rebase). */
	| { kind: "originalGone"; summaryBranch: string };

/**
 * Classifies a Create-PR request. Pure given its inputs (delegates only to the
 * read-only git helpers `orphanBranchExists` + `isAncestor`).
 *
 * `currentBranch` must already be normalized by the caller: the literal sentinel
 * `"HEAD"` signals "could not determine the branch" (detached HEAD or a git
 * error). `commitHash` is the summary's commit; when absent the rename path
 * cannot be verified and the request degrades to `originalGone`.
 */
export async function classifyCreatePrBranch(
	summaryBranch: string | undefined,
	currentBranch: string,
	commitHash: string | undefined,
	cwd: string,
): Promise<CreatePrBranchDecision> {
	// No summary branch context: fall back to current-branch behavior (allowed).
	if (!summaryBranch) {
		return { kind: "ok", effectiveBranch: currentBranch };
	}
	// Cannot determine the current branch. Telling the user to checkout a branch
	// here is wrong — the repo is in a transient bad state, not on a different
	// branch.
	if (currentBranch === "HEAD") {
		return { kind: "detachedHead" };
	}
	if (summaryBranch === currentBranch) {
		return { kind: "ok", effectiveBranch: summaryBranch };
	}
	// Mismatch. The old ref still existing means a genuine cross-branch view —
	// block so we never push the current branch's HEAD onto another branch's PR.
	// (`orphanBranchExists` is a generic `git rev-parse --verify refs/heads/<b>`
	// local-ref check despite its name — it is not specific to the orphan branch.)
	if (await orphanBranchExists(summaryBranch, cwd)) {
		return { kind: "crossBranch", summaryBranch };
	}
	// Old ref is gone (renamed or deleted). Allow only when the current branch
	// actually contains this summary's commit — that proves the work is on the
	// branch we'll push. Without it (rename + rebase that rewrote the hash, or a
	// switch to an unrelated branch) we can't safely attribute the PR.
	if (commitHash && (await isAncestor(commitHash, "HEAD", cwd))) {
		return { kind: "okAsCurrent", effectiveBranch: currentBranch };
	}
	return { kind: "originalGone", summaryBranch };
}

/**
 * The detached-HEAD / git-error warning. Extracted so both guard sites (the
 * panel's prepare step and the service's submit-time second line) emit the
 * identical wording without going through the nullable {@link createPrBlockMessage}.
 */
export function detachedHeadMessage(summaryBranch: string | undefined): string {
	return `Cannot determine the current branch (detached HEAD or git error). Resolve the repository state, then retry creating the PR${
		summaryBranch ? ` for ${summaryBranch}` : ""
	}.`;
}

/**
 * The user-facing warning for a blocking decision, or `null` when the request
 * may proceed (`ok` / `okAsCurrent`). Shared by both guard sites so the wording
 * stays identical.
 */
export function createPrBlockMessage(
	decision: CreatePrBranchDecision,
	summaryBranch: string | undefined,
): string | null {
	switch (decision.kind) {
		case "detachedHead":
			return detachedHeadMessage(summaryBranch);
		case "crossBranch":
			return `This summary is on branch ${decision.summaryBranch}. Checkout ${decision.summaryBranch} to create its PR.`;
		case "originalGone":
			return `The branch this summary was created on (${decision.summaryBranch}) no longer exists, and its commit is not on the current branch — there is no branch to create a PR from.`;
		default:
			return null;
	}
}

/**
 * The branch a Create/Update PR flow should be scoped to once classified:
 * `currentBranch` for the rename/successor case, otherwise the summary's own
 * branch (cross-branch views keep showing the summary's branch; blocked cases
 * never reach a scoped operation).
 */
export function effectiveBranchFor(
	decision: CreatePrBranchDecision,
	summaryBranch: string | undefined,
): string | undefined {
	if (decision.kind === "ok" || decision.kind === "okAsCurrent") {
		return decision.effectiveBranch;
	}
	return summaryBranch;
}
