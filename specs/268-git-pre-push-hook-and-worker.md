# 268. Git Pre-Push Hook and Detached Sync Worker

## Topic Statement

A git pre-push hook that, before objects are transferred to a remote, parses the pushed refs, records the commits being pushed into the push-pending queue, then — when signed in and not opted out — hands that push's commits to a **detached worker** and merely **watches** for a result inside a small fixed wall-clock budget, printing whatever settled and letting the push proceed either way. The worker owns every network round-trip and runs to completion whether or not anyone is still watching. Publishing is optimistic: it happens before git transfers objects, so the hook never waits for remote confirmation. Every internal error path plus a hard-exit timer guarantee the hook can never fail a push or hold it beyond its budget.

## Scope

**In scope:**

- The pre-push standard-input protocol the hook consumes and how it is parsed into ref updates.
- The repo-wide manual-disable gate read before configuration is loaded, and its position relative to the sync-on-push opt-out.
- The special handling of the all-zero object id on either side of a ref update (branch deletion vs. brand-new remote branch).
- How the set of commits introduced by each ref update is enumerated, and how those commits are recorded — with a push-confirmation target — into the pending queue.
- The per-repo outbound-push gate that sits **after** the queue write, and the two different stderr notices it branches into.
- The signed-out memory preview.
- The push identifier, the work-list write that must succeed before anything is spawned, and the detached spawn of the sync worker.
- The wall-clock budget, what it now bounds (a poll loop, not a request), and the hard-exit timer that backstops it.
- The four renderings the hook chooses between when the watch ends: complete, worker-dead, timed-out-with-partial-results, timed-out-with-nothing.
- The per-commit result list: its ordering, status markers, hash and subject columns, and tail text.
- The always-exit-success guarantee.
- The standard-input drain-and-release behavior shared by all standard-input-reading hooks.

**Boundaries (consumed here, owned elsewhere):**

- The on-disk shape of the pending queue, its fields, the stale prune, the queue lock, and the whole claim-based drain are defined by the Push-Pending Queue and Drain Engine topic. This hook only records entries into that queue.
- The request / result / liveness files this hook writes and polls, the watch loop's three endings, and the mapping from a worker note to a user-facing reason are defined by the Pre-Push Worker Result Handoff topic.
- The worker process itself — its two modes, its runtime ceiling, its raised request timeout, its confirmed unfiltered tail pass — and the shared detached-spawn trigger this hook reuses are defined by the Push-Pending Compensation Retry topic.
- Installing the hook file into the repository's git hooks (markers, chaining onto a pre-existing hook, preserving the prior exit status) is defined by the git-shell hook installation topic.
- The repo-wide manual-disable flag's storage, anchoring, priority and migration are defined by the manual-disable topic.
- The per-repo outbound-push opt-out's store, its fail-closed rule, and its "never recommend the destructive recovery on an unreadable store" policy are defined by the Per-Repo Outbound-Push Control topic.

## Data Contracts

### Pre-push standard-input protocol

Git feeds the hook one line per ref being pushed, each with four whitespace-separated fields:

```
<local-ref> <local-sha> <remote-ref> <remote-sha>
```

- Blank lines are skipped; any line with fewer than four fields is skipped.
- The ref names are full ref names; the object ids are 40-character hashes, or the **all-zero object id** as a sentinel.

Git additionally passes the destination **remote name** as the hook's first positional argument. The hook uses it to stamp a push-confirmation target on each recorded commit; when it is absent, entries are recorded without a target.

### The all-zero object id sentinel

- **Local side all-zero** → the ref update is a **branch deletion**. Nothing to sync; the ref update is skipped entirely.
- **Remote side all-zero** → a **brand-new remote branch**. Commit enumeration takes everything reachable from the local tip that is **not** already reachable from any tracked remote, because a two-dot range against a nonexistent remote tip would error.
- Otherwise the enumeration is the two-dot range from the remote tip to the local tip, oldest-first.

An enumeration that fails is logged as a warning and treated as contributing no commits; the ref is skipped and the push still proceeds.

### Branch name

The branch recorded for a ref update is the local ref with a leading branch-namespace prefix stripped; any other ref shape is recorded verbatim.

### Budget

