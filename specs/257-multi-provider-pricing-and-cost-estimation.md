# 257 — Multi-Provider Pricing and Cost Estimation

## Topic Statement

A hand-maintained, per-model USD list-price table keyed by the exact model
identifier that appears in a transcript, plus the uniform cost formula that
prices a model's normalised token usage against it — the write-time cost
estimate stamped on a commit summary and preferred by every token meter in the
product (the editor extension's branch bar and per-memory detail meter, the local
dashboard's memory detail, and the JVM/IDE surface's own detail meter and
memories-list figure), each with its own preference granularity and its own
fallback to the flat-rate estimator for what the stamped figure does not cover.

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
- The bifurcated cost architecture across the product's display surfaces: every
  token meter prefers this spec's write-time figure, each with its own preference
  granularity, its own fallback to the unrelated Sonnet-only estimator (see
  [243 — Token Usage Extraction and Cost Estimation]), and its own set of states
  when neither source yields a figure.
- The one shared routine that serves the per-node, per-model-bucket granularity for
  both the editor extension's detail meter and the local dashboard's memory detail,
  and the half of its result the dashboard discards.
- The JVM/IDE surface's divergences: a tree-wide, all-or-nothing stored-versus-flat
  preference, a single static tooltip, an article line priced by its own port of the
  flat-rate estimator, and a branch banner that sums already-resolved row costs
  instead of resolving its own.
- The three tooltip wordings the editor extension's detail meter selects between,
  which name the sources that actually fed the figure it is showing.
- The rule for a model whose published pricing leaves the cached column blank:
  its cached segment is priced at the FULL input rate rather than the row being
  omitted, and why omission is the worse error.
- The convention that a model under an introductory rate is carried at its
  STANDARD rate, making the estimate an upper bound for that model.

**Out of scope (boundaries)**

- The Sonnet-only, model-blind estimator that still wholly drives every article's
  "Task usage" line, and that every meter falls back to for what this spec's figure
  does not cover — unchanged by this spec (see [243 — Token Usage Extraction and
  Cost Estimation]), including the JVM/IDE surface's own re-implementation of it.
  The PR-body markdown renders no token/cost figure at all, so it consults neither
  estimator.
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
  directions. A third case exists — see "Blank cached column" below.

The table has grown from a dozen rows to roughly three dozen, split between the
Claude model family (Fable, Mythos, Opus, Sonnet and Haiku variants) and the
OpenAI/Codex GPT-5 family. Two things about that growth are worth recording:

- **The second provider's rows are no longer provisional — and the previous ones
  were wrong.** The original three OpenAI/Codex rows were placeholders that
  mirrored an adjacent generation's list tier, understating one model's input rate
  by 4× and its output rate by 3×, which silently under-reported the cost of every
  conversation on those models. Every row is now verified against the provider's
  published pricing page. The lesson is recorded in the table itself as a
  standing rule: verify a new row against the published page rather than copying
  a neighbouring row's numbers.
- **Adjacent rows with identical numbers are sometimes correct.** Where two
  models genuinely publish the same rates, the table says so explicitly, precisely
  because identical adjacent numbers are what an unverified copy looks like.

### Blank cached column → the full input rate

Some models publish an input and an output rate but leave the cached-input column
blank, with no explanation. Such a row is **still written**, with its cached rate
set equal to its full input rate.

Omitting the row is the worse of the two errors, and the reasoning is load-bearing:
a model absent from the table is unpriced, an unpriced model contributes nothing,
and the display layer then prices that conversation's **entire** usage at the flat
Sonnet-class fallback — roughly an order of magnitude below a premium model's real
rates. Pricing the two published segments correctly and the undocumented one at
the full input rate confines the error to the cached segment alone.

The input rate is also the only non-invented value available for that segment: a
blank column means either the model does not support prompt caching (in which case
the cached segment is always zero and the rate never applies) or it caches at no
discount (in which case the input rate is exactly right). Both readings are
consistent with billing at the input rate; neither supports a discount, which is
what a made-up number would imply.

### Introductory rates are never used

Where a model is under a time-limited introductory rate, the table carries its
**standard** rate. Estimates therefore assume standard list pricing — no
promotional, batch, or volume discounts — and are an upper bound for such a model
until its introductory period ends. Surface that caveat next to any figure.

### Table verification stamp

A single date value stamped on the table as a whole, recording when it was
last checked against published pricing. This same value is copied onto any
commit summary that receives a cost figure, so a reader can judge how stale
that figure is without cross-referencing the table's own history.

The stamp is table-wide, not per row, and the two can legitimately disagree by a
little: individual rows carry their own verification notes, and the second
provider's block currently records a verification date one day earlier than the
table-wide stamp. A reader judging staleness from the stamp is therefore reading
the *most recent* verification of any row, not a guarantee about every row.

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

