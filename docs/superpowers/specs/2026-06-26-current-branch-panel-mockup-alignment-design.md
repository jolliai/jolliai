# Current Branch panel — mockup alignment redesign

**Date:** 2026-06-26
**Branch:** `vscode-ui-redesign`
**Baseline mockup:** `jollimemory-design` repo — `vscode-interactive.html` (master) / `dist/sidebar.normal.intent.html`, the **Current Branch** view in its populated state. Verified against a live render of the current branch code via a fixture preview harness (screenshots, 2026-06-26).

**Relationship to prior specs:**
- Builds on `2026-06-22-current-branch-view-design.md` and `2026-06-22-sidebar-ux-redesign-design.md` (the three-view switch, Working Memory grouping, Pinned section — all already shipped).
- **Supersedes the command-bar layout decision** in `2026-06-25-current-branch-command-bar-and-create-pr-pane-design.md` §4. That spec moved **Commit** down into the sticky footer and *removed* the in-section commit button; this spec moves the commit action **back up into the panel body** as a `Commit Memory | Review` button pair, and reshapes the footer to `Create PR | Share | ⋯`. The Create PR pane (`CreatePrWebviewPanel`) and the `⋯` recall actions from the 06-25 spec are **unchanged** and carried forward.

This is the **first of three** panel-alignment specs (Current Branch → Memory Bank → Knowledge); each ships independently.

---

## 1. Summary

Align the **Current Branch** view to the `jollimemory-design` master mock. The structure is already close; this change closes the remaining information-architecture gaps, all verified against a live render of the current code:

1. **Working Memory rows** gain mockup metadata: CONVERSATIONS rows show a per-source colored **dot** + a right-aligned **"N msgs"** count + a **"usage not reported"** sub-label; CONTEXT rows show a right-aligned **token count** and the section gains a **"+" add-context** affordance. Selection stays as the existing checkboxes (per product decision — the mockup's strikethrough-for-excluded styling is **not** adopted).
2. **`Commit Memory | Review` button pair** is rendered in the panel body, after the Files sub-section. **Review** opens a new **Next Memory preview panel**.
3. **Committed Memories** gains a **token progress bar** ("`<total>` tokens · this branch" with an input / output / cached legend) above the rows, plus a per-row **"Show memory details"** expander affordance.
4. **Footer** becomes `Create PR | Share | ⋯`. **Commit** leaves the footer (it is now the body button pair). **Share** is added as a **placeholder** button.

This is a **presentation + wiring** change plus one new editor-column panel. No storage, hook, capture-pipeline, sync, or dual-write behavior changes.

## 2. Scope

**In scope**
- CONVERSATIONS / CONTEXT row restyle in `renderConversationRow` / `renderPlanRow` (`SidebarScriptBuilder.ts`) + supporting CSS.
- CONTEXT section "+" add-context affordance (reuses existing add-plan / add-note commands).
- Body `Commit Memory | Review` button pair (new render block in `renderBranch`), replacing the footer Commit button.
- New **`NextMemoryPreviewPanel`** (editor-column webview) + command `jollimemory.reviewNextMemory`.
- Committed Memories **token progress bar** + new inbound message `branch:tokenStats` and its host computation.
- Footer reshaped to `Create PR | Share | ⋯`; new **Share placeholder** button + `jollimemory.shareBranchPlaceholder` command.
- All Current Branch **states**: normal, empty, foreign-readonly, scanning (worker busy), summary-failed.

**Out of scope (deferred)**
- Real per-conversation token **usage** values — `ActiveConversationItem` carries no usage field today, so CONVERSATIONS rows show the static "usage not reported" sub-label. Wiring real usage is a follow-up.
- The mockup's **strikethrough-for-excluded** row styling (selection stays checkbox-based).
- The full **Share** surface (collaborators, Jolli Space sync, share modal). This spec ships only a footer placeholder button whose action surfaces a "coming soon" hint; the real Share flow is owned by the separate Share effort (sidebar redesign §1/§7, still awaiting lock per `MASTER-DESIGN.md`).
- Memory Bank and Knowledge panels (their own specs).

## 3. Target structure (top → bottom)

```
PINNED (n)                         ← unchanged
WORKING MEMORY
  CONVERSATIONS (n)                ← ☑ + source dot + title + "N msgs" / "usage not reported"
  CONTEXT (n)              [+]     ← ☑ + icon + title + token count ; header "+" adds plan/note
  FILES (n)                        ← ☑ + icon + path + git status   (unchanged)
[ ✦ Commit Memory ] [ ⊙ Review ]   ← NEW body button pair (was footer Commit)
COMMITTED MEMORIES (n)
  ▁▁▁▁ <total> tokens · this branch   ← NEW token bar + input/output/cached legend
  • <commit row>            [Show memory details ⌄]
─────────────────────────────────
[ ⑃ Create PR ] [ ↗ Share ] [ ⋯ ]  ← footer: Commit removed, Share placeholder added
```

Foreign-readonly mode hides the WORKING MEMORY group, the body button pair, and the footer (read-only branches can't commit / review / PR / share) — same gate as today (`isViewingForeign()`).

## 4. Unit A — Working Memory row restyle (webview only)

`SidebarScriptBuilder.ts` + `SidebarCssBuilder.ts`. No host changes.

### 4.1 CONVERSATIONS (`renderConversationRow`)
- Keep the leading checkbox (selection unchanged).
- Replace the source **badge pill** with a small **colored dot** keyed by `item.source` (one CSS class per source, color sanctioned from the existing source palette). The source name moves to the row's `title`/hover; the dot is the at-a-glance signal.
- Right-aligned **`<messageCount> msgs`** (was "`<n> <relative-time>`"; relative time moves to hover).
- Sub-label line **"usage not reported"** in `--vscode-descriptionForeground` (static placeholder; see §2 out-of-scope).

### 4.2 CONTEXT (`renderPlanRow` + section header)
- Keep the leading checkbox.
- Right-aligned **token count** when the row carries one (plans/notes that have an associated commit token figure); omitted otherwise.
- Section header gains a trailing **`+`** button → opens a small menu with **Add plan** / **Add note**, dispatching the existing `command` channel (`jollimemory.newPlan` / `jollimemory.newNote` or their current ids — confirm at implementation). No new host command.

### 4.3 FILES
- Unchanged (checkbox + git-status icon + path + status letter).

### 4.4 CSS / parity rules (apply to every webview change in this spec)
- No inline `style=` / inline handlers — dynamic styles via CSS class, events via the existing delegated `tabContents.branch` click handler + `data-action` attributes (project CSP rule).
- Show/hide via the `.hidden` class, never the HTML `hidden` attribute.
- `\` → `/` path work (if any) goes through `toForwardSlash` / the sanctioned helpers, never inline `replace`.

## 5. Unit B — `Commit Memory | Review` body button pair

- Rendered by a new `renderCommitReviewBar()` block appended to `renderBranch()`'s mount list **after** the Files sub-section and **before** Committed Memories (not sticky — scrolls with content).
- **Commit Memory** (primary, `codicon-sparkle`): reuses the existing commit action path (`changes-commit-memory`) and its disabled rules — disabled when no files/items selected or a blocking worker run is in progress (`isWorkerBlocking()`). This reclaims the action the 06-25 spec had moved to the footer; the footer Commit button is removed (§7).
- **Review** (secondary, `codicon-eye` or `codicon-checklist`): posts `{ type: 'command', command: 'jollimemory.reviewNextMemory' }`. Disabled under the same `isWorkerBlocking()` condition. Hidden in foreign-readonly mode.

## 6. Unit C — Next Memory preview panel

New editor-column webview `NextMemoryPreviewPanel` (host), opened by `jollimemory.reviewNextMemory`.

- **Purpose:** show what the *next* committed memory will capture — the currently **selected** conversations, context (plans/notes/references), and files — so the user can review/adjust before committing. Read-only preview; the actual edit affordances remain the sidebar checkboxes.
- **Data assembly:** reuses the same selection state the commit path reads (commit-selection.json + the active conversations/plans/changes feeds). Modelled on `SummaryWebviewPanel` / `CreatePrWebviewPanel` structure (single-purpose editor webview), but **branch/working-set-scoped**, not memory-scoped — so it is a new class, not an extension of `SummaryWebviewPanel` (same rationale as the 06-25 Create PR pane §3.1).
- **Content:** three grouped sections (Conversations / Context / Files) listing the selected items, plus a header summarizing counts. Actions: **Commit Memory** (delegates to the existing commit command) and **Close**.
- **Empty selection:** panel shows a "nothing selected yet" empty state.

## 7. Unit D — footer reshape (`Create PR | Share | ⋯`)

`renderBranch()` footer (`.branch-footer`, sticky, established by the 06-25 spec):
- **Remove** the footer **Commit** button (now the body pair, §5).
- **Create PR** (`codicon-git-pull-request`): unchanged — `jollimemory.createPrForBranch`, disabled when the branch has no committed memories.
- **Share** (NEW, `codicon-export` / `codicon-link`): placeholder. Posts `{ type: 'command', command: 'jollimemory.shareBranchPlaceholder' }`; the host command shows an information message (e.g. "Sharing is coming soon."). Disabled rules mirror Create PR for now.
- **⋯**: unchanged — the two recall items from the 06-25 spec (`Recall in Claude Code`, `Copy recall prompt for other tools`), opening upward.

## 8. Unit E — Committed Memories token bar

- New inbound message **`branch:tokenStats`**:
  `{ type: "branch:tokenStats"; readonly input: number; readonly output: number; readonly cached: number; readonly total: number; readonly scope: "branch" }`.
- **Host:** computed in `SidebarWebviewProvider` (or its data source) by aggregating the token figures already stored on the branch's committed summaries (the same figures the per-commit hover `statsLine` reads). Pushed alongside `branch:commitsData` and on branch/commits refresh. `null`/absent ⇒ bar hidden.
- **Webview:** a `renderTokenBar(stats)` node mounted at the top of the Committed Memories section body: a horizontal bar segmented input (green) / output (blue) / cached (gray) using the sanctioned `--vscode-charts-*` tokens, with a label "`<total>` tokens · this branch" and a legend row. Reuses the same visual treatment the Memory Bank and Knowledge specs will need (extract a shared `renderTokenBar` helper so all three panels share one implementation).
- **Per-row "Show memory details" expander:** the committed-memory row gains a trailing affordance that toggles the existing nested file-children / details (`renderCommitFileRow`) inline — wiring the existing expansion to a visible labeled control rather than only the chevron.

## 9. State coverage

| State | Behavior |
|---|---|
| **normal** | Full structure (§3). Token bar shown when `branch:tokenStats` present. |
| **empty** | Section headers + per-section empty copy retained (verified to already render). Body button pair shown but **Commit/Review disabled** (nothing selected). Token bar hidden (no commits). Footer Create PR/Share disabled. |
| **foreign-readonly** | WORKING MEMORY group, body button pair, and footer hidden. Committed Memories shows the read-only banner + the selected branch's memories (existing `selection:branchMemories` path). Token bar **hidden** (no per-foreign-branch aggregate in this spec). |
| **scanning (worker busy)** | Commit + Review disabled with an in-progress affordance; Committed Memories header shows the existing worker-phase label. |
| **summary-failed** | Existing failed-summary treatment retained; no new behavior. |

## 10. Messages & commands added

- Inbound: `branch:tokenStats` (§8).
- Outbound: `command` dispatches for `jollimemory.reviewNextMemory`, `jollimemory.shareBranchPlaceholder`, and the CONTEXT "+" add-plan/note commands (reused).
- New host commands: `jollimemory.reviewNextMemory` (opens Unit C), `jollimemory.shareBranchPlaceholder` (info message).
- New webview panel: `NextMemoryPreviewPanel`.

## 11. Testing & coverage

CLI coverage floor is unaffected (no `cli/src` changes expected; token aggregation, if it lands in `cli/src`, must stay ≥97%). VS Code tests:
- `SidebarScriptBuilder.test.ts`: assert CONVERSATIONS row renders dot + "N msgs" + "usage not reported"; CONTEXT row renders token count + header "+"; body `Commit Memory | Review` pair present and gated; token bar renders from `branch:tokenStats` and is absent without it; footer is `Create PR | Share | ⋯` (no Commit).
- `SidebarCssBuilder.test.ts`: source-dot classes, token-bar classes exist.
- New `NextMemoryPreviewPanel.test.ts`: assembles selected items into the three groups; empty-selection state.
- State tests: foreign-readonly hides the button pair + footer + token bar; empty disables Commit/Review.
- `npm run all` must pass (clean → build → lint → test) before commit; DCO sign-off on the commit; no Claude co-author trailer.

## 12. Risks / open items

- **Supersedes a one-day-old decision.** The 06-25 command-bar layout (Commit in footer, no Share) is deliberately reversed here per product direction (align to `jollimemory-design`). The 06-25 spec should get a short "superseded by 2026-06-26 for the command-bar layout" note so the history reads coherently.
- **Share placeholder vs. real Share.** Per `MASTER-DESIGN.md`, the Share design is still awaiting lock with open sub-questions (who-can-read modes, context-payload shape, naming). The placeholder must not imply a committed Share contract — keep it a visibly-inert button + "coming soon" message until the Share spec lands.
- **`branch:tokenStats` source fidelity.** If committed summaries don't all carry input/output/cached splits, the bar should degrade gracefully (show total only, or hide) rather than render a misleading split.
- **Live verification.** The fixture preview harness (`scratchpad/preview/render-sidebar.mts`) should be re-run after implementation to screenshot-compare each state against the mockup before claiming completion.

---

## 13. Addendum (2026-06-27): committed-memory inline detail (Task 7)

**Gap found during manual verification.** The mockup's Current Branch **committed memory row**, when expanded, shows a rich inline detail block — a `SHIPPED` group (a *"No PR yet — create from this memory"* row + a *"Not pushed — Push to Jolli"* row), plus `CONVERSATIONS`, `CONTEXT`, and `FILES` evidence groups, with a **"Show / Hide memory details"** toggle. The original spec (§8) under-captured this — it reduced it to "toggle the existing file-children" — and PR6 did not build even that. Today the sidebar committed row expands only to its file children (`renderCommitFileRow`); the rich detail exists only in the separate editor panel (`SummaryWebviewPanel`). This addendum closes the gap. **In scope as PR6 Task 7; all four groups.**

### 13.1 What's reusable (verified)
The evidence machinery is **commitHash-keyed and repo-aware**, and the Branch committed row already toggles `state.commitsExpanded[item.id]` where `item.id` IS the commit hash:
- `renderMemoryEvidence(commitHash, evidence)` (SidebarScriptBuilder.ts:2324) renders the Conversations / Context / Files groups exactly as the Memory Bank Timeline does.
- The lazy channel `kb:expandMemory {commitHash}` → host `pushMemoryEvidence` (SidebarWebviewProvider.ts:998) → `kb:memoryEvidence {commitHash, evidence}` (+ `evidenceCache`/`evidencePending` guards) works unchanged for a current-repo branch commit.

### 13.2 Task 7a — inline evidence groups + toggle (low risk, pure reuse)
- When a committed row **with a memory** (`hasMemory`/`contextValue==='commitWithMemory'`) is expanded, render `renderMemoryEvidence(item.id, evidence)` in its expanded body (lazy-fetched via the existing `kb:expandMemory` path + `evidenceCache`), in place of the current file-children-only expansion. The Files group inside `renderMemoryEvidence` (`evidence.files`) replaces the old `renderCommitFileRow` children for memory rows. (Non-memory plain commits keep the existing file-children behavior.)
- Add a labeled **"Show memory details" / "Hide memory details"** affordance on the row that drives the same `state.commitsExpanded[hash]` toggle as the chevron (the chevron stays; the label is an additional, clearer control — same dual-control pattern §8 intended for the token area).
- Foreign-readonly: unchanged — Committed Memories already lists foreign memories; expansion reuses the same evidence path (already foreign-aware via `sourceRepoName`/`sourceRemoteUrl`).

### 13.3 Task 7b — SHIPPED group (heavier; documented status degradation)
Two rows rendered **above** the evidence groups inside the expanded body:
- **Push to Jolli row.** Plumb the summary's `jolliDocUrl` onto each `branch:commitsData` item (host: `HistoryTreeProvider` serialize adds an optional `jolliDocUrl?: string`). Row reads *"Synced"* (links to `jolliDocUrl`) when present, else *"Not pushed — Push to Jolli"* (action). Clicking the action dispatches a command that pushes **that memory** to Jolli (by commit hash).
- **PR row.** Row reads *"create PR from this memory"* (action). Clicking opens that memory's flow to create a PR. **Documented degradation:** live PR status (PR #N / open / merged) is a per-memory `gh` probe that is too expensive to run inline for every expanded row, so the PR row is an **action entry without a live PR-number status** in this PR — it does not claim "No PR yet" as verified truth, it offers the create action. (Live per-row PR status is a follow-up, mirroring the token-bar `cached` and conversation-`usage` degradations already accepted in §2/§12.)
- **Reuse for the actions:** prefer dispatching to the existing per-memory surfaces rather than duplicating PR/push logic in the sidebar. If no commitHash-addressable registered command exists for per-memory create-PR / push, the action opens the memory's `SummaryWebviewPanel` (the existing surface that owns create-PR + Push-to-Jolli), keeping the ship logic single-sourced. Implementer confirms the exact reuse path before building.

### 13.4 Task 7 testing
String-assertion tests on `buildSidebarScript()`: expanded memory row emits `renderMemoryEvidence` groups + the "memory details" toggle label; SHIPPED rows render with the push action and (when `jolliDocUrl` present) the synced link; non-memory commits keep file-children expansion. Host: `HistoryTreeProvider` serialize carries `jolliDocUrl`. The `new Function(...)` parse smoke test must stay green. CSP rules apply (no inline style; `.hidden`; CSS-class styling; no backtick in the literal).
