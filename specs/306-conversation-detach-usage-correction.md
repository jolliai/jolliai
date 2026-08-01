# 306 — Conversation Detach Usage Correction

## Topic Statement

When a user detaches one conversation from an already-committed memory, correct
that memory's recorded token and cost figures by exactly the detached
conversation's own persisted share — resolving which node of the consolidation
tree owns the share, refusing to guess whenever ownership or the share itself is
unknown, and reporting every shortfall instead of silently leaving a wrong number
on screen.

## Scope

**In scope**

- The problem this exists to solve: a memory stores only the post-merge aggregate, so removing one conversation from it has no subtrahend unless that conversation's own share was persisted at write time.
- The composite conversation identity used to decide which stored conversation records are being removed.
- Per-node ownership resolution over the consolidation tree, and why the node's own transcript-id list is not itself the ownership record.
- The three unattributable outcomes (no claimant, several claimants, a removed conversation with no recorded share) and the partial-subtraction case that both corrects and reports.
- The subtraction itself: per-segment flooring, the scalar-only degrade, stripping the field group when nothing remains, and re-derivation (never scaling) of the cost.
- The second, parallel correction applied to each skill row's per-session usage split — its unconditional per-node application, its re-derivation of the row's total and confidence from what survives, and its forward-only guard.
- The condition under which the tree is walked at all, given that either correction can be the only one with work to do.
- The write ordering — stored conversation records first, then one summary write carrying both the id removal and the figure correction — and what each failure leaves behind.
- What the user is told when the summary write fails, why that outcome is permanent, and the notification's gate on there having been an attributable correction (so one of the two failure branches is silent).
- The in-place meter replacement the panel performs on success, and the deliberate omission of it when nothing was attributable.

**Out of scope (boundaries)**

- Writing the per-conversation share in the first place, including the one-carrier-per-conversation rule and the turn-less carrier record (see [245 — Commit-Pipeline Conversation Token Attribution]).
- The segment semantics, the cache-read exclusion, and the flat-rate estimator (see [243 — Token Usage Extraction and Cost Estimation]).
- The price table, the cost formula, and the verification stamp (see [257 — Multi-Provider Pricing and Cost Estimation]).
- The summary node's usage/cost field group and the tree-aggregation helpers that read it (see [04 — Summary Tree Structure]).
- The panel that hosts the detach control, its read-only gates, and the conversations list it renders (see [109 — VS Code Summary Webview Panel]).
- The meaning and lifecycle of a node's transcript-id list (see [185 — V5 UUID Identity and Migration]).
- Rewriting the stored conversation records themselves — the detach's file-level effect, which this correction only observes.

## Data Contracts

### Conversation identity (the match key)

A conversation is identified by the **pair** of its producer and its
conversation id, never by the id alone. A stored record that names no producer is
read as the default producer. Two consequences are real: a conversation carrying
the same raw id under a *different* producer is not detached, and the same pair
appearing in several commits' stored records is one conversation, matched in all
of them.

### Removed-share input

For each stored record set the detach touched, keyed by the id of the record the
conversations were removed from, the correction receives the removed
conversations' persisted shares: for each one, its three-segment breakdown and
its per-model split, both optional and — because write time gates them
independently — either one able to be present without the other. Only the
segment breakdown is load-bearing here: a removed conversation whose breakdown is
absent is the "cannot attribute" case defined in [245], regardless of whether a
per-model split accompanies it. The per-model split is read only to refine a
subtraction the breakdown has already authorised.

Each removed conversation additionally carries an optional **session key** — the
same `<source>:<sessionId>` composite the rest of the product uses to identify a
conversation across producers — built by the detach request itself from the
producer and conversation id it already holds. It is the key under which a skill's
per-session usage split was written at capture time, and it drives the per-skill
correction below.

The session key is **independent of the segment breakdown**: a skill split can be
corrected for a conversation whose commit-level share was never recorded, and a
commit-level share can be subtracted for a conversation that appears in no skill's
split. When it is absent, the skill figures are simply left as they are — the same
forward-only stance the aggregate path takes toward a memory with no stored
per-conversation usage.

This input is collected **before** the records are rewritten, because that is the
last moment the removed conversations are readable at all.

### Correction result

- The corrected memory — the same reference when nothing changed, and structurally
  sharing every untouched subtree so a caller can compare by reference.
