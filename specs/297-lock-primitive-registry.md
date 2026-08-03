# 297. Lock Primitive Registry

## Topic Statement

Every mutually-exclusive critical section in the product is guarded by an advisory file lock built on one shared on-disk convention, and each lock is characterised by three independent choices: where its file lives (which decides what it actually serialises), how long a contender waits for it, and — most consequentially — whether failing to acquire it aborts the guarded work or merely degrades to running unlocked.

## Scope

**In scope:**

- The shared on-disk convention every lock uses: the ownership record, the freshness signal, the staleness ceiling, early reclamation of a dead owner's lock, and ownership-checked release.
- The three location scopes a lock can have (per-worktree, shared across every worktree of one repository, machine-global for one user) and what each therefore serialises.
- A complete catalogue of the product's locks: file name, location scope, default wait budget, and failure discipline.
- The **strict** versus **best-effort** failure discipline, which locks have which, and why the distinction is load-bearing rather than stylistic.
- Per-lock constraints that cannot be expressed by the primitive itself: the pair that must never be held simultaneously, the non-re-entrancy rule, and the one lock whose best-effort form now has no callers.

**Out of scope (boundaries):**

- What each guarded critical section actually does — those belong to their own topics (queue draining, orphan-branch writes, Memory Bank sync rounds, the plan/note registry, the pending-push ledger, the repository profile, hook installation, the runtime registry).
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

Where the file lives is what decides what is actually serialised. Three scopes exist:

- **Per-worktree** — inside the per-project state directory of the specific working tree. Two working trees of the same repository never contend. Correct when the guarded state is itself per-worktree.
- **Shared across worktrees** — inside a state directory rooted at the repository's common git directory, so every working tree of the same repository, and every surface operating in any of them, resolves to the same file. Correct when the guarded state is repository-wide rather than worktree-wide. When the location cannot be resolved (not inside a repository, or git unavailable), it falls back to the per-worktree directory — single-worktree behaviour is then unchanged, and multi-worktree serialisation is simply unavailable.
- **Machine-global** — inside the per-user state directory. One file for the whole machine, across every repository and every install surface.

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
| `orphan-write.lock` | Shared across worktrees | 1 second, polled | Acquisition result returned to the caller |
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

The three oldest entries (`worker.lock`, `ingest.lock`, `orphan-write.lock`) and the sync lock are neither strict nor best-effort in the sense above: they hand the acquisition result back and let each caller decide, and every caller declines the work on failure. The strict/best-effort distinction applies to the wrappers that run a callback on the caller's behalf.

### The push-control lock is strict by shape and best-effort by use

`push-control.lock` guards the machine-global per-repo outbound-push store (`push-control.json`, spec 310) so a command-line toggle and an editor toggle of *different* repos cannot lose-update each other. It is machine-global like the runtime-registry lock, but deliberately a **separate file** so the two never contend.

Its wrapper returns the strict acquisition result — on timeout it runs nothing and reports "not acquired". But its **single** caller, the store's read-modify-write, then re-runs the same guarded function unlocked rather than propagating the failure. The net user-visible discipline is therefore best-effort, for the best-effort rationale above: the critical section is a sub-millisecond read-modify-write that re-reads inside the lock and ends in an atomic write, so contention narrows to a small residual lost-update window — whereas dropping the write would silently discard a toggle the user just clicked, which on the *disable* direction means the repo keeps pushing after the user turned it off.

This is worth stating explicitly because the shape and the behavior disagree: reading only the wrapper would classify this lock as strict, and a future second caller that forgets the fallback would silently start dropping toggles.

### The repository profile lock has two disciplines

One lock file, two access wrappers:

- A **best-effort** wrapper, whose timeout warns and proceeds unlocked. It has **no remaining callers** — every consumer moved to the strict form. It is retained only as an unused entry point; a future caller reintroducing it would silently reintroduce the lost-update window for durable lifecycle decisions.
- A **strict** wrapper, whose timeout runs nothing. All current readers and writers of the repository profile use this one.

The consequence of that migration is visible to users: a profile write that cannot take the lock now **fails** instead of racing. Most notably, recording the durable "leave this project alone" preference as part of a disable happens before any hook removal and is not best-effort, so a lock timeout aborts the disable with the lock-timeout message and **no hooks are removed** — the product is never left torn down with no durable record of why.

### Constraints the primitive cannot enforce

