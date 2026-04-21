/**
 * CommitCommand
 *
 * Implements the AI Commit flow triggered by the [✦] button in the Changes panel.
 *
 * Flow (GitHub Desktop model — checkboxes are UI-only, staging happens at commit time):
 * 1. Check that at least one file is selected.
 * 2. Snapshot the original git index, then stage selected / unstage unselected files.
 * 3. Show a progress notification while generating the commit message.
 * 4. Display a QuickPick at the top of the screen (Ctrl+P position) with:
 *    - editable commit message (qp.value)
 *    - three actions: Commit | Commit (Amend) | Commit (Amend, keep message)
 * 5. Execute the selected action.
 * 6. Show a success notification and trigger panel refreshes.
 *
 * If the user cancels or an error occurs, the original index state is fully restored.
 *
 * Push is handled exclusively by the COMMITS panel (PushCommand / SquashCommand)
 * which has full safety checks (isPushed detection, non-fast-forward handling,
 * --force-with-lease).
 */

import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { FilesTreeProvider } from "../providers/FilesTreeProvider.js";
import type { HistoryTreeProvider } from "../providers/HistoryTreeProvider.js";
import type { StatusTreeProvider } from "../providers/StatusTreeProvider.js";
import { isWorkerBusy } from "../util/LockUtils.js";
import { log } from "../util/Logger.js";
import type { StatusBarManager } from "../util/StatusBarManager.js";

// ─── QuickPick items ──────────────────────────────────────────────────────────

const ITEM_COMMIT: vscode.QuickPickItem = {
	label: "$(check) Commit",
	description: "git commit -m",
	alwaysShow: true,
};

const ITEM_AMEND: vscode.QuickPickItem = {
	label: "$(edit) Commit (Amend)",
	description: "git commit --amend -m",
	alwaysShow: true,
};

const ITEM_AMEND_NO_EDIT: vscode.QuickPickItem = {
	label: "$(history) Commit (Amend, keep message)",
	description: "--no-edit · input above will be ignored",
	alwaysShow: true,
};

const DEFAULT_TITLE = "Edit the commit message, then select an action";
const AMEND_NO_EDIT_TITLE =
	"Input will be ignored — reuses last commit message";

// ─── CommitCommand ────────────────────────────────────────────────────────────

export class CommitCommand {
	constructor(
		private readonly bridge: JolliMemoryBridge,
		private readonly filesProvider: FilesTreeProvider,
		private readonly historyProvider: HistoryTreeProvider,
		private readonly statusProvider: StatusTreeProvider,
		private readonly statusBar: StatusBarManager,
		private readonly workspaceRoot: string,
	) {}

