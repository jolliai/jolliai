/**
 * Tiny exponential-backoff retry helper for the sync engine.
 *
 * Used by `BackendClient` (mint-token / notify-push) and `GitClient.push`
 * (non-FF rebase + retry). Kept deliberately small — when sync grows more
 * retry sites, generalize then; for now, three call sites don't justify a
 * full library.
 */

export interface BackoffOpts {
	/** Initial delay before the first retry. */
	readonly baseMs: number;
	/** Cap on any single delay. */
	readonly maxMs: number;
	/** Multiplier applied to the previous delay (typically 2). */
	readonly factor: number;
	/** When true, multiplies each delay by a random factor in [0.5, 1.0). */
	readonly jitter: boolean;
}

export interface RetryOpts {
	/** Total attempts including the initial call. Must be ≥ 1. */
	readonly attempts: number;
	readonly backoff: BackoffOpts;
	/** Decides whether a thrown error is retryable. */
	readonly shouldRetry: (e: unknown) => boolean;
	/** Test seam — defaults to `setTimeout`. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Calls `fn`. On rejection, if `shouldRetry(error)` is true and attempts
 * remain, waits per `backoff` and retries. Throws the last error when
 * attempts are exhausted or `shouldRetry` says no.
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
	const sleep = opts.sleep ?? defaultSleep;
	let lastErr: unknown;
	for (let attempt = 0; attempt < opts.attempts; attempt++) {
		try {
			return await fn();
		} catch (e) {
			lastErr = e;
			const isLast = attempt === opts.attempts - 1;
			if (isLast || !opts.shouldRetry(e)) {
				throw e;
			}
			await sleep(computeDelay(attempt, opts.backoff));
		}
	}
	/* v8 ignore next -- unreachable: loop always either returns or throws */
	throw lastErr;
}

/** Visible for testing: computes the delay before retry `attempt`. */
export function computeDelay(attempt: number, opts: BackoffOpts): number {
	const raw = Math.min(opts.baseMs * opts.factor ** attempt, opts.maxMs);
	if (!opts.jitter) return raw;
	return raw * (0.5 + Math.random() * 0.5);
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
