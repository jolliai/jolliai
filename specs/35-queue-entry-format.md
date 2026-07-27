# Queue Entry Format

## Topic Statement

The on-disk shape and lifecycle of a single record that pairs one git operation with the metadata its later processor will need, written to a per-operation file under a fixed queue directory and removed only after a processing attempt has been made.

## Scope

**In scope:**
- Where a queue entry lives on disk (directory and naming convention).
- The fields a queue entry carries and what each field represents.
- Which producer writes each kind of entry, and what the producer derives the fields from.
- The decision rule that lets one producer defer to another for some operation kinds.
- When an entry's file is removed.
- The single-file-per-operation rule and the historical reason for it.

**Out of scope:**
- The drain loop and dispatch table of the consumer (covered by the queue-worker topic).
- Lock acquisition, the staleness threshold for the worker lock, and the successor-spawn protocol (covered by the queue-worker and chain-spawn topics).
- The cutoff use of an entry's creation timestamp by transcript readers (covered by the transcript-cutoff topic).
- The shape of the summary or transcript artifacts the consumer writes after processing (covered by the summary-tree and transcript-persistence topics).

## Data Contracts

### Queue directory

A single directory at a fixed path inside the per-repository state directory, named for the queue's purpose ("queue of git operations"). It is created on demand by any producer that needs to write to it. Its absence is treated as an empty queue by the consumer.

### Entry file name

A single regular file with the structure:

```
<creation-epoch-millis>-<short-hash>.json
```

where:

- `<creation-epoch-millis>` is the producer's wall-clock time at write, expressed as an integer count of milliseconds since the unix epoch. This is the value used to establish drain order across all entries in the directory. It is captured at the same instant the producer constructs the in-memory entry, so the file name's prefix and the entry body's creation timestamp originate from the same moment but are recorded in different units (milliseconds vs ISO 8601).
- `<short-hash>` is the first eight characters of the operation's target commit hash. This serves as a uniqueness component when two entries are produced inside the same millisecond, and as a debugging aid when reading directory listings.
- The `.json` extension is fixed; the consumer ignores any other extension.

### Entry body

Each file holds a single JSON document with tab-indented serialization. The fields are:

- **operation kind** (required, enumerated string): one of `commit`, `cherry-pick`, `revert`, `amend`, `squash`, `rebase-pick`, `rebase-squash`. The consumer's dispatch table is keyed off this value.
- **target commit hash** (required, full-length string): for plain operations the just-created commit; for amend the new (rewritten) hash; for squash the consolidated commit; for the rebase kinds the new hash on the rewritten history.
- **source hashes** (optional, list of full-length strings; semantics by kind):
  - For `amend`: a single-element list containing the original (pre-amend) hash.
  - For `squash` and `rebase-squash`: every contributing source commit, in declaration order, that was collapsed into the target.
  - For `rebase-pick`: a single-element list with the pre-rewrite hash for the migrated commit.
  - For plain `commit`, `cherry-pick`, `revert`: absent. The consumer never reads it for these kinds.
