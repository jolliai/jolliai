/**
 * Bounded memo writes.
 *
 * One helper for the "remember this, and if the map has grown past a limit drop the
 * whole thing" policy. It exists because that policy arrived three times in one change
 * with three spellings and three limits, and two of the three had no way to be tested:
 * driving a 20,000-entry limit through the caller that owns it costs 20,001 real files.
 * A limit passed as an argument is testable once, here.
 *
 * ## Why whole-map, and why the `has` check is not an optimization
 *
 * A whole-map clear rather than an LRU is deliberate at every current call site: the
 * cost of a miss is re-doing work that was already being done before the memo existed,
 * so eviction accuracy buys nothing and an LRU's bookkeeping is pure overhead.
 *
 * The `has` check is a correctness detail, not a micro-optimization. Testing the size
 * before knowing whether the key is already present means a write that CANNOT grow the
 * map — re-remembering a key it already holds — throws away every other entry once the
 * map is sitting at the limit. That is reachable: a memo whose entries are refreshed in
 * place (a fixture rewritten at the same path, a rollout whose mtime moved backwards)
 * does exactly that, and the observable result is the whole cache evaporating on a write
 * that should have been a no-op.
 */

/**
 * Stores `value` under `key`, clearing the whole map first if this write would push it
 * past `limit`.
 *
 * `onEvict` is called with the pre-clear size, before the clear, so the caller can log
 * in its own words — the helper deliberately owns no logger, which is what keeps it a
 * leaf module every layer can import.
 */
export function setBounded<K, V>(
	memo: Map<K, V>,
	limit: number,
	key: K,
	value: V,
	onEvict?: (size: number) => void,
): void {
	if (memo.size >= limit && !memo.has(key)) {
		onEvict?.(memo.size);
		memo.clear();
	}
	memo.set(key, value);
}
