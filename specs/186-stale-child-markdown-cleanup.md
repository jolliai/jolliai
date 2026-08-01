# Stale Child Markdown Cleanup

## Topic Statement

After every recorded version-control operation, delete visible-layer markdown files for summary-index entries whose parent-pointer is non-null, restoring the invariant that the visible folder holds one file per live head entry.

## Scope

**In scope:**
- The criterion that selects which entries get their visible markdown removed.
- The two invocation modes: single-branch scoped and all-branches whole-index.
- The two trigger sites: the tail step of every recorded version-control operation, and the recurring reconcile step of the local-mirror activate path.
- Per-entry idempotency (already-absent file is not counted as a removal).
- Per-entry error tolerance (one failure does not abort the sweep).
- The interaction with the branch-folder-mapping registry on the visible layer ("ghost-branch" pruning).
- The guard that prevents demoting the originating operation when this cleanup step fails.
- Backend-applicability: cleanup is gated on the storage backend exposing a "delete visible markdown" capability, and ghost-branch pruning is gated on it exposing a "prune branch mappings" capability.
- Reporting (deleted count, failed count).

**Out of scope (boundaries):**
- The structure of the summary tree, the tri-state parent-pointer convention, and how the unified-hoist regime reassigns the prior head's parent-pointer on every new commit, amend, squash, or rebase. Covered by the summary-tree-structure topic.
- The on-disk layout of the visible folder layer (per-branch directories, branch-name → folder-name transcoding, `branches.json` registry). Covered by the memory-bank-folder-layout topic.
- The recurring reconcile step that re-emits a visible markdown file from its hidden record when one was lost to a prior bug. That recovery path is separate from this deletion sweep.
- The git-operation queue worker's broader lifecycle (lock acquisition, op-file ordering, chain-spawn of a successor). Covered by the git-operation-queue-worker topic.
- The local-mirror migration engine's other one-shot repair phases. Covered by the summary-schema-migration topic.
- How summaries are produced from transcripts and how amend, rebase, and squash operations rewrite the tree. Covered by the amend, rebase-pick, and rebase-squash topics.

## Data Contracts

### Summary-index entry (relevant fields only)

- A commit-identifier string.
- A parent-pointer that is tri-state: `null` (root, i.e. a live head), a non-empty string (a hoisted older version pointing at a newer commit-identifier), or absent (legacy entry, treated as root for backward compatibility).
- A branch-name string identifying the branch at which the entry was generated. This field is preserved on hoisted children — it does NOT track which branch currently has the head.

### Storage capability surface (consumed only)

The cleanup helper consumes two optional capabilities from the storage backend:
- A "delete visible markdown for one entry" operation that takes an index entry and returns a boolean: `true` when a file was actually unlinked, `false` when the file was already absent. May throw on I/O failure. Its **scope is the entry's whole visible footprint**, not one file: on the local-mirror backend it removes the entry's per-commit skill-usage aggregate (`skills--<hash8>.md`) before removing the summary markdown itself, and the boolean it returns describes only the summary markdown.
- A "prune branch-folder-mapping rows" operation that takes a list of branch-names and returns the count of mappings actually removed. May throw.

A backend that exposes neither (e.g. a pure durable-store-only backend with no visible layer) is a valid target: both helpers no-op cleanly.

### Result record

- `deleted`: count of entries whose visible markdown was actually removed during this invocation.
- `failed`: count of entries whose visible markdown removal threw.

## Behavior

### Selection criterion

For both invocation modes the candidate set is computed from a single read of the summary-index entry map:

- **Single-branch mode.** Candidates are exactly those entries whose branch-name equals the requested branch AND whose parent-pointer is a non-null string. Entries with parent-pointer `null` (live heads) on the requested branch are NEVER touched. Entries on other branches are NEVER touched, even when their parent-pointer is non-null.
- **All-branches mode.** Candidates are every entry whose parent-pointer is a non-null string, across every branch in the index. Entries with parent-pointer `null` are NEVER touched.

Entries with an absent parent-pointer field (legacy backward-compatibility shape, treated as root) are NOT selected — only an explicit non-null string qualifies.

### Per-entry deletion loop

The candidates are iterated and the storage's per-entry delete-visible-markdown operation is invoked for each one. The loop itself is unchanged by the addition of the skills sibling: the sweep makes exactly the same call it always did, and the sibling removal happens inside that call.

