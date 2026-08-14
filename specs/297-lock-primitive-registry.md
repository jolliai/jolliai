# 297. Lock Primitive Registry

## Topic Statement

Every mutually-exclusive critical section in the product is guarded by an advisory file lock built on one shared on-disk convention, and each lock is characterised by three independent choices: where its file lives (which decides what it actually serialises), how long a contender waits for it, and — most consequentially — whether failing to acquire it aborts the guarded work or merely degrades to running unlocked.

## Scope

**In scope:**

- The shared on-disk convention every lock uses: the ownership record, the freshness signal, the staleness ceiling, early reclamation of a dead owner's lock, and ownership-checked release.
- The location scopes a lock can have (per-worktree, shared across every worktree of one repository, machine-global for one user, and per-configured-vault filed in the machine-global directory) and what each therefore serialises.
- A complete catalogue of the product's locks: file name, location scope, default wait budget, and failure discipline.
- The one lock that has **two callers with opposite busy disciplines against the same budget**, which is the axis this topic owns.
- The one lock that does not use the shared convention at all, and what it drops by re-implementing it.
- The **strict** versus **best-effort** failure discipline, which locks have which, and why the distinction is load-bearing rather than stylistic.
- Per-lock constraints that cannot be expressed by the primitive itself: the pair that must never be held simultaneously, the non-re-entrancy rule and the **one lock that is now re-entrant** (together with the call-chain registry that makes it so, and what breaks in both directions when a caller takes that lock without registering), the one lock whose best-effort form now has no callers, and the one **documented writer that bypasses its lock entirely**.

**Out of scope (boundaries):**

- What each guarded critical section actually does — those belong to their own topics (queue draining, orphan-branch writes, Memory Bank sync rounds, the folder-tree tidy-up, the plan/note registry, the pending-push ledger, the repository profile, hook installation, the runtime registry, the machine-global repository registry).
- The per-vault write lock's path canonicalisation, acquired-handle interface, heartbeat cadence, hold windows, cross-repository waiter registry and diagnostic probe. Only its catalogue row and its two-discipline anomaly are described here.
- Coordination artifacts that are **not** mutual-exclusion locks even though they sit beside these files and share the ownership-record convention: the display-only ingest phase marker and the per-commit capture-progress ownership file that a progress watcher probes to detect a dead producer. They are described where their consumers are.
- In-process synchronisation of any kind. Every lock here is a filesystem artifact, so it serialises separate processes as well as separate asynchronous flows inside one process.

## Data Contracts

### The lock file

A lock is a single regular file whose *existence* means "held". Its contents are the owning process's numeric identifier in plain ASCII. Its modification time is the freshness signal.

Nothing else is recorded — no owner name, no acquisition purpose, no nesting depth. A lock file is therefore readable and removable by hand, which is the intended escape hatch when a machine is left with a wedged lock.

### Acquisition

A contender repeatedly attempts an exclusive create until it succeeds or its **wait budget** expires, sleeping a per-lock **poll interval** between attempts. A few locks are deliberately fail-fast: they make exactly one attempt and never poll.

An existing lock file is **reclaimed** — deleted, and the attempt retried — when either of the following holds:

- its modification time is older than the shared staleness ceiling of five minutes; or
- the process identifier it records is no longer alive.

The second condition exists so a force-killed holder does not block contenders for the full five minutes. A holder that legitimately runs longer than the ceiling (a long queue drain, a long ingest, a long sync round) periodically refreshes its own modification time to avoid being reclaimed while still working; the ceiling is deliberately set to more than twice the longest such heartbeat interval.

A holder whose owning process cannot be signalled because it belongs to another user is treated as alive. The product will wait rather than steal a lock it cannot prove is dead.

### Release

Release reads the lock file, compares the recorded process identifier against the releasing process's own, and removes the file **only if they match**. Without that check, a holder whose lock was stale-reclaimed could delete the reclaimer's freshly-acquired lock on its way out and reopen the concurrent-access window it was supposed to close.

A contender that did not acquire the lock never releases it, even on the best-effort paths where it ran the guarded work anyway.

### Location scopes

Where the file lives is what decides what is actually serialised. Four scopes exist:

- **Per-worktree** — inside the per-project state directory of the specific working tree. Two working trees of the same repository never contend. Correct when the guarded state is itself per-worktree.
- **Shared across worktrees** — inside a state directory rooted at the repository's common git directory, so every working tree of the same repository, and every surface operating in any of them, resolves to the same file. Correct when the guarded state is repository-wide rather than worktree-wide. When the location cannot be resolved (not inside a repository, or git unavailable), it falls back to the per-worktree directory — single-worktree behaviour is then unchanged, and multi-worktree serialisation is simply unavailable.
- **Machine-global** — inside the per-user state directory. One file for the whole machine, across every repository and every install surface.
- **Per-configured-vault, filed machine-globally** — the file lives in a fixed subdirectory of the per-user state directory, but its *name* is derived from a hash of the canonicalised path of a user-configured directory, so one file exists per such directory rather than one per machine. This scope exists for exactly one lock, and the reason it is not simply "inside the directory it guards" is that its earliest holder must acquire **before** any code that touches that directory's own state runs; a lock inside it would not exist in that window. The canonicalisation is the whole correctness story — two parties that spell the same directory differently (a relative path, a symlink, a case variation on a case-insensitive filesystem) must hash to one file, and two parties that spell different directories must not. That canonicalisation belongs to the lock's own topic and is not restated here.

## Behavior

### Failure discipline: strict versus best-effort

This is the single most important axis of the catalogue, and the two disciplines are opposites.

**Best-effort.** If the wait budget expires, the lock is reported as not held, a warning is logged, and **the guarded work runs anyway, unlocked**. Release is skipped. The rationale is that the guarded writes must never be silently dropped: each of these critical sections is a sub-millisecond read-modify-write of a small state document, whose writers additionally re-read near the write and merge per key, and whose file writes are atomic. Losing the lock therefore narrows to a small residual lost-update window rather than a correctness failure, and dropping the write entirely would be worse than taking that window.

**Strict.** If the wait budget expires, the lock is reported as not acquired and **the guarded work does not run at all**. There is no unlocked fallback and no partial progress. The rationale is the mirror image: these critical sections make *durable lifecycle decisions*, so running one unlocked can silently reverse a decision the user made deliberately. An unlocked automatic hook re-installation racing a durable manual disable would re-enable a repository the user turned off; an unlocked runtime-registry reconciliation could leave the dispatch scripts describing one distribution while the registry names another.

Callers must therefore handle the two disciplines differently. A best-effort caller can ignore the outcome. A strict caller must branch on it, and every strict caller does — either surfacing a specific failure message to the user, or treating contention as a clean deferral to be retried on the next occasion.

### Catalogue

| Lock file | Location scope | Wait budget | Discipline |
|---|---|---|---|
| `worker.lock` | Per-worktree | Fail-fast (one attempt, no polling) | Acquisition result returned to the caller, which declines to start a second concurrent drain |
| `ingest.lock` | Per-worktree | Fail-fast (one attempt, no polling) | Acquisition result returned to the caller |
| `orphan-write.lock` | Shared across worktrees | Per-wrapper: 30 seconds for a write that must land, 1 second for a deferrable background write and for the general form's default, 15 seconds for the one sanctioned bare acquisition; all polled at 50 ms | Acquisition result returned to the caller, or converted by the wrapper — see below |
| `sync.lock` | Machine-global | 10 seconds, polled; callers may request a zero budget for a fail-fast attempt that must never block a user interface | Acquisition result returned to the caller |
| `plans.lock` | Per-worktree | 5 seconds, polled | **Best-effort** |
| `commit-selection.lock` | Per-worktree | 5 seconds, polled | **Best-effort** |
| `push-pending.lock` | Per-worktree | 5 seconds, polled | **Best-effort** |
| `sessions.lock` | Per-worktree | 5 seconds, polled | **Best-effort** |
| `config.lock` | Machine-global in production; explicit target directory in scoped operations/tests | 5 seconds, polled | **Best-effort** |
| `profile.lock` | Shared across worktrees | 5 seconds, polled | **Both disciplines exist over this one file** — see below |
| `repo-hooks.lock` | Shared across worktrees | 5 seconds, polled; automatic (machine-initiated) callers use a much shorter budget of a fraction of a second | **Strict** |
| `runtime-registry.lock` | Machine-global | 5 seconds, polled; automatic callers use the same shortened budget | **Strict** |
| `push-control.lock` | Machine-global | 5 seconds, polled at 25 ms | **Strict primitive, best-effort at its one call site** — see below |
| `repo-registry.lock` | Machine-global | 5 seconds, polled at 25 ms | **Best-effort** |
| `vault-<hash>.lock` | Per-configured-vault, filed machine-globally | Two named budgets plus a fail-fast mode: 60 seconds for a holder with queued on-disk work, 10 seconds for a holder that would rather yield; all polled at 100 ms | Acquisition result returned to the caller — and, uniquely, **two callers over one budget answer a miss oppositely**; see below |

