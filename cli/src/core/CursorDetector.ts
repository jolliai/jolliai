/**
 * Cursor Detector
 *
 * Detects Cursor presence by checking for its global state database. Path
 * resolution delegates to VscodeWorkspaceLocator with `flavor: "Cursor"` —
 * shared with VS Code Copilot Chat (`flavor: "Code"`).
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { hasNodeSqliteSupport } from "./SqliteHelpers.js";
import { getVscodeUserDataDir, getVscodeWorkspaceStorageDir } from "./VscodeWorkspaceLocator.js";

const log = createLogger("CursorDetector");

/** Returns the path to Cursor's global state database. */
export function getCursorGlobalDbPath(home?: string): string {
	return join(getVscodeUserDataDir("Cursor", home), "User", "globalStorage", "state.vscdb");
}

/** Returns the path to Cursor's workspace storage directory. */
export function getCursorWorkspaceStorageDir(home?: string): string {
	return getVscodeWorkspaceStorageDir("Cursor", home);
}

/**
 * Checks whether Cursor is installed AND the current runtime can read its DB.
 *
 * Gated on hasNodeSqliteSupport() so VS Code-extension Node 18 hosts report
 * "not installed" rather than "detected but 0 sessions" — the latter is
 * misleading because a scan would always fail on those runtimes.
 */
export async function isCursorInstalled(): Promise<boolean> {
	if (!hasNodeSqliteSupport()) {
		// "Not applicable on this runtime" rather than a failure — log at info so
		// operators can correlate "Cursor absent from status" with the runtime version.
		log.info(
			"Cursor support disabled: this runtime is Node %s, requires 22.5+ for built-in SQLite",
			process.versions.node,
		);
		return false;
	}
	const dbPath = getCursorGlobalDbPath();
	try {
		const fileStat = await stat(dbPath);
		return fileStat.isFile();
	} catch {
		return false;
	}
}