- If the operation returns `true`, the `deleted` counter increments.
- If the operation returns `false`, no counter increments. This is the steady-state outcome for any candidate whose visible markdown was already removed by a prior sweep. Index entries persist forever, so visiting and counting them would yield a perpetually non-zero result.
- If the operation throws, the `failed` counter increments and the loop continues to the next candidate. The error is logged at warning level with the entry's commit-identifier (abbreviated to the first eight characters) and branch. One bad file does not abort the sweep.

### Backend-capability short-circuit

If the storage backend does not expose the "delete visible markdown" operation at all, both invocation modes return immediately with `deleted = 0`, `failed = 0`. No index read is performed and no ghost-branch pruning is attempted. This is the documented behavior for any backend that has no visible-layer concept.

### Ghost-branch pruning (single-branch mode)

After the per-entry loop finishes in single-branch mode, the helper checks whether the requested branch has become a "ghost" — present in the index with at least one entry, but with zero live-head entries (zero entries with `parentCommitHash === null`). This shape arises naturally from a cross-branch hoist: when a commit's effective branch changes (cross-branch amend, cherry-pick, rebase), the new live head lands on the destination branch while the prior head's index entry retains its origin branch-name as a hoisted child. After the sweep deletes that origin branch's last visible file, the origin branch's mapping in the visible-layer branch-folder registry should be dropped so the UI does not list a branch with zero visible content.

Pruning rules:

- **Required precondition: the branch appears in the index.** If the requested branch has zero entries at all in the index, the prune step is skipped. This protects branch-folder mappings created before any commit landed on the branch (a fresh checkout that has registered its mapping but never produced a summary). Pruning such mappings would make freshly checked-out branches vanish from the sidebar before they ever generated a summary.
- **Required precondition: zero live heads.** If any entry on the requested branch has parent-pointer `null`, the branch has a live head and is NOT pruned.
- **Required precondition: zero deletion failures.** If any candidate in the per-entry loop threw, ghost-branch pruning is skipped for this invocation. The rationale is that an undeletable visible markdown (e.g. user-edited or editor-locked file) leaves an orphan file on disk while the index snapshot still reads "no heads on this branch"; pruning the mapping anyway would hide the branch from the sidebar but the orphan file would remain invisible-but-present. The mapping is retained until a future sweep succeeds at removing the file.
- **Capability gating.** If the storage backend does not expose the "prune branch-folder-mapping rows" operation (e.g. a backend with no mapping registry), pruning is a no-op.
- **Error tolerance.** If the prune operation throws, the failure is logged at warning level and swallowed. The cleanup tail step MUST NOT roll back the originating version-control operation by propagating a side-channel registry failure.
- **Logging.** When the prune operation reports a non-zero count of mappings actually removed, an info-level message records "pruned ghost-branch mapping after hoist". When the operation reports zero removed (mapping was already gone, e.g. concurrent prune), the call still happened but the info message is skipped. The result record's `deleted` and `failed` counters are unaffected by ghost-branch pruning either way.

### Ghost-branch pruning (all-branches mode)

After the per-entry loop finishes in all-branches mode, the helper computes the ghost set across the entire index: every branch-name that appears in the index but has zero entries with parent-pointer `null`. Pruning rules differ from the single-branch case in two ways:

- **No `failed === 0` guard.** All-branches mode is invoked from the recurring reconcile step at local-mirror activate, where the goal is to drain a backlog of pre-existing ghosts accumulated by earlier code revisions. A single undeletable file on one branch does not block pruning of other branches.
- **Single batch call.** All ghost branch-names are passed in one invocation of the prune operation, not one call per branch.

If the computed ghost set is empty, the prune operation is not invoked at all. If it is non-empty:
- A non-zero return triggers an info-level "pruned N ghost-branch mappings across all branches" message.
- A zero return suppresses the info message but the call still happened.
- A thrown exception is logged at warning level and swallowed.

The result record's `deleted` and `failed` counters are not affected by ghost-branch pruning.

### Trigger site 1: tail of every version-control operation

The queue worker — the serial drainer that processes recorded version-control operations one at a time under a lock — invokes single-branch mode as the final step of each operation it completes. The branch passed to the helper is the branch-name captured by the hook at the moment the operation was recorded (NOT the current branch resolved live, which may have changed by the time the worker runs).

