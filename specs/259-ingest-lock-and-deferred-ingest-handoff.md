# 259. Ingest Lock and Deferred-Ingest Hand-off

## Topic Statement

A per-worktree filesystem lock that serializes the background worker's topic-knowledge-base **ingest phase** against itself, paired with a single-slot deferred-ingest flag that converts a lost fail-fast acquisition into a guaranteed re-launch when the current holder releases — so an all-or-nothing ingest batch is never stranded and never run twice concurrently in one worktree.

## Scope

**In scope:**

- The identity, scope, location, and staleness rule of the per-worktree ingest lock, and how it is distinct from the summary-drain lock that lives beside it.
- The ingest lock's hold window: the entire ingest phase, which runs **after** both entry-level locks (the per-worktree summary-drain lock and the per-vault write lock) have already been released.
- The mtime heartbeat that keeps a long ingest (which can run for minutes) from being stale-reclaimed.
- The full correctness protocol around one ingest phase: fail-fast acquire → on miss record the deferred flag and retry once → on acquire re-read the queued ingest work, run **one** ingest batch, delete that batch's entries **only on success**, then release the lock, then wake any deferred waiter.
- The single-slot deferred-ingest flag: its presence semantics, the record-before-retry ordering that closes the record/acquire time-of-check/time-of-use gap, the read-and-clear consume, and the wake = consume-then-relaunch-after-release rule.
- The best-effort, idempotent character of the whole hand-off (a launch against an ingest-free queue is a cheap no-op).

**Boundaries (consumed here, owned elsewhere):**

- The worker's overall lifecycle — startup, the per-vault write-lock acquire before storage construction, the summary drain, the chain-spawn for summary leftovers, and the post-drain trigger that enqueues an ingest operation — is owned by the **git-operation queue worker** spec (34). This spec owns only the ingest phase that runs at the tail of that lifecycle.
- What an ingest batch actually does (routing, per-topic reconciliation, page/index/high-water-mark writes, wiki re-render, graph build) is owned by the **topic ingest pipeline** spec (152). This spec treats one ingest run as an opaque unit of work that either succeeds or throws.
- The per-vault write lock, its canonical-path identity, and the per-individual-write acquire the ingest phase performs through the write guard (re-acquiring the vault lock in wait-mode around each page/index/processed-set write, with the orphan-write lock nested inside) are owned by the **vault write lock** spec (171).
- The queue on-disk layout, entry format, timestamp ordering, and the ingest-operation kind discriminator are owned by specs 34 / 35 and the ingest-trigger spec (159).
- The cosmetic ingest-phase display marker (a non-lock heartbeat file that only drives the editor sidebar's "building wiki/graph" pill) carries **no** correctness or gating role and is not part of this lock; it is described where the busy-state read and the commit gate are specified (specs 218, 112).
- The shared PID-plus-mtime file lock primitive — the 5-minute staleness threshold, dead-owner reclaim, PID-checked release, and the residual narrow stale-reclaim race — is inherited from the host lock primitive and not re-specified here.

## Data Contracts

### Ingest lock

- **Scope:** per-worktree — one lock per source checkout, keyed to the same per-project state directory the summary-drain lock lives in. Ingest is a worktree-local operation, so two separate worktrees correctly run their own ingest phases in parallel; the same worktree never runs two ingest phases at once.
- **Semantics:** fail-fast acquire only (a single exclusive-create attempt; a busy lock returns "miss" immediately, never blocks). The whole hand-off below exists precisely because the acquire is single-shot rather than bounded-wait.
- **Staleness:** inherits the shared primitive's 5-minute staleness threshold, dead-owner reclaim, and PID-checked release.
- **Heartbeat:** while the ingest phase runs, the holder bumps the lock's modification time on a fixed 60-second cadence — the same cadence used by the summary-drain lock, the per-vault write lock, and the machine-global sync lock — so an ingest that legitimately outlasts the staleness threshold (wiki render plus graph build can take minutes) is not reclaimed mid-run.

This is a **third** per-worktree lock distinct from the summary-drain lock that shares its directory: the summary-drain lock is held only across summary generation; the ingest lock is held only across the ingest phase. Splitting them is what lets a same-worktree summary worker and an ingest run proceed concurrently (a long ingest no longer blocks summary generation, and the commit/squash gate — which keys off the summary-drain lock — stays open during ingest).

### Deferred-ingest flag

- A **single-slot** presence flag in the same per-worktree state directory as the ingest lock. Its mere existence means "this worktree has an ingest run that lost the acquire race and is waiting to be re-launched." It carries no queue coupling and no count — one worktree can have at most one deferred ingest pending, because the only worker that ever needs waking is this worktree's own next ingest phase.
- **Idempotent:** recording it more than once collapses to the same single flag.
- **Best-effort:** a failed write only means this waiter is not auto-woken; its queued ingest entries stay on disk for the worktree's next post-commit-triggered worker.

This is the degenerate, single-slot analogue of the per-vault cross-repo pending-workers registry (spec 171): that registry must fan out to many sibling repos because the per-vault write lock is shared across repos; the ingest lock is per-worktree, so its "registry" collapses to one flag file. The record-before-retry, consume-before-act, and wake-after-release disciplines are deliberately mirrored from that precedent.

## Behavior

### The ingest phase (runs after both entry-level locks release)

The ingest phase is entered only after the worker has drained all summary work, released the per-vault write lock, and released the per-worktree summary-drain lock (see spec 34 for the full ordering). Consequently the ingest phase holds **neither** entry-level lock; a same-worktree summary worker spawned for a commit that landed during or after the drain can run concurrently with it.

1. **Pre-check.** Read the pending queue and keep only the ingest-kind entries. If there are none, the ingest phase does nothing and the worker exits.
2. **Fail-fast acquire.** Attempt the single-shot acquire of the per-worktree ingest lock.
3. **On miss — record then retry once.** Record the single-slot deferred-ingest flag, then attempt the fail-fast acquire **again, exactly once**.
   - **Recording *before* the retry is load-bearing.** It closes the record/acquire time-of-check/time-of-use window: if the current holder releases in the gap between our first miss and our record, then either our retry wins the now-free lock and proceeds, or the holder's own release-time wake already observes our just-recorded flag and re-launches us. The ingest cannot be stranded on either interleaving. (This mirrors the per-vault write lock's post-timeout fail-fast retry in spec 171.)
   - If the retry also misses, the worker leaves the ingest entries on disk and exits; the current holder's release-time wake is responsible for re-launching this worktree.
