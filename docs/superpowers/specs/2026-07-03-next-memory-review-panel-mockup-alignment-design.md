# Next Memory review panel — mockup alignment redesign

**Date:** 2026-07-03
**Branch:** `vscode-ui-memory-detail`
**Baseline mockup:** `jollimemory-design` repo — `vscode-interactive.html`, the editor-area pane `#pane-working` ("Working Memory" review pane, opened by the sidebar's **Review** button via `showPane('pane-working', 'Working Memory: review & edit')`). This is the rendered pane's actual markup, not the surrounding design-loop comments.

**Relationship to prior specs:**
- **Supersedes Unit C** (`§6`) of `2026-06-26-current-branch-panel-mockup-alignment-design.md`. That spec scoped the Review target as a **read-only, static** preview (`enableScripts: false`, no edit affordances, edits stay in the sidebar). The mockup's `#pane-working` is fully interactive — checkboxes, ✕/+ exclude toggles, an Add-context button, and a functioning `Commit Memory` button. Per established project precedent on this branch (mockup overrides earlier per-element decisions — see the 2026-07-02 memory-detail spec and its "rendered mockup wins over inline comments" rule), the mockup wins here too, over the 06-26 spec's own out-of-scope note. Unit C's implementation (`NextMemoryPreviewPanel.ts`, a static three-`<ul>` skeleton with no action buttons) is replaced by this spec.
- Sibling to `2026-07-02-memory-detail-panel-mockup-alignment-design.md` (the **committed** Commit Memory detail panel). This spec covers the **uncommitted** counterpart — the draft the next commit will save.
- Does not change the sidebar's Working Memory card itself (already aligned per 06-26 Units A/B); this spec only replaces what **Review** opens.

---

## 1. Summary

Rebuild `NextMemoryPreviewPanel` from a static, read-only three-list skeleton into a fully interactive editor-column mirror of the sidebar's Working Memory card, matching the mockup's `#pane-working`:

1. **Header**: title, meta-strip (branch · `NOT COMMITTED` chip · staged diffstat), and an explanatory line.
2. **Proposed title panel**: AI-drafted commit message (reusing the existing pre-commit generator) + a detected-ticket line sourced from already-selected Context references.
3. **Token meter**: total tokens "captured by this memory," summed from real per-conversation usage where available (Claude), degrading to "not reported" for sources that don't expose it.
4. **Conversations / Context / Files panels**: every row from the same live data the sidebar renders from — including **excluded** items, shown struck-through rather than omitted.
5. **Footer**: privacy note, an explanatory line, and a full-width **Commit Memory** button that actually commits.
6. Full interactivity: checkboxes / ✕ / + exclude toggles and the Context "+" add-menu all work from this panel and stay in sync with the sidebar's Working Memory card, because both surfaces read and write the same host-side selection state.

This is a **presentation + host-broadcast** change. No new selection model, no new storage, no new commit pipeline — the panel becomes a second view onto data and actions that already exist.

## 2. Scope

**In scope**
- Rebuild `NextMemoryPreviewPanel` as a builder trio (`NextMemoryHtmlBuilder.ts` / `NextMemoryCssBuilder.ts` / `NextMemoryScriptBuilder.ts`), `enableScripts: true`, nonce-based CSP — replacing the current single-file static-HTML implementation.
- Broadcast fan-out in `SidebarWebviewProvider.postMessage()` so `branch:conversationsData` / `branch:plansData` / `branch:changesData` / `branch:pinsData` reach both the sidebar webview and (when open) the Next Memory panel's webview.
- Panel-side handlers for the same outbound messages the sidebar already sends: `branch:toggleConversationSelection` / `branch:togglePlanSelection` / `branch:toggleNoteSelection` / `branch:toggleReferenceSelection` / `branch:toggleFileSelection`, plus the Context "+" add-menu dispatch and a `body-commit`-equivalent `command` message for the footer's Commit Memory button.
- **Proposed title**: on panel open, host calls the existing `JolliMemoryBridge.generateCommitMessage()` (same call the ✦ Commit Memory flow already makes) against the current staged diff. A manual **Regenerate** button re-triggers it; selection changes do **not** auto-regenerate (bounds LLM call volume).
- **Detected ticket**: derived from the first selected Context row whose `contextValue === 'reference'` and whose label matches the existing ticket-pattern convention (`TICKET_PATTERN` in `CommitMessageUtils.ts`) — no new detection logic. Omitted (not a placeholder) when no such reference is selected.
- **Token meter**: new `getStagedConversationTokenTotals()`-style helper that, for each **selected Claude** conversation, calls the existing `readTranscript(transcriptPath)` (no `beforeTimestamp` — reads start-to-EOF) and sums `usageBreakdown`. Non-Claude sources degrade to "not reported," matching the precedent already shipped for the Commit Memory detail panel.
- **Staged diffstat**: new small helper alongside `getDiffStats()` in `cli/src/core/GitOps.ts` — same `git diff --stat` parsing, against `git diff --stat --cached` instead of two refs.
- Small shared, stateless presentation helpers (`ctxBadge`, `convSourceIcon`/`providerLabel`, exclude-toggle icon/label) extracted so both `SidebarScriptBuilder` and the new panel's script builder use one implementation — leaf helpers only, not row layout.
- Foreign-readonly / worker-busy gating mirrors the sidebar's existing rules (Review is already hidden in foreign-readonly mode per 06-26 §5; Commit Memory disables under `isWorkerBlocking()`).

**Out of scope (deferred)**
- Auto-regenerating the proposed title on every selection change (cost control — manual Regenerate only).
- Any new ticket-detection mechanism beyond reading it off an already-selected reference.
- Token usage for non-Claude sources (no data source exists; same degradation already accepted elsewhere in this codebase).
- Sharing full row-layout renderers between the sidebar and this panel (rejected — see §3 alternatives).
- Any change to the sidebar Working Memory card's own rendering (already aligned).

## 3. Architecture

### 3.1 Approaches considered

1. **(Chosen) New builder trio, panel subscribes to the sidebar's existing broadcast data, posts the sidebar's existing toggle messages.** Zero new selection state; the host stays the single source of truth. Visual layout is purpose-built for the panel's roomier `.panel`/`.row` mockup style (distinct from the sidebar's dense `.tree-node` style), while small leaf helpers (badges, icons) are shared.
2. **Extract shared row-renderers from `SidebarScriptBuilder` for both surfaces.** Rejected: the mockup's panel rows and the sidebar's tree rows are structurally different (different classes, density, metadata placement); forcing one renderer to serve both risks compromising either mockup surface, for marginal reuse on ~30-60 line functions.
3. **Keep it a static, richer-but-read-only preview.** Rejected per user decision — the mockup pane is genuinely interactive and the product intent is one shared editable draft, not a snapshot.

