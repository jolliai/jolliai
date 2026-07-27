# 243 — Token Usage Extraction and Cost Estimation (Sonnet-Only Estimator)

## Topic Statement

Extract a per-turn input / output / cached token breakdown from a Claude Code
transcript and estimate a dollar cost from it at a single hardcoded Sonnet-class
rate, plus the family of formatters that render token counts and costs on the
pushed-memory article and the token-usage meters. This spec now describes one
specific estimator among two that coexist in the product — see the Out-of-Scope
note on [257 — Multi-Provider Pricing and Cost Estimation] for the other.

**Product-wide scope correction:** every claim below about "no per-model
table" and "the model is never consulted for pricing" is still exactly true of
*this* estimator (the Sonnet-only one) and of the surfaces that call it — the
per-commit token meter, the pushed-memory article's "Task usage" line, and the
PR-body markdown. It is **no longer true product-wide**: a second, model-aware
pricing path now exists and is the primary source for the VS Code sidebar's
branch-level token bar (see [257]). Read every "no per-model table" statement
in this spec as scoped to the Sonnet-only estimator, not as a product-wide
guarantee.

## Scope

**In scope**

- The per-turn token-usage breakdown shape (input, output, cached) extracted from a raw transcript line.
- The rule that the "cached" segment carries cache-creation tokens only, and why the cache-read counter is deliberately excluded.
- The gating of usage accumulation by the line-level time cutoff, independent of whether a line produced a displayable conversation turn.
- The Claude-only nature of real token usage: no other producer's transcript carries a usage figure anywhere in the product.
- The single hardcoded per-token pricing table (Sonnet-class) and the deliberate absence of any per-model lookup or unknown-model fallback **in this estimator**.
- The cost-estimation function: segment-priced when a breakdown is available, floored to the input rate when it is not.
- The compact and exact token formatters and the compact and exact cost formatters, including their rounding boundaries.
- The pushed-memory-article "Task usage" line: tree-aggregated total + cost, the omit-when-zero rule, the optional per-segment split, and the NaN-avoidance in the aggregation.
- The fact that the sidebar's client-side cost fallback (used only when the branch's write-time, model-aware cost is absent or zero) reads these same Sonnet-rate constants directly — the one place the model-aware surface still touches this spec's numbers.

**Out of scope (boundaries)**

- **The model-aware, per-model-table pricing path** — a second, independent cost estimator that prices a commit's actual conversation model(s) at their own rates, feeds the VS Code sidebar's branch token bar as its primary source, and is stamped on the commit summary at write time (see [257 — Multi-Provider Pricing and Cost Estimation]). This spec's estimator and that one are not the same code and must not be conflated.
- Summing real usage across a caller-supplied set of transcripts for the live review-panel meter (see [244 — Conversation Token Totals for the Review Panel]).
- Attributing and storing per-conversation usage during commit-summary generation, including exclusion and overlay-delete zeroing (see [245 — Commit-Pipeline Conversation Token Attribution]).
- The tree-aggregation helpers themselves and the token fields on the summary record (see [04 — Summary Tree Structure]).
- How a Claude transcript is read, cleaned, cursored, and time-cut (see [16 — Claude Code Transcript Reading]).
- The product's own summarization LLM-call cache accounting, which is a different figure (see [08 — Anthropic Message API Call]).

## Data Contracts

### Per-turn token breakdown

A record of three non-negative integers:

- `input` — uncached input tokens for the turn.
- `output` — output tokens for the turn.
- `cached` — cache-**creation** tokens for the turn (the portion newly written to the prompt cache on this turn).

The scalar total of a breakdown is `input + output + cached`. This is the same
scalar historically stored as a single "conversation tokens" number, so a
breakdown and its scalar total are always mutually consistent.

### Source usage counters (external Claude transcript format)

Each Claude transcript line may carry a usage object whose counters this layer
maps as follows:

- uncached-input count → `input`.
- output count → `output`.
- cache-creation count → `cached`.
- **cache-read count → deliberately dropped (never mapped, never summed).**

### Pricing table (the data contract; exact constants are load-bearing)

A single hardcoded per-token USD price list at Sonnet-class rates, applied
regardless of which model actually produced the transcript:

| Segment | USD per token | Equivalent per 1,000,000 tokens |
| ------- | ------------- | -------------------------------- |
| input (uncached) | `3 / 1000000` | $3.00 |
| output | `15 / 1000000` | $15.00 |
| cached (cache-creation) | `3.75 / 1000000` | $3.75 |
| cache-read | — (excluded upstream; never priced) | — |

