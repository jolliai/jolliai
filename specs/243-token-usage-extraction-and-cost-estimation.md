# 243 — Token Usage Extraction and Cost Estimation (Sonnet-Only Estimator)

## Topic Statement

Extract a per-response input / output / cached token breakdown from a Claude Code
transcript — de-duplicating the several records one model response is written
across — and estimate a dollar cost from it at a single hardcoded Sonnet-class
rate, plus the family of formatters that render token counts and costs on the
pushed-memory article and the token-usage meters. This spec now describes one
specific estimator among two that coexist in the product — see the Out-of-Scope
note on [257 — Multi-Provider Pricing and Cost Estimation] for the other.

**Product-wide scope correction:** every claim below about "no per-model
table" and "the model is never consulted for pricing" is still exactly true of
*this* estimator (the Sonnet-only one), but the set of surfaces *wholly* served by
it is now the article "Task usage" line — rendered on **three** surfaces, from
three separate copies of the same block: the shared core's article builder (which
feeds the pushed memory), the editor extension's own article builder (clipboard and
local-folder export), and the JVM/IDE surface's article builder. The PR-body
markdown renders no token or cost figure at all. Every token meter in the product —
the editor extension's branch-level bar and per-memory detail meter, and the
JVM/IDE surface's detail meter and memories-list figure — now **prefers** a
model-aware, write-time cost and falls back to Sonnet-rate constants only for what
that figure does not cover (see [257 — Multi-Provider Pricing and Cost
Estimation]). Read every "no per-model table" statement in this spec as scoped to
the Sonnet-only estimator itself, not as a product-wide guarantee, and not as a
claim about the meters.

**And one of those three articles does not share this spec's code.** The two
in-process builders reach the same estimator and the same formatters, so their
figures cannot drift; the JVM/IDE builder prices its line with an independent
re-implementation of the flat-rate estimator and its own re-implemented formatters.
So the constants below are a single source of truth for the surfaces that *call*
them, not for the product — see "Not a single source of truth off-process" under
Shared Behavior.

## Scope

**In scope**

- The per-response token-usage breakdown shape (input, output, cached) extracted from a raw transcript line, and the record-level function that is the single definition of it — including the line-level wrapper that delegates to it and the consumers required to come through it.
- The rule that the "cached" segment carries cache-creation tokens only, and why the cache-read counter is deliberately excluded.
- The per-response de-duplication rule: one model response is written across several records that each repeat the whole usage object, so a response is counted exactly once per read; the optional response-identity key that drives it, and the first-seen-wins and no-identity-always-counts consequences.
- The scope of the already-counted set (one read, never persisted) and the bounded cross-read double-count it accepts.
- The gating of usage accumulation by the line-level time cutoff, independent of whether a line produced a displayable conversation turn.
- The Claude-only nature of real token usage: no other producer's transcript carries a usage figure anywhere in the product.
- The single hardcoded per-token pricing table (Sonnet-class) and the deliberate absence of any per-model lookup or unknown-model fallback **in this estimator**.
- The cost-estimation function: segment-priced when a breakdown is available, floored to the input rate when it is not.
- The compact and exact token formatters and the compact and exact cost formatters, including their rounding boundaries.
- The pushed-memory-article "Task usage" line: tree-aggregated total + cost, the omit-when-zero rule, the optional per-segment split, and the NaN-avoidance in the aggregation.
- The fact that every token meter reaches for these same Sonnet rates as a *fallback* only: the branch bar's client-side estimate when the branch's write-time, model-aware cost is absent or zero, the editor extension's per-memory detail meter's per-node / per-model-bucket remainder, and the JVM/IDE meters' tree-wide all-or-nothing fallback (see [257 — Multi-Provider Pricing and Cost Estimation] for the preference rules; this spec owns only the constants and the formula they feed).
- The two structural caveats on that fallback: the branch bar can suppress its cost figure entirely rather than falling back, and the JVM/IDE surface reaches a re-implementation of these constants rather than these constants.

