# 316. IntelliJ Memory Bank Repo-Scope Filter

## Topic Statement

In the tool window's Memory Bank and Knowledge views the breadcrumb collapses to a single `Showing: <repo>` picker, and that picker carries a **synthetic first entry** — the literal `"All repos"` — that is not a repository at all. Picking it broadens the Memory Bank explorer from one repository to every repository discovered under the Memory Bank parent; picking any other row scopes it back. The synthetic entry cannot travel through the breadcrumb's existing repo/branch callback (there is no repository to enumerate branches for), so [`BreadcrumbHeaderPanel`](../intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/BreadcrumbHeaderPanel.kt) carries a **second, independent** callback, `onRepoFilterChanged(repoName: String?)`, whose `null` argument means "all". On the tree side the filter is a single `@Volatile` field in `KBExplorerPanel` that is never persisted, resets to the workspace repository on every load, and is applied at exactly two places: one list filter feeding the tree build, and one row predicate inside the timeline build. The entry exists only in repo-filter mode, and a restore rule exists specifically to stop it leaking into branch mode, where it would be handed downstream as a repository name.

## Scope

**In scope:**
- The two breadcrumb modes, the synthetic entry's literal and position, and which mode carries it.
- The `onRepoFilterChanged` callback: its signature, its independence from `onSelectionChanged`, and every site that fires it.
- The item-list composition per mode, and the restore rule applied when the mode changes.
- The picker's rendering of the workspace row (bold, `(current)` suffix, separator) and the selected row (check prefix), and the index arithmetic the prefix forces.
- The tree-side filter field: its type, its volatility, its non-persistence, and its two application points.
- The telemetry emitted when the synthetic entry is picked.

**Out of scope:**
- The view switch that puts the breadcrumb into repo-filter mode, and the foreign-repo read-only mode the *other* callback drives (owned by spec 118).
- The branch picker, branch enumeration, and the foreign repo/branch selection semantics (owned by spec 118).
- Repository discovery itself — how `KBRepoDiscoverer.discover` finds Memory Bank repositories and computes `isCurrentRepo` (owned by spec 151 and the bridge surface, spec 287).
- The tree's node model, badges, expansion, and search, and the timeline's date grouping (owned by spec 193).
- The heal pass that runs per admitted repository inside the tree build (owned by spec 315).
- The manifest and index reads the admitted repositories drive (owned by spec 314).

## Data Contracts

### Modes

`enum class Mode { BRANCH, REPO_FILTER }`. `BRANCH` shows `repo / branch`; `REPO_FILTER` hides the slash and the branch picker, shows a `Showing:` prefix label, and shows only the repo picker.

### The synthetic entry

`const val ALL_REPOS_LABEL = "All repos"` — a companion-object constant, English-only by deliberate decision and shared verbatim with the VS Code sidebar dropdown so the two IDE surfaces read identically.

### The callback

```kotlin
private val onRepoFilterChanged: (repoName: String?) -> Unit = {}
```

A constructor parameter defaulting to a no-op. `null` means the user picked the synthetic entry. It is documented as deliberately independent of `onSelectionChanged(repo, branch, isForeign)` because `"All repos"` cannot be routed through the branch / foreign-mode logic that callback owns.

### Item lists per mode

`itemsForCurrentMode()` returns `listOf(ALL_REPOS_LABEL) + repoNames` in `REPO_FILTER` and the bare `repoNames` in `BRANCH`, where `repoNames` is `repos.map { it.repoName }` over the discovered `KBRepoDiscoverer.DiscoveredRepo(kbRoot, repoName, remoteUrl, isCurrentRepo)` list, in discovery order.

### The tree-side field

```kotlin
@Volatile
private var repoFilter: String? = null
```

`null` = all repositories; a non-null value scopes to that `repoName`. It is **never persisted** — the panel starts at `null` and is driven to the workspace repository by the breadcrumb's first broadcast, matching the VS Code sidebar, which also starts scoped and requires an explicit pick to broaden.

## Behavior

### Firing the callback

Four sites, all inside `BreadcrumbHeaderPanel`:

