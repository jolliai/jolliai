/**
 * QueueStatus — a single verdict on whether memory-summary generation is still
 * in progress for a worktree, plus a bounded wait loop.
 *
 * `drained` is decided by two axes only: (1) no non-ingest queue entries remain,
 * and (2) the worker is not blocking-busy (not mid-summary). Wiki/graph ingest
 * entries and the ingest worker phase are intentionally excluded so the PR-wait
 * path never blocks on Memory Bank wiki rendering. The other fields are
 * informational (debugging / progress messaging).
 */

import { getWorkerBusyState } from "./Locks.js";
import { countActiveQueueEntriesByKind, countStaleQueueEntries } from "./SessionTracker.js";

export interface QueueStatus {
	/** Non-stale queue entries that produce a summary (ingest excluded). */
	active: number;
	/** Non-stale ingest (wiki/graph) entries — informational. */
	ingestActive: number;
	/** worker.lock held, any phase — informational. */
	workerBusy: boolean;
	/** worker.lock held AND not a fresh ingest phase (a summary is in flight). */
	workerBlocking: boolean;
	/** active === 0 && !workerBlocking. */
	drained: boolean;
	/** Stale (age > 7d) entries lingering in the queue — informational. */
	stale: number;
}

export const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 120_000;
export const DEFAULT_QUEUE_WAIT_POLL_MS = 1_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for a real, finite, non-negative number — rejects NaN/Infinity/undefined. */
function isFiniteNonNegative(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Reads the current queue/worker state without blocking. */
export async function getQueueStatus(cwd?: string): Promise<QueueStatus> {
	const [kinds, stale, worker] = await Promise.all([
		countActiveQueueEntriesByKind(cwd),
		countStaleQueueEntries(cwd),
		getWorkerBusyState(cwd),
	]);
	const active = kinds.summary;
	const ingestActive = kinds.ingest;
	const drained = active === 0 && !worker.blocking;
	return { active, ingestActive, workerBusy: worker.held, workerBlocking: worker.blocking, drained, stale };
}

/**
 * Polls `getQueueStatus` until `drained` or `timeoutMs` elapses. Returns the
 * final status plus `waitedMs`. Never blocks longer than the timeout, so a
 * crashed worker (stale lock) cannot hang the caller — the caller decides what
 * to do with a non-drained result.
 */
export async function waitForQueueDrained(
	cwd: string | undefined,
	opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<QueueStatus & { waitedMs: number }> {
	// Coerce non-finite / negative inputs to the defaults. A raw NaN (e.g. an
	// MCP client sending `timeoutMs: "abc"` that bypassed the compile-time type)
	// would make `waitedMs >= NaN` always false and `sleep(NaN)` fire at 0 ms,
	// spinning this loop hot forever. `?? DEFAULT` alone doesn't help — NaN is
	// not nullish. The CLI command guards its own input, but this is the shared
	// choke point every caller (including MCP) flows through.
	const timeoutMs = isFiniteNonNegative(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_QUEUE_WAIT_TIMEOUT_MS;
	const pollMs = isFiniteNonNegative(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : DEFAULT_QUEUE_WAIT_POLL_MS;
	const start = Date.now();
	for (;;) {
		const status = await getQueueStatus(cwd);
		const waitedMs = Date.now() - start;
		if (status.drained || waitedMs >= timeoutMs) {
			return { ...status, waitedMs };
		}
		await sleep(Math.min(pollMs, Math.max(1, timeoutMs - waitedMs)));
	}
}