- **commit source** (optional, enumerated string): which surface produced the operation, with values `cli` (the standalone command-line tool) or `plugin` (the editor extension's bridge). Carried verbatim onto the eventual summary record so list views can render the origin.
- **branch** (optional, string): the name of the branch checked out at the moment the producer wrote the entry (the literal `HEAD` when the working tree is in a detached state). The producer omits the field entirely when it cannot read the current branch. Because the consumer drains asynchronously — often seconds to minutes after the commit, by which point the user may have checked out a different branch or a sibling worktree may be on another branch — the consumer prefers this captured value over a live read when deciding which branch to attribute the resulting summary (and its plan/note/reference associations) to, and when scoping stale-child cleanup. A live read of the current branch is used only as a fallback, and only for legacy entries that predate this field (see Shared Behavior).
- **created-at** (required, ISO 8601 string): the producer's wall-clock time at write. Same instant as the file-name prefix; the two fields are not compared for equality but are produced together. The consumer additionally uses this value as a transcript-attribution cutoff (see Shared Behavior).

The body has no version field; readers and writers are coupled to the exact field set above.

### Producers

Two distinct producers write entries:

- **The post-commit hook** writes one entry whenever a non-rewriting commit lands. It is the sole producer of `commit`, `cherry-pick`, `revert`, and `squash` entries (the `cherry-pick`/`revert` kinds are detected by an upstream operation detector, and `squash` is mediated through a pending-marker file written by an earlier hook in the chain — see below). It explicitly does not write `amend` or any rebase entry: when the upstream detector reports either of those, the hook returns without enqueueing, leaving the post-rewrite hook as the sole authority.
- **The post-rewrite hook** writes the entries for git's two rewrite events. For the `amend` event it writes one entry with the new hash as target and the old hash in the single-element source list. For the `rebase` event it groups stdin's `<old> <new>` mapping pairs by their new hash; each group of size one becomes a `rebase-pick` entry, each group of size greater than one becomes a `rebase-squash` entry whose source list is the contributing old hashes in input order.

### The squash-pending bridge file

A separate single-slot file (under the same per-repository state directory, with a fixed name) is written by an earlier-stage hook when it detects that the impending commit will collapse multiple commits into one. The post-commit hook reads it, copies its source-hash list and any present parent-hash guard onto the `squash` entry it is about to write, validates that the guard matches the current parent, and unconditionally deletes the file afterwards. If the guard does not match (the squash-pending file is stale), the hook discards the file and falls back to writing a plain `commit` entry instead.

### Plugin-source bridge file

A separate empty marker file at a fixed name in the same state directory, written by the editor-extension bridge before it invokes git. Both producers consult its presence to decide whether to set the entry's commit-source field to `plugin` (when present) or `cli` (when absent). After consulting, the producer deletes the marker.

### Stale-entry threshold

Seven days. An entry whose creation timestamp is older than this is pruned by the consumer or by a manual cleanup command without ever being processed.

## Behavior

### Writing a plain-commit entry

1. The post-commit hook resolves the just-created commit's hash via the version-control system.
2. It detects the operation kind via an operation detector that inspects working-tree state and history; if the result is `amend` or `rebase`, the hook returns without enqueueing.
3. It checks for the squash-pending bridge file. If present and its parent guard matches the current parent, the kind is upgraded to `squash` and its source-hash list is adopted; if its parent guard does not match, the file is discarded and the kind stays `commit`. The bridge file is deleted in either branch.
4. It checks for the plugin-source marker; if present, the entry's commit-source field is `plugin`, otherwise `cli`. The marker is deleted afterwards.
5. The hook ensures the queue directory exists, computes the epoch-millis prefix, and writes the JSON body to the appropriately named file synchronously. The synchronous write is required because the post-commit hook must return quickly.
6. It then spawns the consumer worker and returns immediately.

### Writing rewrite entries

1. The post-rewrite hook reads the rewrite-event command (one of `amend` or `rebase`) and the old→new mapping pairs from standard input.
2. If no mappings were provided, the hook returns without enqueueing.
3. It checks for the plugin-source marker once; the same value is used for every entry it writes in this invocation.
4. For an `amend` event: a single entry is written with the kind `amend`, the new hash as target, and the old hash in the source list.
5. For a `rebase` event: mappings are grouped by their new hash. Each one-mapping group writes a `rebase-pick` entry; each multi-mapping group writes a `rebase-squash` entry whose source list is the contributing old hashes. Failures to enqueue any single group are counted and logged but do not stop the loop.
6. After writing, the hook consults the worker lock; if the lock is not held it spawns a consumer worker, otherwise it logs that the running worker will absorb its entries.

### File-name construction

1. The producer captures `Date.now()` once.
2. It builds the file name by concatenating the integer rendering of that value, a hyphen, the first eight characters of the entry's target commit hash, and `.json`.
3. The producer does not check for collisions before writing; collisions are vanishingly rare because the suffix differs whenever the target hashes differ within the same millisecond.

### Body construction

The producer constructs the in-memory record with the canonical field set, in the canonical order, and serializes it with two-space-equivalent tab indentation. Optional fields (`source hashes`, `commit source`, `branch`) are present only when applicable — `source hashes` and `commit source` when the kind requires them, `branch` whenever the producer could read the current branch — and are never emitted as `null` placeholders. Both producers capture the branch the same way: they read the working tree's current branch at the instant the entry is built, and drop the field if that read yields nothing.

### File deletion

A queue entry's file is deleted exactly once and only by the consumer:

- After the consumer's handler returns successfully.
- After the consumer's handler throws (failures and successes are deleted identically).
- During the consumer's parse pass when the entry's `created-at` is older than the seven-day stale threshold; in this case no handler is invoked.

The producers never delete entries.

## State Transitions

### One queue entry's lifecycle

- **Not yet enqueued** → **File present in queue directory, processable** when the producing hook completes its synchronous write.
- **File present, processable** → **Parsed in a drain batch** when the consumer lists the directory.
- **Parsed in a drain batch** → **Dispatched to handler** → **File deleted** regardless of handler outcome.
- **File present, processable** → **File deleted, never dispatched** when the entry is older than seven days at parse time.
- **File present, processable** → **Parse error logged, file skipped** if the body fails JSON parse; the file is left in place and is eligible for deletion only by the seven-day prune.

### The squash-pending bridge file

- **Absent** → **Written by an earlier-stage hook** when an impending squash is detected.
- **Present** → **Consumed and deleted by the post-commit hook** during enqueue, regardless of whether its guard matched.
- **Present, age beyond a separate staleness threshold** → **Deleted by a separate cleanup path** without affecting any queue entry.

### The plugin-source marker

- **Absent** → **Written by the editor extension's bridge** before invoking git.
- **Present** → **Read and deleted by whichever producer enqueues first** (post-commit or post-rewrite); the field it set is then carried on the queue entry.

## Notable Behavior

- **One file per operation, never one slot.** The historical predecessors of this queue used per-kind single-slot files (one for amend, one for squash, etc.). A second amend or rebase that arrived while the consumer was still running its language-model call overwrote the first, and the first commit's summary was silently lost. The current design writes one file per operation precisely because rapid amend and rebase sequences produce overlapping in-flight operations and there is no other safe place for the second one to wait. (Surprising; intentional. The historical context is captured verbatim in the project's own development notes.)