Within this estimator there is **no** per-model table and **no**
unknown-model fallback branch, because the model identifier is never consulted
when pricing. The cache-read segment has no price entry because it is dropped
during extraction and can never reach the cost function. (A separate,
model-aware price table exists elsewhere in the product for a different
consumer — see the Out-of-Scope note on [257 — Multi-Provider Pricing and
Cost Estimation] — but nothing in this estimator reads it.)

## Behavior

### Per-line usage extraction

For each raw transcript line, the usage object (if any) is parsed and its
counters mapped to the breakdown as described in the source-counter contract. A
line that fails to parse, or that has no usage object, yields a zeroed breakdown
(`{input: 0, output: 0, cached: 0}`) rather than an error.

Usage is accumulated **per raw line**, not per displayable turn. A line that
carries a real usage object but produces no conversation turn (for example an
assistant turn whose only content was a tool call, so it has no display text)
still contributes its tokens. Accumulation is gated only by the read's
line-level time cutoff (see [16 — Claude Code Transcript Reading]): a line past
the cutoff halts the read and contributes nothing; every line at or before the
cutoff contributes its usage, turn-bearing or not. The running per-segment sums
over the consumed slice become that read's breakdown, and their scalar sum
becomes that read's total.

### The cache-read exclusion (load-bearing reality — document verbatim)

The cache-read counter is **cumulative**, not per-turn. In real Claude
transcripts it is emitted on every assistant turn as the running total of the
cached prefix re-read so far, so it grows monotonically across the turns of a
single session (e.g. it climbs 16036 → 26231 → 50109 → … within one session).
Summing it across the turns of a slice therefore re-counts the already-counted
cached prefix on every turn and inflates the total by roughly an order of
magnitude. The genuine new spend per turn is uncached input + cache-creation +
output; the cache-read of an already-counted prefix is not new work. The cached
segment is therefore defined as cache-creation only, and the cache-read counter
is dropped entirely. This is intentional: it is the reason the "cached" figure
never matches a naive re-read of the raw transcript's cache-read field.

### Claude-only usage

Only the Claude transcript reader extracts a usage breakdown. Every other
producer's reader (Codex, Gemini, OpenCode, Cursor, Copilot CLI, Copilot Chat)
exposes no usage method, so every read from those sources yields a zero total
and no breakdown. Consequently, anywhere in the product where real token usage
appears, it originated from a Claude transcript; a mixed-source commit's usage
figure reflects only its Claude conversations.

### Cost estimation

Given an optional breakdown and a scalar total:

- **With a breakdown**: price each segment at its own rate —
  `input × (3/1000000) + output × (15/1000000) + cached × (3.75/1000000)`.
- **Without a breakdown**: floor the whole total to the input rate —
  `total × (3/1000000)`.

The no-breakdown path is a deliberate **underestimate** whenever output tokens
are present, because output is priced five times higher than input but the floor
prices everything at the input rate. This is accepted: the product never
fabricates a segment split it does not have.

Every produced cost is documented as a **ballpark estimate, not a billing-accurate
figure** — actual cost varies by the true model and by cache-read savings that
this estimate does not represent.

### Token formatters

- **Compact** (space-constrained meters): for a count at or above **999,500**,
  render millions with one decimal place and a stripped trailing `.0` (so
  `999,800` → `1M`, `1,443,000` → `1.4M`, `2,000,000` → `2M`). The 999,500
  boundary exists so a count that would round up to 1000-thousand promotes to
  the `M` form instead of rendering the nonsensical `1000k`. For a count at or
  above **1,000** (but below 999,500), render rounded thousands with a `k`
  suffix (`96,000` → `96k`). Below 1,000, render the integer itself.
- **Exact** (article): render the rounded integer with thousands separators
  (`3,000,000`).

### Cost formatters

- **Compact** (meters): at or above `$0.01`, render `≈$X.XX` (two decimals with
  an approximation prefix); below that, render the floor `<$0.01`.
- **Exact** (article): tiered rounding so a real small amount never displays as
  all-zeros —
  - at or above `$0.01` → two decimals (`$21.75`);
  - at or above `$0.00005` → four decimals (`$0.0034`);
  - any remaining strictly-positive value → the floor `<$0.0001`;
  - exactly zero → `$0.00`.
  There is no approximation prefix on the exact form: the article surfaces the
  precise computed figure (precision here is about not rounding the number away,
  not about billing accuracy).

