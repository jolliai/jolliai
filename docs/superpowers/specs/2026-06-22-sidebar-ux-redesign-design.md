# Sidebar UX Redesign — Design Spec

**Date:** 2026-06-22
**Surface:** VS Code extension sidebar (`jollimemory.mainView`) + its full-screen detail panes
**Baseline:** `jolli-memory-vscode-mock.html` (the redesign mockup) refined by review feedback
**Scope:** The whole redesigned sidebar — three persistent views + shared panes — captured self-contained. The mockup encodes the broad redesign; this spec is the design of record, with the review-feedback deltas folded in and marked **Δ**.

---

## 1. Goal & context

The sidebar is being reorganized from the shipped three-tab layout (Branch / Memory Bank / Status) into three persistent **views** — **Current Branch**, **Memory Bank**, **Knowledge** — plus a set of full-screen editor-column detail **panes** opened via `showPane()`. This spec describes the target information architecture (IA) for each view and the shared Memory detail pane, and folds in five feedback-driven changes the reviewer raised against the mockup.

This is a **presentation-layer redesign**. The parity rule from the mockup holds: every element id and message/command handler is preserved — what the sidebar advertises is exactly what its detail pane shows. No storage, hook, or capture-pipeline behavior changes.

### Feedback deltas folded into this spec

| # | Area | Change |
|---|------|--------|
| ①a | Current Memory | Remove the full-screen "Current Memory — preview" pane and its launch icon; the sidebar's Current Memory section is itself the editable list. |
| ①b | Memory detail panes | Remove the **🔒 Private Transcripts** section entirely (it duplicates Conversations). |
| ①c | Conversations (everywhere) | Remove the **+ Attach / Attach** action (manually attaching a conversation is not feasible). |
| ② | Committed Memories | Add per-row select/unselect + select-all + a "Squash N" action for squashing. |
| ③a | Memory Bank | _Deferred — dedicated Share PR._ Add a **Share** action on each memory row (share a single memory to Jolli). |
| ③b | Memory Bank | _Deferred — dedicated Share PR._ Remove **Share Memory Bank…** (sharing the entire personal bank is not appropriate). |
| ③c | Memory Bank | Remove **Export** and **Export tree…** (the bank is already folders + Markdown on disk). |
| ④a | Knowledge | Remove the sidebar **graph-list mode**; keep the wiki only. The graph is a single full-screen artifact reached from an entry. |
| ④b | Knowledge | Group the wiki by **repo** at the top level (mirroring Memory Bank), since each repo has its own wiki. |

> **Share is out of scope for this redesign.** All Share-related work — the per-row Share (③a), removing **Share Memory Bank…** (③b), and the existing Share button / Jolli "Share in Jolli" affordances in the Memory detail pane — is owned by a separate, dedicated Share PR. This redesign does not add, remove, or change any Share surface; the items above are recorded so that PR has the context. Export removal (③c) is unrelated to Share and stays in scope.

---

## 2. Global shell (unchanged from mockup)

- **Frozen header bar** — `Jolli Memory` title, Settings ⚙ button (`openSettings`), Status ⏻ button (`toggleOverlay('status')` with the warning dot). Unchanged from the current extension.
- **Persistent view switch** — three buttons: `Current Branch` (`navView('current')`), `Memory Bank` (`navView('bank')`), `Knowledge` (`navView('knowledge')`).
- **Per-view layout** — each view owns a toolbar, scrollable content, and a bottom command bar.
- **Detail panes** — all detail/edit surfaces open as full-screen panes in the editor column via `showPane(id, title)`. The sidebar never inlines a full document.

---

## 3. Current Branch view

Sections in order: **Pinned → Current Memory → Committed Memories**. Bottom command bar: `Commit | Create PR | ⋯`.

### 3.1 Pinned
Quick-access list of pinned conversation / plan / memory items. Clicking a row opens the relevant pane.
- **Δ ①c** No Attach affordance on any pinned row.