- **Filename prefix is the canonical drain order.** The body's ISO timestamp is for transcript attribution; the file name's epoch-millis is for ordering. They are produced from the same `Date.now()` call but neither is derived from the other. (Notable.)

- **The eight-character hash suffix is for tie-breaking, not lookup.** The consumer never opens entries by hash; it only sorts by file name and parses the body. Two operations targeting the same commit within the same millisecond is an edge case that would otherwise produce a name collision; the suffix removes it. (Notable.)

- **Producer responsibilities are partitioned, not shared.** Plain commits, cherry-picks, reverts, and squashes are produced by the post-commit hook only; amends and the rebase pair are produced by the post-rewrite hook only. The two hooks coordinate by the post-commit hook explicitly returning early when its detector reports `amend` or `rebase`. (Surprising; this is the only reason the hook chain doesn't double-enqueue rewrite events.)

- **Squash detection is mediated by a pending file, not by a single hook.** The post-commit hook cannot tell from the version-control state alone that a commit is a squash; an earlier-stage hook (the prepare-commit-message hook) writes a small bridge file when it sees `git merge --squash` or the editor extension's squash button. The post-commit hook reads that file to upgrade `commit` to `squash`. The bridge file's parent-hash guard exists to detect a stale file from a previous, abandoned squash attempt. (Notable.)

- **No version field on the entry body.** Readers and writers are tightly coupled at compile time. A field rename or addition is a coordinated change across both producer surfaces and the consumer. (Surprising; intentional given the producers and consumer ship in the same artifact.)

- **The body is written with non-atomic semantics in the post-commit producer, but with atomic-rename semantics in the post-rewrite producer.** The post-commit hook prioritizes synchronous speed (under five milliseconds is the design target); the post-rewrite hook routes through the shared enqueue helper which writes via tempfile-and-rename. The consumer parses both shapes identically. (Notable.)

- **Optional fields are omitted, never `null`.** A plain-commit entry has no `sourceHashes` key at all rather than `"sourceHashes": null`. Consumers that want to detect "amend with no recorded prior commit" must check the array length, not the key's presence alone, on amend entries; for non-amend entries the absence-vs-empty distinction does not arise. (Notable.)

- **The branch is captured at enqueue time precisely so it survives an asynchronous drain.** The entry records the branch the commit was made on, not the branch read live when the consumer later processes it. The two can differ — the user may commit and immediately check out another branch, or a long queue backlog may delay the drain by minutes, or a sibling worktree may sit on a different branch — and a live read at drain time would file the summary's markdown, the sidebar branch view, and branch-scoped recall under the wrong branch. An entry missing the field (only legacy entries produced before the field existed) forces the consumer to fall back to the live read for summary attribution, and to skip stale-child cleanup entirely rather than guess. (Surprising; intentional.)

- **A failed enqueue in the post-rewrite hook's rebase loop drops only one mapping group.** Each group is enqueued through a try-style helper that reports success or failure; failed groups are counted and logged but do not cause the remaining groups to be skipped. The corresponding old-to-new migration for that group is then permanently lost (no retry). (Surprising; intentional.)

- **Stale-entry pruning happens at the consumer's parse step, not at write time.** Producers never check for old files. The consumer's seven-day threshold is the only mechanism that ever removes an unprocessed entry. (Notable.)

- **A corrupt entry body skips processing but does not auto-delete.** When the consumer's parse pass cannot read or JSON-parse a file, it logs and continues. The file remains until the seven-day prune or a manual cleanup. (Surprising.)

## Shared Behavior

- The drain order, dispatch table, lock acquisition, and successor-spawn step that consume these entries are defined by the **Git Operation Queue Worker** topic.
- The successor-spawn race window between producers and an in-flight consumer is defined by the **Worker Chain Spawn** topic.
- The use of an entry's creation timestamp as a transcript-attribution cutoff is defined by the **Summary Attribution by Transcript Cutoff** topic.
- The consumer's preference for the entry's captured branch over a live read (for summary attribution and stale-child cleanup, with a live-read fallback only for legacy entries) is defined by the **Git Operation Queue Worker** topic; the amend-specific use of the captured branch for the prompt-context gathering and the fresh-leaf branch label is defined by the **Amend Summary Migration** topic.
- The squash-pending bridge file's own creation, parent-hash guard, and staleness rule are defined by the prepare-commit-message hook topic.
- The plugin-source marker is also written and consulted by the editor-extension bridge topic.
- The detection logic that distinguishes plain commits, cherry-picks, reverts, amends, rebases, and squashes is defined by the operation-detector topic.
