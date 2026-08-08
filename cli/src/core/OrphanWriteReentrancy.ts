/**
 * Call-chain-scoped re-entrancy for `orphan-write.lock`.
 *
 * `orphan-write.lock` is a plain file lock: `tryAcquireOnce` refuses a second
 * acquisition even from the PID that already owns it (a fresh mtime plus a
 * live owner PID is indistinguishable from a healthy foreign holder). That is
 * correct for cross-process mutual exclusion and fatal for nesting — and the
 * D6 invariant pushes every orphan write path toward taking the lock itself,
 * which makes nesting the normal case rather than the exception:
 *
 *   QueueWorker ingest `writeGuard`  → holds the lock across page + index
 *     └─ IngestPipeline              → saveTopicPage / saveTopicIndex
 *          └─ TopicPageStore         → takes the lock again → self-deadlock
 *
 * The inner acquire polls out its whole budget against a lock its own call
 * chain already owns, then throws. Collapsing the outer guard is not an
 * option: it exists precisely so a page and its index entry land in ONE
 * critical section (a separate index acquisition that fails after the page
 * persisted orphans the page, recoverable only by `--rebuild`).
 *
 * **Why `AsyncLocalStorage` and not a module-level depth counter.** A
 * process-wide counter cannot distinguish "nested inside the holder" from "a
 * second, genuinely concurrent async task in the same process" — the VS Code
 * extension host runs a background scan and a bridge write in one process, and
 * a counter would wave the concurrent task straight through a lock it does not
 * hold. An async-context store only propagates down the holder's own await
 * chain, so re-entry is granted to exactly the callers that already own it.
 *
 * **Known narrow hazard.** A fire-and-forget task started inside a guarded
 * section inherits the store, so if it outlives the section and then performs
 * an orphan write it will skip locking after the outer holder released. Every
 * current guarded section is fully awaited; a new write path that detaches
 * work inside one must await it before returning.
 *
 * **Keying.** Keyed by the resolved `cwd`, not by the lock file path, so that
 * `Locks.withOrphanWriteLock` and `SummaryStore.withRequiredOrphanWriteLock`
 * agree on the key without either having to resolve the shared lock directory
 * (the resolver is private to `Locks.ts`, and routing it through there would
 * break the many suites that mock `Locks.js` wholesale). The asymmetry is the
 * safe one: one `cwd` always maps to exactly one lock file, so a key match can
 * never grant re-entry into a lock the chain does not hold. The reverse — two
 * different worktrees of one repo share a lock file but key differently — is a
 * missed re-entry, i.e. the pre-existing deadlock, and no current nesting site
 * crosses worktrees (every one threads a single `cwd` down the chain).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { resolve as resolvePath } from "node:path";

/** Resolved `cwd`s whose `orphan-write.lock` this async context already holds. */
const heldOrphanWrites = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Normalizes a `cwd` into the re-entrancy key. `undefined` means "the process
 * cwd" for every lock helper, so it has to normalize to the same key an
 * explicit, equal `cwd` produces — otherwise a chain that mixes the two forms
 * would miss the re-entry and deadlock.
 */
function reentrancyKey(cwd?: string): string {
	return resolvePath(cwd ?? process.cwd());
}

/** True when this async call chain already holds `orphan-write.lock` for `cwd`. */
export function holdsOrphanWriteLock(cwd?: string): boolean {
	return heldOrphanWrites.getStore()?.has(reentrancyKey(cwd)) === true;
}

/**
 * Runs `fn` with `cwd` marked as held for the duration. Callers invoke this
 * only after a real acquisition succeeds, so the store never claims a lock
 * that was not actually taken.
 */
export function runHoldingOrphanWriteLock<T>(cwd: string | undefined, fn: () => Promise<T>): Promise<T> {
	const next = new Set(heldOrphanWrites.getStore() ?? []);
	next.add(reentrancyKey(cwd));
	return heldOrphanWrites.run(next, fn);
}
