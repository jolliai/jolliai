/**
 * PushCommand
 *
 * Handles branch submission from the Branch Commits panel. Supports any
 * commit count >= 1 — multi-commit branches push exactly the same way as
 * single-commit ones (`git push origin HEAD`); the difference is purely the
 * force-push warning copy.
 *
 * Flow:
 * 1. Reject empty branches (no commits ahead of base) with a warning.
 * 2. If the HEAD commit is already on remote, ask for force-push confirmation.
 * 3. Otherwise try normal push; on non-fast-forward rejection, offer force push.
 * 4. Refresh panels and status bar after success.
 *
 * Note: pushing is intentionally NOT gated on the post-commit Worker lock
 * (`isWorkerBusy`). Push only runs `git push` on the current code branch; it
 * shares no git ref or file with the QueueWorker, which writes summaries to the
 * orphan branch + Memory Bank folder and never touches the remote. Commit and
 * Squash stay gated because they race the worker (LLM provider / local history
 * rewrite); push does not. Do not reintroduce a worker-busy guard here.
 */

import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { CommitsStore } from "../stores/CommitsStore.js";
import type { FilesStore } from "../stores/FilesStore.js";
import type { StatusStore } from "../stores/StatusStore.js";
import type { BranchCommit } from "../Types.js";
import { gateForcePush, isNonFastForwardError } from "../util/ForcePushPrompt.js";
import { log } from "../util/Logger.js";
import type { StatusBarManager } from "../util/StatusBarManager.js";

export class PushCommand {
	constructor(
		private readonly bridge: JolliMemoryBridge,
		private readonly commitsStore: CommitsStore,
		private readonly filesStore: FilesStore,
		private readonly statusStore: StatusStore,
		private readonly statusBar: StatusBarManager,
	) {}

	async execute(): Promise<void> {
		const commits = this.commitsStore.getSnapshot().commits;
		if (commits.length === 0) {
			log.info(
				"push",
				"pushBranch invoked with empty branch — nothing to push",
			);
			vscode.window.showWarningMessage(
				"Jolli Memory: No commits to push on the current branch.",
			);
			return;
		}

		// commits is newest-first (per JolliMemoryBridge.listBranchCommits), so
		// commits[0] is HEAD. The "is HEAD on remote" check covers both single
		// and multi commit branches uniformly: if HEAD is already pushed, any
		// further push that lands a different HEAD is a history rewrite.
		const headCommit = commits[0];
		let resultLabel: "pushed" | "force-pushed" = "pushed";

		try {
			if (headCommit.isPushed) {
				// HEAD is already on remote, so any push here rewrites remote
				// history. Gate on the actual divergence first — this path used to
				// offer force-push unconditionally, which would clobber a
				// collaborator's commits when the branch was merely behind.
				log.info(
					"push",
					`HEAD already pushed (${commits.length} commit(s) on branch) — checking divergence`,
				);
				if (
					!(await this.runForcePushGate(
						commits,
						"HEAD is already on remote. Force push will rewrite remote branch history.",
						"Force-push confirmation cancelled",
					))
				) {
					return;
				}
				await this.bridge.forcePush();
				resultLabel = "force-pushed";
			} else {
				try {
					await this.bridge.pushCurrentBranch();
				} catch (err: unknown) {
					if (!isNonFastForwardError(err)) {
						throw err;
					}
					log.warn(
						"push",
						"Normal push rejected (non-fast-forward) — checking divergence",
					);
					if (
						!(await this.runForcePushGate(
							commits,
							"Remote branch has diverged. Force push will overwrite remote history.",
							"Force-push fallback cancelled",
						))
					) {
						return;
					}
					await this.bridge.forcePush();
					resultLabel = "force-pushed";
				}
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("push", `Push failed: ${message}`, err);
			vscode.window.showErrorMessage(`Jolli Memory: Push failed: ${message}`);
			return;
		}

		vscode.window.showInformationMessage(
			`Jolli Memory: Successfully ${resultLabel} the current branch.`,
		);
		await this.refreshAll();
	}

	/**
	 * Builds the commit detail line this flow has the context for: single-commit
	 * branches show "Commit: <hash> <msg>"; multi-commit branches show
	 * "HEAD (N commits): <hash> <msg>" so the user can see at a glance how many
	 * commits the force-push will replace on the remote. Shared by both the
	 * already-pushed pre-warning and the non-fast-forward gate so the wording
	 * can't drift between them.
	 */
	private headDetailLine(commits: ReadonlyArray<BranchCommit>): string {
		const head = commits[0];
		const headLabel =
			commits.length === 1 ? "Commit" : `HEAD (${commits.length} commits)`;
		return `${headLabel}: ${head.shortHash} ${head.message.substring(0, 80)}`;
	}

	/**
	 * Runs the shared force-push gate (divergence check → block-or-confirm) with
	 * this flow's commit detail line. Returns true only when the caller should go
	 * ahead and force-push. Both push entry points — the "HEAD already pushed"
	 * pre-warning and the non-fast-forward fallback — route through here so a
	 * branch that is merely behind the remote is never force-pushed over a
	 * collaborator's commits.
	 */
	private async runForcePushGate(
		commits: ReadonlyArray<BranchCommit>,
		reason: string,
		declinedLog: string,
	): Promise<boolean> {
		const outcome = await gateForcePush({
			inspect: () => this.bridge.inspectForcePushSafety(),
			detailLines: [this.headDetailLine(commits)],
			reason,
		});
		if (outcome === "blocked") {
			log.info("push", "Push blocked — remote is ahead; rebase first");
			return false;
		}
		if (outcome === "declined") {
			log.info("push", declinedLog);
			return false;
		}
		return true;
	}

	private async refreshAll(): Promise<void> {
		await Promise.all([
			this.commitsStore.refresh(),
			this.filesStore.refresh(),
			this.statusStore.refresh(),
		]);

		const status = await this.bridge.getStatus();
		this.statusBar.update(status.enabled);
	}
}
