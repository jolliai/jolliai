# 31. Post-Commit Hook Enqueue

## Topic Statement
Detect the operation kind that produced the just-completed commit, decide whether to handle it now or defer to the post-rewrite hook, write a single queue entry describing the operation, and spawn a detached background worker to process the queue.

## Scope
**In scope:**
- The hook's contract with the VCS (when it is invoked, what arguments it receives, expected exit timing).
- The repo-wide manual-disable gate read before any other work, and what returning on it rules out.
- The skip-or-handle decision against the detected operation kind.
- The schema and target location of the queue entry written for handled operations.
- The validation, consumption, and deletion of an optional pre-staged squash pending-state file.
- The detection and consumption of an optional one-shot "this commit came from the graphical-client integration, not the command-line" marker file.
- The spawning of a detached background worker process after enqueue.
- The optional, gated interactive capture-progress feedback watch performed after enqueue and worker-spawn.
- Behavior when reads or writes during the hook fail.

**Out of scope (boundaries):**
- The classification logic itself (covered by **Git Operation Type Detection**).
- The amend / rebase paths, which are detected here but handled by a separate hook (covered by **Post-Rewrite Hook Handling**).
- The pre-operation writing of the squash pending-state file (covered by **Prepare-Commit-Msg Squash Detection**).
- The worker that drains the queue (covered by the queue-worker spec).
- Per-summary storage and merge logic (covered by orphan-branch storage and summary-tree specs).

## Data Contracts

