# Git Operation Queue Worker

## Topic Statement

A single-writer background process that drains a per-operation queue in two phases: first, under a per-source-repo **summary-drain lock**, it processes every summary-producing entry in timestamp order and dispatches each to a handler chosen by its operation kind; then, after releasing that lock (and the outer per-vault write lock), it runs a **separate ingest phase** under its own per-worktree ingest lock to fold the topic knowledge base.

## Scope

**In scope:**
- How the worker is started and how its lock-protected critical section is entered (including the repo-wide manual-disable gate it reads before taking any lock, then the per-vault write lock before constructing storage, then the per-source-repo summary-drain lock).
- The summary-drain lock's identity, the staleness rule that lets a crashed predecessor be evicted, and what happens when the lock is already held by a live writer.
- The on-disk layout of the queue directory and the strict ordering used to drain it.
- That the drain processes only **summary (non-ingest)** entries; an all-ingest queue drains to empty without processing anything in this phase.
- The dispatch rule that maps each summary-producing operation kind to its processing path (full conversational summarization, consolidation, one-to-one migration).
- Per-entry success and failure semantics: when an entry's file is deleted, whether failures retry, whether failures stop subsequent entries.
- The bounded inner-loop safety cap that prevents a runaway drain.
- The post-drain topic-KB ingest trigger (enqueue one ingest operation when at least one commit-typed op was processed).
- The post-drain push-sync trigger (fire-and-forget hand-off of the commit hashes whose summaries were (re)generated this run to the personal-space push engine, so a `git push` that raced ahead of summary generation still syncs once the memory lands).
- The successor-spawn step performed after the locks are released, if new **summary** entries arrived during the drain.
- The separate ingest phase: that it runs after both entry-level locks release, under its own heartbeated per-worktree ingest lock, and its acquire → record-pending-and-retry-once → run-one-ingest → delete-on-success → release-then-wake sequence.
- That each **commit-typed** entry's processing is bracketed by a best-effort per-commit progress event stream and a per-hash liveness lock, so an interactive post-commit watcher can observe the pipeline (detail owned by the Post-Commit Capture Progress Streaming spec).

**Out of scope:**
- The on-disk shape and authoring of an individual queue entry (covered by the queue-entry-format topic 35).
- The transcript-cutoff mechanism the worker passes into the per-commit handler (covered by the transcript-cutoff topic).
- The push-pending queue, its dedicated lock, and the claim-based drain engine the post-drain push-sync trigger hands off to (owned by spec 269); this spec only describes the hand-off from the worker's side.
- The successor-spawn race protocol viewed from the producing hooks' side (covered by the worker-chain-spawn topic).
- The internals of any individual handler (full conversational pipeline, consolidation pipeline, migration) beyond which one runs for which operation kind. The commit pipeline additionally includes an AI context-relevance filtering sub-stage (which conversation sessions are relevant to the change) — owned by spec 258, not re-specified here — and a carve-out that withholds track-only external references from that sub-stage's input, owned by the per-commit summarization and reference specs. The dispatch table itself is unaffected by either.
- The per-vault write lock the worker acquires before storage construction (owned by spec 171); this spec only notes where the worker takes and releases it.
- The per-worktree **ingest lock** and its single-slot deferred-ingest hand-off protocol (owned by spec 259); this spec describes the ingest-phase structure and cross-references 259 for the lock/hand-off correctness detail.
- The topic-KB ingest pipeline the ingest phase invokes (owned by spec 152).
- The on-disk format of summaries and registries the handlers ultimately write.
- The progress stream's format and milestones, the watcher-side lock probe, and the interactive feedback watch — all owned by the Post-Commit Capture Progress Streaming spec; this spec only notes where the worker emits progress and acquires/releases the per-hash lock.

## Data Contracts

### Worker invocation

The worker is invoked as a node script with two flags:

- A flag indicating worker mode.
- A flag introducing the working directory of the host repository, with an absolute path as its value.

When invoked without those flags, the script does not run a drain. The flags can also be omitted entirely when the worker function is called in-process (used by tests and by the manual re-summarize path).

### Spawn shape

A successor process spawned by the worker (or by the producing hooks) is:

