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
 */

import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { CommitsStore } from "../stores/CommitsStore.js";
import type { FilesStore } from "../stores/FilesStore.js";
import type { StatusStore } from "../stores/StatusStore.js";
import type { BranchCommit } from "../Types.js";
import { isWorkerBusy } from "../util/LockUtils.js";
import { log } from "../util/Logger.js";
import type { StatusBarManager } from "../util/StatusBarManager.js";

const FORCE_PUSH_CONFIRM_LABEL = "Force Push (--force-with-lease)";

export class PushCommand {
	constructor(
		private readonly bridge: JolliMemoryBridge,
		private readonly commitsStore: CommitsStore,
		private readonly filesStore: FilesStore,
		private readonly statusStore: StatusStore,
		private readonly statusBar: StatusBarManager,
		private readonly workspaceRoot: string,
	) {}

	async execute(): Promise<void> {
		// Guard: block while the post-commit Worker holds the lock
		if (await isWorkerBusy(this.workspaceRoot)) {
			vscode.window.showWarningMessage(
				"Jolli Memory: AI summary is being generated. Please wait a moment.",
			);
			return;
		}

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
				log.info(
					"push",
					`HEAD already pushed (${commits.length} commit(s) on branch) — asking for force-push confirmation`,
				);
				const confirmed = await this.showForcePushWarning(
					commits,
					"HEAD is already on remote. Force push will rewrite remote branch history.",
				);
				if (!confirmed) {
					log.info("push", "Force-push confirmation cancelled");
					return;
				}
				await this.bridge.forcePush();
				resultLabel = "force-pushed";
			} else {
				try {
					await this.bridge.pushCurrentBranch();
				} catch (err: unknown) {
					if (!this.isNonFastForwardError(err)) {
						throw err;
					}
					log.warn(
						"push",
						"Normal push rejected (non-fast-forward) — offering force push",
					);
					const confirmed = await this.showForcePushWarning(
						commits,
						"Remote branch has diverged. Force push will overwrite remote history.",
					);
					if (!confirmed) {
						log.info("push", "Force-push fallback cancelled");
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
	 * Shows a modal force-push confirmation dialog.
	 *
	 * Single-commit branches show "Commit: <hash> <msg>"; multi-commit branches
	 * show "HEAD (N commits): <hash> <msg>" so the user can see at a glance how
	 * many commits the force-push will replace on the remote.
	 */
	private async showForcePushWarning(
		commits: ReadonlyArray<BranchCommit>,
		reason: string,
	): Promise<boolean> {
		const head = commits[0];
		const headLabel =
			commits.length === 1 ? "Commit" : `HEAD (${commits.length} commits)`;
		const answer = await vscode.window.showWarningMessage(
			[
				"This operation may rewrite remote history.",
				"",
				`${headLabel}: ${head.shortHash} ${head.message.substring(0, 80)}`,
				"",
				reason,
				"This may affect collaborators on the same branch.",
			].join("\n"),
			{ modal: true },
			FORCE_PUSH_CONFIRM_LABEL,
		);
		return answer === FORCE_PUSH_CONFIRM_LABEL;
	}

	private isNonFastForwardError(err: unknown): boolean {
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
