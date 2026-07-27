# IntelliJ Changes Panel

## Topic Statement

The CHANGES section of the JolliMemory tool window — a per-row list of working-tree files reported by a NUL-separated, rename/copy-aware `git status` (with untracked files listed individually inside new directories), each row carrying a checkbox (selection input for the AI-commit flow), a colored single-letter status badge, the filename, the parent directory in a muted color, a hover-only discard glyph, and a single-click that opens the IDE's diff viewer for the file.

## Scope

**In scope:**
- The data the panel renders: the list of changed files (modified, added, deleted, renamed/copied, untracked, unmerged) returned by the NUL-separated, rename/copy-aware `git status` for the project's repository, with untracked files inside a newly-added directory listed individually rather than as one directory row.
- The per-row anatomy: checkbox, file-type icon, filename in status color, parent directory in gray, status badge, hover-only discard glyph.
- The mapping of porcelain status codes to display letters (`M`, `A`, `D`, `R`, `U`) and colors.
- The "untracked → U" relabel: porcelain returns `??` for untracked, the panel displays `U` to match the user-facing convention used throughout the product.
- The in-memory selection that is the input to AI commit (the panel's checkboxes own this state; nothing else does).
- The auto-refresh sources: working-tree changes outside `.git/`, and IDE-side git repository changes (commit, branch switch, index update).
- The single-click opens-diff behavior, with three branches by status: side-by-side `HEAD` vs working tree, working-tree-only open, and `HEAD`-content read-only view.
- The hover-only discard action and its three-branch destructive semantics.
- The "no changes" empty state and the disabled-project / initializing placeholders.
- Refresh debouncing and stale-result discard via a monotonic version counter.

**Out of scope:**
- The AI-commit flow itself (how selected files are staged and a commit message generated) — separate spec.
- The exclusion-pattern filter that some surfaces use to hide files — not enforced in this panel; every porcelain row is shown.
- The Branch / Plans / Memories / Commits sections of the tool window.
- The folder-grouping rendering style (this panel is flat, one row per file).
- The "select all" and "clear all" toolbar actions in detail (only their data effect on the in-memory selection is described here).

## Data Contracts

### Source query

The panel reads from **two** sources, in a first-then-fallback order:

1. **The IDE's own change tracker, first.** Each refresh asks the IDE's change-list manager for its current change set plus its unversioned-file set, relativizes each path against the repository root, and maps the IDE's change types onto the same single-letter status codes the git path emits (so downstream consumers — commit staging, discard, status badges — behave identically whichever source produced the row). The rows are sorted by path so the panel's de-duplication signature is stable against the manager's unordered collections.
2. **The porcelain `git status` path, as fallback.** An **empty** result from the change tracker is deliberately treated as "has not populated yet", not as "clean", and falls through to git. At startup and briefly after a VCS refresh the manager returns empty collections before its first update completes, so trusting that emptiness would flash "no changes" over a dirty tree. The cost of the conservative choice is one extra cheap `git status` per poll tick on a genuinely clean tree.

The consequence worth stating: the panel now reflects **unsaved in-editor edits**, because the IDE's change tracker sees the document model, not just the disk. A file modified in an editor and not yet saved appears as a change here.

**Unsaved ignore-rule files are flushed before every read.** Each poll tick and each debounced refresh first writes out any unsaved editor buffer for the repository's ignore files (the tracked ignore file and the local per-repository exclude file). Without that flush, a user who has just typed a new ignore pattern but not saved would keep seeing files the rule already excludes, because both the change tracker and `git status` read the on-disk rules.

### Porcelain fallback details

The fallback path is the project service's "list changed files" call. Underneath it runs `git status` in **NUL-separated porcelain-v1** form with untracked files listed **individually inside newly-added directories** (rather than collapsed into one directory row), against the repository working tree, mirroring the VS Code bridge's flags. The NUL-separated output is parsed segment-by-segment:

- Each entry segment begins with a two-character code (index column, worktree column) followed by a space and the path.
- A rename/copy entry (index column `R` or `C`) carries the **original path in the following NUL segment**, which the parser consumes and discards.
- A directory-shaped segment (path ending in `/`) is skipped — the list is files-only.

Each returned row carries:

| Field            | Meaning                                                      |
| ---------------- | ------------------------------------------------------------ |
| `relativePath`   | Path relative to the repository root, forward-slash separated. For a rename/copy this is the new/destination path. |
| `statusCode`     | A **single resolved status letter**: the index column when it is neither blank nor `?`, otherwise the worktree column. So an untracked file resolves to the worktree column character. |
| `isSelected`     | Boolean; the checkbox state on first render (from the project service's selection memory). |

### Per-row layout

A horizontal row, top-down:

| Position           | Element                                                              |
| ------------------ | -------------------------------------------------------------------- |
| Far left           | Checkbox.                                                            |
| Left of filename   | File-type icon (resolved by the IDE from the filename's extension). |
| Left-leading text  | Filename in the status color.                                        |
| Trailing left      | Parent directory + `/` in gray, slightly smaller font, allowed to truncate. |
| Far right (always) | Status badge: a single colored letter with a tooltip naming the status. |
| Far right (hover)  | Discard glyph (a "revert" icon), shown only while the mouse is over the row. |

Row height is constrained so the surrounding box-layout cannot stretch rows apart.

### Status code mapping

Each porcelain status maps to a display letter, a color, and a tooltip:

| Porcelain | Display | Color (hex) | Tooltip          |
| --------- | ------- | ----------- | ---------------- |
| `M`       | `M`     | `#C08020` (yellow/orange) | "Modified"       |
| `A`       | `A`     | `#20A040` (green)         | "Index Added"    |
| `??`      | `U`     | `#20A040` (green)         | "Untracked"      |
| `D`       | `D`     | `#C02020` (red)           | "Deleted"        |
| `R`       | `R`     | `#6A9FD6` (blue)          | "Renamed"        |
| `C`       | `C`     | `#6A9FD6` (blue)          | "Copied"         |
| `U`       | `U`     | `#C02020` (red)           | "Unmerged"       |

The `U` color is **conditional on porcelain code, not on display letter**: untracked files (porcelain `??` → display `U`) render green; unmerged files (porcelain `U` → display `U`) render red. The two are distinguished by tooltip.

### Selection

A list-aligned array of checkbox states held in panel memory. The "selected files" output that the AI-commit flow consumes is a derived view: the subset of the latest row list whose corresponding checkbox is checked.

**That array must be a concurrency-safe, snapshot-reading collection.** Its mutations all happen on the UI thread (checkbox toggles, refresh rebuilds), but the AI-commit action's enablement check reads it from a background action-update thread. A plain resizable list would let the refresh's clear-then-refill cycle slice through that read and throw a concurrent-modification error, disabling the commit action at random. A copy-on-write collection gives the background reader an implicit snapshot with no explicit locking; the per-write copy cost is bounded by the working-tree change count.

The selection memory does not survive a panel rebuild — every full refresh rebuilds the row list and the checkbox array fresh. Selection persistence across rapid debounced refreshes is delegated to the project service (its row list carries the prior `isSelected` per path). A panel-level "toggle select all" helper flips all checkboxes: if any are unchecked, it checks them all; otherwise it unchecks them all.

### Empty / placeholder states

Three single-label states, in priority order:

| Condition                                | Body                                              |
| ---------------------------------------- | ------------------------------------------------- |
| Status not yet loaded                    | "Initializing Jolli Memory..."                    |
| Status loaded but the repository is not enabled | "Jolli Memory is not enabled for this repository." then, on a second line, "Open the Status panel to install hooks and enable it." |
| Working tree clean (zero rows)           | "Working tree clean — no changes."                |

The disabled placeholder is deliberately distinct from the initializing one so a user is not misled into thinking a background task is still running — nothing is, until they enable. Both of the first two states also reset the panel's render-deduplication signature, so the next data refresh repaints even when the change set is byte-identical to what was on screen before the placeholder appeared.

## Behavior

### Initial load

On panel construction:

1. The panel registers a project-status listener so it refreshes whenever the project's enabled flag flips.
2. The panel subscribes to the IDE's application-level virtual-file-system change channel and to the project-level git-repository-change channel.
3. It schedules a background "list changed files" query and renders the initializing placeholder until the result arrives.

### Auto-refresh sources

Debounced refresh paths cover different change shapes:

| Source                                | Reason it fires                                    | Debounce |
| ------------------------------------- | -------------------------------------------------- | -------- |
| Workspace virtual-file-system changes | Any working-tree file changed (saves, edits from outside, copy/move, etc.). | 300 ms   |
| **IDE change-list update-done**       | The IDE's own change tracker finished an update — which happens for **unsaved in-editor edits** too, so this is what makes the panel update as the user types rather than only after a save reaches disk. | 300 ms   |
| IDE window re-activated               | The user alt-tabbed back after an external tool (an agent in a terminal, say) edited files, so the panel is current the moment they look at it. | 300 ms   |
| IDE git-repository changes, and VCS configuration changes | A commit, branch switch, or index update that the workspace VFS cannot observe (for example, a commit performed via the IDE's own commit dialog moves staged files to committed without touching working-tree files). | 500 ms   |
| A fixed periodic tick, gated on the panel actually being on screen | A **backstop** for external changes no listener reported. It is no longer the primary mechanism — the change-list subscription is. Because a refresh whose change set is byte-identical to the last render is de-duplicated, an unchanged tree makes the tick nearly free. | — |

Every one of these paths — including the periodic tick — performs the unsaved-ignore-file flush described above **before** reading, so the read always sees current ignore rules.

The VFS path explicitly ignores any event whose path contains the git metadata directory — those events fire constantly and are not relevant to the change set. The git-repo path is the dedicated channel for index changes that the VFS misses.

### Stale-result discard

A monotonic version counter is incremented before each background query. When the query returns, if the panel's counter has advanced (a newer refresh started), the result is dropped. This prevents an in-flight slow query from overwriting a fresher state — for example, on initial install when the status listener fires while the first slow `git status` is still running.

### Single-click opens diff

A single left click on the row (anywhere except the checkbox or the discard glyph) opens the IDE's diff viewer. Three branches by status:

| Status        | What opens                                                                    |
| ------------- | ----------------------------------------------------------------------------- |
| `M`, `R`      | Side-by-side: left = `git show HEAD:<path>`, right = working-tree file (read from VFS so unsaved edits, encoding, and line separators come from the IDE document model). Tab title: `<path> (HEAD ↔ Working Tree)`. |
| `A`, `??`     | The working-tree file is opened directly in the editor (no `HEAD` version exists to compare against). |
| `D`           | Read-only view: left = `git show HEAD:<path>`, right = empty. Tab title: `<path> (Deleted)`. |

The checkbox is excluded from this click handler (clicking the checkbox toggles selection without opening a diff). The discard glyph has its own handler.

### Discard

Hovering a row reveals a discard glyph at the right end of the row. Clicking it opens a confirm dialog whose verb depends on the status:

| Status      | Confirmation verb                          |
| ----------- | ------------------------------------------ |
| `??`        | "Are you sure you want to delete `<path>`?" |
| Others      | "Are you sure you want to discard changes to `<path>`?" |

On confirm, the discard branches by status:

- `??` (untracked): **this arm is now unreachable.** The discard code still contains a `??`→delete branch, but the changed-files source now hands the panel a single-character `?` status for untracked files (never the two-character `??`), so this branch never matches. An untracked file instead falls through to the *all others* branch below and is run through `git checkout HEAD -- <path>`, which is a **no-op** for a file that was never committed — so the untracked file is **not** deleted. (Bug: untracked discard silently does nothing.)
- `A` (staged-new): unstage with `git reset HEAD -- <path>`, then delete from disk.
- All others (`M`, `D`, `R`, `C`, `U`, and the single-character `?` an untracked file actually arrives as): restore via `git checkout HEAD -- <path>`.

A refresh is triggered after the discard completes.

### Hover detection

The hover handler is attached to the row and to every child component, with an "is the mouse really still inside the row" check on `mouseExited` to avoid hide flicker when the cursor crosses from a child component into a sibling. The discard glyph is the only element whose visibility is toggled by hover.

### Toggle select all

The panel exposes a "toggle select all" entry point used by the section's toolbar action. The rule:

- If any row is unchecked, every row becomes checked.
- Otherwise, every row becomes unchecked.

The toggle does not refresh the underlying list; it only flips checkbox states. Re-rendering propagates the new states to the AI-commit consumer through the standard derived-view path.

## State Transitions

```
[panel construction]
  emptyLabel default: "No changes detected."
  subscribe to status listener
  subscribe to VFS change channel
  subscribe to git-repo change channel
  spawn initial background refresh

[refresh]
  version++
  background: query porcelain
  on response:
    if status == null → "Initializing JolliMemory..."
    else if !status.enabled → "Jolli Memory is disabled."
    else: rebuild row list with checkboxes from isSelected

[VFS event with path not under .git/]
  schedule debounced refresh (300 ms)

[git-repo change event]
  schedule debounced refresh (500 ms)

[user clicks row (not checkbox, not discard glyph)]
  open diff per status branch

[user clicks discard glyph]
  confirm dialog (verb depends on status)
  on confirm: discard per status branch; refresh()

[user toggles checkbox]
  panel-local checkbox state flips

[panel toolbar: toggle select-all]
  if any unchecked → check all
  else → uncheck all

[panel disposed]
  unsubscribe from all listeners; cancel debounce timers
```

## Notable Behavior

- **The panel is flat, not folder-grouped.** Each porcelain row gets exactly one panel row. There is no hierarchy.
- **Files inside a newly-added directory are listed individually.** The status call requests all untracked files (not the collapsed `dir/` form), so a fresh directory expands to one row per file. Directory-shaped rows are skipped outright.
- **Renames/copies consume a second segment.** In the NUL-separated stream a rename/copy carries its original path as the next segment; the parser reads and discards it and lists only the destination path. Paths with spaces parse unambiguously because the stream is NUL-delimited, not line-delimited.
- **The source now emits a single resolved status letter.** The "list changed files" call collapses the two-column porcelain code to one letter (index column when set and not `?`, else worktree column). Untracked therefore arrives as a single `?` (worktree column), not the two-character `??` that the status-code mapping table above is keyed on — a drift between the source query and the panel's documented `??`→`U` relabel that predates this change (the panel-render mapping was not re-verified against the single-letter form here).
- **Untracked porcelain `??` is rebranded to display `U`.** This is to align the panel with the convention used in the product's documentation and the VS Code parallel surface. The tooltip (`Untracked`) and the green color disambiguate from unmerged-`U` (red).
- **The status badge color depends on the porcelain code, not the display letter.** Two rows showing `U` can be different colors.
- **Working-tree clean is its own message.** It distinguishes from the disabled and uninitialized placeholders, which use different copy.
- **The VFS listener filters `.git/` paths.** Without that filter, every `git` operation would fire a refresh storm; the dedicated git-repo listener covers what the filter excludes.
- **Two listeners with two debounces because their cadences differ.** A working-tree file save fires immediately and rapidly; a commit-via-IDE-dialog needs a longer settle window for the index to stabilize.
- **Stale-result protection is monotonic, not reentrant.** A newer refresh may start before the older one has decided to discard. The version compare in the result handler is the gate.
- **Selection is a panel-local, refresh-rebuilt state.** The panel does not own a long-lived selection map; it relies on the project service's row list carrying `isSelected` so that brief refreshes do not lose the user's choices.
- **The selection array is read off the UI thread, which dictates its type.** The AI-commit action's enablement check runs on a background action-update thread and reads this array while UI-thread refreshes rebuild it. The array is therefore a copy-on-write collection, not a plain list — a detail that is load-bearing, not incidental: with a plain list the commit action intermittently throws and appears disabled for no visible reason.
- **The panel shows unsaved edits.** Reading the IDE's change tracker first means a file edited in an editor but not saved counts as a change here, unlike a pure `git status` view. Conversely, an empty change-tracker result is never trusted as "clean" — it falls back to git, so a not-yet-populated tracker cannot flash an empty panel over a dirty tree.
- **Ignore-rule buffers are flushed before each read.** A newly typed but unsaved ignore pattern takes effect on the very next refresh, because the panel writes those buffers to disk first. Without the flush the panel would keep listing files the user has already excluded.
- **The disabled placeholder is the same copy the sibling memory panels use.** Its two-line text points the user at the Status panel; it is distinct from the initializing copy so a not-enabled repository does not look like a slow load.
- **Single-click on a row opens a diff; the row has no double-click meaning.** Diffs open immediately on the first click. Clicks on the checkbox or discard glyph are excluded from this handler.
- **Diff content for the working-tree side is sourced from VFS, not from the file on disk.** This is what lets the diff reflect unsaved edits in the IDE's document model and use the right encoding / line separators.
- **The discard dialog wording is destructive for `??` and `A` and corrective for the others.** This is intentional — for untracked / staged-new files there is no `HEAD` version to fall back to, so the right verb is "delete"; for the others the verb is "discard".
- **The hover discard glyph is the panel's only inline destructive action.** The status badge is non-interactive (tooltip-only); the filename is non-interactive (clicking it opens the diff, like the row).
- **Toggle-select-all uses an asymmetric rule.** It checks all when any are unchecked; it does not require "all checked" to switch to "all unchecked". This mirrors a checkbox tri-state where the "off" state requires unanimous unchecked.

## Shared Behavior

- **Project status surface** — feeds the `enabled` flag the panel keys its placeholders on.
- **IDE change-list manager** — the panel's primary data source, and the reason unsaved edits are visible; also the source of the change-set notifications that let the fixed poll act as a backstop rather than the main trigger.
- **Project service "list changed files" call** — the panel's fallback data source, still a native in-process porcelain read.
- **Git operations bridge** — runs `git checkout`, `git reset`, and `git show <ref>:<path>` for the discard and diff branches.
- **IDE diff viewer** — the destination for click-on-row in `M` / `R` / `D` cases.
- **IDE file editor** — the destination for click-on-row in `A` / `??` cases.
- **AI-commit flow** — the consumer of the panel's selection (selected files become the staged set).
- **Section toolbar** — the surface where "toggle select-all", "refresh", and similar actions are anchored.
