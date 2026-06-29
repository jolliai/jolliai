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
// The divergence inspection lives in the vscode-free `ForcePushSafety` module so
// non-UI callers (e.g. JolliMemoryBridge, tested under node) can import it
// without pulling in `vscode`. The gate below only needs the result shape.
import type { ForcePushSafety } from "./ForcePushSafety.js";

/** Button label for the modal force-push confirmation. */
export const FORCE_PUSH_CONFIRM_LABEL = "Force Push (--force-with-lease)";

/** Default reason line for the diverged-branch (non-fast-forward) case. */
const DEFAULT_FORCE_PUSH_REASON =
	"Remote branch has diverged. Force push will overwrite remote history.";

/**
 * Recognizes git's non-fast-forward push rejection. A normal push emits this
 * both when the local branch was rewritten after it was first pushed (the
 * force-push case) AND when the branch is merely behind a collaborator's new
 * remote commits (the rebase case) — git uses the same stderr for both, so this
 * matcher alone cannot tell them apart. Callers must run `gateForcePush` after
 * a match to measure the actual divergence before offering a force-push.
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

/** Modal warning shown when the branch is merely behind the remote (no force-push offered). */
export function remoteAheadMessage(branch: string, remoteOnly: number): string {
	const commits = remoteOnly === 1 ? "commit" : "commits";
	return [
		`Remote branch "${branch}" has ${remoteOnly} ${commits} you don't have locally,`,
		"and your branch has no commits the remote is missing.",
		"",
		"This is not a history rewrite — your branch is simply behind. Pull or",
		"rebase to integrate the remote commits, then push again. Force-pushing",
		`here would permanently delete those ${remoteOnly} remote ${commits}.`,
	].join("\n");
}

/** Detail line appended to the force-push modal when remote-only commits would be lost. */
export function lostRemoteCommitsLine(remoteOnly: number): string {
	const commits = remoteOnly === 1 ? "commit" : "commits";
	return `Warning: this will permanently delete ${remoteOnly} ${commits} that exist only on the remote.`;
}

/** Result of the post-rejection force-push gate. */
export type ForcePushOutcome = "confirmed" | "declined" | "blocked";

/**
 * Post-rejection gate shared by both push entry points. Inspects the divergence,
 * then either:
 * - blocks (returns `"blocked"` after a modal warning) when the branch is merely
 *   behind the remote — force-push is never offered, the user must rebase first;
 * - shows the shared force-push modal (annotated with the count of remote-only
 *   commits that will be lost) and returns the user's choice (`"confirmed"` /
 *   `"declined"`).
 *
 * When the divergence can't be measured (inconclusive probe), it falls back to
 * the plain confirm modal so a legitimate rewrite is never blocked by a transient
 * git/network failure.
 */
export async function gateForcePush(opts: {
	inspect: () => Promise<ForcePushSafety | null>;
	detailLines?: ReadonlyArray<string>;
	reason?: string;
}): Promise<ForcePushOutcome> {
	const safety = await opts.inspect();
	if (safety?.behindOnly) {
		await vscode.window.showWarningMessage(
			remoteAheadMessage(safety.branch, safety.remoteOnly),
			{ modal: true },
		);
		return "blocked";
	}
	const lostLine =
		safety && safety.remoteOnly > 0
			? [lostRemoteCommitsLine(safety.remoteOnly)]
			: [];
	const confirmed = await confirmForcePush({
		detailLines: [...(opts.detailLines ?? []), ...lostLine],
		reason: opts.reason,
	});
	return confirmed ? "confirmed" : "declined";
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