Tail-step rules:

- **Captured-branch requirement.** If the queue entry lacks a captured branch-name (a pre-existing entry from a code revision that did not capture this field), the cleanup tail step is skipped with a warning-level log entry. The rationale is that guessing the live branch at cleanup time is exactly the failure mode the captured-branch field was introduced to prevent: a guess could prune mappings for a branch the user has since switched to.
- **Failures do not roll back.** Any thrown exception from the helper is caught at the tail-step boundary, logged at warning level, and swallowed. The version-control operation that produced the hoist is already complete; a cleanup failure must never propagate upward.
- **Conditional logging.** When the helper returns `deleted = 0` and `failed = 0` (the steady-state common case under v4 hoist, where the only candidates are entries whose visible file was already removed by an earlier sweep), no log line is emitted. Either a non-zero `deleted` or a non-zero `failed` produces an info-level summary line.

### Trigger site 2: recurring reconcile at local-mirror activate

The local-mirror migration engine runs once per activate (window reload / process start). After its one-shot repair phases, it invokes all-branches mode unconditionally on the local-mirror storage backend. This is an idempotent reconciliation, not a one-shot repair gated by a stamp:

- **Runs on every activate.** Pre-existing hoisted children whose origin branch has since gone inactive or been merged would otherwise accumulate forever, because the queue worker's tail-step only sweeps the branch on which an operation is currently happening.
- **Independent of the one-shot repair stamp.** A "migration completed" stamp on the local-mirror state gates only the one-shot repair phase that re-emits lost head markdown. This recurring sweep is NOT gated by the stamp and runs every activate regardless of stamp state. The stamp itself MUST NOT be bumped by this recurring sweep alone (a fresh stamp timestamp on every reload would erase the meaning of the stamp).
- **A non-zero `failed` count is logged at warning level.** A persistently undeletable visible markdown on a now-inactive branch leaves a ghost file that no later run surfaces. The warning is emitted independently of any info-level summary so it is not swallowed under quiet logging modes.
- **Cross-storage scope.** The migration engine invokes this only against the visible-layer storage backend it owns (the local mirror). A pure durable-store backend has no visible-layer files, so a similar invocation against it would short-circuit on the capability check.

## State Transitions

This helper is stateless — it reads the index snapshot once at invocation, computes the candidate set, and operates on each. There is no persistent state mutation other than:
- Visible-layer file deletions (per-entry, via the storage backend).
- Branch-folder mapping deletions (per ghost-branch, via the storage backend).
- Log records.

No invariant is maintained across invocations beyond the on-disk file system and the mapping registry themselves. The index-entry map is NOT mutated by this helper: a hoisted child's index entry persists after its visible markdown is deleted.

## Notable Behavior

