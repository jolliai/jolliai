# 360. Working-Tree File Discard

## Topic Statement

The single path-driven rule set that resolves each requested discard path against one authoritative status read taken at the worktree root, dispatches it to one of a closed set of index/worktree operations, and reports a per-path outcome that never presents a failure as success.

## Scope

**In scope:**

- The request shape: a list of paths and nothing else. Why status codes are deliberately not an input.
- The worktree-root anchoring the rule set performs on its own, and what happens when that resolution fails.
- The one status read, its two-column parsing, the rename/copy path pair, and the precedence rule that resolves a path reported twice.
- The classification order and each group's operation, including the per-path question asked of git for conflicted rows.
- The outcome record: its actions, the rule pairing each action with success or failure, and the extra paths a rename revert reports back.
- The read-only companion query that decides the confirmation wording — what it answers, what it answers when it cannot, and the letter heuristic that survives only as its throw-fallback.
- Every way a failure could be lost, and the guard that closes each.
- The literal-pathspec rule and the known sites that do not honour it.
- Each host's obligations around the call: the pre-call unsaved-editor flush, the post-call refresh, and the capability asymmetry between the two hosts.

**Boundaries (consumed here, owned elsewhere):**

- The file lists the two hosts render, their per-row status letters, checkbox selection, and the rest of their panel behavior.
- The staging and unstaging operations that share the literal-pathspec wrapper but are not discards.
- The message protocol that carries a discard request from a webview to its host, and the bridge transport that carries it from the JVM host to the rule set.
- The IDE-native change tracker whose rows can disagree with a status read, and the periodic poll that re-reads it.
- The commit, amend and squash flows that consume the same file selection.

## Data Contracts

### The request

A discard request is **a list of repository-relative paths and nothing else**. No caller passes a status code, a status letter, or a pair of porcelain columns. The rule set resolves each path's state itself, from one status read, and returns **one outcome per requested path in request order, duplicates included**.

That shape is the load-bearing part, not a convenience. Both hosts previously carried their own dispatch, and nothing on the wire between a host and the shared code fails when the two disagree — so a host-side restatement is wrong *silently*. Two consequences of passing paths: a host never has to understand porcelain columns and therefore cannot collapse them lossily on the way in, and a host cannot go stale between rendering a row and the user clicking it.

The editor host's own discard message still *carries* a collapsed status letter, both raw porcelain columns and a rename's original path, and its handler still forwards them — but they are **dead payload**: nothing downstream reads them, and the path is the only load-bearing field.

The host-side copy this replaced covered fewer than half the groups below. It had no case at all for renames or copies — which cannot be discarded correctly without the original path, a field its file model never carried — and it matched untracked against a two-character code that every producer in that host collapses to one character before the row is built, so untracked files fell through to a restore-from-committed-tree that cannot succeed for a path the committed tree has never seen, and silently did nothing.

**Paths are relative to the worktree root.** The rule set anchors its own working directory there before any status read, pathspec or path join, because the three things it does with a path disagree otherwise: a status read reports root-relative paths wherever it runs, while a pathspec and a filesystem join are both resolved against the process working directory. Left unanchored the halves fail differently — the status lookup still matches (both sides come from git), the restore fails loudly on a pathspec it cannot find, and the *delete* lands on a path that does not exist, where a missing-file error is swallowed as success and the outcome reports success for a file still on disk. Anchoring closes that here rather than trusting every caller.

Anchoring does **not** rescue a caller whose paths are relative to something else: the status lookup then finds nothing for them and every one comes back as the already-in-that-state answer with success. Both hosts send root-relative paths for that reason.

When the root resolution itself fails (not a repository, git not reachable), it falls back to the caller's own directory — and the status read immediately after fails for the same reason, so every requested path is reported unavailable rather than clean.

### The status read

One read of the pending change set, with untracked directories expanded into their individual files — without that expansion a new folder is a single directory row and a request to discard a file inside it finds no entry, and both hosts list those files individually.

Each row keeps its **two columns uncollapsed** — index column and worktree column, each a single character, blank when clean — plus the path, plus (for renames and copies) the path the content came from. In the NUL-separated stream a rename or copy carries its **new path first and the original as its own following segment**; plain human-readable status output prints the pair the other way round, which is a trap when writing a test against either.

