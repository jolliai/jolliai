import * as vscode from "vscode";
import { GLOBAL_INSTRUCTIONS_PROMPT } from "../../../cli/src/install/GlobalInstructionsInstaller.js";
import { loadConfig, saveConfig } from "../../../cli/src/core/SessionTracker.js";

/**
 * True once the user has dismissed the notification (Not now / X / timeout) this
 * VS Code session. Keeps the switch undecided but suppresses re-prompting until the
 * window reloads. Module-level so it lives for the extension-host session.
 */
let dismissedThisSession = false;

/** Test-only: reset the session-dismiss flag between cases. */
export function resetGlobalInstructionsSessionFlagForTests(): void {
	dismissedThisSession = false;
}

/**
 * When the global-instructions switch is still undecided (and not dismissed this
 * session), show a benefit-led notification. On "Add" persist "enabled" and re-run
 * the idempotent enable so the block is written now; on "Never" persist "disabled";
 * on dismiss leave it undecided and suppress re-prompting for this session.
 *
 * Shares GLOBAL_INSTRUCTIONS_PROMPT with the CLI so the wording cannot drift.
 */
export async function maybePromptGlobalInstructions(bridge: {
	enable: () => Promise<{ success: boolean; message: string }>;
}): Promise<void> {
	if (dismissedThisSession) return;
	const cfg = await loadConfig();
	if (cfg.globalInstructions !== undefined) return;

	const ADD = "Add";
	const NEVER = "Never";
	const choice = await vscode.window.showInformationMessage(GLOBAL_INSTRUCTIONS_PROMPT, ADD, "Not now", NEVER);

	if (choice === ADD) {
		await saveConfig({ globalInstructions: "enabled" });
		await bridge.enable();
	} else if (choice === NEVER) {
		await saveConfig({ globalInstructions: "disabled" });
	} else {
		dismissedThisSession = true;
	}
}
