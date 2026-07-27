# 172. Global Sync Lock

## Topic Statement

The machine-global file-based mutex that serializes Memory Bank reconciliation rounds across every checkout, every editor window, and every CLI invocation belonging to the same OS user.

## Scope

**In scope:**

- The on-disk location and naming of the global sync mutex, including the test-isolation environment override.
- Lazy creation of the parent directory on first acquire so a fresh install with no other Memory Bank state still works.
- The single ordered acquire algorithm shared with the two sibling per-user locks (per-worktree worker mutex, per-vault write mutex), built on three primitive observations: file existence, written process identifier, and modification time.
- Stale detection by two independent signals: an absolute age threshold, and an OS-level liveness probe of the written process identifier.
- The fail-fast acquire mode (zero budget — single attempt) versus the bounded polling mode with a default budget and poll interval.
- The default 10-second budget that applies uniformly to the periodic background poll and to the user-initiated manual "sync now" surface, with the documented rationale for each.
- Periodic refresh of the lock's freshness timestamp by a long-running holder so a peer cannot mtime-reclaim mid-round.
- Owner-checked release: the lock file is removed only when its written process identifier matches the releasing process.
- A passive "is held" probe that reports the lock's status without attempting acquisition.
- Concurrent-acquire arbitration semantics: when multiple callers race the same mutex, exactly one wins each round.
- The documented release-ordering invariant relative to the backend write-lock release call.
- The documented unclosed mtime-refresh race window and its mitigation by refresh cadence margins.

**Out of scope (boundaries — what is sent or received but not re-specified here):**

- The reconciliation round's full step sequence that takes this lock at entry (separate spec — referenced only as "the round driver").
- The per-vault write mutex held only across the integration-and-conflict-resolution window (separate spec — distinct file, distinct scope, same primitive).
- The per-worktree summary-worker mutex (separate spec — distinct file, distinct scope, same primitive).
- The per-worktree ingest mutex held only across the worker's topic-KB ingest phase (spec 259 — distinct file, distinct scope, same primitive).
- The backend per-personal-space write lock acquired by the credentials mint, released via one of three documented success calls or a failure-path safety-net (separate spec — distinct system, lives on the server, only its release-ordering relative to this local mutex is specified here).
- The polling timer that fires the periodic background acquire from the IDE host (separate spec — referenced only as "the periodic background poll").
- The manual "sync now" command surface (separate spec — referenced only as "the manual trigger").
- The in-process coalescing that prevents two simultaneous trigger sources from both calling the round driver in a single IDE process (separate spec — referenced only as "the in-process coalescer").
- The cross-repo "pending workers" wakeup registry the round driver consults on completion (separate spec — distinct file, distinct purpose).
- The post-commit hook flow: the post-commit hook **never** acquires this mutex (the auto post-commit sync trigger was intentionally removed; the only entry points are the periodic background poll and the manual trigger).

## Data Contracts

### Lock-file location

| Aspect | Value |
| --- | --- |
| Default directory | A fixed machine-global directory under the OS user's home, conventionally `<home>/.jolli/jollimemory/`. |
| File name | A fixed leaf name, conventionally `sync.lock`. |
| Test-isolation override | An environment variable can replace the default directory at every lookup. The override is read on every path resolution (not cached). |
| Override semantics for "unset" vs. "empty string" | Both treated identically as "no override" — the default directory is used. |
| Parent directory | Created recursively on first acquire if absent; no preflight check. |

### Lock-file contents

| Aspect | Value |
| --- | --- |
| Body | The current process's numeric process identifier, written as ASCII text with no trailing newline or surrounding whitespace. |
| Encoding | Plain text. No JSON, no schema version, no payload. |
| Mutation | Written once at acquisition; never edited afterwards. Refresh updates the file's modification time only — content is untouched. |
| On read | Trimmed of surrounding whitespace and reduced to its numeric form before comparison. An empty body (after trim) is treated as "no owner" / unreadable. |

### Acquire options

The caller may supply:

| Field | Default | Meaning |
| --- | --- | --- |
| Budget (timeout) | 10 seconds | Maximum wall-clock time to wait for a fresh holder to release. |
| Poll interval | 100 milliseconds | Sleep between retries while the lock is held by a fresh living owner. |

A budget of zero (or negative) collapses to a single fail-fast attempt — no sleep, no retry. The poll interval is unused when the budget is zero.

### Staleness criteria

A lock counts as **stale** (reclaimable by the next acquirer) when **either** of these holds:

1. The lock file's modification-time age is greater than or equal to a fixed staleness threshold (5 minutes).
2. The written process identifier no longer corresponds to a live process on this host.