### 3.2 Current Memory — the editable draft of the next commit
The set of conversations, context items, and files that the next **Commit Memory** will capture. Three labelled sub-sections, every row carrying an include checkbox:

- **Conversations (N)** — captured AI sessions, each with a checkbox + message count. `Show N more` reveals the tail. Unchecking excludes a conversation from the next memory (shown struck-through + `excluded`).
- **Context (N)** — plans / notes / snippets / detected references (Linear / GitHub / Jira / Notion), each with a checkbox. Retains the **+ Add** menu (Add Plan / Markdown Note / Text Snippet) — these are user-authored additions and stay.
- **Files (N)** — changed files with a checkbox + the rationale line; unchecked files show `won't commit`. A `View diff` link opens `pane-diff`.

**Δ ①a — remove the full preview.** Delete the "Open the full memory in an editor tab" icon next to the Current Memory heading and the full-screen `pane-working` it opened. Rationale: `pane-working` reproduced these same three checkboxed sub-sections in a larger view — pure duplication. The sidebar section is the editable surface; include/exclude is the inline checkbox state. Commit happens from the bottom command bar's `Commit` button.

**Δ ①c — remove Attach.** Delete the `+ Attach` / `Attach` action and the "N conversation(s) not attached" affordance from the Conversations sub-section. Capture is automatic; there is no manual attach.

### 3.3 Committed Memories — read-only, AI-generated
List of committed memories for the current branch (title, icon, time · hash). Each row expands to reveal nested children where present; clicking opens the `pane-memory` detail pane.

**Δ ② — squash selection.** Add to this section:
- A **checkbox** on every memory row.
- A section-toolbar **select-all / select-none** control.
- A **Squash N** action, enabled only when ≥ 2 rows are selected (consistent with the existing `jollimemory.squash` gate), plus a **Cancel** to clear the selection.

The Squash action drives the existing squash-consolidation flow; this delta is purely the missing selection affordance in the redesigned section.

---

## 4. Shared Memory detail pane (`pane-memory` / `pane-memory-local` / `pane-memory-synced`)

Opened from Committed Memories rows and from Memory Bank rows. The mockup's "parity rule" applies: every item the sidebar row advertises appears here.

Section order:
1. **Title row** — commit message, `hash` chip, `branch` chip, time, `Details` disclosure, **Share** button (top-right).
2. **Hero cards** — **Pull Request** (state chip + `View PR` / `Create PR…`) and **Jolli** (sync state chip + `Open in Jolli` when synced, or `Share in Jolli` when not).
3. **MEMORY** — the AI recap / summary.
4. **E2E Test Guide** — when present.
5. **Conversations (N)** — captured sessions; each row's `Show` / `Continue` opens `pane-convo`.
6. **Context (N)** — plans / notes / references; **+ Add** retained.
7. **Files (N)** — changed files with `M`/status markers; `View diff`.

**Δ ①b — remove Private Transcripts.** Delete the **🔒 Private Transcripts (N)** section (the "stored locally — click to expand" drawer) from all three memory panes. Raw transcript access is via the Conversations rows' `Show` / `Continue` → `pane-convo`. This removes the top-Conversations / bottom-Private-Transcripts duplication.

**Δ ①c — remove Attach.** Delete the `+ Attach` action from the Conversations section header in all memory panes.

The top-row **Share** button and the **Jolli** hero card's `Share in Jolli` / `Open in Jolli` are Share-surface elements owned by the dedicated Share PR (§1) — this redesign leaves them as-is and does not change their behavior.

---

## 5. Memory Bank view

`All repos ▾` selector + `SYNCED …` status indicator + toolbar icons; a `Search memories…` box; a tree: `repo → branch → memory → (Conversations / Context / Files)`. Bottom command bar.