Two cost paths coexist in the product today, and every token meter now prefers
this spec's path over the Sonnet-only one. They differ in how finely they resolve
that preference, and in what they render when neither path yields a figure:

- **The branch-level token bar** (VS Code sidebar) reads the write-time stored
  cost, summed across the branch's whole commit-summary tree, as its primary
  figure. When that summed figure is absent or zero for the branch — legacy data
  written before the field existed, or a branch whose only usage is on unpriced
  models — the bar falls back to a client-side estimate computed from the
  Sonnet-class per-token constants (see [243]), read directly by the sidebar's
  client script rather than through this spec's table. The preference is
  all-or-nothing for the whole branch.

  But the fallback is not universal, and one state produces **no cost figure at
  all**. The bar first asks whether *any* memory on the branch reported a
  per-segment breakdown. If none did, both the dollar figure and the per-segment
  legend are suppressed and the bar shows the token total alone — because a $0
  estimate and an "0 input · 0 output" legend beside a non-zero total would
  contradict it, and the help affordance already explains that only some memories
  report. The fallback formula reinforces this: it prices the three **segments**
  only and never reads the scalar total, so a branch whose memories carry only a
  scalar total has nothing for it to price and could not produce a figure even if
  the suppression were lifted. So the branch bar has three cost states, not two:
  stored, segment-derived fallback, and **suppressed**.
- **The per-node, per-bucket rule now serves TWO surfaces from one routine.** The
  editor extension's per-memory detail meter and the local dashboard's memory
  detail both call the same shared walk, which lives in the shared core rather
  than on either surface — precisely because a memory's cost must read the same on
  both, and it did not: the dashboard read the tree's ROOT node's own stored cost
  while the editor summed the whole tree, so a consolidated memory was priced at a
  fraction of the work folded beneath it on one surface and in full on the other,
  with identical token headlines on both. The dashboard's memory detail now runs
  the whole-tree walk; the editor's output is unchanged, since it was already the
  caller the rule was written for. (The spec's earlier enumeration of which
  surface prices how did not mention the dashboard at all.) The dashboard keeps
  the ROOT's price-table verification stamp for its "estimated at these prices"
  note, which is what that note has always meant, even though the nodes summed
  beneath it may carry different stamps. It also uses only half of what the shared
  routine returns: it takes the dollar figure and **discards the source mode**, so
  it has no counterpart to the three source-naming tooltip wordings below, and it
  attaches no cost field at all when the walk totals zero — an absent figure,
  never a rendered `$0.00`.

  The routine resolves the preference **per node of the consolidation tree, and
  within a node per model bucket**. It walks every node and, for each:
  - a node with a strictly-positive stored cost contributes that cost — plus a
    flat-rate estimate for exactly those of its per-model buckets whose model has
    no table entry, since a stored cost is a lower bound and not proof of full
    coverage;
  - a node with no stored cost but real tokens is priced wholly at the flat rate;
  - a node with neither contributes nothing and does not influence the tooltip.

  Resolving per node is load-bearing: the token headline beside the figure
  aggregates *every* node, so a tree-wide "any stored cost wins" test would price
  only the root of a mixed consolidation and show that partial total next to the
  full tree's tokens. Summing per node keeps the two figures over the same set,
  and because the flat-rate formula is linear per segment, summing per-node
  fallbacks equals estimating from their aggregate — so an all-fallback tree
  reads exactly as it did before the preference existed.
- **The pushed-memory article's "Task usage" line** still uses the Sonnet-only
  estimator described in [243], unchanged by this spec. It never consults the
  per-model table, never reads the per-model usage field, and never sees an
  unpriced-model distinction — it always produces a number, priced uniformly as
  if every model were Sonnet-class. The clipboard / local-folder markdown emits
  the same line, but **not from the same builder**: two independent article
  builders (one in the shared core, one in the editor extension) each carry their
  own copy of the usage block, character-for-character equivalent today. They
  share only the estimator and the formatters, so the *figure* cannot drift while
  the surrounding line's wording, ordering, and omit-when-zero rule are duplicated
  and can. The PR-body markdown displays no token or cost figure at all, so it
  consults neither estimator.
