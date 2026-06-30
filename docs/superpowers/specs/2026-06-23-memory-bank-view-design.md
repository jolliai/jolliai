# PR3 — Memory Bank View — Design Spec

**Date:** 2026-06-23
**Surface:** VS Code extension sidebar **Memory Bank** view (`navView('bank')`) — the Tree + Timeline modes and the shared repo selector.
**Baseline:** updated mockup `sidebar-redesign(3).html` (Memory Bank view), refined by review decisions below.
**Builds on:** PR1 (three-view shell), PR2 (Current Branch view). Parent spec: [2026-06-22-sidebar-ux-redesign-design.md](2026-06-22-sidebar-ux-redesign-design.md).

---

## 1. Goal & scope

Fill out the **Memory Bank** view to the updated mockup. The mockup's Memory Bank is memory-centric (repo → branch → memory → evidence), but two review decisions narrow the scope from a full rewrite to a focused, low-risk change:

- The **Tree stays the current on-disk file tree** — no memory-node evidence expansion (decision below). The only Memory-Bank structural change lands in **Timeline**.
- The **Timeline gains per-memory evidence nesting** + time grouping.
- A **shared repo selector** replaces the breadcrumb on Memory Bank (and, later, Knowledge).

**Out of scope (deferred, by decision):**
- **Token meter** (the "33M tokens" segmented bar with repo/branch/all aggregation) — a separate later PR; it is a new cross-memory token-aggregation pipeline reused by both Memory Bank and the detail pane.
- **"Open in larger view"** editor-area panes for Tree/Timeline (`pane-timeline` etc.) — later.
- **Per-memory Share** affordances (mockup shows "Share memory" on rows) — owned by the dedicated Share PR (parent spec).

**Frozen:** `FolderStorage`/`KbFoldersService` disk layout, the orphan branch, the Current Branch view (PR2), command ids / handler names, storage/hooks/sync.

### Review decisions (confirmed)

| Decision | Resolution |
|----------|------------|
| Tree memory nodes expand to show conversations/context/files? | **No.** The Tree is unchanged — it stays the on-disk `.md` file tree. |
| Where does Timeline evidence data come from? | Reuse the **SummaryStore** data the detail panel (`SummaryWebviewPanel`) already computes — no new pipeline. |
| Token meter / larger-view panes / per-row Share? | Deferred (see scope). |

---

## 2. Tree mode — unchanged

The Tree (`renderFolders` driven by `KbFoldersService`) stays exactly as today: `repo → branch → file` of the on-disk Memory Bank, preserving every current capability — the diverged "edited on disk" ✎ marker, **Revert to System Version**, open-the-`.md`-file, the per-repo **View knowledge graph** action, lazy `kb:expandFolder` loading, and the diverged/reset messages (`kb:markDiverged` / `kb:clearDiverged` / `kb:foldersReset`).

Memory-kind file nodes remain **leaf nodes** (clicking opens / views that memory). They do **not** gain a twirl or nested evidence. Plan/note file nodes are unchanged.

This PR makes **no change** to the Tree beyond what the shared repo selector (§4) implies for the header.

---

## 3. Timeline mode — per-memory evidence nesting + time grouping

The Timeline (`renderMemories`) keeps its memory list + `kb:loadMore` paging, with two additions:

- **Time grouping headers** — memories render under relative-time group labels (TODAY / YESTERDAY / EARLIER THIS WEEK / older), derived from each `MemoryItem.timestamp`. Pure presentation over the existing item list.
- **Expandable evidence** — each memory row gets a twirl; expanding it lazily loads and renders the memory's evidence as three labelled sub-groups: **Conversations**, **Context** (plans / notes / references), **Files** (changed source files). Collapsed by default; expansion state is per-session (mirrors the Branch view's `commitsExpanded` pattern). Evidence rows reuse the existing open commands:
  - conversation row → opens `ConversationDetailsPanel`,
  - plan / note row → opens its preview,
  - file row → opens the diff,
  - (these are the same commands the Current Branch / detail-pane evidence rows already dispatch).

Empty / failed-summary memories show no evidence groups (or a single muted "no evidence" line), consistent with how the detail pane handles a missing summary.

---

## 4. Shared repo selector (Memory Bank + Knowledge)

The header's repo/branch **breadcrumb** is contextual to the active view:

- **Current Branch** → the existing `repo / branch` breadcrumb (unchanged from PR1/PR2).
- **Memory Bank** (and Knowledge, in PR4) → a **"Showing: <repo>"** selector — `All repos` or a specific repo — driving which repos the Tree/Timeline shows.

The swap is class-driven off the active view (mockup: `body.nav-bank` shows the repo filter and hides the branch segment). The repo list reuses the existing `selection:repos` enumeration the breadcrumb dropdown already consumes; picking a repo filters the Memory Bank content. "All repos" is the default. This is shared chrome that PR3 introduces (PR3 is first); PR4 reuses it for Knowledge.

---

## 5. Data & message protocol

Only the Timeline evidence is net-new plumbing:

- **Outbound:** `{ type: "kb:expandMemory"; repoName: string; branchName: string; commitHash: string }` — sent when the user expands a Timeline memory whose evidence isn't cached.
- **Inbound:** `{ type: "kb:memoryEvidence"; commitHash: string; conversations: …; context: …; files: … }` — the host's response, built from the **same SummaryStore read** the detail panel uses, projected to the minimal display shape the Timeline rows need (reuse existing `SerializedTreeItem`-style shapes / `MemoryHover` where they fit; do not invent a parallel evidence type if an existing one fits).
- The client caches evidence per `commitHash` and follows the established lazy "request on cache-miss, render Loading until response" pattern (same shape as `kb:foldersData` / `branchMemoriesCache`), including a trigger on every entry path (init/expand/refresh) per the lazy-protocol convention.

The repo selector reuses `selection:repos` (no new message); filtering by repo re-requests the Timeline/Tree feed for the selected scope through the existing refresh path.

---

## 6. Testing

- Sidebar builders (`SidebarHtmlBuilder` / `SidebarScriptBuilder` / `SidebarCssBuilder`) are tested by asserting on the generated string + the `new Function(...)` parse smoke test (the established pattern). Assertions: Timeline emits time-group labels + a `renderMemoryEvidence` path + `kb:expandMemory`; the repo selector markup swaps on `nav-bank`.
- The host evidence builder (`kb:expandMemory` → `kb:memoryEvidence`) gets unit tests in the provider's existing harness (mirror an existing handled-message test). It lives in `vscode/src` (no cli coverage gate), but the suite must pass.
- The Tree is asserted **unchanged** (no new evidence markup under memory file nodes).

---

## 7. Confirmed design decisions

- **Tree unchanged**, evidence nesting only in Timeline. *(Approved.)*
- **Evidence sourced from SummaryStore** (the detail-pane data), no new pipeline. *(Approved.)*
- **Timeline time grouping** done this PR (pure rendering). *(Approved.)*
- Token meter, larger-view panes, per-row Share deferred. *(Approved.)*

## 8. Open items

None.
