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
 * `timedOut: true` (the run continues server-side). The default cap is sized to a
 * few minutes of wall-clock (see {@link DEFAULT_MAX_ATTEMPTS}) so the single
 * foreground `jolli workflow-run-status` call the recipe shells stays inside a
 * typical agent shell-tool timeout — the graceful `timedOut` report is only useful
 * if it actually reaches the agent rather than the host killing the call first.
 *
 * The ONLY throw it propagates is a `getRunStatus` failure that is not recoverable
 * by waiting: a {@link PlatformToolUnavailableError} (platform tools off / backend
 * too old) is structurally permanent and re-thrown immediately, and a run of
 * consecutive transient throws past `maxTransientRetries` is re-thrown too. The
 * command turns either into a `{ type: "error" }` result.
 */

import {
	isTerminalStatus,
	type OpenableUrl,
	PlatformToolUnavailableError,
	type RunReport,
	shapeRunReport,
	type WorkflowRunPayload,
} from "./WorkflowRunReport.js";

/** The side-effecting seams {@link monitorRun} needs; the command wires real impls. */
export interface MonitorDeps {
	/** Fetch one run's enriched status; LOUD-FAIL (throws on transport/tool-absent). */
	getRunStatus: (runId: string) => Promise<WorkflowRunPayload>;
	/** Wait `ms` milliseconds (injected so tests need no real timers). */
	sleep: (ms: number) => Promise<void>;
}

/** Bounds and backoff shape for {@link monitorRun}; each field defaults when omitted. */
export interface MonitorOptions {
	/** Max poll attempts before returning a `timedOut` report (default {@link DEFAULT_MAX_ATTEMPTS}). */
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

/**
 * Poll-attempt cap. With the default backoff (2s → 4s → 8s → 15s ceiling), 15
 * attempts is ~3 min of wall-clock — a few minutes, bounded well under a typical
 * agent shell-tool timeout so the graceful `timedOut` report reaches the agent
 * instead of the host killing the foreground call. A still-running run is not lost:
 * the recipe re-runs `workflow-run-status <runId>` to pick it back up.
 */
const DEFAULT_MAX_ATTEMPTS = 15;
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
 *   openableUrls: [workflow and run deep-links the last payload carried] }` — the
 *   run URL points straight at the still-in-progress run for the user to watch.
 * - a {@link PlatformToolUnavailableError} ⇒ re-thrown immediately (structurally
 *   permanent — retrying cannot make the tool appear).
 * - a persistent transient `getRunStatus` throw (past `maxTransientRetries`
 *   consecutive failures) ⇒ re-thrown for the command to report; a successful poll
 *   resets the transient counter.
 */
export async function monitorRun(deps: MonitorDeps, runId: string, opts: MonitorOptions = {}): Promise<MonitorResult> {
	const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const maxTransientRetries = opts.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
	const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

	let lastWorkflowUrl: string | undefined;
	let lastRunUrl: string | undefined;
	let consecutiveFailures = 0;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		let run: WorkflowRunPayload;
		try {
			run = await deps.getRunStatus(runId);
		} catch (error) {
			// A tool-absent failure is permanent — waiting cannot fix it, so surface
			// it now rather than burning the transient budget + backoff on retries.
			if (error instanceof PlatformToolUnavailableError) {
				throw error;
			}
			consecutiveFailures++;
			if (consecutiveFailures > maxTransientRetries) {
				throw error;
			}
			await deps.sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
			continue;
		}
		consecutiveFailures = 0;
		lastWorkflowUrl = run.workflowUrl ?? lastWorkflowUrl;
		lastRunUrl = run.runUrl ?? lastRunUrl;
		if (isTerminalStatus(run.status)) {
			return shapeRunReport(run);
		}
		// Skip the backoff wait after the final attempt — the loop is about to exit
		// and return the `timedOut` report, so that last sleep would poll nothing.
		if (attempt < maxAttempts - 1) {
			await deps.sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
		}
	}

	const openableUrls: OpenableUrl[] = [];
	if (lastWorkflowUrl !== undefined) {
		openableUrls.push({ kind: "workflow", url: lastWorkflowUrl });
	}
	if (lastRunUrl !== undefined) {
		openableUrls.push({ kind: "run", url: lastRunUrl });
	}
	return { status: "running", openableUrls, timedOut: true };
}
