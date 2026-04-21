/**
 * StatusBarManager
 *
 * Manages the bottom status bar item for Jolli Memory.
 * Shows: [✓ Jolli Memory] when enabled, [○ Jolli Memory (disabled)] when disabled.
 * Branch and staged count are not shown — VSCode's built-in Source Control
 * status bar already provides that information.
 */

import * as vscode from "vscode";

export class StatusBarManager {
	private readonly item: vscode.StatusBarItem;

	constructor() {
		this.item = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			100,
		);
		this.item.command = "jollimemory.focusSidebar";
		this.item.tooltip = "Jolli Memory — click to open sidebar";
		this.item.show();
	}

	/** Updates the status bar to reflect whether Jolli Memory is enabled. */
	update(enabled: boolean): void {
		if (!enabled) {
			this.item.text = "$(circle-outline) Jolli Memory (disabled)";
			this.item.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.warningBackground",
			);
			this.item.color = undefined;
			return;
		}

		this.item.text = "Jolli Memory";
		this.item.backgroundColor = undefined;
		this.item.color = undefined;
	}

	/** Disposes the status bar item. */
	dispose(): void {
		this.item.dispose();
	}
}
