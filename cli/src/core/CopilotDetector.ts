/**
 * GitHub Copilot CLI detector.
 *
 * Copilot CLI stores conversations in ~/.copilot/session-store.db (SQLite, WAL).
 * We read the DB via node:sqlite — pure-JS SQLite libraries cannot see WAL data.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { hasNodeSqliteSupport, NODE_SQLITE_MIN_VERSION } from "./SqliteHelpers.js";

const log = createLogger("CopilotDetector");

/** Returns the absolute path to Copilot CLI's session-store database. */
export function getCopilotDbPath(): string {
	return join(homedir(), ".copilot", "session-store.db");
}

/**
 * Returns true when Copilot CLI's session DB is present *and* the current
 * runtime can read it. Mirrors `isOpenCodeInstalled`'s shape.
 */
export async function isCopilotInstalled(): Promise<boolean> {
	if (!hasNodeSqliteSupport()) {
		log.info(
			"Copilot CLI support disabled: this runtime is Node %s, requires %d.%d+ for built-in SQLite",
			process.versions.node,
			NODE_SQLITE_MIN_VERSION.major,
			NODE_SQLITE_MIN_VERSION.minor,
		);
		return false;
	}
	return isCopilotPresent();
}

/**
 * Pure filesystem presence check: is Copilot CLI's session DB on disk,
 * regardless of whether THIS runtime can read it? Unlike `isCopilotInstalled`,
 * this does NOT gate on `hasNodeSqliteSupport()`. Used for MCP registration,
 * which only writes a config file and never reads the DB — so it must work on a
 * runtime below the Node floor, where the SQLite gate would otherwise suppress
 * a host that is genuinely installed.
 */
export async function isCopilotPresent(): Promise<boolean> {
	const dbPath = getCopilotDbPath();
	try {
		const fileStat = await stat(dbPath);
		return fileStat.isFile();
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Copilot DB stat failed (%s): %s", code ?? "unknown", (error as Error).message);
		}
		return false;
	}
}