| Site | Argument | Guard |
|---|---|---|
| `refresh()` (`:213`) | `repoPicker.selected` after the initial silent selection | fires only when `mode == REPO_FILTER` |
| `setMode()` (`:166-168`) | the restored selection | fires only when entering `REPO_FILTER`, the restored value is non-null and not `ALL_REPOS_LABEL`, **and** `repos.isNotEmpty()` |
| `onRepoSelected()` synthetic branch (`:225-228`) | `null` | fires unconditionally when the picked value equals `ALL_REPOS_LABEL`, then **returns** |
| `onRepoSelected()` normal branch (`:237`) | the picked repository name | fires only when `mode == REPO_FILTER` |

The initial broadcast in `refresh()` exists because `setSelectedSilently` deliberately does not fire `onPick`; without it the first user click would flip the tree from "all" to "current repo" for no visible reason.

The `repos.isNotEmpty()` guard in `setMode` exists because the mode can be set during panel construction, before the first `refresh()` has populated `repos` — firing then would rebuild the tree against an empty cached repository list and flash "No memories yet".

### The synthetic pick short-circuits

`onRepoSelected()` tests for `ALL_REPOS_LABEL` **first**. On a match it emits telemetry, calls `onRepoFilterChanged(null)`, and returns — before the `isForeign` computation, before the `repo_switched` telemetry for a real repository, and before `refreshBranches()`. That early return is what keeps the label out of the branch-lookup path, which has no repository to look up.

### The restore rule

`setMode` repopulates the picker without a full `refresh()` (which would lose the selection and refire a git branch enumeration), then restores via:

```kotlin
internal fun resolveRestoredRepoSelection(previous: String?, newItems: List<String>): String? {
    if (previous != null && previous in newItems) return previous
    return newItems.firstOrNull { it != ALL_REPOS_LABEL }
}
```

Preserve the previous selection **only** if it is a member of the new list; otherwise fall back to the first non-synthetic entry — the workspace repository, which is present in both modes' lists. The helper is `internal` specifically so it can be unit-tested without instantiating the Swing surface.

### Rendering