### 3.2 Data flow

`SidebarWebviewProvider.postMessage(msg)` (`vscode/src/views/SidebarWebviewProvider.ts:546`) currently posts only to `this.view.webview`. It gains a small broadcast list: additional `vscode.Webview` targets register themselves (the Next Memory panel adds itself on open, removes itself in `onDidDispose`) and receive the same messages. No other change to the ~15 `push*()` methods that already compute and send `branch:conversationsData` / `branch:plansData` / `branch:changesData` / `branch:pinsData` / `branch:tokenStats` — they keep calling `this.postMessage(...)` exactly as today; the fan-out is invisible to them.

The panel's script builder renders its `.panel`/`.row` layout directly from the same `SerializedTreeItem[]` payloads the sidebar already receives (source, messageCount, gitStatus, contextValue, isSelected, etc. are already present — no new fields needed for structure). Toggling a checkbox or the ✕/+ control posts the identical `branch:toggle*Selection` message shape the sidebar posts; the existing host handlers for those messages are untouched, so both surfaces reflect a change immediately (the host re-pushes `branch:*Data` to all registered targets after every mutation, as it already does today for the sidebar alone).

`getNextMemorySelection()` (`SidebarWebviewProvider.ts:1924`, the current lossy `{title}`/`{path}`-only DTO) is deleted along with the static HTML path in `NextMemoryPreviewPanel.ts` that consumed it.

### 3.3 New capabilities — sourcing and degradation

| Capability | Source | Degradation |
|---|---|---|
| Proposed title | `JolliMemoryBridge.generateCommitMessage()` (existing, same call the ✦ Commit Memory flow makes) | On failure: title panel shows a neutral "Couldn't generate a title" message + Regenerate button; rest of the panel renders normally |
| Detected ticket | First selected Context row where `contextValue === 'reference'` and label matches `TICKET_PATTERN` | Line omitted entirely when none match (not a placeholder) |
| Token meter (per-row + total) | `readTranscript(transcriptPath)` → `usageBreakdown`, summed over selected **Claude** conversations only | Non-Claude rows show "not reported"; total reflects only reporting sources, same accepted pattern as the Commit Memory detail panel |
| Staged diffstat | New helper beside `getDiffStats()` in `cli/src/core/GitOps.ts`, using `git diff --stat --cached` | No staged changes → diffstat segment omitted from the meta-strip |