4. **On acquire — run one ingest batch.** With the lock held:
   1. Start the 60-second mtime heartbeat.
   2. **Re-read** the queued ingest entries. Between the pre-check and the acquire, a prior holder may have already consumed and deleted the batch; if the re-read finds no ingest entries, the phase does nothing further and proceeds to teardown.
   3. Otherwise, synthesize a single ingest unit of work (its trigger tag taken from the oldest queued ingest entry, since the queue is timestamp-ordered) and run **one** ingest batch (spec 152). Each individual persistence inside that batch re-acquires the per-vault write lock in wait-mode and nests the orphan-write lock inside it (the write-guard contract owned by spec 171); the lock-free reconciliation model calls between writes hold no lock.
   4. **Delete-on-success.** Only after the ingest run returns without throwing are the consumed ingest entries deleted. A throw anywhere in the run skips the deletes, leaving the entries on disk for the next run to retry — the batch is all-or-nothing with respect to its queue entries.
5. **Teardown (always runs).** Stop the heartbeat, then **release the ingest lock, then wake any deferred waiter** — in that order.

An ingest run that throws is non-fatal: it is logged and swallowed, and the worker still reaches teardown. The thrown run does not delete its entries (step 4.4), so the work is preserved.

### Deferred-ingest wake (after release)

Teardown's wake step:

1. **Consume** the single-slot deferred-ingest flag: read-and-clear. If no flag was set, the wake is a no-op and returns.
2. If a flag was set (and is now cleared), **launch a fresh detached worker** for this worktree.

**The wake must run *after* the lock release**, never before: the re-launched worker is a detached process that must be able to win the now-free ingest lock to make progress. Releasing first guarantees the freshly spawned worker finds the lock free.

**Deleting the flag before acting mirrors the pending-workers consume:** a producer (another timed-out ingest worker) that races in after the clear simply re-arms the flag for the next release, so nothing is lost.

