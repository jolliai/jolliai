/**
 * LockUtils.ts — Shared lock file utilities for the JolliMemory VSCode extension.
 *
 * The post-commit Worker holds `.jolli/jollimemory/worker.lock` while running
 * the LLM summarization pipeline (~20-40s). These helpers let the extension and
 * command classes check the lock state to prevent race conditions
 * (Commit / Squash are gated on it). Push is intentionally NOT gated: it only
 * runs `git push` on the current branch and shares no state with the worker.
 *
 * Notes on the lock split:
 *   - `worker.lock` is the QueueWorker's "I'm draining the queue" marker; this
 *     is the file we watch here.
 *   - The sibling `orphan-write.lock` is a short-lived (millisecond-scale)
 *     mutex around individual orphan-branch writes; it is irrelevant to the
 *     worker-busy state and intentionally not surfaced.
 *   - Pre-split, both roles shared a single `lock` file. Watching that path
 *     after the split would silently always return false — which is why this
 *     module is updated in lockstep with `Locks.ts`.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

/** Lock timeout matches `LOCK_TIMEOUT_MS` in cli/src/core/Locks.ts (5 minutes). */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Returns true if the JolliMemory worker lock file exists and is not stale.
 * A lock older than 5 minutes is considered stale (crashed worker).
 */
export async function isWorkerBusy(cwd: string): Promise<boolean> {
	try {
		const lockStat = await stat(
			join(cwd, ".jolli", "jollimemory", "worker.lock"),
		);
		const ageMs = Date.now() - lockStat.mtimeMs;
		return ageMs < LOCK_TIMEOUT_MS;
	} catch {
		return false;
	}
}
