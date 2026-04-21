/**
 * SquashCommand
 *
 * Implements the Squash flow triggered by the [⊞ Squash] button in the Branch History panel.
 *
 * Flow:
 * 1. Verify at least 2 commits are selected.
 * 2. If any selected commits are already pushed, show a force-push warning modal.
 * 3. Generate a squash message via LLM (with fallback to string-merge).
 * 4. Show a QuickPick at the top of screen with editable message:
 *    - ⊞ Squash
 *    - ⊞↑ Squash & Push
 * 5. Execute the selected action.
 * 6. Show success notification and refresh panels.
 */

import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { FilesTreeProvider } from "../providers/FilesTreeProvider.js";
import type { HistoryTreeProvider } from "../providers/HistoryTreeProvider.js";
import type { StatusTreeProvider } from "../providers/StatusTreeProvider.js";
import type { BranchCommit } from "../Types.js";
import { isWorkerBusy } from "../util/LockUtils.js";
import { log } from "../util/Logger.js";
import type { StatusBarManager } from "../util/StatusBarManager.js";

// ─── QuickPick items ──────────────────────────────────────────────────────────

const ITEM_SQUASH: vscode.QuickPickItem = {
	label: "$(git-merge) Squash",
	description: "git reset --soft + git commit",
	alwaysShow: true,
};

const ITEM_SQUASH_PUSH: vscode.QuickPickItem = {
	label: "$(cloud-upload) Squash & Push",
	description: "git reset --soft + git commit + git push --force-with-lease",
	alwaysShow: true,
};

// ─── SquashCommand ────────────────────────────────────────────────────────────

export class SquashCommand {
	constructor(
		private readonly bridge: JolliMemoryBridge,
		private readonly historyProvider: HistoryTreeProvider,
		private readonly filesProvider: FilesTreeProvider,
		private readonly statusProvider: StatusTreeProvider,
		private readonly statusBar: StatusBarManager,
		private readonly workspaceRoot: string,
	) {}