- A changed flag, true when at least one node's figures were rewritten.
- A list of record ids whose removed conversations could **not** be fully
  attributed. This list and the changed flag are independent: a partial
  attribution sets both.

## Behavior

### Attribution is per node, not per tree

An amend or squash root and each of its folded children carry their own usage
figures, and the tree aggregation that display surfaces use walks all of them. A
conversation detached from a child must therefore be subtracted **from that
child**: subtracting at the root would corrupt a node that never carried those
tokens while leaving the node that did carry them untouched.

### Ownership resolution — the id list is not the ownership record

A node's transcript-id list means two different things depending on where it sits,
which is why ownership is computed rather than read off the field:

- On a **leaf**, the ids whose conversations that node's usage figures cover.
- On a **consolidated root**, the tree-wide authoritative index. Amend
  (inherited ∪ delta), rebase-pick (one-to-one migration) and squash (union over
  children) all re-list every descendant's ids at the root so that lookups find
  every file — while the root's own usage figures cover its **delta** only
  (amend, pick) or nothing at all (squash).

A node therefore **owns** an id only when it lists that id and **no descendant**
lists it. Resolution is a post-order walk, so a node can only become an owner once
its whole subtree has had the chance to claim the id, and the walk is restricted to
the ids actually being detached so an unrelated tree-wide index costs nothing.

Ownership is resolved over the whole tree **before** anything is subtracted, then
each owner's subtrahends are applied in a second walk.

That second walk runs when **either** correction has work to do — an owner was
found, or the detach supplied any session key at all. A memory can carry skill
figures with no aggregate figure to fix, and gating the walk on ownership alone
would leave the skill numbers stale while reporting that nothing changed.

### The three unattributable outcomes

All three are reported. The first two also correct nothing for the id in
question; the third corrects whatever it can — see "Partial attribution" below,
where a record holding several removed conversations of which only some carry a
share is reported **and** has the shares that do exist subtracted.

1. **No claimant.** The memory and the stored records disagree about what belongs
   to this memory.
2. **Two or more claimants.** Sibling nodes can both list an id without either
   being the other's descendant, so there is no deepest one. Subtracting at both
   would double-subtract; picking one arbitrarily would corrupt the other.
3. **A removed conversation with no recorded segment breakdown.** Written before
   the share was persisted, produced by a source that reports no usage, or — the
   non-obvious one — a record that persisted a **per-model split but no segment
   breakdown**. Write time gates the two halves independently (see [245]), so that
   shape is reachable; this correction keys the whole decision on the segment
   breakdown and stops as soon as it is absent, so the per-model split sitting right
   beside it is never consulted, not even to derive a segment sum from. Such a
   conversation is reported unattributed and nothing is subtracted for it, even
   though the information needed to subtract exactly is on disk.

Guessing a subtrahend — splitting the aggregate evenly, zeroing the node, or
subtracting from every node that lists the id — would replace a known-stale number
with an invented one, so none of those are done.

### Partial attribution corrects *and* reports

Outcome 3 is evaluated per removed conversation, not per record: the record is
reported as unattributed as soon as **one** of its removed conversations lacks a
share, even when the others have one. The shares that do exist are still
subtracted. A partial subtraction leaves the figure wrong in the other direction
(too low by nothing, too high by the missing share), so correcting silently would
reproduce exactly the "stale figure with no trace" this behavior exists to avoid.

### Subtracting one node's share

For an owning node, the removed conversations' shares are summed (per segment, and
per model where a split exists), then:

- A subtrahend summing to zero, or an owner node that records **no token figure at
  all**, is a no-op. Note the asymmetry: that second case is **not** reported as
  unattributed — an owner with nothing to correct silently absorbs its subtrahend.
- Every segment is floored at zero. A subtrahend can legitimately exceed the stored
  value: the node may have been written before per-response de-duplication existed
  (see [243]), so its aggregate is inflated while the detached conversation's
  recorded share is not. The floor prevents a negative figure; it does not make the
  remainder exact, which is why over-subtraction collapses the node to "reports no
  usage" rather than to a fabricated remainder.
- If the node records a scalar total but **no** per-segment split (older data), the
  scalar is reduced directly and the split stays absent. Treating the missing split
  as zeros would compute a remaining total of zero and wipe usage the memory
  legitimately still has.
