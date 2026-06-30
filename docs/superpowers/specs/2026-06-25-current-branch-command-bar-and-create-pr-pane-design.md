# Current Branch command bar + Create PR pane — design

> **Superseded for the command-bar layout** by `2026-06-26-current-branch-panel-mockup-alignment-design.md`: Commit moves from the footer back into a body `Commit Memory | Review` pair and the footer becomes `Create PR | Share | ⋯` (Share placeholder). The Create PR pane and the `⋯` recall actions defined below are unchanged.

**Date:** 2026-06-25
**Branch:** `vscode-ui-redesign`
**Baseline mockup:** `~/Downloads/sidebar-redesign(3).html` — command bar `data-area="current"` and `pane-pr`.
**Relationship to prior spec:** This completes two items the sidebar UX redesign explicitly deferred (see `2026-06-22-sidebar-ux-redesign-design.md` §7): "The **Create PR** flow and its pane" and the Current Branch bottom command bar's `Create PR`. It does **not** revisit anything else in that redesign.

---

## 1. Summary

The redesigned **Current Branch** view currently has no bottom command bar; "Commit Memory" lives as a CTA inside the Files sub-section. This change:

1. Adds a **sticky bottom command bar** to the Current Branch view: `Commit | Create PR | ⋯`, moving the commit action down into it and removing the in-section button.
2. Adds a **`⋯` overflow menu** with two branch-level recall actions: **Recall in Claude Code** and **Copy recall prompt for other tools**. (Share is intentionally not added.)
3. Adds a new full-screen **Create PR pane** (`CreatePrWebviewPanel`, editor column) whose body is drafted from the branch's unmerged memories, modelled on `SummaryWebviewPanel`.

This is a **presentation + wiring** change. No storage, hook, capture-pipeline, sync, or dual-write behavior changes. PR creation reuses the existing `PrCommentService` / `PrDescription` machinery; recall reuses the existing `ContextCompiler` / `RecallResolver` machinery.

## 2. Scope

**In scope**
- Current Branch sticky command bar (`Commit | Create PR | ⋯`) and its disabled / foreign-mode rules.
- `⋯` menu: `Recall in Claude Code`, `Copy recall prompt for other tools`.
- Three new host commands (recall-in-claude, copy-recall-prompt, create-pr-for-branch) — all branch-level.
- A shared `buildBranchRecallPrompt(cwd, branch)` helper.
- New `CreatePrWebviewPanel` with the full mockup content (Title, Body, Memories included, E2E Test Guide when present, Files changed, actions).
- Create PR pane actions: **Create PR** (push + `gh`), **Edit** (edit title/body before creating), **Copy body**.

**Out of scope (deferred)**
- **Create PR & Share** / signed-in auto-sync of included memories to Jolli Space. Share is owned by the separate Share PR (redesign §1/§7). The signed-in button stays plain **Create PR**.
- `⋯ More` long-tail action menu from the mockup (only the two recall items ship).
- The mockup's Recall **split-button**; recall ships as two `⋯` menu items instead (per product owner's chosen command-bar composition `Commit | Create PR | ⋯`).
- Any Share surface (top-row Share, Jolli hero card, Share collaborators dialog).
- The per-memory `Create PR…` entry in `SummaryWebviewPanel` is unchanged.

## 3. Architecture

Two decoupled units:

- **Unit A — command bar** (sidebar webview, `SidebarScriptBuilder` / `SidebarCssBuilder`). Pure presentation + message dispatch. The `Create PR` button posts a command; it does not know about the pane internals.
- **Unit B — `CreatePrWebviewPanel`** (extension host, new editor-column webview). Owns PR data assembly and the create/edit/copy actions.

They communicate only through the existing webview→host `command` channel and a new host command id. Either can be understood and tested without the other.

### 3.1 Why a new panel (not extending `SummaryWebviewPanel`)
The Create PR pane is **branch-level** ("drafted from N memories"), opened from the command bar, with no single owning memory. Extending `SummaryWebviewPanel` (a per-memory surface) would push branch-level semantics into a memory-scoped class and tangle two responsibilities. A dedicated `CreatePrWebviewPanel` keeps each surface single-purpose and reuses the shared, already-extracted building blocks (`PrDescription`, `PrCommentService`, `GitOps`).

## 4. Unit A — Current Branch command bar