- A detached child of the current process whose lifetime is unlinked from its parent.
- Started with no inherited standard streams (stdin/stdout/stderr ignored).
- Hidden on the platform that supports a hidden-window flag.
- Started with a flag that suppresses experimental-feature warnings emitted by the runtime when on-demand database modules are loaded later.
- Configured so the parent does not wait for the child.

### Summary-drain lock

A single regular file at a fixed name inside the per-repository state directory, held only for the duration of the **summary** drain. Its modified timestamp is the metadata used for liveness (freshness) decisions; the file's body holds the holder's process id, which is consulted on **release** (the holder removes the file only when its recorded PID matches the current process, guarding the stale-reclaim race) but not for the fresh/stale liveness check. Acquisition is fail-fast — a second worker that finds it held by a live writer exits immediately. The worker bumps this lock's modified timestamp on a periodic (60-second) heartbeat so a handler call that legitimately exceeds the staleness threshold is not reclaimed mid-run.

This lock is distinct from two siblings the worker also touches: the outer per-vault write lock (spec 171), acquired before storage construction and released before the ingest phase, and the per-worktree **ingest lock** (spec 259), acquired only for the ingest phase after this summary-drain lock has been released.

### Lock-staleness threshold

Five minutes. A lock whose modified timestamp is younger than this is considered live and blocks acquisition. A lock whose modified timestamp meets or exceeds this is considered stale and is removed before retrying acquisition. The same threshold and heartbeat cadence apply to the sibling ingest lock and the per-vault write lock.

### Queue directory

A single directory inside the per-repository state directory under a fixed name. Each pending operation occupies one file in this directory. The directory is created on demand. Its absence is treated as an empty queue.

### Drain-batch entry

Each readable queue file produces an in-memory record carrying:

- The parsed operation payload (kind, target hash, optional source hashes, source-of-action marker, optional enqueue-time branch, creation timestamp). The handlers prefer the entry's captured branch over a live branch read when attributing the resulting summary and its associations, falling back to a live read only for legacy entries that lack the field; the per-commit and amend-migration topics own that attribution detail.
- The absolute path of the file on disk, retained so that the entry's file can be deleted after processing.

### Per-run cap

A constant integer (twenty) that bounds the total number of entries any single worker run will process before voluntarily yielding to its successor.

### Operation-kind dispatch table

Each **summary-producing** operation kind is mapped to exactly one handler, dispatched during the summary drain:

- Plain commit, cherry-pick, revert: the full per-commit conversational pipeline. (The commit pipeline includes an AI context-relevance filtering sub-stage — spec 258.)
- Amend: the full per-commit conversational pipeline (which itself branches further by old-summary presence and delta triviality).
- Squash: the consolidation pipeline that merges multiple source summaries into one.
- Rebase-pick: the one-to-one migration that re-keys an existing summary under a new commit hash.
- Rebase-squash: the same consolidation pipeline used by squash.
- Any unknown (but non-ingest) kind: a warning is logged, no handler runs, and the entry is still deleted.

The **ingest** operation kind is **not** dispatched in the summary drain. Ingest entries are filtered out of the drain and left on the queue for the separate ingest phase that runs after the drain (see "Ingest phase" below). A queue containing only ingest entries therefore drains empty without any summary handler running.

## Behavior

### Startup

1. Set the per-repository log directory so handler output reaches the project's log file.
2. **Repo-wide manual-disable gate.** Read the repository's manual-disable flag. If it is set, log that the repository is manually disabled and return. The position is load-bearing: this read sits **after** the log-directory setup but **before** the per-vault write lock, before the startup banner, and before storage construction. A disabled repository therefore logs neither the banner nor any lock activity, never constructs or registers a storage backend, never touches either drain lock, drains nothing, deletes nothing, spawns no successor, and never reaches the ingest phase. Every spawn of the worker — from any hook, any surface, or the manual re-summarize path — is inert on a disabled repository, so the gate does not need to be duplicated at the spawn sites. The flag's storage, priority, and migration are owned by the manual-disable spec.
3. Log the startup banner.
4. Acquire the per-vault write lock (spec 171) in bounded-wait mode **before** constructing storage — storage construction has side effects on the personal-space per-repo config directory that must not race a concurrent writer. On a full miss the worker records itself in the cross-repo wakeup registry, retries once fail-fast, and exits if still missed. (Full mechanics: spec 171.)
5. Construct the configured storage backend for the repository (orphan-only, dual-write, or folder-only) and register it as the active backend so all subsequent handler writes use it.
6. Attempt to acquire the summary-drain lock (see below).
7. If the summary-drain lock is unavailable, log a warning that another worker may be running and exit (releasing the per-vault write lock via the backstop finally) without doing any further work.