- If nothing remains, the **whole** usage/cost field group is stripped rather than
  written as zeros — so the display falls back to "not reported" instead of showing
  a measured nothing (see [04 — Summary Tree Structure]).

### The per-skill correction, which is NOT ownership-resolved

A memory's skill rows carry their own usage, stored as an explicit per-session
split rather than as an opaque total. That split is what makes a second, parallel
correction possible — and it is applied by a different rule from the one above:

- **It runs on every node, unconditionally**, rather than only on the node that
  owns the detached id. That difference is not merely permitted, it is required:
  an amend hoists a child's skill rows onto the root, so one conversation's
  contribution is genuinely recorded in **both** places and both records are stale
  until each is corrected. Ownership resolution would fix exactly one of them.
  Deleting a key cannot double-subtract, which is what makes the unconditional walk
  safe where the aggregate correction's would not be.
- **It subtracts by deletion, then re-derives.** For each row, the detached session
  keys are dropped from the split, and the row's `usage` total is recomputed **from
  what survives** rather than subtracted from. Confidence is re-derived too, never
  carried over: dropping the only estimated session leaves a total that really is
  fully attributed, and keeping the old label would understate what is now known.
- **A row whose split empties out keeps its identity and loses only its figure.**
  Both `usage` and the split are stripped; the row and its invocation count stay.
  The skill did run — the count says so — and what a detach removes is the evidence
  of what it cost. An absent usage states that; a zero would claim the skill was
  free, and deleting the row would claim it never ran.
- **A row with no per-session split is returned untouched.** Forward-only, for the
  same reason the aggregate path refuses to invent a subtrahend.

### Cost is re-derived, never scaled

The node's remaining per-model buckets are computed by subtracting the removed
share model-by-model (segments floored, buckets that drain to nothing dropped),
and the cost is then computed **from those remaining buckets** using the shared
formula, with the price table's current verification stamp (see
[257 — Multi-Provider Pricing and Cost Estimation]). Scaling the old figure
proportionally would be wrong: the detached conversation may have run a different —
or an unpriced — model than the ones left behind.

Two consequences follow:

- The re-stamped verification date can **post-date** the memory itself. It dates
  the pricing, not the memory.
- Because the cost is rebuilt solely from the node's recorded per-model buckets, a
  node that recorded a cost but no per-model buckets loses its cost figure on
  correction, and a node whose remaining buckets are all unpriced loses it too
  (a cost is attached only when the re-derived total is strictly positive — the
  same never-store-a-zero rule as at write time). Both are consistent with
  "absent cost means no priced usage", and the first shape is off-contract data
  in any case: write time never stores a cost without buckets.

### Write ordering: records first, then one summary write

1. Collect the removed shares and compute the correction, holding the result in a
   **local**. The in-memory memory must not be reassigned yet.
2. Write the stored conversation records (rewrites for records that still hold
   conversations, deletions for records left empty).
3. Then perform **one** summary write carrying both the transcript-id removal and
   the figure correction.

The ordering is not interchangeable, and each half's failure mode is what decides
it:

- **Records fail** → nothing has been written at all. A retry is a clean redo: the
  conversations are still readable and the memory still claims their ids. The
  failure is surfaced as a visible error.
- **Summary write fails** → a dangling id (file gone, id still listed) plus stale
  figures. The dangling id is harmless in the display and self-heals there: the
  panel intersects the memory's ids with the transcript files that actually exist
  before rendering anything from them.
- **Ids first (the rejected order)** would be unrecoverable: the id strip is
  durable while the record batch can still fail, so the user's retry would
  recompute the correction against a memory in which **no node claims the detached
  id** — the no-claimant outcome — which refuses to guess. The detach would then
  "succeed" on the second attempt with the figures permanently stale, and the
  orphaned records referenced by nothing.

The correction is deliberately **not** published to the in-memory memory before the
writes succeed. An already-subtracted in-memory value surviving a failed write
would let the user's retry apply the same subtraction a second time — and the
zero-floor would then collapse the meter to "not reported", indistinguishable from
a memory that never reported usage. Only what is durable is published.

### When the summary write fails — told only if there was a correction to lose

A failed summary write is **not** retried and is **not** recoverable:

- The conversations are already gone from the stored records, so a second attempt
  finds nothing to remove and completes as a plain acknowledgement.
- The subtrahend this run held in memory is unrecoverable, because it is read from
  the removed conversations' own persisted shares, which are only readable while
  they are still in the records.
- Regenerating the memory does not help: regeneration carries the token figures
  over verbatim rather than recomputing them from conversations.

So the figures stay permanently high by the detached conversation's share. A log
line the user never opens is not an honest way to report that — but the
notification that says so is **gated on there having been an attributable
correction to lose**, which splits the failure into two outcomes:

- **Something was attributable.** A **warning notification** is shown stating that
  the conversation was detached but the memory's token and cost figures could not
  be updated and still include it.
- **Nothing was attributable.** The write that would have run carries only the
  transcript-id removal, and its failure produces **no notification at all** — a
  single log line and nothing on screen. The memory keeps a dangling id and figures
  that were already stale before this detach began. This is the less honest of the
  two outcomes: the user is told nothing, and the same "stale figure with no trace"
  this behavior exists to avoid is exactly what they are left with. It is a gap in
  the reporting, not a designed exemption — the figures being *already* wrong is
  not a reason to stay silent about a write that failed.

Either way the row is still acknowledged to the panel — the records really did
change, and leaving the row on screen would only invite the no-op retry.

### Success path: in-place meter replacement

On success the panel is told the conversation was detached, and — **only when the
figures actually changed** — is handed a freshly-built token meter to swap in
place. The row is removed and the meter replaced without a full re-render, so a
single-row change does not collapse scroll position and expanded sections. When
nothing was attributable the meter is deliberately omitted and keeps its current
value, which is the honest reading of "we cannot know" (see [109 — VS Code Summary
Webview Panel]).

## State Transitions

Per detach: collect removed shares (last readable moment) → resolve ownership over
the whole tree → classify each id (owner found / unattributable) → subtract at each
owner and re-derive its cost → write stored records → write the summary once
(ids + figures) → refresh the panel's id set → acknowledge the row, with a rebuilt
meter only if the figures changed.

Nothing is retried at any step. Every step before the record write is pure
computation over the input tree; the tree itself is never mutated in place.

## Notable Behavior

- **The per-conversation share is the entire reason this is possible.** A memory
  records only the post-merge aggregate with no record of who contributed what, so
  before the share was persisted, detaching a conversation could not update the
  figures at all. Everything here is forward-only for that reason. (Notable; see
  [245].)
- **A node listing an id does not mean it owns it.** On a consolidated root the id
  list is a tree-wide index while the node's figures cover only its delta (or
  nothing). Ownership must be computed post-order — deepest claimant wins. (Surprising;
  intentional.)
- **The per-skill correction deliberately ignores ownership, and the aggregate one
  deliberately cannot.** The skill correction runs on every node because an amend
  genuinely records one conversation's skill contribution at both the root and the
  child it wraps, and deleting a key from a split cannot double-subtract the way
  subtracting a total from two nodes would. So the two corrections in this one
  operation apply opposite rules for good reasons, and neither rule is safe for the
  other's data. (Surprising; load-bearing.)
- **A skill row whose split empties keeps its identity and loses only its figure.**
  The invocation count stays and both usage fields are stripped, because "it ran,
  we can no longer say what it cost" is the honest reading. A zero would claim the
  skill was free; removing the row would claim it never ran. (Notable; the same
  strip-never-zero contract the aggregate group follows.)
- **Skill confidence is re-derived, never carried.** Dropping the only estimated
  session leaves a remainder that really is fully attributed, so keeping the old
  label would understate what is now known. (Notable.)
- **A skill row written before per-session splits existed is corrected not at all.**
  It is returned untouched — the same refusal-to-invent-a-subtrahend the aggregate
  path applies, and the reason a merged split is dropped rather than half-kept
  upstream (see [04 — Summary Tree Structure]). (Notable; forward-only.)
- **The tree is walked when EITHER correction has work.** Gating the walk on
  ownership alone would leave a memory's skill figures stale while the result
  reported that nothing changed — the exact "wrong number, no trace" outcome this
  behavior exists to avoid. (Surprising; intentional.)
