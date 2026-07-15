import * as vscode from "vscode";
import { track } from "../../../cli/src/core/Telemetry.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { buildBranchRecallPrompt } from "../views/BranchRecall.js";

const EMPTY_MSG = "No Jolli Memory records on this branch yet.";
const DETACHED_HEAD_MSG = "Detached HEAD — switch to a branch to recall its memory.";

/**
 * Resolves the current branch, guarding against detached HEAD.
 *
 * `bridge.getCurrentBranch()` returns the literal "HEAD" when the repo is in a
 * detached-HEAD state (e.g. checked out to a tag or raw commit). Feeding "HEAD"
 * into {@link buildBranchRecallPrompt} compiles an empty/wrong context with no
 * indication that the user simply isn't on a branch. Returns null after showing
 * a clear message so callers abort rather than building bogus context.
 */
async function resolveRecallBranch(bridge: JolliMemoryBridge): Promise<string | null> {
	const branch = await bridge.getCurrentBranch();
	if (branch === "HEAD") {
		await vscode.window.showInformationMessage(DETACHED_HEAD_MSG);
		return null;
	}
	return branch;
}

export async function runRecallInClaudeCode(bridge: JolliMemoryBridge, cwd: string): Promise<void> {
	const branch = await resolveRecallBranch(bridge);
	if (branch === null) {
		return;
	}
	const { prompt, commitCount } = await buildBranchRecallPrompt(cwd, branch);
	if (commitCount === 0) {
		await vscode.window.showInformationMessage(EMPTY_MSG);
		return;
	}
	const uri = vscode.Uri.parse(`vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`);
	await vscode.env.openExternal(uri);
}

export async function runCopyBranchRecallPrompt(bridge: JolliMemoryBridge, cwd: string): Promise<void> {
	const branch = await resolveRecallBranch(bridge);
	if (branch === null) {
		return;
	}
	const { prompt, commitCount } = await buildBranchRecallPrompt(cwd, branch);
	if (commitCount === 0) {
		await vscode.window.showInformationMessage(EMPTY_MSG);
		return;
	}
	await vscode.env.clipboard.writeText(prompt);
	// JOLLI-1904: recall prompt copied to clipboard (mirrors IntelliJ; no props).
	track("recall_prompt_copied");
	await vscode.window.showInformationMessage("Recall prompt copied — paste it into Codex, Cursor, or any AI tool.");
}
