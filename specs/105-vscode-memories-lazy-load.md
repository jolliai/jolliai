# VS Code Memories Tab Lazy Load and Pagination

## Topic Statement

The Memories tab fetches its first page of summary entries only the first time the user reveals the sidebar in an IDE window, with cross-panel watchers gated on a "has first-loaded" flag so a user who never opens Memories pays no listing cost on every commit, and once first-loaded the panel exposes a paginated list with a server-side text filter.

## Scope

**In scope:**
- The idempotent first-load gate that triggers the first bridge query.
- The "has first loaded" flag and which subscribers are required to gate on it.
- The page-size constant (18 entries) and the cumulative count of entries currently loaded that grows on each Load More.
- The filter contract: the filter string is owned host-side; the bridge does the matching; pagination is suppressed while a filter is active.
- The capped result set when filtering (500 entries maximum) so a wildcard query doesn't unbounded-allocate.
- The snapshot fields that drive the panel's rendering (the loaded entries, the total count, the filter-active signal, the more-available signal, the empty-state signal, the first-load completion flag).
- The `jollimemory.memories.hasFilter` context key and what it gates.
- Disable semantics: every cached value is wiped including the first-load completion flag, so re-enable is a clean lazy slate.

**Out of scope:**
- The bridge's filter matching algorithm and its index lookups — owned by the storage topic.
- The summary panel that opens when the user clicks a memory row — separate topic.
- The Folders sub-mode of the KB tab — separate topic.
- The Memory Bank rebuild / migrate flows that may invalidate the underlying index — they are detected here only via the orphan-ref watcher refreshing on completion.

## Data Contracts

### Page size and search cap

| Constant              | Value | Meaning                                                                                                              |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| Page size             | 18    | Number of entries the first load and every Load More page request brings in.                                          |
| Maximum search result | 500   | When a filter is active, the bridge query asks for up to 500 entries in a single call (no pagination during search). |

### State held by the store

| Field                              | Meaning                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| The held entries                   | The currently held entries (loaded subset of the index).                                                                              |
| The total count                    | The total entry count reported by the bridge for the current filter (no filter = total summary count).                                |
| The count of entries currently loaded | The pagination cursor — starts at the page size, grows by the page size on each Load More, reset to the page size on disable.     |
| The filter string                  | The current filter string, trimmed of whitespace.                                                                                    |
| The enabled flag                   | The repository's enabled flag.                                                                                                       |
| The first-load completion flag     | The has-first-loaded flag — flips to true on the idempotent trigger that loads the first page if it has not yet been loaded and on any of the explicit refresh paths; reset to false on disable. |

### Snapshot shape

The store broadcasts a snapshot on every change:

| Field                          | Meaning                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| The held entries               | The same entries the store holds.                                                                             |
| The held-entries count         | The length of the held entries list.                                                                          |
| The total count                | The same total count the store holds.                                                                          |
| The filter string              | The same filter string.                                                                                        |
| The filter-active signal       | True when the filter string has non-zero length.                                                              |
| The more-available signal      | True when no filter is active **and** the count of entries currently loaded is less than the total count. Filtered results suppress pagination. |
| The empty-state signal         | True when the held entries list is empty.                                                                      |
| The enabled flag               | The enabled flag.                                                                                              |
| The first-load completion flag | The has-first-loaded flag.                                                                                     |
| The change reason              | One of: initialization, refresh, load-more, filter-change, or enabled-change.                                  |

### Per-row content

Each row carries:

| Field          | Meaning                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| The row id     | A stable per-row id of the form `memory-<commitHash>`.                                                            |
| The title      | The commit message subject.                                                                                       |
| The commit hash| The full commit hash — drives the row click (open the rich memory panel).                                         |
| The branch     | The source branch on which the commit was made.                                                                  |
| The repo name  | Source repository name (`repoName`). Equals the workspace basename for current-repo entries; for entries discovered under the Memory Bank parent that belong to another repo, it is that repo's name. The webview shows a repo badge on the row when the visible memories span more than one distinct repo. |
| The timestamp  | Commit date as ms since epoch.                                                                                   |
| The tooltip    | Plain-text multi-line tooltip with full metadata (commit message, relative date, commit type, branch, hash, stats). |
| The hover data | Structured display-ready fields the webview renders into a hover-card popup (mirrors the Commits tab's hover shape). |

The list is ordered newest-first by timestamp. The bridge returns entries in storage order; the host re-sorts by descending timestamp at the serialization boundary.

### Description string

The Memories tab section header surfaces a description derived from the snapshot:

| Condition                       | Description                              |
| ------------------------------- | ---------------------------------------- |
| Filter is active                | `"<query>" — N result(s)`                |
| No filter, total count > 0      | `N memories`                             |
| Otherwise                       | (no description)                         |

### Context key

`jollimemory.memories.hasFilter` is set to the snapshot's filter-active signal whenever the snapshot changes. Consumers:

- The clear-filter affordance is shown only when the key is true.
- The Load More row's visibility is gated on the inverse — it shows only when no filter is active and there are more entries to page in (i.e. when the more-available signal is true). Filter state is incompatible with Load More, so the filter-active signal indirectly hides Load More.

## Behavior

### Idempotent first-load gate

The store exposes an idempotent trigger that loads the first page if it has not yet been loaded. Its contract:

1. If the first-load completion flag is already true, return immediately. No bridge call, no snapshot rebuild.
2. Otherwise, set the first-load completion flag to true and run the standard bridge fetch (page-size entries, no offset, no filter).
3. The fetch's success or failure both leave the first-load completion flag true so subsequent calls are no-ops.

The gate fires from exactly one passive path: the sidebar's first-visibility trigger. It is plumbed through the sidebar provider's first-visibility dependency callback, which the sidebar provider itself calls at most once per webview lifetime.

### Cross-panel watchers gate on the first-load completion check

Two watchers are running in the background regardless of which tab the user has open:

- The orphan-summary-ref watcher — fires when the summary worker writes a new entry.
- The worker-lock watcher's release path — fires when the worker finishes (a fallback for missed ref watcher events).

Both watchers consult the first-load completion check before triggering a refresh on the Memories store. If the user has never opened Memories in this window, both watchers skip their Memories refresh entirely. This is the lazy-load contract's load-bearing guarantee: a user who works in a repo for an hour without ever clicking Memories does not pay an N-times-per-commit listing cost.

Active gestures bypass the gate:

- The explicit refresh button on the Memories section invokes the refresh entry point directly.
- The Enable command refreshes Memories eagerly alongside the other panels (the user has explicitly turned the feature on; deferring would create a confusing first-open lag).

### Refresh, load-more, set-filter

All three operations route through a single internal path that fetches from the bridge and rebuilds the snapshot exactly once with the appropriate change reason:

| Operation         | Effect                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Refresh           | Fetch with the current count of entries currently loaded (or 500 if a filter is active), rebuild snapshot with the refresh reason. |
| Load more         | Increment the count of entries currently loaded by the page size, then fetch and rebuild with the load-more reason. Filter must be empty for this to be wired (the webview only shows Load More when the description is "N memories"). |
| Applying a filter | Trim and store the new filter, then fetch and rebuild with the filter-change reason. Loading 500 (the cap) on filtered queries is one shot — no Load More while filtering. |

Each operation sets the first-load completion flag to true (refresh and load-more cannot run before the first load anyway; applying a filter can be called in any order but is treated as an active gesture).

A bridge fetch failure does not raise into the caller. The store catches, logs a warning, replaces the held entries with the empty list, sets the total count to zero, and emits the snapshot. The user sees an empty state instead of a stuck spinner.

### Filtering

The bridge owns the matching logic. The store passes the trimmed filter string and a count limit. There is no client-side filtering; the snapshot's held entries are exactly what the bridge returned for that filter.

While a filter is active:

- The more-available signal is forced to false (one-shot fetch up to the cap).
- The description string switches to the filtered form.
- The clear-filter affordance is shown.

Clearing the filter (the dedicated command) is equivalent to applying an empty filter, which routes through the same shared path with an empty filter — the bridge returns the standard pagination view and the count of entries currently loaded is preserved (the pre-filter pagination depth is restored).

### Disable

Disabling resets the store to a clean lazy slate:

- Held entries cleared, total count set to zero, filter string cleared.
- The first-load completion flag reset to false.
- The count of entries currently loaded reset to the page size.

The reset on the first-load completion flag is by design: re-enabling means the user must open Memories again to trigger the next fetch, just as if they had opened a fresh window. The reset on the count of entries currently loaded is also by design: a prior Load More session would otherwise carry its 36/54/… cursor (page size 18) across the disable boundary and request a needlessly large first page after re-enable.

### Open a memory row

Row click dispatches the rich memory panel for the commit hash. From the protocol's perspective this is the typed `kb:openMemory { commitHash }` outbound, which the host routes through the dedicated view-memory command. The Memories store is not involved beyond having shipped the row.

## State Transitions

```
[Activation]
   first-load completion flag = false, count of entries currently loaded = pageSize, held entries = [], filter = ""

[Sidebar first visibility (one-shot)]
   The idempotent first-load trigger fires:
     if the first-load completion flag is true: return
     set the first-load completion flag to true
     fetch(count = pageSize, offset = 0, filter = none)
     emit with the refresh reason

[Orphan-ref watcher fires]
   if the first-load completion check is true: refresh; else: skip

[Worker-lock release fires]
   if the first-load completion check is true: refresh; else: skip

[Active "Refresh" button]
   refresh unconditionally

[Active "Enable" command]
   refresh unconditionally (alongside other panels)

[Load More row clicked]
   count of entries currently loaded += pageSize
   fetch and emit with the load-more reason

[Search query typed]
   filter ← trimmed query
   fetch up to the search cap (500) and emit with the filter-change reason

[Clear filter]
   apply an empty filter → returns to paginated view, count of entries currently loaded preserved

[Disable]
   held entries ← [], total count ← 0, filter ← "", first-load completion flag ← false, count of entries currently loaded ← pageSize
   emit with the enabled-change reason
```

## Notable Behavior

- **The lazy-load gate is the contract's load-bearing guarantee.** Without it, every commit in the user's normal workflow would wake the bridge for a listing the user is never going to look at. The gate is the difference between "Memories panel works on demand" and "Memories panel is a tax on every commit".
- **The idempotent first-load trigger is idempotent — once true, always true (within the window).** Even if the bridge call fails, the first-load completion flag flips to true. The user can still retry by clicking the Refresh button (active gesture, bypasses the gate).
- **Active vs. passive triggers are explicit.** Active = user gesture (Refresh, Enable, opening the panel for the first time). Passive = background watchers and cross-panel reactions. Only active triggers are allowed to wake the bridge before the user has opened the panel. Passive triggers must consult the first-load completion check.
- **The page size and cap are constants in the store, not configurable.** A user with thousands of memories who searches for a common token sees up to 500 results in one shot; the rest are unreachable from the search box (they would require either a more specific query or scrolling past Load More with the filter cleared).
- **Pagination is suppressed during search.** The bridge returns the matched entries (up to the cap) in one fetch; there is no "load more results" while a filter is active. Clearing the filter restores the pre-filter pagination depth (the count of entries currently loaded is not reset by applying a filter).
- **The total-count is per-fetch, not cached across fetches.** Each fetch overwrites both the held entries and the total count with whatever the bridge returned, including for filtered queries (where the total count is the count of matched entries within the cap).
- **The webview re-sorts by descending timestamp at serialization time.** The bridge's storage order is not assumed; the row order is canonical only after the descending-timestamp sort.
- **A failed bridge fetch resets to empty rather than surfacing an error.** The user sees the empty state, not an unactionable error. The next active gesture retries.

## Shared Behavior

- **Sidebar message protocol** — the route the data, lazy-load trigger, search command, and Load More command flow through.
- **Activation lifecycle** — wires the lazy-load callback to the sidebar's first-visibility event.
- **Orphan-summary-ref watcher and worker-lock release** — the two passive triggers that must consult the first-load completion check.
- **AI summary storage / index** — producer of the entries returned by the bridge.
- **Memory rich-panel viewer** — consumer of the row-click event.
- **Memory Bank rebuild / migrate** — destructive paths whose post-completion `kb:foldersReset` does not directly touch this store; the orphan-ref watcher carries any structural change through to a refresh once the user has first-loaded.
