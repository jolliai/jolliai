# Commit Memory detail panel — mockup alignment redesign

**Date:** 2026-07-02
**Branch:** `vscode-ui-memory-detail`
**Baseline mockup:** `jollimemory-design` repo — `vscode-interactive.html`, the editor-area panes `pane-memory` (synced / committed state) and `pane-memory-local` (no-PR / local / not-synced state). These two panes are the authority for this spec; where the rendered mockup and an inline design comment disagree, the **later share-simplify pass** wins (see §4.1).

**Relationship to prior specs:**
- Sibling to the three sidebar panel-alignment specs (`2026-06-26-current-branch-panel-mockup-alignment-design.md` and the Memory Bank / Knowledge specs). Those align the **sidebar**; this aligns the **editor-column Commit Memory detail panel** (`SummaryWebviewPanel` + its `Summary*Builder` trio).
- **Builds on** the per-memory token **breakdown** data layer shipped in `b0d3ca21` (`ConversationTokenBreakdown { input, output, cached }`, per-summary field, aggregation). This spec **consumes** it in the detail panel's token meter (§5) — it does not re-implement it. (This is the detail-panel counterpart to the sidebar token bar that `b0d3ca21` already renders.)
- The detail-panel redesign **scaffolding** (`.ship-bar`, `.panel`, `.meta-strip`, collapsible `#propTable`) already shipped alongside the sidebar redesign commit. This spec closes the remaining structural gaps against the mockup.

---

## 1. Summary

Align the Commit Memory detail panel to the `pane-memory` / `pane-memory-local` mockup. Five structural gaps, all confirmed against the current `SummaryHtmlBuilder` output:

1. **Ship bar: two cards → one Jolli card.** The PR card (`#prCard` wrapping `buildPrSectionHtml`) leaves the detail panel; Create PR now lives only in the dedicated `CreatePrHtmlBuilder` pane reached from the sidebar. The remaining Jolli card is reshaped to the mockup (`codicon-arrow-swap` icon, name "Jolli", `SYNCED`/`LOCAL` chip with sign-in and sync-state variants, `Open in Jolli` / `Push to Jolli`).
2. **New token meter (`.tmeter`).** A per-memory usage meter between the meta strip and the details table: total `conversationTokens`, a cache-aware `≈$` cost estimate, a `?` help popover, a segmented `input / output / cache` bar, and a legend. Degrades to a `.tmeter.na` "Task usage not reported" state when no session reports usage. **Segmented data comes from the existing `conversationTokenBreakdown`** (§5) — 3 segments (input / output / cached).
3. **Conversations → inline rows.** The current modal-based "Manage" flow (`.private-zone` + overlay) is replaced by inline `.row` elements per the mockup: source badge, title, right-aligned "N msgs", and a detach action (no Show/Continue resume buttons).
4. **New Files panel.** A dedicated panel listing changed files with per-file `M/A/D` status badges, click-to-open-diff, and off-branch handling (`.is-unresolvable` row + "Diffs open only on the checked-out branch" hint). Reuses the `git diff --name-status` → `parseDiffNameStatus` pipeline and row markup already proven in the Create PR pane.
5. **Context/Attachments: collapsible cards → flat rows.** The single "Attachments & context" panel (with `#plansCard` / `#sourceCard` collapsible cards) becomes a flat **Context** panel (plans + references as `.row` with `.kb-tag`, Edit/Open/Remove actions, a `+ Add` affordance, a count chip). **Source Commits are removed** from the detail panel (per the mockup — see §4.5).

Plus a **meta-strip reshape** (§4.6). Items 1, 3, 5, and the meta-strip are presentation + wiring changes that preserve every existing element id and message handler. Item 2 (token meter) **consumes** the per-memory `conversationTokenBreakdown` that already exists on the branch base (`b0d3ca21`) — no CLI work (§5). Item 4 (Files) reuses the existing `parseDiffNameStatus` pipeline.

## 2. Scope