- **③a — per-row Share — _deferred._** A per-memory **Share in Jolli** affordance is the intended end state, but it is owned by the dedicated Share PR (see §1). This redesign does not add it.
- **③b — remove Share Memory Bank — _deferred._** The `Share Memory Bank…` action stays as-is for now; the Share PR owns the share-surface rework (including dropping the bank-wide share). This redesign does not touch it.
- **Δ ③c — remove Export.** Delete the toolbar `Export tree…` action and the bottom command-bar `Export` action. Rationale: dual-write already writes human-browsable Markdown into the local Memory Bank folder, so in-place browsing/copy covers the need; a separate export is redundant. The bottom command bar becomes **`Sync | ⋯`** (Refresh stays as the existing toolbar refresh icon).

Toolbar retains (unchanged by this redesign): repo selector, sync-state indicator, `Share branch…`, `Share Memory Bank…` (until the Share PR), `Sync to Personal Space`, `Refresh Memory Bank`. Tree mode toggles (Tree / Timeline) are unchanged.

---

## 6. Knowledge view

The compiled wiki for the user's memories. Toolbar: `All repos ▾`, `BUILT FROM N MEMORIES`, `Build / Rebuild Knowledge`, refresh, and the graph entry (below). A `Search topics & decisions…` box. Content: per-repo wiki trees.

- **Δ ④a — remove the graph-list mode.** Delete the wiki/graph segmented toggle (`knView('wiki'|'graph')`) and the graph mode that re-rendered the topic tree as a list of `kgFocus(...)` rows. The sidebar shows **only the wiki**. The knowledge **graph** is a single full-screen artifact (`pane-graph`) reached from two entries:
  - a **toolbar icon** "View knowledge graph", and
  - a **"View as graph"** link inside the wiki Overview / topic panes (may carry `kgFocus` to center a specific topic node).
- **Δ ④b — group by repo.** The wiki's top level is **repos** (like Memory Bank): `repo → that repo's wiki`, where a repo expands to its **Overview + categories + topics**. The wiki is compiled per-repo across branches, so there is **no branch level** under a repo. `All repos` may still aggregate when more than one repo is present.

Each topic row opens its `pane-wiki-topic` / `pane-wiki` article. `Build Knowledge Wiki` / `Rebuild from latest memories` are retained.

---

## 7. Frozen (explicitly unchanged)

To bound the redesign and prove the sweep was deliberate, the following are **not** changed:

- **All Share functionality** — per-row Share (③a), Share Memory Bank removal (③b), and the Memory detail pane's Share button / Jolli "Share in Jolli". Owned by a separate dedicated Share PR; untouched here.
- The frozen header bar and the six **Settings** panels (AI Agents / AI Summary / Jolli account / Memory Bank / Agent access / Advanced).
- The **Create PR** flow and its pane; the **Share collaborators** dialog (Invite / People with access / General access / Copy link) itself.
- Detail panes other than the Memory pane: ADR, PR, diff, plan, note, conversation (`pane-convo`), reference panes (Linear / GitHub / Jira / Notion).
- The `showPane()` mechanism, message-passing protocol, and all command ids / handler names.
- Storage, hooks, capture pipeline, sync, and dual-write behavior.

---

## 8. Confirmed design decisions

- **③c bottom bar:** after removing Export, the Memory Bank bottom command bar is `Sync | ⋯`; Refresh remains the toolbar refresh icon. *(Approved.)*
- **④a graph entries:** the graph is reachable from both a toolbar icon and an Overview/topic-pane "View as graph" link. *(Approved.)*
- **①b transcript access:** with Private Transcripts removed, raw transcripts are reached via Conversations rows' `Show` / `Continue` → `pane-convo`. *(Approved.)*
- **Share deferred:** all Share work (③a, ③b, and the Memory detail pane's Share button / Jolli `Share in Jolli`) is out of scope for this redesign and handled by a separate dedicated Share PR. Only ③c (Export removal) remains in this redesign's Memory Bank changes. *(Approved.)*

## 9. Open items

None. All review questions resolved (scope = whole-sidebar spec; Export = remove both; Private Transcripts = remove the section).
