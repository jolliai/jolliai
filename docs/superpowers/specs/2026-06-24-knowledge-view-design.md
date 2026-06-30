# PR4 — Knowledge View — Design Spec

**Date:** 2026-06-24
**Surface:** VS Code extension sidebar **Knowledge** view (`navView('knowledge')`) — replaces the PR1 "coming soon" stub.
**Baseline:** updated mockup `sidebar-redesign(3).html` (Knowledge view), refined by review decisions below.
**Builds on:** PR1 (three-view shell, Knowledge stub), PR2 (Current Branch view), PR3 (Memory Bank view + shared repo filter). Parent spec: [2026-06-22-sidebar-ux-redesign-design.md](2026-06-22-sidebar-ux-redesign-design.md).

---

## 1. Goal & scope

Fill the **Knowledge** view with the mockup's in-sidebar, repo-grouped **wiki**: an Overview entry, a single Knowledge-graph entry, and a `repo → category → topic` tree compiled from the topic-KB. This lands the two parent-spec Knowledge deltas:

- **④a** — the graph is a **single artifact reached from one entry** (the "Knowledge graph" row), not a sidebar graph-list mode.
- **④b** — the wiki is **grouped by repo** at the top level (mirroring Memory Bank), each repo expanding to its categories → topics.

**Reuses (no rebuild):**
- **Knowledge graph** → the existing `jollimemory.viewKnowledgeGraph` command / `KnowledgeGraphPanel` (one panel per repo).
- **Build / Rebuild** → the existing `jollimemory.compileNow` command / `CompileCommand` (compiles the topic-KB → `_wiki/`).
- **Repo filter** → the shared "Showing: <repo>" selector built in PR3 (shown on Knowledge too).

**Out of scope (deferred, by decision):**
- The editor-area **full-wiki webview panes** (`pane-wiki` two-pane reader, `pane-wiki-topic` rendered topic page) — topics and Overview open the **on-disk `.md` files** instead (decision below).
- **Per-row Share** ("Share wiki / graph to Jolli") — owned by the dedicated Share PR; the mockup marks these FUTURE.
- **Token meter** (deferred repo-wide, same as PR3).

**Frozen:** Current Branch view (PR2), Memory Bank view (PR3), the Tree (`renderFolders`), `KnowledgeGraphPanel`, `CompileCommand`, command ids / handler names, storage/hooks/sync.

### Review decisions (confirmed)

| Decision | Resolution |
|----------|------------|
| How do topics / Overview open? | **Open the on-disk `.md` files** — `_wiki/topic--<stableSlug>.md` for a topic, `_wiki/_index.md` for Overview. Defer the editor-area wiki webview panes. |
| Category descriptions in the tree? | Render the description **if** the topic-KB index carries one; otherwise show just the category name + counts. No new data pipeline. |
| Graph entry / Build / repo filter? | Reuse existing (`viewKnowledgeGraph`, `compileNow`, PR3 repo filter). |

---

## 2. Knowledge view structure (`renderKnowledge`)

Replace the stub with:

- **Header row** — "Built from N memories" + a **Rebuild** icon (→ `jollimemory.compileNow`). The shared **repo filter** ("Showing: <repo>", PR3) is shown on this view (the same view-driven swap that PR3 added for Memory Bank — extend it to `activeTab === 'knowledge'`). A **"Search topics & decisions…"** box filters the loaded tree client-side by query.
- **Overview row** (book icon) → opens `_wiki/_index.md` for the active repo (via the existing open-file path).
- **Knowledge graph row** (graph icon) → `jollimemory.viewKnowledgeGraph` (single entry — ④a). When a specific repo is filter-selected, pass that repo; otherwise the current repo.
- **Wiki tree** (④b): top level is **repos**; expanding a repo shows its **categories** (collapsible, with the category name, a memory/topic count, and the optional description); expanding a category shows its **topics** (title + memory count). Clicking a topic opens `_wiki/topic--<stableSlug>.md`.
- **Empty state (`nowiki`)** — when the active repo has no compiled wiki, show a "Build Knowledge Wiki" CTA (→ `jollimemory.compileNow`) instead of the tree.

Categories/topics expansion state is per-session (mirror the Memory Bank tree's collapse-state pattern).

---

## 3. Data & message protocol

- **Inbound:** `{ type: "kb:knowledgeData"; repos: ReadonlyArray<KnowledgeRepo> }` where a `KnowledgeRepo` is `{ repoName, memoryCount, categories: KnowledgeCategory[] }`, a `KnowledgeCategory` is `{ name, description?, topicCount, memoryCount, topics: KnowledgeTopic[] }`, and a `KnowledgeTopic` is `{ title, stableSlug, memoryCount }`. **Eager** push (the topic-KB is small — dozens of topics).
- **Outbound:** a refresh trigger reusing the existing refresh path; opening a topic/overview uses the existing open-file command with the resolved `_wiki/...` path.
- **Host source:** read the **topic-KB index** (`TopicIndex` via `TopicPageStore`, `cli/src/core/TopicKBTypes.ts` / `TopicPageStore.ts`) per repo under the Memory Bank parent, projected to the `KnowledgeRepo[]` shape. `description` is populated only if the index/category metadata carries one. Repo enumeration reuses the same `selection:repos` repo list the filter already consumes.
- Reuse the established lazy/eager render conventions; the tree re-renders on `kb:knowledgeData` and on repo-filter change.

---

## 4. Testing

- Sidebar builders tested by asserting on the generated string + the `new Function(...)` parse smoke test (established pattern): `renderKnowledge` emits the Overview + Knowledge-graph entry rows, the repo→category→topic structure, the `nowiki` empty CTA, and the `kb:knowledgeData` handler; the repo filter shows on the knowledge view.
- The host knowledge builder (`kb:knowledgeData` from `TopicIndex`) gets unit tests in the provider's harness (mirror an existing handled-message/data-push test). Lives in `vscode/src` (no cli coverage gate); the suite must pass.
- The graph-entry / Build actions are asserted to dispatch the **existing** `jollimemory.viewKnowledgeGraph` / `jollimemory.compileNow` commands (no new command).

---

## 5. Confirmed design decisions

- **Topics / Overview open the on-disk `_wiki/*.md` files**; the editor-area wiki webview panes are deferred. *(Approved.)*
- **Category description rendered only if present** in the topic-KB index; no new pipeline. *(Approved.)*
- **Graph = single entry** reusing `viewKnowledgeGraph` (④a); **wiki grouped by repo** (④b); Build reuses `compileNow`; repo filter reuses PR3. *(Approved.)*
- Full-wiki panes, per-row Share, token meter deferred. *(Approved.)*

## 6. Open items

None.
