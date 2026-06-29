/**
 * ForcePushPrompt
 *
 * Single source of truth for the modal force-push confirmation shown when a
 * normal `git push` is rejected because the branch's local history was
 * rewritten after it was first pushed (rebase / amend / squash / reset), or
 * the HEAD is already on remote.
 *
 * Two push entry points share this so users see byte-identical wording and the
 * same button regardless of where they triggered it:
 * - the sidebar Push Branch flow (`PushCommand`), which adds a HEAD/commit line
 * - the Create PR push step (`PrCommentService`), which has no commit context
 *
 * The squash pre-warning in `SquashCommand` is intentionally NOT routed here:
 * it's a different decision (confirming a history rewrite *before* squashing,
 * with its own button text), not a post-rejection force-push confirmation.
 */

import * as vscode from "vscode";

/** Button label for the modal force-push confirmation. */
export const FORCE_PUSH_CONFIRM_LABEL = "Force Push (--force-with-lease)";

/** Default reason line for the diverged-branch (non-fast-forward) case. */
const DEFAULT_FORCE_PUSH_REASON =
	"Remote branch has diverged. Force push will overwrite remote history.";

/**
 * Recognizes git's non-fast-forward push rejection. A normal push emits this
 * when the local branch was rewritten after it was first pushed. Both push
 * entry points classify the same stderr identically through this helper.
 */
export function isNonFastForwardError(err: unknown): boolean {
	const message = (
		err instanceof Error ? err.message : String(err)
	).toLowerCase();
	return (
		message.includes("non-fast-forward") ||
		message.includes("fetch first") ||
		message.includes("[rejected]") ||
		message.includes("tip of your current branch is behind")
	);
}

/**
 * Shows the shared modal force-push confirmation. Returns true only when the
 * user clicks the explicit force-push button.
 *
 * - `detailLines` are inserted between the lead-in and the reason — Push Branch
 *   passes the HEAD/commit-count line; Create PR passes none.
 * - `reason` overrides the default diverged-branch wording (Push Branch's
 *   already-pushed path uses a slightly different sentence).
 */
export async function confirmForcePush(
	opts: { detailLines?: ReadonlyArray<string>; reason?: string } = {},
): Promise<boolean> {
	const detailLines = opts.detailLines ?? [];
	const lines = [
		"This operation may rewrite remote history.",
		"",
		...(detailLines.length > 0 ? [...detailLines, ""] : []),
		opts.reason ?? DEFAULT_FORCE_PUSH_REASON,
		"This may affect collaborators on the same branch.",
	];
	const answer = await vscode.window.showWarningMessage(
		lines.join("\n"),
		{ modal: true },
		FORCE_PUSH_CONFIRM_LABEL,
	);
	return answer === FORCE_PUSH_CONFIRM_LABEL;
}