- **The JVM/IDE surface has its own set of figures, and they are not this table's
  code.** That surface prices summaries itself rather than asking for a figure, so
  it carries an independent port of both this table and the Sonnet-only estimator
  (see the lockstep note under Shared Behavior). Four things are specific to it:
  - **Its article line is wholly flat-rate**, like the two above, but priced by its
    *own* re-implementation of the flat-rate estimator rather than by the shared
    constants — so this is the one usage figure in the product that can drift from
    [243]'s numbers without any shared code changing.
  - **Its per-memory detail meter resolves the stored-versus-flat preference
    tree-wide and all-or-nothing**, not per node and per model bucket: one summed
    stored cost across the whole tree, and if that sum is not positive, one
    flat-rate estimate of the tree's aggregated breakdown. It is therefore subject
    to exactly the mixed-consolidation under-report the per-node rule above exists
    to prevent, and it never flat-rates an unpriced bucket that sits beside a priced
    one.
  - **That meter carries one static tooltip**, not the three source-naming wordings
    below: a single wording stating that cost is priced per model when the model is
    known and estimated at Sonnet rates otherwise, without saying which actually
    happened for the figure on screen.
  - **Its memories-list rows and its branch-level banner use the same tree-wide,
    all-or-nothing preference** as its detail meter, resolved once per row when the
    list is built. The banner then merely *sums* the rows' already-resolved costs and
    has no fallback of its own — which is why it carries a cost-not-available label
    for the case where no row yielded a figure, and why that label cannot actually
    appear (see Unreachable Paths).

### The editor extension's detail meter: three tooltip wordings

Because that meter's figure can be fed by either source or both, it reports which
one it actually used rather than overclaiming. The wording is selected by how many
nodes contributed from each source — the source mode the shared per-node routine
returns alongside the figure. (The JVM/IDE detail meter has one static wording
instead, and the local dashboard's memory detail has none at all: it drops that
mode — see above.)

1. **Stored only** (at least one node priced from the table, none fell back) —
   described as priced per model at list rates, with the standard "no
   promotional/volume discounts, actual spend may differ" caveat.
2. **Mixed** (at least one node from each source) — described as priced per model
   where that model has a known price and at the flat Sonnet rate for the rest.
3. **Flat only** (no node carried a stored cost) — described as assuming Sonnet
   pricing, so actual cost varies by model.

A memory whose tree reports no tokens at all renders the meter's empty state:
no bar and **no dollar figure** — the absence is stated in words rather than
priced at zero.

This means the same commit's cost can legitimately read differently on several
surfaces at once: the editor extension's branch bar prefers a branch-wide stored
sum, falls back only from the segments, and suppresses the figure entirely when no
memory reports segments; its detail meter and the local dashboard's memory detail
share one routine that mixes per node and per model bucket, and therefore agree by
construction (differing only in that the dashboard shows no source wording); the
JVM/IDE meters prefer tree-wide and all-or-nothing; and every article line is always
flat-rate — from one of three separate copies of that estimator's usage block, one
of which is a re-implementation on the JVM.

## Unreachable Paths

- **The OpenAI/Codex price rows cannot be looked up today, and that has not
  changed as the block grew.** Per-model usage capture — the step that buckets a
  transcript's tokens by model id — is still implemented only for the Claude
  transcript parser. The Codex parser (and every other producer) exposes no such
  capture, so no live path ever constructs a per-model usage bucket carrying an
  OpenAI/Codex-family provider tag. Every GPT-5-family row therefore exists for
  forward-compatibility once Codex per-model capture ships and is dead code
  today — reachable only by a test that constructs a bucket by hand. **Do not
  delete them**: they were re-verified against the provider's published pricing
  precisely so that the day capture ships, no wrong figure is already in place —
  which is what happened with the three rows that preceded them.
  A corollary: the "blank cached column → full input rate" rule above states its
  motivation in terms of a real understatement on the display layer, but for
  those specific models that consequence is likewise forward-looking rather than
  observable today, for the same reason.
- **The "unknown" provider tag on the per-model usage record is declared but
  never produced.** Real capture always stamps a concrete provider (currently
  always "anthropic", since only the Claude path captures per-model usage at
  all); no live path constructs a bucket tagged "unknown". It appears only in
  a test fixture.
- **The JVM/IDE surface's "cost not available" label is dead in both places it
  appears.** Two of its meters carry a literal label for "tokens are present but no
  cost could be derived", and neither can reach it. On its per-memory detail meter,
  the flat-rate fallback is reached whenever the stored sum is not positive, and that
  fallback prices a bare scalar total at the input rate — so it always returns a
  strictly-positive figure whenever the meter renders at all (the meter's zero-token
  early exit having already handled the only other case). On its branch-level banner,
  the label is reachable only from a hand-constructed totals object: the live
  producer resolves each row's cost with the same always-positive fallback before the
  banner sums them, and it skips exactly those rows that reported no segments — the
  ones that would have contributed no cost. Both surfaces' tests pin this, asserting
  the label's absence on the detail meter and constructing the totals directly to
  exercise it on the banner. **Do not read the label as a fourth render state**;
  treat it as a defensive branch. It is worth keeping only as insurance against the
  upstream fallback being removed, and worth knowing about because it makes the two
  surfaces *look* like they have a state the editor extension lacks.
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
- **Estimates are an upper bound in one way, deliberately.** A model under an
  introductory rate is carried at its standard rate, so its estimate reads high
  until that period ends. Chosen for the same reason unpriced models are excluded
  rather than guessed: prefer a stated, uniform convention over a figure that
  changes meaning on a date nobody tracks. (Intentional; note it points the
  opposite way from the three lower-bound rules above.)
