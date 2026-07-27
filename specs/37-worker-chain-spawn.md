# Worker Chain Spawn

## Topic Statement

After a worker finishes draining the queue and releases its lock, it lists the queue once more and starts a successor as a new detached process if any entry has appeared, so that work enqueued during the drain is never stranded.

## Scope

**In scope:**
- The race that makes a successor necessary: producers enqueue while a consumer holds the lock.
- The successor protocol: list-after-release, conditional spawn, exit.
- The producer's complementary rule that decides whether to spawn its own consumer or rely on the running one.
- What happens when the chain breaks, and how recovery is achieved.
- Why the successor is a brand-new process rather than an in-process re-entry.

**Out of scope:**
- The drain loop itself, the dispatch table, and the per-entry success/failure semantics (covered by the queue-worker topic).
- The shape of an individual queue entry (covered by the queue-entry-format topic).
- The transcript cutoff each entry carries (covered by the transcript-cutoff topic).
- The mechanics of lock acquisition and the staleness threshold (covered by the queue-worker topic).

## Data Contracts

### Lock observation primitive

A function that reports whether the worker lock file currently exists and is younger than the staleness threshold (five minutes). Used by producers to decide between spawning a fresh consumer and relying on the running one.

### Spawn primitive

The same detached-spawn primitive used by both producers and the worker's own successor step:

- Spawns the worker script as a detached child of the current process.
- Inherits no standard streams.
- Hides any platform-specific console window.
- Suppresses experimental-feature warnings emitted by the runtime when on-demand database modules are loaded later.
- Unrefs the child so the parent does not wait for it.

### Producer policy

When a producer (post-commit hook or post-rewrite hook) finishes writing its entry, it consults the policy table:

- The post-commit hook always spawns a fresh worker after enqueue, regardless of whether the lock is held. (See Notable Behavior on why this is correct.)
- The post-rewrite hook checks the lock first. If the lock is held, it does not spawn. If the lock is not held, it spawns.

### Successor policy (consumer side)

The worker, after releasing its lock, lists the queue. If the listing returns one or more processable entries, the worker spawns a successor and exits. If the listing returns nothing, the worker just exits.

## Behavior

### The race the protocol solves

1. Worker A is mid-drain, holding the lock and running the language-model call for some entry.
2. The user makes another commit. The post-commit hook runs synchronously, writes a new queue entry, and tries to spawn a new worker.
3. If a producer-side policy demands "spawn unconditionally" and the spawn happens, the new worker (worker B) starts, observes the lock as held, and exits immediately.
4. Worker A finishes its language-model call and reaches the end of its drain loop. Without the chain-spawn protocol, worker A's drain would be empty (it processed everything it had pulled in earlier) but the queue would have the new entry sitting unprocessed and no other worker to handle it.
5. Worker A would then release the lock and exit, stranding the new entry.

### The producer-side rule that makes (3) safe

The post-commit hook spawns unconditionally because (a) spawning is cheap (a detached process that exits at once on contention) and (b) the hook cannot afford to make any network or filesystem decision beyond the synchronous queue write — it is constrained to under five milliseconds of work. The post-rewrite hook does the lock-held check because it is permitted slightly more leeway and because rebases can produce many entries in a single invocation; checking once and skipping the spawn loop avoids spawning the same dead-on-arrival worker dozens of times in a row.

### The consumer-side successor step

After the drain loop exits and the lock has been released:

1. The worker re-lists the queue directory using the same drain-listing routine that prunes stale entries during normal iteration.
2. If the routine returns one or more processable entries, the worker calls the spawn primitive once and then exits.
3. If the routine returns zero entries, the worker exits without spawning.

The exit step is unconditional after this check; the worker does not loop back to the drain. The successor performs its own startup, lock acquisition, and drain.

### Why a successor process and not an in-process loop

The worker could in principle re-acquire its own already-released lock and re-enter the drain loop. It instead chooses to release-then-spawn-fresh because:

- The fresh process picks up changes to the storage backend configuration that may have been written during the previous drain.
- It picks up changes to the per-repository config (log level, integration toggles) that downstream handlers consult.
- It is symmetric with the producer-spawn path; only one piece of code needs to be correct.
- The bounded per-run cap (twenty entries) is intentionally a safety belt, and re-acquiring in-process would let a runaway producer indefinitely defer the cap's intended exit.

### When the chain breaks

If the spawn primitive itself fails (for example, the runtime cannot fork a new process), the queue entry is left in place. The next time any hook fires (next commit, next amend, next rebase), the producer's spawn step makes another attempt and the entry is picked up. If no further hooks fire, the entry sits until either a manual command or the seven-day stale prune removes it. There is no in-process retry of the spawn.

The doctor command, separately, detects unprocessed entries (a backlog older than expected) and stale locks, and offers manual recovery: release the lock and invoke the worker function directly.

## State Transitions

### Across two consecutive commits during a long language-model call

