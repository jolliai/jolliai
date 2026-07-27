# 23. Session Registry Pruning

## Topic Statement
Maintain a persistent registry of recent AI agent sessions that have been observed across all supported sources, automatically pruning entries older than a fixed staleness threshold so the active set stays small and self-cleaning.

## Scope

**In scope:**
- The on-disk shape of the session registry (a single versioned document mapping a session identifier to a metadata record).
- The fields stored per session record.
- The fixed staleness threshold and the unit of time it is measured in.
- When pruning runs (read paths, write paths, and an explicitly-invoked clean operation).
- Atomic file replacement semantics for the registry document.
- The companion advisory lock file used to detect concurrent writers, including its name and stale-detection threshold.
- Upsert semantics for adding or refreshing a session record.
- Behavior when the registry document is absent, empty, or unparseable.
- Cross-process safety properties of the registry (what it does and does not guarantee).
- The implicit pruning of dependent transcript-cursor records when a session is dropped (boundary fact only — the dependent storage is its own topic).

**Out of scope (boundaries):**
- Filtering of the active set by which integrations the user has enabled (read-time filter applied by callers).
- Discovery of brand-new sessions (how transcript files are located on disk for each source).
- The shape and lifecycle of the transcript-cursor records that the registry coordinates with (covered by **Transcript Cursor Resumption**).
- Other state files that share the same parent directory and lock file (configuration, plans registry, queued git operations, squash/amend pending markers, plugin-source marker).
- The per-project "commit exclusion selection" store (the sticky unchecked-row set the queue worker consults at commit time) — that file lives in the same parent directory but is its own document, its own schema, and its own write protocol; sessions are not added to or removed from it as a side-effect of registry pruning. See **Commit Exclusion Selection Store**.
- The per-project "hidden conversations" store (the list-level "remove this row from the active-conversations list" set) — a separate document with its own lock file and snapshot-scoped semantics; pruning a session from the registry does not touch a hide record, and recording a hide does not touch the registry. See **Hidden Conversations Store**.

## Data Contracts

### Session record
A record describing a single observed AI agent session. Its fields are:
- **session identifier**: a string uniquely identifying the session within its source. Used as the registry's lookup key.
- **transcript locator**: a string locating the underlying transcript artifact for the session (typically an absolute filesystem path to the source-specific transcript file). Carried by the record so other stores keyed by the locator can be cleaned up when the session is dropped.
- **recorded-at timestamp**: the ISO 8601 wall-clock time at which the record was last upserted. This is the field compared against the staleness threshold.
- **source tag** (optional): a discriminator naming which AI agent produced the session. The closed enumeration of recognised tags covers twelve transcript sources: the default agent (Claude), Gemini, Codex, OpenCode, Cursor, Cursor CLI, Copilot CLI, Copilot Chat, Cline (VS Code), Cline CLI, Devin, and Antigravity. When absent, callers treat the record as belonging to the historically-default source (Claude) for backward compatibility with records written before the field existed.

The record does NOT include a project-root path, working-directory path, or user-message preview. Only the four fields above are part of the contract; any caller wanting more must look it up at read time from the underlying transcript.

### Registry document
A single document persisted under the project-scoped state directory. Its fields are:
- **schema version**: integer, currently 1.
- **session map**: an object keyed by session identifier whose values are session records.

The document is written as a JSON-encoded text file with tab indentation. The file name within the state directory is fixed.

### Staleness threshold
A single fixed constant: 48 hours, expressed in milliseconds. A record is considered **stale** when the absolute difference between the current wall-clock time and the record's recorded-at timestamp exceeds this constant.

### Lock file (advisory)
A separate sibling file inside the same state directory used to coordinate concurrent operations on the directory as a whole (NOT only the session registry). Its properties:
- Fixed name: a short single-word file name.
- Content: the writing process's PID, written as a decimal string.
- Created with an exclusive-create flag so that two processes attempting to create the lock simultaneously cannot both succeed.
- A separate staleness threshold of **5 minutes** based on the file's modification time. Any lock older than this is treated as abandoned by a crashed process and removed before a fresh acquisition is attempted.

The lock is advisory: callers must invoke acquire/release explicitly. The session-registry write path itself does NOT take this lock.

## Behavior

