/**
 * Gemini Session Detector
 *
 * Utility functions for detecting Gemini presence on the system.
 * Unlike Codex (which requires filesystem discovery at commit time),
 * Gemini sessions are tracked via the AfterAgent hook. This module
 * only provides detection helpers used by the Installer and status command.
 *
 * Gemini stores data at: ~/.gemini/
 * Project sessions live at: ~/.gemini/tmp/<sha256(projectRoot)>/chats/
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";

const log = createLogger("GeminiDetector");

/** Base directory name for Gemini data */
const GEMINI_DIR_NAME = ".gemini";

/**
 * Checks whether the Gemini data directory exists.
 * Used by the Installer to detect Gemini presence.
 */
export async function isGeminiInstalled(): Promise<boolean> {
	const geminiDir = join(homedir(), GEMINI_DIR_NAME);
	try {
		const dirStat = await stat(geminiDir);
		return dirStat.isDirectory();
	} catch {
		log.debug("Gemini directory not found: %s", geminiDir);
		return false;
	}
}
