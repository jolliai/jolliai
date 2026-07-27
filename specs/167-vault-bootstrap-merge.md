# 167. Vault Bootstrap Merge

## Topic Statement

Adopt a populated remote default branch into a brand-new local vault working tree that already carries unborn-HEAD user content by stashing every local file, force-checking out the remote, then walking the stash with a remote-wins-with-deterministic-union-merge-fallback policy before staging and committing the merged result.

## Scope

**In scope:**

- The strict trigger predicate (all five conditions C1–C5) that decides whether a fresh-local-and-populated-remote shape is present.
- The in-function race reassertion that re-checks the destructive-path conditions (unborn HEAD; no local branches) between the upstream gate and the destructive checkout.
- The four-step bootstrap pipeline: stash-every-local-file → adopt-remote → walk-stash-per-path → stage-and-commit.
- The per-path disposition decision tree (pure local addition; byte-identical no-op; aggregate-file union merge; remote-wins-local-stays-in-stash fallback).
- The reserved hidden stash directory at the vault root and the rule that its contents are never staged.
- The empty-merge commit path (working tree identical to remote → "nothing to commit" treated as success with the current HEAD as the result sha).
- The two failure shapes (race-detected; checkout-failed) and the byte-for-byte rollback that runs on checkout failure.
- The two terminal commit-failure shapes (real commit failure surfaced verbatim; "HEAD missing after empty merge" defensive failure).
- The post-merge stash-directory cleanup (empty-directory pruning) and the survivors list returned to the caller for surfacing through the canary signal.
- File-kind handling during the walk: regular files, symlinks (moved like regular files), non-file-non-symlink entries (silently ignored).
- The pre-existing-stash-dir skip during the local-file enumeration (so a stash dir left by an aborted prior run does not get re-stashed into itself).
- Cross-device-rename resilience (rename → copy+unlink fallback) on both the stash and the rollback move paths.
- Read-error policy during enumeration (`ENOENT` on the local root is swallowed; every other error and `ENOENT` from non-root reads is propagated; non-`ENOENT` errors from the stash root and the prune walk are also propagated).
- The commit-message form used by the engine-produced bootstrap commit and the author identity it carries.

**Out of scope (boundaries — what is sent/received but not re-specified here):**

- The surrounding reconciliation round (separate spec). Bootstrap merge runs only as the unborn-HEAD-with-content side branch of the branch-recovery state machine, before the round's normal pull-rebase step.
- The vault identity marker write and verification (separate spec). The marker is already in place when bootstrap merge runs; bootstrap merge does not consult it.
- The steady-state conflict pyramid (Tier 1.5 / 2.7 / 2 / 3 — separate spec). Bootstrap merge has its own remote-wins policy and shares only the aggregate-file deterministic merger as a single boundary call (Tier 1.5 logic, byte-stable, dedupe-by-primary-key, per-file tiebreak).
- The owned-path classifier (separate spec). Bootstrap merge does not classify; it stages every file under the new working tree.
- The allowlist staging used by the steady-state round (separate spec). Bootstrap merge stages with a single all-paths add and lets the next round's staging classify any surviving content.
- The deny-all `.gitignore` template and its safeguards (separate spec). Bootstrap merge depends only on the property that the hidden stash directory is gitignored.
- The per-vault write lock (separate spec). Bootstrap merge runs under the reconciliation mutex of the enclosing round but does not acquire the per-vault write lock — there is no concurrent writer to coordinate with on a vault that has just been created.
- The corrupt-JSON quarantine pass (separate spec). It runs only in the steady-state auto-reconcile path; bootstrap merge does not quarantine.
- The canary signal cap and the round-result data shape (separate spec). Bootstrap merge returns a "stashed survivors" array; the round folds it into the canary unowned bucket and truncates.

## Data Contracts

### Trigger predicate output

A discriminated union returned by the strict trigger check:

- A successful verdict (`ok: true`).
- A rejection (`ok: false`) carrying a single human-readable `reason` string. The reason names which of the five gates failed, in the form `<description> (C<N> failed)` for caller logging. The caller uses the result strictly as a yes/no — the reason is for the offline-fallback audit trail.

### Bootstrap merge inputs

The runner consumes:

- A vault git client bound to the vault working tree.
- An absolute vault root path.
- The credentials-declared default branch name.
- An author identity `{ name, email }` used on the produced commit.
- An optional log sink with `info` / `warn` methods (no `error`). When absent, all log calls are no-ops.

### Per-path report

For every path the walk touched, a record carrying:

- The relative POSIX path under the vault root.
- A single disposition from a closed enum:
  - `added-from-local` — pure local addition, no remote counterpart, restored from stash to working tree.
  - `no-op` — both sides byte-identical; stash entry discarded.
  - `aggregate-merged` — both sides are valid envelopes of an aggregate file kind; the deterministic union merger combined them; merged bytes written to the working tree; stash entry discarded.
  - `remote-wins-local-stashed` — both sides have content that differs; remote stays in the working tree; the local copy remains in the stash directory for the user to recover manually.
  - `remote-only` — defined in the closed enum but unused by the walk; remote-only paths are not visited because the walk iterates the stash (which contains only local-side content). Present in the enum for callers that switch on it exhaustively.

### Bootstrap merge result

A discriminated union:

- **Success** (`ok: true`):
  - The commit sha produced (or the current HEAD when the merge was empty and the commit was skipped as "nothing to commit").
  - The full per-path reports array, in the order the walk visited them.
  - A "stashed survivors" array — the relative POSIX paths still sitting in the stash directory after the walk completed. Same set as the paths with disposition `remote-wins-local-stashed`. Surfaced separately because the caller folds it into the round's canary unowned bucket.
- **Failure** (`ok: false`):
  - A stable code from a closed union: `race-detected`, `checkout-failed`, `commit-failed`.
  - A human-readable message. For thrown values, the message is the `.message` if present, otherwise `String(value)`.

### Hidden stash directory

A fixed-name directory at the vault root, dot-prefixed so the deny-all `.gitignore` template excludes it and so the owned-path classifier rejects everything inside it as unowned. Used as scratch space during the bootstrap and as the final resting place for the local-side copy of any path where remote-wins-local-stashed was applied.

### Commit produced

A single non-empty commit on the now-born default branch, with:

- Commit message: a one-line summary `[jolli-mb] reconcile: bootstrap merge of fresh local into populated remote`.
- Author and committer set from the caller-supplied author identity.
- Tree contents: `origin/<default>`'s tree plus any restored local additions plus any merged aggregate-file bytes.

When the merged tree happens to be byte-identical to `origin/<default>` (no pure local additions; everything either no-op or stashed), no commit is produced and the result sha is the current HEAD (which is the remote tip the checkout just adopted).

## Behavior

### Phase 0: Trigger evaluation

1. The caller (the reconciliation round, inside its branch-recovery state machine on the unborn-HEAD-with-content path) consults the strict trigger predicate. The predicate evaluates the five gates **in this order**, returning the first failure:

   - **C1** — HEAD must be unborn (no commit yet on any branch this client can see).
   - **C2** — The remote-tracking ref `origin/<default>` must exist (the remote-default has been fetched, so there is something to adopt).
   - **C3** — The working tree must be non-empty when measured with **ignored entries included**. The deny-all `.gitignore` template makes every engine-written file ignored, so a plain "porcelain" check would return empty even when the local side has real content to preserve. Without the include-ignored widening, the predicate would silently let the round proceed to a plain `checkout -B` that overwrites the ignored files.
   - **C4** — The local-branches list must be empty. Any local branch ref existing means there are stranded commits to consider, which the bootstrap path is not allowed to discard.
   - **C5** — The stash ref must not exist. A user stash means real local work the bootstrap cannot risk.

2. The "C6 = no reflog entries" check from the design is **not** a separate gate. It is folded into C1+C4+C5: with HEAD unborn and no local branches and no stash, there is no surface a reflog entry could persist on.

3. On any failure, the caller logs the verdict reason at warn level and defers to the auto-reconcile + pull-rebase path. Bootstrap merge is not invoked.

4. On success, the caller invokes the bootstrap merge runner. The reasoning is intentionally conservative — "better to under-trigger than mis-trigger". A false-negative costs at most one offline round (the next round retries from a clean state). A false-positive runs a destructive checkout against a vault with real history.

