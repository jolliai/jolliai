# PR2 — Current Branch View + Memory Detail Pane Redesign — Design Spec

**Date:** 2026-06-22
**Surface:** VS Code extension sidebar `Current Branch` view + the Memory detail panel (`SummaryWebviewPanel`)
**Baseline:** `jolli-memory-vscode-mock.html` refined by review feedback; builds on PR1 (the three-view shell, already merged on `vscode-ui-redesign`).
**Parent spec:** [2026-06-22-sidebar-ux-redesign-design.md](2026-06-22-sidebar-ux-redesign-design.md)

---

## 1. Goal & scope

Land the mockup's **Current Branch view** (Pinned / Current Memory / Committed Memories) in the sidebar, and redesign the **Memory detail panel** (`SummaryWebviewPanel`) to the mockup's `pane-memory` structure with the relevant feedback baked in. PR1 already shipped the view shell; this PR fills the `Current Branch` view's content and its detail panel.

**How the feedback maps to real code (verified against the current implementation, not the mockup):**

| # | Feedback | Reality on current code | This PR |
|---|----------|-------------------------|---------|
| ②  | Add squash select/unselect to Committed Memories | **Already implemented** (`commits-squash` / `selectAllCommits` / `toggleCommitSelection`, disabled when <2 selected) | Reuse as-is; rename the section to "Committed Memories" |
| ①c | Remove the Attach action on Conversations | No "attach a conversation" action exists in current code | N/A — do not build one |
| ①a | Remove the full-screen Current Memory preview | No `pane-working` equivalent exists | N/A — do not build one |
| ①b | Remove the duplicate Private Transcripts section | The detail panel's bottom "All Conversations" (PRIVATE) drawer is currently the **only** transcript entry point and is **not** duplicated | Becomes a real change **only inside this PR's detail-pane redesign**: a top Conversations section is added, which makes the bottom drawer the duplicate → remove it, fold transcript access into the Conversations rows |

So this PR is mostly **net-new redesign** (Current Branch view restructure + detail-pane restructure) with ①b as a bake-in constraint; ② is reused, ①a/①c are non-tasks.

**Out of scope (deferred):** all Share functionality (per the parent spec — dedicated Share PR); Memory Bank view (PR3); Knowledge view (PR4).

---

## 2. Current Branch view — sidebar (`SidebarScriptBuilder.renderBranch`)

Three sections, in order: **Pinned → Current Memory → Committed Memories**.

The current `renderBranch` renders four flat sections — `conversations`, `plans` (Plans & Notes + references), `changes`, `commits`. This PR regroups them:

- **Pinned** — net-new (see §3).
- **Current Memory** — a single grouping header with three labelled sub-sections:
  - **Conversations** = current `branchData.conversations`
  - **Context** = current `branchData.plans` (plans / notes / Linear-GitHub-Jira-Notion references)
  - **Files** = current `branchData.changes`
  - **Selection semantics are unchanged**: the per-row include/exclude checkboxes continue to read/write `CommitSelectionStore` (`commit-selection.json`) via the existing `branch:toggleConversationSelection` / `branch:togglePlanSelection` / `branch:toggleReferenceSelection` / `branch:toggleNoteSelection` / `branch:toggleFileSelection` messages. This is a **presentation regroup only — no change to the selection data model or its wire messages.**
- **Committed Memories** — the current `commits` section, **renamed** in the UI only (internal section key stays `commits` for back-compat). The squash selection affordance (② — checkboxes, select-all, "Squash Selected" gated at ≥2) already exists and is preserved unchanged.

The section-collapse, foreign-readonly, worker-busy, and sync-phase behaviors of the current `renderBranch` are preserved.

---

## 3. Pinned subsystem (net-new)

**Persistence — `PinStore`** (`cli/src/core/PinStore.ts`), writing `<projectDir>/.jolli/jollimemory/pins.json`. Pins are grouped by **`<repoName>::<branchName>`** (per-branch scope). Each entry:

```
{ kind: "conversation" | "plan" | "note" | "memory", id: string, title: string, pinnedAt: number }
```

`id` reuses the existing stable identifiers: `conversationKey(...)` for conversations, plan slug for plans, note id for notes, full commit hash for memories. The store exposes `listPins(repo, branch)`, `addPin(repo, branch, entry)`, `removePin(repo, branch, kind, id)`, and is worktree-aware (resolves the project dir via the same helper as the other per-project stores).

