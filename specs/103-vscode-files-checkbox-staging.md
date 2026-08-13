# VS Code Changes Tab Per-File Selection

## Topic Statement

A UI-only set of repository-relative paths that records which files the user has checked in the Changes tab, kept entirely separate from the git index so the user's selection survives every file-system or index change until the next AI Commit, at which point the selection is the authoritative input to staging.

## Scope

**In scope:**
- The data shape that backs the per-file selection (a set keyed by repository-relative path).
- How the selection interacts with the live file list returned by the underlying repository status query.
- The single direction of authority: the in-memory selection set is the truth; the IDE TreeItem checkbox state is derived.
- The mapping of git porcelain status codes to the row's left-glyph (M/A/D/R/U/C/I/?), and how each code influences row click behavior. The code does **not** influence discard — see the note under the mapping table.
- The folder-grouping the Changes tab presents and the per-folder expand/collapse persistence within the webview's lifetime.
- The "N selected" count surfaced to the toolbar and status bar.
- The debounced refresh path that keeps the file list current across rapid file-system or index events without losing selection.

**Out of scope:**
- The AI Commit flow itself — staging at commit time, message generation, hook orchestration. This topic owns the **selection input**; the commit flow owns what to do with it.
- The exclude filter implementation. Its existence is honored here (selected paths that become excluded are pruned), but the pattern set is owned elsewhere.
- The discard action's destructive semantics — the path-only request shape, the single status read every path is resolved against, the classification and per-path operations, the outcome actions, and the read-only query that words the confirmation prompt. Owned by the working-tree-file-discard topic. This topic notes only that selection prunes after discard.
- The Branch tab's plans/notes/commits surfaces.

## Data Contracts

### The selection set

A set of strings, each a repository-relative path with forward-slash separators, held in extension-host memory by the Files store for the lifetime of the IDE window. The set is empty on activation and is mutated by:

| Mutator                                | Source                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Single-row checkbox toggle             | The webview's per-row checkbox click — the host applies it to the set directly via a checkbox-batch helper without a command roundtrip. |
| "Select all" toolbar action            | Adds every currently-visible (post-exclude) file's path to the set, or clears it if all visible were already selected.                  |
| Programmatic deselect                  | Called after a successful discard with the discarded paths, and after the exclude filter changes (paths that became excluded are pruned). |
| Refresh-time pruning                   | After every fresh file-list query, paths that are no longer present in the new list are removed from the set.                            |

### Snapshot shape

The Files store broadcasts a snapshot on every change. Consumers (the tree-data provider, the sidebar webview adapter) read these fields:

| Field           | Meaning                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `files`         | Full ordered list after merging the selection set onto the raw file list and applying the stable-order cache. |
| `visibleFiles`  | `files` filtered by the exclude predicate.                                                                    |
| `selectedFiles` | `selectedAndVisible(files)` — the input that AI Commit consumes. An excluded selected file can never reach commit even if it was selected before the pattern was added. |
| `excludedCount` | Count of files hidden by the exclude filter.                                                                  |
| `visibleCount`  | `visibleFiles.length`.                                                                                        |
| `isEmpty`       | True when `files.length === 0`.                                                                               |
| `isMigrating`   | True while a one-shot legacy-data migration is running.                                                       |
| `isEnabled`     | The JolliMemory enabled flag for this repository.                                                             |
| `changeReason`  | One of `init` / `refresh` / `selectAll` / `userCheckbox` / `excludeFilter` / `migrating` / `enabled` / `deselect`. |

The change reason exists so consumers can opt out of expensive rebuilds for benign mutations. The webview does not opt out of any reason — it pushes a fresh snapshot on every change so the disabled state of toolbar buttons (which depends on `selectedFiles.length`) stays in sync.

### Stable display order

A path-to-index map is recomputed after every snapshot rebuild and used as the prior order on the next refresh. Files known from the previous snapshot keep their original positions; newly seen files are appended in the order the underlying status query returned them. This prevents the list from reshuffling on every working-tree change.

The order is reset only on:
- Explicit `refresh(reorder = true)` calls (the manual Refresh button).
- Disable (the order map is cleared along with the rest of the cached state).

### Status code mapping

Each row carries a single status code character extracted from the underlying repository status query. The protocol surfaces it as the `gitStatus` field on the serialized row. Codes used and their behavior:

| Code | Meaning            | Click action                                                                          |
| ---- | ------------------ | ------------------------------------------------------------------------------------- |
| `M`  | Modified           | Open a side-by-side diff: `HEAD` vs working tree.                                     |
| `A`  | Added (staged-new) | Open the working-tree file directly (no `HEAD` version exists).                       |
| `D`  | Deleted            | Open the `HEAD` version read-only.                                                    |
| `R`  | Renamed            | Side-by-side diff: previous path at `HEAD` vs current path in working tree.           |
| `?`  | Untracked          | Open the working-tree file directly.                                                  |
| `U`  | Unmerged           | (Standard diff or open path; consumers gate on the code.)                             |
| `C`  | Copied             | Standard diff path.                                                                    |
| `I`  | Ignored            | Standard open.                                                                         |

**The status code no longer influences discard at all.** The row's discard sends the row's repository-relative path and nothing else; the wording of its confirmation prompt comes from a separate read-only query, and the operation performed comes from a status read the discard rule set takes itself. Two consequences for this table: it has no discard column, and the code is not what decides between "discard all changes to this file" and "permanently delete this file from disk".

The delete-wording set is also wider than a `?` / `A` / `R` rule would give: a **copy** revert deletes the copy, and a **conflicted** row's file is deleted whenever the committed tree has no version of it — while a *staged deletion*, which also arrives as `D` here, is **restored**. A collapsed one-letter code cannot express that split, which is exactly why the wording is queried rather than derived. The one-letter rule survives on this surface only as the fallback for a query that *throws*, and it covers `?`, `A`, `R` **and** `C`.

### Folder grouping

The Changes tab groups its files into the conventional folder rows the webview renders. Folder rows have the same expand/collapse affordance that the IDE's tree-style views use — the webview persists each folder's open/closed state for the duration of the webview's lifetime. The selection set is path-keyed and indifferent to folder rows: collapsing a folder does not deselect its files; expanding it does not auto-select.

### "N selected" badge

The Changes section header surfaces the count of selected files as part of the section title. The count is the size of `selectedFiles` (i.e. selected ∩ visible) — a file selected but later hidden by the exclude filter does not contribute. The same count drives the Toolbar disabled-state of the AI Commit button (disabled when the count is zero).

## Behavior

### Toggle path

1. The user clicks a row's checkbox in the webview.
2. The webview posts the typed `branch:toggleFileSelection { filePath, selected }` message to the host.
3. The host calls `applyCheckboxBatch([[filePath, selected]])` on the Files store directly — bypassing the command surface so rapid clicks don't race a command pipeline.
4. The store mutates the selection set, rebuilds the snapshot with `changeReason = userCheckbox`, and emits.
5. Every consumer (the webview adapter, the status bar) receives the new snapshot. The webview pushes a fresh `branch:changesData` payload back so its toolbar disabled-state and the "N selected" count update.

The toggle never touches the git index. The IDE's checkbox visual is rendered by the webview from the snapshot's `isSelected` boolean — it is never read back.

### Refresh path

The Files store keeps two file-system watchers active for the workspace lifetime:

- A watcher on `.git/index` — fires on stage/unstage performed by the IDE's git surface, the command line, or any other tool.
- A workspace-wide watcher that fires on any working-tree change except paths under any `.git/` directory.

Both watchers schedule a debounced refresh (a single trailing-edge timer with a 400 ms delay; subsequent events within the window reset the timer). The refresh:

1. Increments a sequence counter and starts an underlying file-list query through the bridge.
2. When the query returns, drops the result if the sequence counter has advanced (a newer refresh already started).
3. Otherwise, prunes paths from the selection set that are no longer in the new list.
4. Replaces the cached raw list, rebuilds the snapshot (default `reorder = false` keeps the stable-order cache; the manual Refresh button passes `reorder = true`), and emits.

A refresh that arrives while the user is mid-click does not wipe the selection — the merge-with-selection step re-overlays the in-memory set onto the new list so even files whose underlying status changed (M → A, etc.) keep their checked state if the path matches.

### Select-all toggle

The select-all command flips the selection by visibility:

- If `visibleFiles` is non-empty and every visible file is currently selected, the set is cleared (uncheck-all).
- Otherwise, every visible file is added to the set (check-all).

Files hidden by the exclude filter are never added by select-all and are never removed by uncheck-all — the operation acts only on what the user can see.

### Exclude-filter change

When the user edits the exclude pattern set:

1. The host loads the new patterns.
2. The Files store calls `applyExcludeFilterChange()`, which prunes any selected path that the new pattern set excludes, then rebuilds the snapshot with `changeReason = excludeFilter`.
3. The bridge is **not** re-queried — only the visibility split and the selection-prune are recomputed.

