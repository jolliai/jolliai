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
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workerCount = Math.min(Math.max(1, limit), items.length || 1);

	async function worker(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			const item = items[index];
			try {
				results[index] = await task(item, index);
			} catch (err) {
				if (!onError) throw err;
				results[index] = onError(item, err, index);
			}
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}
