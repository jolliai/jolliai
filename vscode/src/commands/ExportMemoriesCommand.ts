/**
 * ExportMemoriesCommand
 *
 * Exports all memories for the current workspace as markdown files under
 * ~/Documents/jollimemory/<project>/ (via SummaryExporter in the core library).
 *
 * Flow:
 * 1. Show a progress notification while the export runs.
 * 2. On success, show an info notification with counts. If anything was
 *    written or skipped, include an "Open folder" action that reveals the
 *    output directory in the OS file explorer.
 * 3. On error, show an error notification with the error message.
 */

import * as vscode from "vscode";
import type { ExportResult } from "../../../cli/src/core/SummaryExporter.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { log } from "../util/Logger.js";

const OPEN_FOLDER_LABEL = "Open folder";

export class ExportMemoriesCommand {
	constructor(private readonly bridge: JolliMemoryBridge) {}

	async execute(): Promise<void> {
		try {
			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Exporting memories…",
				},
				() => this.bridge.exportMemories(),
			);
			await this.presentResult(result);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("exportMemories", `Export failed: ${message}`, err);
			await vscode.window.showErrorMessage(
				`Jolli Memory: Export failed: ${message}`,
			);
		}
	}

	/**
	 * Surfaces the export result to the user, branching on the four possible states:
	 *
	 *   1. Nothing processed         (written=0, skipped=0, errored=0) → info, no action
	 *   2. Clean success             (errored=0)                        → info + "Open folder"
	 *   3. Partial failure           (errored>0, written>0)             → warning + "Open folder"
	 *   4. Total failure             (errored>0, written=0)             → error, no action
	 *
	 * Partial failure keeps the "Open folder" action because real new files landed on disk
	 * and the user should be able to inspect them. Total failure withholds the action
	 * because nothing from this run is new — offering the folder would imply progress
	 * that didn't happen.
	 */
	private async presentResult(result: ExportResult): Promise<void> {
		// Case 1: nothing processed.
		if (
			result.filesWritten === 0 &&
			result.filesSkipped === 0 &&
			result.filesErrored === 0
		) {
			await vscode.window.showInformationMessage(
				"Jolli Memory: No memories to export yet.",
			);
			return;
		}

		// Case 4: total failure — every write errored, nothing new on disk.
		if (result.filesErrored > 0 && result.filesWritten === 0) {
			const message = `Jolli Memory: Export failed — ${result.filesErrored} failed (${result.filesSkipped} already on disk).`;
			log.error("exportMemories", message);
			await vscode.window.showErrorMessage(message);
			return;
		}

		// Cases 2 and 3 both land files on disk, so both offer "Open folder".
		// Case 3 uses a warning toast so the user cannot miss the partial failure.
		const successMessage =
			result.filesErrored === 0
				? `Jolli Memory: Exported ${result.filesWritten} new memories (${result.filesSkipped} skipped). Total: ${result.totalSummaries}.`
				: `Jolli Memory: Exported ${result.filesWritten} new memories, ${result.filesErrored} failed (${result.filesSkipped} skipped).`;

		if (result.filesErrored > 0) {
			log.error("exportMemories", successMessage);
		}

		const show =
			result.filesErrored > 0
				? vscode.window.showWarningMessage
				: vscode.window.showInformationMessage;
		const selection = await show(successMessage, OPEN_FOLDER_LABEL);
		if (selection === OPEN_FOLDER_LABEL) {
			// Use openExternal (not revealFileInOS) for directories: the former
			// opens the folder to show its contents, the latter selects the folder
			// inside its parent (open -R / explorer /select).
			await vscode.env.openExternal(vscode.Uri.file(result.outputDir));
		}
	}
}