**One path can produce two rows, and the map must not be last-write-wins.** Removing a file from the index alone leaves a staged deletion in the index while the file stays on disk; the index walk and the untracked walk are separate, and both then report that path independently. The map resolves this by **precedence, not arrival order**: an untracked row never displaces an entry that already exists, and nothing else can collide (a tracked path has exactly one index state and one worktree state, and two untracked rows for one path cannot happen either). The tracked row is the right answer — restoring index and worktree together brings the index entry and the file back and leaves a clean tree.

Writing it as precedence rather than "keep whichever arrived first" is deliberate: git emits index rows ahead of untracked ones today, but that ordering is not part of the porcelain contract. **Notable:** keeping the untracked row is what previously classified such a path untracked, so the discard **deleted the worktree copy while leaving the staged deletion in the index** — reporting success with the row still on screen, because only half of it had been resolved.

A read that fails is distinguished from a clean tree and carries git's own error text. Collapsing the two is what makes every requested path look already-discarded; and a missing git binary surfaces as a nonzero exit code rather than a thrown error, so "git is not reachable" is a real deployment (a background process spawned by a GUI-launched IDE inherits a stripped search path), not a hypothetical.

### The outcome record

One record per requested path:

| Field | Meaning |
| --- | --- |
| path | The requested repository-relative path, echoed verbatim. |
| ok | Whether the requested state now holds. The **only** thing a host may branch on. |
| action | Which operation this path needed — see below. |
| error | Populated when `ok` is false: the git error text or the filesystem error that stopped it. Optional; absent failures happen. |
| additional paths | Other repository-relative paths this discard changed on disk. Populated **only** by a rename revert, and populated **unconditionally** — including on failure, because the revert is two git calls and the first may have landed. |

`action` is read **together with** `ok`, never alone: on success it is what the discard *did*, and on failure it is what was *attempted*. An unstage-then-delete that failed while unstaging never reached the delete. The alternative — a distinct action per failure point — would multiply the vocabulary a host has to know without telling it anything the error text does not.

The actions split into operations and non-operations:

| Action | Meaning | Pairs with |
| --- | --- | --- |
| restored | Worktree only, or worktree and index together. Also the answer for a conflicted path the committed tree has a version of. | success or failure |
| unstaged-and-deleted | Index entry dropped, then the file removed, because the committed tree has no version to come back to. | success or failure |
| deleted | Untracked: removed from disk. | success or failure |
| rename-reverted | Both paths unstaged, the original restored, the new path removed. | success or failure |
| already-in-the-requested-state (spelled on the wire as a "not found" value, which reads like an error and is not one) | The path had no pending change — already clean, or discarded by something else. | **always success** |
| status-unavailable | The status read could not run, so nothing was classified and nothing was touched. | always failure |
| invalid-path | The caller sent an empty or blank path, which names no file. | always failure |
| unclassified | Internal: the path reached no group and no group recorded it. | always failure |

**The already-in-the-requested-state answer is the only action that is *always* a success.** Restored, unstaged-and-deleted, deleted and rename-reverted each pair with success when they succeed and with failure when they do not; status-unavailable, invalid-path and unclassified are always failures.

### The preview record

The read-only companion answers, per path, a single boolean: **does discarding remove the file at this path rather than restoring it in place?** That is the one thing a confirmation prompt has to get right, since the user cannot undo either outcome. Nothing else is returned — not the group, not the operation.

## Behaviors (execution order)

### Classification order

Every path is looked up in the status map and classified by a **single shared dispatch table**, extracted rather than written twice precisely because the sentence the user reads before clicking and the code that decides what happens have to be the same rule. The order the groups are tested in is load-bearing:

| # | Group | Matched when | Operation | Action reported |
| --- | --- | --- | --- | --- |
| 1 | unmerged | either column carries a conflict marker, **or** both columns are the same added/deleted marker (both-added, both-deleted) | git is asked per path whether the committed tree has this path: if yes, index and worktree both restored; if no, the index entry is dropped and the file removed | restored / unstaged-and-deleted |
| 2 | renamed | index column marks a rename | one path at a time: both paths unstaged, the original restored, the new path removed | rename-reverted |
| 3 | added (including copied) | index column marks an addition **or** a copy | batch unstage, then remove each file | unstaged-and-deleted |
| 4 | untracked | both columns untracked | remove from disk; nothing in git to restore | deleted |
| 5 | staged-and-worktree | index column set to anything else | index and worktree both restored | restored |
| 6 | worktree-only | anything remaining | worktree restored, index untouched | restored |

**Unmerged must stay first.** Both-added and added-by-us carry an *added* marker in the index column, so testing additions first sent them into the addition group and **unstaged-and-deleted a file the committed tree still had** — measured on a real both-added conflict, reported as a success, leaving a staged deletion behind. Both-modified escaped only by luck: its conflict marker fell through to the staged-and-worktree group, which happens to be the right answer for it.