- **A blank cached column is priced at the full input rate, not omitted.**
  Omitting the row would push the entire conversation onto the flat Sonnet-class
  fallback — roughly an order of magnitude low for a premium model — so writing
  the row and billing the undocumented segment at the full input rate confines the
  error to that one segment. (Surprising; intentional. The alternative reading —
  "unknown, so unpriced" — is the one that produces the larger error.)
- **The bifurcated architecture is a live, unresolved product state, not a
  transitional one documented as fully migrated.** Every token meter has now adopted
  the model-aware path, at three different granularities, but every article line
  remains on the older Sonnet-only estimator with no migration in flight — and the
  meters keep that estimator as their fallback, so the older path is not merely
  legacy, it is load-bearing. (Notable.)
- **The per-node, per-bucket rule is shared code, and the surface that adopted it
  most recently is the one it fixed.** The local dashboard's memory detail used to
  read the tree's root node's own stored cost while the editor summed the whole tree,
  so a consolidated memory's cost differed by orders of magnitude between the two
  surfaces while both showed the same token headline. Moving to the shared walk
  changed the dashboard's number and left the editor's untouched. (Notable; the fix
  was to route a second caller through the existing rule, not to change the rule.)
- **Several meters, two preference granularities, and different "no figure"
  behaviours.** The editor extension's branch bar suppresses the cost outright when no
  memory on the branch reports segments; its detail meter states the absence in words
  when the tree reports no tokens; the JVM meters always reach a positive flat-rate
  figure once any tokens exist, so their cost-not-available labels never fire. A
  reader comparing two surfaces for the same memory should not assume a discrepancy is
  a bug. (Surprising; nobody designed this set, it accreted.)
- **The JVM surface is the one place the flat-rate figure itself can drift.** Every
  other surface reaches the shared estimator and constants directly, so their
  fallback numbers are identical by construction; the JVM surface re-implements both
  the estimator and the formatters, so its article line and its meters can quote a
  different number after a rate change that touches only the shared side.
  (Surprising; the price *table* is a documented lockstep pair, but the flat-rate
  estimator's duplication is not similarly flagged anywhere in the code.)
- **A stored cost does not mean a node is fully priced.** The write-time figure
  excludes unpriced buckets rather than guessing, so the detail meter treats
  "stored cost present" as a lower bound and flat-rates exactly the unpriced
  buckets on top of it. Reading a positive stored cost as full coverage
  under-reported every node that mixed a priced model with an unpriced one — the
  unpriced tokens sat in the headline total beside a figure that excluded them.
  (Surprising; intentional.)

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
- **The per-node, per-model-bucket walk is one routine with two callers**, and it
  lives in the shared core rather than on either surface for exactly that reason:
  the editor extension's per-memory detail meter and the local dashboard's memory
  detail must show the same figure for the same memory, and they did not while the
  dashboard priced the tree's root alone. It returns the dollar total and the source
  mode; the editor uses both, the dashboard uses only the total. Its membership test
  for "unpriced" is the same per-model lookup the write-time estimate uses — probed
  through that lookup's own null answer rather than by re-reading the table — so the
  two can never disagree about what unpriced means.
- **The price table and its formula exist twice, and must move together.** The
  JVM/IDE surface carries an independent port of the same table — the same rows
  (three dozen on each side today), the same rates, the same verification stamp, the
  same blank-cached-column rule, and the same unpriced-is-undefined formula — because
  that surface prices summaries itself rather than asking for a figure. A rate edited
  on one side and not the other makes the two surfaces quote different costs for the
  same memory. **Row count, rates, and the stamp are genuinely in lockstep and
  verified as such.** Beyond them, the two sides are not equivalent, and the
  divergences are behavioural rather than cosmetic: that surface also re-implements
  the flat-rate estimator and the token/cost formatters, resolves the
  stored-versus-flat preference tree-wide instead of per node and per model bucket,
  carries one static tooltip instead of three source-naming ones, and renders a
  cost-not-available state that has no counterpart elsewhere (all detailed under "The
  bifurcated cost architecture"). One difference *is* purely cosmetic and worth
  naming so it is not mistaken for a real one: the third segment's field is named
  after the Anthropic cache-*write* reading on that side while carrying whichever
  provider-appropriate value the row calls for.
- When a conversation is detached from an already-written memory, the affected
  node's cost is **re-derived** from its remaining per-model buckets using this
  spec's formula, and re-stamped with the table's current verification date; it is
  never scaled from the old figure. That correction is defined in
  [306 — Conversation Detach Usage Correction].