## 4. Error handling

- `generateCommitMessage()` throws (no API key / network / LLM error): caught at the same boundary the ✦ flow already uses; panel shows the degraded title state above, does not block render of Conversations/Context/Files/Commit Memory.
- `readTranscript()` throws for a given conversation (moved/deleted file, permission error): that row's token figure degrades to "not reported"; does not fail the whole token meter or panel.
- Foreign-readonly branch: unreachable state for this panel — Review is already hidden under `isViewingForeign()` per the 06-26 spec; no new gate needed.
- Worker busy: Commit Memory button in the panel disables under the same `isWorkerBlocking()` condition the sidebar's body bar already uses.
- Fully empty selection (no conversations, no context, no files): existing "nothing selected" empty state is retained for this specific case; any non-empty subset renders its populated sections and omits empty ones (mirrors the mockup's `hide-empty` convention).

## 5. State coverage

| State | Behavior |
|---|---|
| **normal** | Full structure per §1; token meter and proposed title populate from live data. |
| **fully empty selection** | Existing empty-state copy retained; no Commit Memory action available. |
| **partially excluded** | Excluded rows render struck-through and dimmed, not hidden; toggling them updates both this panel and the sidebar. |
| **worker busy** | Commit Memory disabled with the same in-progress affordance as the sidebar body bar. |
| **generateCommitMessage failure** | Title panel degrades in isolation; everything else renders normally. |
| **foreign-readonly** | Unreachable — Review entry point is already hidden. |

## 6. Messages & commands

- **Reused, unchanged:** `branch:toggleConversationSelection`, `branch:togglePlanSelection`, `branch:toggleNoteSelection`, `branch:toggleReferenceSelection`, `branch:toggleFileSelection`, and the Context "+" add-menu dispatch.
- **New:** a broadcast-target registration path on `SidebarWebviewProvider` (internal, not a message type); a `command` dispatch for the panel's own Commit Memory button (delegates to the existing commit path); a `command` dispatch for "Regenerate title."
- **Removed:** the `getNextMemorySelection()` DTO and its consumption in `NextMemoryPreviewPanel.ts`.

## 7. Testing & coverage

- `NextMemoryHtmlBuilder.test.ts` / `NextMemoryCssBuilder.test.ts` / `NextMemoryScriptBuilder.test.ts`: structural + substring assertions, mirroring the existing `Summary*Builder.test.ts` / `SidebarScriptBuilder.test.ts` conventions.
- **Contract test (regression-critical):** assert the panel's outbound `branch:toggle*Selection` messages are field-identical to the sidebar's — the two emitters must never drift, since both feed one host handler.
- Token-summing helper: real pinned Claude transcript fixture per project convention (no invented usage lines); non-Claude source explicitly asserted as "not reported."
- Staged-diffstat helper in `cli/src/core/GitOps.ts`: held to the 97%/96% CLI coverage floor.
- `NextMemoryPreviewPanel.test.ts`: broadcast registration/deregistration on open/dispose, `generateCommitMessage` failure fallback, empty-selection state, worker-busy gating.
- State tests from §5.
- `npm run all` must pass before commit; DCO sign-off; no Claude co-author trailer.

## 8. Risks / open items

- **Supersedes a prior product decision.** The 06-26 spec's Unit C explicitly scoped this as read-only; this spec reverses that per the mockup. The 06-26 spec should get a short "Unit C superseded by 2026-07-03" note.
- **LLM call cost at Review-open time.** `generateCommitMessage()` runs once automatically on every panel open, plus again on each manual Regenerate click. If the automatic on-open call proves too eager in practice (e.g. users opening Review just to glance at the diff, not to commit), it can be dropped in favor of requiring the manual button even for the first generation — a follow-up, not built preemptively.
- **Broadcast fan-out lifecycle.** The panel must deregister from `SidebarWebviewProvider`'s broadcast list in `onDidDispose` or the provider will hold a dead `Webview` reference and leak pushes into the void; this needs explicit test coverage, not just code-review attention.