**The committed-tree question is asked of git, never derived from the columns.** The conflict shapes do not encode it consistently: added-by-them shows a conflict marker in the index column while the committed tree has nothing at all, so the obvious column-based rule is wrong for exactly the shape whose file must be removed. The question is answered by listing the path out of the committed tree, where **presence is non-empty output, never the exit code** (the listing exits zero whether or not the path matched). A git that cannot run therefore answers "absent", which routes to the unstage-and-remove half — where the unstage fails loudly before anything is deleted, so a broken git cannot turn into data loss.

**The unstage for a conflicted path is not the same command as the unstage everywhere else.** Restoring the index from the committed tree *refuses* an unmerged path outright, while resetting the path drops the conflict entry. Getting this wrong is at least not silent, but it is a discard that reports an error and does nothing.

Paths are grouped so each git command runs once per group rather than once per file: separate invocations contend on the index lock and turn a multi-file discard into a partial one. The two per-path loops are deliberate — a rename carries its own original path, and a conflicted row needs its own committed-tree question — and batching conflicts would gain nothing anyway, since a tree mid-merge has a handful of them rather than the hundreds the batched groups exist for.

### Notable — unborn committed tree

The addition group's unstage is chosen by asking once per call whether the committed tree resolves at all. Restoring the index *from* a tree has nothing to restore from before the first commit and refuses the whole batch. Since every staged file in a freshly initialised repository is an addition, without this branch discard cannot work at all in a repository the user has not committed to yet — it fails loudly for every file. In that case the index entry is **removed** instead, which for an addition is the same operation (the entry goes away and the path becomes untracked), and it is forced: an unforced removal is refused when the staged content differs from both the worktree and the committed tree, and the file is about to be deleted regardless. The forced form stays scoped to the unborn case; with a committed tree present, the restore is the narrower command and needs no force.

### Notable — capitalisation-only rename

After the original path is restored, the two paths' **device and inode identity** are compared and the removal is **skipped** when they are the same file. A rename that changed only capitalisation is one directory entry on a case-insensitive filesystem — which is most of this product's users — so the restore wrote the content back into the very file the removal would delete. Measured: renaming a file to differ only in case and then discarding the new path left **neither** path on disk and still answered success, so the user confirmed "undo the rename" and got the file deleted. Skipping there skips a removal, not a step: the content is already back under the original name and the index has already forgotten the move.

The comparison is identity, not a case-insensitive string compare, on purpose: on a genuinely case-sensitive filesystem the two spellings are two real files and the new one still has to be removed. Any failure to read that identity answers "not the same file", so a read that could not run can never skip a removal that was needed.

### Notable — an untracked directory git refuses to expand

Expansion turns untracked directories into their individual files, so every classified path is normally a file. A directory git will not expand — a nested repository or a submodule — arrives as a single directory row anyway, and is removed **recursively**. A plain file unlink cannot remove a directory, so without that branch such a row fails.

A removal target that is already gone is **success, not failure**: the path being absent is the state that was asked for, and something else deleting it between the status read and the removal is a race that must not be reported as an error.

### Failure modes — every way a failure could be lost

The live guards, plus one entry that is only history:

- **A failed status read reports unavailable on every requested path**, carrying git's own error text, and never the already-in-that-state answer. An empty map would otherwise make every path look already-discarded, and both hosts render that as a silent success.
- **A blank or whitespace-only path is invalid-path, per path**, without failing the rest of the batch. It must not reach the already-in-that-state line, which reports success on the premise that the caller asked for a state that already holds — a blank path holds no state, and answering "already clean" makes a malformed request indistinguishable from a working button. **Its reachability is unproven.** The editor host's three webview producers — the inline row button, the row context menu, and the review panel's file row — each substitute the empty string rather than fail, and the host's message handler forwards whatever arrives unvalidated; but all three read a field the host itself populated from a parsed status row, off a row resolved from the clicked element, so no input is known that actually yields an empty path. By the same standard that marks the unclassified action below unreachable, this is a defensive guard rather than a demonstrated path — it differs only in reporting a distinct reason. It is nonetheless a **new** guard and not a restored one: the host-side shape guard that used to reject a malformed discard payload validated the *status columns*, which stopped being an input.
- **The JVM host synthesises one failed outcome per requested path** when the response is unparseable, does not carry exactly one outcome per requested path, **or** carries an outcome with a blank action. The rule set always sets an action, so a blank one means the body cannot be lined up against the request. Returning an empty list instead reads to every caller as "nothing failed".
- **A path no group recorded is unclassified and a failure**, deliberately *not* the already-in-that-state answer: that value is documented as "the state you asked for already holds", and spelling two opposite meanings with one string leaves the success flag as the only thing telling them apart. **Unreachable today by construction** — every group records every one of its members. It is kept so the return needs no assertion, and it reports failure because a future group added without a matching record means the path was never acted on.
- **History, not a guard:** the behavior this replaced swallowed both a nonzero git exit *and* a failed file removal. That is how "the confirmation dialog appears, you click through, and the file is still there" became the user-visible symptom with nothing in any log.

