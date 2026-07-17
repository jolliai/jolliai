/**
 * Concurrency — generic bounded-parallelism map. Runs `task` over `items` with
 * at most `limit` in flight at once, preserving input order in the result.
 *
 * When `onError` is supplied, a task that throws is converted to a result via
 * `onError(item, err)` instead of rejecting the whole batch — callers that want
 * per-item degradation (e.g. the ingest reconcile fan-out) pass it. Without
 * `onError`, the first thrown error rejects the returned promise.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T, index: number) => Promise<R>,
	onError?: (item: T, err: unknown, index: number) => R,
	onEach?: (result: R, item: T, index: number) => void,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	// Set the first time a task throws with no `onError`. The whole call is about
	// to reject, so peer workers stop pulling new items rather than burning more
	// work (e.g. LLM calls) on a batch that's already doomed. In-flight tasks
	// still finish; a no-op when `onError` is supplied (every task is handled).
	let aborted = false;
	const workerCount = Math.min(Math.max(1, limit), items.length || 1);

	async function worker(): Promise<void> {
		while (next < items.length) {
			if (aborted) return;
			const index = next++;
			const item = items[index];
			let out: R;
			try {
				out = await task(item, index);
			} catch (err) {
				if (!onError) {
					aborted = true;
					throw err;
				}
				out = onError(item, err, index);
			}
			results[index] = out;
			// Fire onEach after the result is recorded so a callback that inspects
			// `results` (unlikely, but permitted) sees the current slot filled.
			// Errors thrown by onEach are intentionally NOT caught — progress
			// callbacks that throw are a caller bug and should surface promptly.
			onEach?.(out, item, index);
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}
