# VS Code Commits Tab Dual Mode (Normal / Merged / Single / Empty)

## Topic Statement

The Commits tab presents the current branch's commits in one of four modes — multi-commit (the default, between the merge-base and HEAD), single-commit, merged-history (the branch has been fully merged into the configured main and the view shows a read-only filter of the user's own commits since the branch was created), and empty — with the mode and the resulting per-commit metadata computed once per refresh and shipped to the webview as a single payload.

## Scope

**In scope:**
- The four modes the Commits tab supports and the predicate that selects each.
- The base-ref resolution priority used to find the comparison point against main.
- The merged-mode trigger and the inputs it consults: branch creation point via reflog, and the current git author for filtering.
- The per-commit fields the tab carries (hash, short hash, message, author, date, change stats, push status, summary-presence flag, optional commit-type tag).
- The lazy load of each commit's file children with promise-deduped concurrent requests, and the order-of-arrival cache.
- The range-checkbox semantics and the selection set the squash command consumes.
- The mode tag pushed alongside every commit-list payload (`multi` / `single` / `merged` / `empty`) and the read-only-history label the webview shows in `merged` mode.

**Out of scope:**
- The squash command itself — it is a consumer of the selection set.
- The push command and its base-ref resolution — only the per-commit `isPushed` flag is shipped here.
- The AI summary panel and the recall-prompt flow — they consume `hasMemory` to decide whether to expose the View Memory affordance, but their content is owned elsewhere.
- The bridge's storage-layer details — the index entry that drives `hasMemory` is owned by the storage topic.

## Data Contracts

### Modes

| Mode      | Predicate                                                                                                                                 | UI consequences                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `empty`   | Zero commits returned.                                                                                                                    | Section renders its empty placeholder; checkboxes hidden.                                |
| `single`  | Exactly one commit returned.                                                                                                              | Checkbox hidden; row gets a commit-glyph icon. The Squash affordance only makes sense with two or more commits, so it is gated off in this mode. |
| `merged`  | The branch's merge-base against the resolved main ref equals the current HEAD (i.e. the branch has been fully merged).                    | Section header reads "merged — read-only history"; checkboxes hidden; every row is treated as already pushed. |
| `multi`   | More than one commit and not merged.                                                                                                      | Standard row rendering with checkboxes; range-selection rules apply.                      |

The modes are mutually exclusive: `empty` wins if there are no commits; `merged` wins when the branch is fully merged and produced any commits; `single` is reserved for the literal one-commit case in the non-merged path.

### Comparison base-ref priority (normal mode)

The "between merge-base and HEAD" base ref is resolved by trying these candidates in order and taking the first that exists:

1. `origin/<mainBranch>`
2. `upstream/<mainBranch>`
3. `<mainBranch>` (local)

The default `<mainBranch>` is `main` and can be reconfigured by callers. Preferring the remote refs avoids showing commits already on the remote main as part of the current branch's history when the local main has fallen behind.

### Merged-mode trigger

The check for merged mode is: with the resolved base ref, find the merge-base of `HEAD` and the base ref. If the merge-base equals the current HEAD hash, the branch is fully merged. The view then transitions into merged mode by:

1. Asking the reflog for the branch's creation point (see below). If unavailable, the view collapses to `empty`.
2. Asking git for the current user's name (`user.name` from the active config). If unavailable, the view collapses to `empty`.
3. Replacing the merge-base with the creation-point hash.
4. Adding an `--author=<currentUserName>` filter to the underlying log query, paired with `--fixed-strings` so a `user.name` containing regex metacharacters (`J. Doe (Acme)`) is matched as a literal substring rather than a regex. (`--fixed-strings` is global, so it stays safe only while `--author` is the sole pattern operand — there is no `--grep` here.)

The intent is "show me my commits on this branch since I created it, even though it's been merged into main". Other contributors' commits are filtered out so the view does not balloon to the full history of the merged-into branch.

### Branch creation point (merged mode only)

The reflog for the branch is read with `reflog show <branch> --format=%H %gs`. The lookup walks the entries from oldest to newest:

- The first entry whose subject contains "branch: Created from" wins; its hash is the creation point.
- If no such entry exists (e.g. the reflog has expired, or the branch was created without a reflog write), the **oldest** entry's hash is used as a fallback.
- If the reflog itself is empty, merged mode is abandoned and the view collapses to `empty`.

### Per-commit fields

Every row carries:

| Field        | Source                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `hash`       | Full commit hash.                                                                                                                            |
| `shortHash`  | First 7 characters of `hash`.                                                                                                                |
| `message`    | Commit subject (the underlying log uses `%s`).                                                                                                |
| `author`     | Author name.                                                                                                                                 |
| `authorEmail`| Author email.                                                                                                                                |
| `date`       | ISO 8601 author date.                                                                                                                        |
| `shortDate`  | `MM-DD` formatted (zero-padded).                                                                                                             |
| `topicCount` | Pulled from the per-commit AI-summary index entry when available; zero otherwise.                                                            |
| `insertions` / `deletions` / `filesChanged` | Pulled from the cached diff stats on the index entry; falls back to `git diff --stat` per commit when the index entry is missing the stats. |
| `commitType` | Optional tag (e.g. "amend", "interactive") read from the index entry; absent on commits without one.                                          |
| `isPushed`   | True iff merged mode (every commit is treated as pushed) **or** the commit hash is in the set of hashes between the configured push base and HEAD that the underlying log says are already on the remote. |
| `hasMemory`  | True iff the AI-summary index has an entry for this commit hash.                                                                             |

A background pass scans commits whose hash is not in the index for tree-hash aliases (cross-branch matches by tree identity) and logs a hint that a panel refresh is recommended when new aliases are found. The current refresh's payload is unaffected — the next user-driven refresh picks up the alias.

### Push base ref (normal mode)

The "isPushed" computation needs a separate base ref that represents "what the current branch already has on its remote". The priority is:

1. The current branch's `@{upstream}` (its configured upstream).
2. `origin/<currentBranch>` (the conventional remote-tracking ref of the same name).
3. None — when neither exists, every commit is reported as not pushed.

Merged mode skips this computation entirely and reports every commit as pushed.

### Selection set and snapshot

The Commits store keeps:

| Field             | Meaning                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `commits`         | Newest-first ordered list of the per-commit records above.                                                                           |
| `selectedHashes`  | The set of hashes the user has range-checked.                                                                                        |
| `selectedCommits` | `commits.filter(c => selectedHashes.has(c.hash))` — the input that the squash command consumes.                                       |
| `isMerged`        | The mode-decision result for this snapshot.                                                                                          |
| `singleCommitMode`| True when `commits.length === 1`.                                                                                                    |
| `isEmpty`         | True when `commits.length === 0`.                                                                                                    |
| `isEnabled`       | The repository's enabled flag.                                                                                                       |
| `isMigrating`     | True while a one-shot legacy-data migration is running.                                                                              |
| `changeReason`    | One of `init` / `refresh` / `userCheckbox` / `selectAll` / `enabled` / `migrating` / `mainBranch`.                                    |

### Per-commit file children

Each commit row is collapsible. Its children are file rows describing the commit's changes:

| Field          | Meaning                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `commitHash`   | The parent commit's hash, repeated on each child for the host's structural-shape rebuild on click.                    |
| `relativePath` | Repository-relative path of the file at this commit.                                                                  |
| `statusCode`   | `M` / `A` / `D` / `R`.                                                                                               |
| `oldPath`      | Optional, populated only for renames.                                                                                |

The list is fetched lazily through a per-commit cache: the first request for a hash starts an underlying file-list query and stores the **promise**; subsequent requests for the same hash before it resolves return the same promise (request dedup). The cache is cleared when the commit-hash sequence changes between two refreshes.

## Behavior

### Refresh

1. Capture the previous commit hash sequence.
2. Ask the bridge for the branch commits with the configured main branch.
3. Replace the cached commits and the `isMerged` flag with the result.
4. If the hash sequence changed: clear the per-commit file cache and clear the selection set.
5. Rebuild the snapshot and emit.

The "sequence changed" predicate is order-sensitive and length-sensitive: any difference (new commit, removed commit, reordered hashes) clears the cache.

### Mode decision (inside the bridge call)

```
branch = current branch
baseRef = first(origin/main, upstream/main, main) that exists
mergeBase = git merge-base HEAD baseRef
if mergeBase == HEAD:
    creation = findBranchCreationPoint(branch)        # via reflog
    if creation == None: return empty
    author   = git config user.name
    if author == None:   return empty
    mergeBase = creation
    isMerged = true
    logFilter = --author=author
else:
    isMerged = false
    logFilter = (none)
commits = git log mergeBase..HEAD <logFilter> ...
if commits == []: return empty (force isMerged = false)
return commits, isMerged
```

The post-log empty-check forces `isMerged = false` so a brand-new branch that has not diverged from main does not get the "merged — read-only history" label.

### Range-checkbox semantics

A click on the checkbox of the commit at index `N` (counted from HEAD = 0):

- **Check** flips on the commit at `N` and every newer commit (indices `0..N` inclusive). Selecting an older commit drags every commit between it and HEAD into the selection.
- **Uncheck** flips off the commit at `N` and every older commit (indices `N..end`). Unchecking propagates downward toward the merge-base.

The intent is the squash semantic: a user who clicks "I want this commit included" is implicitly opting into every commit on top of it; un-clicking removes it and everything beneath it.

### Mode propagation

The webview is told the current mode by the `mode` field on every `branch:commitsData` push (separate topic). Modes affect rendering:

- `single` and `merged` suppress checkboxes; the snapshot's `selectedHashes` is therefore irrelevant in these modes.
- `merged` adds the "merged — read-only history" header label.
- `empty` shows the empty-state placeholder.

The single-commit mode sets a context key (`jollimemory.history.singleCommitMode`) that command-palette `when` clauses can gate on. The merged-mode sets `jollimemory.history.mergedMode` similarly. The empty state sets `jollimemory.history.empty`.

### File children expand

When a commit row is expanded, the host serializes its file children inline as part of the commits payload. The serializer:

1. Asks the per-commit cache for the file list (request dedup if a concurrent expand is already in flight).
2. On success, attaches the file rows under the parent row's `children`.
3. On failure (single commit's file fetch raised), drops the children but keeps the parent row in the payload — the rest of the list still renders.

### Disable

Disabling clears the cached commits, the selection set, the per-commit file cache, and resets `isMerged`. Re-enabling triggers a fresh refresh and the merged-mode predicate re-evaluates from scratch.

## State Transitions

```
[refresh starts]
  prevHashes = current commit hashes

[bridge returns]
  case empty result:                        → mode = empty,   isMerged = false
  case fully-merged + creation found:       → mode = merged,  isMerged = true,  filter = --author=user
  case fully-merged + creation missing:     → mode = empty,   isMerged = false
  case normal + commits.length == 0:        → mode = empty,   isMerged = false  (force: brand-new branch)
  case normal + commits.length == 1:        → mode = single,  isMerged = false
  case normal + commits.length >= 2:        → mode = multi,   isMerged = false

[hash sequence changed?]
  yes: clear file cache; clear selection set
  no:  preserve both

[checkbox toggled at index N]
  if check:   selection ← selection ∪ {hashes[0..N]}
  if uncheck: selection ← selection − {hashes[N..end]}

[disable]
  commits ← [], selection ← ∅, file cache cleared, isMerged ← false

[main branch reconfigured]
  refresh re-runs end-to-end (new base ref, new mode decision)
```

## Notable Behavior

- **The merge-base check uses commit-hash equality, not ancestry.** "Fully merged" here means literally `merge-base(HEAD, base) == HEAD`. A branch that has merged most of itself but has new commits beyond the merge will fail the equality and stay in normal mode.
- **The reflog fallback is the oldest entry, not nothing.** A branch whose explicit "Created from" entry has aged out of the reflog still lands in merged mode using the oldest visible entry as a creation proxy. This avoids degrading to empty for older branches whose reflog is sparse.
- **Merged mode filters by author name (string), not author email.** Users whose `user.name` differs across machines (or who reconfigure it) will see different "merged-mode my-commits" sets on different machines.
- **A merged branch with zero commits between creation and HEAD shows as empty, not merged.** This handles brand-new branches that branched from main and have not diverged yet — they would otherwise spuriously show "merged — read-only history" because their merge-base is HEAD.
- **The push-base resolution is independent of the history-base resolution.** The history view compares against `origin/main` (or fallbacks); the per-row `isPushed` flag compares against the branch's own upstream (or `origin/<branch>`). A user whose `main` is stale but whose feature branch tracks correctly still sees accurate per-row push state.
- **Tree-hash alias scanning is a background pass with no impact on the current payload.** When new aliases are found the host logs a hint; the next user-driven refresh picks them up. This keeps the refresh latency-bounded without making the user wait on cross-branch scanning.
- **The per-commit file cache is keyed by hash and lives until the sequence changes.** A commit that is amended in place (rebased, etc.) gets a new hash, so its old cache entry is dropped on the next refresh's sequence-change check. There is no cross-branch sharing.
- **The change-reason `userCheckbox` does fire `onDidChangeTreeData`** unlike the Files store. The pre-existing UX already fires on single-click range-checks and the cost of re-rendering checkbox rows is acceptable; the simpler invariant (every reason emits) is preserved here.
- **The `isMerged` and `singleCommitMode` flags are independent of the protocol's `mode` tag** — the snapshot exposes the underlying flags so other host-side consumers can read them without parsing the mode string. The mode tag is the webview's compact view.

## Shared Behavior

- **Squash command** — consumer of `selectedCommits`; only meaningful in `multi` mode.
- **Push command** — consumer of the per-commit `isPushed` flags and the same upstream-resolution rules.
- **AI summary index** — producer of `topicCount`, `commitType`, cached diff stats, and the boolean `hasMemory`.
- **Sidebar message protocol** — the channel that ships `branch:commitsData` with the mode tag and the per-commit fields.
- **Branch watcher / HEAD watcher** — the trigger for refresh on branch switch.
- **Worker-lock watcher** — refreshes the Commits tab when the post-commit summary worker releases its lock so freshly-arrived `hasMemory` flags appear without a click.