### Pushed-article "Task usage" line

On the pushed-memory / clipboard / folder-export article, a "Task usage"
property line is rendered from the whole consolidation tree (a squash or amend
memory carries its tokens on its folded children, so the figure is the
tree-aggregated total, not the root's own):

1. Compute the tree-aggregated scalar total. If it is not greater than zero,
   omit the line entirely (there is no "not reported" state in the article's
   property list — omit-when-zero, mirroring the neighboring conversation-turns
   line).
2. Compute the tree-aggregated per-segment breakdown. Treat it as a usable
   breakdown only when at least one of its segments is greater than zero;
   otherwise treat it as absent so the cost falls back to the input-rate floor.
3. Render the line as the exact thousands-separated total, then the exact tiered
   cost, then — only when a usable breakdown exists — an optional split
   `(<input> input, <output> output, <cached> cached)` in exact form.

This line is rendered on the article surface only; it is **not** rendered in the
pull-request-body markdown.

### NaN-avoidance in aggregation

The tree aggregation of the per-segment breakdown falls back to zero **per
field**, not per object. Summaries are read back without schema validation, so a
present-but-partial breakdown (hand-edited, older schema, or a future producer
that writes only some segments) must not leak a missing field into the sums —
missing-plus-number is NaN, and because `NaN > 0` is false, an NaN total would
make the whole figure silently vanish from the article and the meter. Per-field
zero-fallback keeps a partial breakdown contributing its present segments.

## Notable Behavior

- **Cache-read is a cumulative trap, not a per-turn delta.** Excluding it is the
  single most load-bearing rule in this spec; including it inflates totals by an
  order of magnitude. (Surprising; intentional. Bug-as-feature: the "cached"
  figure is cache-creation only by design.)
- **The model is never consulted for pricing, within this estimator.** Every
  transcript passing through this path is priced at the one hardcoded
  Sonnet-class table regardless of the model that produced it; there is no
  per-model table and no unknown-model fallback here. The resulting cost is
  explicitly a ballpark. This is still true of the per-commit meter, the
  pushed-article line, and the PR-body markdown — but it is no longer true of
  the whole product: the VS Code sidebar's branch token bar now prefers a
  model-aware, per-model-priced figure computed at write time, falling back to
  this spec's Sonnet-rate constants only when that figure is absent or zero
  (see [257 — Multi-Provider Pricing and Cost Estimation]). (Bug-as-feature,
  now scoped rather than product-wide.)
- **The no-breakdown cost is a deliberate underestimate** when output is
  present, because the floor prices everything at the input rate. (Intentional.)
- **Usage accumulates per raw line, not per turn.** A tool-only assistant turn
  contributes tokens even though it produces no displayable conversation turn.
  (Notable.)
- **The 999,500 compact boundary** is chosen so rounding never emits `1000k`.
  (Notable.)
- **Exact cost never renders all-zeros for a real amount**: a positive value too
  small for four decimals renders `<$0.0001` rather than `$0.0000`. (Notable.)
- **Per-field zero-fallback in aggregation** prevents an `NaN` from silently
  hiding the figure, since `NaN > 0` is false. (Surprising; intentional.)
- **Only Claude carries real usage.** Every other producer contributes zero, so
  a mixed-source commit's usage reflects only its Claude conversations.
  (Notable.)

## Shared Behavior

- The pricing constants and the formatters are the single source of truth shared
  by the article builders and the token meters, so those surfaces can never
  disagree on the same underlying counts. This is now also true of the sidebar's
  client-side cost fallback: it imports these same Sonnet-rate constants
  directly rather than duplicating them, so its fallback figure never drifts
  from this spec's numbers even though it is otherwise a [257]-driven surface.
- The per-turn breakdown shape is the same shape summed by the review-panel
  meter (see [244 — Conversation Token Totals for the Review Panel]) and
  attributed per conversation during commit-summary generation (see
  [245 — Commit-Pipeline Conversation Token Attribution]).
- The token fields persisted on a summary and the tree-aggregation helpers are
  defined in [04 — Summary Tree Structure].
- The model-aware pricing path that now coexists with this estimator is defined
  in [257 — Multi-Provider Pricing and Cost Estimation]; it is a parallel,
  independent estimator, not a replacement for the one described here.
