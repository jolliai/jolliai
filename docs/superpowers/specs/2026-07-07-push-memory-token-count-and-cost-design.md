# Push memory: token count & cost in the article body

## Problem

A memory pushed to a Jolli Space renders a Markdown article whose Properties
section lists Commit / Branch / Author / Date / Duration / Changes /
Conversations — but **not** the conversation token count or its estimated cost.
The VS Code Commit Memory panel already shows a token meter
(`12.4M tokens · ≈$4.20 · input / output / cached`, `buildTokenMeter` in
`vscode/src/views/SummaryHtmlBuilder.ts`), so the pushed article is missing
information the local surface already displays.

The structured data is *already* pushed: `pushSummary` sends `summaryJson`
(the full `CommitSummary`, including `conversationTokens` and
`conversationTokenBreakdown`). Only the human-readable Markdown body omits it.
Cost is a derived estimate (not stored anywhere) computed at display time from
per-token Sonnet-pricing constants.

## Goal

Add a single `Task usage` line to the shared Markdown Properties section so both
the pushed Space article and the clipboard export show the token total, an
estimated cost, and (when available) the input/output/cached split — matching
the VS Code token meter's numbers exactly.

## Non-goals

- No new structured field on `PushPayload`. `summaryJson` already carries
  `conversationTokens` / `conversationTokenBreakdown`; cost is derived and, per
  existing convention, never persisted.
- No backend / wire-schema change.
- No change to the VS Code token meter's own rendering.

## Display format (three states)

The line is appended to `pushPropertiesSection` (shared by `buildPushMarkdown`
and the clipboard-export `buildMarkdown`), placed after the `Conversations`
line. It mirrors the three states of `buildTokenMeter`:

| State | Rendered line |
|-------|---------------|
| Breakdown present | `- **Task usage:** 12.4M tokens · ≈$4.20 (8.1M input, 1.2M output, 3.1M cached)` |
| Total > 0, no breakdown | `- **Task usage:** 12.4M tokens · ≈$4.20` |
| Total == 0 | line omitted entirely |

Omit-when-zero matches the established pattern in the same function
(`Conversations` is only emitted when `totalTurns > 0`) — a Markdown property
list has no "empty state" analogue to the panel's "Task usage not reported".

Token counts use `formatTokensCompact`; the cost uses the `≈$X.XX` / `<$0.01`
formatting of `formatSonnetCostEstimate`, so the article and the panel never
disagree on the same underlying counts.

## Data source

Aggregate across the whole consolidation tree — NOT the root's own scalar — via
the existing helpers in `cli/src/core/SummaryTree.ts`:

- `aggregateConversationTokens(summary)` → the headline total.
- `aggregateConversationTokenBreakdown(summary)` → the input/output/cached split
  (returns zeros when no segment data exists; treat all-zero as "no breakdown").

This is the same tree walk the VS Code meter uses, so a squash/amend memory that
carries its tokens on folded children totals correctly.

## Cost estimate

Cost is derived, mirroring `estimateCost` in `SummaryHtmlBuilder.ts`:

- With a breakdown: `input·INPUT + output·OUTPUT + cached·CACHE_WRITE`.
- Without: `total·INPUT` (a floor — we don't fabricate a split we don't have).

Constants are the current Sonnet-pricing per-token values
(`3 / 15 / 3.75` per million). The `≈$` prefix already signals "estimate";
actual cost varies by model, as the existing tooltip notes.

## Code structure — single source of truth

The cost constants and formatting helpers currently live only in
`vscode/src/views/SummaryUtils.ts`. The CLI Markdown builder
(`cli/src/core/`) is the lower layer and cannot depend on VS Code, yet the
repo's standing constraint is that the two surfaces "never disagree on the same
number". Resolution: sink the primitives into CLI core; VS Code re-exports them.

1. **New `cli/src/core/TokenCost.ts`** — moved from `SummaryUtils.ts`:
   - `SONNET_INPUT_PER_TOKEN`, `SONNET_OUTPUT_PER_TOKEN`,
     `SONNET_CACHE_WRITE_PER_TOKEN`
   - `formatTokensCompact(n)`
   - `formatSonnetCostEstimate(costUsd)`
   - `estimateConversationCostUsd(breakdown | undefined, total)` → number — the
     non-HTML core of `SummaryHtmlBuilder.estimateCost`.

2. **`vscode/src/views/SummaryUtils.ts`** re-exports the moved symbols from
   `../../../cli/src/core/TokenCost.js` (the intentional bundle-time
   cross-package import pattern) and drops the local definitions. Existing
   imports in `SummaryHtmlBuilder.ts` / `SidebarScriptBuilder.ts` keep resolving
   the same numeric values, so those files are untouched. `SummaryHtmlBuilder`'s
   `estimateCost` may delegate to `estimateConversationCostUsd` +
   `formatSonnetCostEstimate` to avoid a second copy of the arithmetic.

3. **`cli/src/core/SummaryMarkdownBuilder.ts` `pushPropertiesSection`** appends
   the `Task usage` line using `SummaryTree`'s aggregation helpers and
   `TokenCost`'s formatting.

## Testing

- `cli/src/core/TokenCost.test.ts` — `formatTokensCompact` boundaries
  (`999_500` → `1M`, `1_000` → `1k`), `formatSonnetCostEstimate` (`<$0.01`
  boundary), `estimateConversationCostUsd` with and without a breakdown.
- `cli/src/core/SummaryMarkdownBuilder.test.ts` — the three `Task usage` states
  (breakdown / total-only / omitted), and that a squash tree aggregates across
  children rather than reading the root scalar.
- VS Code: update any test that asserted on the moved symbols' original import
  location; the numbers are unchanged.
- Hold the CLI coverage floor (97% statements / 96% branches / 97% functions /
  97% lines).

## Files touched

- `cli/src/core/TokenCost.ts` (new) + `TokenCost.test.ts` (new)
- `cli/src/core/SummaryMarkdownBuilder.ts` + its test
- `vscode/src/views/SummaryUtils.ts` (re-export; delete local defs)
- `vscode/src/views/SummaryHtmlBuilder.ts` (optional: delegate `estimateCost`)