### 4.1 Mount & layout
- Rendered in `renderBranch()` (`SidebarScriptBuilder.ts`) by appending a `.branch-footer` node to `nodesToMount` (so it re-renders with the view; cheap).
- `.branch-footer` is `position: sticky; bottom: 0`, pinned to the bottom of the `#tab-content-branch` scroll container; content scrolls behind it. Background `--vscode-sideBar-background` + a top border so it reads as a footer.
- Rendered **only in workspace (non-foreign) mode** — `isViewingForeign()` is true ⇒ no footer (foreign read-only branches can't commit / create PRs).
- Layout: `[✦ Commit] [⑃ Create PR] [⋯]`.

### 4.2 Buttons
- **Commit** (primary, `codicon-sparkle`): reuses the existing `changes-commit-memory` action path and its disabled rules — disabled when no files are selected or a blocking worker run is in progress (`isWorkerBlocking`). The existing in-section `commit-memory-action` button (rendered by `renderCommitMemoryButton`, mounted inside the Files/changes section) is **removed**; its click delegation moves to the footer button.
- **Create PR** (`codicon-git-pull-request`): posts `{ type: 'command', command: 'jollimemory.createPrForBranch' }`. **Disabled** when the current branch has no committed memories (`branchData.commits.length === 0`).
- **⋯** (`codicon-ellipsis`): opens the existing `showContextMenu(x, y, items)` positioned to open **upward** from the button (footer sits at viewport bottom). Items:
  - `Recall in Claude Code` → command `jollimemory.recallBranchInClaudeCode`
  - `Copy recall prompt for other tools` → command `jollimemory.copyBranchRecallPrompt`

### 4.3 CSS / parity rules
- New `.branch-footer` block in `SidebarCssBuilder.ts`; reuse existing button styles where possible.
- Honor the project's webview CSP constraints: no inline `style=`/inline handlers — dynamic styles via CSS class, events via the existing delegated `tabContents.branch` click handler / `data-action` attributes.
- `.hidden` class is used for show/hide, never the HTML `hidden` attribute (project convention).

## 5. Unit B — new host commands

All three live in `Extension.ts` alongside the existing `copyRecallPrompt` / `openInClaudeCode` (which stay per-commit and unchanged).

### 5.1 `buildBranchRecallPrompt(cwd, branch)` (shared helper)
- Calls `compileTaskContext({ branch }, cwd)` then `renderContextMarkdown(ctx, DEFAULT_TOKEN_BUDGET)` (both from `cli/src/core`, bundled into the extension).
- Returns `{ prompt: string, commitCount: number }`. Callers handle `commitCount === 0` (no records on this branch).
- Location: a small new module under `vscode/src/views/` (e.g. `BranchRecall.ts`) or co-located with `SummaryMarkdownBuilder`. The per-commit `buildClaudeCodeContext(summary)` is **not** reused (it's single-summary).

### 5.2 `jollimemory.recallBranchInClaudeCode`
- Resolves the current branch (`bridge.getCurrentBranch()`), builds the prompt, opens `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}` via `vscode.env.openExternal` — mirroring the existing per-commit `openInClaudeCode`.
- `commitCount === 0` ⇒ `showInformationMessage("No Jolli Memory records on this branch yet.")` and return.

### 5.3 `jollimemory.copyBranchRecallPrompt`
- Same prompt build → `vscode.env.clipboard.writeText(prompt)` + `showInformationMessage("Recall prompt copied — paste it into Codex, Cursor, or any AI tool.")`.
- `commitCount === 0` ⇒ same info message as above, no clipboard write.

### 5.4 `jollimemory.createPrForBranch`
- Resolves current branch + workspace root, loads branch summaries (`loadBranchSummariesForPr(branch)` logic, extracted/shared so the pane and `SummaryWebviewPanel` agree), picks the anchor = most-recent summary, then `CreatePrWebviewPanel.show(...)`.
- If the branch has no committed memories, the command is a no-op with an info message (the button is already disabled in that state — this is belt-and-suspenders).

## 6. Unit B — `CreatePrWebviewPanel`

New `vscode/src/views/CreatePrWebviewPanel.ts` (+ Html/Css/Script builders if the existing panel-builder split pattern is followed). Editor-column webview, `ViewColumn.One` (matching the redesign's pane convention).

### 6.1 Data assembly (host side, before first render)
- `branch` = current branch; guard cross-branch (see §6.4).
- `{ summaries, missingCount } = loadBranchSummariesForPr(branch)` — the branch's unmerged memories.
- `anchor` = `summaries[0]` (most-recent) — used only as `buildPrBodyMarkdown` / `pickPrTitle` fallback.
- `title = pickPrTitle(anchor, summaries)`.
- `body = buildPrBodyMarkdown(anchor, summaries, missingCount)` (raw markdown; `wrapWithMarkers(body)` only when sending to the create/update form, matching `SummaryWebviewPanel`).
- `diffStats` (`+X −Y · N files`) via `bridge` / `GitOps.getDiffStats` against the merge base with `main` (the branch's unmerged delta).
- `filesChanged` = the changed file list for the branch delta (path + git-status marker).
- `e2eGuide` = `anchor.e2eTestGuide` (`E2eTestScenario[]`); section renders only when present.

### 6.2 Sections (top → bottom, matching mockup `pane-pr`)
1. `<h1>Create Pull Request</h1>`
2. **meta strip** — `<branch> → main · drafted from N memories · +X −Y · N files`.
3. **Title** panel — the generated title (read display; editable via the Edit action).
4. **Body — drafted from this branch's memories** panel — rendered markdown.
5. **Memories included (N)** — one row per branch summary (title · `hash` · PR # when known). Row click opens that memory's detail pane (`jollimemory.viewMemorySummary` with the hash).
6. **E2E Test Guide** — rendered from `e2eGuide` scenarios, only when present (`is-ok` count chip).
7. **Files changed (N)** — one row per changed file (path + `M`/`A`/`D`/… marker). Row click opens the diff (existing diff command / `pane-diff` equivalent).
8. **Actions** — `Create PR`, `Edit`, `Copy body`.

### 6.3 Actions
- **Create PR** → existing `handleCreatePr(title, body, cwd, postMessage, branch)` (push branch + `gh pr create`, then toast with "Open PR"). No new PR backend.
- **Edit** → reveals an editable title + body form (reuse the `SummaryWebviewPanel` / `PrCommentService` create-form interaction: editable `prTitleInput` / `prBodyInput`, then Create). The pane opens in read-first mode; Edit switches to the editable form.
- **Copy body** → `vscode.env.clipboard.writeText(wrapWithMarkers(body))` + toast.
- **Signed-in / signed-out** copy hint line is shown for context, but the button stays **Create PR** in both states (Share coupling deferred).

### 6.4 Error handling & guards
- **Cross-branch guard** — reuse `SummaryWebviewPanel`'s guard: `git push -u origin HEAD` requires the branch to be checked out. If the branch differs from the current branch (or `getCurrentBranch()` returns the `"HEAD"` sentinel), block with the same distinct messages and `prCreateBlockedCrossBranch` semantics.
- **Worker-busy guard** — reuse `isWorkerBlockingBusy` (ingest exempt) before Create PR, as in `SummaryWebviewPanel`.
- **Empty branch** — if `summaries.length === 0`, the panel should not have been reachable (button disabled); the command guards with an info message anyway.
- **PR creation failure** — surfaced via the existing `handleCreatePr` toast + `prCreateFailed` path; no silent swallow.

## 7. Files touched

- `vscode/src/views/SidebarScriptBuilder.ts` — render `.branch-footer`; move/remove `renderCommitMemoryButton`; `⋯` menu wiring + footer click delegation.
- `vscode/src/views/SidebarCssBuilder.ts` — `.branch-footer` (+ button) styles.
- `vscode/src/Extension.ts` — register `recallBranchInClaudeCode`, `copyBranchRecallPrompt`, `createPrForBranch`.
- `vscode/src/views/CreatePrWebviewPanel.ts` (new) — the pane (+ Html/Css/Script builders per existing split pattern).
- `vscode/src/views/BranchRecall.ts` (new) or co-located — `buildBranchRecallPrompt`.
- Possibly extract `loadBranchSummariesForPr` into a shared module so the pane and `SummaryWebviewPanel` share one implementation.

**Reused unchanged:** `cli/src/core/PrDescription.ts` (`buildPrBodyMarkdown` / `pickPrTitle` / `wrapWithMarkers`), `vscode/src/services/PrCommentService.ts` (`handleCreatePr` / `handleCheckPrStatus`), `cli/src/core/ContextCompiler.ts` + `RecallResolver.ts` (`compileTaskContext` / `renderContextMarkdown`), `cli/src/core/GitOps.ts` (`getDiffStats`).

## 8. Testing

- **Command bar** — `SidebarScriptBuilder` / `SidebarCssBuilder` builder unit tests: footer renders in workspace mode, hidden in foreign mode; Commit/Create PR disabled states; `⋯` menu contains exactly the two recall items (no Share); the in-section commit button is gone.
- **New commands** — unit tests for the three commands: branch resolution, `commitCount === 0` info path, clipboard / `openExternal` / panel-open calls (mock `vscode` like existing tests).
- **`buildBranchRecallPrompt`** — unit test the `compileTaskContext` → `renderContextMarkdown` wiring and the empty-branch return.
- **`CreatePrWebviewPanel`** — data-assembly unit tests (title/body/memories/files/e2e/diffstat from fixtures), action dispatch (Create PR → `handleCreatePr`, Copy body → clipboard), and the cross-branch / worker-busy guards.
- Maintain the vscode 97% coverage threshold (`npm run all` gate). New code under `cli/src/` (if any helper lands there) honors the CLI 97/96/97/97 floor.

## 9. Confirmed decisions

- Command bar composition: **`Commit | Create PR | ⋯`**; recall actions live in the `⋯` menu (not a split-button).
- Create PR pane: **full mockup content** (Title / Body / Memories included / E2E Test Guide when present / Files changed / actions).
- **Create PR & Share** signed-in sync coupling: **deferred**; ship plain **Create PR**.
- Recall scope: **whole current branch** (`compileTaskContext` branch-level), not per-commit.
- Bottom bar scope: **Current Branch view only** (sticky footer), hidden in foreign read-only mode.
