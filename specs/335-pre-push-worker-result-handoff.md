# 335. Pre-Push Worker Result Handoff

## Topic Statement

The file-based request / result / liveness protocol by which the git pre-push hook hands one push's commits to a detached sync worker and then watches it: the worker republishes a partial outcome after **every** settled commit, then back-fills and publishes a final one the hook stops watching on.

## Scope

**In scope:**

- The push identifier, where it comes from, and why uniqueness is not enforced here.
- The three per-push artifacts — a work list, a result, and a liveness lock — their naming, their directory, and their write discipline.
- Clearing stale artifacts when a push identifier is reused.
- Validation on reading the work list and the result, and why a malformed file must not degrade into "nothing to do".
- The result contract: partial republication after every settled commit, what the complete flag does and does not guarantee, and the short-circuit note.
- Back-filling an outcome for every requested hash the drain never reported on, including the one case that is a success rather than an anomaly.
- Turning a drain's short-circuit note into a user-facing reason.
- The watch loop, its poll cadence, its three endings, and the ordering that makes each ending honest.
- Lock acquisition before any other work, and release only after the terminal result exists.
- Why nothing is deleted on completion, and how the artifacts eventually disappear.

**Boundaries (consumed here, owned elsewhere):**

- The pre-push hook that mints the identifier, writes the work list, spawns the worker and renders the result is defined by the Git Pre-Push Hook topic.
- The worker process — its mode selection, its runtime ceiling, its raised request timeout, its unfiltered confirmed tail pass — is defined by the Push-Pending Compensation Retry topic.
- The drain that produces the per-commit outcomes and the short-circuit notes, and the outcome record's own fields, are defined by the Push-Pending Queue and Drain Engine topic.
- The **per-commit capture progress stream** and its per-hash liveness lock live in the same directory and are swept by the same pass, but are an entirely different stream with a different producer and consumer; they are defined by the Post-Commit Capture Progress Streaming topic. Only the age-based sweep and the directory are shared.
- The process-id liveness primitives (writing an owner id, reading it back, owner-guarded release, probing whether a process is alive) are defined by the lock-primitive topic.

## Data Contracts

### The push identifier

The hook mints one identifier per push: the **ambient trace identifier** when one is set for the process, otherwise a fresh random identifier. Uniqueness is therefore a property of how the identifier was obtained, **not** something this protocol enforces — which is why writing a work list first clears the other two artifacts for that identifier (below).

### Where the artifacts live

All three files sit in the same per-project progress directory the commit-capture stream uses, named by the push identifier: a **work list**, a **result**, and a **liveness lock**. That directory was chosen because the repository is writable by anyone who can push to it, and because each worktree gets its own copy for free.

### The work list

Written by the hook, read by the worker. Carries the push identifier and the commits of **this** push, in push order.

Reading validates the identifier round-trips, that the hash list is an array, and that every element is a non-empty string. Anything else reads as absent. Validation matters because a malformed work list would otherwise degrade into "no eligible entries", which is indistinguishable from a legitimately empty push.

### The result

Written by the worker, polled by the hook. Carries:

- the push identifier;
- the per-commit **outcomes settled so far**, in **completion order — not push order**;
- a **complete** flag: false while the drain is still running; true means nothing more is coming;
- an optional **note**, set when the run short-circuited (not signed in, push disabled, nothing eligible, and so on).

Reading validates the identifier round-trips and that the outcome list is an array; anything else, including a file that does not exist yet, reads as absent.

**Nothing validates coverage.** Full coverage of the requested hashes is produced by ordering alone — the back-fill runs immediately before the terminal publication of a drain run — and only on that path: the two terminal results published *instead of* running a drain carry an **empty** outcome list plus a note, as does the one the hook publishes on its own behalf when the spawn fails. So the hook must not assume a complete result mentions every hash; it labels any hash the result omits from the note, and never as "still syncing", which would be false once the worker has exited.

### The liveness lock

A file whose body is the worker's process id. A watcher's verdict:

- **present and its owner is not alive** → the worker was killed and will never publish again;
- **absent** → **not** dead (the worker may not have started yet, or may have finished and released);
- **present and alive** → still working.

Release is owner-guarded, so a stale release can never delete a live lock.

### Write discipline

- The work-list write **throws** on failure. That is the signal the hook uses to skip the spawn entirely rather than start a worker that cannot find its work.
- The result write is **best-effort**: a result nobody reads changes nothing about the push that already happened, so a write failure must never break the worker's own accounting.
- The lock write is best-effort; only the liveness probe degrades if it fails.
- Every published file is written **temp-then-rename**, and every reader treats a missing or torn file identically — as "not published yet" — so a reader that catches a rename in flight simply polls again.

