# 359. Memory Bank Duplicate-Folder Consolidation

## Topic Statement

Fold the several Memory Bank folders that hold one repository into a single survivor, chosen by comparing each folder's set of stored memories against the system of record.

## Scope

**In scope:**
- The trigger: the desktop editor host's folder-tree Refresh, immediately after the unused-folder archival sweep on the same click.
- Duplicate detection for the **current** repository only: which folders count, how identity is compared, and the base-name-plus-numeric-suffix ladder that bounds the search.
- The classification, decided solely by comparing sets of stored memory identifiers: the three cases, the survivor each one picks, and the tie-breakers.
- The modal confirmation gating the whole operation, its case-specific wording, and the fact that execution happens only on confirm.
- The archival of every folder the survivor replaces — a recoverable move, never a deletion — and, on the rebuild case, of the survivor's own predecessor at the base name.
- The merge: recursive copy-if-absent, the metadata union across the index, the manifest and the branch registry, the heal pass that regenerates missing human-readable copies, and the archival of the drained losers.
- The rebuild: archiving the whole pile, recreating the base-named folder, and re-populating it from the system of record.
- What the merge omits — the archive subtree at every depth, and the per-folder configuration, migration-progress and dirty-marker documents.
- The base-slot hijack the rebuild's survivor computation admits.
- The degradations: a system of record that is absent at execute time, and one that is unreadable at classify time.
- What "the system of record" resolves to, the one routing state for which resolving it raises, and why that raise never reaches the user.
- The per-vault write lock hold, its wait budget, and the fail-visibly-on-busy discipline.
- What happens after a successful merge: the notification and its reveal action, the dirty signal, the folder re-listing, and the re-pushed pickers.
- The host preconditions: what the host must supply, and which hosts perform this at all.

**Out of scope (boundaries):**
- The unused-folder archival sweep that runs immediately before this operation on the same Refresh — it archives every discovered folder that provably holds nothing, skipping the current repository's own, and it skips silently when the vault is busy. Covered by the Memory Bank unused-folder archival spec.
- The folder-tree listing itself: the relative-path protocol, lazy expansion, manifest-derived file classification, title derivation, and the divergence flag (covered by the editor Memory Bank folder-browser spec).
- The repository-identity normalization that folds transports and host aliases to one key — the fix that stops *new* duplicate folders from appearing, and which cannot retract the folders already on disk (covered by the repository-identity-and-folder-naming spec).
- The folder-resolution ladder that allocated the numeric suffixes, and the peek mode that re-resolves a freed slot without claiming it (covered by the Memory Bank folder-layout spec).
- The copy engine that re-populates a folder from the system of record — its per-root pass, its idempotency check, its bulk sweeps, its progress record, and the visible-layer reconciliation at its tail (covered by the Memory Bank migration-engine spec).
- The heal pass that regenerates a missing human-readable copy from its hidden source, and the hand-edit protection that refuses to overwrite a diverged file (covered by the folder-based summary-storage spec).
- The archive directory's naming and its interaction with the vault sync classifier (covered by the migration-engine and sync-engine specs).
- The per-vault write lock's own primitive: its identity derivation, staleness ceiling, heartbeat, and ownership-checked release (covered by the vault write-lock spec and the lock-primitive registry).
- The storage routing that decides which backend is a repository's system of record, and the freeze that makes a previously-authoritative one unwritable (covered by the storage-routing and cutover-fence specs).

## Data Contracts

### Duplicate set

Every folder under the vault parent whose recorded identity matches the **current** repository, found by walking the base name and then its numeric-suffix ladder up to a fixed cap. The match predicate has three arms:

- Both sides record a remote — the two normalized remotes must be equal.
- Neither side records a remote — the folder's recorded name must equal the current one **or be unset entirely**.
- One side records a remote and the other does not — never a match, whichever way round.

The second arm's "or be unset" is why an unclaimed stub is **not** excluded: for a project with no remote of its own, a folder carrying neither a remote nor a name joins the duplicate set. Folders that record a *different* repository's remote are excluded by the first arm, and a folder that records no remote at all while the current project has one is excluded by the third.

