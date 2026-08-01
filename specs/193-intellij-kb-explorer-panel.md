# 193. IntelliJ KB Explorer Panel

## Topic Statement

Surface the multi-repository Memory Bank parent folder inside the IDE tool window as a two-level tree whose top level is the set of discovered repositories, whose second-and-deeper levels are each repository's visible content interleaved with user-created folders.

## Scope

**In scope:**
- The two-tier tree shape: a hidden synthetic root, a repository row per discovered repository, then per-repository content (branch folders and root-level files).
- The per-listing build sequence that, on every refresh, replaces the entire tree model with a freshly assembled snapshot.
- The discovery boundary — which on-disk children of the parent folder qualify as repositories and how the currently active project is identified amongst them.
- The shared in-memory cache that holds the discovery result and the flattened-entry index, refilled at every refresh and consumed by both this tree and a separate timeline projection.
- The reconcile pre-pass that runs against the currently active repository before each refresh.
- The KB-root resolution sequence that initializes the currently active repository's on-disk subdirectory if absent before the first refresh.
- Per-repository hidden-or-internal filtering at the immediate-children level (the visible per-branch directories, and the root-level non-dot files outside an internal-name blocklist).
- Per-branch-folder recursive enumeration with directories-first sort and dotfile filtering.
- Manifest-driven enrichment of every visible file with a one-letter classification badge, a manifest-derived display title, the entry's source branch, and the on-disk repository root that owns it.
- The hiding rule that omits manifest entries whose recorded parent-commit pointer marks them as superseded children of a squash or consolidation.
- The expansion policy that auto-expands the currently active repository row and each of its branch-folder children while collapsing every other repository row.
- The selection-preservation policy that survives a refresh by re-finding the previously selected node's absolute path in the rebuilt tree.
- The double-click behavior for file leaves: a memory entry opens its rendered viewer; any other file opens in the host editor.
- The empty-state message that replaces the tree body when no repositories were discovered.
- The error-state message that replaces the tree body when the build sequence throws.
- The refresh triggers: an external status-change signal from the project's session service, a virtual-filesystem change event whose path lies under the parent folder, a git-repository change event from the IDE, and any user-initiated mutation routed through this panel.
- The cross-repository handling: foreign repositories appear collapsed by default with their own per-row hidden-metadata folder used to resolve viewer paths.
- The "reset" action that marks the migration state pending and launches the command-line surface's one-shot migration from the orphan-branch source of truth into the folder mirror.
- The knowledge-wiki build button hosted on this panel's toolbar, whose behavior is owned by the wiki-build-trigger spec (216).
- The delegation boundary: which of this panel's data reads are cross-process round-trips to the command-line surface and which remain native in-process directory walks.
- The toolbar view-toggle between tree mode and a separate timeline mode (the timeline mode itself is across the boundary, but the toggle's wiring into refresh and search is in scope).

**Out of scope (boundaries):**
- The parent folder's location, the per-repository collision-suffix allocation, the hidden-metadata layer's documents (manifest, branches registry, config, migration state, index, catalog), and which on-disk children of the parent count as repositories — defined by spec 151 (memory bank folder layout).
- The repository-identity-matching rules that resolve "the current project" against a discovered repository (URL normalization, name fallback, worktree handling) — defined by spec 151.
- The schema and mutation semantics of the manifest, index, and branches registry — defined by the folder-based summary storage spec.
- The one-shot migration command the reset action invokes — owned by the command-line surface's migration spec. This panel only marks the migration state pending and launches the command.
- The viewer that opens when a memory file is double-clicked — its own spec.
- The drag-and-drop reordering, in-place rename, move-to-folder, new-folder, new-file, import-file, and delete file-operations — separate "tree mutation actions" topic.
- The right-click context menu's full action set — referenced only at the boundary.
- The timeline-view tree projection — separate spec.
- The search field that filters the timeline view — separate spec.
- The recall-prompt clipboard action — separate spec.
- The visible-layer heal pass's own mechanics — what it regenerates and how — remain across the boundary. **This panel now runs it**, however, immediately before each per-repository manifest read, under a per-repository clean-set short-circuit and a failure cooldown; that gating is owned by spec 315 and is not restated here.
- The repository-scope filter that narrows the tree to the current repository or broadens it to every discovered repository — spec 316. This panel's per-repository loop reads whatever list that filter produces.
- The sibling VS Code memory-bank folder browser — spec 175.
- The visual chrome (icons, colors, fonts, badge styling) beyond the structural-flag contract this panel emits to its row renderer.

## Data Contracts

### Synthetic root

The tree model's root is a synthetic, never-rendered node carrying only a literal label string. The renderer hides the root row; only its descendants are visible. The root has one child per discovered repository, in the order produced by the discovery boundary.

### Repository row

Each discovered repository contributes one tree node directly under the synthetic root, with these fields:

- **On-disk path**: the repository's absolute root path under the parent folder.
- **Display name**: the recorded repository name (from the boundary), used both as the row label and as the row's intrinsic name.
- **Is-directory**: always true.
- **Is-repo-root**: true (used by the row renderer to switch icon and font weight).
- **Is-current-repo**: true when the boundary marked this repository as matching the currently active project; false otherwise. Drives the auto-expansion rule and a bold-font flag in the row renderer.

A repository row's children are precomputed eagerly at build time and stored on the node — they are not lazy-loaded on first expansion. Lazy expansion in this surface refers only to the on-screen expand/collapse state, not to a deferred children-fetch.

### Branch-folder row

Inside a repository row, every direct subdirectory of the repository root whose name is **not** filtered (see "Hidden-or-internal filter" below) becomes a child node:

- **On-disk path**: the directory's absolute path.
- **Display name**: the directory's on-disk basename.
- **Is-directory**: true.
- **Is-repo-root**: absent.
- **Is-current-repo**: absent.

Each branch-folder row recursively contributes its own children (see "Recursive descent" below).

### Root-level file row

Inside a repository row, every direct file child of the repository root that is **not** dot-prefixed and **not** named with the index-document basename becomes a child node:

- **On-disk path**: the file's absolute path.
- **Display name**: the manifest entry's recorded title when one exists for the file's repository-relative path, otherwise the file's on-disk basename.
- **Is-directory**: false.
- **Badge**: a single-letter classification code derived from the manifest entry's type (see "Classification badge" below); the empty string when no manifest entry exists. Not rendered — it survives purely as a dispatch key.
- **Source branch**: the manifest entry's recorded source branch; absent when no manifest entry exists or when the entry has no recorded source branch.
- **Owning repository root**: the absolute path of this row's repository, so that downstream actions (memory viewer, context-menu metadata lookups) can find the right hidden-metadata folder when the user has expanded a foreign repository.

A root-level file row whose repository-relative path is in the "hidden children" set (see below) is omitted from the listing.

### Nested-file row (inside a branch folder)

Identical to the root-level file row shape, except that the on-disk path lies arbitrarily deep under a branch-folder row and the recursive descent visited it.

### Hidden-or-internal filter

The filter applied to the immediate-children enumeration of a repository row, controlling which directories surface as branch-folder rows:

- A directory whose name starts with a dot is excluded (the hidden-metadata folder being the canonical instance).
- A directory whose name is exactly `summaries`, `transcripts`, or `plan-progress` is excluded (these are reserved sub-tree names that belong to the per-repository internal layer but live as plain directories rather than under the dot-prefixed hidden folder).

The filter is applied **only** at the repository's immediate children. Inside a branch folder, the recursive descent uses only the dot-prefix filter and does not re-check the three reserved names. A user-created folder named `summaries` inside a branch folder is therefore visible; the same name at the repository root is not.

### Hidden children set

Per repository, the set of repository-relative paths that should not surface as file rows even though they exist on disk. Computed at build time:

1. Read the per-repository projected summary index.
2. For each index entry whose recorded parent-commit pointer is non-null (i.e. the entry is a hoisted child of a squash or consolidation), collect the entry's commit hash.
3. Walk the manifest's row list. For every manifest row whose type is `commit` and whose file identifier is in the collected hash set, add the row's repository-relative path to the hidden-children set.

The motivation is to keep the tree showing only the post-squash representative for any given commit's content, hiding the original per-commit files that were promoted into a containing parent. The visible/hidden state is recomputed every refresh; a re-amend that breaks the parent relationship will re-surface the child rows on the next refresh.

### Classification badge

Derived from the manifest entry's type:

| Manifest type | Badge letter |
| ------------- | ------------ |
| `commit`      | `C`          |
| `plan`        | `P`          |
| `note`        | `N`          |
| Any other     | empty string |

**The badge letter is no longer rendered.** The row renderer draws the file-type icon and the display title and nothing else; the trailing colored single-letter glyph was removed deliberately, on the grounds that the leading Markdown file icon already discriminates the content and the glyph was an IDE-only affordance the sibling VS Code surface never had. What the badge field still does is **dispatch**: three separate call sites test it for the literal `C` — the double-click handler (memory viewer vs. plain file open), the memory-open helper's own guard, and the context-menu enablement check. A file with no manifest entry has no badge at all (an absent field, distinct from an empty-string badge), and both of those fail the `C` test identically.

### Recursive descent

For every branch-folder row, the panel walks the on-disk subtree depth-first, contributing one node per visible entry:

1. Enumerate the immediate children of the current directory.
2. Drop any entry whose name starts with a dot.
3. Sort survivors with directories first, then files, alphabetically by name within each kind.
4. For a directory survivor: project a branch-folder-shaped node (no `is-repo-root` flag), then recursively descend into it.
5. For a file survivor: project a nested-file row, skipping the projection if the file's repository-relative path is in the hidden-children set.

A directory-enumeration error during the descent is caught: the offending directory contributes whatever children were already enumerated before the error, the error is logged via the IDE's logging channel, and the descent continues with the next sibling. The build sequence does not abort on a single bad sub-tree.

### Display-name override per row

The renderer reads two fields from each file row:

- The on-disk basename (`name`).
- The manifest-derived display title (`displayName`).

The row's displayed label is the display title when non-empty, otherwise the on-disk basename. The renderer also reads the badge letter and the row-kind flags (`is-directory`, `is-repo-root`, `is-current-repo`) to switch icon and font weight.

### Empty and error states

The tree body is replaced with a single centered message panel under these conditions:

- The build sequence discovered zero repositories: the message reads `No memories yet — commit with an AI coding tool to get started`.
- The build sequence threw during initial load: the message reads `Error:` followed by the exception's class simple name, a colon, a space, and the exception's message.
- The build sequence threw during a refresh: the message reads `Refresh error:` followed by the exception's message.

When a message panel is shown, the tree instance is not retained; the next non-empty refresh recreates it fresh.

## Behavior

### Where the data comes from: the delegation boundary

Every step below that "reads" Memory Bank metadata is a **cross-process round-trip to the command-line surface**, not a local file read. Specifically, all of the following are delegated:

- extracting the repository name from the current project, and resolving the remote URL;
- resolving the KB root path from the repository name, remote URL and configured override;
- initializing the KB folder (writing the per-repository configuration document);
- the reconcile pre-pass;
- repository discovery;
- the visible-layer heal pass, when the per-repository gate does not short-circuit it (spec 315);
- the migration-state write the reset action performs.

**Per-repository manifest and projected-index reads are no longer delegated.** They are now native in-process reads — a whole-file read plus a decode, straight off the repository's hidden-metadata folder — performed by a dedicated native metadata reader shared with the sidebar's own entry cache. The motive is explicit: the VS Code sibling reads the same manifest directly with a plain file read even though it has the command-line code in-process, and routing these through the boundary cost one round-trip per repository per refresh, which on a parent folder holding ten or more repositories added a visible fraction of a second of pure transport to every tree rebuild. Only reads moved; **writes still go through the boundary**, so dual-write consistency, read-modify-write guards, and atomic-write ownership stay with the command-line surface. The lockstep obligation this creates on the manifest and index schemas is owned by spec 314.

What remains **native in-process**: the manifest and projected-index reads described above, the on-disk directory enumeration and recursive descent that produce the branch-folder and file rows, the hidden-or-internal filter, the sorts, the tree-model assembly, the selection/expansion bookkeeping, and the default parent-folder path.

The practical shape of one refresh is therefore: a handful of delegated calls to establish the KB root and reconcile, **one delegated discovery call, then — per discovered repository — at most one delegated heal call (usually short-circuited) and two native metadata reads**, followed by a full native directory walk of every repository subtree. The per-repository transport cost that used to scale with the repository count is gone from the steady state.

### Initial load

Triggered the first time the panel is shown after construction:

1. Resolve the currently active repository's KB root. This involves: extracting the current project's repository name (via remote URL basename, then git-common-dir parent basename, then directory basename — boundary), resolving the KB root path (via the parent-folder resolution rules — boundary), and initializing the KB folder by writing the project's recorded name and remote URL into the per-repository configuration document (boundary). **All three are delegated calls.**
2. Run the reconcile pre-pass against the resolved KB root. This rewrites the manifest in place when a file recorded under one path is now located under another, based on fingerprint match (boundary). **Delegated.**
3. Reload the shared discovery cache: invoke the discovery boundary with the currently active project's recorded repository name, recorded remote URL, and the parent-folder override (if configured). Store the result. Reload the shared flattened-entry index from each discovered repository's manifest, skipping rows whose file identifier is in that repository's hidden-children set. **The discovery call is delegated; each per-repository manifest and index read is native** (spec 314).
4. Build the tree (see "Building the tree" below).

Each step's exceptions propagate; the top-level handler catches and renders the initial-load error message. A delegated call that fails (the runtime is missing, the subprocess times out, the response does not parse) surfaces through exactly that path — so a transport failure and a genuine data problem are indistinguishable to the user, both rendering the same `Error:` / `Refresh error:` message.

### Refresh

Triggered by any of the refresh triggers (see "Refresh triggers" below) or by any user-initiated mutation routed through this panel:

1. Resolve the currently active repository's KB root (same as initial load step 1 — delegated).
2. Run the reconcile pre-pass (delegated).
3. Reload the shared discovery cache (same as initial load step 3 — delegated discovery plus one delegated manifest read per repository).
4. Rebuild the currently active view's tree:
   - In tree mode, run the tree build (see "Building the tree" below).
   - In timeline mode, run the timeline build (across the boundary).

Each step's exceptions propagate; the top-level handler catches and renders the refresh error message.

### Building the tree

Runs on a worker thread up to and including the tree-node assembly; the final swap-into-UI step runs on the host's UI dispatcher.

1. Read the discovered-repositories list from the shared cache.
2. If the list is empty, replace the tree body with the empty-state message and return.
3. Create the synthetic root node.
4. For each discovered repository, in the order produced by discovery:
   1. Run the visible-layer heal pass for this repository unless its gate short-circuits (spec 315). This is the one delegated call left inside the per-repository loop, and in steady state it does not run.
   2. Read the per-repository manifest and projected index from the repository's hidden-metadata folder. **Both are native reads** — a whole-file read plus a decode, no cross-process round-trip (spec 314).
   3. Compute the hidden-children set (see Data Contracts above).
   4. Compute three lookup maps over the manifest's row list, keyed by repository-relative path: a badge-letter map, a display-title map (only for rows whose recorded title is non-empty), and a source-branch map (only for rows whose source record carries a branch).
   5. Project the repository row.
   6. Enumerate the immediate-child directories of the repository root, apply the hidden-or-internal filter, sort by name. For each surviving directory: project a branch-folder row, recursively descend (see Data Contracts above), attach to the repository row.
   7. Enumerate the immediate-child files of the repository root, drop dot-prefixed names and the literal `index.json`, sort by name. For each surviving file: skip if its repository-relative path is in the hidden-children set; otherwise project a root-level file row populating the badge, display title, source branch, and owning repository root from the three lookup maps. Attach to the repository row.
   8. Attach the repository row to the synthetic root.
5. On the UI dispatcher:
   1. If no tree instance exists yet, create one with the new model, install a row renderer that switches on the row's flags, install single-selection mode, install double-click and right-click mouse handlers, and install the drag-and-drop wiring (across the boundary).
   2. If a tree instance already exists, capture the on-disk path of the currently selected row (if any), swap the new model in, and after the swap attempt to re-select the row whose on-disk path equals the captured path by walking the new model from the synthetic root.
   3. For every repository row: if `is-current-repo` is true, expand the row and expand each of its direct branch-folder children; otherwise collapse the row.
   4. Reset the tree body's scroll pane to wrap the (possibly new) tree instance and force a layout pass.

The on-screen result: the currently active repository is open with its branches one level deep; every other repository is a single closed row.

### Building a branch-folder row's children (recursive descent)

For a directory `D` under repository root `R`:

1. Enumerate the immediate children of `D`. On enumeration error, log and abort the descent into `D` (the partial children already attached survive).
2. Drop any child whose name starts with a dot.
3. Sort the survivors with directories first, then files, alphabetically by name within each kind.
4. For each surviving directory: project a branch-folder-shaped node (no `is-repo-root`), recursively descend into it.
5. For each surviving file: compute its repository-relative path against `R`. If the path is in the hidden-children set, skip. Otherwise project a nested-file row, populating the badge, display title, source branch, and owning repository root from the three lookup maps for `R`.

### Refresh triggers

The panel installs four refresh paths during construction; each runs the refresh sequence on a worker thread.

1. **Service status listener.** The panel registers a no-argument callback with the project's session service at construction. Every time the session service fires a status change (sign-in, sign-out, settings change, manual refresh request from elsewhere in the IDE), the callback schedules a refresh.
2. **Virtual-filesystem change listener.** The panel subscribes to the IDE's virtual-filesystem-changes bus and inspects each batch of events. If any event in the batch is a create, delete, or move event **and** the event's path string starts with the absolute string form of the parent folder, the batch triggers a refresh. Other event kinds (content change, rename) and other paths are ignored.
3. **Git repository change listener.** The panel subscribes to the IDE's git-repository-change bus. On every event, it issues an asynchronous virtual-filesystem refresh whose completion callback schedules a panel refresh. The two-step indirection exists because git hooks write to the KB folder via an external process, and the IDE's virtual-filesystem may not see those writes until an explicit refresh. The git-change event is therefore re-routed through a virtual-filesystem refresh which then fires the virtual-filesystem listener's downstream refresh.
4. **User-initiated mutations.** Drag-and-drop completion, context-menu rename / move / delete / new-folder / new-file / import-file, and the reset action all call a "background refresh" helper that schedules the refresh sequence on a worker thread.

The four triggers are independent; concurrent refreshes can occur. The build sequence holds no lock — two concurrent refreshes both run reconcile, both reload the cache (last write wins on the volatile cache reference), both rebuild the model. The UI-dispatcher swap step is serialized by the dispatcher itself; if two builds finish out of order, the later swap wins.

### View-toggle

The toolbar carries two segmented toggle buttons (tree and timeline) plus a refresh icon and a search field. The search field is visible only in timeline mode.

A toggle-button click:

1. Sets the panel's current-view enum to the clicked button's mode.
2. Selects only the clicked button.
3. Shows or hides the search field based on the mode (visible only for timeline).
4. Switches the central card-layout to expose the corresponding panel (tree panel for tree mode, timeline panel for timeline mode).
5. Schedules a rebuild of the current view on a worker thread.

The tree-mode and timeline-mode panels share the same data cache and the same set of refresh triggers; switching modes is essentially a render-only switch over an already-current data set.

### Double-click on a row

The mouse handler fires on click-count equal to 2 with the row at the click location selected.

1. Recover the row's data payload. If the payload is missing or the row is a directory, do nothing.
2. If the row's badge letter is `C` (a memory file), open the rendered memory viewer (see "Opening a memory viewer" below).
3. Otherwise, open the file in the host editor in a read/write text editor with focus.

### Opening a memory viewer

Triggered by a double-click on a memory-badged file row, or by the "View Commit Memory" context-menu action.

1. Resolve the owning repository root for the row: the row's recorded owning-repository-root field if present (the foreign-repository case after the user expanded a non-current repository), otherwise the currently active repository's KB root.
2. Compute the file's repository-relative path against the owning root.
3. Look up the manifest entry for the relative path in the owning repository's manifest. If no entry exists, fall back to opening the file in the host editor and return.
4. Compose the on-disk path of the cold-store summary document: `<owning-root>/<hidden-metadata-folder>/summaries/<file-identifier>.json`.
5. If the summary document does not exist, fall back to opening the file in the host editor and return.
6. On a worker thread: read the summary document as UTF-8 text, parse it as JSON, materialize into a summary value. If the parse yields nothing (the JSON parser returned a null), fall back to opening the file in the host editor on the UI dispatcher and return.
7. Determine the read-only flag: true when the row's owning repository root differs from the currently active repository's KB root (i.e. the user is viewing a foreign repository's memory and should not be able to edit it); false otherwise.
8. On the UI dispatcher, hand the parsed summary and the read-only flag to the **shared single-memory-tab opener** (across the boundary). That opener enforces at most one memory tab per project: if a memory tab is already open, it swaps that tab's content to this memory and re-activates it rather than opening a second tab.

The consequence for this panel is user-visible and easy to trip over: **double-clicking a foreign repository's memory here replaces whatever memory the reader was already looking at** — including one of their own, editable memories — and **flips that same tab into read-only mode**. There is no second tab, so a reader cannot hold their own memory open on one side while inspecting a foreign one; and after the swap the tab's write affordances are gone until they open an own-repository memory again.

Any exception in steps 6–8 is logged and a fall-back open in the host editor is scheduled on the UI dispatcher.

### Selection preservation across refresh

When a refresh swaps the tree's model:

1. Capture the on-disk path of the currently selected row (the row data's path field) before the swap.
2. Install the new model.
3. If a path was captured, walk the new model from the synthetic root depth-first, comparing each visited node's data payload's path field to the captured path. The first match becomes the new selected row.
4. If no match is found (the selected row no longer exists, e.g. the file was deleted), the new model carries no selection.

Selection by on-disk path means: a file that was moved between branch folders surfaces with its previous selection if the new node at the move destination carries the new path — but the captured path is the **old** path, so the move actually drops the selection. The contract is "same physical file at same path retains selection".

### Reset action

A toolbar refresh-icon button. Clicking it schedules the following sequence on a worker thread:

1. Read the currently active repository's KB root (from the panel's state, populated by the most recent KB-root resolution).
2. Write a migration-state document marking status `pending` into the per-repository hidden-metadata folder — a delegated call.
3. Resolve the currently active project's on-disk path (via the service's main-repo-root field, falling back to the IDE-supplied project base path).
4. Invoke the command-line surface's **one-shot migration command** against that project path and wait for it. This is a separate one-shot invocation, not one of the panel's ordinary delegated data calls: it has its own multi-minute budget and its result is the last well-formed line of the command's output.
5. Log the result (status, migrated-entry count, total-entry count).
6. Invoke a refresh.

Any exception in steps 2–5 is logged via the IDE's logging channel; the refresh in step 6 is not invoked in the exception path.

The panel no longer constructs a source-of-truth reader, a folder-mirror writer, or a migration engine of its own — none of those exist on this surface. It also no longer *reads* the migration state: the "orphan branch has data but migration has not completed" decision lives entirely inside the migration command. The panel's only contribution is the pending marker, which tells that command it has work to do.

### Empty-tree behavior

When the discovery returns no repositories, the build sequence runs through up to step 2 of "Building the tree", replaces the tree body with the empty-state message, and exits. The shared cache is left holding the empty discovery result; subsequent refreshes will keep showing the empty-state until a discovery returns at least one repository.

## State Transitions

### Per-repository row expansion state

For any given repository row in any given tree model:

```
NEW MODEL ── is-current-repo == true ──> EXPANDED (with branch-folder children also expanded)
NEW MODEL ── is-current-repo == false ──> COLLAPSED
EXPANDED ── user clicks the collapse arrow ──> COLLAPSED
COLLAPSED ── user clicks the expand arrow ──> EXPANDED
EXPANDED ── refresh assembles a new model ──> see NEW MODEL above
COLLAPSED ── refresh assembles a new model ──> see NEW MODEL above
```

Expansion state is **not** persisted across refreshes for foreign repositories. A user who manually expanded a foreign repository to inspect its memories will see it collapse again on the next refresh; only the current-project repository auto-re-expands. (Notable.)

### Per-leaf selection state

For any given file row:

```
UNSELECTED ── user clicks the row ──> SELECTED
SELECTED ── user clicks a different row ──> UNSELECTED (the other row becomes SELECTED)
SELECTED ── refresh keeps the row in the new model with the same on-disk path ──> SELECTED
SELECTED ── refresh drops the row from the new model ──> UNSELECTED
```

### Current-view state

The toolbar's view-toggle drives a two-state enum (`TREE`, `TIMELINE`). The state is not persisted across IDE restarts; the panel starts in `TREE` mode on every construction. Switching views fires a rebuild of the newly active view but does not invalidate the shared cache.

### Cache lifecycle

The shared discovery cache and the flattened-entry index are both per-panel singletons (held as object-level state, not per-instance). The lifecycle:

```
EMPTY ── first refresh of any panel ──> POPULATED (discovery result and entry index)
POPULATED ── every subsequent refresh ──> REPLACED (atomic swap)
```

There is no explicit cache invalidation API; every refresh fully replaces the cache contents. The cache is therefore never stale relative to the panel's currently displayed tree (the panel rebuilt that tree from the same cache contents in the same refresh).

## Notable Behavior

- **Lazy expansion in this surface is UI-only.** Despite the row-flag contract distinguishing repository rows from branch-folder rows, the tree-model build precomputes every descendant of every repository — files, branch folders, and nested sub-trees — eagerly, before the model swaps onto the UI dispatcher. The IDE's tree component then only lazily renders rows whose parents are expanded. A repository with thousands of memories pays the full enumeration cost on every refresh; the rendering deferral is not a fetch deferral. **The transport half of that cost is gone**: the manifest and index reads inside the per-repository loop are now native (spec 314), so a refresh pays the KB-root, initialize, reconcile and discovery calls once, and inside the loop only a heal call that the steady-state gate short-circuits (spec 315). What remains repository-count-scaled is the filesystem work — the full eager directory walk of every repository subtree — not the round-trips. (Notable; still contrasts with spec 175's VS Code sibling, which does defer fetching.)
- **Foreign repositories collapse on every refresh.** The expansion policy applies unconditionally per refresh: current-repository row expands, every other row collapses. A user who manually expanded a foreign repository to inspect a memory will see the row collapse the next time anything triggers a refresh (a virtual-filesystem event in the parent folder, a git operation, a status change). (Notable.)
- **Three "internal" directory names are filtered at the repository root only.** The literal names `summaries`, `transcripts`, and `plan-progress` are excluded from the repository's direct-child enumeration. These three are conventional reserved sub-trees that live as plain directories alongside the dot-prefixed hidden-metadata folder, and surfacing them would mix system content with user branches. The same names appearing one level deeper (inside a branch folder, for example) are not re-checked and would surface. (Notable; intentional asymmetry.)
- **The index-document base name is filtered only at the repository root file pass.** The literal file name `index.json` is dropped from the root-level file enumeration; a file by that name nested inside a branch folder would surface. (Notable.)
- **The "hidden children" set hides squash-superseded entries, not the squash parent.** A squash that consolidates three commits into one promotes the parent commit's manifest row to visibility and pushes the three children into the hidden-children set. The result is a tree showing only the squash representative — but the three children are still on disk and still in the manifest, so an external consumer that reads the manifest directly will see them. (Notable.)
- **The hidden-children set is recomputed every refresh.** A re-amend that breaks the parent-commit relationship surfaces the children again on the next refresh without any explicit invalidation step. (Notable.)
- **The classification badge map collapses one source type (`commit`) to a different letter (`C`).** Other types pass through unchanged. A future manifest type that this map does not enumerate yields an empty-string badge. (Notable; intentional graceful degradation.)
- **The badge is computed and never shown, and it is load-bearing anyway.** The renderer stopped drawing the letter glyph, so the map's three letters are invisible to the user — but `C` is still the predicate that decides whether a double-click opens the memory viewer or the plain host editor, and whether the context menu's memory action is enabled. A change to the badge map is therefore a change to *dispatch*, not to appearance, which is the opposite of what its name suggests. (Notable; the name outlived the rendering.)
- **Manifest title takes priority over the on-disk basename for the display label.** A file whose manifest entry carries a title shows that title in the tree; the file's actual filename is never displayed for those rows. A user who renames the file on disk without going through this panel will not see the new filename in the tree until either (a) the reconcile pre-pass updates the manifest entry to point at the new path or (b) the manifest title is cleared. (Notable.)
- **The KB-root resolution sequence initializes the hidden-metadata folder if absent.** On the first refresh after the panel is added to the IDE, the current project's KB root is created if it doesn't exist, and its configuration document is written with the project's recorded remote URL and recorded name. This is a write side-effect of opening the tool window; uninstalling or moving the IDE configuration does not roll it back. (Notable; intentional eager initialization.)
- **Two refresh triggers, virtual-filesystem and git-repo-change, are wired in series.** The git-repo-change handler does not call refresh directly; it requests a virtual-filesystem refresh whose completion callback calls panel refresh. This works because the same VFS-changes listener is what would have noticed the git operation's file writes anyway — wiring git changes through VFS-refresh ensures we observe the writes the hook just made. The double-hop adds one round-trip but unifies the listener path. (Notable; intentional indirection.)
- **The virtual-filesystem listener only acts on create / delete / move events.** Content-changed events are deliberately ignored: a user editing a memory file in the host editor mutates content but does not change the tree's shape, and triggering a refresh on every keystroke would thrash. (Notable.)
- **The virtual-filesystem path predicate is a prefix match against the parent folder.** A virtual-filesystem event for a file deep inside any discovered repository (or any user-created subdirectory of the parent folder) triggers a refresh of every repository, not just the changed one. The refresh is the unit of recomputation; per-repository deltas are not tracked. (Notable.)
- **Concurrent refreshes are unsynchronized, and each now costs a full round of cross-process calls.** Two refresh triggers firing in rapid succession can both start the refresh sequence on worker threads. Both reload the shared cache (last write wins on the volatile reference), both rebuild a tree model, both schedule a UI-dispatcher swap. The dispatcher serializes the swaps; the later swap wins. There is no debounce or coalesce step. Because every metadata read is delegated, the duplicated work is no longer merely redundant filesystem I/O — it is a duplicated set of subprocess/daemon round-trips, including a duplicated reconcile *write* against the manifest. Two overlapping refreshes therefore issue two concurrent reconcile passes over the same manifest. (Notable.)
- **The default parent folder is the last locally-computed path.** When no Memory Bank folder is configured, the fallback parent directory is still computed in-process by this surface. Every path derived from it — the KB root, the hidden-metadata folder, the per-repository subfolders — comes back from the command-line surface. A divergence between the two sides' notion of the default parent would therefore surface as a panel that initializes one folder and enumerates another. (Notable.)
- **Selection preservation across refresh is by on-disk path equality.** A file moved between branch folders during a refresh loses its selection because the captured path no longer matches any new-model node's path; a file whose row's display title changed but whose path is the same retains selection. (Notable.)
- **The empty-state message replaces the tree body, not the tree.** A subsequent non-empty refresh recreates the tree from scratch rather than re-adding rows to an existing tree instance. The "lost tree" code path lets the build sequence operate on a clean slate and avoids subtle row-merging bugs. (Notable.)
- **The error-state messages use different prefixes for initial-load vs refresh failures.** Initial load prefixes with `Error:`; refresh prefixes with `Refresh error:`. The distinction is intentional so debugging can attribute a stuck panel to one path or the other. (Notable.)
- **The build sequence tolerates per-directory enumeration failures.** A directory whose contents cannot be enumerated (permission denied, transient I/O error) is logged and skipped — the build does not propagate. The repository row still appears with whatever other branch folders enumerated successfully. (Notable.)
- **The reset action schedules a refresh only on success.** A reset that throws midway through the migration leaves the panel showing the pre-reset tree. The user must trigger another refresh path (any of the four) to see the post-failure state. (Notable.)
- **The tool window's refresh icon is the reset action, not a refresh action.** The reset action label is "Reset — re-migrate from orphan branch"; clicking it re-runs the one-shot migration, not just a refresh. A pure-refresh action does not exist in this panel; refresh is implicit in every trigger. (Notable; user-visible terminology surprise.)
- **Reset is a two-part handshake with the command-line surface, and the parts can come apart.** The panel writes the pending marker first and launches the migration command second. If the command never runs (missing runtime, spawn failure) the marker stays `pending` on disk, and the next start of any surface that consults it will run the migration on its own. The panel neither reads that marker back nor clears it.
- **The KB-root resolution's write side-effect is now a delegated write.** The initialize step still creates the current project's KB root and writes its configuration document on the first refresh, but it does so through the command-line surface. A missing runtime therefore turns "opening the tool window quietly initializes the folder" into "opening the tool window shows an error message" — the eager initialization is no longer independent of the delegated transport. (Notable.)
- **The cache is panel-wide singleton state, not per-panel-instance state.** Two tool windows hosting two panel instances against the same IDE process would share the same discovery cache. This is consequence of the discovery cache being implemented as an object-level singleton rather than as a per-panel field. In practice the IDE only hosts one such tool window per project, so the singleton-vs-per-instance distinction is academic. (Notable.)
- **The drag-and-drop, context-menu mutations, and timeline view share the same refresh helper.** Any user-initiated mutation that this panel exposes routes its post-action refresh through the same worker-thread-scheduling helper as the listener paths. There is no separate "after-mutation" path; the refresh sequence is the unit of "make the tree consistent with disk". (Notable.)
- **Foreign-repository rows still resolve their memory viewer correctly.** A foreign-repository row's children carry the owning-repository-root field, so a double-click on a memory file there opens that repository's cold-store summary document — not the current repository's. The memory viewer also flips to read-only when the owning root differs from the current root, preventing cross-repository edits. (Notable.)
- **Opening a memory from this tree replaces whatever memory was already showing.** All memory opening now goes through the shared single-memory-tab opener, which allows at most one memory tab per project. So a double-click here does not add a tab — it takes over the existing one, including when the reader was in the middle of an *editable* memory of their own, and including flipping that tab read-only for a foreign repository's memory. Side-by-side comparison of two memories is not possible from this panel (or any other). (Notable; a consequence the tree's "browse many repositories" framing does not suggest.)
- **The status listener uses a single shared callback object, not a fresh closure per registration.** On disposal, the panel removes the exact same callback object it registered at construction, so the service's listener list stays clean across panel show/hide cycles. (Notable; pinned regression.)
- **The renderer's repository-row icon and font-weight branching reads two row flags together.** The icon switches based on `is-repo-root` alone, but the font-weight switches based on `is-current-repo`. A refresh that propagates `is-repo-root` without `is-current-repo` would silently regress the current-repository emphasis. (Notable; intentional triple lookup.)
- **Path strings inside the tree model are platform-native.** The tree uses absolute on-disk paths verbatim; on Windows these contain backslashes. The relativization helper that computes manifest-lookup keys explicitly normalizes backslashes to forward slashes so the manifest's stored paths (forward-slash form) match. The same normalization is not applied to the tree's stored path strings — they remain platform-native — so any string-equality check against the tree's path strings must use the platform's separator. (Notable.)