### Hook contract
- The VCS invokes this hook synchronously after every successful commit. It is called with no arguments. It is expected to return quickly (the design budget is on the order of a few milliseconds; longer execution blocks the user's commit). The manual-disable read that now precedes all other work is inside that budget in the steady state — it costs one source-control query for the repository's shared root plus one small file read. The once-per-repository first read is the outlier: it additionally enumerates every worktree and takes a lock to persist its verdict. Exit status is observed but the hook always exits zero on its own initiative — even on internal failures it logs and returns rather than failing the commit. After the enqueue-and-spawn work, in an interactive context (a real terminal, or an AI-agent session identified by env markers) the hook additionally blocks on a bounded capture-progress watch and prints milestone lines before returning; this detail is owned by the Post-Commit Capture Progress Streaming spec.
- The hook is invoked for amends as well as for ordinary commits. Whether it does any user-visible work depends on the detected kind (see Behavior).
- The hook is invoked once per commit replayed during a rebase; the implementation deliberately does nothing in that case.

### Inputs
- The current working directory (taken to be the project root).
- The output of the operation-type detector (described under **Git Operation Type Detection**).
- The just-created commit's hash, obtained by resolving the symbolic name for the current tip via the VCS.
- The current branch name, obtained by resolving the abbreviated symbolic name of the current tip via the VCS (the literal `HEAD` when the working tree is detached). Read failures are tolerated: the value is treated as empty and the entry's `branch` field is then omitted.
- The previous commit's hash (the parent of the just-created commit), obtained by resolving the relative reference for "tip's first parent" via the VCS.
- The optional pre-staged squash pending-state file at a well-known path under the product-namespace state directory inside the working tree, written before the commit by the prepare-commit-msg path (or by a graphical-client integration). When present its content is a JSON document with at least:
  - a list of source commit hashes that were collapsed into the new commit;
  - an expected-parent-hash field (the tip immediately before the new commit was created); used as a stale-file guard;
  - (additional fields exist but are not consulted here).
- The optional one-shot graphical-client-source marker file at a well-known path inside the same product-namespace state directory; its mere presence flips the recorded source from `cli` to `plugin` for this entry.

### Queue entry
A single JSON document written into the well-known queue subdirectory under the product-namespace state directory, with these fields:
- `type`: one of `commit`, `squash`, `cherry-pick`, `revert` (per the precedence below; `amend` and `rebase-pick`/`rebase-squash` are deliberately never written from this hook).
- `commitHash`: the just-created commit's hash.
- `sourceHashes` (optional): present only when `type === squash`, carrying the list of pre-existing commit hashes that were collapsed.
- `commitSource` (optional): one of `cli` or `plugin`, recording which surface produced the commit.
- `branch` (optional): the name of the branch the commit landed on, read from the VCS at enqueue time (the literal `HEAD` when the working tree is detached). The field is omitted entirely if that read fails. The consumer prefers this captured value over a live branch read when attributing the eventual summary, because by the time the detached worker drains the entry the user may have checked out a different branch.
- `createdAt`: an ISO-8601 timestamp captured at enqueue time.

### Queue entry filename
The entry file's name is `<wall-clock-millis>-<short-hash>.json`, where `<wall-clock-millis>` is the integer number of milliseconds since the epoch at enqueue time and `<short-hash>` is the first eight characters of the just-created commit's hash. The file is written under the well-known queue subdirectory; the subdirectory is created (recursively) if absent. The numeric prefix is what defines processing order; the trailing short hash exists only to prevent collisions when several commits land in the same millisecond.

## Behavior

### Repo-wide manual-disable gate (step zero)
0. Before anything else — before the operation-type detector runs, before any hash is resolved, before any file is read or written, and before the worker is spawned — read the repository's manual-disable flag. If it is set, log that the repository is manually disabled and return. Nothing is detected, nothing is enqueued, no worker is spawned, no marker or pending file is consumed or deleted, and — because the hook returns here rather than falling through to the post-enqueue step — the interactive capture-progress feedback watch is **unreachable**: a disabled repository prints no capture feedback at all, regardless of whether the commit came from a terminal, from an AI-agent session, or with the feedback setting forced on. The flag's storage, priority, and migration are owned by the manual-disable spec.

### Skip-or-handle decision
1. Run the operation-type detector against the current working directory.
2. If the detected kind is `rebase`, log and return without writing anything. This is critical because rebase invokes this hook once per replayed commit; **Post-Rewrite Hook Handling** owns rebase handling using the authoritative old-to-new mapping the VCS supplies on its stdin.
3. If the detected kind is `amend`, log and return without writing anything. Amend is handled by **Post-Rewrite Hook Handling** for the same reason: that hook receives the authoritative single-line old-to-new mapping, whereas at post-commit time we know only that an amend happened, not which prior commit it replaced.
4. Otherwise, proceed to read the just-created commit's hash via the VCS. If reading the hash fails, log the error and return.

### Source-marker resolution
- Test for the existence of the one-shot graphical-client-source marker file inside the project's product-namespace state directory.
- If present, the entry's `commitSource` is set to `plugin`; otherwise it is set to `cli`.
- After the entry is enqueued, the marker file is deleted (best-effort; failures are swallowed).

### Squash-pending consumption (only when detected kind is `squash`)
1. Take the path supplied by the detector.
2. Read and parse the file as JSON. On any parse error, log a debug message, set `type` back to `commit`, and continue (no source-hash list is attached).
3. Resolve the parent of the just-created commit (`HEAD~1`) via the VCS.
4. Compare the resolved parent to the file's expected-parent-hash field:
   - If the field is absent (older file format), accept the file as valid for backward compatibility.
   - If the field is present and equals the resolved parent, accept the file as valid.
   - If the field is present and does not equal the resolved parent, log a warning identifying both hashes by short prefix, treat the file as stale, and demote `type` back to `commit` (no source-hash list is attached).
5. On acceptance, copy the file's source-hash list onto the entry's `sourceHashes` field.
6. Delete the file regardless of whether it was accepted, valid, stale, or unparseable. Failures during deletion are swallowed.

### Enqueue
1. Build the queue entry record per the schema above (`type`, `commitHash`, optional `sourceHashes`, optional `branch` when the branch read succeeded, `commitSource`, `createdAt`).
2. Ensure the well-known queue subdirectory exists (created recursively if needed).
3. Compute the entry filename as `<wall-clock-millis>-<short-hash>.json`.
4. Write the entry as tab-indented JSON in a single synchronous filesystem write.
5. On any write failure, log the error and return (without spawning the worker).

### Worker spawn
- After a successful enqueue, spawn the worker process detached and unawaited. In a non-interactive context the hook returns immediately, while in an interactive context it blocks on the capture-progress feedback watch before returning — the worker is still detached and unawaited either way (the watch only observes the worker's progress file, never awaits the process, propagates its exit code, or inherits its streams). The worker runs independently and is the sole consumer of the queue.
- Neither the spawn nor the feedback watch is reachable when the manual-disable gate returned at step zero.
- The worker's lifecycle, locking, and chain-spawn behavior are owned by the queue-worker spec and are not part of this hook's contract.

### Defer-to-post-rewrite logic (concrete consequences)
- The post-commit hook never writes a queue entry of type `amend`, `rebase-pick`, or `rebase-squash`. Those entries are written exclusively by **Post-Rewrite Hook Handling** using the VCS's authoritative old-to-new mapping piped to that hook on stdin.
- The reason is informational asymmetry: at post-commit time, the VCS has already discarded the old commit hash for amend, and during rebase it has not yet produced a stable mapping. Post-rewrite is invoked exactly once per rewrite operation (rather than once per commit), with full mapping information, making it the right authority.

## State Transitions

Per invocation, observable persistent state changes are confined to:
- **Squash pending-state file** (if it existed): `present → absent` after this hook runs (deleted regardless of acceptance vs. stale outcome).
- **Graphical-client-source marker file** (if it existed): `present → absent` after this hook runs.
- **Queue subdirectory**: gains exactly zero (skip cases) or exactly one (handled cases) new entry file. No existing queue files are read, mutated, or deleted by this hook.

When the manual-disable gate returns at step zero, **none** of the above changes: pending files and markers are left exactly as they were (they are not consumed and not deleted), and the queue is untouched. The one exception is not a state change of this hook's own: the manual-disable read may itself create the repository profile file the very first time it runs in a repository (owned by the manual-disable spec).

## Notable Behavior

- **The manual-disable gate is step zero, and its position is what makes the disabled path silent.** Because the hook returns before the enqueue-and-spawn work, it never reaches the interactive feedback watch either — so a disabled repository produces no queue entry, no worker, *and* no terminal output on commit. Placing the gate after the enqueue instead would leave a visible watch on a repository the user turned off. (Surprising; intentional.)
- **Two-layer hook model.** Post-commit synchronously enqueues and spawns; the worker asynchronously holds a lock and drains. This hook never calls the LLM, never reads the orphan branch, and never holds a long-running lock — those are the worker's job. Returning quickly here is what keeps the user's commit unblocked. (Notable; central design choice.)
- **Amend and rebase always defer.** This hook never enqueues amend or rebase entries even though it can detect them. The reason is that the post-rewrite hook receives the VCS's authoritative old-to-new mapping; reconstructing it after the fact at post-commit time is impossible for amend (the old hash is gone) and unstable for rebase (the mapping is built incrementally). (Surprising; intentional.)
- **Stale squash-pending guard.** Comparing the file's expected-parent-hash to `HEAD~1` catches the case where a previous, abandoned squash attempt left a pending file behind that an unrelated subsequent commit would otherwise consume. On mismatch the file is discarded and the commit is enqueued as a plain `commit`. (Surprising; intentional. The newer per-entry queue design makes this race far less likely; the check survives as a defensive fallback.)
- **Backward compatibility on missing expected-parent-hash.** A pending file that omits the expected-parent-hash field is accepted as valid; this preserves compatibility with files written by older versions of the integration. (Notable; intentional.)
- **Unparseable squash-pending demotes silently.** If the file exists but cannot be parsed as JSON, the operation is recorded as a plain `commit`, the file is still deleted, and the user-visible commit succeeds without surfacing the error. (Notable.)
- **Squash-pending is always deleted, even when stale or invalid.** The deletion is unconditional once the file has been opened, so a permanently-invalid file cannot keep mis-classifying future commits. (Surprising; intentional.)
- **Plugin-source marker is one-shot.** The marker file is deleted by this hook after one consumption, so subsequent commits originating from the command line are correctly recorded as `cli` even right after a graphical-client-driven commit. (Notable; intentional.)
- **Filename uses millisecond timestamp + short hash.** The filename's leading wall-clock-millis component is what defines drain order in the queue; the trailing short hash is anti-collision only. The worker draining the queue must rely on filename ordering, not file-creation-time, because the latter is not portable across filesystems. (Notable.)
- **Single tab-indented JSON file per entry.** Each operation gets its own file (rather than a single shared rolling file) precisely because earlier single-slot designs lost summaries during rapid amend/rebase sequences when one hook overwrote another's pending state. (Notable; documented design rationale.)
- **All failures are non-fatal to the commit.** Hash-resolution errors, write errors, and unparseable inputs are logged and ignored; the hook still exits cleanly so the user's commit completes. The price is that some operations may go un-summarized. (Notable; intentional.)
- **Worker is fully detached.** The hook returns before the worker has done any work; there is no `await`, no exit-code propagation, and no stdout inheritance from the worker. The worker writes its own log file. This is what makes the few-millisecond latency budget achievable. The interactive feedback watch is a separate observer of the worker's per-commit progress file (not the process), bounded by a timeout and a dead-worker probe so it can't hang; a non-interactive context has no watch at all. (Notable.)
- **One implementation.** This hook is the single implementation of the post-commit contract for every surface. The graphical-client integrations do not carry their own port of it — they install and invoke this hook, and their only inbound contribution is writing the source marker and the squash pending-state file this hook then consumes. (Notable; a previous second in-process port no longer exists.)

## Shared Behavior
- The repo-wide manual-disable flag read at step zero — its storage, its repo-wide anchoring, its priority, its migration, and the cost of the read — is owned by the manual-disable spec.
- The operation-type classification is performed by **Git Operation Type Detection**.
- The squash pending-state file consumed here is written by **Prepare-Commit-Msg Squash Detection**.
- Amend and rebase, which this hook deliberately ignores, are handled by **Post-Rewrite Hook Handling**.
- The queue this hook writes into is drained by the queue-worker (referenced from the queue and worker specs); summary storage details belong to the orphan-branch and summary-tree specs.
- The interactive capture-progress feedback watch — its gate, milestone stream, timeouts, and dead-worker probe — is defined by the Post-Commit Capture Progress Streaming spec.