The three oldest entries (`worker.lock`, `ingest.lock`, `orphan-write.lock`), the sync lock and the per-vault write lock are neither strict nor best-effort in the sense above: they hand the acquisition result back and let each caller decide. Every caller of the first four declines the work on failure; the per-vault lock is the one place where two callers make different choices. The strict/best-effort distinction applies to the wrappers that run a callback on the caller's behalf.

The parent directory of a lock file may not exist on a fresh install; every acquire path creates it on demand.

### The push-control lock is strict by shape and best-effort by use

`push-control.lock` guards the machine-global per-repo outbound-push store (`push-control.json`, spec 310) so a command-line toggle and an editor toggle of *different* repos cannot lose-update each other. It is machine-global like the runtime-registry lock, but deliberately a **separate file** so the two never contend.

Its wrapper returns the strict acquisition result — on timeout it runs nothing and reports "not acquired". But its **single** caller, the store's read-modify-write, then re-runs the same guarded function unlocked rather than propagating the failure. The net user-visible discipline is therefore best-effort, for the best-effort rationale above: the critical section is a sub-millisecond read-modify-write that re-reads inside the lock and ends in an atomic write, so contention narrows to a small residual lost-update window — whereas dropping the write would silently discard a toggle the user just clicked, which on the *disable* direction means the repo keeps pushing after the user turned it off.

This is worth stating explicitly because the shape and the behavior disagree: reading only the wrapper would classify this lock as strict, and a future second caller that forgets the fallback would silently start dropping toggles.

### The per-vault write lock is the first with two callers whose disciplines are opposites

Every other result-returning lock in the catalogue has one answer to a miss: the caller declines the work. The per-vault write lock is the first where that is not true, and the disagreement is not between budgets — it is between two callers that take **the same budget, milliseconds apart, on one user gesture**.

A user-initiated Refresh of the editor's Memory Bank tree runs two operations in sequence, each holding this lock for its whole body with the shorter yield budget:

- The **archival sweep** of the folders that hold nothing answers a full-budget miss by reporting that it archived nothing, **silently**. Its result is a list of folders it moved, so the miss is indistinguishable from a sweep that found nothing to move, and its caller suppresses the notification on an empty list. Under sustained contention the sweep therefore never runs and never says so.
- The **duplicate-folder consolidation** answers the same miss by raising a typed busy signal that reaches the user as "busy writing a summary right now — click Refresh again shortly".

The axis is not the budget, the location, or the guarded state — all three are identical. It is **whether the user asked for that specific operation**: the Refresh implies the re-listing, so a tidy-up may defer without comment; a merge the user confirmed through a modal may not, because a silent swallow would look like the confirmation did nothing. This is the sharpest available illustration of why discipline is the catalogue's third column rather than a property of the lock, and it is also the case that breaks the shortcut of inferring a discipline from a budget: a future reader who does that will infer the wrong one for one of the two.

Two further properties of these particular holders are worth recording here because they are lock-level, not operation-level. Both reach the lock through the body-style wrapper that acquires, heartbeats, runs and releases — and both **omit its optional release hook**, so neither drains the cross-repository waiter registry on release. A queue worker that timed out on this lock and recorded itself there survives both releases untouched. Nothing type-checks, tests, or logs the omission, because the wrapper is perfectly correct without the hook — just less useful to everybody else.