### Summary-drain lock acquisition

1. Probe the lock file. If it does not exist, proceed to creation.
2. If it exists, compute its age from its modified timestamp.
3. If the age is below the staleness threshold, refuse acquisition (fail-fast).
4. If the age meets or exceeds the staleness threshold, log that a stale lock is being removed, delete it, and proceed to creation.
5. Create the lock file with an exclusive-creation flag. If creation fails because another process won the race, refuse acquisition.

### Drain loop (summary entries only)

After successful acquisition, repeat the following until no summary entries remain or the per-run cap is reached:

1. Read every file in the queue directory whose name ends in `.json`.
2. Sort the file names lexicographically. (See Notable Behavior for why this is equivalent to timestamp order.)
3. For each sorted file: parse it as a queue entry; if its creation timestamp is older than the queue-entry stale threshold, delete the file and skip it; otherwise add it to the in-memory drain batch.
4. **Keep only the non-ingest (summary-producing) entries.** Ingest entries stay on the queue for the ingest phase. If no summary entries remain in the batch, break the loop — an all-ingest queue therefore exits the drain immediately, leaving the ingest entries intact.
5. For each summary entry in the batch, in order:
   a. If the cumulative count of processed entries has already reached the per-run cap, exit the inner loop early; the outer loop will then re-evaluate the cap and exit cleanly.
   b. Dispatch the entry to its handler by operation kind.
   c. If the handler throws, catch the error, log the operation kind and short hash and message, and continue.
   d. Delete the entry's file regardless of whether the handler succeeded or threw.
   e. Increment the processed-entry counter, record that at least one commit-typed op was processed this run (used by the post-drain ingest trigger below), and add the entry's target commit hash to the set of hashes whose summary was (re)generated this run (used by the post-drain push-sync trigger below). Both are recorded only on a successful handler call — an entry whose handler threw contributes to neither trigger.
6. If the outer loop performs another iteration, re-list the directory; summary entries that arrived during the previous iteration are picked up here.

### Post-drain topic-KB ingest trigger

After the drain, if at least one commit-typed op was processed this run, enqueue a single repo-wide topic-KB ingest operation (tagged "post-commit"), subject to its own per-cwd cooldown debounce (spec 159). Ingest ops themselves never set this flag, so the trigger cannot self-perpetuate. The ingest op is enqueued (not run inline) so it is consumed by the ingest phase / a successor rather than extending the summary hold.

### Post-drain push-sync trigger

After the drain, if the set of hashes whose summary was (re)generated this run is non-empty, hand those hashes to the personal-space push engine (spec 269) as a **fire-and-forget** call scheduled on the next tick, tagged with the **post-queue** source and filtered to exactly those hashes. This exists so a `git push` that fired *before* the pushed commits had memories (the pre-push hook enqueued them into the push-pending queue but the drain worker found no summary yet) gets those memories uploaded as soon as they are generated here. The call is deliberately not awaited: a slow or offline upload must never extend this worker's lock hold or delay the ingest phase, and any failure is swallowed to a debug log — the entries survive in the push-pending queue for the next push / activation retry. The trigger does nothing when no summaries were generated this run.

### Lock release, successor check, then ingest (in order)

1. **Release both entry-level locks.** Release the per-vault write lock, then the summary-drain lock, clearing their heartbeats, and wake any cross-repo vault waiters. Releasing the summary-drain lock lets a same-repo summary successor run concurrently with the ingest phase below.
2. **Successor check — summary leftovers only.** Re-list the queue; if any **non-ingest** entry remains (arrived past the per-run cap or during the drain), log how many and start a successor worker as a fresh detached process. Because the summary-drain lock is now released, the successor can immediately win it. Ingest entries are deliberately **not** a successor-spawn trigger — they are handled by the ingest phase and its deferred hand-off, so spawning for them would double-run.
3. **Ingest phase** (see below).