- **The sweep also removes each stale child's skill-usage aggregate, and this spec's contract did not have to change to get it.** The per-entry delete operation removes the `skills--<hash8>.md` sibling before the summary markdown, so the sweep inherits that behavior through the same call it already made. A sibling failure is logged and swallowed *inside* that operation, so it never reaches this helper: it does not increment `failed`, and therefore cannot suppress the single-branch ghost-branch prune, which is gated on `failed === 0`. The trade-off is deliberate and asymmetric — an undeletable *summary* markdown blocks the prune (the orphan would be invisible-but-present), while an undeletable *aggregate* does not, because a stranded aggregate is swept by the next pass and is not itself a memory. (Notable; the containment lives in the backend, not here — see the folder-based summary storage spec.)
- **The deletion counter reflects real unlinks, not visits.** A perpetually non-zero "deleted" count on every activate would collapse the user's expanded folder tree in any UI that watches deletion events for cache invalidation. The contract therefore is: "the steady-state result on a quiet repo is `deleted = 0, failed = 0`." Backends MUST return `false` from the per-entry delete operation when the file is already gone. (Intentional.)
- **Branch-scoped invocations never touch other branches' candidates.** A queue-worker tail step operates against the captured branch only. Even when other branches in the same index have stale-child candidates, they are deferred to either (a) a future operation on that branch, or (b) the recurring all-branches sweep at next activate. This guarantees a single operation's cleanup cost is proportional to its own branch, not the whole repo. (Intentional.)
- **The ghost-branch precondition "branch appears in the index" is required.** A fresh checkout may have registered a branch-folder mapping before any summary was produced; without this precondition, the very first cleanup sweep would erase the mapping and the freshly checked-out branch would disappear from the sidebar. (Notable; intentional.)
- **The single-branch ghost-prune `failed === 0` guard intentionally creates a UI/disk-state divergence window.** Under EACCES/EBUSY on a user-edited visible markdown, the index snapshot reads "no heads on this branch" but the orphan file is still on disk. Pruning the mapping anyway would hide the branch while leaving the orphan invisible-but-present. The guard prefers a visible-but-empty branch in the UI to an invisible orphan on disk, on the bet that the next cleanup pass (after the lock clears) restores consistency. (Notable; intentional.)
- **The all-branches ghost-prune has NO `failed === 0` guard.** A single locked file on one branch must not block ghost cleanup of other branches at activate time. The asymmetry with the single-branch guard is by design: the single-branch trigger runs frequently and can re-attempt; the all-branches trigger runs once per activate and is the only opportunity to drain pre-existing ghosts. (Notable; intentional.)
- **Failures in the prune step never demote the operation's success result.** Both invocation modes always return the per-entry-loop's `deleted` and `failed` counters as the public result, regardless of whether ghost-branch pruning succeeded, returned zero, or threw. The prune step is a side-channel registry cleanup, and a registry failure must never demote the visible markdown deletion result that triggered it. (Intentional.)
- **The captured-branch requirement at the queue-worker tail step is non-negotiable.** Resolving the live branch at cleanup time is exactly the bug the captured-branch field exists to prevent. A pre-existing queue entry without a captured branch-name is skipped with a warning, NOT processed against a fallback branch. (Intentional.)
- **A non-zero `failed` at the activate-time reconcile is logged at warning level independently.** A user running under a quiet logging mode would otherwise never see that ghost visible files have accumulated on disk. The warning is emitted in addition to (not instead of) any info-level summary. (Notable.)
- **The all-branches sweep at activate is on a single backend.** The migration engine that invokes it owns the visible-layer storage; this helper is not invoked against the durable-store backend (which has no visible layer). The capability short-circuit makes this safe even if the storage selection ever changes — a backend with no visible-layer concept simply no-ops. (Notable.)
- **The recurring all-branches sweep cannot recover heads that an earlier code revision's inverted-criterion bug already deleted from disk.** Restoring lost head markdown is a separate, one-shot repair owned by the migration engine and not described here. (Notable.)
- **Tri-state parent-pointer matters for the selection criterion.** Only an explicit non-null string is a candidate; an absent (`undefined`) parent-pointer on a legacy index entry is treated as root and NOT selected. A `null` parent-pointer is also NOT selected. (Notable; intentional.)

## Shared Behavior

- **Summary tree structure and the parent-pointer convention** — covered by the summary-tree-structure topic. The unified-hoist regime's rule that every new commit/amend/squash writes a fresh head with `parentCommitHash === null` and reassigns the prior version's index entry to `parentCommitHash = <new-head>` is the precondition that creates the candidates this helper deletes.
- **Memory-bank folder layout** — covered by the memory-bank-folder-layout topic. Defines the visible-layer per-branch directory structure, the per-commit skill aggregate that sits beside each summary markdown, the branch-name → folder-name deterministic transcoding, and the branch-folder-mapping registry (`branches.json`) that the ghost-branch prune step targets.
- **Folder-based summary storage** — owns the per-entry delete operation this helper calls, including the sibling-first ordering, the separate error containment around the sibling, and the manifest bookkeeping both removals perform.
- **Git-operation queue worker** — covered by the git-operation-queue-worker topic. Owns the tail-step trigger site; this helper is invoked as the worker's final step on every drained operation after the worker has finished writing the new head's summary.
- **Amend, rebase-pick, and rebase-squash migrations** — covered by their respective topics. Each is a producer of new candidates: every successful amend, pick-with-modification, or squash leaves the prior version with a non-null `parentCommitHash`, which this helper then sweeps from the visible layer.
- **Summary schema migration** — covered by the summary-schema-migration topic. Owns the local-mirror migration engine's one-shot repair phases and the migration stamp. This helper is invoked as the engine's recurring (every-activate) reconcile phase, distinct from those one-shot phases and not gated by their stamp.
