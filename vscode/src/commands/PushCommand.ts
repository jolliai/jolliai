/**
 * PushCommand
 *
 * Handles single-commit branch submission from the Branch Commits panel.
 *
 * Flow:
 * 1. Validate the branch has exactly one commit in history view.
 * 2. If the commit is already pushed, ask for force-push confirmation first.
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
		if (commits.length !== 1) {
			log.warn(
				"push",
				`pushBranch only supports single-commit mode, got ${commits.length}`,
			);
			vscode.window.showWarningMessage(
				"Jolli Memory: Push mode is available only when this branch has exactly 1 commit.",
			);
			return;
		}

		const onlyCommit = commits[0];
		let resultLabel: "pushed" | "force-pushed" = "pushed";

		try {
			if (onlyCommit.isPushed) {
				log.info(
					"push",
					"Single commit already pushed — asking for force-push confirmation",
				);
				const confirmed = await this.showForcePushWarning(
					onlyCommit,
					"This commit is already on remote. Force push will rewrite remote branch history.",
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
						onlyCommit,
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

	private async showForcePushWarning(
		commit: BranchCommit,
		reason: string,
	): Promise<boolean> {
		const answer = await vscode.window.showWarningMessage(
			[
				"This operation may rewrite remote history.",
				"",
				`Commit: ${commit.shortHash} ${commit.message.substring(0, 80)}`,
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
