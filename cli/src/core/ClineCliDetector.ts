import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Cline CLI data root: <home>/.cline/data (home-relative on all platforms). */
export function getClineCliDataDir(home: string = homedir()): string {
	return join(home, ".cline", "data");
}

/** Per-session directory root: <dataDir>/sessions. */
export function getClineCliSessionsDir(home: string = homedir()): string {
	return join(getClineCliDataDir(home), "sessions");
}

/**
 * Detected when the sessions/ dir exists. No node:sqlite gate — the CLI
 * discoverer reads plain JSON sidecars, never the WAL-mode sessions.db.
 */
export async function isClineCliInstalled(home: string = homedir()): Promise<boolean> {
	try {
		await access(getClineCliSessionsDir(home));
		return true;
	} catch {
		return false;
	}
}