**Out of scope (boundaries)**

- **The model-aware, per-model-table pricing path** — a second, independent cost estimator that prices a commit's actual conversation model(s) at their own rates, feeds the VS Code sidebar's branch token bar as its primary source, and is stamped on the commit summary at write time (see [257 — Multi-Provider Pricing and Cost Estimation]). This spec's estimator and that one are not the same code and must not be conflated.
- Summing real usage across a caller-supplied set of transcripts for the live review-panel meter (see [244 — Conversation Token Totals for the Review Panel]).
- Attributing and storing per-conversation usage during commit-summary generation, including exclusion and overlay-delete zeroing (see [245 — Commit-Pipeline Conversation Token Attribution]).
- Correcting an already-written memory's figures when a conversation is detached from it (see [306 — Conversation Detach Usage Correction]).
- The tree-aggregation helpers themselves and the token fields on the summary record (see [04 — Summary Tree Structure]).
- How a Claude transcript is read, cleaned, cursored, and time-cut (see [16 — Claude Code Transcript Reading]).
- The product's own summarization LLM-call cache accounting, which is a different figure (see [08 — Anthropic Message API Call]).

## Data Contracts

### Per-response token breakdown

A record of three non-negative integers:

- `input` — uncached input tokens for the turn.
- `output` — output tokens for the turn.
- `cached` — cache-**creation** tokens for the turn (the portion newly written to the prompt cache on this turn).

The scalar total of a breakdown is `input + output + cached`. This is the same
scalar historically stored as a single "conversation tokens" number, so a
breakdown and its scalar total are always mutually consistent.

