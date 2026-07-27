# 257 — Multi-Provider Pricing and Cost Estimation

## Topic Statement

A hand-maintained, per-model USD list-price table keyed by the exact model
identifier that appears in a transcript, plus the uniform cost formula that
prices a model's normalised token usage against it — the write-time cost
estimate stamped on a commit summary and read by the VS Code sidebar's branch
token bar.

## Scope

**In scope**

- The per-model price table: provider tag, input rate, output rate, cached
  rate, all in USD per 1,000,000 tokens, plus the table's verification-date
  stamp.
- The uniform cost formula and the per-model cost function built on it.
- The unpriced-model rule: a model absent from the table contributes no cost
  and is reported back to the caller, never guessed at another model's rate.
- Summing cost across several per-model usage buckets (a conversation can
  switch models mid-session).
- The per-model usage-capture step that buckets a transcript's consumed slice
  by model id, and its currently-Claude-only reach.
- The write-time decision of whether a commit summary receives a cost figure
  at all (the three-way state: no usage, usage but unpriced, usage and
  priced).
- The bifurcated cost architecture across the product's display surfaces: the
  VS Code sidebar branch token bar is this spec's primary consumer; every
  other cost-displaying surface uses the unrelated Sonnet-only estimator (see
  [243 — Token Usage Extraction and Cost Estimation]).

**Out of scope (boundaries)**

- The Sonnet-only, model-blind estimator used by the per-commit token meter
  and the pushed-memory article's "Task usage" line — unchanged by this spec
  (see [243 — Token Usage Extraction and Cost Estimation]). The PR-body markdown
  renders no token/cost figure at all, so it consults neither estimator.
- Extracting a per-turn token breakdown from a transcript line, and the
  cache-read exclusion rule — shared machinery, defined in [243 — Token Usage
  Extraction and Cost Estimation].
- The commit-pipeline attribution loop that merges per-model usage across
  sessions and applies the exclusion / overlay drop rules (see [245 —
  Commit-Pipeline Conversation Token Attribution]).
- The per-model usage record's field shape and the tree-aggregation helpers
  that walk it (see [04 — Summary Tree Structure]).
- The review-panel's whole-conversation token meter, which has no per-model or
  cost dimension at all (see [244 — Conversation Token Totals for the Review
  Panel]).

## Data Contracts

### Per-model price entry

Keyed by the exact transcript model identifier (`message.model` for Claude,
`turn_context.payload.model` for Codex). Each entry carries:

- `provider` — which billing family the model belongs to (an Anthropic /
  OpenAI / "unknown" enumeration; see the reachability note below).
- an input rate (USD per 1,000,000 uncached input tokens).
- an output rate (USD per 1,000,000 output tokens; reasoning tokens are
  expected to be folded into this segment upstream).
- a cached rate (USD per 1,000,000 tokens billed at the model's cached
  segment) — set as an independent literal per model rather than derived from
  the input rate, because "cached" means opposite things by provider: an
  Anthropic cache *write* is priced ABOVE the input rate (roughly 1.25×); an
  OpenAI/Codex cache *read* is priced BELOW the input rate (roughly 0.1×).
  Keeping the rate a literal per row keeps the formula uniform across both
  directions.

The table currently carries rows for the Claude model family (Fable, Opus,
Sonnet, Haiku variants) and a small set of OpenAI/Codex GPT-5-family models.
The Anthropic rows are the verified, shippable figures; the OpenAI/Codex rows
are marked provisional pending re-verification against OpenAI's own pricing
page, but see Unreachable Paths below for why they cannot be exercised today
regardless of accuracy.

### Table verification stamp

A single date value stamped on the table as a whole, recording when it was
last checked against published pricing. This same value is copied onto any
commit summary that receives a cost figure, so a reader can judge how stale
that figure is without cross-referencing the table's own history.

### Per-model usage bucket (cost-formula input)

A model identifier paired with three already-normalised, disjoint token
segments — input, output, cached — the same shape the cost formula consumes
regardless of which provider produced it. A single conversation may contribute
several buckets (one per distinct model id) if the session switched models
mid-stream.

### Cost estimate result

Given a set of per-model usage buckets, the estimate carries:

- a total USD figure, summed only across models present in the price table.
- a set of model identifiers present in the usage that have no table entry —
  their tokens are excluded from the total. A non-empty set is the caller's
  signal that the total is a lower bound, not an exact figure.

## Behavior

### The uniform cost formula