### Upsert (the "save session" path)
1. Ensure the project-scoped state directory exists.
2. Load the current registry document (see "Load" below).
3. Produce a copy of the session map with the supplied record installed at its session-identifier key. Existing records under the same key are overwritten verbatim.
4. Apply the pruning pass against the copy (see "Pruning"). The pass returns the surviving subset and the list of transcript locators belonging to the pruned records.
5. Wrap the surviving subset in a fresh registry document with schema version 1 and write it atomically (see "Atomic write").
6. If at least one record was pruned, fan out a cursor-cleanup operation against the dependent cursor store, passing the pruned transcript locators (boundary call into the cursor topic).

### Load (any read path)
1. Compute the absolute path to the registry document under the project-scoped state directory.
2. Attempt to read the file as UTF-8 text and parse it as JSON.
3. On any error during read or parse (file does not exist, permission denied, malformed JSON), return an empty registry document `{ schemaVersion: 1, sessions: {} }`. The caller cannot distinguish these cases from a genuinely empty registry.

### Pruning pass
A pure function over a session map that walks every entry and partitions it:
- For each entry, compute `now - recordedAt` in milliseconds. If the difference is greater than the staleness threshold, classify the entry as stale and append its transcript locator to the staleness-output list.
- Otherwise, copy the entry into the active-output map.
- Return the active-output map and the list of stale transcript locators.

The pass does NOT itself perform writes; it only computes the partition.

### Read paths that apply pruning
Three explicit read entry points apply the pruning pass to the loaded registry **without writing**:
- "Load all active sessions" — returns the active-output map's values.
- "Load most recent active session" — returns the entry from the active-output map with the largest recorded-at timestamp, or null if empty.
- "Count stale sessions" — returns the number of entries that would be removed (used for dry-run reporting).

These read paths do NOT persist the pruning result. A purely-reading caller never modifies the file.

### Explicit prune operation
A separate "prune now" entry point loads, runs the pruning pass, and persists the active-output map, returning the count of records dropped. When at least one record is dropped, it also invokes the cursor-cleanup fanout described in step 6 of upsert.

### Atomic write
1. Write the new content to a sibling temporary file whose name is the target name with a `.tmp` suffix.
2. Rename the temporary file over the target. The rename is the commit point.
3. On Windows-class platforms where the rename can fail with permission-denied errors (a process holding the target open — antivirus, file watchers), fall back to a direct overwrite of the target plus best-effort deletion of the temporary file.

### Lock acquisition
1. Stat the lock file. If it exists and its age (now minus mtime) is below the lock-staleness threshold of 5 minutes, return failure (another process holds the lock).
2. If it exists and its age is at or above the threshold, remove it (treating it as crashed-process residue) and proceed.
3. Create the lock file with an exclusive-create flag and write the current process's PID as its content. If creation fails because a peer raced past step 1 and created the file first, return failure without retrying.
4. On success, return success.

### Lock release
Best-effort removal of the lock file. Errors are logged but do not propagate.

### Lock-held probe (for hooks deciding whether to spawn a new worker)
Stat the lock file; report it as "held" iff it exists AND is younger than the lock-staleness threshold. Absence of the file or a stale file both report as "not held".

### Lock-stale probe (for diagnostics)
Stat the lock file; report it as "stale" iff it exists AND is at or older than the lock-staleness threshold. Used by health-check tooling to detect crashed workers.

## State Transitions

The registry document has two abstract states:
- **Absent / empty** — file does not exist, is unreadable, or is malformed. All read paths treat these identically and return an empty registry. No transition is recorded by reads alone.
- **Populated** — file contains a valid registry document with zero or more session records.

Allowed transitions:
- Absent → Populated: a successful upsert or explicit prune produces the file.
- Populated → Populated: every successful upsert and explicit prune replaces the document atomically with a new version that may contain more, fewer, or the same number of records.
- There is no Populated → Absent transition. Even an empty active set after pruning is persisted as a populated document with an empty session map.

Per-record transitions:
- **New** → installed by upsert under a previously unseen session identifier.
- **Refreshed** → installed by upsert under an existing identifier with a newer recorded-at timestamp.
- **Pruned** → removed when its age exceeds the staleness threshold during any subsequent upsert or explicit prune. Its transcript locator is fanned out to the cursor cleanup.

