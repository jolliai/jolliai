/**
 * VS Code Copilot Chat detector.
 *
 * Returns true when EITHER of the two Copilot Chat data roots exist:
 *   - <userDataDir>/User/globalStorage/github.copilot-chat (Copilot Chat extension installed)
 *   - ~/.copilot/session-state                              (Copilot CLI agent backend on disk)
 *
 * Either root can carry chat panel "New Chat" session data; chat-panel sessions
 * with copilotcli-backend models write to the latter (events.jsonl), and
 * sessions with other-vendor models write to chatSessions/<sid>.jsonl under
 * the former's parent workspace storage tree.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { getVscodeUserDataDir } from "./VscodeWorkspaceLocator.js";

const log = createLogger("CopilotChatDetector");

/** Returns vscode's globalStorage/github.copilot-chat directory path. */
export function getCopilotChatStorageDir(home?: string): string {
	return join(getVscodeUserDataDir("Code", home), "User", "globalStorage", "github.copilot-chat");
}

/** Returns ~/.copilot/session-state directory path (Copilot CLI agent backend). */
export function getCopilotCliSessionStateDir(home: string = homedir()): string {
	return join(home, ".copilot", "session-state");
}

async function existsAsDir(path: string): Promise<boolean> {
	try {
		const fileStat = await stat(path);
		return fileStat.isDirectory();
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn(
				"Copilot Chat probe stat failed for %s (%s): %s",
				path,
				code ?? "unknown",
				(error as Error).message,
			);
		}
		return false;
	}
}

/**
 * Returns true when either of the two known Copilot Chat data roots exists.
 * Returns false on ENOENT or non-directory state for both.
 */
export async function isCopilotChatInstalled(): Promise<boolean> {
	const [globalStorage, sessionState] = await Promise.all([
		existsAsDir(getCopilotChatStorageDir()),
		existsAsDir(getCopilotCliSessionStateDir()),
	]);
	return globalStorage || sessionState;
}