A lock counts as **held** when both:

1. Its modification-time age is less than the staleness threshold, **and**
2. Its written process identifier corresponds to a live process (or the file is unreadable / contents are not a positive integer — in which case the owner is treated as "unknown" and the mtime-only path applies).

### Liveness probe (PID)

| Input | Output |
| --- | --- |
| The content is not a positive integer (empty, non-numeric, zero, negative) | "Not alive" — the lock is reclaimable on the PID signal. |
| The content equals the current process's identifier | "Alive" — short-circuit (this process is its own owner). |
| The signal-zero probe reports the process exists | "Alive". |
| The signal-zero probe reports "no such process" | "Not alive" — the lock is reclaimable on the PID signal. |
| The signal-zero probe reports "permission denied" (process exists but is owned by another OS user) | "Alive" defensively — never steal a lock that belongs to a different user account. |
| Any other signal-zero error | "Alive" defensively. |

### "Is held" probe (passive)

Returns true when the lock file exists and its mtime age is less than the staleness threshold. The PID liveness check is **not** consulted by this probe — it is an mtime-only check. Any error reading the file (missing, unreadable, transient I/O) returns false.

## Behavior

The acquire / release flow is the same on every entry to the round driver. Entry points are limited to the periodic background poll and the manual trigger; there is no third entry point.

### Acquire — fail-fast (budget = 0)

1. Resolve the lock-file path (re-reads the environment override on every call).
2. Recursively create the parent directory (idempotent — no-op if it exists).
3. Run one acquisition attempt:
   1. Attempt to read the lock file's modification time.
      - **File missing:** proceed to step 3.3.
      - **Stat error other than missing:** abandon the attempt and report failure (this is rare and treated as a transient filesystem issue, not retried at this level).
      - **Stat succeeds:** continue with steps 3.2.
   2. Read the lock-file body and resolve the owner state:
      - Compute the mtime age.
      - Run the PID liveness probe.
      - If the file's age is below the staleness threshold **and** the owner is alive, report failure (held by a live peer).
      - Otherwise, log a warning naming the reason (orphaned PID vs. stale mtime), remove the lock file, and continue.
   3. Attempt to write the lock file with exclusive-create semantics, writing the current process identifier as the body.
      - **Success:** report success.
      - **Failure (already exists or other):** report failure (a peer raced in between the stat and the create).

### Acquire — bounded polling (budget > 0)

1. Compute a deadline = now + budget.
2. Loop:
   1. Run one fail-fast attempt (steps 3.1–3.3 above).
   2. On success, return success immediately.
   3. If now ≥ deadline, return failure.
   4. Sleep for the poll interval.
   5. Repeat.

### Refresh (heartbeat)

Long-running holders must periodically bump the lock's modification time so peers do not mtime-reclaim it. The refresh:

1. Reads the current owner identifier from the lock file.
2. If the owner is not this process, the refresh is a no-op (refusing to refresh someone else's lock prevents extending the lifetime of a lock the previous holder has lost via a stale-reclaim — see Notable).
3. Otherwise, bumps both the access time and modification time to the current wall-clock time.
4. Any filesystem error (file missing, transient I/O) is swallowed silently — refresh is best-effort.

The round driver runs the refresh on a fixed 60-second interval for the duration of the round.

### Release

1. Read the current owner identifier from the lock file.
2. If the file is missing or the body is empty / unreadable, proceed to step 4 (best-effort unlink).
3. If the owner identifier differs from the current process's identifier, log a warning naming the peer's identifier and return without touching the file (the stale-reclaim race guard — see Notable).
4. Otherwise (owner matches or owner unknown), unlink the lock file. Any error other than "missing" is logged and swallowed.

### Passive "is held" probe

1. Stat the lock file.
2. If stat fails (missing, unreadable, other), return false.
3. Return true if `(now − mtime) < staleness threshold`, otherwise false.

The probe never opens or reads the file body and never runs the PID liveness probe; it is intended for cheap status checks, not for arbitration.

### Outcome surface to the round driver

The round driver invokes acquire at the top of every round with the default 10-second budget. On failure:

- The round emits the `syncing` UI state with empty per-step booleans (`fetched=false`, `pulled=false`, `pushed=false`, no conflicts) and exits without doing any further work.
- No backend mint is attempted; no on-disk state changes; no progress events fire.
- The caller (the periodic background poll or the manual trigger) consumes the `syncing` outcome and clears any transient sidebar indicator. The next poll tick (default 90 minutes) or the next manual click is the only retry mechanism — this layer does not requeue.

### Release-ordering invariant

On every round outcome — success, conflict, terminal failure, transient failure, or exception — the round driver's finally clause runs the following sequence in this order:

1. Stop the refresh interval timer.
2. If the round acquired a backend per-personal-space write lock that has not already been released by one of its three normal release paths, call the backend's explicit release with the owner token.
3. Release the global sync mutex.
4. Fire the post-round chain-spawn callback (if any).

The backend release **precedes** the sync-mutex release intentionally. Were the order reversed, the next round (already gated by the sync mutex) could start its credentials mint before the in-flight backend release completes, observe the backend's own write lock still held, and be forced into its multi-minute backoff schedule. The extra wall-clock cost of holding the sync mutex across the backend release call (typically a few hundred milliseconds) is the deliberate trade.

### Refresh timer caveat

The refresh interval is cleared in the finally clause before the release sequence runs. A refresh in flight when the finally fires therefore completes against a still-owned lock; the subsequent release sees its own identifier and removes the file. No race here.

### Reentrant acquire from the same process

A second acquire from the same process while it already holds the lock returns failure on a fail-fast attempt. The kernel-level exclusive-create on write is the arbiter and refuses regardless of who the existing owner is. There is no per-process counter — the contract is "one outstanding acquire per host", not per process. Releasing once removes the lock file unconditionally (owner-checked, the same process is its own owner).

### Concurrent acquire across many callers

Multiple simultaneous acquire calls — whether from the same process, different processes belonging to the same OS user, or different editor windows — see exactly one winner per round. The exclusive-create at step 3.3 is atomic at the OS level; losers either return failure (fail-fast) or sleep and retry (polling). The polling losers will eventually win once the holder releases, or time out at the deadline.

## State Transitions

The lock has three observable states. Each transition is driven by exactly the actor named.

| From | To | Driven by | Trigger |
| --- | --- | --- | --- |
| Absent | Held (by us) | Acquire | Fail-fast or polling attempt succeeds. |
| Absent | Held (by peer) | (External — peer's acquire) | A different process on this host acquires. |
| Held (by us) | Held (by us, refreshed) | Refresh | Heartbeat interval fires while we still own the lock. |
| Held (by us) | Absent | Release | Round's finally clause runs the release sequence. |
| Held (by peer) | Stale | Time passes | Peer holds for ≥ staleness threshold without refreshing **or** peer crashes. |
| Stale | Absent (then Held by us) | Acquire | Next acquirer detects staleness, removes the file, exclusively re-creates it. |
| Held (by anyone) | Absent | (External — manual removal) | Filesystem-level intervention; not part of any code path. |

The "Held (by peer)" state from the perspective of the current process is indistinguishable from "Held (by us)" by file inspection alone — the differentiator is whether the written identifier matches. Release and refresh both consult that identifier.

## Notable Behavior

- **No third entry point exists.** The product previously included an auto post-commit sync trigger; that was intentionally removed because the post-commit hook is on a critical UX path and synchronous sync acquisition would block the user's commit. The post-commit hook does not take this mutex. The only ways the mutex is taken are the periodic background poll (default cadence 90 minutes) and the manual user-initiated trigger.
- **Same 10-second budget for poll and manual.** The poll could fail-fast (budget 0) and rely on the next tick to catch up, but the manual trigger needs a brief wait so the user does not see a no-op for trivial contention. Sharing the same 10 seconds means both entry points see the same "small wait, then defer" behavior, which keeps the operational model simple. (Notable; intentional.)
- **Failure to acquire is not an error.** A held lock surfaces to the user as the `syncing` state — the same state a successful in-progress round would show. The next poll tick (or the next manual click) is the only retry mechanism at this layer; no backoff, no exponential delay. (Notable.)
- **Acquire considers PID liveness in addition to mtime.** A crashed holder leaves the file behind with a fresh mtime if it never managed to refresh. Without the PID check, the next acquire would wait the full staleness threshold (5 minutes) before reclaiming. With the PID check, "process gone" is a sufficient signal regardless of mtime. (Notable; closes a "force-killed mid-round leaves lock stuck for 5 minutes" footgun.)
- **Permission-denied on the PID probe means "alive".** When the PID probe reports the process exists but is owned by a different OS user, the lock is treated as held — we never steal a lock that belongs to someone else's account, even on a multi-user host where the directory happens to be readable. (Notable; defensive.)
- **Release is PID-checked.** A finally clause that ran after a stale-reclaim would otherwise delete the new holder's freshly acquired lock. Release inspects the file's written identifier and refuses to remove the file unless the identifier matches the releasing process. (Notable; closes the stale-reclaim race for the deterministic case.)
- **Refresh is PID-checked.** Refreshing a lock owned by a different process would extend the lifetime of a lock the previous holder has already lost via stale-reclaim, fooling that holder into thinking it still owns the lock when it does not. The refresh therefore refuses to bump the mtime unless the file's identifier matches. (Notable; same threat model as the PID-checked release.)
- **An mtime-refresh race window remains open.** Between a peer's stat (observing age ≥ threshold) and the peer's unlink, the original holder can fire one refresh and bump the file fresh; the peer then unlinks a now-fresh lock and both believe they hold it. Closing this completely requires an atomic "remove-iff-mtime-unchanged" primitive (link/rename or a comparable scheme). It is not implemented because the window requires a sub-millisecond gap at a 60-second boundary tick. The window is documented for future readers, not patched. (Notable; intentionally unclosed.)
- **The "is held" probe is mtime-only.** It deliberately does not consult the PID liveness probe, because a recent crashed holder still surfaces as "held" until the staleness threshold elapses. Callers that need the more accurate signal must call acquire (which does the full check). The cheap probe is for status indicators only. (Notable.)
- **Test-isolation override is read on every path lookup.** Because the override is consulted on every acquire / release / refresh / probe, a test fixture can rotate it between test cases without any module-level state to reset. (Notable; deliberate.)
- **Override "empty string" means "unset".** The override does not distinguish a deliberately empty string from an absent variable. Both yield the default directory. (Notable; a subtle but deliberate guard against shell `export FOO=` leaving a no-op-looking override active.)
- **Parent directory is created on every acquire, not on module load.** On a fresh install where no other Memory Bank state exists yet, the very first acquire will be the path that creates `<home>/.jolli/jollimemory/`. There is no preflight check elsewhere that the directory exists. (Notable.)
- **Refresh failures are silent.** A transient I/O error or the file disappearing under the refresh call is swallowed without logging. The next acquire by a peer would detect the resulting staleness and reclaim. (Notable.)
- **Holder identification is local-only.** The written identifier is meaningful only on the same host. There is no hostname, no boot ID, no global identifier. The mutex is per-host; cross-host contention is solved by the backend write lock, not this file. (Notable.)
- **The mutex is global-per-user, not global-per-host.** It lives under the OS user's home, so two OS users on the same host hold independent mutexes and can run rounds simultaneously without contention. (Notable.)
- **Concurrent in-process callers also see exactly one winner.** Three near-simultaneous acquire calls from the same process race the kernel-level exclusive-create. Exactly one returns success; the other two return failure (fail-fast) or block (polling). The contract holds regardless of process identity. (Notable.)
- **Signal-induced exits bypass the release path.** Ctrl-C, SIGKILL, kernel OOM, or hard power loss skip the finally clause. The staleness threshold (or, faster, the PID-liveness check on the next acquire) is the only reclamation mechanism for these cases. (Notable.)
- **No cross-process file-descriptor handoff.** The lock file is opened, written, and closed within the acquire call; no file descriptor is kept open for the lifetime of the round. The freshness signal is the mtime, not a held file descriptor. This means a `fuser` / `lsof` inspection of the file shows no owner; the only way to identify the holder is to read the file's body. (Notable.)

## Shared Behavior

- **Same lock primitive as the per-worktree summary-worker mutex, the per-worktree ingest mutex, and the per-vault write mutex.** All four locks share the identical on-disk convention (PID body, mtime freshness signal, 5-minute staleness threshold, PID-checked release, exclusive-create acquire, polling with bounded budget where applicable). The differences are scope and location:
  - This mutex: machine-global per OS user.
  - The per-vault write mutex: per-vault directory (one per local vault clone), keyed by a hash of the vault path.
  - The per-worktree summary-worker mutex: per-source-checkout directory (one per git worktree).
  - The per-worktree ingest mutex (spec 259): also per-source-checkout, a sibling of the summary-worker mutex, held only across the worker's topic-KB ingest phase.
- **Same staleness threshold across all three locks.** 5 minutes. The threshold's documented invariant is "greater than 2× the longest heartbeat interval of any caller". Current heartbeat interval is 60 seconds, so the 5-minute floor leaves a comfortable margin for missed garbage-collector ticks or scheduling stalls.
- **Same refresh cadence as the per-vault write mutex.** 60 seconds. Round drivers that hold both this mutex and the vault write mutex run two independent refresh timers at the same cadence.
- **Release ordering with the backend write lock.** Documented above in Behavior — the backend release call is sandwiched between stopping the refresh and releasing this mutex. See spec 150 (Sync Engine Reconciliation) for the round driver as a whole.