For one model's usage bucket, cost is `input × inputRate + cached ×
cachedRate + output × outputRate`, each rate expressed per token (the table's
per-million rates divided by 1,000,000). This is the single formula for every
priced model regardless of provider; providers differ only in which literal
rates they plug in, and in how upstream capture normalises usage into the
three segments before it reaches this formula (out of scope here — see [243]
and [245]).

### Unknown-model handling — never guessed

If a model id has no table entry, its per-model cost is undefined (not
zero, not another model's rate). At the multi-bucket level, an unpriced
model's tokens are excluded entirely from the running total and its id is
added to a returned unpriced set; the caller is expected to surface that set
so a reader knows the total is a floor, not a complete figure. Same-model
buckets (e.g. from two sessions that both used the same model) are summed
before or during pricing so a repeated model is not double-reported in the
unpriced set.

### Per-model usage capture (write-time)

During the same read that produces a transcript's scalar and per-segment
usage totals, a per-model capture step buckets that usage by the model id
attributed to each contributing line, over exactly the slice consumed (the
same cutoff-bounded slice the scalar figures are computed from — see [245]).
A capture step is optional per producer: a producer whose reader exposes no
model-aware capture simply contributes no per-model buckets, and downstream
pricing is skipped for its usage entirely (see Unreachable Paths).

### Write-time three-way cost state

When a commit summary is built, the per-model usage buckets surviving
attribution (see [245]) are priced via the formula above, and the outcome is
one of three states:

1. **No usage** — the slice attributed to this commit carried no token usage
   at all. No usage fields, no per-model usage, no cost are stored.
2. **Usage present but unpriced** — real per-model usage exists, but every
   model in it is absent from the price table (or the capture step produced
   no buckets at all for a non-capturing producer). The per-model usage is
   still stored (so a future price-table update can re-price it retroactively
   without re-reading transcripts), but no cost figure is stamped — an absent
   cost is read downstream as "unknown", never as "$0.00".
3. **Usage priced** — at least one bucket priced to a strictly-positive total.
   Both the per-model usage and the cost figure (plus the table's
   verification stamp) are stored together.

The cost figure is attached only when the priced total is strictly greater
than zero — the same forward-only, never-store-a-literal-zero discipline
applied to the scalar and per-segment token fields (see [04], [245]).

### The bifurcated cost architecture

Two independent cost paths coexist in the product today:

- **This spec's path** (per-model, provider-aware): used exclusively by the
  VS Code sidebar's branch-level token bar. The bar reads the write-time
  stored cost (summed across the branch's whole commit-summary tree) as its
  primary figure. When that stored figure is absent or zero for the branch —
  legacy data written before this field existed, or a branch whose only usage
  is on unpriced models — the bar falls back to a client-side estimate
  computed from the same Sonnet-class per-token constants the Sonnet-only
  estimator uses (see [243]), read directly by the sidebar's client script
  rather than through this spec's table.
- **Every other cost-displaying surface** (the per-commit token meter and the
  pushed-memory article's "Task usage" line) continues to use the Sonnet-only
  estimator described in [243], unchanged by this spec. They never consult the
  per-model table, never read `conversationModels`, and never see an
  unpriced-model distinction — they always produce a number, priced uniformly
  as if every model were Sonnet-class. The PR-body markdown displays no
  token/cost figure at all, so it consults neither estimator.

This means the same commit's cost can legitimately read differently on the
branch token bar than on its own per-commit meter: the former is
model-aware (or, absent that, Sonnet-rate-only as a fallback); the latter is
always Sonnet-rate-only, with no fallback distinction needed because it never
had a model-aware figure to prefer in the first place.

## Unreachable Paths

- **The OpenAI/Codex price rows cannot be looked up today.** Per-model usage
  capture — the step that buckets a transcript's tokens by model id — is
  currently implemented only for the Claude transcript parser. The Codex
  parser (and every other producer) exposes no such capture, so no live path
  ever constructs a per-model usage bucket carrying an OpenAI/Codex-family
  provider tag. The GPT-5-family rows in the price table exist for
  forward-compatibility once Codex per-model capture ships, but are dead code
  today — they can only be reached by a test that constructs a bucket by
  hand.
- **The "unknown" provider tag on the per-model usage record is declared but
  never produced.** Real capture always stamps a concrete provider (currently
  always "anthropic", since only the Claude path captures per-model usage at
  all); no live path constructs a bucket tagged "unknown". It appears only in
  a test fixture.
- **The price lookup never reads the provider field.** Despite the per-model
  usage record carrying a `provider` tag end-to-end through the pipeline, the
  cost formula and the table lookup key purely on the model identifier
  string; `provider` is carried for documentation / future-branching value
  only and has no effect on which price is applied or whether a lookup
  succeeds.

## Notable Behavior

- **Unpriced is a first-class outcome, not an error.** A model absent from the
  table degrades the estimate to a lower bound rather than failing or
  guessing; the per-model usage survives storage even when uncosted so a
  later table update can re-price it without re-reading transcripts.
  (Intentional.)
- **Cached-rate direction flips by provider.** Anthropic's cached segment is
  priced above the input rate (a cache write); OpenAI/Codex's is priced below
  it (a cache read) — the two providers' upstream capture must normalise
  their raw counters into the same three-segment shape before either reaches
  this uniform formula, but the per-model table entry itself is what encodes
  the directional difference, since the same formula runs for both.
  (Surprising if compared to [243]'s single Sonnet-rate table, which has no
  such distinction because it never varies by model.)
- **Cost is a lower bound in three independent ways**: models missing from
  the table are excluded (never guessed); the write-time guard only ever
  attaches a strictly-positive figure (a zero is never stored, so partial
  unpriced usage never masquerades as "no cost"); and legacy/degraded data
  simply has no per-model usage to price at all. (Intentional.)
- **The bifurcated architecture is a live, unresolved product state, not a
  transitional one documented as fully migrated.** Only one surface (the
  sidebar branch bar) has adopted the model-aware path; every other
  cost-displaying surface remains on the older Sonnet-only estimator with no
  migration in flight. (Notable.)

## Shared Behavior

- The per-model usage bucket's segment shape (input / output / cached) is the
  same normalised shape the cache-read-exclusion rule and per-turn extraction
  produce in [243 — Token Usage Extraction and Cost Estimation]; this spec
  only adds the model-id key and the price lookup on top of it.
- The commit-pipeline attribution loop that merges buckets across sessions,
  drops excluded/overlay-pruned sessions' buckets, and decides whether a
  commit's usage survives into the stored total is defined in [245 —
  Commit-Pipeline Conversation Token Attribution]; this spec is invoked from
  within that same write path to turn the surviving buckets into a cost
  figure.
- The per-model usage record's field shape on the summary node, and the two
  tree-aggregation helpers that merge per-model usage across a tree and sum
  an already-priced cost across a tree, are defined in [04 — Summary Tree
  Structure].
