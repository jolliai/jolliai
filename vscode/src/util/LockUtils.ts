/**
 * LockUtils.ts — Shared lock file utilities for the JolliMemory VSCode extension.
 *
 * The post-commit Worker holds `.jolli/jollimemory/worker.lock` while running
 * the LLM summarization pipeline (~20-40s). These helpers let the extension and
 * command classes check the lock state to prevent race conditions (Commit /
 * Squash are gated on `isWorkerBusy`). Push is intentionally NOT gated: it only
 * runs `git push` on the current branch and shares no state with the worker.
 *
 * Ingest runs under its own `ingest.lock`, so `worker.lock` is held ONLY during
 * summary generation and the gate is a plain `isWorkerBusy` — there is no
 * "exempt the ingest phase" logic, because ingest can never hold `worker.lock`.
 * The ingest phase drives only the cosmetic sidebar pill, via `readIngestPhase`
 * below (the `ingest-phase` file + `ingest.lock` liveness backstop).
 *
 * Notes on the lock split:
 *   - `worker.lock` is the QueueWorker's "I'm draining summaries" marker.
 *   - `ingest.lock` is the QueueWorker's "I'm running wiki/graph ingest" marker.
 *   - The sibling `orphan-write.lock` is a short-lived (millisecond-scale) mutex
 *     around individual orphan-branch writes; irrelevant to busy state.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Lock timeout matches `LOCK_TIMEOUT_MS` in cli/src/core/Locks.ts (5 minutes).
 * Doubles as the freshness window for the cosmetic `ingest-phase` file: the
 * worker heartbeats both `ingest.lock` and the `ingest-phase` file every 60 s
 * (WORKER_LOCK_REFRESH_INTERVAL_MS in QueueWorker), so the same 5× margin
 * applies to all three files.
 */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

function jolliMemoryFile(cwd: string, name: string): string {
	return join(cwd, ".jolli", "jollimemory", name);
}

async function isFileFresh(path: string): Promise<boolean> {
	try {
		const st = await stat(path);
		return Date.now() - st.mtimeMs < LOCK_TIMEOUT_MS;
	} catch {
		return false;
	}
}

/**
 * Returns true if the JolliMemory worker lock file exists and is not stale.
 * A lock older than 5 minutes is considered stale (crashed worker). This is the
 * sole gate for Commit / Squash: `worker.lock` is held only during summary
 * generation (ingest has its own `ingest.lock`).
 */
export async function isWorkerBusy(cwd: string): Promise<boolean> {
	return isFileFresh(jolliMemoryFile(cwd, "worker.lock"));
}

/** Cosmetic ingest sub-phase for the sidebar pill; null when no ingest is live. */
export type IngestPhaseLabel = "wiki" | "graph" | null;

/**
 * Reads the cosmetic ingest display state from the `ingest-phase` file, with
 * `ingest.lock` freshness as a liveness backstop (a phase file that missed a
 * heartbeat but whose ingest is still alive should keep the pill).
 *
 * Returns `busy: true` only while an ingest is genuinely in flight — either the
 * phase file OR `ingest.lock` is fresh. `phase` is derived from the file's full
 * value (`ingest:graph` → "graph", otherwise "wiki"), defaulting to "wiki" when
 * the lock is fresh but the phase file is momentarily missing/stale.
 */
export async function readIngestPhase(cwd: string): Promise<{ busy: boolean; phase: IngestPhaseLabel }> {
	const phasePath = jolliMemoryFile(cwd, "ingest-phase");
	const lockFresh = await isFileFresh(jolliMemoryFile(cwd, "ingest.lock"));
	let content = "";
	let phaseFresh = false;
	try {
		content = (await readFile(phasePath, "utf-8")).trim();
		phaseFresh = await isFileFresh(phasePath);
	} catch {
		// No phase file — fall back to lock liveness below.
	}
	if (!phaseFresh && !lockFresh) return { busy: false, phase: null };
	if (phaseFresh && content.indexOf("ingest") !== 0) return { busy: false, phase: null };
	return { busy: true, phase: content.indexOf("ingest:graph") === 0 ? "graph" : "wiki" };
}