- **A per-model split without a segment breakdown is treated as no share at all.**
  The two halves of a persisted share are gated independently at write time, so a
  record can carry the per-model split alone; this correction never looks past the
  missing breakdown, so it reports the conversation unattributed while the exact
  subtrahend sits unread on disk. (Surprising; a consequence of two independent
  write gates meeting one read gate, not a deliberate refusal. See [245].)
- **Zero claimants and two claimants are both "correct nothing, report it".** Not
  an error, not a guess — the memory keeps its stale figure and the shortfall is
  reported. (Intentional.)
- **A partial attribution corrects part of the total *and* reports the rest.** The
  changed flag and the unattributed list are not mutually exclusive. (Surprising;
  a natural reading would treat "reported" as "skipped".)
- **An owner node that carries no figure silently absorbs its subtrahend.** Unlike
  the three outcomes above, this one is not reported: there is nothing to correct,
  so the correction reports success while the detached share is simply dropped.
  (Surprising; a real reporting gap, not a designed exemption.)
- **Over-subtraction is possible and is floored, not reconciled.** A memory written
  before per-response de-duplication carries an inflated aggregate while the
  detached conversation's recorded share is not inflated, so the subtrahend can
  exceed the stored value. Flooring collapses such a node to "reports no usage".
  (Surprising; intentional — the alternative is a fabricated remainder.)
- **The field group is stripped, never zeroed.** A stored zero would render as a
  real measurement of nothing; absence renders as "not reported". (Surprising;
  intentional. Same contract as at write time — see [04].)
- **Cost is re-derived from what remains, and re-stamped.** Never scaled from the
  previous figure, because the detached conversation's model may differ from (or be
  absent from) the price table. The stamp can therefore post-date the memory.
  (Notable.)
- **Identity is the producer-and-id pair.** A conversation with the same raw id
  under a different producer is not detached, in the records or in the figures.
  (Notable.)
- **The correction is computed early and published late.** It is held in a local
  until both writes succeed, because a retry against an already-subtracted
  in-memory value would subtract twice and the floor would then hide the memory's
  usage entirely. (Surprising; intentional.)
- **Records are written before the summary, and the reverse order was rejected as
  unrecoverable.** Writing ids first turns a later failure into a retry that can no
  longer attribute anything (no node claims the id), leaving the figures
  permanently stale and the records orphaned. (Surprising; intentional.)
- **A failed summary write is permanent, and the user is told so only when a
  correction was lost with it.** Not retried, not recoverable by retrying, and not
  fixable by regenerating (regeneration carries the token figures over verbatim).
  When something was attributable the figures stay high by the detached
  conversation's share and a warning says so. When nothing was attributable the
  failing write carried only the id removal, and the user sees nothing — a log line
  is the whole report. (Surprising; the silent branch is a reporting gap, and the
  less honest of the two outcomes.)
- **The meter is swapped in place, and omitted when nothing changed.** No full
  re-render for a single-row change, and no meter update at all when nothing was
  attributable — the old value stands rather than being replaced by a guess.
  (Notable.)

## Shared Behavior

- The per-conversation share this correction consumes — including why exactly one
  stored record per conversation carries it, why an overlay-pruned conversation has
  none, and why an all-zero share is never persisted — is written by
  [245 — Commit-Pipeline Conversation Token Attribution].
- The segment semantics, the flat-rate estimator, and the per-response
  de-duplication whose absence in older data makes over-subtraction possible are
  defined in [243 — Token Usage Extraction and Cost Estimation].
- The price table, the cost formula, the unpriced-model rule and the verification
  stamp re-applied here are defined in [257 — Multi-Provider Pricing and Cost
  Estimation].
- The corrected fields, the "absent means not reported" contract, and the
  tree-aggregation helpers every display surface reads them through are defined in
  [04 — Summary Tree Structure]. That spec also owns the skill accumulation whose
  all-or-nothing merge of per-session splits exists precisely so this correction's
  re-derivation from the surviving split cannot silently under-report.
- The per-skill usage split this correction deletes from — how it is captured, keyed
  and attributed at write time — is owned by spec 321, and the row it sits on by
  spec 319.
- The transcript-id list whose per-node meaning drives ownership resolution is
  defined in [185 — V5 UUID Identity and Migration].
- The panel that offers the detach control, gates it in read-only modes, hides
  turn-less carrier records from its conversations list, and performs the in-place
  meter swap is [109 — VS Code Summary Webview Panel].