### Phase 1: Pre-flight race reassertion

5. The runner re-checks C1 and C4 immediately at entry, before any destructive step. (C2/C3/C5 were already checked upstream and are not re-checked — they cannot deteriorate into a destructive failure: C2 only gets stronger, C3 cannot turn the destructive step destructive on more content, and C5 turning true would just be a user surprise rather than a data loss vector.)

6. If `hasHead()` returns true, return `{ ok: false, code: "race-detected", message: "HEAD appeared between trigger check and stash" }`. No filesystem state has been touched.

7. If the local-branches list is non-empty, return `{ ok: false, code: "race-detected", message: "local branch appeared mid-flight: <names>" }`. No filesystem state has been touched.

8. The duplicate I/O of these re-checks is intentional: the cost of a false-positive at the destructive checkout step is real data loss; the cost of a false-negative here is one offline round.

### Phase 2: Stash every local file

9. Enumerate every regular file and symlink anywhere under the vault root, recursing into subdirectories. Two exclusions:

   - The `.git` directory at any level — moving its contents would corrupt the repo.
   - The hidden stash directory itself — a leftover from a prior aborted run must not be re-stashed into itself.

10. Other directory entries (non-file, non-symlink, non-directory) are silently skipped. Symlinks are collected and moved as-is; the steady-state staging layer's symlink defense fires later if any survives into a tracked path.

11. Read-error policy during enumeration:

    - `ENOENT` on the vault root itself is swallowed (the vault directory does not exist yet → empty file set → bootstrap proceeds with nothing to stash and the working tree fully adopting remote).
    - Any other error, including `ENOENT` on any non-root directory and any error code anywhere else, is propagated to the caller as an exception.

12. Log "stashing N local files into `<stash-dir-name>`" at info level.

13. For each enumerated relative path:

    - Compute the destination path inside the stash directory at the same relative path.
    - Create the parent directories of the destination.
    - Move the file via rename. If rename fails (cross-device, etc.), fall back to copy + unlink.

14. Per-file moves are not transactional. A failure here propagates and leaves the vault in a half-moved state — the safety story is that the runner returns success only when the full pipeline completes, and the next round's bootstrap (if the predicate still holds) is built to skip a pre-existing stash dir.

### Phase 3: Adopt remote as-is

15. Call the vault client's "checkout tracking branch" helper for the default branch. This runs the equivalent of `git checkout -B <default> origin/<default>` — destructive on the working tree but safe here because every local file is now inside the stash directory.

16. On checkout failure:

    - Log "checkout failed: `<msg>` — rolling back stash" at warn level.
    - **Rollback** the stash: for each path that **this run** moved in Phase 2, move it back to its original working-tree location, using the same rename-with-copy-fallback pattern. A path whose stash entry has already vanished is silently skipped (defensive). A pre-existing stash from a prior aborted run is **not** restored — that prior run is responsible for its own recovery.
    - Prune the now-empty stash directory recursively (so the rollback leaves no hidden directory behind).
    - Return `{ ok: false, code: "checkout-failed", message: <msg-or-string-of-throw> }`. HEAD is still unborn; the next round can retry bootstrap cleanly.

17. The rollback exists because, without it, a checkout failure would leave the vault in a confusing transient state: the canonical FolderStorage paths empty, the content relocated into the hidden stash directory, until some later round's bootstrap happens to succeed and consume the stash. The rollback makes the failure path idempotent.

### Phase 4: Walk the stash and decide per-path disposition

18. Enumerate every regular file and symlink anywhere under the stash directory, recursing into subdirectories. Non-file-non-symlink entries are silently skipped. The walk uses the same read-error policy as Phase 2's enumeration but rooted at the stash directory; an `ENOENT` on the stash root itself returns the empty set (the stash directory may not exist if Phase 2 moved zero files), while any other error is propagated.