The contrast is **not** "every other holder passes the hook": the hook is passed by the queue worker's ingest write guard and the two compile write guards, while the worker's own summary drain calls the same drain by hand right after releasing, and the Memory Bank sync round's drain is **round-scoped rather than release-scoped** — a round-complete callback that fires after the whole round, not when this lock frees mid-round. The two editor-host spans are therefore the only holders that leave a recorded waiter untouched, but they are not the only ones without the hook.

### The dashboard spawn lock is REMOVED

`dashboard-spawn.lock` used to be the one entry in the catalogue that did not go through the shared primitive: same shape (a regular file whose existence means "held", holding the owner's numeric identifier, taken by exclusive create) but with no staleness ceiling, no freshness signal and an unconditional release. It existed for exactly one job — stopping two launchers from racing each other into two detached dashboard servers.

There are no launchers any more. `jolli dashboard` binds the port in its own process and serves until the user stops it, so two concurrent invocations are two ordinary listeners: the second finds the preferred port taken, moves to the next candidate, and says so. The failure the lock prevented — a second *background* server nobody can find, because both were competing to be named by one state record — cannot be constructed.

Nothing replaced it. Do not reintroduce a lock here on the strength of "two dashboards at once": that is now a supported outcome, not a race.

### The repository profile lock has two disciplines

One lock file, two access wrappers:

- A **best-effort** wrapper, whose timeout warns and proceeds unlocked. It has **no remaining callers** — every consumer moved to the strict form. It is retained only as an unused entry point; a future caller reintroducing it would silently reintroduce the lost-update window for durable lifecycle decisions.
- A **strict** wrapper, whose timeout runs nothing. All current readers and writers of the repository profile use this one.

The consequence of that migration is visible to users: a profile write that cannot take the lock now **fails** instead of racing. Most notably, recording the durable "leave this project alone" preference as part of a disable happens before any hook removal and is not best-effort, so a lock timeout aborts the disable with the lock-timeout message and **no hooks are removed** — the product is never left torn down with no durable record of why.

### Constraints the primitive cannot enforce

- **`repo-hooks.lock` and `runtime-registry.lock` must never be held simultaneously.** They are deliberately separate — one is repository-scoped, one machine-global — and the install and uninstall paths acquire them strictly in sequence, completing and releasing the machine-global phase before entering the repository phase. Holding both would let two surfaces installing into two different repositories deadlock against each other. Neither of them is re-entrant, so this constraint cannot be softened by nesting.
- **One nesting exists, and only in one direction: repository hooks → configuration.** The explicit plugin-setup path (`/jolli:init`) writes the local-agent tool while it still holds the repository-hooks lock, and that write takes the machine-global configuration lock. The order is safe only because nothing guarded by the configuration lock ever reaches for a repository lock, so no cycle can form; a future configuration-guarded operation that acquired a repository lock would complete the deadlock. This is a different situation from the pair above, which must not overlap at all — here overlapping is permitted, and it is the *direction* that is load-bearing. The cost is that the configuration lock's best-effort budget can be spent inside the repository-lock critical section under contention.
- **No lock is re-entrant except one.** For every lock but the shared summary-ref write lock, a flow that already holds a lock and takes it again polls until its budget expires. On a best-effort lock that degrades into running the inner section unlocked; on a strict lock it fails outright. The rule is therefore to wrap the leaf read-modify-write, never a caller that already holds the lock — and, for the strict pair, to pass an explicit "already held" signal down to a nested operation rather than letting it try to acquire again. The one exception, and the mechanism behind it, is the section below.
- **The staleness ceiling is a contract with long holders, not just a cleanup value.** Any new long-running holder must refresh its modification time on an interval well under half the ceiling, or it will be reclaimed while still working.

### One lock is re-entrant — but only through its wrappers

The shared summary-ref write lock is the only re-entrant lock in the product, and the re-entrancy is **not a property of the lock file**. The file behaves exactly like every other one: an acquisition attempt refuses a lock that is already held even by the acquiring process's own identifier, because a fresh modification time plus a live owner is indistinguishable from a healthy foreign holder. That is correct for mutual exclusion between processes and fatal for nesting — and nesting is now the normal case, because every path that writes the summary ref is expected to take this lock around its own write, so an outer section that must group several writes into one critical section inevitably contains inner sections that each take it too.

Re-entrancy is instead provided by a **call-chain-scoped registry of held working directories**, layered above the lock:

- The registry is an asynchronous-context store, not a process-wide counter. A counter cannot distinguish "nested inside the holder" from "a second, genuinely concurrent asynchronous task in the same process" — an editor host runs a background scan and a bridge write in one process — and would wave the concurrent task straight through a lock it does not hold. An asynchronous-context store propagates only down the holder's own chain, so re-entry is granted to exactly the callers that already own it.
- The key is the **resolved working directory**, normalised so that "no working directory given" and an explicit, equal one produce the same key. It is deliberately not the lock file's path: one working directory always maps to exactly one lock file, so a key match can never grant re-entry into a lock the chain does not hold, while the reverse — two working trees of one repository sharing a lock file but keying differently — is only a missed re-entry, which is the pre-existing self-block.
- A wrapper registers the working directory **only after a real acquisition succeeded**, so the registry never claims a lock that was not taken, and unregisters on the way out.

Three wrappers implement this, differing only in failure policy — which is the caller's contract, not a tuning knob:

| Wrapper | Budget on a fresh acquisition | On contention |
| --- | --- | --- |
| Must-land | 30 seconds | Throws a typed contention error |
| Deferrable | 1 second | Runs the caller's "busy" continuation instead (which may itself be asynchronous, because a deferring caller often still has to build the in-memory answer it returns) |
| General form | 1 second by default, caller-overridable | Throws the same typed contention error |

The typed contention error exists so callers can tell contention from a real fault: one consumer classifies it as a benign write conflict to be retried on the next pass rather than as an input/output fault, and the compile commands turn it into "try again shortly" instead of a stack trace.

**Taking the lock directly, without a wrapper, breaks re-entrancy in both directions.** Only the wrappers consult and register the store, so a hand-rolled acquisition:

- **Self-blocks when it is nested** inside a section its own call chain already holds. It polls out its entire budget against itself and then reports **contention** — and that report is textually identical to real contention, so it reads as normal operation in production while the write silently never lands. This has been measured: a search-index rebuild running inside an outer write guard reached a catalogue reconciliation that hand-rolled its acquisition, and the reconciliation was skipped on every single run.
- **Makes every wrapper below it self-block in turn**, because it holds the lock without registering it, so a nested wrapper sees the store as empty, tries a real acquisition, and waits out its own budget. Two schema migrations turned that into a hard abort naming a writer that does not exist.

There is exactly **one sanctioned bare acquisition**: the cutover compare-and-swap, which holds several *different* clones' locks simultaneously — a shape no single-working-directory wrapper can express without one nesting level per clone. It is safe unwrapped because it is always top-level (never reached from inside another guarded section) and performs no summary-ref write inside its critical section. Its budget is the 15 seconds in the catalogue above, and it releases every acquired lock in reverse order. Any other direct acquisition is a defect.

### One writer of a guarded document deliberately takes no lock

The machine-global runtime-registry lock is strict, and every writer of the runtime registry is required to hold it — with one exception that is deliberate, documented in place, and worth stating here because "every writer takes it" is otherwise the rule this whole topic rests on.

The repository's own IDE-sandbox launcher — a developer-facing script started by hand — writes two runtime-registry entries on every launch **without acquiring this lock**. Its defence, recorded beside the write, has two parts:

1. **It is a development-only, interactively-invoked entry point.** It never fires from a hook, from continuous integration, from a package-manager post-install step, or from any autonomous flow, so the concurrent-writer workload the lock defends against is not one this script participates in.
2. **Its write makes no decision.** The sanctioned writer reads the existing entry to decide keep-or-overwrite, which is exactly the check-then-act the lock closes; this script overwrites unconditionally. The only surviving race is therefore "which of two developer-initiated writes lands last", which is either indistinguishable (same content) or resolved by last-writer-wins.

Its individual writes are still atomic (temporary file then rename), so a concurrent reader never sees a torn entry.

**The exception's blast radius is not scoped to the sandbox.** There is one registry per user, and the script writes into it, so a concurrent enable or post-install refresh on the same machine can lose an update against it — and the entries it lands persist after the sandbox exits, by explicit design. The note beside the write states that if a future caller ever invokes this from a non-interactive path, the analysis no longer holds and the lock must be added.

This is a **coverage** exception, not a discipline change: the lock is still strict for every other writer, and nothing about the primitive was softened to accommodate it.

### Residual races that are accepted, not fixed

- **Stale-reclaim versus heartbeat.** Between a contender observing that a lock is older than the ceiling and its removal of that file, the holder can refresh the modification time once. The contender then deletes a now-fresh lock and both parties believe they hold it. Closing this needs an atomic "remove only if the modification time is unchanged" operation, which the primitive does not have. The window requires the refresh to land in the sub-millisecond gap at the one boundary tick inside a full heartbeat cycle.
- **A detached task inherits the re-entrancy registry.** A fire-and-forget task started inside a guarded section of the one re-entrant lock inherits the call-chain store, so if it outlives the section and then performs a summary-ref write it skips locking entirely — after the outer holder has already released. Every guarded section today is fully awaited; a new write path that detaches work inside one must await it before returning.
- **Process-identifier reuse.** Ownership is recorded as a process identifier rather than a random token. A false ownership match requires a machine restart inside the staleness ceiling, the lock file surviving that restart, the recycled identifier matching the dead holder's exactly, and that process happening to take the same lock. Accepted as a simplification over reading a token file on every release.

Both are documented here explicitly so a future reader does not mistake them for oversights and apply a half-fix.

## State Transitions

For any single lock file:

- **Absent** → **Held (fresh)** — a contender's exclusive create succeeded; its own process identifier is recorded.
- **Held (fresh)** → **Absent** — the owner released it and the ownership check matched.
- **Held (fresh)** → **Held (stale)** — the modification time aged past the ceiling without a heartbeat, or the owning process died.
- **Held (stale)** → **Held (fresh, new owner)** — a contender reclaimed it: removed the file and created its own.
- **Held (fresh)** → **Held (fresh)**, same owner — the owner heartbeated its modification time to avoid reclamation during long work.
- **Held (fresh, other owner)** → unchanged, contender gives up — the wait budget expired. What happens next is the lock's discipline: a best-effort contender runs the guarded work unlocked, a strict contender runs nothing, and a result-returning contender's caller declines.
- **Held** → **Absent** by hand — a user deleted the file. Safe by design: the next contender simply acquires, and the previous owner's release is a no-op because the ownership check cannot match a file that is gone.

## Notable Behavior

- **Discipline is a property of the caller, and one lock now proves it by having two callers who disagree.** The per-vault write lock's two editor-host holders take the same budget on the same click and answer a miss oppositely — one silently, one visibly — on the sole basis of whether the user asked for that specific operation. Any reading of the catalogue that treats discipline as derivable from the budget or the guarded state is wrong for that pair. (Surprising; the catalogue's three columns are independent and this is the case that demonstrates it.)
- **A silent miss can be indistinguishable from a successful no-op, and one caller is built that way on purpose.** The archival sweep's result is the list of folders it moved, so "the vault was busy for ten seconds" and "there was nothing to move" are the same answer, and the notification is suppressed on both. That is what "never block the user's click" costs: the operation has no observability at all under contention. (Notable.)
- **The location choice, not the lock, is what makes serialisation correct.** A repository-wide state document guarded by a per-worktree lock is serialised against nothing when two working trees contend. This is why the repository profile and the repository hook lifecycle both live in the shared-across-worktrees directory even though most state locks are per-worktree: their writers are a command-line process in one working tree and an editor extension host in another.
- **A lock only works if every writer takes it — and one guarded document already has a writer that does not.** Partial coverage serialises nothing, so adding a new writer to any guarded document without routing it through the same lock silently reopens the window the lock exists to close. The runtime registry carries exactly one sanctioned breach of that rule (the IDE-sandbox launcher), justified by being interactive-only and decision-free rather than by anything the primitive provides. Reading its justification as a general licence would be wrong: what makes it tolerable is precisely that it performs no read-modify-write, which is not true of any other writer of any guarded document here. (Surprising; the rule is stated absolutely elsewhere and has one live exception.)
- **Best-effort was the original discipline; strict is the newer one.** The older state-document locks were all written to degrade rather than block, because their worst case was a small lost update. The locks added for durable lifecycle decisions inverted that on purpose, and the repository profile was migrated across the line. The two disciplines coexisting is deliberate, not an inconsistency to be normalised.
- **The shortened automatic budget is a deferral mechanism, not an optimisation.** A background caller that would otherwise stall a user's session asks for a fraction of the normal budget precisely so that contention resolves as "try again next time" within milliseconds. This only works because the lock is strict: a short budget on a best-effort lock would make unlocked execution the common case rather than the rare one.
- **Re-entrancy lives above the lock, not in it, and bypassing the wrapper breaks it symmetrically.** The one re-entrant lock is re-entrant only because a call-chain-scoped registry sits over it; the file itself still refuses its own owner. A caller that acquires it directly both self-blocks when nested and causes every wrapper beneath it to self-block — and in the first direction the failure is indistinguishable from ordinary contention in the log, so the write simply never lands and nothing reports it. (Surprising; the failure mode is a plausible-looking log line, not an error.)
- **A wait budget on that lock is a failure policy, not a performance knob.** The one-second budget means "defer, we will be re-invoked"; a caller with no re-invocation needs the thirty-second must-land budget. Several call sites moved to the must-land wrapper after it became clear they had no re-invocation at all — a request server that dispatches concurrently and a JVM host that does not retry a failed write. (Notable.)
- **An unused best-effort entry point is a hazard, not dead weight.** The retained best-effort wrapper over the repository profile lock still compiles and still degrades to unlocked execution; a future caller reaching for it by name would reintroduce exactly the race its callers were migrated away from.