### Poll cadence

The watch polls every **200 ms** by default.

## Behavior

### Publishing the work list (hook side)

1. Ensure the progress directory exists.
2. **Remove any result and any lock left for this same push identifier**, unconditionally.
3. Write the work list atomically.

Step 2 is the entire defence against a reused identifier, and nothing else here would catch the reuse: a leftover *complete* result reads as this push's own outcome — announcing commits this push never sent — and a leftover lock owned by a dead process reports this push's worker as interrupted before it has even started. Clearing both puts a reused identifier on the same blank slate a fresh one gets.

### Worker side, in order

1. **Acquire the liveness lock first**, before anything else. Everything below it — reading a repo-wide flag through a subprocess, statting a directory for the sweep — takes long enough that a crash in between would be invisible to the hook's probe and cost it a full budget wait.
2. Publish a **terminal** result when the repository is manually disabled (note: repository disabled) and return. A silent exit here would leave the hook polling until its deadline and then announcing background work that will never happen.
3. Read the work list. If it is absent or carries no hashes, publish a **terminal** result (note: work list missing) and return.
4. Run the drain, publishing a **non-complete** result after **every** settled commit. That per-commit republication is the point of the protocol: one commit's push is a chain of requests (each attachment, then the summary), so a large push settles gradually and a hook that gives up at its deadline can still print what landed.
5. When the drain returns, keep its short-circuit note. When the drain **throws**, keep the error message as the note instead — the run is over either way and the hook still needs something to label the unreported hashes with.
6. **Back-fill** every requested hash the drain never reported on (below).
7. Publish the **terminal** result carrying the note.
8. **Release the lock only after that terminal result exists** (in a cleanup block). A hook that saw the lock gone while no complete result was published would report a finished run as interrupted.

### Back-filling unreported hashes

If every requested hash already has an outcome, do nothing.

Otherwise re-read the pending queue to learn which hashes are still waiting. A **failed** read leaves that knowledge unavailable, and the back-fill then falls back to the note-derived reason for every hash — never to a false "already synced".

For each hash with no outcome:

- **Known to have left the pending queue** → record it as **published, with no article URL**. A hash that is gone was drained by someone else, or by an earlier run: that is a success, not an anomaly, and saying otherwise would send the user to the debug log over nothing. This process simply never held the article id.
- **Otherwise** → record it as **deferred**, with the reason derived from the note.

### Note-to-reason mapping

The drain's short-circuit notes are machine-ish; the hook prints prose. The mapping is shared by the worker (for the back-fill) and the hook (as its fallback wording for a hash with no outcome):

| Note | Reason shown |
| --- | --- |
| not signed in | not signed in to Jolli |
| push disabled for this repo | outbound push disabled for this repo |
| syncOnPush disabled | push sync is turned off |
| all entries claimed by another process | another sync is already handling this commit |
| push not confirmed | push not confirmed on the remote |
| no pending entries *or* no eligible entries | nothing left to sync |
| *(no note at all)* | not reached — see the local debug log |
| *(anything else)* | the note itself, verbatim |

The absent-note case deliberately does **not** mean "fine": every known short-circuit sets a note, so an unreported hash with no note is an anomaly worth pointing at the log for. The one benign case — a hash that left the pending queue entirely — is handled by the back-fill *before* this mapping is consulted.

### The watch loop

Repeat:

1. Read the result; remember it if present. The **last** result seen is always returned, even on a non-complete ending, so the caller can print whatever settled before it gave up.
2. If the latest result is **complete** → end as **complete**.
3. If the deadline has passed → end as **timeout**.
4. If the worker is probed **dead** → end as **worker-dead**.
5. Sleep one poll interval and repeat.

The liveness probe runs **after** the result read on every iteration, so a worker that publishes its final result and exits in the same tick is reported as complete rather than dead.

### Cleanup

Nothing is deleted when a push finishes. A force-killed worker never reaches a cleanup step anyway, and deleting right after a write would race the hook's next poll and turn an early exit into a full-budget wait. The artifacts are instead swept by the shared age-based prune over this directory, which covers the work list and result files, the lock, and any temp file left by a process that died between writing and renaming.

## State Transitions

### The liveness lock