19. For each relative path under the stash directory, decide its disposition by examining the working-tree counterpart (which now contains remote content):

    - **Working-tree counterpart absent** → pure local addition. Recreate the parent directory chain in the working tree, move the file back from the stash to the working tree, record disposition `added-from-local`.
    - **Working-tree counterpart present** → read both byte buffers and compare:
      - **Byte-identical** → discard the stash entry (unlink), record disposition `no-op`.
      - **Differ AND the path matches an aggregate-file shape** (`<repo>/.jolli/{manifest,index,branches,catalog,migration,config}.json` or the per-vault `.jolli/repos.json` — same predicate the steady-state Tier 1.5 path uses) → invoke the shared deterministic union merger with the stash bytes as "ours" and the working-tree bytes as "theirs". Three outcomes:
        - Merge succeeds → write the merged bytes to the working-tree path, discard the stash entry, record disposition `aggregate-merged`.
        - Merge returns null (parse failure, unknown envelope shape) → log "aggregate merge returned null for `<path>` — falling back to remote-wins" at warn level, fall through to the conservative case below.
      - **Differ AND not an aggregate path, OR aggregate-merge returned null** → leave remote in the working tree, leave the local copy in the stash directory, record disposition `remote-wins-local-stashed`.

20. The walk visits stash paths in filesystem-enumeration order. No total order is guaranteed across runs.

21. After the walk, prune any directories that became empty inside the stash directory (recursive bottom-up `rmdir`). When the directory's rmdir fails (e.g. EACCES on the parent), the directory is left in place and the survivors list is computed regardless — the survivors logic only counts regular files, so lingering empty directories do not produce false survivors.

22. Non-`ENOENT` read errors from the stash walk and from the prune walk are propagated as exceptions (the runner does not catch them).

23. Re-enumerate the stash directory after pruning to produce the survivors list. This is the array of paths that remained in the stash — equal to the set of `remote-wins-local-stashed` dispositions.

### Phase 5: Stage and commit the merged result

24. Stage every path in the now-merged working tree via the client's stage-all helper. The working tree at this point is `origin/<default>` plus restored local additions plus any merged aggregate-file bytes. The hidden stash directory is gitignored and so is not staged.

25. Attempt to commit with the message `[jolli-mb] reconcile: bootstrap merge of fresh local into populated remote` and the caller-supplied author identity.

26. **Commit outcomes:**

    - **Success** → record the commit sha.
    - **Failure whose message matches `nothing to commit` or `no changes added`** (case-insensitive substring) — the empty-merge case: the merged tree equals `origin/<default>`. Re-read the current HEAD:
      - If HEAD resolves to a sha → use it as the result `commitSha`. This is the same sha the checkout already moved to; bootstrap is treated as successful even though no new commit was created.
      - If HEAD resolves to null (a defensive shape that should not arise after a successful checkout) → return `{ ok: false, code: "commit-failed", message: "HEAD missing after empty merge" }`.
    - **Any other failure** → log "commit failed: `<msg>`" at warn level and return `{ ok: false, code: "commit-failed", message: <msg-or-string-of-throw> }`.

27. Log "done commit=`<sha>` reports=`<N>` stashedSurvivors=`<M>`" at info level.

28. Return success: `{ ok: true, commitSha, reports, stashedSurvivors }`.

### Phase 6: Caller handoff

29. The caller (the reconciliation round) folds the `stashedSurvivors` array into its round-result canary unowned bucket, truncated to the remaining canary cap, so the UI can surface "the local copy of these files was preserved in the hidden stash directory; you can recover them by hand". The success continues normally — the round proceeds with its usual stage/commit/push leg, which will see the bootstrap commit as a regular born-HEAD state.

30. On any bootstrap failure code, the caller logs "bootstrap merge failed (`<code>`): `<msg>` — falling back to defer" at warn level and defers to the auto-reconcile + pull-rebase path of the round's branch-recovery state machine. The failure is non-terminal at the round level.

## State Transitions

### Predicate → outcome

| Trigger gate that first failed | Outcome of `shouldRunBootstrapMerge`                 | Caller action                  |
|--------------------------------|------------------------------------------------------|--------------------------------|
| C1 (HEAD is born)              | `{ ok: false, reason: "HEAD is born (C1 failed)" }`  | Defer to auto-reconcile        |
| C2 (origin ref missing)        | `{ ok: false, reason: "origin/<b> missing (C2 …)" }` | Defer to auto-reconcile        |
| C3 (working tree empty)        | `{ ok: false, reason: "working tree empty (C3 …)" }` | Defer to auto-reconcile        |
| C4 (local branches exist)      | `{ ok: false, reason: "local branches present: …" }` | Defer to auto-reconcile        |
| C5 (stash present)             | `{ ok: false, reason: "git stash present (C5 …)" }`  | Defer to auto-reconcile        |
| none (all pass)                | `{ ok: true }`                                       | Invoke `runBootstrapMerge`     |