### Ingest phase (separate lock; runs with both entry-level locks released)

Run only if the queue holds at least one ingest entry. This phase holds neither entry-level lock, so it runs concurrently with any same-repo summary successor. Its own per-worktree ingest lock and single-slot deferred-ingest hand-off are owned by spec 259; the structure here:

1. **Fail-fast acquire** the per-worktree ingest lock. On a miss, record the single-slot deferred-ingest flag and retry the acquire once (recording before the retry closes the record/acquire race — spec 259); if still missed, leave the ingest entries queued for the current holder's release-time wake and skip the rest of this phase.
2. On acquire, start a 60-second heartbeat on the ingest lock (an ingest — wiki render plus graph build — can run for minutes and must not be stale-reclaimed).
3. **Re-read** the queued ingest entries inside the lock (a prior holder may have consumed them in the gap). If any remain, synthesize one ingest operation (trigger tag from the oldest queued ingest entry) and run **one** ingest batch via the topic-KB ingest pipeline (spec 152). Each individual write inside that batch re-acquires the per-vault write lock in wait-mode (orphan-write lock nested inside) per the write guard; the reconcile model calls between writes hold no lock (spec 171).
4. **Delete-on-success:** delete the consumed ingest entries only after the ingest run returns without throwing. A throw leaves them queued for the next run — an ingest batch is all-or-nothing against its queue entries.
5. **Teardown (always):** stop the heartbeat, release the ingest lock, then wake any deferred-ingest waiter (consume the flag and launch a fresh worker). The wake must follow the release so the detached worker can win the now-free lock. An ingest run that throws is logged and swallowed (non-fatal to the worker).

### Storage activation as side effect

Setting the active storage backend during startup is a process-wide side effect: every handler call that writes through the canonical summary store implicitly uses the backend chosen during this worker's startup, until the process exits.

## State Transitions

### Worker run

- **Idle (no process)** → **Running (summary drain, holding summary-drain lock)** when a hook spawns the worker and it acquires the per-vault write lock and the summary-drain lock.
- **Idle (no process)** → **Idle (no process)** when a hook spawns the worker but the summary-drain lock (or the per-vault write lock) is held; the new instance exits without doing summary work.
- **Idle (no process)** → **Idle (no process)** when the worker is spawned against a repository carrying the manual-disable flag; it exits before taking any lock, so no lock is even probed and no banner is logged.
- **Running (summary drain)** → **Running (ingest phase, holding ingest lock; entry-level locks released)** after the drain finishes, the ingest trigger enqueues, both entry-level locks release, and the successor check runs — if ingest entries are present and the ingest lock is won.
- **Running (either phase)** → **Idle (no process)** when the ingest phase finishes (or is skipped), the ingest lock is released, and any pending waiter/successor has been spawned.

### Summary-drain lock

- **Absent** → **Present (this worker holds it)** on successful acquisition.
- **Present (any holder, age ≥ staleness threshold)** → **Absent** when the next worker observes it as stale and removes it as part of acquisition.
- **Present (this worker holds it)** → **Absent** (PID-checked release) before the successor check and the ingest phase.

### Ingest lock (per worktree; see spec 259)

- **Absent** → **Present (this worker holds it)** on the fail-fast acquire (or the one post-record retry).
- **Present (held by a live ingest)** → this worker records the deferred-ingest flag and, if the retry also misses, exits; the holder's release-time wake re-launches it.
- **Present (this worker holds it)** → **Absent** (PID-checked release) in the ingest-phase teardown, followed by the deferred-ingest wake.

### Queue entry (from this worker's perspective)

- **Pending summary file in queue dir** → **Parsed entry in drain batch** during a list-and-parse pass.
- **Pending file with stale `createdAt`** → **Deleted** during the parse pass with no handler invocation.
- **Parsed summary entry** → **Dispatched to handler** → **File deleted** regardless of handler outcome.
- **Pending ingest file** → **Skipped by the drain** (filtered out) → **consumed by the ingest phase** → **deleted only on a successful ingest run** (a throw leaves it queued for the next run).

## Notable Behavior

