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

/**
 * Lock timeout matches `LOCK_TIMEOUT_MS` in cli/src/core/Locks.ts (5 minutes).
 * Doubles as the freshness window for the `worker-phase` marker: the worker
 * heartbeats both `worker.lock` and an active `ingest` marker every 60 s
 * (WORKER_LOCK_REFRESH_INTERVAL_MS in QueueWorker), so the same 5× margin
 * applies to both files.
 */
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
 * ~80s+ duration is pure UX damage. Any git op landed during ingest is queued
 * and drained right after the ingest entry — usually by the SAME worker, in
 * the same lock hold (the drain loop re-dequeues between entries; a
 * chain-spawned successor only covers ops that land after the drain exits).
 * That is why callers with a long user interaction between the gate check and
 * the actual git op (Commit/Squash: LLM message generation + QuickPick) must
 * re-check this gate immediately before executing.
 *
 * The phase comes from the `worker-phase` marker the QueueWorker writes next
 * to `worker.lock` (see WORKER_PHASE_FILE in cli/src/core/Locks.ts). A
 * missing/unreadable marker means the default summary phase → blocking. An
 * `ingest` marker is honoured only while its mtime is fresh: the worker
 * heartbeats the marker during a genuine ingest, so a stale one is residue
 * from a failed cleanup and the run in progress may well be a blocking
 * summary — treat it as such (fail-safe).
 */
export async function isWorkerBlockingBusy(cwd: string): Promise<boolean> {
	if (!(await isWorkerBusy(cwd))) {
		return false;
	}
	return !(await isFreshIngestPhase(cwd));
}

async function isFreshIngestPhase(cwd: string): Promise<boolean> {
	const phasePath = join(cwd, ".jolli", "jollimemory", "worker-phase");
	try {
		const content = await readFile(phasePath, "utf-8");
		if (content.trim() !== "ingest") {
			return false;
		}
		const phaseStat = await stat(phasePath);
		return Date.now() - phaseStat.mtimeMs < LOCK_TIMEOUT_MS;
	} catch {
		return false;
	}
}
