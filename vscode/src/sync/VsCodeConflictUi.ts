/**
 * VS Code-side conflict UI for the Tier 3 binary-pick.
 *
 * Uses `window.showQuickPick` so the user gets a focusable picker that
 * stays open until they choose ("ignoreFocusOut: true"). `viewDiff` opens
 * VS Code's native diff editor against in-memory blobs surfaced through
 * an untitled-document scheme; this is read-only — the user never edits
 * the conflict text by hand (matches source plan §11 "user永不手工合并文本").
 */

import * as vscode from "vscode";
import type {
	ConflictUi,
	Tier3Pick,
} from "../../../cli/src/sync/ConflictResolver.js";

const QUICK_PICK_LABELS = {
	mine: "$(check) Use my edit",
	theirs: "$(cloud-download) Use remote version",
	viewDiff: "$(diff) View diff",
	skip: "$(close) Skip — resolve later",
} as const;

type PickKey = keyof typeof QUICK_PICK_LABELS;

export class VsCodeConflictUi implements ConflictUi {
	async promptBinaryPick(
		path: string,
		_oursOid: string | null,
		_theirsOid: string | null,
	): Promise<Tier3Pick> {
		const items: Array<vscode.QuickPickItem & { key: PickKey }> = [
			{
				label: QUICK_PICK_LABELS.mine,
				key: "mine",
				description: "keep your local edit",
			},
			{
				label: QUICK_PICK_LABELS.theirs,
				key: "theirs",
				description: "discard yours, take remote",
			},
			{
				label: QUICK_PICK_LABELS.viewDiff,
				key: "viewDiff",
				description: "open side-by-side diff",
			},
			{
				label: QUICK_PICK_LABELS.skip,
				key: "skip",
				description: "leave conflict for next round",
			},
		];

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: `Memory Bank conflict in ${path}`,
			ignoreFocusOut: true,
			title: "Resolve sync conflict",
		});

		if (!picked) return "skip";
		return picked.key;
	}

	async showDiff(path: string, ours: string, theirs: string): Promise<void> {
		const oursDoc = await vscode.workspace.openTextDocument({
			content: ours,
			language: "markdown",
		});
		const theirsDoc = await vscode.workspace.openTextDocument({
			content: theirs,
			language: "markdown",
		});
		await vscode.commands.executeCommand(
			"vscode.diff",
			oursDoc.uri,
			theirsDoc.uri,
			`${path} — mine ↔ remote`,
			{ preview: true } satisfies vscode.TextDocumentShowOptions,
		);
	}
}