- **The manual-disable gate makes the worker inert without touching a lock.** It is read after the log directory is set but before the per-vault write lock, the banner, and storage construction — so a disabled repository produces a worker process that logs one line and exits, indistinguishable from an unspawned worker in every on-disk respect. Placing it before the locks is what keeps a disabled repository from being observable in lock state (and therefore from perturbing the queue-status read or a sibling worker's staleness reasoning). (Surprising; intentional.)
- **Lock contention is silent and non-queueing.** When the lock is held, the second worker exits with a warning and does not retry, sleep, or wait. Producers (the post-commit and post-rewrite hooks) rely on the running worker's drain loop and the post-drain successor check to pick up entries they enqueue while the lock is held; producers do not re-spawn and do not poll. (Surprising; intentional.)

- **Lock liveness is decided purely by the lock file's modified timestamp.** The recorded process id is not used to detect a crashed holder; only the five-minute age threshold is. A long handler call that legitimately exceeds five minutes therefore looks indistinguishable from a crashed holder; a competing worker would consider the lock stale and remove it. (Surprising; intentional.)

- **Filename sort is the timestamp sort.** Drain order is established by sorting file names lexicographically. Because the names begin with a fixed-width-ish epoch-millisecond prefix produced by `Date.now()`, this sort matches creation order in practice. Two entries created in the same millisecond are tie-broken by the short-hash suffix in the file name. (Notable.)

- **Per-entry failure does not block subsequent entries.** A handler exception is caught, logged, and the next entry is processed. The failed entry's file is deleted just like a successful one. There is no per-entry retry, no quarantine, and no dead-letter directory. (Surprising; intentional.)

- **Failed entries are deleted, not retained.** The codebase explicitly notes that pipeline steps (cursor advancement, summary writes) are not idempotent, so naive retry could produce duplicate summaries or corrupt metadata; deletion is the safe default. The trade-off is that an LLM outage causes a permanently unsummarized commit unless a manual re-summarize is invoked later. (Surprising; intentional.)

- **The drain loop has a hard per-run cap of twenty entries.** Even if more entries are present, the worker stops after processing twenty and lets the post-drain successor check pick them up via a fresh process. The cap is a safety belt against an unexpected spin loop, not a normal-case throttle. (Notable.)

- **Stale entries are pruned during the parse pass, before dispatch.** Any queue file whose `createdAt` is older than the queue-entry stale threshold (seven days) is deleted in place; it does not count against the per-run cap and never reaches a handler. (Notable.)

- **Lock release happens before the successor-spawn check.** The current worker first releases both entry-level locks (per-vault write lock, then summary-drain lock), then lists the queue, then spawns the successor if needed. As a result the successor can immediately acquire the summary-drain lock without contending with the predecessor. The window between release and successor spawn is short but non-zero; if a hook spawns its own worker in this window it will succeed instead of waiting on the chain. (Surprising.)

- **The summary drain and the ingest phase use two different locks, on purpose.** The summary-drain lock is held only across summary generation; the ingest phase runs afterward under a separate per-worktree ingest lock (spec 259) with both entry-level locks released. This lets a same-repo summary successor run concurrently with a long (minutes-scale) wiki/graph ingest, and keeps the user-facing commit/squash/create-PR gate (which watches only the summary-drain lock — spec 112) open during ingest. (Surprising; intentional.)

- **Ingest entries are filtered out of the drain and are not a successor-spawn trigger.** The drain processes only summary-producing entries; ingest entries are left queued for the ingest phase, and the successor check spawns only for leftover **summary** entries. Ingest leftovers are picked up by the ingest phase and its deferred-ingest hand-off instead, so a chain spawn for them would double-run. (Notable.)

- **An ingest batch is all-or-nothing against its queue entries.** The consumed ingest entries are deleted only after the ingest run returns successfully; a throw leaves them queued for the next run. This differs from summary entries, which are deleted whether their handler succeeds or throws. (Surprising; the ingest pipeline is separately idempotent, so a full re-run is safe.)

- **The post-drain ingest trigger fires only when a commit-typed op was processed.** Ingest ops never set the flag, so the trigger cannot self-perpetuate; the trigger is further debounced by a per-cwd cooldown (spec 159). (Notable.)

- **The post-drain push-sync trigger is fire-and-forget and never blocks the worker.** It hands the just-generated commit hashes to the push engine (spec 269) on the next tick, filtered to those hashes, so a `git push` that outran summary generation completes once the memory lands — but it is not awaited, so a slow/offline upload cannot extend the lock hold or delay ingest, and a failure just leaves the entries pending for a later retry. Only summaries generated *this run* are handed off. (Notable.)

- **Successor spawn re-uses the spawn primitive used by hooks.** The worker has no privileged "in-process re-entry"; it spawns a brand-new detached process, just as a hook would, and unrefs it. (Notable.)

- **Worker can be invoked from arbitrary cwd.** The script reads the working-directory flag and uses that for all repository-rooted operations. The actual `process.cwd()` is irrelevant. (Notable.)

- **Storage backend is process-global.** The startup step that registers the backend mutates a module-level singleton; tests that share the worker function within a single process must reset it explicitly, and a misconfigured backend selected at startup persists for the run. (Notable.)

- **Spawn primitive must hide the platform-specific console window.** The detached spawn passes a hidden-window flag so that on platforms that draw a window for child processes there is no visible flicker on every commit. (Notable.)

- **The script auto-runs only when its file name on disk is the canonical worker file name.** Bundlers that inline the worker module into another bundle (for example the editor-extension bundle) end up with a different on-disk file name; the auto-run guard checks the canonical name to prevent the bundle's main script from accidentally re-entering the worker. (Surprising.)

- **The successor-spawn re-list step uses the same drain-listing routine that prunes stale entries.** If the only remaining files are stale — or are all ingest entries — no **summary** successor is spawned (ingest leftovers go to the ingest phase instead). (Notable.)

- **Each commit-typed entry emits a best-effort progress stream and holds a per-hash liveness lock.** Before dispatching it, the worker prunes aged progress artifacts, writes its PID into a per-hash lock file, and emits a start milestone; the pipeline stages emit further milestones (diff stats, linked references, analyzing, plan-progress) and a stored/skipped outcome. A terminal end milestone is always emitted in a `finally`, after which the per-hash lock is released only if this process still owns it. The rebase-pick migration and the squash/rebase-squash handlers participate in the same bracket. Emission and locking are entirely best-effort — a failure degrades the watcher's fidelity but never affects summary generation. (Notable.)

## Shared Behavior

- The repo-wide manual-disable flag read at startup — its storage, repo-wide anchoring, priority, migration, and the fact that the same gate is carried by every producing hook — is owned by the manual-disable spec.
- The format and lifecycle of an individual queue entry are defined by the **Queue Entry Format** topic.
- The transcript cutoff that the worker passes into the per-commit handler is defined by the **Summary Attribution by Transcript Cutoff** topic.
- The post-drain successor protocol that ensures no entry is ever stranded is defined by the **Worker Chain Spawn** topic.
- The full conversational pipeline that processes the per-commit kinds is defined by the per-commit summarization topic; its AI context-relevance filtering sub-stage is defined by spec 258.
- The consolidation pipeline shared by squash and rebase-squash is defined by the squash-consolidation topic.
- The one-to-one re-key used for rebase-pick is defined by the migration topic.
- The lock and queue file conventions on disk are also referenced by the doctor / cleanup topic, which detects stuck locks and stale queues.
- The per-vault write lock the worker acquires before storage construction and releases before the ingest phase (and re-acquires per write during ingest) is defined by spec 171.
- The per-worktree ingest lock and the single-slot deferred-ingest hand-off used by the ingest phase are defined by spec 259.
- The topic-KB ingest pipeline the ingest phase invokes, and the per-cwd cooldown debounce on the post-drain ingest trigger, are defined by specs 152 and 159.
- The queue-status read that reports the summary-drain verdict (and deliberately ignores the ingest lock and ingest entries) is defined by spec 218.
- The push-pending queue, its dedicated lock, and the claim-based drain engine that the post-drain push-sync trigger hands off to (with the `post-queue` source and a hash filter) are defined by spec 269. The pre-push hook that enqueues the pushed commits in the first place is defined by spec 268, and the startup / sign-in retry of all pending entries by spec 270.
- The per-commit progress stream, the per-hash capture lock, and the interactive watcher that observes them are defined by the Post-Commit Capture Progress Streaming spec.
