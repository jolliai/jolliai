/**
 * LockUtils.ts — Shared lock file utilities for the JolliMemory VSCode extension.
 *
 * The post-commit Worker holds `.jolli/jollimemory/lock` while running the
 * LLM summarization pipeline (~20-40s). These helpers let the extension and
 * command classes check the lock state to prevent race conditions.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

/** Lock timeout matches SessionTracker.LOCK_TIMEOUT_MS (5 minutes). */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Returns true if the JolliMemory worker lock file exists and is not stale.
 * A lock older than 5 minutes is considered stale (crashed worker).
 */
export async function isWorkerBusy(cwd: string): Promise<boolean> {
	try {
		const lockStat = await stat(join(cwd, ".jolli", "jollimemory", "lock"));
		const ageMs = Date.now() - lockStat.mtimeMs;
		return ageMs < LOCK_TIMEOUT_MS;
	} catch {
		return false;
	}
}
