# 270. Push-Pending Compensation Retry

## Topic Statement

A best-effort, fire-and-forget catch-up that, whenever a Jolli Memory surface activates, the user signs in, or a repo's outbound push is re-enabled, retries **every** commit still waiting in the push-pending queue — with no hash filter — by spawning the same detached sync worker the pre-push hook uses, in the worker's unfiltered mode.

## Scope

**In scope:**

- The compensation occasion (surface activation, sign-in, and push re-enable) as a distinct occasion from the git-push occasion and the queue-drain follow-up.
- The unfiltered, fire-and-forget contract: retry everything pending, never throw, no-op cleanly when there is nothing to do, when the user is signed out, or when the repository is manually disabled.
- The **shared detached-spawn trigger**: its trigger tag, its optional extra arguments, its spawn-error callback, its boolean return, and the backlog pre-check it deliberately skips when extra arguments are present.
- How the worker script is located, including the development fallback that preserves the process boundary.
- The worker's **two modes**, which drain options each selects, and the runtime ceiling / hard-exit grace / raised request timeout that bound both.
- The confirmed, unfiltered **tail pass** that only the pre-push mode runs, and what it exists to finish.
- The repo-wide manual-disable gate's placement inside the worker rather than inside the drain engine, and what that placement implies for the other occasions.
- The invoking surfaces and the trigger tag each supplies.

**Boundaries (consumed here, owned elsewhere):**

- The queue file, the queue lock, and the claim-based drain this worker calls (its gates, eligibility, confirmation, claiming, upload and retry accounting) are defined by the Push-Pending Queue and Drain Engine topic. This spec owns only *when and how* a drain is kicked off, and which options each mode passes.
- The pre-push hook that records the commits, writes the work list and watches, is defined by the Git Pre-Push Hook topic; the request / result / liveness protocol between it and this worker is defined by the Pre-Push Worker Result Handoff topic.
- The queue-drain follow-up occasion (drain the hashes just summarized) is defined by the git-operation queue-worker topic.
- The JetBrains-side specifics — its own pre-check, its spawn, and its bounded-blocking variant — are defined by the JetBrains pre-push sync catch-up topic.
- The repo-wide manual-disable flag's storage, anchoring, priority and migration are defined by the manual-disable topic.

## Data Contracts

### The shared spawn trigger

Inputs: the host repository's working directory; a **trigger tag** identifying the invoking surface and occasion (defaulting to the activation tag, and used only for logging); optional **extra arguments** appended to the worker's command line; and an optional **spawn-error callback**.

Return value: a boolean reporting **synchronous** failure only — no worker script found, or the spawn call itself throwing. The common failures (a missing runtime, a permissions error) surface **asynchronously** on the child's error event, which is what the callback is for; the pre-push caller uses it to publish a terminal result so its poll loop exits on the next tick instead of waiting out its whole budget.

**The backlog pre-check is skipped whenever extra arguments are present.** With no extra arguments (every compensation caller) the trigger returns early, without spawning, when the queue file is absent — the file is unlinked when empty, so mere existence means there is at least one entry to try, and the common "nothing pending" path pays no process-spawn cost. With extra arguments (the pre-push caller, which passes a push identifier) the check is skipped deliberately: the hook has just written those entries, and a stat race must not silently drop the spawn.

Nothing here throws. A missing worker script, an absent runtime, a non-git directory, or an offline network just leaves the entries for the next occasion, logged at debug.

### Locating the worker

The built worker script beside the trigger module is preferred. Failing that, the **source** file is used, launched with the current process's own runtime loader arguments — so running the CLI from source under a TypeScript runner keeps the compensation process boundary instead of silently falling back to in-process work. If neither exists, no spawn happens and the trigger reports failure.

### Spawn shape

Detached, hidden, standard streams ignored, working directory set to the project directory, and unref'd so the caller can exit. The command line always carries the working directory and the trigger tag, plus any extra arguments. An ambient trace identifier, when the calling process has one, is propagated to the child through the environment.