Fewer than two matches means there is nothing to consolidate and no plan is produced.

This set is **not** the same as the set of folders the unused-folder sweep on the same Refresh skipped. The two differ in both directions:

- A folder that records no remote while the current project has one is *skipped by the sweep* (its recorded name can still match the current repository's) yet *excluded from this set* by the third arm above.
- A nameless stub at a suffixed slot, under a remote-less project, is *in this set* by the second arm yet *not skipped by the sweep* — its recorded name is the suffixed directory name, which matches neither the current repository's name nor the current-repository flag. If it is empty, the sweep archives it before detection runs.

For the ordinary case — a project that records a remote, and folders that record the same one — the two sets do coincide, because every member then also carries the discovery pass's current-repository flag.

### Memory set

For each folder, the set of stored-memory identifiers recorded in its hidden layer's per-memory document directory, read by enumerating that directory's entries. An unreadable or absent directory yields the empty set.

This set is the **only** input to classification. Nothing else about a folder — how many visible files it carries, how recently it was written, what its configuration or migration-progress records say, whether it carries a dirty marker — influences which folder survives.

### Plan

Produced by classification, consumed by execution:

- The **case** (one of the three below).
- The current repository's recorded name.
- The full duplicate set.
- The **survivor**: the folder that will remain live. For two of the cases this is a member of the duplicate set; for the rebuild case it is the base-named path, which may itself be archived and then recreated.
- The **archived** list: for two of the cases, every folder except the survivor; for the rebuild case, **every folder including the base**.
- Counts, for the confirmation's wording: each folder's memory count, the system of record's count, the union's count, the survivor's own count, and how many the survivor stands to gain (union minus survivor).

### Classification

| Case | Condition | Survivor | Archived |
| --- | --- | --- | --- |
| **Identical** | Every folder holds the same memory set | The folder with the shortest basename; ties broken lexicographically | Every other folder |
| **Orphan-superset** | The sets differ, but their union is a subset of the system of record's set | The base-named path, computed directly | **Every** folder, the base included |
| **Union-largest** | The sets differ and the union contains at least one memory the system of record does not | The folder with the most memories; ties broken by the shortest-basename rule | Every other folder |

The order is fixed: identity is tested first, then the subset test, and union-largest is the fallback. That ordering decides more than tie-breaking — because set identity is tested **before** the subset test, folders holding the same memories classify identical no matter what the system of record holds, including when it could not be read at all. The union-largest case is the one that exists because rebuilding from the system of record would **drop** memories another clone wrote against a system of record that lives elsewhere.

### Result

The case that was executed, the survivor's path, the list of archived folders, and the survivor's memory count read back from disk after the operation.

### Merge exclusions

The recursive copy skips:

- **Every metadata document that is either merged or survivor-owned**: the projected index, the manifest and the branch registry (all three merged separately, below), and the per-repository identity document, the migration-progress record and the per-device dirty marker (none of which are copied or merged at all).
- **Any directory named for the archive, at every depth**, and any version-control directory. Both are skipped by name during the walk and again by relative-path prefix when a file is considered.

## Behavior

### Trigger and ordering

1. The user clicks Refresh on the folder tree, at the Memory Bank scope or the everything scope.
2. The unused-folder archival sweep runs (boundary).
3. This operation runs: detect, confirm, execute.
4. The root listing is re-fetched.
5. The repository and branch pickers are re-pushed, so an archived repository stops being offered.

The whole operation is skipped, silently and with no message, when the host did not supply a current repository name **or** a current project root. Both are required: the duplicate set is defined relative to one repository identity, and reading the system of record requires that repository's working tree.

### Detection

1. Assemble the duplicate set for the current repository. Fewer than two members: return no plan and stop.
2. For each folder, read its memory set and record its count. Accumulate the union.
3. Read the system of record's memory set.
4. Classify per the table above and compute the survivor, the archived list, and the counts.

**Detection runs outside the lock.** Nothing about the plan is re-validated under the lock before it is executed.

### Confirmation

A **modal** warning, one of three sentences chosen by case, each naming the repository, the number of folders, the survivor's basename and the relevant counts:

- Identical — states that the folders have identical contents and the memory count they share, and asks to keep the survivor and archive the rest.
- Orphan-superset — states that the system of record already contains all of its memories, so a single clean folder under the base name will be rebuilt from it and every duplicate archived.
- Union-largest — states that the folders have different contents, that the survivor will absorb a stated number more from the others for a stated total, and that the remaining folders will then be archived.

Execution proceeds only when the user picks the merge action. Any other outcome — the alternative button, dismissal, or the modal being closed — returns without touching anything.

### Execution — merge (identical and union-largest)

Held under the per-vault write lock for its whole duration (below).

1. Ensure the survivor's hidden layer directory exists.
2. For each other folder, walk it recursively and copy every file into the survivor at the same relative path **only when nothing exists there already**. The survivor's own copy always wins a collision. The exclusions above apply.
3. Union the three metadata registries, in each case reading the survivor first so its rows win, then each loser in order:
   - The projected index, keyed by memory identifier; the survivor's recorded schema version is kept, and cross-commit alias mappings are unioned by key on the same first-wins rule.
   - The manifest, keyed by file identifier.
   - The branch registry, keyed by branch name.
   Each merged registry is written atomically over the survivor's own.
4. Run the survivor's heal pass, which regenerates any human-readable copy that is missing relative to its hidden source. This is a safety net for gaps an interrupted earlier write left behind, not part of the merge itself.
5. Archive each drained loser — a recoverable move into the hidden archive directory inside the vault parent, never a deletion.
6. Read the survivor's memory count back from disk and return it.

The **identical** case runs this identical sequence. It is not a shortcut that only archives: the copy, the metadata union and the heal all execute, and they are expected to be no-ops for the file layer because the memory sets match — but the metadata union is not a no-op, since two folders with the same memory set can still carry different manifest rows or branch mappings.

### Execution — rebuild (orphan-superset)

Held under the same lock.

1. Resolve the system of record for the current project. This is the only site in the operation that can propagate the blocked-routing-state raise, and it is **unreachable on such a repository** — the classifier's read already turned that raise into an empty memory set, and an empty set cannot produce this case (see the classification note).
2. **If it does not exist**, do not archive anything: fall back to a union-largest merge over the same folders, recomputing the survivor as the folder with the most memories and running the merge sequence above. This is deliberately a lossless degradation — archiving every folder and then rebuilding nothing would leave every memory in the archive.
3. Otherwise archive **every** folder in the duplicate set, the base-named one included, so the base slot is free.
4. Write the current repository's identity into the base-named path.
5. Ensure that folder's hidden layer.
6. Run the copy engine over the system of record into it (boundary), which re-populates the memories, transcripts, plans, notes and plan-progress, and stamps its own progress record.
7. Read the resulting memory count back from disk and return it.

### Lock hold and busy discipline

The vault parent is also the vault's own version-controlled working tree, so the copy-if-absent, the metadata union and every archival rename are working-tree mutations that must serialize against a queue worker mid-drain, a synchronization round that has already snapshotted the working tree's status, and a compile pass. The whole execution therefore runs under the per-vault write lock, keyed on the canonical vault parent, that all of those writers take.

The lock is taken with the **short** wait budget — ten seconds — and polled at a fixed short interval, with the lock's modification time heartbeated while held.

**When the lock is busy for the whole budget the merge fails visibly.** A typed busy signal reaches the caller, which tells the user the product is busy writing a summary right now and to click Refresh again shortly. This is deliberately the opposite of the sweep that ran moments earlier on the same click, which skips silently: the user confirmed this merge through a modal, so a silent swallow would look like Refresh did nothing.

Any other failure is logged and swallowed, so the re-listing the user asked for still happens.

### After a successful merge

1. Drop the whole per-session clean-repository memo. The survivor's contents changed even when its path did not, so the next listing must re-run its reconcile-and-heal pre-pass rather than short-circuit past it.
2. Show a notification naming the survivor's basename, the survivor's memory count, and how many duplicate folders were archived, with singular and plural wording chosen from the count, and offer a reveal-the-archive action.
3. Re-fetch the root listing.
4. Re-push the repository and branch pickers.

## State Transitions

Per Refresh, for the current repository's folder set:

| From | Event | To |
| --- | --- | --- |
| One folder (or none) | Detection | Unchanged; no plan, no modal |
| No current repository name or no project root | Detection | Unchanged; operation disabled, silently |
| Several folders | Detection | A plan exists; modal open |
| Modal open | Dismissed or declined | Unchanged; **the modal reappears on every subsequent Refresh** |
| Modal open | Confirmed, lock busy for the whole budget | Unchanged; the user is told to retry shortly |
| Modal open | Confirmed, identical or union-largest | One survivor holding the union of the file layers and the union of the three registries; every other folder archived |
| Modal open | Confirmed, orphan-superset, system of record present | Every folder archived; a fresh base-named folder re-populated from the system of record |
| Modal open | Confirmed, orphan-superset, system of record absent at execute time | Degrades to a union-largest merge; nothing is archived beyond the merge's own losers |
| Any | System of record unreadable at classify time, folder sets **differ** | The plan is forced to union-largest, because an unreadable source reads as the empty set and no non-empty union is a subset of it |
| Any | System of record unreadable at classify time, folder sets **equal** | Identical — the set-identity test runs first and never consults the system of record |
| Any | The repository's routing state is blocked (frozen system of record) | Reads as the empty memory set, so consolidation **runs** and always folds; the rebuild case is unreachable there |

## Notable Behavior

- **Classification looks only at stored memory identifiers.** Nothing else is consulted — not visible-file counts, not modification times, not the configuration or migration-progress documents, not the dirty marker. Two folders whose memory sets match are "identical" even when everything else about them differs. (Notable; it is what makes the classification cheap and deterministic, and it is also the root of the omissions below.)
- **The merge walker skips any directory named for the archive at every depth, so a loser folder's own archived content is silently not carried over.** The skip exists to keep the vault root's archive out of a recursive copy, and it is applied by bare directory name during the walk, so it matches at any nesting level. A folder that itself accumulated an archive subtree therefore has that subtree left behind in the archived loser. Nothing reports it. (Surprising; a real data omission produced by a defensive rule aimed at a different depth.)
- **Under union-largest a diverging same-identity memory in a loser is dropped with no conflict surfaced.** The copy is copy-if-absent and the survivor always wins a collision, so where two folders hold different content for the *same* memory identifier, the loser's version is simply not carried over — and the loser is then archived. There is no comparison, no conflict list, no warning, and the notification counts only what the survivor holds afterwards. (Surprising.)
- **The losers' configuration, migration-progress and dirty-marker documents are neither copied nor merged.** For the configuration document this is correct — the survivor owns its own identity. For the other two it is a loss: migration progress recorded only in a loser is gone, so a subsequent activation reads the survivor's own record and may re-run a copy the loser had already completed; and a dirty marker recorded only in a loser is dropped, which discards the one signal that a write meant for that content failed. That last point is the exact inverse of the sibling sweep on the same Refresh, which treats the marker as content weighty enough to pin a whole folder. (Surprising; the two halves of one Refresh disagree about the same file.)
- **Base-slot hijack: the rebuild's survivor is the base-named path computed directly, not re-resolved after archiving.** The rebuild archives every folder for *this* repository and then writes this repository's identity into the base name. If that base name belongs to a **different** repository sharing the same basename — which is the very reason this repository was given a numeric suffix in the first place — the archival step does not touch that other repository's folder, and the rebuild then overwrites its recorded identity and migrates this repository's memories into it. The pre-existing explicit rebuild action avoids exactly this by re-resolving the freed slot through the read-only peek resolver after archiving, which would return the next unused suffix when the base is still occupied by someone else. This operation skips that step. (Surprising; documented as the behavior.)
- **A disabled repository loses everything to the archive on the rebuild path.** Neither this operation nor the sweep before it consults the manual-disable state. For a repository the user turned off and whose classification lands on orphan-superset, the sequence still archives **every** folder, then the identity write into the recreated base folder is suppressed by the storage layer's own gate, the copy engine returns its transient "skipped" outcome, and nothing is rebuilt. The notification then reports the survivor with a memory count of zero. Every memory is recoverable from the archive and from the system of record, but the product has emptied the user's Memory Bank for that repository and reported success. (Surprising; the highest-consequence interaction in this spec.)
- **Detection runs outside the lock and the plan is never re-validated under it.** The modal can sit open indefinitely — it is modal to the editor window, not to the machine — while a queue worker writes new memories, a synchronization round pulls a peer's, or another window's Refresh archives a folder. Execution then acts on counts and a folder list that may no longer describe disk. The lock protects the *mutations* from tearing, not the *decision* from going stale. (Surprising; the split between plan and execute exists to put the modal in the middle, and that is exactly where the staleness enters.)
- **Dismissing the modal suppresses nothing.** There is no "do not ask again", no per-session memo, and no marker on disk. The duplicate set is recomputed from scratch on every Refresh, so a user who declines is asked again on the next click, indefinitely. (Notable.)
- **Two brand-new empty folders produce a modal describing identical contents holding zero memories.** Whenever the project records a remote, every member of the duplicate set also carries the discovery pass's current-repository flag, and the sweep on the same click deliberately skips exactly those — so the sweep cannot clear them. Two empty folders have equal (empty) memory sets, so they classify as identical, and the confirmation asks the user to approve keeping one folder with zero memories and archiving another with zero memories. (The one member the sweep *can* reach first is the nameless stub of a remote-less project; see the duplicate-set contract.) (Surprising; the interaction between the sweep's current-repository guard and this operation's identity scoping.)
- **The identical case still runs the whole merge.** It is not an archive-the-others shortcut: the file copy, the three-registry union, and the heal pass all execute. The file copy is expected to be a no-op, but the registry union is not — two folders holding the same memories can still carry different manifest rows and different branch mappings, and the union is what preserves them. (Notable; a reading of the case name that assumes "nothing moves" is wrong.)
- **The two degradations point in opposite directions and both favour keeping data.** An unreadable system of record at classify time reads as the empty set, so — for folders whose sets *differ* — the subset test cannot pass and the plan is forced to union-largest: a fold, never a rebuild. (Folders whose sets are equal still classify identical; the identity test runs first.) An absent system of record discovered at execute time abandons the rebuild and falls back to a union-largest merge rather than archiving the pile and rebuilding nothing. Neither degradation is reported to the user; both are logged. (Notable.)
- **A frozen system of record does not stop the consolidation — it makes it always fold, and makes the rebuild case unreachable.** Before a storage cutover the system of record is the version-controlled ref; after one it is the local database; for a repository whose routing state is blocked, resolving it raises. But the classifier's read of the system of record catches that raise and answers the **empty set**, so classification proceeds, a plan is produced, the modal is shown, and a merge executes. The empty set can only satisfy the subset test when the union is empty too — and an empty union means every folder's set is equal, which the identity test claims first. So the one call site that could propagate the raise (the rebuild's own resolution of the source) is never reached on such a repository. What the user sees is a merge, not an error. (Surprising; the obvious reading — "it throws, the caller swallows it, nothing happens" — is wrong in both halves.)
- **This holder does not discharge the lock's release-time obligation.** Three holders pass the release-time hook that drains the cross-repository pending-worker registry when the lock frees — the queue worker's per-write ingest guard, the single-target compile and the multi-repository compile sweep — so a queue worker that timed out waiting for the vault and recorded itself there is re-spawned. Neither this operation nor the sweep before it passes one, so a stranded worker stays stranded across both, until its own repository's next commit spawns a fresh worker. Two further holders drain without the hook and so are not the contrast either: the queue worker's summary drain drains the registry itself right after releasing, and the reconciliation round drains at the end of a round rather than at lock release. (Surprising; an omitted argument rather than a recorded decision.)
- **The busy discipline is the reverse of the sweep's, on the same click and the same lock with the same budget.** The sweep skips silently; this fails visibly with a retry instruction. The distinction is whether the user asked for the specific operation, and it is the first time this lock has had two callers with opposite disciplines. (Notable.)
- **Survivor selection prefers the shortest name, which is a proxy for "the unsuffixed one".** Both the identical case and the union-largest tie-break sort by basename length and then lexicographically, so the base name wins over any numeric suffix, and `-2` wins over `-10`. This is a determinism rule rather than a judgement about which folder is more real. (Notable.)
- **The suffix ladder bounds detection, so a folder past the cap is invisible.** Duplicate detection walks the base name and a fixed number of numeric suffixes; a folder allocated outside that ladder — notably the timestamp-suffixed last-resort name the folder allocator falls back to when the ladder is exhausted — is never part of a duplicate set and never consolidated. (Notable.)
- **The operation is silently disabled without a current project root.** A host with no repository open, or one that does not supply the working-tree root, gets no detection and no message. The requirement is real — the system of record is read relative to that root — but the failure is indistinguishable from "no duplicates". (Notable.)
- **Only the desktop editor host performs this.** The other IDE integration's Memory Bank explorer has neither this consolidation nor the unused-folder sweep, so a user of that host sees the duplicate folders and has no in-product way to fold them. The rules themselves live in the shared core layer and could be reached over that host's bridge; no bridge operation exposes them today. (Notable.)

## Shared Behavior

- **The unused-folder archival sweep** that runs immediately before this operation on the same Refresh — its emptiness predicate, its current-repository guard, its silent skip on a busy vault, and its own omission of the lock's release hook — is defined by the Memory Bank unused-folder archival spec. The two share the lock, the budget and the archive destination, and disagree about the dirty marker.
- **The per-vault write lock** — its identity derived from a canonicalization of the vault root, its acquisition modes and wait budgets, its heartbeat, its ownership-checked release, and the cross-repository pending-worker registry drained on release — is defined by the vault write-lock spec, and its position in the product's lock catalogue by the lock-primitive registry.
- **The copy engine** that re-populates the recreated base folder from the system of record — its per-root pass, the manifest-based idempotency check, its bulk sweeps, its progress record, the transient "skipped" outcome it returns for a disabled repository, and the visible-layer reconciliation at its tail — is defined by the Memory Bank migration-engine spec. That spec also owns the explicit rebuild action whose post-archive slot re-resolution this operation does not perform.
- **The heal pass** that regenerates a missing human-readable copy from its hidden source, the hand-edit protection that refuses to overwrite a diverged file, and the manifest, index and branch-registry schemas the metadata union reads and writes are defined by the folder-based summary-storage spec.
- **The archive directory** — its location inside the vault parent, its timestamped naming, its collision counter, and why archiving is a move rather than an identity rewrite — is shared with the migration engine's rebuild path and defined by the Memory Bank migration-engine spec.
- **The duplicate folders' origin**: the repository-identity normalization that folds transports and host aliases to one key (the fix that stops new duplicates and cannot retract existing ones) is defined by the repository-identity-and-folder-naming spec; the numeric-suffix ladder, the reuse-and-adoption policy, and the read-only peek resolver are defined by the Memory Bank folder-layout spec.
- **Storage routing** decides which backend is this repository's system of record and therefore what the subset test compares against; the freeze that makes resolving it raise — a raise this operation absorbs into the empty set rather than propagating — is owned by the cutover-fence spec.
- **The folder-tree listing** and the per-session clean-repository memo dropped after a successful merge are defined by the editor Memory Bank folder-browser spec.
- **The manual-disable state** neither this operation nor the sweep consults, and the storage-layer suppression that makes the disabled-repository outcome what it is, are defined by the durable repository opt-out spec and the zero-write contract spec.