A breakdown produced from one transcript record additionally carries an
**optional de-duplication key** — the identity of the model response the record
belongs to. It is present only when the record names that response; a breakdown
with no key is unconditionally counted by the consumer (see "Per-response
de-duplication"). The key is never stored anywhere and never leaves the read.

### Source usage counters (external Claude transcript format)

Each Claude transcript line may carry a usage object whose counters this layer
maps as follows:

- uncached-input count → `input`.
- output count → `output`.
- cache-creation count → `cached`.
- **cache-read count → deliberately dropped (never mapped, never summed).**

Alongside the counters, the record's message envelope may carry the identifying
string of the API response the counters describe. That string becomes the
de-duplication key. Two placement rules matter and are load-bearing:

- The usage object itself is read from the message envelope, falling back to a
  top-level usage object on the record when the envelope carries none.
- The response identity is read from the message envelope **only** — there is no
  top-level fallback. A record whose usage came from the top-level fallback
  location therefore has no identity and is always counted.

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

Extraction is split into two layers, and the inner one is the contract:

- A **record-level** function takes an already-parsed transcript record and
  returns the identity plus the three mapped segments — or nothing when the
  record carries no usage object. This is the single definition of what a Claude
  turn cost and of what identifies it.
- A **line-level** wrapper parses one raw line and delegates to it, returning
  nothing when the parse throws.

The split exists because both rules the record-level function encodes are easy to
get subtly wrong in a second implementation, and both fail **silently**: excluding
the cumulative cache-read counter (summing it re-counts the cached prefix on every
turn), and keying de-duplication on the response identity (one response spans
several lines, each repeating the whole usage object). Every per-segment consumer
must come through this one function or its numbers will drift from the others' for
the same transcript. Three do today: the commit-level reader, the per-model split,
and per-skill attribution — the last of which has already parsed the line for its
own skills-specific field and calls the record-level overload precisely so it does
not parse twice (see [321 — Skill Token Attribution]).

A line that fails to parse, or that has no usage object, yields a breakdown whose
three segments are all zero and which carries **no** de-duplication key, rather
than an error.

Usage is extracted **per raw line**, not per displayable turn. A line that
carries a real usage object but produces no conversation turn (for example an
assistant turn whose only content was a tool call, so it has no display text)
still contributes its tokens. Accumulation is gated only by the read's
line-level time cutoff (see [16 — Claude Code Transcript Reading]): a line past
the cutoff halts the read and contributes nothing; every line at or before the
cutoff is offered for accumulation, turn-bearing or not. The running per-segment
sums over the consumed slice become that read's breakdown, and their scalar sum
becomes that read's total.

### Per-response de-duplication (load-bearing reality — document verbatim)

The producer writes **one record per content block** of a single model response —
one for a reasoning block, one for a text block, and one per parallel tool call —
and every one of those records repeats that response's **whole** usage object
verbatim, not a per-block share of it. Accumulating per record therefore billed
one API call once per block; measured against real transcripts the inflation runs
roughly 2×–10×, the high end being agentic turns that fire six or seven tool calls
out of one response.

The consumer therefore keeps a set of response identities it has already counted:

- A record whose breakdown carries a de-duplication key already in the set
  contributes **nothing** — no segment, no scalar.
- A record whose key is new is counted in full and its key is added to the set.
- A record with **no** key is always counted (the pre-existing behavior, correct
  for a producer that reports usage once per line).

Two consequences follow directly from that shape and are real:

- **First-seen wins, unconditionally.** The first record bearing a given identity
  fixes what the whole response contributes. If that first record's counters are
  missing or non-numeric they map to zero, the identity is still registered, and
  every later record of the same response — including ones carrying real
  figures — is skipped. The response scores zero.
- **The set lives for exactly one read and is never persisted.** Nothing in the
  resumption bookmark records a response identity (see [24 — Transcript Cursor
  Resumption]). So when a read's time cutoff falls between two records of one
  response, that response is counted by the read that owns the earlier records
  *and again* by the read that picks up the rest. The over-count is bounded at
  one response per read boundary, which is accepted rather than closed: closing
  it would mean persisting the last-counted identity in the bookmark, and that
  schema change is not worth the magnitude.

The per-model split (see [257 — Multi-Provider Pricing and Cost Estimation]) is
computed over the same consumed slice and de-duplicates on the **same** identity.
That is deliberate: were the two to dedupe differently, the per-model buckets
would drift from the segment breakdown and the cost would be priced off a larger
token count than the meter displays.

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

**The branch-level token bar does not reach the no-breakdown path at all.** It
consumes these same per-token rates but applies them inline to the three segments
only, never to the scalar total, so it has no input-rate floor. Two consequences
follow: a branch whose memories carry only a scalar total has nothing the bar can
price, and rather than showing a contradictory $0 beside a real token total the bar
**suppresses the cost figure entirely** whenever no memory on the branch reported a
per-segment breakdown. So "falls back to this estimator" is true of the bar only
when segment data exists somewhere on the branch; otherwise there is no fallback,
there is no figure. (The preference rules themselves are [257]'s.)

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

### Article "Task usage" line

On the pushed-memory / clipboard / folder-export article, a "Task usage"
property line is rendered from the whole consolidation tree (a squash or amend
memory carries its tokens on its folded children, so the figure is the
tree-aggregated total, not the root's own). The steps below are implemented
**three times over** — once per article builder (shared core, editor extension,
JVM/IDE surface) — rather than once in a shared helper, so the sequence is a
duplicated contract rather than a single code path:

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
  breakdown passing through this path is priced at the one hardcoded
  Sonnet-class table regardless of the model that produced it; there is no
  per-model table and no unknown-model fallback here. The resulting cost is
  explicitly a ballpark. This remains true of every article's "Task usage" line,
  which consults nothing else — but it is **not** true of any token meter any more:
  all four prefer a model-aware, per-model-priced figure computed at write time and
  reach for a flat rate only for the remainder that figure does not cover (see
  [257 — Multi-Provider Pricing and Cost Estimation]). (Bug-as-feature, now scoped
  to the article line rather than product-wide.)
- **"Single source of truth" holds within one process, not across the product.** The
  JVM/IDE surface re-implements this estimator and these formatters rather than
  calling them, so its article line and its meters' fallback figures can drift from
  every other surface's after a rate or rounding change here. Nothing in this
  estimator's code flags that pairing — unlike the model-aware price table, whose
  duplication is documented as a lockstep contract. (Surprising; the drift risk is
  real and unguarded.)
- **Extraction is record-level, with the line-level form as a thin wrapper — and that shape is the drift guard.** Both of this spec's silent-failure rules (drop the cumulative cache-read counter; dedupe on the response identity) live in exactly one function, and every per-segment consumer is required to reach it rather than re-read the usage object itself. Per-skill attribution is the reason the record-level form is exported at all: it has already parsed the line for a top-level field of its own, and re-parsing to get the counters would have been the moment a second, drifting implementation appeared. So per-skill totals cannot disagree with the commit total for the same transcript. (Notable; the guarantee is structural, not tested per consumer.)
- **One response, several records, one whole usage object on each.** Summing per
  record multiplied real usage by the response's content-block count (measured
  2×–10×). De-duplicating on the response identity is what makes the figure
  mean what it says. (Surprising; the inflation shipped before it was fixed.)
- **First-seen wins even when the first record is the useless one.** A first
  record with missing or non-numeric counters registers the identity at zero and
  suppresses every later record of the same response, scoring the whole response
  zero. (Surprising; intentional — no re-scoring pass exists.)
- **A record with no response identity always counts.** Absence of an identity is
  treated as "this producer reports usage once", not as "unknown, skip" — so a
  usage object found only at the record's top level (where no identity is ever
  read) is never de-duplicated. (Notable.)
- **The already-counted set is per read, so a response straddling a read boundary
  is counted twice.** Bounded at one response per boundary and knowingly
  accepted, because closing it would require the resumption bookmark to carry a
  response identity. (Surprising; intentional.)
- **The no-breakdown cost is a deliberate underestimate** when output is
  present, because the floor prices everything at the input rate. (Intentional.)
- **Usage is extracted per raw line, not per turn — but counted per response.** A
  tool-only assistant turn contributes tokens even though it produces no
  displayable conversation turn; several such records belonging to one response
  contribute once between them. (Notable.)
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

- **Not a single source of truth off-process.** The pricing constants and the
  formatters *are* shared by every in-process consumer — the two in-process article
  builders and the editor extension's two meters all call them directly rather than
  duplicating them, including on the meters' fallback paths, so none of those
  surfaces can disagree on the same underlying counts even though the meters are
  otherwise [257]-driven. The JVM/IDE surface is outside that guarantee: it
  re-implements the estimator and the formatters in its own language for its article
  line and both its meters, so a change to the numbers or the rounding here silently
  leaves that surface behind until it is ported too.
- The per-response breakdown shape is the same shape summed by the review-panel
  meter (see [244 — Conversation Token Totals for the Review Panel]), attributed
  per conversation during commit-summary generation (see
  [245 — Commit-Pipeline Conversation Token Attribution]), and persisted per
  conversation so a later detach can subtract it (see [306 — Conversation Detach
  Usage Correction]).
- The per-skill attribution that consumes the record-level extractor — how a turn
  is assigned to a skill, and the per-session split it produces — is defined in
  [321 — Skill Token Attribution]. It reuses this spec's counters and this spec's
  de-duplication identity rather than deriving its own, which is what keeps a
  commit's per-skill figures reconcilable with its commit-level total.
- The de-duplication described here happens inside a single transcript read, so
  its scope, and the bookmark that cannot carry it across reads, belong to
  [16 — Claude Code Transcript Reading] and [24 — Transcript Cursor Resumption].
- The token fields persisted on a summary and the tree-aggregation helpers are
  defined in [04 — Summary Tree Structure].
- The model-aware pricing path that now coexists with this estimator is defined
  in [257 — Multi-Provider Pricing and Cost Estimation]; it is a parallel,
  independent estimator, not a replacement for the one described here.