### Runner → outcome

| Pipeline state                                               | Outcome                                                                 |
|--------------------------------------------------------------|-------------------------------------------------------------------------|
| Race re-check sees HEAD born                                 | `race-detected` failure; no filesystem state touched                    |
| Race re-check sees a local branch                            | `race-detected` failure; no filesystem state touched                    |
| Checkout throws                                              | Rollback + prune; `checkout-failed` failure; HEAD still unborn          |
| Commit throws "nothing to commit" AND HEAD resolves          | Success with HEAD as `commitSha`                                        |
| Commit throws "nothing to commit" AND HEAD is null           | `commit-failed` failure with message "HEAD missing after empty merge"   |
| Commit throws any other error                                | `commit-failed` failure with the thrown message verbatim                |
| Commit succeeds                                              | Success with the new commit sha                                         |

### Per-path disposition

| Stash side       | Working-tree side             | Aggregate path? | Aggregate merge result | Disposition                    |
|------------------|-------------------------------|-----------------|------------------------|--------------------------------|
| present          | absent                        | n/a             | n/a                    | `added-from-local`             |
| present          | present, byte-identical       | n/a             | n/a                    | `no-op`                        |
| present          | present, differs              | no              | n/a                    | `remote-wins-local-stashed`    |
| present          | present, differs              | yes             | bytes returned         | `aggregate-merged`             |
| present          | present, differs              | yes             | null                   | `remote-wins-local-stashed`    |

The walk does not iterate working-tree-only paths, so a "remote-only" disposition is never produced even though the closed enum reserves the discriminant for callers that switch on it exhaustively.

## Notable Behavior