## Shared Behavior

- **The parent folder location, repository-discovery rules, repository-identity matching against the current project, the collision-suffix allocation, the per-repository hidden-metadata folder, the manifest's schema and atomic-write semantics, the projected-index document, and the per-branch folder transcoding** are defined by spec 151 (memory bank folder layout). This panel consumes that contract at the discovery and manifest-read boundaries only.
- **The folder-based summary storage layer's manifest, index, branches registry, and reconcile pipeline** are defined by the folder-based summary storage spec; this panel calls into the reconcile pipeline as a single black-box pre-pass.
- **The memory-viewer that opens when a memory row is double-clicked** (its layout, its read-only mode, its summary-document parsing) is defined by a separate spec, as is the shared single-memory-tab opener this panel hands the parsed summary to — including the one-tab-per-project rule, the in-place content-and-read-only swap, and the stale-tab-title consequence.
- **The migration that the reset action triggers** (source-of-truth reader, folder-mirror writer, migration-state document, the decision to run at all) is owned entirely by the command-line surface's one-shot migration command. This panel contributes only the pending marker and the launch.
- **The knowledge-wiki build button on this panel's toolbar** is owned by spec 216; it too is a single delegated call to the command-line surface, and it forces a recursive virtual-file refresh of the Memory Bank root on success — a refresh which in turn trips this panel's virtual-filesystem trigger.
- **The delegated transport itself** (how a request reaches the command-line surface, the daemon-first / one-shot-fallback behavior, and the timeouts) is owned by the IDE-delegation spec. This panel's observable coupling to it is that the remaining delegated calls — KB-root resolution, initialize, reconcile, discovery, heal, and the reset action's migration-state write — can fail as a transport error and surface as the panel's generic error message. The manifest and index reads no longer participate in that failure mode.
- **The native manifest and projected-index reader** (spec 314) owns the whole-file read, the decode, the absence-and-malformed handling, the deliberate lack of an out-of-sync gate, and the cross-language schema lockstep it creates with the command-line surface's metadata writer. This panel is one of its two consumers; the sidebar's flattened-entry cache is the other.
- **The visible-layer heal pass's per-repository gating** (spec 315) — the clean-set short-circuit and the failure cooldown that keep a dead delegation from producing one timeout per repository per rebuild — is owned there; this panel owns only the position of the call inside the per-repository loop.
- **The repository-scope filter** (spec 316) decides which discovered repositories the per-repository loop iterates. This panel treats that list as an input.
- **The drag-and-drop, context-menu mutation actions, and the timeline view** that share this panel's refresh helper are defined by separate specs.
- **The sibling VS Code Memory Bank Folder Browser** (spec 175) covers the same surface for the VS Code extension. The two diverge on lazy expansion (VS Code defers child fetches, this panel precomputes); on classification (VS Code surfaces `wiki` as a separate kind, this panel collapses it into "no badge"); on the "is-diverged" flag (VS Code computes per-file fingerprint divergence, this panel does not surface divergence at all). **Two former divergences have closed**: this panel now runs the heal pass as well as reconcile (spec 315), and it now reads the manifest natively exactly as VS Code does (spec 314). One divergence went the other way: VS Code renders a classification glyph per row, this panel no longer renders one at all. Behaviors common to both surfaces — manifest-derived display title, hidden-children-set construction, dotfile filtering, directories-first sort, current-repository auto-expansion — are described in both specs at the level of structural-flag contracts.