**In scope**
- `SummaryHtmlBuilder.ts`: `buildShipBar`, `buildHeader` (meta strip + `#propTable` → `.mem-details`), new `buildTokenMeter`, `buildConversationsSection` → inline rows, new `buildFilesPanel`, `buildAttachmentsPanel` → flat Context panel (drop Source Commits), new footer privacy note.
- `SummaryCssBuilder.ts`: `.tmeter*`, `.mem-details`/`.md-row`, single-card ship bar + chip state variants (`.si-only`/`.so-only`, `.sc-todo`/`.sc-done`), inline conversation `.row`/`.badge`/`.conv-resume`, `.kb-tag`, Files `.gs`/`.fname-*`/`.is-unresolvable` — porting mockup values (which already mirror these token names).
- `SummaryScriptBuilder.ts`: `Details` disclosure toggle, `?` token-help pin toggle, conversation detach / Show / Continue bindings (reusing existing handlers), file-row open-diff binding, `+ Add` context binding. All via `addEventListener` + `.hidden` class (strict CSP — no inline handlers/styles).
- `SummaryWebviewPanel.ts`: new/renamed inbound messages only where an interaction has no existing handler (file open-diff; conversation detach if not already present). Existing message ids preserved.
- **Token meter data:** consume the existing `summary.conversationTokenBreakdown` (§5) — no CLI change.
- Files panel status pipeline: reuse `CreatePrData.parseDiffNameStatus`; a host-side per-commit `git diff --name-status` fetch keyed by the memory's commit + branch reachability check for off-branch handling.
- All detail-panel **states**: synced, local/not-synced (with sign-in variants), foreign-readonly, stale-rewritten.

**Out of scope (deferred)**
- Create PR flow itself — unchanged; owned by `CreatePrHtmlBuilder` / its pane.
- The `SummaryWebviewPanel` message **protocol shape** and every existing element id / handler — preserved, not refactored.
- Wiki topic / conversation / diff / reference **detail panes** shown elsewhere in the mockup (`pane-convo`, `pane-diff`, `pane-plan`, `pane-ref-*`, wiki) — separate surfaces.
- Retroactive backfill of the token breakdown onto **already-stored** summaries — new field is optional; old summaries render the meter from `conversationTokens` total with the bar degraded (see §5.4). No migration re-run.

## 3. Target structure (top → bottom)

```
feat(...): <commit message>                              ← h1 .page-title
269d1089 · <branch> · <time> · Details · [Share] [Export]  ← .meta-strip (author/date/changes move into details)
▁▁▁▁▁▁▁▁ 1.4M tokens · ≈$1.60 · this task   [?]           ← .tmeter (head + bar + legend); .tmeter.na when unreported
  ├ .mem-details (Commit / Author / Summary by / Linked)   ← collapsed; toggled by "Details"
┌ Jolli ───────────────────────────────── SYNCED ┐        ← .ship-bar > single .ship-card (PR card removed)
│ Auto-synced …            [ Open in Jolli ]      │
└─────────────────────────────────────────────────┘
┌ Memory ─────────────────────────────────────────┐        ← recap (topics grid stays inside)
┌ E2E Test Guide ───────────────────── 3 SCENARIOS ┐        ← unchanged panel, count chip
┌ Conversations ─────────────────────────────── 2 ┐        ← inline .row (badge · title · N msgs · detach [· Show/Continue])
┌ Context ─────────────────────────────── 2  [+ Add]┐       ← flat .row (kb-tag · title · Edit/Open/Remove)   [Source Commits removed]
┌ Files ───────────────────────────────────────── 3 ┐       ← NEW: per-file row (fname · dir · M/A/D badge), click→diff; off-branch hint
🔒 Full conversation transcripts (n) stay in your repo …     ← footer privacy note (replaces attribution footer? see §4.7)
```

`foreign-readonly` and `stale-readonly` modes keep hiding destructive controls via the existing page-class CSS rule; the reshaped elements carry the same `data-foreign-safe` gating they carry today.

## 4. Per-section design

### 4.1 Ship bar → single Jolli card

The inline mockup comment on `pane-memory` is explicit: *"the Jolli card offers only Open (PR moved out of the ship area per the share-simplify pass)."* The `pane-memory` recap text still mentions "unifying Create PR and Jolli sync" — that describes an **earlier** iteration; the rendered pane is Jolli-only and the share-simplify comment is the later decision, so **the ship bar shows one card, no PR card**.

- `buildShipBar` drops the `#prCard` branch entirely. `buildPrSectionHtml` is no longer called from the detail panel.
- **Handler safety:** before deleting, grep for inbound/outbound messages and script bindings that reference `#prSection` / `#prCard` / the PR create button ids. Any that the panel still needs are relocated to the Create PR pane's ownership; if any handler is *only* reachable from the detail panel and still required, hide `#prSection` with `.hidden` instead of removing the DOM (preserve handler) and note it in §9. Expectation from the code read: the Create PR flow already has its own pane (`CreatePrHtmlBuilder`, `createPr` command), so full removal is expected to be safe.
- The Jolli card is reshaped to the mockup:
  - head: `codicon-arrow-swap` icon (was `◆`), name "Jolli" (was "Jolli Memory"), status chip.
  - chip states: `.ship-status.is-ok` `SYNCED` vs `.local-chip` `LOCAL`, plus sign-in variants (`.si-only` signed-in / `.so-only` signed-out) and the local pane's sync-state variants (`.sc-todo` not-yet-synced / `.sc-done` synced). Driven by `summary.jolliDocUrl` (synced) and the panel's existing auth state.
  - sub-text + actions per state: signed-in synced → "Auto-synced …" + `Open in Jolli`; not-synced → "Not synced. Share once …" + `Push to Jolli`. Reuse the existing `#pushJolliBtn` handler and `buildJolliRow` link block.