- **The trigger and the in-function reassertion are intentionally redundant.** C1 and C4 are checked twice (once upstream, once in the runner) because the destructive checkout cannot be undone if either gate degraded between the trigger and the destructive step. The duplicate I/O is the cost of preserving "data loss is impossible on the false-positive path".
- **C3 must use the include-ignored porcelain probe.** Plain `git status --porcelain` would return empty under the deny-all `.gitignore` template that the engine ships, even when the local side has real owned content. Without the widening, the trigger would silently skip bootstrap on a vault that needs it, and the round would proceed to a plain `checkout -B` that overwrites the ignored content.
- **A pre-existing stash directory from a prior aborted run is not re-stashed.** The Phase 2 enumeration walks the vault root recursively but skips the stash directory itself. A leftover from a prior crash lives undisturbed until either Phase 4's walk consumes it (when bootstrap retries from scratch on a vault still matching C1–C5) or the user manually removes it.
- **Symlinks are moved as plain entries.** The runner does not distinguish them from regular files during stash/restore. Any hostile symlink that survives Phase 4 (`added-from-local` of a symlink path) is caught downstream by the steady-state staging layer's symlink defence and routed to the canary, not the commit.
- **Cross-device rename is handled at both move points.** Phase 2 (stash move) and Phase 3 rollback (restore move) both use rename with a copy + unlink fallback. The copy + unlink path is exercised on systems where the vault root and the OS temp dir live on different filesystems and where the user's home is on a network mount.
- **Bootstrap merge does NOT participate in the steady-state conflict pyramid.** It has its own remote-wins policy. The only shared boundary with the pyramid is the aggregate-file deterministic merger (Tier 1.5 logic) — when both sides of a conflicting aggregate path parse as valid envelopes, the same byte-stable union merge runs here. Every other shape, including JSON files that look aggregate-shaped but whose envelope is unparseable, falls back to remote-wins-local-stashed. The Tier 2 AI merge, Tier 2.7 heuristics, and Tier 3 prompt are all bypassed.
- **The stashed local copy is the user's escape hatch.** When remote-wins applied, the local copy is not destroyed — it sits in the hidden stash directory at its original relative path. The survivors list is surfaced via the round's canary so the UI can name the affected paths; the user can manually inspect, diff, or copy back from the stash directory at their leisure. The stash directory persists across rounds (the dot-prefix gitignores it and the classifier rejects everything inside it as unowned, so no later round will ever stage or commit its contents).
- **The empty-merge "nothing to commit" path is a success, not a no-op.** The bootstrap pipeline has done real work — the checkout adopted remote, and the lack of a new commit just means the working tree was already byte-identical to remote on the local side too. The result sha is the current HEAD (the remote tip), so callers that key on `commitSha` get a sensible reference. The "HEAD missing after empty merge" branch exists as a defensive shape; in practice the checkout always lands a HEAD by the time the commit runs.
- **Rollback restores only files moved by THIS run.** If a prior bootstrap aborted and left a partial stash, this run's rollback leaves that partial stash exactly where it found it. The prior run's recovery is its own responsibility; bootstrap is intentionally not a stash-recovery tool.
- **The hidden stash directory is gitignored both by the deny-all template and by the dot-prefix segment rule.** Every segment leading with a dot is rejected as unowned by the path classifier, providing a second layer of protection against accidental staging of stashed content. The bootstrap runner does not need to write any per-clone exclude file or git-attributes; the existing `.gitignore` regime covers it.
- **Race detection is symmetric to the trigger gates.** The runner's pre-flight reassertion only re-checks C1 and C4 (the two gates whose flip would make the destructive step destructive). C2 cannot deteriorate (an existing remote-tracking ref does not vanish), and C3 and C5 flipping mid-flight is either harmless (C3) or cannot occur (C5 requires a born HEAD to create a stash, and C1 still holds).
- **`pruneEmptyDirs` failure modes are non-fatal but distinguishable.** A failed `rmdir` (EACCES, etc.) leaves the directory in place and continues; a failed `readdir` with a non-`ENOENT` code propagates to the caller. The asymmetry is intentional: an empty directory left behind is cosmetic noise, but a read error in the middle of the walk indicates a real I/O fault the caller should know about.
- **Per-path reports preserve walk order, not lexicographic order.** Tests rely on lookup via a `Map`, not on a stable index. Callers should not depend on the array being sorted.
- **The stash directory's name is `BOOTSTRAP_STASH_DIRNAME`** — a fixed, dot-prefixed identifier (`.jolli-bootstrap-stash`) coordinated with the deny-all `.gitignore` template so the template author can audit that the entry exists. Renaming the directory would require updating the template.

## Shared Behavior

- **Aggregate-file deterministic union merger.** The same merger used by the steady-state Tier 1.5 conflict resolution path is invoked during the bootstrap walk for paths that match the aggregate-file shape predicate. Byte-stable across devices (dedupe by primary key, per-file tiebreak, sort for stable output). See sync-engine reconciliation spec for the merger's semantics; bootstrap is one of its two call sites.
- **Hidden-stash-directory gitignore property.** The deny-all `.gitignore` template (separate spec) is what makes the stash directory invisible to staging. Bootstrap merge does not author the template; it only depends on the invariant.
- **Owned-path classifier rejecting dot-prefixed segments.** Bootstrap merge depends on the classifier returning null for anything under a dot-prefixed segment (separate spec). This is the second layer of stash isolation; without it, a future round's staging could inadvertently include stashed content.
- **Reconciliation round's branch-recovery state machine.** Bootstrap merge runs as one side branch of the unborn-HEAD-with-content state in that machine (separate spec). The round invokes bootstrap merge synchronously inside the branch-recovery phase, before the round's normal pull-rebase step; the bootstrap commit becomes the round's first committed state and the pull-rebase below it sees a born HEAD.
- **Round-result canary unowned bucket.** The bootstrap survivors list flows into the canary array under a small per-round cap (separate spec). The UI consumes the canary; bootstrap merge does not render anything itself.
- **Commit message prefix `[jolli-mb] <op>: <summary>`.** Bootstrap merge produces one commit whose `<op>` is `reconcile` and whose `<summary>` is the fixed string "bootstrap merge of fresh local into populated remote". The same format is consumed by the backend mirror that reads the orphan history; format changes would require coordinated backend updates.
