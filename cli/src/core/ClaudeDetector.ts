/**
 * Claude Detector
 *
 * Detects Claude Code presence by checking for the ~/.claude/ directory.
 * Used by the Installer and status command to report Claude CLI integration state.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Base directory name for Claude Code data */
const CLAUDE_DIR_NAME = ".claude";

/**
 * Checks whether the Claude Code data directory exists.
 * Used by the Installer to detect Claude Code presence.
 */
export async function isClaudeInstalled(): Promise<boolean> {
	const claudeDir = join(homedir(), CLAUDE_DIR_NAME);
	try {
		const dirStat = await stat(claudeDir);
		return dirStat.isDirectory();
	} catch {
		return false;
	}
}