	/**
	 * Executes the squash flow.
	 * Called when the user clicks [⊞ Squash] in the Branch History panel header.
	 */
	async execute(): Promise<void> {
		// Guard: block while the post-commit Worker holds the lock
		if (await isWorkerBusy(this.workspaceRoot)) {
			vscode.window.showWarningMessage(
				"Jolli Memory: AI summary is being generated. Please wait a moment.",
			);
			return;
		}

		// Step 1: Verify selection
		const selected = this.historyProvider.getSelectedCommits();
		log.info("squash", `Selected commits: ${selected.length}`, {
			historySelection: this.historyProvider.getSelectionDebugInfo(),
			selectedHashes: selected.map((c) => c.hash.substring(0, 8)),
		});
		if (selected.length < 2) {
			log.warn("squash", "Fewer than 2 commits selected — aborting");
			vscode.window.showWarningMessage(
				"Jolli Memory: Select at least 2 commits to squash.",
			);
			return;
		}

		// Commits are newest-first; for git operations we need oldest-first
		const orderedHashes = [...selected].reverse().map((c) => c.hash);
		log.info("squash", "Computed squash range", {
			count: orderedHashes.length,
			oldestHash: orderedHashes[0]?.substring(0, 8),
			newestHash: orderedHashes[orderedHashes.length - 1]?.substring(0, 8),
			orderedHashes: orderedHashes.map((hash) => hash.substring(0, 8)),
		});

		// Step 2: Warn if any commits are already pushed
		const pushedCommits = selected.filter((c) => c.isPushed);
		if (pushedCommits.length > 0) {
			log.warn(
				"squash",
				`${pushedCommits.length} pushed commit(s) — showing force-push warning`,
			);
			const confirmed = await this.showForcePushWarning(pushedCommits);
			if (!confirmed) {
				log.info("squash", "User cancelled force-push warning");
				return;
			}
		}

		// Step 3: Generate squash message (LLM with fallback to string-merge)
		let squashMessage: string;
		try {
			log.info("squash", "Generating squash message via AI…");
			squashMessage = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Jolli Memory: Generating squash message…",
					cancellable: false,
				},
				() => this.bridge.generateSquashMessageWithLLM(orderedHashes),
			);
			log.info("squash", "Squash message generated", { squashMessage });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("squash", `Failed to generate squash message: ${message}`, err);
			vscode.window.showErrorMessage(
				`Jolli Memory: Failed to generate squash message: ${message}`,
			);
			return;
		}

		// Step 4: Show QuickPick
		const selectedAction = await this.showSquashQuickPick(squashMessage);
		if (!selectedAction) {
			log.info("squash", "QuickPick cancelled by user");
			return;
		}

		// Step 5: Protect staged files — ensure squash doesn't include unrelated staged files.
		// git reset --soft + git commit (used by squashCommits) commits the entire staging area,
		// which would include any files the user had previously staged but not yet committed.
		// We unstage them before the squash and re-stage them after.
		let originalStagedPaths: Array<string> = [];
		try {
			originalStagedPaths = await this.bridge.getStagedFilePaths();
			if (originalStagedPaths.length > 0) {
				await this.bridge.unstageFiles(originalStagedPaths);
				log.info(
					"squash",
					`Unstaged ${originalStagedPaths.length} file(s) to protect from squash`,
				);
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.error(
				"squash",
				`Failed to protect index before squash: ${message}`,
				err,
			);
			vscode.window.showErrorMessage(
				"Jolli Memory: Could not save current index state. Squash aborted.",
			);
			await this.restoreStagedFiles(originalStagedPaths);
			return;
		}

		// Step 6: Execute
		try {
			log.info("squash", `Executing action: ${selectedAction.item.label}`, {
				hashes: orderedHashes.map((hash) => hash.substring(0, 8)),
				oldestHash: orderedHashes[0]?.substring(0, 8),
				newestHash: orderedHashes[orderedHashes.length - 1]?.substring(0, 8),
				message: selectedAction.message,
			});
			await this.executeSquashAction(
				selectedAction.item,
				orderedHashes,
				selectedAction.message,
			);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("squash", `Squash action failed: ${message}`, err);
			vscode.window.showErrorMessage(`Jolli Memory: Squash failed: ${message}`);
			await this.restoreStagedFiles(originalStagedPaths);
			return;
		}

		// Step 7: Restore previously staged files that were not part of the squash
		await this.restoreStagedFiles(originalStagedPaths);

		// Step 8: Success notification and refresh
		const actionLabel =
			selectedAction.item === ITEM_SQUASH_PUSH
				? "squashed and pushed"
				: "squashed";
		log.info("squash", `Success — ${selected.length} commits ${actionLabel}`);
		vscode.window.showInformationMessage(
			`Jolli Memory: ${selected.length} commits ${actionLabel}. post-commit hook is merging summaries in the background.`,
		);

		await this.refreshAll();
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	/** Re-stages files that were temporarily unstaged to protect them from the squash commit. */
	private async restoreStagedFiles(paths: Array<string>): Promise<void> {
		if (paths.length === 0) {
			return;
		}
		try {
			await this.bridge.stageFiles(paths);
			log.info("squash", `Re-staged ${paths.length} previously-staged file(s)`);
		} catch (err: unknown) {
			log.warn("squash", `Failed to re-stage previously-staged files: ${err}`);
			vscode.window.showWarningMessage(
				"Jolli Memory: Some previously-staged files could not be re-staged. You may need to re-stage them manually.",
			);
		}
	}

	/**
	 * Shows a modal warning when squashing already-pushed commits requires force push.
	 * Returns true if the user confirmed, false if they cancelled.
	 */
	private async showForcePushWarning(
		pushedCommits: Array<BranchCommit>,
	): Promise<boolean> {
		const commitList = pushedCommits
			.map((c) => `• ${c.shortHash} ${c.message.substring(0, 60)}`)
			.join("\n");

		const answer = await vscode.window.showWarningMessage(
			[
				`${pushedCommits.length} of the selected commit(s) have already been pushed to remote:`,
				"",
				commitList,
				"",
				"Squashing will rewrite history. You will need to force push afterwards.",
				"This may affect collaborators on the same branch.",
			].join("\n"),
			{ modal: true },
			"Continue (I know force push is needed)",
		);

		return answer === "Continue (I know force push is needed)";
	}

	private showSquashQuickPick(
		squashMessage: string,
	): Promise<{ item: vscode.QuickPickItem; message: string } | undefined> {
		return new Promise((resolve) => {
			const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
			qp.value = squashMessage;
			qp.placeholder = "Edit the squash commit message, then select an action";
			qp.items = [ITEM_SQUASH, ITEM_SQUASH_PUSH];

			// Disable filtering so the input text is used as a free-form message,
			// not as a filter query. Same fix as CommitCommand.
			qp.matchOnLabel = false;
			qp.matchOnDescription = false;
			qp.matchOnDetail = false;

			log.debug("quickpick", "Squash QuickPick shown", {
				value: squashMessage,
			});

			// Guard: resolve before dispose — same race-condition fix as CommitCommand.
			let accepted = false;

			qp.onDidAccept(() => {
				accepted = true;
				const selected = qp.selectedItems[0] ?? qp.items[0];
				const message = qp.value.trim();
				log.info("quickpick", "Squash accept triggered", {
					selectedLabel: selected.label,
					messageLength: message.length,
				});
				if (!message) {
					qp.dispose();
					resolve(undefined);
					return;
				}
				resolve({ item: selected, message });
				qp.dispose();
			});

			qp.onDidHide(() => {
				if (accepted) {
					return;
				}
				log.debug("quickpick", "Squash QuickPick hidden (dismissed)");
				qp.dispose();
				resolve(undefined);
			});

			qp.show();
		});
	}

	private async executeSquashAction(
		item: vscode.QuickPickItem,
		hashes: Array<string>,
		message: string,
	): Promise<void> {
		if (item === ITEM_SQUASH_PUSH) {
			await this.bridge.squashAndPush(hashes, message);
		} else {
			await this.bridge.squashCommits(hashes, message);
		}
	}

	private async refreshAll(): Promise<void> {
		await Promise.all([
			this.historyProvider.refresh(),
			this.filesProvider.refresh(),
			this.statusProvider.refresh(),
		]);

		// Update status bar
		const status = await this.bridge.getStatus();
		this.statusBar.update(status.enabled);
	}
}