`WorkspaceAwareCellRenderer` composes each row as a fixed-width check gutter (`"✓ "` when the row equals the picker's current selection, two spaces otherwise) followed by the value. The workspace row additionally renders bold with a grey `(current)` suffix in HTML and carries a 1 px bottom matte border, so the `All repos` header and the workspace row read as a group above the alphabetical tail. `getSelected` is passed as a getter rather than a snapshot so the renderer stays correct across repaints.

The workspace row is identified by index, and the index depends on the mode: `isWorkspaceItem` computes `allReposIdx = if (mode == Mode.REPO_FILTER) 1 else 0` and matches `index == allReposIdx && repos.any { it.isCurrentRepo }` — the synthetic prefix pushes the workspace entry from index 0 to index 1, matching where the VS Code sidebar puts `<repo> (current)`.

### Applying the filter

`KBExplorerPanel.setRepoFilter(repoName: String?)` early-returns when the value is unchanged, assigns the field, and dispatches `rebuildCurrentView()` onto a pooled thread. Two application points:

- **Tree** — `filteredRepos()` (`:406-409`) is documented as *the* single source of truth for which repositories `build*()` iterates: `repoFilter ?: return cachedRepos`, otherwise `cachedRepos.filter { it.repoName == filter }`. `buildTree` calls it once and renders the empty-state message when the result is empty.
- **Timeline** — `buildTimeline` (`:1285-1290`) captures `repoFilter` into a local, then filters each date group's entries by `repoFilterCapture == null || it.repo == repoFilterCapture`, stacking the search predicate on top. The capture is taken once per build so a concurrent flip cannot split one render across two filters.

`KBDataCache` itself is never filtered — it always holds every discovered repository's entries, and both views narrow at render time.

### Wiring

`JolliMemoryToolWindowFactory` constructs the breadcrumb with `onRepoFilterChanged = { repoName -> kbPanel.setRepoFilter(repoName) }` (`:533-535`) and sets `Mode.REPO_FILTER` for both the Memory Bank and the Knowledge segments of the view switch (`:556`, `:562`), `Mode.BRANCH` for Current Branch (`:551`).

### Telemetry

The synthetic pick emits `repo_switched` with `{"is_foreign": false, "all_repos": true}`; a real repository pick emits `repo_switched` with `{"is_foreign": <not the workspace repo>}` and no `all_repos` key.

## State Transitions

| From | Event | To | Notes |
|---|---|---|---|
| Panel constructed | — | `repoFilter = null` (all) | Not yet broadcast; the tree has no cached repositories either. |
| Any | `refresh()` completes in `REPO_FILTER` | the first discovered repository | The workspace repository, selected silently then broadcast. |
| Any | View switch into Memory Bank / Knowledge | the restored selection, if non-null and not synthetic and repositories are loaded | Otherwise no broadcast; the tree keeps its previous filter. |
| Scoped | User picks `All repos` | `null` | Early return: no branch refresh, no foreign-mode routing. |
| `null` | User picks a repository row | that repository | `refreshBranches()` also runs, which cascades into `onBranchSelected(trackSwitch = false)`. |
| Any | View switch into Current Branch | unchanged | `setMode(BRANCH)` never fires `onRepoFilterChanged`; the hidden tree keeps whatever scope it had. |
| Any | Panel reload / IDE restart | `null`, then the workspace repository on the next broadcast | Nothing is persisted. |

## Notable Behavior

- **`"All repos"` must never survive a transition into branch mode, and the restore rule is the only thing stopping it.** The unrestrained restore did leak it: branch mode's item list does not contain the label, `onBranchSelected` handed `"All repos"` downstream as a repository name (blowing up Memory Bank lookups with no matching repository), and the workspace `(current)` bold was lost because the index-0 check misfired. The membership test plus the `firstOrNull { it != ALL_REPOS_LABEL }` fallback is the fix, and it is unit-tested through the `internal` helper rather than through the Swing surface. (Surprising; the reason the restore is not simply "keep the previous value".)
- **The picker shows a muted `(current)` suffix on the workspace row — identified by index, not by value.** With the synthetic prefix present that index is 1, not 0. The offset lives in the `isWorkspaceItem` lambda passed to the picker, so a future change to the prefix's position silently mislabels a row rather than failing.
- **Two callbacks fire for one click, and they own disjoint slices of the UI.** A real repository pick in repo-filter mode drives `onRepoFilterChanged` (tree scope) *and*, via `refreshBranches` → `onBranchSelected`, `onSelectionChanged` (foreign-mode routing for the Current Branch view's panels). The synthetic pick drives only the first. The factory's comment states the split explicitly.
- **Knowledge view shares the mode but not the consumer.** Both Memory Bank and Knowledge put the breadcrumb into `REPO_FILTER`, and both therefore broadcast on entry — but the only subscriber is `kbPanel`. Picking a repository while looking at the Knowledge placeholder re-scopes the Memory Bank tree, which is not on screen.
- **The filter is `@Volatile` and read from two threads.** It is written from the callback (which reaches `setRepoFilter` from the EDT via `SwingUtilities.invokeLater`) and read on the pooled thread doing the rebuild. `setRepoFilter`'s KDoc claims the rebuild runs "synchronously on the calling thread (callers already run on a pool thread)"; the body does the opposite and dispatches to `executeOnPooledThread`. The dispatch is what is true — and what is required, since the callers reach it from the EDT.
- **Broadening is never the implicit default.** The initial selection is always the workspace repository, on the stated grounds that an unfiltered tree over ten or more repositories is a wall of text on cold start. `null` is reachable only by an explicit pick, and it does not survive a reload.
- **The tree's empty state is filter-sensitive.** `filteredRepos()` returning empty renders "No memories yet — commit with an AI coding tool to get started", which is also what an entirely empty Memory Bank renders. A filter naming a repository that discovery no longer returns produces the same message as having no memories at all.

## Shared Behavior

- **IntelliJ Tool Window Accordion (118)** — owns the three-segment view switch, the breadcrumb's placement and mode changes, the branch picker, and the foreign-repo read-only mode driven by the *other* breadcrumb callback.
- **IntelliJ KB Explorer Panel (193)** — owns the tree and timeline this filter narrows, including the node model and the search predicate that stacks on top of the scope.
- **IntelliJ Memory Bank Heal Pass Gating (315)** — heals exactly the repositories this filter admits, so broadening the scope also broadens what gets healed.
- **IntelliJ Native Memory Bank Metadata Read (314)** — performs the per-repository manifest and index reads for the admitted set.
- **Memory Bank Folder Layout (151)** — owns the parent folder and per-repository subdirectory that discovery enumerates.
- **CLI IDE-Bridge Command Surface (287)** — carries the `kb` `discover` operation that produces `DiscoveredRepo`, including its `isCurrentRepo` flag.