**Both hosts branch on the failure flag, never on whether the error text is non-empty**, and substitute a generic message when a failure arrives without one. The error field is optional, so an empty-string test drops any failure that arrives without text.

The two hosts surface a failure differently. The editor host's shared boundary collects every failing outcome and raises **one** error naming each failing path with its reason, which the command turns into a user-visible error notification. The JVM host takes the first failing outcome and shows a modal error dialog naming the path and the reason — where previously nothing was reported at all.

### Literal, non-glob pathspecs

Every path this rule set hands to git is wrapped as a **literal** pathspec. A bare path is matched as a **glob**: with one file modified, asking to restore a name whose glob metacharacters happen to match it reverts a *different* file, leaves the requested one alone, and exits zero. That is an operation reporting success for a file it never touched while destroying another file's edits.

The same wrapper is applied to **staging and unstaging on both hosts** (and to the editor host's stage-the-unmerged-files step, which the JVM host has no equivalent of), because those glob identically. It is deliberately **not** applied to a caller-authored pattern — someone typing a wildcard wants the glob.

**Notable:** the rule is stated universally in the project's own prose but is not applied universally. The sites known to pass bare paths are the Memory Bank sync engine's four path batches (stage, remove, drop-from-index, reset-path), the editor host's diff-for-the-selection capability (its tracked diff against the committed tree and its untracked-file scan), and the shared path-scoped working-tree diff-stat helper the next-memory preview calls. The last two are precisely the case the rule claims to cover — a path that came out of a status read, or out of a UI row built from one — and both sit in the same modules as the wrapped staging and discard calls. The two diff sites are read-only, so a wrong glob there misstates what a preview shows rather than destroying an edit; the sync engine's batches stage and reset, so theirs do not have that consolation.

### The confirmation wording

The verb in the confirmation prompt comes from the **read-only preview query**, not from a status letter. It shares its classification with the discard itself, extracted for exactly that reason: two copies of the rule is how the rename/copy wording bug reached production in **both** hosts at once, each omitting a different letter, telling the user the file would stay while the button removed it.

Untracked, added (including copied) and renamed **delete**; a conflicted row deletes only when the committed tree lacks the path (asked of git per path, for the same reason the discard asks it); everything else **restores**.

The query is read-only — no index, worktree or ref is written — which is what lets it run **before** the user has confirmed anything. On the JVM host that means its confirmation dialog now opens from a background callback rather than directly on the UI thread.

**Notable — the fallback is narrower than both hosts' own comments claim, and an unreadable answer falls on the opposite side of the line from where they put it.** A failed status read, a blank path and a path with nothing pending all answer "does not delete" — the milder verb — **without raising**, and so does a response that parsed but carried no answer list or the wrong number of entries, which the JVM adapter reduces to an empty set. Promising a deletion that cannot be substantiated would push the user to cancel a discard that would have worked. But a body that genuinely **cannot be read** never reaches that adapter: the transport rejects an unparseable answer itself, so it propagates. The collapsed-status-letter heuristic therefore fires on exactly four things — a genuine transport or parse failure, an unreadable body, a host process that is down, and a missing runtime — not on any failure, and not (as both hosts' comments have it) on the quiet cases above.

### The letter heuristic that survives as that fallback

Each host keeps a one-letter heuristic for the throw case only. It must answer "deletes" for **untracked, added, renamed and copied**: reverting a rename deletes the new path (the content returns under the original name) and reverting a copy deletes the copy. Both hosts had shipped this wrong in opposite directions — one omitted copied, the other omitted both renamed and copied — telling the user the file stays while the button removes it.

