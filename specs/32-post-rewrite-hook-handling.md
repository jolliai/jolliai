# 32. Post-Rewrite Hook Handling

## Topic Statement
Process amend and rebase operations using the VCS's authoritative old-to-new commit-hash mapping piped on standard input, group rebase mappings by destination commit to distinguish 1:1 (pick) from N:1 (squash/fixup) cases, write one queue entry per group, and spawn a background worker only if no worker is already running.

## Scope
**In scope:**
- The hook's contract with the VCS (when invoked, what command-name argument it receives, what stdin payload it consumes).
- The repo-wide manual-disable gate read before the standard-input mapping is consumed, and the consequence that the mapping is therefore not drained on the disabled path.
- Parsing of the stdin mapping stream into structured `(oldHash, newHash)` pairs.
- The amend code path: enqueue exactly one entry.
- The rebase code path: group by `newHash`, enqueue one entry per group, classify each group as `rebase-pick` (one source) or `rebase-squash` (multiple sources).
- Source-marker resolution (graphical-client vs. command-line origin) and one-shot consumption of that marker.
- The "spawn worker only if no lock is held" coordination.
- Behavior on unrecognized command-name argument.

**Out of scope (boundaries):**
- Operation-type classification at post-commit time (covered by **Git Operation Type Detection**).
- The post-commit hook itself, which deliberately defers to this hook for amend and rebase (covered by **Post-Commit Hook Enqueue**).
- The squash pending-state file used at post-commit time (covered by **Prepare-Commit-Msg Squash Detection** and **Post-Commit Hook Enqueue**).
- The queue, the lock, and the worker pipeline (covered by the queue-worker spec).
- Per-summary migration semantics (one-to-one vs. many-to-one merge) — this hook only enqueues; the worker (or in the alternate port, a direct in-process call) performs the migration. The migration semantics belong to the summary-store spec.

## Data Contracts

### Hook contract
- The VCS invokes this hook after rewriting one or more commits. The first positional argument identifies the rewrite kind: the literal value `amend` for an amend, the literal value `rebase` for a rebase. Other values are possible in principle but are treated as "unknown" by this hook.
- The hook reads its mapping payload from standard input. Each line is `<old-hash> <new-hash>`, separated by one or more whitespace characters; the lines are terminated by line feed (CR/LF tolerated). Blank lines are ignored. The set of lines is the complete mapping for the rewrite operation.
- The hook is invoked exactly once per rewrite operation (not once per rewritten commit).
- The hook's exit status is observed but failures are logged and not propagated; a fatal error logs and exits non-zero only in the script-entry wrapper.

### Inputs
- The first positional argument: the rewrite kind (`amend`, `rebase`, or unknown).
- The standard-input mapping payload: zero or more `<oldHash> <newHash>` lines.
- The current working directory (taken to be the project root).
- The current branch name, resolved from the VCS at hook-execution time. Read failures are tolerated: the value is treated as empty and the `branch` field is then omitted from every entry written in this invocation.
- An optional one-shot graphical-client-source marker file at the well-known path inside the product-namespace state directory; its presence sets the recorded source on enqueued entries from `cli` to `plugin`, and the file is deleted once consumed.
- The state of the worker's advisory lock under the product-namespace state directory; whether or not it is currently held determines whether this hook spawns a new worker.

### Hash-mapping pair
A normalized record `{ oldHash, newHash }` produced by parsing one well-formed input line. Lines that do not contain at least two whitespace-separated non-empty tokens are silently dropped.

### Queue entries written
For every queue entry written by this hook, the schema matches the queue-entry schema used by the post-commit hook with the following kind-specific shapes. In addition to the kind-specific fields below, every entry this hook writes carries the optional `branch` field — the name of the branch checked out when the rewrite ran, resolved once for the whole invocation and omitted from the entry when the branch cannot be read. The consumer prefers this captured branch over a live read when attributing the migrated summary, because the rewrite worker drains asynchronously and the live branch may have moved by then.

- **Amend entry** (written when the command argument is `amend`):
  - `type` = `amend`.
  - `commitHash` = `newHash` from the (single) mapping pair.
  - `sourceHashes` = `[oldHash]` (a one-element list).
  - `commitSource` per source-marker resolution.
  - `createdAt` = ISO-8601 timestamp at enqueue time.
- **Rebase-pick entry** (written when the command argument is `rebase` and a group has exactly one source):
  - `type` = `rebase-pick`.
  - `commitHash` = the group's shared `newHash`.
  - `sourceHashes` = `[oldHash]` (one-element list).
  - `commitSource`, `createdAt` as above.
