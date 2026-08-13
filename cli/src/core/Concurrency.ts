/**
 * Concurrency — generic bounded-parallelism map. Runs `task` over `items` with
 * at most `limit` in flight at once, preserving input order in the result.
 *
 * When `onError` is supplied, a task that throws is converted to a result via
 * `onError(item, err)` instead of rejecting the whole batch — callers that want
 * per-item degradation (e.g. the ingest reconcile fan-out) pass it. Without
 * `onError`, the first thrown error rejects the returned promise.
 *
 * ## Why this is a wrapper and not a second worker pool
 *
 * `util/Concurrency.ts` owns the pool. This module is the OTHER call signature —
 * `(items, limit, task)` with an explicit limit and an `onError` seam, against
 * that one's `(items, fn, limit?)` with the shared I/O budget's width as the
 * default. Both spellings have live callers, and neither reads naturally as the
 * other, so the two survive as signatures rather than as implementations: the
 * pool logic (worker count, order preservation, the shared `next` cursor) exists
 * once, where a fix to it reaches both.
 *
 * Do not "unify" these by editing call sites to the other signature. The
 * argument orders are transposed — `limit` sits where `fn` does in the other —
 * so a moved call site that type-checks by coincidence would pass a number where
 * a function belongs, and the compiler is not guaranteed to catch every shape.
 */

import { mapWithConcurrency as mapWithPool } from "../util/Concurrency.js";

export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T, index: number) => Promise<R>,
	onError?: (item: T, err: unknown, index: number) => R,
): Promise<R[]> {
	return mapWithPool(
		items,
		async (item, index) => {
			// Without `onError` the rejection propagates verbatim, which is what abandons
			// the remaining items — the pool's own documented behaviour, unchanged.
			if (!onError) return task(item, index);
			try {
				return await task(item, index);
			} catch (err) {
				return onError(item, err, index);
			}
		},
		limit,
	);
}