This guarantees an excluded file can never reach the commit input even if the user selected it before adding the pattern.

### Discard

Discard is destructive and runs through the bridge. The store's role is post-discard cleanup:

- After a successful single-file discard, the Files store is told to deselect that exact path and refresh.
- After a successful multi-file discard ("Discard All" on the selected subset), the store refreshes from scratch — the missing-from-new-list pruning rule clears the selection naturally.

### Disable

When JolliMemory is disabled for the repository, the Files store flips its enabled flag and:

- Clears the cached raw list, the selection set, and the order map.
- Rebuilds the snapshot with `changeReason = enabled`.

The webview shows the disabled placeholder; the AI Commit button is disabled regardless of selection because the snapshot's `isEnabled` is false. Re-enabling triggers a fresh bridge query and the order map is rebuilt from the new list.

## State Transitions

```
[Initial]
selection = ∅, rawFiles = [], orderMap = {}, isEnabled = true

[user toggles a row]
  selection ← selection ⊕ path
  emit(reason = userCheckbox)

[select-all]
  if every visible was selected: selection ← selection − visiblePaths
  else: selection ← selection ∪ visiblePaths
  emit(reason = selectAll)

[debounced refresh]
  rawFiles ← bridge.listFiles()
  selection ← selection ∩ {p | p in rawFiles}
  rebuild order from prior map (known files keep order, new files appended)
  emit(reason = refresh)

[explicit refresh button]
  same as above with order map reset (reorder = true)

[exclude-filter change]
  selection ← selection − {p | excluded(p)}
  emit(reason = excludeFilter)

[discard single (path p)]
  bridge.discardFiles([p])
  selection ← selection − {p}
  refresh()

[discard selected]
  bridge.discardFiles(selectedAndVisible)
  refresh()  -- pruning rule clears the selection naturally

[disable]
  rawFiles ← []
  selection ← ∅
  orderMap ← {}
  emit(reason = enabled)
```

## Notable Behavior

- **The selection survives index changes.** A user who has selected `foo.ts` and then runs `git add foo.ts` from the command line still sees `foo.ts` selected after the next debounced refresh. This is the GitHub-Desktop staging model: the index is touched only at commit time.
- **The selection is pruned, not erased, on refresh.** A path that disappeared from the underlying status (e.g. the user reverted the change in another tool) is dropped from the selection silently; paths still present keep their checked state.
- **Selection is the authority, not the IDE checkbox visual.** Even though IDE TreeItem instances carry a tri-state checkbox enum, the snapshot exports a flat `isSelected` boolean derived from the in-memory set so the webview never needs to interpret the IDE's enum.
- **Order persistence is by-design.** Without it, every working-tree change would reshuffle the row order. The price is that newly-introduced files appear at the bottom rather than wherever a sort would put them, which is acceptable: the user's mental map of the list stays stable across saves.
- **Selection is bounded to visible files at commit input.** `selectedFiles` is the intersection with `visibleFiles`. A pre-selected file that becomes excluded never leaks into a commit, even if the user has not unchecked it.
- **A refresh in flight is invalidated by a newer refresh.** The sequence counter discards stale bridge results so the snapshot always reflects the most recent query, not a query that resolved out of order.
- **The watcher excludes anything under a `.git/` directory** (any path containing the segment `/.git/` or its Windows equivalent). The dedicated `.git/index` watcher handles the only path under `.git/` that this surface cares about.
- **Disable wipes the order map.** Re-enabling rebuilds it from the next bridge query rather than carrying a stale order across the disable boundary.

## Shared Behavior

- **AI Commit flow** — the consumer of `selectedFiles`. Stages exactly that subset and runs the LLM message-generation step.
- **Discard action** — the destructive operation that prunes the selection after success. It takes paths only; neither the row's status code nor its raw porcelain columns reach it, and the wording of its prompt is a separate read-only query rather than a function of the code this topic maps.
- **Exclude filter** — the pattern set whose changes prune the selection and shrink `visibleFiles`.
- **Repository status query** — the producer of the raw file list and the porcelain status codes.
- **Sidebar message protocol** — the route the toggle messages flow through.
- **Status bar / AI Commit toolbar button** — consumers of the "N selected" count.
- **Worker-lock guard** — the pre-flight check that aborts AI Commit if the post-commit summary worker is busy; orthogonal to selection.
