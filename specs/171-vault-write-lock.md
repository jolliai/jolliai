# 171. Vault Write Lock

## Topic Statement

Serialize concurrent writers against a single shared personal-space working tree by keying a host-machine file lock to the canonicalized identity of that working tree's root path.

## Scope

**In scope:**

- The identity of the lock — what string is hashed to produce a single stable per-working-tree lock file regardless of which process is asking.
- The full canonicalization contract that lock-using parties must independently arrive at the same string from any equivalent path the user may have configured.
- The location of the lock file (outside the working tree, under a per-user state directory) and the test-only environment override that redirects the parent directory.
- The two acquisition modes (fail-fast and bounded-wait) and the on-miss return that lets a caller branch.
- The production heartbeat-protected hold windows, in **two shapes**:
  - **Span holds** (the lock is held across a multi-step body) — the **queue-worker summary drain** (held from before storage construction through the last summary write, then released **before** the ingest phase); the **brief replay-plus-resolution span** inside one reconciliation round; the desktop editor host's **unused-folder archival sweep**; and that same host's **duplicate-folder consolidation**.
  - **Per-write re-acquire** (the lock is taken around one write and dropped, with the model-bearing work in between holding nothing) — the worker's **ingest phase**, the **single-target compile**, and the **multi-repo compile sweep**.

  The asymmetry is deliberate: the summary drain holds the lock for one full drain (potentially minutes); the reconciliation round holds it only across remote-replay-and-conflict-resolution and explicitly releases between phases; the two editor-host spans are short by nature (a directory scan and a set of filesystem moves) and are bounded by a short budget rather than by their own structure; and every per-write call site never holds it across a whole drain or pass at all — it grabs and drops it per write. Every long, model-bearing phase in the product sits outside a hold window.
- The three default wait budgets — one short (sync yielding to a busy worker, and reused verbatim by both editor-host spans), one longer (worker waiting through a busy sync), and the fail-fast single attempt — and the fact that a missed acquisition is benign for some callers and user-visible for others, routing to different recovery paths per call site.
- The **split busy discipline over one budget**: the two editor-host spans take the same short budget on the same user click, and one skips silently while the other fails visibly.
- The mtime heartbeat that prevents the stale-reclaim threshold from stealing a held lock during a long body.
- The cross-repo wakeup registry that converts a missed acquisition for one repo into a re-spawn — and the differing shapes in which a holder does (or does not) drain it: through the helper's optional release hook, by hand right after its own release, at the end of a surrounding round, or not at all.
- The diagnostic "is this lock held right now?" probe, advertised as racy.
- The mutual exclusion semantics observed by every caller and by tests: independent working trees never share a lock; the same working tree (whether configured as itself, via a symlink, or with case variation on a case-insensitive filesystem) always shares one.

**Out of scope (boundaries — what is sent or received but not re-specified here):**

- The PID-plus-mtime file lock primitive itself — the staleness threshold, the dead-owner reclaim rule, the PID-checked release, and the residual narrow stale-reclaim race are all properties of the shared host lock primitive and are not duplicated here.
- The reconciliation round's surrounding phases (credential mint, identity guard, allowlist staging, push retry, status emission). Only what enters and leaves this lock's hold window is described here. See spec 150.
- The queue worker's own per-source-repo lock that serializes two workers for the **same** source repo, its dispatch table, its drain loop, and its chain-spawn. Only the worker's outer acquire-and-release around the drain is described here. See spec 34.
- The personal-space backend write lock (a remote, server-issued lock with its own TTL and release endpoint). This spec is about a local on-disk lock; the backend lock is a separate mechanism.
- The machine-wide reconciliation mutex that serializes one reconciliation round against another reconciliation round across processes on the host. That lock is described in spec 172.
- What the compile entry points do with a busy acquisition (which step treats it as fatal, which degrade to a per-target failure or a warn-and-skip). The compile paths use this lock as clients, per write; the lock itself has no compile-specific behavior. See specs 159 / 160.
- What the two editor-host spans actually do inside their hold windows — the emptiness predicate and current-repository guard of the archival sweep, and the classification, copy-if-absent merge, metadata union and rebuild of the duplicate consolidation. Only what enters and leaves this lock's hold window, the budget each asks for, and each one's busy discipline are described here. See specs 358 / 359.
- The on-disk shape of the queue, the conflict-resolution tiers, the per-vault marker, the allowlist classifier, the aggregate-merge files, and every other piece of vault content the lock protects but does not interpret.
- The "personal-space busy" wait notification, the round result `lastError` code mapping, and the status surface. The lock raises a sentinel on timeout from one call site; how the surrounding round converts that sentinel into a stable error code and UI state is described in spec 150.

## Data Contracts

### Lock identity

A single absolute string derived deterministically from the user-configured local personal-space root by a fixed six-step canonicalization. Two processes that independently canonicalize equivalent inputs MUST produce byte-identical strings. The six steps, in order:

