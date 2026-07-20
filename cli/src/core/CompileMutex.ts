/**
 * CompileMutex — process-wide serialization for compile pipelines that swap the
 * process-global storage override via `setActiveStorage` (see SummaryStore).
 *
 * Both `compileAllRepos` and `compileSingleRepo` point the SHARED
 * `activeStorageOverride` at the repo they're compiling, then restore it in a
 * `finally`. That is safe when compiles run one at a time, but a long-lived host
 * (the desktop cockpit's per-tab rebuild, VS Code's "Build wiki") can start two
 * concurrently. If it does, they interleave on the single global: compile A sets
 * the override to repo A, compile B sets it to repo B, then a still-in-flight
 * write from A resolves the override to B and lands in the WRONG Memory Bank.
 * Cross-PROCESS overlap is already safe (each process has its own global) — this
 * only guards the in-process case.
 *
 * The fix is to serialize compiles process-wide: only one holds the override at
 * a time. This is a coarse lock (it also serializes compiles of DIFFERENT
 * vaults), but that is correct — they all contend on the same process global —
 * and compiles are already heavy, minutes-scale operations where a little queuing
 * is invisible next to the LLM work.
 *
 * Implemented as a promise-chain mutex: each caller waits on the tail of the
 * chain, then becomes the new tail. A rejected compile does not poison the next
 * waiter (the tail swallows outcomes); the caller still receives the real
 * result/rejection. Non-reentrant — a compile must never call `withCompileLock`
 * again from inside its own callback (it would deadlock). No current caller does:
 * the pipeline's only fan-out (`launchWorker`) spawns a DETACHED process, not an
 * in-process compile.
 */

let tail: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` once every previously-queued compile has finished, guaranteeing at
 * most one compile touches the process-global storage override at a time.
 * Returns whatever `fn` resolves to (or rejects with `fn`'s error).
 */
export function withCompileLock<T>(fn: () => Promise<T>): Promise<T> {
	// Chain off the current tail (which always resolves — see below), so this run
	// starts only after the prior one settles.
	const run = tail.then(() => fn());
	// Advance the tail to this run, but swallow its outcome so a rejected compile
	// doesn't reject the NEXT waiter's gate. The caller still sees `run`'s result.
	tail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}