It is wrong only for a conflicted row, and unavoidably so: the collapsed one-letter status cannot distinguish a **staged deletion** (which discard *restores*) from the conflicts whose file it *removes*, nor the conflicts it restores from the one it removes. The JVM host cannot fix that host-side under any spelling — its rows come from the IDE's own change tracker, whose change types have no conflicted case at all, so the raw columns are not even recoverable there. Falling back to a wording that is wrong for a conflicted row is nonetheless strictly better than refusing to open the dialog over a wording detail.

### Unsaved-editor flush (JVM host only)

Immediately after confirmation and **before any git call**, the requested paths' unsaved editor buffers are written to disk, on the UI thread. That host's file list is built from the IDE's change tracker, which deliberately reports a file as changed while its edits live only in the editor's document; the rule set resolves every path against a status read, which cannot see those. Without the flush the row's discard comes back as the already-in-that-state answer **with success** — so the user confirms an irreversible action, nothing happens, and nothing is shown anywhere.

**Only the requested paths are flushed.** A save-everything call is one line and writes every other unsaved editor in the project to disk as a side effect of discarding one file.

The editor host needs no equivalent: its list comes from the status read in the first place.

### Post-discard refresh

The JVM host refreshes its virtual filesystem for **every path the outcome touched** — the requested path plus any additional path reported back, distinct — before re-reading the working tree, and it does so **whether or not the discard failed**. Refreshing only the clicked path leaves a reverted rename's restored original invisible; the additional paths exist precisely because the host cannot derive that original itself. Without the refresh the row survives its own successful discard, because the change tracker is built from the virtual filesystem and the rule set changed the files behind the IDE's back — and the periodic poll does not rescue it, because that poll short-circuits on an unchanged signature computed from the same stale tracker.

The editor host instead deselects the discarded path and re-queries git. The deselect both drops the path from the selection and records it so the next refresh's default-select pass cannot re-seed it. On failure the editor host still re-queries git — a partial failure changed something — but does **not** deselect and does not refresh the status bar.

### Notable — the JVM host's worktree-root resolution changed

The helper the discard path asks for a root previously returned the **project directory unchanged**. The resolution behind it now runs a git query for the worktree root and keeps the caller's own spelling only when the two are **canonically equal** (the git answer resolves symlinks, and other surfaces compare against the project directory), falling back to the project directory when the query fails or the canonicalisation raises. The project directory is **not** the git root when the project is opened on one module of a monorepo, and every path this topic deals with is root-relative.

The query runs **once, at project initialisation**, and the answer is cached; the per-call lookup reads that cache and falls back to the project directory, which is what keeps it safe to call from the UI thread. That resolved root is also the working directory for the bridge call, the base of every join behind the virtual-filesystem refresh, and — because a pathspec is resolved against the process working directory, unlike status output — the working directory of the host's long-lived git wrapper, which is re-anchored there rather than at the project directory.

**A project with no resolvable root at all is reported as a failure** ("no repository root is available") and returns before any git call — and, because it returns early, before the virtual-filesystem refresh too. That is the one path on this host where a discard attempt ends without a refresh.

### Notable capability removal — the hosts are now asymmetric

The JVM host **lost multi-file discard entirely**: its discard-selected-files action was deleted, and its file-header action group is now present but **empty**, carrying a comment that this deliberately matches the editor host's file header, where discard is a per-row hover action only.

The editor host keeps a multi-file discard command — it previews deletions across the selection, lists the affected paths (capped, with an "and N more" tail), warns when any of them will be deleted from disk, and confirms with a single modal. It is reachable **only from the command palette**: it is declared but appears in no menu contribution, and the webview still carries a stale mapping from a file-header button id to it while that header renders **no** action icons at all. **Notable:** unlike the single-file path, the multi-file path does not deselect the discarded paths — they stay in the selection until the refresh's missing-from-the-new-list pruning drops them.

## State Transitions

```
[host: user clicks discard on a row]
  ├─ JVM host: ask the read-only preview (background) → open dialog with its verb
  │              on throw (transport / parse failure, unreadable body, host down,
  │                        no runtime) → fall back to the one-letter heuristic
  │              parsed but unusable answer → the milder verb, no raise
  └─ editor host: ask the read-only preview → confirm modal

[confirmed]
  JVM host only: flush THIS path's unsaved editor buffer to disk (UI thread)

[rule set: discard(paths)]
  anchor working directory to the worktree root (fallback: caller's directory)
  one status read, untracked directories expanded, columns kept uncollapsed
    ├─ read failed → every requested path: status-unavailable, ok = false, git's text
    └─ read ok → per requested path:
         blank path                → invalid-path, ok = false
         no entry                  → already-in-the-requested-state, ok = true
         else                      → classify: unmerged → renamed → added
                                      → untracked → staged-and-worktree → worktree-only
  run each group's operation (batched per group; renames and conflicts per path)
  return one outcome per requested path, in request order, duplicates included

[host: outcomes]
  branch on ok (never on error being non-empty); generic message when error is absent
  JVM host: refresh the virtual filesystem for every touched path (requested +
            additional, distinct) — on failure too — then re-read the working tree
  editor host: deselect the path, re-query git
```