## Shared Behavior

- **Per-worktree state directory**, **repository-shared state directory rooted at the common git directory**, and **the per-user machine-global state directory** are the three location conventions used throughout the product; the locks simply live in them alongside the state they guard.
- **Hook installation orchestration** is the consumer of the two strict locks that must never be held simultaneously, and owns the user-facing message emitted for each acquisition failure.
- **Per-source dist-path version selection** requires every registry writer to hold the machine-global runtime-registry lock, and deliberately leaves its own read-modify-write internally unlocked in reliance on that. It also owns the full account of the one unlocked writer noted above — what it writes, what else it skips, and the machine-wide consequence of it.
- **Npm postinstall dist-path refresh** turns a failure to acquire the machine-global lock into a complete silent skip.
- **The repository-profile / manual-disable topic** owns the state guarded by the strict profile lock, including the abort-without-teardown behaviour on a lock timeout.
- **The cutover compare-and-swap** is the one sanctioned bare acquisition of the summary-ref write lock, and owns why it holds several clones' locks at once, in what order, and what it does inside them — defined by **Orphan Branch Cutover Fence and Compare-and-Swap** (345).
- **The per-vault write lock's own topic** owns its path canonicalisation, its acquired-handle interface, its heartbeat cadence, its hold windows, the cross-repository waiter registry drained on release, and its diagnostic probe. This topic owns only its place in the catalogue and the fact that it is the one lock with two callers whose disciplines are opposites. The two editor-host holders that produce that split, and their omission of the release hook, are owned by the Memory Bank unused-folder archival spec and the Memory Bank duplicate-folder consolidation spec.
- **The dashboard command** (361) owns why the spawn lock no longer exists: it serves in its own process, so there is no detached server for two invocations to race into creating.
- **The machine-global repository registry** — the durable record from which the dashboard database is rebuilt — owns its own read-modify-write; its lock is best-effort for the same reason as the other state-document locks, and running that section unlocked narrows to a small lost-registration window rather than dropping the registration outright.
- **Queue draining, orphan-branch writes, Memory Bank sync rounds, the plan/note registry, the commit-selection record, the pending-push ledger, session/cursor registries, and machine-global configuration** each own their guarded critical section; this topic owns only the lock characteristics.