**No queue re-check on the wake path.** The wake does not inspect the ingest queue before launching. A worker that starts against an ingest-free queue drains nothing in its ingest phase and exits cheaply (the launch is idempotent), so waking after the holder already consumed every ingest entry is a benign no-op. This keeps the flag mechanism free of any queue coupling.

## State Transitions

### Ingest lock (per worktree)

| From | Action | To | Notes |
| ---- | ------ | -- | ----- |
| Free | fail-fast acquire | Held | Exclusive-create wins. |
| Free (stale / dead-owner) | fail-fast acquire | Held | Primitive reclaims then re-creates. |
| Held | another worker's fail-fast acquire | Held | Returns miss; that worker records the deferred flag and retries once. |
| Held | holder's heartbeat tick | Held | Mtime advances; staleness countdown resets. |
| Held | holder's PID-checked release | Free | Teardown removes it, then wakes. |
| Held | staleness threshold elapses without a heartbeat | Free (stale) | Next acquirer reclaims. |

### Deferred-ingest flag (per worktree, single slot)

```
ABSENT ──(worker misses fail-fast acquire, records)──▶ SET
SET    ──(record again, idempotent)────────────────▶ SET
SET    ──(holder's release-time wake consumes)──────▶ ABSENT ──▶ detached worker launched
SET    ──(this worker's own retry wins the lock)────▶ SET (harmless residue; next release consumes and
                                                        launches a worker that no-ops against an
                                                        already-drained ingest queue)
ABSENT ──(release-time wake finds nothing)──────────▶ ABSENT (no-op)
```

## Notable Behavior

- **The ingest lock is single-shot, not bounded-wait — and that is the reason the deferred flag exists.** A bounded-wait acquire would let a second ingest worker simply block until the first released; the fail-fast-plus-hand-off design instead lets the second worker exit immediately and be re-launched by the first's release, so no process idles waiting.
- **Record before retry closes the TOCTOU.** The single riskiest interleaving — holder releases and drains the flag in the gap after a miss — is defused by recording the flag *before* the one retry. Either the retry wins, or the holder's wake sees the flag.
- **Delete-on-success makes an ingest batch all-or-nothing against its queue entries.** A crash or throw mid-ingest leaves every consumed entry on disk, so the next run redoes the whole batch rather than losing partially-processed work. (The ingest pipeline itself is separately idempotent — an already-processed source is skipped by its high-water mark — so a full re-run is safe.)
- **Wake strictly follows release.** Because the re-launch is a detached spawn, waking before release would spawn a worker that immediately loses the still-held lock and exits, re-orphaning the work. Release-then-wake is the only correct order.
- **The whole hand-off is best-effort and idempotent.** A failed flag write, a failed consume, or a redundant launch all degrade gracefully: the worst case is one missed auto-wake (the entries wait for the next post-commit trigger) or one redundant no-op spawn.
- **This lock never gates user-facing git actions.** The commit / squash / Create-PR gate and the "worker busy" status read key off the *summary-drain* lock only; the ingest lock is deliberately invisible to them so committing during a long wiki/graph build is never blocked (see specs 112, 218).

## Shared Behavior

- **Host PID-plus-mtime file lock primitive.** Inherited verbatim: 5-minute staleness threshold, dead-owner reclaim, PID-checked release, PID-checked heartbeat, and the residual narrow stale-reclaim race. The same primitive backs the summary-drain lock (spec 34), the per-vault write lock (spec 171), and the machine-global sync lock (spec 172); all heartbeat at 60 seconds against the same threshold.
- **Queue worker lifecycle (spec 34).** The ingest phase is the tail of the worker's run; the worker acquires and releases the per-vault write lock and the summary-drain lock *before* the ingest phase, and a post-drain trigger is what enqueues the ingest operation this phase later consumes.
- **Topic ingest pipeline (spec 152).** One ingest batch is a call into the pipeline; this spec owns only the lock and hand-off around that call, not the pipeline's routing/reconcile internals.
- **Vault write lock (spec 171).** The ingest phase re-acquires this per-vault lock in wait-mode around each individual write (orphan-write lock nested inside), releasing between writes; the cross-repo pending-workers registry described there is the many-repo analogue of this spec's single-slot flag.
- **Cosmetic ingest-phase marker.** A display-only heartbeat file drives the editor sidebar pill during the ingest phase; it is not a lock and carries no gate role (specs 218, 112).