1. **Tilde expansion.** A leading `~` (bare or followed by a separator) is replaced by the user's home directory. No other tilde forms are recognized.
2. **Lexical absolute resolution.** Relative inputs are resolved against the current working directory; `.` and `..` segments are collapsed; duplicate separators are normalized. No filesystem access in this step.
3. **Partial real-path resolution.** The path is walked from leaf toward root until an existing ancestor is found. That ancestor is resolved through any symlinks in its chain to a real on-disk path, and the non-existent tail segments are reattached lexically. This step exists so the canonicalization is stable both before and after the working tree is first created on disk (cold start before clone); pure real-path resolution would otherwise throw on a not-yet-cloned tree. If even the filesystem root cannot be inspected, the input from step 2 is returned unchanged.
4. **Case folding on case-insensitive filesystems.** On host filesystems that are case-insensitive at the kernel level (Windows and macOS), the path is lowercased. On case-sensitive hosts (Linux), case is preserved. This step is applied unconditionally to the entire path string (not just the leaf) so two inputs that differ only in case map to the same lock on a case-insensitive host.
5. **Separator normalization.** Any run of forward-or-back slashes is collapsed to a single platform-native separator. On a non-root path a single trailing separator is stripped.
6. **Hashing.** A SHA-256 hex digest of the canonical string forms the lock filename body.

Empty input is rejected with an explicit error (caller bug).

The contract is symmetric: every production caller — the queue worker, the reconciliation round, and the desktop editor host — invokes the same canonicalization helper on **already-resolved** working-tree root paths, never on the raw user-configured value. The lock would silently fail to exclude if one caller hashed a raw configured value and another hashed a derived value, because step 3 cannot retro-resolve a user-typed environment-variable reference or per-config default folder that the consuming code has already substituted. The editor host is the newest party to that contract and it satisfies it the same way: the value it hands in is the validated, default-resolved Memory Bank parent it also uses to enumerate repositories, not the raw configured string.

### Lock file location

`<lock-dir>/vault-<sha256-hex>.lock`, where:

- `<lock-dir>` defaults to a fixed subdirectory under the per-user state root that hosts every host-side jollimemory lock.
- The subdirectory may be overridden by a documented environment variable (used by the acceptance suite to redirect lock state away from a developer's real installation). An explicitly empty override is treated as unset.
- The parent directory may not exist on a fresh install; the acquire path creates it on demand.

The lock file is intentionally placed **outside** the working tree it protects, because at least one caller (the queue worker) must acquire the lock **before** any code that touches the working tree's per-repo configuration directory runs. A lock inside the working tree would be unreachable in that pre-init window, and racing two callers through the per-repo config-creation path is exactly the corruption surface this lock was added to close.

The hash-derived filename is fixed-length and printable regardless of the exotic-ness of the user-configured working-tree path (spaces, non-ASCII, very long).

### Acquisition modes

A caller passes one of two mode discriminators:

- **Fail-fast.** Single-shot attempt. Returns "acquired" or "miss" immediately.
- **Bounded wait.** Carries an integer millisecond budget. Polls at a fixed short interval (default 100 ms) up to the budget; returns "acquired" on success, "miss" on timeout. A zero budget collapses to fail-fast semantics.

### Acquired handle

The acquire call returns either a small handle bundle or a "miss" sentinel (null). The handle exposes exactly two operations:

- **Release.** Idempotent best-effort removal of the lock file, gated by a PID-ownership check inherited from the host lock primitive (will not delete a lock currently owned by a different process — protects against the stale-reclaim race).
- **Refresh.** Bumps the lock file's modification time. Skipped if the lock has been reclaimed by a different owner since acquisition.

The handle interface is callable from any context; callers MUST release on every exit path (typically via a try/finally).

### Heartbeat cadence

Every caller, while holding the lock for any non-trivial body, runs a periodic `refresh` on a 60-second cadence. The cadence is fixed at 60 seconds and is more than two times below the host primitive's 5-minute stale-reclaim threshold, leaving margin for a missed scheduler tick. The same 60-second cadence is used by the per-source-repo summary-drain lock, the per-worktree ingest lock (spec 259), and the machine-wide reconciliation mutex, so all jollimemory long-held locks heartbeat in lockstep against the same threshold.

The heartbeat timer is unreferenced where the host supports it, so a single-shot CLI process that completes its real work cannot be kept alive by the heartbeat alone.

### Default wait budgets

Two named budgets are defined, and one of them is now shared by three unrelated call sites:

- **Worker budget.** 60 seconds. Used when a hook-spawned queue worker discovers a held lock and prefers to wait rather than abandon its queue entries; also used by the worker's per-write ingest guard and by both compile entry points. Sized to cover the 95th-percentile reconciliation round and a typical worker drain.
- **Yield budget.** 10 seconds. Used by the reconciliation round at its remote-replay site when a queue worker is mid-drain — intentionally **below** the worst-case worker hold time so the round yields rather than waits through a multi-minute drain; the miss converts to a transient error code, the round skips, and the next periodic round retries. **Both editor-host spans reuse this same budget** for the same reason: neither may block a user's click on the tree's Refresh button through a model-bearing drain.

The yield budget is where the two disciplines diverge, and the divergence is per call site rather than per budget. On a full-budget miss the archival sweep **reports nothing archived and says nothing at all** — indistinguishable to its caller from a sweep that found nothing to do — while the duplicate consolidation raises a typed "vault busy" signal that its caller turns into a message telling the user the product is busy writing a summary and to click Refresh again shortly. The rule is whether the user asked for that specific operation: a Refresh implies the re-listing, so the tidy-up may silently defer; a modal-confirmed merge may not, because a silent swallow would look like the confirmation did nothing.

### Cross-repo wakeup registry (for the bounded-wait worker call site)

A sibling directory next to the lock file, named `vault-<sha256-hex>-pending/`. One file per pending source-repo cwd; the filename is a SHA-256 of the cwd, the file contents are the absolute cwd verbatim. Lifecycle:

- When a queue worker fails to acquire after exhausting its wait budget, it writes its cwd into this registry before exiting. Writes are idempotent: two timeouts for the same cwd collapse to the same filename. Errors writing the registry are logged but not fatal — at worst, that timeout victim won't be auto-woken and its queue entries will wait for the next post-commit hook.
- When a holder releases **and supplied the release hook**, the helper reads the registry, deletes each entry **before** acting on it (so a concurrent producer cannot have its just-written entry consumed), and invokes a caller-supplied "launch worker for cwd" callback for each consumed entry. The launch helper is idempotent against an empty queue, so a redundant spawn is harmless. **Exactly three call sites supply the hook**, and all three are per-write re-acquires: the worker's ingest write guard, the single-target compile's write guard, and the multi-repo compile sweep's write guard.
- **Draining and supplying the hook are not the same thing, and two holders drain by other means.** The queue-worker drain does not use the body-style helper at all: it acquires directly and calls the same registry drain itself, immediately after releasing (and again in its backstop `finally`), passing its own cwd as the self-exclusion. The reconciliation round supplies nothing to this lock and drains nothing on release either — its drain is a **round-complete** callback wired in at sync bootstrap, so it fires after the whole round (past the machine-wide mutex release), not when this lock frees at the end of replay. A reader tracing "who wakes waiters" therefore has to look in three different shapes.
- **Two holders neither supply the hook nor drain by any other means.** Both editor-host spans — the archival sweep and the duplicate consolidation — pass no release hook, so a worker that timed out waiting for this lock and recorded itself in the registry is not woken when either of them frees the lock. It stays in the registry, its queue entries undrained, until its own repository's next commit spawns a fresh worker. The hook is an optional argument on the body-style helper, so nothing about the omission is visible at the call site or reported anywhere.
- A worker that hits the registry with its own cwd present is filtered out (no self-launch).
- The empty registry directory is best-effort removed after a consume pass; a concurrent producer that just landed an entry blocks the directory removal benignly.

This registry exists because the lock is per-vault but queue entries are per-source-repo: a long drain in repo A can starve repo B's worker, whose queue entry would otherwise sit until repo B's user happens to commit again (potentially hours).

### Diagnostic probe

A separate read-only probe answers "is this lock currently held by a non-stale owner?" by inspecting the lock file's modification time against the host primitive's staleness threshold. It is documented as racy (the lock can be released between the probe and any follow-up action); callers that need to act on the outcome must instead attempt acquisition.

## Behavior

### Acquire — fail-fast

1. Compute the lock file path from the supplied already-resolved working-tree root via the six-step canonicalization and SHA-256 of the canonical string.
2. Ensure the lock file's parent directory exists, creating it recursively on demand.
3. Delegate to the host primitive's single-attempt acquire. The primitive either creates the lock file exclusively (success) or returns false (an existing fresh lock is held by a still-live owner).
4. On success, return a handle whose `release` is the primitive's PID-checked release and whose `refresh` is the primitive's mtime bump.
5. On miss, log at debug level and return null.

### Acquire — bounded wait

1. Compute the lock file path and ensure the parent directory exists (same as fail-fast).
2. Delegate to the host primitive's poll-acquire with the caller-supplied millisecond budget and the fixed 100 ms poll interval. The primitive enters a loop that calls single-attempt acquire, returns true on success, returns false once the deadline is exceeded, and sleeps the poll interval between attempts. A non-positive budget collapses to a single fail-fast attempt.
3. On success, return the handle.
4. On timeout, log at debug level and return null.

### Wrapped acquire — body-style helper

A convenience helper composes acquire-run-release as a single call: it acquires the lock in the caller-chosen mode, starts a 60-second heartbeat timer for the duration of the body, runs the body, then on every exit (normal return, body throw, early return) clears the timer and releases the handle. It takes the release hook as an **optional** argument, so a caller that omits it gets a correct acquire-and-release with no registry drain and no diagnostic. The helper reports back one of two outcomes:

- **Body ran.** The lock was acquired and the body completed (normally or by throw). On throw the thrown value propagates after the release; on normal return the body's value is returned.
- **Lock busy.** The acquire missed; the body did not run.

The helper is the documented call shape for **every per-write re-acquire** — the worker's ingest phase and both compile entry points all reach the lock through it, which is also what gives all three the same on-release cross-repo wakeup behavior for free.

It is **not** exclusive to the per-write shape. Two of the four span holds use it as well: both editor-host spans wrap their whole body in it, because their bodies own no additional state and their only branch on the outcome is the busy path. The other two span holds do not: the queue worker's entry-level acquire and the reconciliation round use a manually composed acquire / try / finally because their try blocks own additional state (the worker's per-repo lock; the round's per-round disposition holder) that cannot be hidden behind a single helper.

Reaching the lock through the helper is therefore not what gives a caller the on-release wakeup drain — supplying the hook is. Both editor-host spans use the helper and omit the hook.

### Production hold window — queue worker (summary drain only; released before ingest)

The queue worker holds this lock around the **summary drain only** — from before storage construction through the last summary write — and **releases it before the ingest phase runs**. The ingest phase then re-acquires the lock per individual write (see the next section). The exact ordering is:

1. Worker process starts and logs its startup banner.
2. Load the persisted global configuration to discover the configured personal-space root.
3. Compute the already-resolved working-tree root once and feed it to the lock as the identity input.
4. Attempt to acquire in bounded-wait mode with the **worker** budget (60 seconds).
   - **Miss path:** Record this worker's source-repo cwd in the cross-repo wakeup registry. Then attempt **one** fail-fast re-acquire (a lost-wakeup guard: if the holder released in the gap between the wait expiring and the record landing, this second attempt grabs the freed lock and proceeds instead of stranding the queue entry). If that too misses, log a warning carrying the budget and the configured root and return immediately; the registry consumer re-spawns the worker when the holder releases.
   - **Hit path:** Continue.
5. Start a 60-second heartbeat timer that calls the handle's `refresh`.
6. Construct the storage layer. This is the side-effectful path the lock was added to protect: storage construction creates the per-repo configuration directory inside the personal space, and concurrent uncoordinated execution would race on the per-repo-identity assignment.
7. Acquire the per-source-repo summary-drain lock (a narrower, separate lock that serializes two summary workers for the same source repo). This lock is described in spec 34. Failure to acquire it returns the worker with the heartbeat still running on the outer lock — the backstop `finally` (step 12) releases it.
8. Start a second 60-second heartbeat for the per-source-repo summary-drain lock.
9. Run the **summary** drain: dequeue all entries in timestamp order, process only the non-ingest (summary-producing) entries, delete each processed entry's file after the handler returns (success or failure), and apply an upper bound on entries processed per run. Ingest-kind entries are left on the queue for the ingest phase. After the drain, if at least one commit-type operation was processed, enqueue a debounce-style topic-index-ingest entry so a later drain picks it up.
10. **Release both entry-level locks BEFORE ingest.** Release this vault-write lock (idempotently), then release the per-source-repo summary-drain lock, clearing both heartbeats. Releasing the vault lock lets cross-repo summary workers proceed; releasing the summary-drain lock lets a **same-repo** summary worker (a commit that landed during/after the drain) run concurrently with the ingest phase that follows. Then drain the cross-repo wakeup registry so vault waiters do not idle through the ingest.
11. **Chain-spawn check.** If any **summary** (non-ingest) entries remain — arrived past the per-run cap or during the drain — spawn a successor worker (detached). This now runs **after** the locks are released, so the successor can immediately win the fail-fast summary-drain lock on its own entry. Ingest leftovers are deliberately **not** a chain-spawn trigger; they are consumed by the ingest phase and its own deferred-ingest hand-off (spec 259), so spawning for them would double-run.
12. **Ingest phase.** Runs with neither entry-level lock held, under its own ingest lock (spec 259); its writes re-acquire this vault-write lock per write (next section).
13. **Backstop finally (idempotent):** re-run both releases and the registry drain to cover early-return and mid-run-throw paths where step 10 did not run.

The **summary** hold window therefore covers everything between storage construction and the last summary write. The worker cannot release between files within a single multi-file summary write (canonical JSON, visible Markdown, aggregate-index updates) because that would expose exactly the cross-file tear the lock exists to prevent. But the window ends at the summary drain — the ingest phase is explicitly outside it.

### Production hold window — queue worker ingest phase (per-write re-acquire)

The worker's topic-KB ingest phase (owned by spec 259 for its own lock and hand-off, and spec 152 for the pipeline) runs **after** both entry-level locks above are released, concurrently with any same-repo summary successor. It never holds this vault-write lock across the whole ingest. Instead, each individual ingest write goes through a per-write guard that:

1. Acquires this vault-write lock in **bounded-wait** mode with the **worker** budget (60 seconds).
   - On a full-budget miss, the guard raises a typed "vault busy" sentinel; the pipeline treats that page as a benign hold (its sources stay pending and are retried on the next drain) rather than a hard failure.
2. With the lock held, runs the write **nested inside the repo-level orphan-write lock** — the same vault→orphan lock ordering the summary write path uses, so ingest's orphan-ref writes serialize against the now-concurrent summary writes on that same orphan lock. (A folder-only wiki write that this guard also wraps is already covered by the vault lock; the extra orphan lock there is harmless.)
3. Releases the orphan lock, then this vault lock, then wakes cross-repo vault waiters via the wakeup registry.

The lock-free reconciliation model calls **between** writes hold no lock, which is the whole point of the split: a minutes-long ingest never holds the vault lock across its LLM phase and therefore never blocks a concurrent commit-summary worker. Optimistic concurrency covers the gap — each guarded write re-reads the target inside the lock and holds (skips) the source rather than clobbering a page a sync pull or another drain rewrote during the lock-free phase.

### Production hold window — reconciliation round (replay + resolution only)

The reconciliation round acquires the lock for **only** the remote-replay-and-conflict-resolution window inside one round. The round's other phases (credential mint, identity guard, clone-or-fetch, branch recovery, auto-reconcile, allowlist staging, commit, push) run **without** this lock; they are serialized only against other reconciliation rounds by a separate machine-wide reconciliation mutex (spec 172). The exact composition:

1. The round acquires the reconciliation mutex (this is the outer per-round mutex; see spec 172) and proceeds through its pre-replay phases.
2. At the remote-replay step, the round invokes a wrapper that:
   1. Attempts to acquire this lock in bounded-wait mode with the **yield** budget (10 seconds).
   2. **Miss path:** Throws a sentinel error specifically identifying "vault-write lock unavailable for replay; a queue worker is busy". The round's outer catch maps this sentinel to a transient error code (the same code used for "network is currently unavailable"), which causes the round to surface "currently offline" and to be retried at the next periodic poll. The mutex (spec 172) is released as part of the round's normal teardown. **Note: this sentinel is the only way the round can return without having fetched or pushed.**
   3. **Hit path:** Starts a 60-second heartbeat for this lock, runs the inner body, clears the heartbeat in a `finally`, releases this lock. **No cross-repo registry drain happens here** — the round's drain is round-scoped (below), not release-scoped.
3. The inner body of the wrapper does **both** of the following back-to-back:
   - Replay remote changes through the rebase-style integration step.
   - If the replay reported any conflicted paths, run the conflict-resolution tier pyramid against those paths. Conflict resolution may invoke AI-mediated merges (long-running) and/or open-ended user prompts (unbounded); the heartbeat protects against the stale-reclaim threshold reclaiming the lock during these long operations.
   - The reason both halves are inside the same hold window is that replay returns with the integration **paused on disk**; releasing the lock between replay and resolution would let a concurrent queue worker write into the paused-rebase window, which is the corruption surface this lock was added to close.
4. After the lock is released, the round continues into the non-locked phases (mapping resolve, allowlist stage, commit, push). A concurrent queue worker may now begin writing; its writes may produce a partial overlap with the round's stage-and-commit pass, captured as a **benign / eventually consistent** outcome: nothing is lost from disk; at worst the round's commit captures some files of a multi-file worker write but not others, and the **next** round picks up the remainder.
5. A second site inside the same round can re-acquire this lock: the push-with-retry helper, on a non-fast-forward rejection, runs a second replay to integrate the racing remote commit. That second replay is also wrapped in the same bounded-wait acquire (yield budget). A timeout at this second site is also mapped to the transient code, again skipping the round.
6. At the **end of the round** — after the backend lock and the machine-wide reconciliation mutex are released, and long after this lock was — a round-complete callback wired in at sync bootstrap spawns a worker for the round's own cwd and drains the cross-repo pending-workers registry. That is the round's only interaction with the registry: it supplies no release hook to this lock, so a waiter recorded against this lock is woken at round completion rather than at the moment replay released.

The asymmetry is **by design**, not an oversight: holding the lock around the whole round (30–90 seconds in practice) would force the user-facing latency between a `git commit` in the source repo and the summary appearing in the UI to span the full round. Releasing between replay and commit accepts the "benign partial-commit" outcome in exchange for that latency reduction. The race the lock definitively closes is the paused-rebase-window write; the race the lock deliberately does **not** close is the partial-commit window.

### Production hold window — compile paths (per-write re-acquire)

Both compile entry points — the single-target compile and the multi-repo sweep (specs 159 / 160) — use the **same per-write shape as the worker's ingest phase**, not a pass-spanning hold. Neither wraps its pass in one acquisition:

1. Each persistence step goes through the body-style helper individually, acquiring in **bounded-wait** mode with the 60-second budget, and releasing on that step's exit.
2. Waking cross-repo vault waiters happens on each of those releases, because both compile paths supply the release hook.
3. The model-bearing phases in between — the reconcile calls inside the drain, and the knowledge-graph build — hold **no** lock at all.

Consequences that follow from there being no pass-spanning acquisition:

- **A compile hold window is one write, not one pass over the vault.** A compile pass may run for minutes; the lock is unheld for nearly all of it.
- **There is no whole-pass miss path.** A compile can never be declined as a unit — a busy acquisition is scoped to the individual write that asked for it, and neither entry point reports a "skipped because another writer holds the lock" outcome. What a busy write does instead is the caller's business: the sweep records it as a per-target failure or (for a derived-layer step) warns and skips; the single-target compile treats it as fatal at exactly one step, its rebuild reset, and non-fatal everywhere else.
- **Correctness across the released intervals** comes from the drain's optimistic concurrency (each guarded write re-reads its target inside the lock and holds rather than clobbering), identically to the ingest phase above — not from lock duration.

### Production hold windows — the desktop editor host's folder-tree tidy-up (two span holds on one click)

A user-initiated Refresh of the editor's Memory Bank folder tree runs two operations before it re-lists the tree, and each takes this lock for its whole body through the body-style helper, in **bounded-wait** mode with the **yield** budget:

1. **The archival sweep.** Inside the hold window it enumerates the repository folders under the vault parent and moves every one that provably holds nothing into the vault's hidden archive directory. What enters the window is the vault parent path; what leaves is the list of folders moved. On a full-budget miss the helper reports "lock busy", the body never runs, and the sweep answers "nothing archived" — **the miss is not distinguished from an empty result anywhere**, which is what makes the skip silent.
2. **The duplicate consolidation.** Its detection and its user confirmation both run **outside** the lock; only the execution is inside. Inside the window it copies files between folders, rewrites the survivor's metadata registries, regenerates missing human-readable copies, and moves the drained folders into the same archive directory — or, on the rebuild path, archives every folder and re-populates a fresh one from the system of record. On a full-budget miss it raises a typed "vault busy" signal that reaches the user as a retry instruction.

Why the lock is needed here at all: the vault parent is itself a version-controlled working tree, so each folder move is simultaneously an unlocked working-tree mutation and an implicit staged removal of that folder's tracked metadata documents. Without the lock either operation can land in the middle of a queue worker's multi-file summary write, or after a reconciliation round has already snapshotted the working tree's status and before it stages, or during a compile pass's write.

Neither span supplies the release hook, so neither wakes a worker parked in the cross-repo registry (see that section).

### Mtime heartbeat

While any caller holds the lock for a non-trivial body, a recurring 60-second timer calls the handle's `refresh`. Each `refresh`:

1. Reads the PID written into the lock file.
2. If the PID is absent or does not match the current process, does nothing (the lock has been reclaimed by another owner; refreshing would extend a lock the holder lost).
3. Otherwise, updates the lock file's modification time to the current wall clock.

The timer is unreferenced on hosts that support timer reference counting, so a short-lived CLI process is not kept alive past its real work by an idle heartbeat.

### Diagnostic probe

A separate function answers "is the lock currently held by a non-stale owner?" by stat'ing the lock file:

1. If the file does not exist, returns false.
2. If the file's modification time is within the stale-reclaim threshold, returns true.
3. Otherwise, returns false (the file exists but is stale — the next acquirer will reclaim it).

The probe never modifies state and never falls through to acquire on the caller's behalf. It is documented as racy.

## State Transitions

The lock has only two on-disk states:

- **Free.** Lock file absent, OR present but older than the stale-reclaim threshold (the host primitive's threshold), OR present but the written PID is no longer alive on this host.
- **Held.** Lock file present, younger than the stale-reclaim threshold, and the written PID is still alive.

Transitions:

| From | Action | To | Notes |
| ---- | ------ | -- | ----- |
| Free (absent) | acquire | Held | A new file is created exclusively; the host primitive's `wx` flag rejects a concurrent winner. |
| Free (stale or dead-owner) | acquire | Held | The primitive removes the stale file, then creates a new one. |
| Held | another caller's acquire (fail-fast) | Held | Returns null. |
| Held | another caller's acquire (wait) within budget | Held → Free → Held | The caller polls until the holder releases; the host primitive may briefly observe the lock free between the holder's release and this caller's create. |
| Held | another caller's acquire (wait) exhausting budget | Held | Returns null. |
| Held | holder's refresh tick | Held | Mtime advances; staleness countdown resets. |
| Held | holder's release | Free | PID-checked removal. |
| Held | foreign caller's release | Held | PID-checked; no-op. |
| Held | stale threshold elapses without refresh | Free (stale) | Next acquirer's reclaim sweep removes the file. |

## Notable Behavior

- **Asymmetric scope is intentional, not an oversight — and the asymmetry has one governing rule: no model-bearing phase may sit inside a hold window.** The queue worker holds the lock for its whole **summary** drain but releases it before the ingest phase; the reconciliation round holds it only across replay-plus-resolution; the ingest phase and both compile entry points hold it per write and nothing more; the two editor-host spans hold it across a body that contains no model call at all. The UX cost of holding a lock across a long model-bearing phase was the gating reason in every case:
  - Holding the round-side lock around the whole round would reopen a multi-minute latency the design accepted a benign partial-commit window to close.
  - Holding the **ingest** across its whole drain would block commit-summary generation for minutes — which is why ingest was moved outside the drain window onto per-write re-acquires.
  - **The compile entry points were moved for the identical reason, and the symptom was observed in production:** a multi-minute compile that held this lock across its whole pass starved the commit-summary workers, which exhausted their 60-second budget and exited leaving their queue entries undrained. Commit memory is high-priority and user-visible; a "build the wiki" pass is low-priority and may proceed slowly. So compile now yields between writes too, and the cost it accepts in exchange is that two compiles over the same vault can overlap (safe under the same optimistic concurrency) and that a page-purge which needs a continuously-held lock is no longer safe to run outside an explicit rebuild.

  Read together, the three cases are one rule applied three times, not three local decisions: whenever a hold window grew to span a model call, the fix was to shrink the window to a single write and lean on optimistic concurrency for the gap — never to lengthen anyone's wait budget.

- **One budget, two opposite busy disciplines, on the same click.** The two editor-host spans both take the yield budget against the same lock, milliseconds apart, and answer a full-budget miss oppositely: the sweep silently reports nothing archived, the consolidation raises a typed signal that becomes a user-visible retry instruction. This is the first pair of callers of this lock whose disciplines disagree, and the axis they disagree on is not the budget but whether the user asked for that specific operation. A future reader who infers a discipline from the budget will infer the wrong one for one of the two. (Surprising.)

- **A busy miss on the sweep is indistinguishable from a clean sweep.** Its result is a list of archived folders, and both the miss and the nothing-to-do case produce the empty list. Its caller suppresses the notification on an empty list, so a vault that has been busy for every Refresh all day produces exactly the same user experience as a vault with nothing to tidy. That is the intended cost of "never block the click", but it means the sweep has no observability at all under contention. (Notable.)

- **Two holders drain no waiters on release, and the omission is invisible.** The release hook is an optional argument to the body-style helper. Both editor-host spans use the helper and omit it, so a queue worker that timed out on this lock and recorded itself in the cross-repo registry is *not* re-spawned when either of them releases — it waits for its own repository's next commit. Nothing type-checks, tests, or logs the difference; the failure is a stranded queue entry with no message anywhere. (Surprising; the shape that made this easy to get wrong is that the helper is correct without the hook, just less useful to everyone else.)

  **What this is not is "every other holder passes the hook."** Three call sites do, all of them per-write re-acquires: the worker's ingest guard and the two compile guards. The queue-worker drain passes none — it acquires without the helper and calls the drain itself just after releasing — and the reconciliation round passes none and drains at *round* completion rather than at lock release. So the population splits three ways (hook, drains by hand, drains not at all), and only the third way loses a waiter.

- **Lock identity uses already-resolved roots, not raw configured values.** Every production caller MUST pass the post-derive working-tree root (i.e., the configured local root with subdirectory and tilde expansion already applied). Passing the raw configured value silently defeats the lock because the canonical hash would differ between the worker (which derives once at entry) and the round (which derives during context resolution).

- **The lock lives outside the working tree on purpose.** The queue worker must acquire **before** constructing storage, because storage construction is itself the side-effectful path that needs serializing. A lock inside the working tree would not exist before the working tree is first created and would race the same way storage construction races without the lock.

- **Cross-platform path canonicalization has six steps, all six are load-bearing.** Tilde expansion is needed because the configured root may begin with `~`. Lexical resolution is needed for relative inputs. Partial real-path resolution is needed for the cold-start case where the working tree has not yet been cloned. Case folding is needed on macOS / Windows so a user-configured `/Volumes/Foo` and `/volumes/foo` hash to the same lock. Separator normalization is needed because both forward and back slashes appear in user-typed configurations. Hashing is needed so exotic paths produce a fixed-length printable lock filename. A canonicalization that elides any one step produces non-overlapping locks for inputs that point at the same working tree.

- **The "partial real-path" trick (resolve the nearest existing ancestor, reattach the tail lexically) is what makes the canonicalization stable both before and after the working tree is materialized.** Pure real-path resolution would throw on the cold-start case; pure lexical resolution would diverge as soon as one party canonicalizes after a symlinked parent appears. The partial approach gives the same canonical string before and after the working tree exists.

- **Two default wait budgets, and distinct recovery paths per caller.** The longer 60-second budget is used by the worker's entry-level acquire, by its ingest phase's per-write guard, and by both compile entry points; the shorter 10-second yield budget is used by the reconciliation round and by both editor-host spans. On timeout the worker's entry acquire records itself in the cross-repo wakeup registry; the round throws a sentinel that it maps to a transient error code and the next periodic round retries; a per-write miss inside ingest or compile is scoped to that one write (a held source, a per-target failure, or a warn-and-skip, depending on the caller); the archival sweep answers "nothing archived" silently and the duplicate consolidation surfaces a retry instruction. The budget asymmetry encodes a directional preference: writers with on-disk work queued wait through sync rounds; sync rounds and user-interface work yield to them (they will run again soon).

- **The stale-reclaim race the host primitive does not close is inherited here.** There is a sub-millisecond window between one process observing the lock as stale and removing it, and another process having just refreshed the mtime. Both processes can then believe they hold the lock. The 60-second heartbeat cadence against the 5-minute threshold makes this window vanishingly small, and the PID-checked release at least prevents accidental cross-process file deletion outside the race window itself. Closing the race entirely would require an atomic rm-if-mtime-unchanged primitive that the host filesystems do not all provide.

- **The cross-repo wakeup registry is a separate sidecar storage with its own correctness story.** A producer (timed-out worker) writes a per-cwd file whose name is a hash of the cwd; duplicate writes are idempotent at the filename level. A consumer (lock releaser) deletes each file before launching the corresponding worker so a concurrent producer's just-written entry cannot be lost. The worst-case outcome of a producer/consumer race is one redundant spawn or one missed spawn that the next round picks up; the launch helper is idempotent against an empty queue.

- **Refresh is PID-checked, not just a blind mtime bump.** A holder that lost the lock to a stale-reclaimer must not bump the mtime back, because doing so would extend a lock the original holder no longer owns and let the original holder believe it still holds it. This couples to the stale-reclaim race noted above: the residual narrow window cannot be closed at this layer, but the PID-checked refresh ensures that once the original holder loses the lock and a new holder takes it, the original holder's running heartbeat does not interfere with the new holder.

- **The diagnostic probe never converts to acquisition.** Callers that want to act on "is the lock held?" must call acquire; the probe is intentionally racy and intended only for status displays and tests. Code that branches on the probe and then writes to the working tree is a bug.

- **Release is best-effort but PID-checked.** A PID-mismatched release is a no-op (do not delete a freshly-acquired peer lock). A release that fails for filesystem reasons is logged and swallowed; the host primitive's stale-reclaim path reclaims abandoned locks at the threshold.

- **Heartbeat timers are unreferenced.** A short-lived CLI process that finishes its real work is not kept alive by the heartbeat timer alone. The trade-off is that a process that returns control to the event loop without explicitly releasing the lock relies on a separate `finally` block to release; there is no separate "lifeline" timer that holds the process alive solely to refresh.

- **The bounded-wait poll interval (100 ms) is shared across all bounded-wait acquires of this lock.** A future caller that wants different polling granularity would need to plumb a separate knob; the current interface fixes it.

- **The environment override that redirects the lock parent directory is intended for the acceptance suite.** It mirrors the existing override convention used by the machine-wide reconciliation mutex (spec 172), so a developer running tests locally does not collide with their real installation's locks. An explicit empty value falls back to the default — otherwise an accidental empty assignment in a shell rc would stash locks in the current working directory as bare `.lock` files (a confusing failure mode).

## Shared Behavior

- **Host PID-plus-mtime file lock primitive.** Inherited verbatim: 5-minute stale-reclaim threshold, dead-owner reclaim (the written PID is no longer alive on this host), PID-checked release, and the narrow stale-reclaim race noted above. The same primitive backs the per-source-repo summary-drain lock (spec 34), the per-worktree ingest lock (spec 259), and the machine-wide reconciliation mutex (spec 172); all of them heartbeat at 60 seconds against the same 5-minute threshold.

- **Per-source-repo summary-drain lock (spec 34).** Acquired **inside** this lock's hold window by the queue worker during the summary drain. Narrower scope: serializes two summary workers for the same source repo only; cannot prevent a same-vault cross-source-repo tear, which is why this outer lock exists. Released before the ingest phase.

- **Per-worktree ingest lock (spec 259).** A distinct sibling that serializes the worker's topic-KB ingest phase against itself. It is held while the ingest phase runs, but this vault-write lock is **not** held for that duration — the ingest phase re-acquires this lock per individual write instead. The two are orthogonal: the ingest lock bounds "one ingest per worktree," this lock bounds "one vault writer at a time."

- **Machine-wide reconciliation mutex (spec 172).** Acquired **outside** this lock's hold window by the reconciliation round. Different scope: serializes two reconciliation rounds against each other across processes; does not serialize a round against a queue worker, which is why this lock is acquired at the round's replay site.

- **Cross-repo pending-workers registry.** Defined in this spec because its producer is a timed-out acquire of this lock. Its consumers are **not** uniform: the launch-on-release callback is supplied by exactly three per-write call sites — the worker's ingest guard (spec 34) and both compile entry points (specs 159 / 160); the queue-worker drain (spec 34) drains the registry by hand right after releasing rather than through the hook; and the reconciliation round (spec 150) drains at **round** completion, wired into the round's own teardown rather than into this lock's release. The two editor-host spans (specs 358 / 359) are holders that are **not** consumers by any route: they release without draining, so a waiter recorded in the registry survives their release untouched.

- **The desktop editor host's folder-tree tidy-up (specs 358 / 359).** Two span holds taken on one Refresh click, both through the body-style helper with the yield budget, both omitting the release hook, and with opposite busy disciplines. What each does inside its window — the emptiness predicate and the current-repository guard for the sweep; the classification, the copy-if-absent merge, the metadata union and the rebuild for the consolidation — belongs to those specs; this one owns the budget they ask for and the disciplines they answer a miss with.

- **Reconciliation round outer flow (spec 150).** The "vault-write busy" sentinel raised at this lock's reconciliation-round call sites converts to a transient error code at the round's outer catch boundary. The round's full mapping of error codes to UI states is described in spec 150; only the boundary contract (sentinel name and routing target) is described here.

- **Compile entry points (specs 159 / 160).** Both the single-target compile and the multi-repo sweep use the body-style helper **per write** — not around a pass — to serialize against this lock's other consumers, and both supply the launch-on-release hook. Neither contributes any new behavior to the lock itself; what differs between them is only how each treats a busy acquisition, which is specified on their side.