### 4.2 Token meter (`.tmeter`)

Rendered by a new `buildTokenMeter(summary)` between the meta strip and `.mem-details`.

- **Total + cost:** `.tmeter-head` shows `summary.conversationTokens` formatted (e.g. `1.4M`), a cache-aware `≈$` estimate ("assumes Sonnet pricing" tooltip), and "· this task", plus a `?` help affordance whose `.tok-pop` popover explains the count and cost basis and notes when not all sessions report usage. The `?` toggles a `.pinned` class via `addEventListener` (no inline handler).
- **Bar + legend:** `.tmeter-bar` renders three segments (`.seg-in` / `.seg-out` / `.seg-cache`) sized from the existing per-memory `summary.conversationTokenBreakdown` (§5); `.tmeter-legend` labels them. The breakdown is the 3-field `ConversationTokenBreakdown { input, output, cached }` — `cached` is `cache_creation` only; `cache_read` is deliberately excluded (it is a per-turn running total that would double-count). Invariant `input + output + cached === conversationTokens`, so the three segments sum to 100%.
- **`.tmeter.na` state:** when `conversationTokens` is absent/0 (no usage-reporting session — e.g. Codex-only), render the `na` variant with "Task usage not reported" and the explanatory popover; no bar.
- **Segment sizing** uses percentages of the total; widths are set via CSS custom properties / classes, never inline `style=` (CSP). A small set of width buckets or a CSS var (`--seg-in-pct`) set through a `style` attribute is disallowed by CSP; instead emit a `data-*` value and let the script set `el.style.width` after load, or pre-bucket to fixed classes. **Chosen:** script reads `data-pct` and sets `style.width` at runtime (allowed — it's a property write, not an inline attribute).

### 4.3 Conversations → inline rows

`buildConversationsSection` is rewritten to emit a `.panel` with a count chip and one `.row` per linked conversation, dropping the `.private-zone` header/description and the manage-modal overlay markup.

- Row: `.badge.src-<source>` (claude/codex/gemini/…), `.r-main > .r-title`, right-aligned `.r-meta` "N msgs" (`.hide-on-hover`), `.r-actions` with a detach (trash) button. **No Show/Continue resume buttons** (dropped per product decision — the row's only action is detach; opening the transcript, if wired, is a row click, not a button).
- **Handler reuse:** detach maps to the panel's existing conversation detach handler. If detach has no existing message, add one inbound message `conversationDetach` (hash + session id). Removal is an in-place row removal (no full-panel rebuild), mirroring the sidebar's precise in-place update rule.
- The transcript privacy note moves to the footer (§4.7). Transcripts remain repo-only; no transcript body is inlined here.

### 4.4 Files panel (new)

New `buildFilesPanel(summary, fileRows)` renders a `.panel` ("Files" + count chip) with one `.row` per changed file, markup identical to the Create PR pane's `buildFileRows` (`.r-main > .r-title.fname-<status>` + `.r-sub` dir + `.gs.gs-<status>` badge).

- **Data:** host computes rows via the shared `parseDiffNameStatus` over `git diff --name-status` for the memory's commit (same parser the Create PR pane uses; the two `parseDiffNameStatus` copies in `CreatePrData.ts` and `JolliMemoryBridge.ts` stay in lockstep — extend the shared one, don't fork a third). Rows are posted to the webview (or embedded at build time when already resolved).
- **Off-branch handling:** when the memory's commit is not reachable on the checked-out branch (foreign Memory Bank repo, or a different branch), the diff can't be resolved. Render `.row.is-unresolvable` (no click) plus a `.files-offbranch-hint` "Diffs open only on the checked-out branch. Check out `<branch>` to view these changes." — matching `pane-memory-local`.
- **Click → diff:** a resolvable row opens the file's diff at that commit via a new inbound message `openFileDiff` (path + commit hash) handled in `SummaryWebviewPanel` using the existing VS Code diff/command plumbing. If an equivalent command already exists, reuse it.

### 4.5 Context panel (flat) + Source Commits removed

`buildAttachmentsPanel` becomes `buildContextPanel`:

- One flat `.panel` "Context" with a count chip and a `+ Add` affordance (reusing the existing add-plan / add-note commands and menu).
- Rows: plans (`.kb-tag.t-plan`), notes, and references (`.kb-tag.t-ref`) as sibling `.row` elements — Edit/Open-in-browser/Remove actions per type, matching the mockup. No `.attach-card` collapsible wrappers.
- **Source Commits removed** (user decision; the mockup has no Source Commits section). `buildSourceCommits` / `#sourceCard` are dropped from the detail panel. Confirm no inbound message depends on `#sourceCard` before removal; if a handler is orphaned, remove it too. The `sourceNodes` collection stays available in the model (other consumers) but is no longer rendered here.
- Refresh boundaries: plans/notes/references share `#plansAndNotesSection` today; keep that inner id so `plansAndNotesUpdated` in-place refreshes keep working, just re-parented into the flat Context panel.

### 4.6 Meta strip reshape

- Strip content: `hash · branch · time · Details · [Share] [Export]`. `Details` becomes a dotted-underline toggle (mockup style) driving the `.mem-details` disclosure (keep the existing `#detailsToggle` id + `aria-expanded` wiring; restyle only). **Share** and **Export** buttons move into the strip (Export replaces the old "Copy Markdown" split button; its menu items — Copy Markdown / Save as Markdown File — move under Export). The separate `.header-actions` row is removed; `#regenerateSummaryBtn` relocates (into the Export menu or kept adjacent) — retain its id and foreign-mode omission.
- The `#propTable` collapsed table is replaced by `.mem-details` with `.md-row` (`.md-k`/`.md-v`) rows trimmed to the mockup's four: **Commit** (hash + copy), **Author** (name + full date), **Summary by** (model + "N tokens to write this summary" from `summary.llm`), **Linked** ("N conversations · N context · N files"). Branch/Date/Duration/Changes rows are dropped (branch + time already in the strip; changes now in the Files panel). **Decision:** keep the existing `#propTable` element id and retarget its content to the `.mem-details` rows (minimal change; the `#detailsToggle` wiring and existing tests keep pointing at `#propTable`).

### 4.7 Footer

Replace the attribution `.page-footer` with the mockup's privacy note: `🔒 Full conversation transcripts (n) stay in your repo — never included in shared exports.` (n = linked conversation count). **Decision:** the current attribution footer ("*Generated by Jolli Memory · …*") is an intentional product signature and is **kept**; the `🔒` privacy note is added **above** it. The mockup's omission of attribution is treated as a mockup simplification, not a decision to drop the signature.

## 5. Token-breakdown data — CONSUME the existing field (no CLI work)

**This section changed after implementation began.** The token-breakdown CLI vertical this spec originally described was found to already exist on the branch this work rebased onto — commit `b0d3ca21` ("Add token usage breakdown tracking for VS Code sidebar rendering"). The detail panel's token meter (§4.2) **consumes** it; no CLI change is made here.

### 5.1 What already exists (`b0d3ca21`)
- `ConversationTokenBreakdown = { readonly input: number; readonly output: number; readonly cached: number }` in `cli/src/Types.ts` — **3 fields.** `cached` is `cache_creation_input_tokens` only. `cache_read_input_tokens` is EXCLUDED because it is a per-turn running total; summing it across a slice re-counts the cached prefix and inflates the total ~10× (guarded by the `ClaudeTranscriptParser` "C6" regression test). Invariant: `input + output + cached === conversationTokens`.
- The optional per-summary field `conversationTokenBreakdown?: ConversationTokenBreakdown` on the summary node types, populated by `TranscriptReader` (Claude only exposes it today) → `QueueWorker` assembly, and summed field-wise across consolidation trees in `SummaryTree`. It persists to both the orphan-branch JSON and the Memory Bank folder JSON via the existing serializer.

### 5.2 What this spec does
- `buildTokenMeter` (§4.2) reads `summary.conversationTokens` (total) and `summary.conversationTokenBreakdown` (segments) and imports the `ConversationTokenBreakdown` type from the CLI types. **No new type is introduced; no CLI file changes.**

### 5.3 Degradation (consumer side)
- `conversationTokenBreakdown` absent (non-Claude sessions, old summaries) → meter shows the real `conversationTokens` total with the bar collapsed to a single segment; no fabricated split.
- `conversationTokens` absent/0 → `.tmeter.na` ("Task usage not reported").
- The summary-write usage (`summary.llm.inputTokens/outputTokens/cachedTokens`) is a SEPARATE number, used only for the `.mem-details` "N tokens to write this summary" line — not the task meter, and not conflated with `conversationTokenBreakdown`. (Summary-write `cachedTokens` is commonly 0 because summarization prompt-caching isn't enabled — a known data reality, not a meter bug.)

### 5.4 Provenance
Original Tasks 1–3 in the plan (a 4-field `UsageBreakdown` with `cacheRead` summed in) were **wrong** — they would have reintroduced the cache_read inflation bug and duplicated `b0d3ca21`. They are retired; see the plan's "Tasks 1–3 — RETIRED" note.

## 6. States

| State | Ship card | Token meter | Files | Destructive actions |
|-------|-----------|-------------|-------|---------------------|
| Signed-in, synced | Jolli · SYNCED · Open in Jolli | real total + bar (if breakdown) | resolvable rows, click→diff | shown |
| Signed-in/out, local | Jolli · LOCAL · Push to Jolli (sign-in variant text) | real or `.na` | rows; off-branch hint if not checked out | shown |
| foreign-readonly (cross-repo Memory Bank) | Jolli card, no destructive | `.na` or total | **off-branch** `.is-unresolvable` + hint | hidden (`data-foreign-safe` gate) |
| stale-rewritten | stale banner on top (unchanged) | as data allows | as reachability allows | hidden |

## 7. Testing (TDD)

- **Builder structure tests** (`SummaryHtmlBuilder.test.ts`): per-section failing-first assertions pinning the mockup structure — single ship card (no `#prCard`), `.tmeter` presence + `.na` variant, inline conversation `.row` (no `.private-zone`), Files panel rows + off-branch hint, flat Context panel (no `.attach-card`, no Source Commits), reshaped meta strip + `.mem-details` four rows.
- **Token meter tests** (VS Code, structural): segmented bar when `conversationTokenBreakdown` present (three `.seg-*`), total-only degrade when absent, `.tmeter.na` when `conversationTokens` is 0. (The CLI breakdown itself is already tested on `b0d3ca21` — not re-tested here.)
- **Script/interaction tests** (`SummaryScriptBuilder.test.ts` / panel tests): Details toggle, `?` pin toggle, detach in-place removal, file-row open-diff message, `+ Add` — using the polling helper for any async handler (avoid single-tick flakiness).
- **Panel message tests:** new `openFileDiff` / `conversationDetach` inbound handlers; existing handlers unaffected.
- Run `npm run all` once at the end (not per-task).

## 8. File-level change map

- `vscode/src/views/SummaryHtmlBuilder.ts` — buildShipBar, buildHeader, +buildTokenMeter, buildConversationsSection, +buildFilesPanel, buildAttachmentsPanel→buildContextPanel, buildFooter.
- `vscode/src/views/SummaryCssBuilder.ts` — new/ported classes (§2).
- `vscode/src/views/SummaryScriptBuilder.ts` — toggles + bindings (§2).
- `vscode/src/views/SummaryWebviewPanel.ts` — new inbound messages only (openFileDiff, conversationDetach if absent); Files rows plumbing.
- **No CLI files change.** The token breakdown data layer (`ConversationTokenBreakdown`, per-summary field, aggregation) already exists on the branch base (`b0d3ca21`); `buildTokenMeter` only imports the `ConversationTokenBreakdown` type and reads `summary.conversationTokenBreakdown`.
- `cli/src/core/…` shared `parseDiffNameStatus` — reused for Files status (no third copy).

## 9. Intentionally unchanged

- **`SummaryWebviewPanel` message protocol + every existing element id / handler** — preserved. New messages are additive.
- **Create PR flow** (`CreatePrHtmlBuilder` + its pane) — untouched; the detail panel simply stops hosting a PR card.
- **`conversationTokens` semantics** and the **summary-write `llm` usage** — unchanged; the new breakdown is additive and kept distinct from summary-write usage.
- **StorageProvider / orphan-branch + folder dual-write** — no change; the new field rides the existing serializer.
- **Runtime data paths, package names, orphan branch name** — unchanged.
- **Attribution footer** — kept per §4.7 (pending review confirmation); the product signature is not dropped.
- **CLI transcript parsers for sources that don't expose usage components** — left scalar-only; they degrade rather than gain fabricated splits.

## 10. Resolved decisions (review gate)

1. **Footer (§4.7):** keep the attribution footer AND add the `🔒` privacy note above it.
2. **`#propTable` id (§4.6):** keep the existing `#propTable` id; retarget its content — no rename.
3. **Token breakdown source (§5):** the data layer already exists on the branch base (`b0d3ca21`, Claude-only); this spec only consumes it. Non-Claude memories degrade to the total-only meter.