## Notable / Surprising Behavior

- **Passing paths instead of status codes is the whole design.** It is what makes host-side divergence structurally impossible rather than merely discouraged, because nothing on the wire fails when a host's own dispatch disagrees with the shared one.
- **The already-in-the-requested-state answer is the only action that is always a success.** Every other non-operation — status-unavailable, invalid-path, unclassified — is a failure, and each operation action pairs with either. A host that treats "nothing happened" as benign re-creates the symptom this topic exists to remove.
- **Unmerged is classified first, and that ordering is the fix for a data-loss bug.** Both-added and added-by-us carry an added marker in the index column and were previously unstaged and deleted with the committed tree still holding the file, reported as a success.
- **A capitalisation-only rename revert deliberately skips its own removal.** Device and inode identity, not spelling, is what decides — and the removal it skips would otherwise delete the file the restore just wrote.
- **A repository with no commit yet takes a different unstage command**, probed once per call. Without it every discard in a pre-first-commit repository fails, since every staged file there is an addition.
- **One path can be reported twice by one status read**, and precedence — not arrival order — is what keeps the tracked row. Arrival order previously deleted the worktree copy and left the staged deletion in the index, reporting success with the row still on screen.
- **The confirmation wording is a query, not a letter, and "unreadable" is a throw rather than a shrug.** The one-letter heuristic survives only as the fallback for a query that *throws* — a transport or parse failure, an unreadable body, a host that is down, a missing runtime. A failed status read, a blank path, a clean path and a response that parsed but cannot be lined up against the request all answer the milder verb without raising. Both hosts' comments have that split, and specifically the unreadable case, the wrong way round.
- **The letter heuristic cannot be right for a conflicted row.** A staged deletion (restored) and the delete-side conflicts (removed) collapse to the same letter, and so do the restore-side conflicts and the added-by-them one. The JVM host cannot recover the columns at all.
- **The blank-path guard is defensive, and no producer is known to fire it.** It is the only thing left between a malformed message and a confirmed, irreversible click that does nothing — the host-side shape guard that used to reject such a payload validated the status columns, which stopped being an input — but the three webview producers that fall back to the empty string all read a field the host populated from a parsed status row, so its reachability is unproven rather than established.
- **The unclassified action is unreachable today** and is kept anyway, so the return needs no assertion and a future group added without a matching record fails loudly instead of claiming the path was already clean.
- **A literal pathspec is not a discard-only rule**, and is not applied everywhere it should be. Staging, unstaging and unmerged-staging on both hosts carry it; the Memory Bank sync engine's path batches, the editor host's diff-for-the-selection capability and the shared path-scoped working-tree diff-stat helper all pass bare paths — the last two on paths that came straight out of a status read, which is the case the rule exists for.
- **The JVM host's unsaved-editor flush is scoped to the requested paths**, because the obvious whole-project save writes every other unsaved editor to disk as a side effect of discarding one file.
- **The post-discard virtual-filesystem refresh runs on failure too**, and covers the additional paths a rename revert reports — which are reported even when the revert failed, because its first git call may have landed.
- **Multi-file discard now exists on only one host.** The JVM host's selected-files action was removed and its header action group is empty; the editor host's equivalent survives as a command-palette-only command.

## Shared Behavior

- **The two hosts' file lists** — the producers of the paths a request carries. One builds its list from the status read itself; the other from the IDE's change tracker, which is why only it needs the unsaved-editor flush and the virtual-filesystem refresh.
- **The bridge transport** — how the JVM host reaches the shared rule set: one mutating action and one read-only preview action, through an adapter that decides nothing beyond synthesising failures for a response it cannot line up against the request.
- **Staging / unstaging** — separate operations that share the literal-pathspec wrapper for the same reason, on both hosts.
- **The worktree-root resolution the JVM host performs** — also the working directory for its bridge calls and the anchor for its long-lived git wrapper.
- **The per-file selection the hosts hold** — pruned after a successful discard on the editor host; unrelated to the request shape, which carries paths only.