- **Rebase-squash entry** (written when the command argument is `rebase` and a group has more than one source):
  - `type` = `rebase-squash`.
  - `commitHash` = the group's shared `newHash`.
  - `sourceHashes` = the full list of source `oldHash` values for that group, preserving the order in which they were observed in the input.
  - `commitSource`, `createdAt` as above.

There is exactly one entry per amend operation; there is exactly one entry per rebase destination group (i.e. per distinct `newHash`).

## Behavior

### Top-level dispatch
1. Configure the logger to write inside the project's product-namespace log directory (so concurrent invocations from different repos write to their own files).
2. **Repo-wide manual-disable gate.** Read the repository's manual-disable flag. If it is set, log that the repository is manually disabled and return. Because this gate sits **before** the standard-input read in step 3, the mapping payload the VCS piped to this hook is **never consumed** on the disabled path — the hook exits without draining it. No entries are enqueued, the source marker is neither read nor deleted, the worker lock is not probed, and no worker is spawned. (Contrast the pre-push hook, which reads its standard input at its own entry point *before* the gated body runs, and therefore always drains its pipe even on a disabled repository. The two hooks differ on purpose; only this one leaves its input unread.) The flag's storage, priority, and migration are owned by the manual-disable spec.
3. Read every line from standard input, parse each line, and accumulate a list of `(oldHash, newHash)` mapping pairs (per the parsing rule below). If the resulting list is empty, log "nothing to do" and return.
4. Resolve `commitSource` once for the whole invocation: if the one-shot graphical-client-source marker file is present in the project's product-namespace state directory, set `commitSource = plugin` and delete the marker (best-effort; deletion failures are swallowed); otherwise `commitSource = cli`. Resolve the current branch name once as well, from the VCS; a read failure leaves it empty so the `branch` field is omitted from every entry. The same branch value is stamped on every entry written in this invocation.
5. Dispatch on the first positional argument:
   - `amend` → run the amend handler.
   - `rebase` → run the rebase handler.
   - anything else → log "unknown command, skipping" and proceed to the worker-spawn step (no entries enqueued).

### Stdin parsing
- For each newline-separated input line, trim leading and trailing whitespace, split on runs of any whitespace.
- If at least two non-empty tokens result, take the first as `oldHash` and the second as `newHash`, ignoring any extra trailing tokens. (No hex-validation is performed; the contract is "the VCS gave us hashes.")
- Otherwise the line is dropped silently.

### Amend handler
1. Take the first (and, in normal operation, only) parsed mapping pair.
2. Build the amend entry exactly as specified under Data Contracts.
3. Enqueue the entry to the queue (writing one file under the product-namespace queue subdirectory; ordering and naming follow the same rules used by **Post-Commit Hook Enqueue**, namely a millisecond-prefixed filename).
4. Log a message identifying the old and new hashes by short prefix.