## Notable Behavior

- **Pruning runs on writes, not on plain reads.** Read paths apply the pruning pass in-memory so callers see only fresh records, but the pass's result is only persisted by the upsert path and the explicit prune operation. A registry read by a tool that only inspects state never modifies the file. (Surprising: counting stale sessions does NOT delete them.)
- **Upsert always runs the prune pass.** Every "save session" call is also a prune call. There is no "save without pruning" entry point. This means a long-running interactive AI session that keeps refreshing its own record will incidentally clean up other sources' stale records as a side-effect.
- **Read errors are silently flattened to empty.** A missing file, a corrupt-JSON file, and a permission-denied error all produce the same empty-registry result on read. Callers cannot distinguish these conditions from a genuinely empty registry. (Surprising; intentional simplicity.)
- **The lock file is sibling, not part of the registry.** Writes to the registry document do NOT acquire the lock file. The lock guards higher-level multi-step operations (the queued git-operation worker, in particular) that touch many files in the directory; concurrent registry writes rely on the atomic-rename of the document for last-writer-wins semantics, not on the lock.
- **Last-writer-wins on concurrent upserts.** Two processes simultaneously calling upsert with different session records will both load the registry, both add their record, and both write atomically. Whichever rename lands second silently overwrites the other process's contribution under any session identifier the loser added that the winner did not. The risk window is small (milliseconds) but real. The lock file does NOT mitigate this for the registry's write path.
- **Lock-staleness is mtime-based, not heartbeat-based.** A long-running operation that holds the lock for more than 5 minutes without touching the file will be considered crashed by the next would-be acquirer, which will then remove the lock and proceed. There is no heartbeat / refresh mechanism. In practice the operation that acquires the lock either completes quickly or churns the file naturally, but a quiescent holder that just happens to be slow can be torn down. (Surprising; deliberate trade-off for crash recovery.)
- **Staleness threshold is in milliseconds and explicit.** 48 hours converted as `48 * 60 * 60 * 1000`. The same constant is duplicated for the squash/amend pending state files and the lock-staleness has its own constant of `5 * 60 * 1000`. Callers cannot tune any of these at runtime.
- **The transcript locator is the join key for cleanup, not the session identifier.** Pruning emits transcript locators (not session identifiers) into its stale-output list, because the dependent cursor store is keyed by transcript locator (with a "plan:" prefix variant for plan-discovery cursors). The session-identifier-to-locator mapping is therefore baked into the registry record. (Notable cross-store invariant.)
- **Atomic-write degrades on Windows.** The rename-over-target step can fail with permission errors when the target is held open by an external process. The fallback is a direct overwrite plus a best-effort temporary-file delete, which is no longer atomic but is the only thing that completes successfully on those platforms. (Surprising; pragmatic.)
- **Schema version is encoded in every write but not enforced on read.** The document contains `version: 1` but the loader does not check it; corrupt or future-schema files fall through to the empty-registry case via a generic catch.
- **There is one implementation of this registry.** The former JVM-based port is gone, and with it the `amend-pending` companion file it maintained — no such file is written or read anywhere. The JVM-hosted surface neither loads nor prunes the registry; where it needs registry-adjacent state it goes through a bridge action. (Notable.)

## Shared Behavior
- The shape, lifecycle, and pruning of dependent transcript-cursor records keyed by transcript locator (including the plan-scan-cursor variant) are defined by **Transcript Cursor Resumption**.
- The atomic-write primitive (temp-file + rename, with Windows fallback) is shared with several other small state files in the same directory (configuration, plans registry, squash-pending). Each of those is its own topic; the primitive itself is described here because the session registry is its primary user.
- The advisory lock file is described here in full because the session registry shares its parent directory with the lock; however, the lock is consumed primarily by the queued git-operation worker, whose locking discipline is its own topic.
- Read-time filtering of the active set by which integrations the user has enabled is performed by the caller against the loaded set; it is not part of this registry's contract.
- The per-conversation skip set the queue worker consults at commit time to discard unchecked conversations — which are still read so their cursor advances, with only their entries dropped from the summary — is its own document; see **Commit Exclusion Selection Store**. The list-level "row vanishes from the active-conversations list" set is also its own document; see **Hidden Conversations Store**. Neither store shares state with this registry.