- **Total budget: 3,000 ms**, anchored at process start so the runtime startup this process already paid for is not charged to the watch. Shared by the local git reads, the queue write, the work-list write, the spawn, and the result watch.
- **Hard-exit grace: 1,000 ms** on top, arming an unref'd last-resort timer that force-exits the process with success. The watch honours the deadline on its own, so this only fires if something wedges outside it.

The budget bounds **this process only**. The worker it spawns is not bounded by it and runs to completion.

### Result list rendering

One header line, then one line per commit **in push order** (never in the worker's completion order), each carrying:

- a status marker — published `✓`, still-generating `…`, deferred `…`, merged `–`, failed `✗`;
- the first 8 characters of the commit hash;
- the commit subject, truncated at 50 display characters (the 50th becoming an ellipsis) and padded to that width;
- a tail: the article URL for a published commit, otherwise the outcome's short reason.

Subjects come from one best-effort lookup over all hashes at once; a failure there leaves every subject blank and the list still renders. A hash the worker reported nothing for renders with the **deferred** marker and a caller-chosen fallback tail. Nothing is printed when there are no commits.

### Signed-out memory preview

At most **3** commits (short hash plus subject), followed by an ellipsis line when more exist or the scan hit the deadline, then a blank line and a sign-in call to action.

## Behavior

### Hook entry

1. Anchor the budget at process start and compute the deadline.
2. Arm the unref'd hard-exit timer at budget plus grace, force-exiting with success regardless of what else is happening. Standard input is read at the hook's own entry point, **before** the budget-bound body — so the pipe is drained on every path, including the gated ones.
3. **Repo-wide manual-disable gate.** If the repository carries the manual-disable flag, log it and return. This sits **before** configuration is loaded, and therefore before the sync-on-push opt-out is ever consulted. On this path there is no queue write, no spawn, no preview and no result list, while the push itself proceeds normally.
4. Load configuration.
5. **Sync-on-push opt-out gate.** If the setting is explicitly off, do nothing at all — no queue write, no spawn — and return.
6. Note whether a personal-space credential exists; this decides step 10 versus step 11 below.
7. Parse the standard-input block into ref updates. For each: skip a branch deletion; derive the branch name; enumerate the introduced commits oldest-first; skip the ref if that yields nothing; accumulate the commits into a run-wide set; record them into the pending queue under that branch, attaching a confirmation target when the remote name is known.
8. If the run-wide set is empty, return.
9. **Per-repo outbound-push gate.** Read the outbound-push **state**, not the boolean. When it reports disabled, the commits recorded in step 7 stay pending (a later re-enable catches them up), nothing is spawned, and exactly one of two stderr lines is printed before returning:
   - **Genuine opt-out** (no read error): a line saying outbound push is disabled for this repo, that the commits were recorded locally, and naming the enable command as the fix.
   - **Unreadable store** (a read error is present): a line saying the outbound-push setting could not be read so nothing was sent, that the commits were recorded locally, pointing at the push-control command for detail and interpolating the error — and **deliberately withholding** the enable hint, because on a corrupt store enabling rebuilds from empty and drops every repo's opt-out. This is the one push-disabled notice a user cannot miss, which is exactly why it must not be the one that misleads.

   The notice exists because the worker's own drain gates on the same flag and its empty result would print nothing.
10. **Not signed in.** The commits stay recorded (so a later sign-in catches up), but there is nowhere to publish. Best-effort, print the signed-out preview: scan local storage, deadline-bound, for this push's own-hash non-child summaries in push order, up to the display limit, flagging "more" when the limit or the deadline is hit; then the sign-in call to action. Any failure in the scan is logged at debug and prints nothing.
11. **Signed in.** Proceed to the detached hand-off.

### Detached hand-off

1. **Mint a push identifier** — the ambient trace id when one is set, otherwise a fresh random identifier.
2. **Write the work list** (this push's hashes, in push order, under that identifier). If the write throws, log the error, print a one-line "recorded locally — background sync could not start" notice, and return **without spawning and without watching**: a worker with no work list cannot produce a result, and making the user wait out the budget for one would be pointless.
3. **Spawn the detached worker** in its pre-push mode, passing the push identifier, plus a callback for asynchronous spawn failures. That callback publishes a terminal result naming the spawn error, so the poll loop below exits on its next tick instead of waiting out the whole budget. A **synchronous** spawn failure is reported by the spawn's return value: log it, print the same "background sync could not start" notice, and return.
4. **Watch** for a result until it is complete, the worker is detected dead, or the deadline passes. Any throw from the watch is logged and treated as a timeout with whatever result had been seen — the worker already owns the work, so a broken watch degrades to exactly the same outcome as a timeout.
5. **Render**, keying the worker's reported outcomes by hash:
   - **Complete** → print the result list, using the worker's short-circuit note (mapped to a user-facing reason) as the fallback tail for any hash still missing. A complete result is a promise that nothing more is coming, so a missing hash is a genuine anomaly and must not be labelled "still syncing" — the worker is gone.
   - **Worker dead** → print the result list with the fallback tail "interrupted — still pending", then a second stderr line saying background sync was interrupted and pointing at the local debug log.
   - **Timed out with at least one outcome** → print the result list with the fallback tail "syncing in the background", which is accurate because the worker is still alive.
   - **Timed out with no outcomes at all** → print a single line saying the commits are syncing in the background and results land shortly.

### Always exit success

Every error thrown anywhere in the hook's work is caught and logged, and the hook exits with success. **The pre-push hook must never turn a push into a failure or hold it beyond its budget** — its sync work is strictly best-effort, and the hard-exit timer is the unconditional backstop. The queue write is atomic, so a force-exit loses at most one unrecorded entry.

### Standard-input drain-and-release (shared)

The shared helper that reads a hook's entire standard input **destroys the input stream before resolving** the collected text on reaching end-of-input. A hook process must resolve promptly and must not keep the pipe open after consuming everything; leaving it open can hold the writing side waiting. This applies to every hook that reads standard input, not only this one.

## State Transitions

### A pushed ref update

| From | Condition | To |
| ---- | --------- | -- |
| Ref line on standard input | local side all-zero | Skipped (branch deletion) |
| Ref line on standard input | remote side all-zero | Enumerated as commits not on any tracked remote |
| Ref line on standard input | both sides real | Enumerated as the remote-tip-to-local-tip range |
| Enumerated, non-empty | — | Recorded into the pending queue (branch + confirmation target) |
| Enumerated, empty or enumeration failed | — | Contributes nothing; push proceeds |

### The hook run

| From | Condition | To |
| ---- | --------- | -- |
| Invoked | repository carries the manual-disable flag | Full no-op; configuration never loaded; exit success (standard input still drained) |
| Invoked | sync-on-push explicitly off | Full no-op; exit success |
| Invoked | 0 commits after parsing | Recorded nothing; no spawn; exit success |
| Invoked | outbound push disabled, ≥1 commit recorded | Record only; no spawn; **one** stderr notice carrying the enable hint; exit success |
| Invoked | push-control store unreadable, ≥1 commit recorded | Record only; no spawn; a **different** stderr notice naming the read error, **without** the enable hint; exit success |
| Invoked | signed out, ≥1 commit recorded | Record + signed-out preview; no spawn; exit success |
| Invoked | signed in, work-list write fails | Record only; no spawn, no watch; one "could not start" notice; exit success |
| Invoked | signed in, synchronous spawn failure | Record only; no watch; the same "could not start" notice; exit success |
| Invoked | signed in, worker spawned | Watch until complete / dead / deadline, then one of four renderings; exit success |
| — | hard-exit timer fires | Force-exit with success, regardless |

## Notable Behavior

- **The hook no longer pushes anything itself.** It records, writes a work list, spawns a detached worker, and watches. The reason is that an aborted request is the worst outcome available: the server may already have minted an article id, the abort throws it away, and the next attempt creates a duplicate article instead of updating the existing one. The worker therefore runs to completion with no wall-clock budget at all; only this hook's watch is bounded. (Notable; architecture change.)
- **The budget now bounds a poll loop, not a network request.** Timing out costs the user nothing but visibility — the work continues, and the very next occasion (or the worker's own tail pass) finishes it. (Notable.)
- **Publishing is optimistic, and deliberately asymmetric.** The hook runs before git transfers objects, so waiting for remote confirmation would deadlock: git waits for the hook to exit before transferring, so a remote-ref check cannot succeed while this process is alive. A rejected push can therefore briefly leave articles for commits that never reached the remote — accepted, because the retry converges by reusing the article id. The mirror image is **not** accepted: orphan deletion is deferred, so a rejected push can never strip articles from history that still exists on the remote. (Surprising; intentional, and the asymmetry is the point.)
- **The result list iterates push order, not the worker's completion order.** The worker settles commits concurrently and reports them as they land, so rendering its order directly would scramble the list relative to the push. (Notable.)
- **A hash with no outcome renders with the deferred marker, but its wording depends on how the watch ended.** "Syncing in the background" is printed only when the worker is still alive; a complete result labels the gap from the worker's own short-circuit note, and a dead worker labels it "interrupted". The hook is careful never to promise background work that provably will not happen. (Notable.)
- **A failed work-list write skips the spawn entirely.** Starting a worker that cannot find its work list would make the user wait out the whole budget for a result that can never come. (Notable.)
- **An asynchronous spawn failure is reported through the result file, not the return value.** The common failures — a missing runtime, a permissions error — surface on the child's error event after the spawn call has already returned success, so the callback publishes a terminal result and the poll loop exits on its next tick. (Surprising; the boolean return only covers synchronous failures.)
- **Unlike the sync-on-push and manual-disable gates, the push-disabled gate still records the commits.** It sits *after* the queue write, so the backlog survives and the re-enable drain flushes it. The other two gates return before anything is written. (Notable; the ordering is the difference between "we'll catch up later" and "this push was never seen".)
- **A push-disabled repo prints one of two different notices, and the choice is a safety decision.** The hook reads the state rather than the boolean precisely so it can tell "the user opted this repo out" apart from "the setting file could not be read" — the gate fails closed, so an unreadable store reports disabled for every repo on the machine. Only the genuine opt-out gets the enable hint; on a corrupt store that command rebuilds from empty and drops every repo's opt-out. The most unmissable notice in the product must not be the one that recommends the destructive recovery. (Surprising; the same condition yields two notices on purpose.)
- **The manual-disable gate outranks the sync-on-push opt-out and masks it.** The repo-wide flag is read before configuration is loaded, so on a disabled repository the sync-on-push setting is never consulted at all. (Notable; a deliberate priority ordering.)
- **This hook always drains its standard input, even when it is going to do nothing.** The read happens at the entry point, before the gates. The post-rewrite hook is the deliberate contrast: its gate precedes its own read, so a disabled repository leaves that hook's rewrite mapping unread. Both are correct for their own pipe — pre-push must release git promptly — but "the hook drained its input" is not a signal that it did any work. (Surprising; the two differ on purpose.)
- **A brand-new remote branch uses a "not on any remote" enumeration, not a range.** A two-dot range against the all-zero remote id would error, so the hook falls back to everything reachable locally that no tracked remote already has. (Surprising; intentional.)
- **The signed-out preview is deadline-bound, not just capped.** Each candidate costs a storage read and a first push of a large branch can carry thousands of memory-less hashes, so the scan stops at the deadline and flags "more" rather than grinding on until the hard-exit timer kills the process. (Notable.)

## Shared Behavior

- The pending queue file, its fields, the stale prune, the queue lock, and the claim-based drain the worker runs are defined by the Push-Pending Queue and Drain Engine topic.
- The work-list / result / liveness files, the watch loop, the note-to-reason mapping used for the fallback tail, and the guarantee that a complete result covers every requested hash are defined by the Pre-Push Worker Result Handoff topic.
- The worker process, its two modes, and the shared detached-spawn trigger (detached, hidden, streams ignored, unref'd, with its own resolution of the worker script) are defined by the Push-Pending Compensation Retry topic.
- The repo-wide manual-disable flag read at step 3 — its storage, anchoring, priority, migration, and the fact that the worker carries the same gate independently — is defined by the manual-disable topic.
- The per-repo outbound-push opt-out read at step 9, the state form it returns, its fail-closed rule, and the policy behind the two notices are defined by the Per-Repo Outbound-Push Control topic.
- Installation of the hook file (markers, chaining, prior-exit-status preservation) is defined by the git-shell hook installation topic.
- The single-commit personal-space upload contract and its typed error taxonomy are defined by the summary-push topics.