- **t0**: First post-commit hook writes entry 1 and spawns worker A. Worker A acquires the lock, parses entry 1, calls the language-model.
- **t1 (during the language-model call)**: Second post-commit hook writes entry 2 and spawns worker B. Worker B starts, observes lock-held, exits at once.
- **t2**: Worker A's language-model call returns. Worker A's drain loop's outer iteration begins again, finds entry 2 (which is newer than the stale threshold and was added to the directory after worker A's previous list), processes it. Drain loop exits when the next list returns empty.
- **t3**: Worker A releases the lock.
- **t4**: Worker A re-lists. If worker B's spawn or any subsequent producer's spawn succeeded between t3 and t4 and that worker has not yet acquired the lock, worker A may still observe the queue as empty (entries are deleted by whichever worker processes them). If worker A's re-list is empty, worker A exits.
- **t4'**: If t4 finds an entry (a third commit's hook ran between t3 and t4, fast enough to write but slow enough that no worker has yet picked it up), worker A spawns a successor and exits.

### When the user commits faster than the worker drains

The drain loop's outer iteration handles this: every time the inner per-entry loop exits, the outer iteration re-lists the directory. New entries that arrived during the inner loop's processing of the last entry are picked up by the next outer iteration. The chain-spawn step at the very end is the last line of defense for entries that arrive after the final outer iteration's listing.

### When a producer's lock-held check is racy

The post-rewrite hook checks the lock once. The worker may release the lock between that check and the post-rewrite hook's decision not to spawn. In that narrow window the queue's new entry would be unprocessed and no worker would be running. The chain-spawn step at the worker's exit would not fire (the worker that just released its lock had already passed its own re-list step), but the next producer to fire would re-acquire the world; if no further producer fires, the recovery falls to the doctor command. (See Notable Behavior.)

## Notable Behavior

- **The chain-spawn is the only mechanism that closes the producer-locked-out-of-spawning hole.** A producer that spawned a worker and saw it bounce off the lock has no way to wake the running worker with a signal; it relies on the running worker discovering the new entry on its next list. The drain loop's inner re-list and the post-drain re-list are the two places that discovery can happen. (Surprising; intentional.)

- **Release-then-list, not list-then-release.** The worker releases the lock first, then re-lists. This intentionally lets a successor immediately acquire the lock without contending with the predecessor. The window between release and successor spawn is short but non-zero; if a hook spawns its own worker in this window it will succeed instead of waiting on the chain. Either way, exactly one fresh worker tries to acquire the lock — the chain spawn or the producer's spawn, whichever fires first; the other observes the lock as held and exits. (Surprising.)

- **Unconditional spawn from the post-commit hook is intentional.** A hook that conditionally spawns based on lock observation must serialize against the worker's release step, which is impossible to get right in five milliseconds of synchronous work. Unconditional spawn lets the spawned worker make the decision (acquire-or-exit) under the lock's actual semantics. The cost of the no-op spawn is a few milliseconds of process startup and exit; the benefit is correctness. (Surprising; intentional.)

- **Conditional spawn from the post-rewrite hook is also intentional.** Rebase events emit one stdin pair per rewritten commit; a fifty-commit rebase produces fifty queue entries through the same hook invocation. Spawning fifty no-op workers, even if cheap, would generate fifty log lines and fifty process-creation events. Checking the lock once and skipping fifty spawns is the chosen trade-off, accepting the narrow race window in exchange for log clarity. (Surprising.)

- **The post-drain re-list is bounded by the drain loop's stale-prune step.** The same routine that returns processable entries also deletes seven-day-old entries during its parse pass. A re-list that finds only stale entries returns empty and triggers no successor. (Notable.)

- **The successor is just another worker, not a special "drain-only" process.** It performs full startup: log directory setup, storage backend selection, and lock acquisition. It is indistinguishable from a worker spawned by a hook. (Notable.)

- **Chain-spawn does not happen when the lock acquisition itself failed.** If a worker fails to acquire the lock, it exits at once without performing the post-drain re-list or successor spawn. The successor is the responsibility of whichever worker actually held the lock. (Notable.)

- **There is no second attempt if the spawn primitive fails.** A failure in the spawn primitive (for example, fork failure under resource exhaustion) is logged and the worker exits anyway. Recovery falls to the next hook firing or to a manual doctor invocation that releases any stale lock and starts the worker by direct function call. (Surprising.)

- **The worker can be invoked directly without spawning.** Tests and the doctor's recovery path import the worker function and call it in-process. The lock-acquisition, drain, release, and post-drain re-list steps still run; only the spawn primitive at startup is bypassed. The chain-spawn at exit, however, still uses the spawn primitive — calling the worker function directly does not chain in-process. (Notable.)

- **No coordination with the language-model call.** The chain-spawn step does not interrupt or signal the in-flight language-model call inside another worker. It relies on the lock as the only synchronization point. (Notable.)

## Shared Behavior

- The drain loop, lock acquisition, and the per-entry success-and-failure semantics are defined by the **Git Operation Queue Worker** topic.
- The shape of a queue entry, the producer hooks, and the file-name convention used to establish drain order are defined by the **Queue Entry Format** topic.
- The transcript cutoff each entry carries forward into its handler is defined by the **Summary Attribution by Transcript Cutoff** topic.
- The doctor command's manual recovery flow (release stuck lock, invoke worker directly) is defined by the doctor topic.