### Mode selection

The worker chooses its mode from whether a **push identifier** argument is present:

- **Pre-push mode** (identifier present) — drains that push's commits.
- **Compensation mode** (identifier absent) — drains whatever is pending.

The worker also accepts an explicit working-directory argument, so an external orchestrator can run the compensation mode directly rather than through the trigger.

### Ceilings

- **Runtime ceiling: 3 minutes** — a start gate on new commit pushes, not a cancellation. Commits already in flight run to completion; the rest stay pending. It covers the tail pass too, so that pass cannot run just as long right after the scoped pass gave up.
- **Hard-exit grace: 90 seconds** on top of the ceiling, arming an unref'd last-resort timer that force-exits with success. Sized to let one in-flight request finish and write back, since the ceiling stops new pushes but never cancels running ones.
- **Request timeout: 60 seconds** — double the client default, and deliberately one third of the runtime ceiling so a single stuck request cannot swallow most of the run's budget. Nothing is waiting on this process, and an aborted request is the expensive failure: the server may already have minted an article id that the abort discards, making the next attempt create a duplicate.

## Behavior

### The compensation occasion

Distinct from the other occasions that reach the drain engine:

- **Git-push occasion** — fires on a push, records the just-pushed commits, and (when signed in) hands them to this same worker in its pre-push mode.
- **Queue-drain follow-up** — fires after summaries are generated, draining only the just-generated hashes, so a push that outran memory generation completes once the memory lands.
- **Compensation occasion (this topic)** — fires on surface activation, sign-in, and on re-enabling this repo's outbound push, and drains **everything** pending. It is the safety net for entries none of the other occasions completed: a push made while offline or signed out, a push whose worker was killed or ran out of runtime budget, and entries deliberately *held* while the repo's outbound push was off.

### Compensation mode

1. **Repo-wide manual-disable gate**, as the worker's first statement. When set, log one line and return: the queue file is never read, the queue lock is never taken, no network call is made, and no entry is touched. Every surface's spawn is therefore inert on a disabled repository, which is why no surface needs its own pre-check.
2. Otherwise run the drain tagged with the **activation** source and **no hash filter**, with the remote-confirmation gate and orphan deletion both **on**.
3. Log the run's counts (attempted / published / failed) and any short-circuit note.

### Pre-push mode

Runs the drain scoped to the work list's hashes with the confirmation gate and orphan deletion both **off**, the runtime ceiling as its start gate, the raised-timeout client, and a per-commit settled callback that republishes partial progress. It carries its own copy of the manual-disable gate, and its result-publishing, lock ordering and back-fill are defined by the Pre-Push Worker Result Handoff topic.

Three things differ from the compensation drain, all deliberate:

- **No remote-ref confirmation** — git has not transferred objects yet, so the check would refuse every entry.
- **No orphan deletion** — same reason: if the push is then rejected, deleting the old articles would leave the remote history intact with its memories gone, and the pending entry that could restore them already removed.
- **A ceiling on starting new pushes rather than on the run**, plus the longer request timeout. Nothing here is ever cancelled mid-flight, because aborting throws away an article id the server may already have minted.

### The confirmed tail pass (pre-push mode only)

After the terminal result is published and the liveness lock released, the worker runs **one more drain** — unfiltered, with the confirmation gate and orphan deletion back **on**, the same raised-timeout client, and the same runtime ceiling as its start gate. It is skipped entirely when the ceiling has already been reached, and every failure is swallowed: the scoped pass is already published and must not be undone by a problem in this best-effort tail.

By this point git has finished transferring, so confirmation can succeed, and two things nothing else would reach get finished:

- the **orphan cleanup the scoped pass deferred** — those entries were kept as patches rather than deleted, and only a confirmed drain may delete remote articles;
- any **backlog left by earlier pushes**.

Without it, deferred cleanup would wait for an activation trigger, which a pure command-line user may not hit for days — long enough for the stale prune to drop the entries and strand the articles. A rejected push simply fails confirmation and everything stays pending, which is exactly what makes deferring safe in the first place.