- **`repo-hooks.lock` and `runtime-registry.lock` must never be held simultaneously.** They are deliberately separate — one is repository-scoped, one machine-global — and the install and uninstall paths acquire them strictly in sequence, completing and releasing the machine-global phase before entering the repository phase. Holding both would let two surfaces installing into two different repositories deadlock against each other. No lock here is re-entrant, so this constraint cannot be softened by nesting.
- **One nesting exists, and only in one direction: repository hooks → configuration.** The explicit plugin-setup path (`/jolli:init`) writes the local-agent tool while it still holds the repository-hooks lock, and that write takes the machine-global configuration lock. The order is safe only because nothing guarded by the configuration lock ever reaches for a repository lock, so no cycle can form; a future configuration-guarded operation that acquired a repository lock would complete the deadlock. This is a different situation from the pair above, which must not overlap at all — here overlapping is permitted, and it is the *direction* that is load-bearing. The cost is that the configuration lock's best-effort budget can be spent inside the repository-lock critical section under contention.
- **No lock is re-entrant.** A flow that already holds a lock and takes it again polls until its budget expires. On a best-effort lock that degrades into running the inner section unlocked; on a strict lock it fails outright. The rule is therefore to wrap the leaf read-modify-write, never a caller that already holds the lock — and, for the strict pair, to pass an explicit "already held" signal down to a nested operation rather than letting it try to acquire again.
- **The staleness ceiling is a contract with long holders, not just a cleanup value.** Any new long-running holder must refresh its modification time on an interval well under half the ceiling, or it will be reclaimed while still working.

### Residual races that are accepted, not fixed

- **Stale-reclaim versus heartbeat.** Between a contender observing that a lock is older than the ceiling and its removal of that file, the holder can refresh the modification time once. The contender then deletes a now-fresh lock and both parties believe they hold it. Closing this needs an atomic "remove only if the modification time is unchanged" operation, which the primitive does not have. The window requires the refresh to land in the sub-millisecond gap at the one boundary tick inside a full heartbeat cycle.
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

- **The location choice, not the lock, is what makes serialisation correct.** A repository-wide state document guarded by a per-worktree lock is serialised against nothing when two working trees contend. This is why the repository profile and the repository hook lifecycle both live in the shared-across-worktrees directory even though most state locks are per-worktree: their writers are a command-line process in one working tree and an editor extension host in another.
- **A lock only works if every writer takes it.** Partial coverage serialises nothing. Adding a new writer to any guarded document without routing it through the same lock silently reopens the window the lock exists to close.
- **Best-effort was the original discipline; strict is the newer one.** The older state-document locks were all written to degrade rather than block, because their worst case was a small lost update. The locks added for durable lifecycle decisions inverted that on purpose, and the repository profile was migrated across the line. The two disciplines coexisting is deliberate, not an inconsistency to be normalised.
- **The shortened automatic budget is a deferral mechanism, not an optimisation.** A background caller that would otherwise stall a user's session asks for a fraction of the normal budget precisely so that contention resolves as "try again next time" within milliseconds. This only works because the lock is strict: a short budget on a best-effort lock would make unlocked execution the common case rather than the rare one.
- **An unused best-effort entry point is a hazard, not dead weight.** The retained best-effort wrapper over the repository profile lock still compiles and still degrades to unlocked execution; a future caller reaching for it by name would reintroduce exactly the race its callers were migrated away from.

## Shared Behavior

- **Per-worktree state directory**, **repository-shared state directory rooted at the common git directory**, and **the per-user machine-global state directory** are the three location conventions used throughout the product; the locks simply live in them alongside the state they guard.
- **Hook installation orchestration** is the consumer of the two strict locks that must never be held simultaneously, and owns the user-facing message emitted for each acquisition failure.
- **Per-source dist-path version selection** requires every registry writer to hold the machine-global runtime-registry lock, and deliberately leaves its own read-modify-write internally unlocked in reliance on that.
- **Npm postinstall dist-path refresh** turns a failure to acquire the machine-global lock into a complete silent skip.
- **The repository-profile / manual-disable topic** owns the state guarded by the strict profile lock, including the abort-without-teardown behaviour on a lock timeout.
- **Queue draining, orphan-branch writes, Memory Bank sync rounds, the plan/note registry, the commit-selection record, the pending-push ledger, session/cursor registries, and machine-global configuration** each own their guarded critical section; this topic owns only the lock characteristics.