	/**
	 * Executes the AI commit flow.
	 * Called when the user clicks [✦] in the Changes panel header.
	 */
	async execute(): Promise<void> {
		// Guard: block while the post-commit Worker holds the lock
		if (await isWorkerBusy(this.workspaceRoot)) {
			vscode.window.showWarningMessage(
				"Jolli Memory: AI summary is being generated. Please wait a moment.",
			);
			return;
		}

		// Step 1: Verify at least one file is selected
		const selectedFiles = this.filesProvider.getSelectedFiles();
		log.info("commit", `Selected files: ${selectedFiles.length}`);
		if (selectedFiles.length === 0) {
			log.warn("commit", "No files selected — aborting");
			vscode.window.showWarningMessage(
				"Jolli Memory: No files are selected. Please check at least one file before committing.",
			);
			return;
		}

		// Step 2: Snapshot the original index, then stage selected / unstage unselected.
		// We use git write-tree to capture the full index state (including partial-hunk
		// staging, intent-to-add entries, and mode-only changes) so that cancel/error
		// paths can restore it exactly.
		// Untracked files (statusCode "?") are excluded from the unstage list —
		// git restore --staged on files never in the index would error out.
		const selectedPaths = selectedFiles.map((f) => f.relativePath);
		const allFiles = this.filesProvider.getFiles();
		const unselectedTrackedPaths = allFiles
			.filter((f) => !f.isSelected && f.statusCode !== "?")
			.map((f) => f.relativePath);
		let originalIndexTree: string;
		let originalStagedPaths: Array<string>;
		try {
			originalIndexTree = await this.bridge.saveIndexTree();
			originalStagedPaths = await this.bridge.getStagedFilePaths();
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("commit", `Failed to snapshot index: ${message}`, err);
			if (message.includes("conflict markers")) {
				vscode.window.showErrorMessage(`Jolli Memory: ${message}`);
			} else {
				vscode.window.showErrorMessage(
					"Jolli Memory: Could not read the current git index. Commit aborted to avoid data loss.",
				);
			}
			return;
		}
		try {
			await this.bridge.stageFiles(selectedPaths);
			if (unselectedTrackedPaths.length > 0) {
				await this.bridge.unstageFiles(unselectedTrackedPaths);
			}
			log.info(
				"commit",
				`Staged ${selectedPaths.length}, unstaged ${unselectedTrackedPaths.length} file(s)`,
			);
			log.debug("commit", "Staged files", { files: selectedPaths });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("commit", `Failed to prepare index: ${message}`, err);
			vscode.window.showErrorMessage(
				`Jolli Memory: Failed to stage files: ${message}`,
			);
			await this.restoreIndex(originalIndexTree);
			return;
		}

		// Step 3: Generate commit message with progress notification
		let generatedMessage: string;
		try {
			log.info("commit", "Generating commit message via AI…");
			generatedMessage = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Jolli Memory: Generating commit message…",
					cancellable: false,
				},
				() => this.bridge.generateCommitMessage(),
			);
			log.info("commit", "Commit message generated", { generatedMessage });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("commit", `Failed to generate commit message: ${message}`, err);
			vscode.window.showErrorMessage(
				`Jolli Memory: Failed to generate commit message: ${message}`,
			);
			await this.restoreIndex(originalIndexTree);
			return;
		}

		// Step 4: Show QuickPick at top of screen
		log.info("commit", "Showing QuickPick");
		const selected = await this.showCommitQuickPick(generatedMessage);
		if (!selected) {
			log.info("commit", "QuickPick cancelled by user — restoring index");
			await this.restoreIndex(originalIndexTree);
			return;
		}

		// Step 5: Re-stage selected files to capture any edits made during message
		// generation or QuickPick review, then execute the selected action.
		try {
			await this.bridge.stageFiles(selectedPaths);
			log.info(
				"commit",
				`Re-staged ${selectedPaths.length} file(s) before commit`,
			);
			log.info("commit", `Executing action: ${selected.item.label}`, {
				message: selected.message,
			});
			await this.executeCommitAction(selected.item, selected.message);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("commit", `Commit action failed: ${message}`, err);
			vscode.window.showErrorMessage(`Jolli Memory: Commit failed: ${message}`);
			await this.restoreIndex(originalIndexTree);
			return;
		}

		// Step 6: Re-stage any files that were staged before the commit flow but
		// were not part of this commit (preserves mixed-workflow staging).
		const selectedPathSet = new Set(selectedPaths);
		const remainingStagedPaths = originalStagedPaths.filter(
			(p) => !selectedPathSet.has(p),
		);
		if (remainingStagedPaths.length > 0) {
			try {
				await this.bridge.stageFiles(remainingStagedPaths);
				log.info(
					"commit",
					`Re-staged ${remainingStagedPaths.length} previously-staged file(s) not in this commit`,
				);
			} catch (err: unknown) {
				log.warn(
					"commit",
					`Failed to re-stage previously-staged files: ${err}`,
				);
				vscode.window.showWarningMessage(
					"Jolli Memory: Some previously-staged files could not be re-staged. You may need to re-stage them manually.",
				);
			}
		}

		// Step 7: Show success and refresh all panels
		log.info("commit", "Success — committed");
		vscode.window.showInformationMessage(
			"Jolli Memory: Successfully committed. post-commit hook is generating a summary in the background.",
		);

		await this.refreshAll();
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	/**
	 * Restores the git index to the exact state captured by saveIndexTree().
	 * Preserves partial-hunk staging, intent-to-add entries, and mode-only changes.
	 */
	private async restoreIndex(indexTreeSha: string): Promise<void> {
		try {
			await this.bridge.restoreIndexTree(indexTreeSha);
			log.info("commit", "Index restored from tree snapshot");
		} catch (err: unknown) {
			log.error("commit", `Failed to restore index: ${err}`);
			vscode.window.showWarningMessage(
				"Jolli Memory: Failed to restore the git index — you may need to re-stage files manually.",
			);
		}
	}

	private showCommitQuickPick(
		generatedMessage: string,
	): Promise<{ item: vscode.QuickPickItem; message: string } | undefined> {
		return new Promise((resolve) => {
			const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
			qp.value = generatedMessage;
			qp.title = DEFAULT_TITLE;
			qp.placeholder = "Edit the commit message, then select an action";
			qp.items = [ITEM_COMMIT, ITEM_AMEND, ITEM_AMEND_NO_EDIT];

			// Disable filtering so the input text is used as a free-form commit
			// message, not as a filter query. Without this, the commit message
			// text would filter items by label — leaving no active items and
			// causing Enter (onDidAccept) to never fire.
			qp.matchOnLabel = false;
			qp.matchOnDescription = false;
			qp.matchOnDetail = false;

			// Update title dynamically when the user highlights a different action
			qp.onDidChangeActive((active) => {
				qp.title =
					active[0] === ITEM_AMEND_NO_EDIT
						? AMEND_NO_EDIT_TITLE
						: DEFAULT_TITLE;
			});

			log.debug("quickpick", "Commit QuickPick shown", {
				value: generatedMessage,
			});

			// Guard: resolve must happen BEFORE dispose, because dispose()
			// synchronously fires onDidHide which would resolve(undefined) first.
			let accepted = false;

			qp.onDidAccept(() => {
				accepted = true;
				const selected = qp.selectedItems[0] ?? qp.items[0];
				const message = qp.value.trim();
				log.info("quickpick", "Accept triggered", {
					selectedLabel: selected.label,
					messageLength: message.length,
				});
				if (!message && selected !== ITEM_AMEND_NO_EDIT) {
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
				log.debug("quickpick", "QuickPick hidden (dismissed)");
				qp.dispose();
				resolve(undefined);
			});

			qp.show();
		});
	}

	private async executeCommitAction(
		item: vscode.QuickPickItem,
		message: string,
	): Promise<void> {
		if (item === ITEM_AMEND || item === ITEM_AMEND_NO_EDIT) {
			// Check if HEAD is pushed BEFORE amend (hash changes after amend)
			const wasPushed = await this.bridge.isHeadPushed().catch(() => false);
			const headBeforeAmend = await this.bridge.getHEADHash().catch(() => "");
			log.info("commit", "Amend preflight", {
				headBeforeAmend: headBeforeAmend
					? headBeforeAmend.substring(0, 8)
					: undefined,
				wasPushed,
				keepMessage: item === ITEM_AMEND_NO_EDIT,
				historySelection: this.historyProvider.getSelectionDebugInfo(),
			});

			if (item === ITEM_AMEND_NO_EDIT) {
				await this.bridge.amendCommitNoEdit();
			} else {
				await this.bridge.amendCommit(message);
			}

			const headAfterAmend = await this.bridge.getHEADHash().catch(() => "");
			log.info("commit", "Amend completed", {
				headBeforeAmend: headBeforeAmend
					? headBeforeAmend.substring(0, 8)
					: undefined,
				headAfterAmend: headAfterAmend
					? headAfterAmend.substring(0, 8)
					: undefined,
				historySelection: this.historyProvider.getSelectionDebugInfo(),
			});

			if (wasPushed) {
				vscode.window.showInformationMessage(
					"Commit amended. The original was already pushed — you'll need to force push to update the remote.",
				);
			}
		} else {
			await this.bridge.commit(message);
		}
	}

	private async refreshAll(): Promise<void> {
		log.debug("commit", "refreshAll() start", {
			historySelection: this.historyProvider.getSelectionDebugInfo(),
		});
		await Promise.all([
			this.filesProvider.refresh(),
			this.historyProvider.refresh(),
			this.statusProvider.refresh(),
		]);

		// Update status bar with fresh data
		const status = await this.bridge.getStatus();
		this.statusBar.update(status.enabled);
		log.debug("commit", "refreshAll() complete", {
			headHash: (
				(await this.bridge.getHEADHash().catch(() => "")) || undefined
			)?.substring(0, 8),
			historySelection: this.historyProvider.getSelectionDebugInfo(),
		});
	}
}