### Failure policy

Any error escaping either mode is logged and the process exits with **success**: this is a background sync and must never look like a failure.

### Invocation surfaces

| Surface | Occasion | Trigger tag |
| --- | --- | --- |
| Command line | the enable command | a CLI-enable tag |
| Command line | a successful sign-in | a CLI-sign-in tag |
| Command line | the guided front door, after wiring is complete | a front-door tag |
| Editor extension | activation, after storage is initialized | an activation tag |
| Editor extension | immediately after a successful sign-in | a sign-in tag |
| JetBrains plugin | plugin startup, and its sign-in follow-up | **none supplied** — the worker falls back to its default activation tag |
| Any surface's push-control toggle | re-enabling outbound push for the current repo | a re-enable tag |
| Git pre-push hook | a push, when signed in | a pre-push tag, **plus** the push identifier that selects pre-push mode |

Initialization-before-spawn matters for the editor extension: the drain needs an active storage backend to read summaries. The sign-in occasions are the ones that catch up commits pushed *while signed out*, whose hook recorded intent but never spawned a worker.

### The re-enable occasion

Turning outbound push back **on** for a repo writes the flag and then kicks the same worker with the re-enable tag. Everything else is identical to the activation occasions: same worker, same activation drain source, no hash filter, same cheap backlog pre-check.

Two consequences worth stating explicitly:

- **The re-enable drain is exported separately from the flag write**, so a surface that knows the repo's *identity* rather than a path — a machine-wide push-control list — can write by identity (the key the user actually clicked) and still get the drain, without the flag-writing path re-deriving the target from a working-tree path as a second, disagreeing source of truth. Such a list therefore drains only when the clicked row **is** the current workspace repo; re-enabling a *foreign* repo by identity writes the flag and nothing else, and that repo catches up on its own next activation or push.
- **This occasion is exactly why the drain's mid-run holds must release their claims.** It is a single detached pass with no retry of its own, so an entry still carrying a fresh claim from the run that held it would be skipped and wait for an unrelated later trigger — defeating the catch-up the toggle exists to provide.

## State Transitions

### A pending entry, from the compensation trigger's view

| From | Condition | To |
| ---- | --------- | -- |
| pending, repository manually disabled | trigger fires | unchanged — the worker returns before the drain is called at all; the queue file is not even read |
| pending, signed out | trigger fires | unchanged (the drain no-ops on its sign-in gate) |
| pending, sync-on-push disabled | trigger fires | unchanged (the drain no-ops on that gate) |
| pending, outbound push disabled for this repo | trigger fires | unchanged — the drain no-ops on its per-repo gate and reports the push-disabled note; entries are deliberately **kept** so the re-enable occasion catches them up |
| pending, held by a mid-run outbound-push hold | **re-enable** trigger fires | claimed and published (the hold released the claim precisely so this pass can re-claim it) |
| pending, signed in, confirmed, has memory | trigger fires | published then deleted (by the drain) |
| pending, signed in, memory not yet generated | trigger fires | left pending (the drain releases the claim) |
| pending, retry-exhausted or stale | trigger fires | untouched by this run; ages out via the stale prune |
| none pending | trigger fires | no-op — the surface skips the spawn entirely, per the shared pre-check |

## Notable Behavior