### Rebase handler
1. Build a map keyed by `newHash`. For each parsed mapping pair, append its `oldHash` to the list at `map[newHash]`.
2. For each `(newHash, [oldHash, ...])` group, in iteration order:
   - If the list has exactly one entry, the group's `type` is `rebase-pick`; if it has more than one entry, the group's `type` is `rebase-squash`.
   - Build the entry per Data Contracts (preserving the input-observed order of source hashes within the group's `sourceHashes`).
   - Enqueue the entry; record success or failure for that group.
   - Log a message identifying the source hashes by short prefix and the destination by short prefix.
3. After processing all groups, if any groups failed to enqueue, log a warning naming the failure count over the total group count and noting that those mappings will be lost.
4. Log a final summary identifying total groups enqueued and total mappings observed.

### Worker spawn (post-handler)
- After the amend or rebase handler has written its entries, query the worker's advisory lock state.
- If the lock is **not held**, spawn a detached background worker (the same launching primitive used by **Post-Commit Hook Enqueue**). The hook returns immediately.
- If the lock **is held**, do not spawn a worker. The currently-running worker, when it finishes its current entry, is responsible for re-checking the queue and processing newly-arrived entries before terminating (see the queue-worker spec). Log a message indicating that the running worker will pick up the new entries.

### Logging boundaries
- Internal failures (stdin read errors, unknown command, failed enqueue of one group) are logged and swallowed; the hook continues processing remaining inputs and still spawns the worker if the lock is free.
- The script-entry wrapper around the handler catches any otherwise-uncaught exception, prints a fatal-error message, and exits non-zero. This is the only path that produces a non-zero exit; ordinary input-validation failures do not.

## State Transitions

Per invocation, persistent state changes are:
- **Graphical-client-source marker file** (if present): `present → absent`.
- **Queue subdirectory**: gains zero entries (unknown command, empty stdin, total enqueue failure) or one entry (amend) or one entry per rebase destination group (rebase).
- **Worker process**: zero or one new detached worker process is spawned, conditional on the lock not being held when the post-handler check runs.
- **Repository manually disabled**: none of the above. The marker file is left in place, the queue is untouched, no worker is spawned, and the standard-input mapping is left unread.

No existing queue files are read, mutated, or deleted by this hook; coordination with the running worker is performed exclusively via the lock-state check, never by direct manipulation of the queue.

## Notable Behavior

- **Group-by-destination distinguishes pick from squash.** During rebase, the same `newHash` may appear on multiple input lines when several source commits collapsed into one (squash, fixup). Grouping by `newHash` and counting the group size is what distinguishes pick (1) from squash (≥2). Processing each line independently would either overwrite earlier entries or produce nonsense `1:1` migrations for what is really a many-to-one merge. (Surprising; intentional.)
- **Sole authority for amend.** The post-commit hook deliberately does nothing for amend; this hook is the only place an `amend` queue entry is ever written. The reason is that this hook receives the authoritative `(oldHash, newHash)` mapping from the VCS, while at post-commit time the old hash has already been discarded. (Notable; central design choice.)
- **Sole authority for rebase migration.** During rebase, post-commit fires once per replayed commit and is told to skip; this hook fires once per rebase operation with the full mapping. Without this division of labor a long rebase would either spawn N workers (each racing for the lock) or migrate summaries one-by-one without enough information to detect squash collapses. (Notable; central design choice.)
- **Worker spawn is gated on the lock, not on whether the queue was non-empty.** If a worker is already running and we just added new entries, we explicitly do not spawn another. The running worker's drain loop checks for new entries at the end of its work; this is what avoids redundant workers stomping on each other under the same lock. (Surprising; intentional.)
- **Empty stdin is a no-op.** The hook still ran, but no entries are enqueued and no worker is spawned. (Notable.)
- **Unknown command argument is a no-op.** The hook does not raise; it logs and falls through to the worker-spawn step (which is itself a no-op when nothing was enqueued and a useful safety net when a stale lock has cleared but entries from a previous invocation remain). (Notable.)
- **Per-line resilience to malformed input.** Lines that do not parse into at least two non-empty tokens are silently dropped, not logged at warn level; the hook does not fail the rewrite over a malformed line. (Notable.)
- **Plugin-source marker is one-shot.** Same contract as in **Post-Commit Hook Enqueue**: present → absent on first read, regardless of whether any entries were ultimately written. (Notable.)
- **Source-hash order within a squash group preserves stdin order.** The list ordering inside a `rebase-squash` entry's `sourceHashes` is the order the VCS sent the lines on stdin. (Notable; relied on by downstream merge code that uses earliest-stdin-line as the canonical "primary source" of a squash.)
- **A disabled repository leaves the rewrite mapping undrained.** The manual-disable gate precedes the standard-input read, so on the disabled path the payload the VCS piped in is never consumed. This is the deliberate opposite of the pre-push hook, which reads its input at its entry point before its gated body and therefore always drains. The rewrite mapping is a one-shot input with no later consumer, so leaving it unread costs nothing — but it does mean "the hook ran" cannot be inferred from the pipe having been emptied. (Surprising; intentional.)
- **One implementation.** This hook is the single implementation of the post-rewrite contract for every surface. The alternate in-process port that performed the summary migration directly in the handler no longer exists; the enqueue-and-conditionally-spawn model described above is the only one. (Notable.)
- **Failures during enqueue are counted but do not abort.** A rebase with ten destination groups in which two enqueues fail still spawns the worker and lets it process the eight that succeeded; a warning records that two were lost. (Notable.)

## Shared Behavior
- The repo-wide manual-disable flag read at step 2 — its storage, repo-wide anchoring, priority, migration, and the per-invocation cost of the read — is owned by the manual-disable spec, which also records the deliberate asymmetry between this hook's undrained input and the pre-push hook's always-drained input.
- This hook produces queue entries with the same schema and filename convention as **Post-Commit Hook Enqueue**.
- The lock-state check and worker-spawn primitive are part of the queue-worker contract (referenced from the queue and worker specs).
- The graphical-client-source marker file is written by the graphical-client integration (not in the scope of these hook specs) and consumed identically here and in **Post-Commit Hook Enqueue**.
- The amend / rebase-pick / rebase-squash queue-entry kinds are interpreted by the worker per the summary-store migration rules (one-to-one for amend and rebase-pick; many-to-one merge for rebase-squash).
