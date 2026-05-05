/**
 * Cursor Detector
 *
 * Detects Cursor presence by checking for its global state database.
 * Used at install time and by getStatus() to report Cursor integration state.
 *
 * Per-platform database paths:
 *   darwin  ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   linux   ~/.config/Cursor/User/globalStorage/state.vscdb
 *   win32   %APPDATA%/Cursor/User/globalStorage/state.vscdb
 *
 * Detection is gated on hasNodeSqliteSupport() so VS Code extension hosts
 * running Node 18 report "not installed" rather than "detected but unreadable".
 */

import { stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { hasNodeSqliteSupport } from "./SqliteHelpers.js";

const log = createLogger("CursorDetector");

/**
 * Returns the Cursor user-data root directory for the current platform.
 * Matches the paths used by the VS Code-based Cursor editor.
 */
function getCursorUserDataDir(home: string = homedir()): string {
	switch (platform()) {
		case "darwin":
			return join(home, "Library", "Application Support", "Cursor");
		case "win32":
			return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor");
		default:
			// linux and other unix-like systems
			return join(home, ".config", "Cursor");
	}
}

/**
 * Returns the path to Cursor's global state database.
 * Readable via node:sqlite; contains extension state, workspace history, etc.
 */
export function getCursorGlobalDbPath(home?: string): string {
	return join(getCursorUserDataDir(home), "User", "globalStorage", "state.vscdb");
}

/**
 * Returns the path to Cursor's workspace storage directory.
 * Each workspace gets a hashed subdirectory containing a state.vscdb.
 * Used by CursorSessionDiscoverer to enumerate per-project sessions.
 */
export function getCursorWorkspaceStorageDir(home?: string): string {
	return join(getCursorUserDataDir(home), "User", "workspaceStorage");
}

/**
 * Checks whether Cursor is installed AND the current runtime can read its DB.
 *
 * Returns false when node:sqlite is unavailable (VS Code extension hosts on
 * Node 18) so the UI does not render "Cursor detected & enabled (0 sessions)"
 * on runtimes where a scan would always fail.
 */
export async function isCursorInstalled(): Promise<boolean> {
	if (!hasNodeSqliteSupport()) {
		// Expected "not applicable", not a failure — log at info so operators
		// can correlate "Cursor absent from status" with the runtime version.
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
