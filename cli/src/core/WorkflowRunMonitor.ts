/**
 * The deterministic poll-to-terminal monitor for a remote workflow run. The
 * remote-run recipe shells `jolli workflow-run-status <runId>` once instead of
 * driving a poll loop in the agent: this core polls `getRunStatus(runId)` with
 * exponential backoff until the wire status is terminal, then returns the pure
 * {@link shapeRunReport} projection of the final payload.
 *
 * It is pure-ish — every side-effecting seam is injected ({@link MonitorDeps}):
 * the run-status read-method and a `sleep` clock — so tests drive it with a fake
 * sleep and need no real timers. The monitor NEVER hangs and NEVER throws for a
 * still-running run: on the attempt cap it returns a still-running report tagged
 * `timedOut: true` (the run continues server-side). The ONLY throw it propagates
 * is a PERSISTENT `getRunStatus` failure — a small number of consecutive
 * transient throws are retried first; only a run of failures past that budget is
 * re-thrown, which the command turns into a `{ type: "error" }` result.
 */

import { isTerminalStatus, type RunReport, shapeRunReport, type WorkflowRunPayload } from "./WorkflowRunReport.js";

/** The side-effecting seams {@link monitorRun} needs; the command wires real impls. */
export interface MonitorDeps {
	/** Fetch one run's enriched status; LOUD-FAIL (throws on transport/tool-absent). */
	getRunStatus: (runId: string) => Promise<WorkflowRunPayload>;
	/** Wait `ms` milliseconds (injected so tests need no real timers). */
	sleep: (ms: number) => Promise<void>;
}

/** Bounds and backoff shape for {@link monitorRun}; each field defaults when omitted. */
export interface MonitorOptions {
	/** Max poll attempts before returning a `timedOut` report (default 40). */
	readonly maxAttempts?: number;
	/** Consecutive transient `getRunStatus` throws tolerated before re-throwing (default 3). */
	readonly maxTransientRetries?: number;
	/** First backoff delay in ms; doubles each attempt up to {@link maxDelayMs} (default 2000). */
	readonly baseDelayMs?: number;
	/** Backoff ceiling in ms (default 15000). */
	readonly maxDelayMs?: number;
}

/** A {@link RunReport} plus the monitor-only `timedOut` flag (set only on the cap). */
export interface MonitorResult extends RunReport {
	/** True when the attempt cap was hit while the run was still non-terminal. */
	readonly timedOut?: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 40;
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 2000;
const DEFAULT_MAX_DELAY_MS = 15000;

/** A real `sleep` seam for production wiring (the command injects this). */
export function realSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Exponential backoff for `attempt` (0-based), doubling `base` and capped at `max`. */
function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
	return Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
}

/**
 * Poll `runId` to a terminal state and return its shaped report. See the file
 * header for the full contract:
 * - terminal (`completed`/`failed`/`cancelled`) ⇒ the shaped report, returned as
 *   soon as it is observed (no trailing sleep).
 * - attempt cap hit while non-terminal ⇒ `{ status: "running", timedOut: true,
 *   openableUrls: [workflow URL if the last payload carried one] }`.
 * - a persistent `getRunStatus` throw (past `maxTransientRetries` consecutive
 *   failures) ⇒ re-thrown for the command to report; a successful poll resets the
 *   transient counter.
 */
export async function monitorRun(deps: MonitorDeps, runId: string, opts: MonitorOptions = {}): Promise<MonitorResult> {
	const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const maxTransientRetries = opts.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
	const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

	let lastWorkflowUrl: string | undefined;
	let consecutiveFailures = 0;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		let run: WorkflowRunPayload;
		try {
			run = await deps.getRunStatus(runId);
		} catch (error) {
			consecutiveFailures++;
			if (consecutiveFailures > maxTransientRetries) {
				throw error;
			}
			await deps.sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
			continue;
		}
		consecutiveFailures = 0;
		lastWorkflowUrl = run.workflowUrl ?? lastWorkflowUrl;
		if (isTerminalStatus(run.status)) {
			return shapeRunReport(run);
		}
		await deps.sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
	}

	return {
		status: "running",
		openableUrls: lastWorkflowUrl !== undefined ? [{ kind: "workflow", url: lastWorkflowUrl }] : [],
		timedOut: true,
	};
}
