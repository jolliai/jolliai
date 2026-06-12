/**
 * LockUtils.ts — Shared lock file utilities for the JolliMemory VSCode extension.
 *
 * The post-commit Worker holds `.jolli/jollimemory/worker.lock` while running
 * the LLM summarization pipeline (~20-40s). These helpers let the extension and
 * command classes check the lock state to prevent race conditions
 * (Commit / Squash are gated on it — via `isWorkerBlockingBusy`, which exempts
 * the ingest phase). Push is intentionally NOT gated: it only runs `git push`
 * on the current branch and shares no state with the worker.
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

import { readFile, stat } from "node:fs/promises";
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

/**
 * Returns true only when the worker is busy with a phase that must block user
 * git actions (Commit / Squash). The topic-KB ingest phase is exempt: it only
 * reads already-stored summaries and renders the Memory Bank wiki, never the
 * code branch or the commit pipeline, so blocking commit/squash for its
 * ~80s+ duration is pure UX damage. Any git op landed during ingest is simply
 * enqueued and drained by the chain-spawned successor worker.
 *
 * The phase comes from the cosmetic `worker-phase` marker the QueueWorker
 * writes next to `worker.lock` (see WORKER_PHASE_FILE in cli/src/core/Locks.ts).
 * A missing/unreadable marker means the default summary phase → blocking.
 */
export async function isWorkerBlockingBusy(cwd: string): Promise<boolean> {
	if (!(await isWorkerBusy(cwd))) {
		return false;
	}
	return (await readWorkerPhase(cwd)) !== "ingest";
}

async function readWorkerPhase(cwd: string): Promise<string | null> {
	try {
		const content = await readFile(
			join(cwd, ".jolli", "jollimemory", "worker-phase"),
			"utf-8",
		);
		return content.trim();
	} catch {
		return null;
	}
}