| From | Event | To |
| --- | --- | --- |
| absent (or cleared by a work-list write) | worker starts | present, owner = worker |
| present, owner alive | terminal result published | released (owner-guarded) |
| present, owner dead | observed by the watch | ends the watch as **worker-dead** |
| present, any owner | new work list written for the same identifier | removed |

### The result

| From | Event | To |
| --- | --- | --- |
| absent | worker publishes after the first settled commit | present, not complete |
| present, not complete | each further settled commit | republished with one more outcome |
| present, not complete | drain returns or throws, back-fill applied | present, **complete**, one outcome per requested hash |
| absent | repository disabled, or work list unusable | present, **complete**, empty outcome list, note set |
| absent | spawn failed asynchronously | present, **complete**, empty outcome list, note names the spawn error *(written by the hook's own spawn-error callback)* |
| present, any state | new work list written for the same identifier | removed |

### The watch

| From | Condition | To |
| --- | --- | --- |
| polling | a complete result is read | **complete** (with that result) |
| polling | deadline reached | **timeout** (with the last result seen, if any) |
| polling | lock present and its owner gone | **worker-dead** (with the last result seen, if any) |

## Notable Behavior

- **A complete result is a stopping signal, and its coverage rests on ordering alone.** The hook stops watching the moment it sees one, so the back-fill is placed immediately before the terminal publication of a drain run to give every requested hash an outcome. Nothing checks that it did, and the terminal results published without running a drain carry no outcomes at all — which is why the hook keeps a per-hash fallback wording for the complete ending too. (Notable; load-bearing.)
- **Publishing the work list destroys the other two artifacts for that identifier.** The identifier is often the ambient trace identifier, so reuse is possible and nothing else would catch it: a leftover complete result would be read as this push's outcome, and a leftover dead lock would report this push's worker as interrupted before it started. (Surprising; the clear is a correctness step, not tidiness.)
- **The work-list write throws while the result write does not.** They fail in opposite directions on purpose: without a work list there is nothing to run, so the hook must learn immediately and skip the spawn; a result nobody can read changes nothing about a push that already happened. (Notable.)
- **A hash the worker never mentioned is treated as a success when it has left the pending queue.** It is recorded as published with no article URL — the commit really is synced, this process just never held the article id. Every other unreported hash is deferred with a reason derived from the run's note. (Surprising; the one benign gap.)
- **A failed re-read of the pending queue falls back to the note, never to "already synced".** The optimistic answer is the dangerous one here, so the ambiguous case takes the pessimistic branch. (Notable.)
- **The lock is taken before the disable check and before the sweep.** The work between process start and lock acquisition is invisible to the hook's probe, so anything slow placed ahead of the lock turns a crash into a full-budget wait for the user. (Surprising; ordering is load-bearing.)
- **The lock is released only after the terminal result exists.** Releasing first would let a hook that polls in between see "no lock, no complete result" and report a finished run as interrupted. (Notable.)
- **The deadline is checked before the liveness probe, so a worker that dies exactly at the deadline is reported as a timeout.** The caller then prints its "still syncing in the background" wording for a worker that is already gone. The ordering is what guarantees the opposite, more common case is right — a worker that publishes and exits within one poll interval reads as complete — and both orderings cannot be had at once. (Surprising; a real, accepted mis-report at the boundary.)
- **Outcomes are published in completion order, and the protocol says so.** The drain settles commits concurrently, so any caller that wants push order must re-order them itself against its own request list. (Notable.)
- **Nothing is deleted on completion.** A killed worker leaves its files behind regardless, and deleting immediately after a write would race the hook's next poll — so the age-based sweep over the shared progress directory is the only reaper. (Notable.)
- **A missing or torn file is indistinguishable from "not published yet", by design.** Every read is a parse-or-nothing, and the writer renames into place, so the watch simply polls again. (Notable.)

## Shared Behavior

- The hook that mints the identifier, writes the work list, spawns the worker, watches, and renders the three endings is defined by the Git Pre-Push Hook topic — including the spawn-error callback that publishes a terminal result on its behalf.
- The worker's mode selection, runtime ceiling, and confirmed unfiltered tail pass are defined by the Push-Pending Compensation Retry topic.
- The per-commit outcome record (status, article URL, reason), the short-circuit notes mapped above, and the drain that emits them are defined by the Push-Pending Queue and Drain Engine topic.
- The progress directory, its age-based sweep, and the separate per-commit capture stream and per-hash lock that share it are defined by the Post-Commit Capture Progress Streaming topic.
- The owner-id lock primitives and the process-liveness probe are defined by the lock-primitive topic.