**Actions** — a Pin / Unpin affordance (hover action + right-click context-menu item) on:
- Conversation rows (Current Memory → Conversations),
- Plan / note rows (Current Memory → Context),
- Committed memory rows.

**Rendering** — the Pinned section renders the current branch's pin list. Clicking a pinned row opens its target: conversation → `ConversationDetailsPanel`; plan/note → the existing plan/note preview/editor; memory → the detail panel.

**Messages** — new outbound `branch:pin` / `branch:unpin` (`{ kind, id, title }`); new inbound `branch:pinsData` (`{ items: PinEntry[] }`). The host repopulates pins on init, on pin/unpin, and on branch switch (using the active repo+branch).

**Switching repo/branch** re-reads pins for the new `<repo>::<branch>`; foreign-readonly mode shows the viewed branch's pins read-only (Pin/Unpin actions hidden, consistent with the other foreign-readonly sections).

---

## 4. Memory detail panel redesign (`SummaryHtmlBuilder` / `SummaryCssBuilder`)

Restructure the panel sections to the mockup's `pane-memory` order:

1. **Title row** — commit message, `hash` chip, `branch` chip, time, `Details` disclosure, **Share** button.
2. **Hero cards** — **Pull Request** (state + View PR / Create PR…) and **Jolli** (sync state + Open in Jolli / Share in Jolli).
3. **MEMORY** — the recap (existing).
4. **E2E Test Guide** — existing, when present.
5. **Conversations** — the conversations captured for this memory; each row's `Show` / `Continue` opens `ConversationDetailsPanel` for the raw transcript.
6. **Context** — Plans & Notes + references (the existing "Attachments & context" content).
7. **Files** — changed files (existing source-commits / file content).

**Δ ①b — remove the bottom "All Conversations" (PRIVATE) drawer.** Delete `buildPrivateDrawer` / `buildAllConversationsSection` and their `Private Zone` CSS. With the new top Conversations section (item 5) providing transcript access via each row's `Show`, the bottom drawer is now the duplicate the feedback targets. Transcript access is **not lost** — it moves to the Conversations rows. (This is why ①b is coupled to adding the top Conversations section, not a bare deletion of the only transcript entry point.)

**Share** button and the Jolli card's `Share in Jolli` / `Open in Jolli` keep their current behavior — owned by the dedicated Share PR (parent spec), untouched here.

The recap / PR / topic / E2E data sources and their commands are reused; this is a section re-layout plus one removal.

---

## 5. Frozen (explicitly unchanged)

- PR1's three-view shell, `navView`/`switchTab`, `#view-switch`.
- `CommitSelectionStore` semantics and all `toggle*Selection` wire messages.
- The squash flow and its gating; `ConversationDetailsPanel`.
- All Share behavior (deferred to the dedicated Share PR).
- Command ids / handler names; storage, hooks, sync, dual-write.
- The three API-key-parser implementations; worktree-aware invariants.

---

## 6. Testing

- Sidebar builders (`SidebarHtmlBuilder` / `SidebarCssBuilder` / `SidebarScriptBuilder`) and the detail-panel builders (`SummaryHtmlBuilder` / `SummaryCssBuilder`) are tested by asserting on the generated string (`toContain` / `toMatch`) plus the `new Function(...)` parse smoke test — the established pattern for these files.
- `PinStore` gets normal unit tests; it lives in `cli/src`, so the CLI coverage floor (97% statements / 96% branches / 97% functions / 97% lines) applies — its tests must keep coverage above the threshold.
- The detail-panel ①b change is verified by `SummaryHtmlBuilder.test.ts`: the new Conversations section is present; the `private-drawer` / "All Conversations" markup is absent.

---

## 7. Confirmed design decisions

- **Current Memory is a presentation regroup** of the existing Conversations / Plans&Notes / Changes sections over the unchanged `CommitSelectionStore`. *(Approved.)*
- **①b mechanics:** add a top Conversations section to the detail panel, then remove the bottom "All Conversations" private drawer; transcripts reached via the Conversations rows' `Show`. *(Approved.)*
- **Pinned scope:** per-branch; `pins.json` under the per-project `.jolli/jollimemory/`, grouped by `<repo>::<branch>`. *(Approved.)*

## 8. Open items

None.