- **One worker binary serves two very different jobs, selected by a single argument.** With a push identifier it is the pre-push publisher — scoped, unconfirmed, cleanup-deferring, result-publishing. Without one it is the compensation drain — unscoped, confirmed, cleanup-performing, silent. Everything else, including the spawn trigger, is shared. (Notable.)
- **The pre-push spawn skips the backlog pre-check that every other caller relies on.** The check exists to avoid a spawn when nothing is pending, but the pre-push caller has just written those entries, so a stat race there would silently drop the whole push's sync. The presence of extra arguments is what distinguishes the two callers. (Surprising; the pre-check's absence is deliberate, not an omission.)
- **The boolean return does not mean the worker started.** It reports only synchronous failures; a missing runtime or a permissions error arrives later on the child's error event, which is why the trigger takes a callback at all. A caller that treats the boolean as proof of a running worker will wait out its whole budget on a spawn that never happened. (Surprising; load-bearing for the pre-push watch.)
- **The tail pass is the only thing that finishes deferred orphan cleanup for a command-line-only user.** Nothing else runs a *confirmed* drain after a push, and the deferred entries would otherwise sit until an activation trigger that may never come, then age out and strand the articles. (Notable.)
- **The runtime ceiling gates starts, never cancels, and the grace timer is sized for that.** A ceiling that cancelled in-flight requests would throw away article ids the server had already minted, which is the failure the whole per-commit path exists to avoid — so the grace is long enough for one full request to finish and write back. (Notable.)
- **This is the occasion that rescues signed-out and offline pushes.** A push made while signed out records intent and spawns nothing; a push made offline spawns a worker whose requests fail. Neither the git-push nor the queue-drain occasion completes them — the activation / sign-in retry does. (Notable; the whole point of the trigger.)
- **There is an occasion here that is not an activation.** Re-enabling a repo's outbound push spawns the identical worker with its own tag. It is easy to miss because it originates in the push-control core rather than in any surface's startup path, yet it is the only occasion that exists to flush entries the product itself deliberately withheld. (Notable.)
- **Unfiltered by design.** Unlike the queue-drain follow-up, which is scoped to the hashes just summarized, the compensation retry considers every eligible entry, because on a fresh session it has no knowledge of which specific commits are outstanding. (Notable.)
- **Never blocks activation.** The trigger is fire-and-forget and fully guarded; activation, sign-in, and the enable command never wait on it and never fail because of it. (Notable.)
- **Idempotence comes from the drain, not the caller.** Beyond the shared backlog-existence skip, the trigger does no pre-checks; the drain's own gates (nothing pending / opt-out / signed out) make repeated invocation safe. (Notable.)
- **The manual-disable gate lives in the worker, not in the drain.** It is the worker's first statement in either mode, so a disabled repository makes the whole spawn inert — no queue read, no lock, no network. Placing it there rather than in the drain means the queue-drain follow-up does not inherit it; that occasion is covered because the generating worker itself is already gated. No surface needs a manual-disable pre-check of its own. (Surprising; the gate's location is what lets every surface stay ignorant of it.)
- **The development fallback preserves the process boundary rather than falling back to in-process work.** Running from source relaunches the source file with the current runtime's own loader arguments, so the detached-child semantics hold in development exactly as they do from a build. (Notable.)
- **One surface supplies no trigger tag at all** and is therefore logged under the default activation tag, indistinguishable in the log from any other default-tagged spawn. The tag is logging-only, so nothing else is affected. (Notable.)

## Shared Behavior

- The queue file, the queue lock, and the claim-based drain (its gates, eligibility, confirmation, claiming, upload, holds and retry accounting) are defined by the Push-Pending Queue and Drain Engine topic. The manual-disable gate is deliberately *not* part of that drain.
- The pre-push hook occasion — recording the commits, writing the work list, spawning this worker in pre-push mode, and watching — is defined by the Git Pre-Push Hook topic; the file protocol between them is defined by the Pre-Push Worker Result Handoff topic.
- The queue-drain follow-up occasion is defined by the git-operation queue-worker topic.
- The repo-wide manual-disable flag the worker reads before either drain is defined by the manual-disable topic.
- The per-repo outbound-push opt-out whose re-enable is one of these occasions — its store, its identity keying, and the surfaces that toggle it — is defined by the Per-Repo Outbound-Push Control topic. The mid-run held outcome this occasion exists to flush, and the claim-release rule that makes flushing possible, are defined by the drain-engine topic.
- The JetBrains-plugin specifics (its own pre-check, spawn, and bounded-blocking variant) are defined by the JetBrains pre-push sync catch-up topic.
