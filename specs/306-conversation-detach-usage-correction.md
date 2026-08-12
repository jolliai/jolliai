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
- Per-node ownership resolution over the consolidation tree — both of its evidence tiers — and why the node's own transcript-id list is not itself the ownership record.
- The three unattributable outcomes (no resolvable claimant, several claimants, a removed conversation with no recorded share) and the partial-subtraction case that both corrects and reports.
- The subtraction itself: per-segment flooring, the scalar-only degrade, stripping the field group when nothing remains, and re-derivation (never scaling) of the cost.
- The second, parallel correction applied to each skill row's per-session usage split — its unconditional per-node application, its re-derivation of the row's total and confidence from what survives, and its forward-only guard.
- The condition under which the tree is walked at all, given that either correction can be the only one with work to do.
- The write ordering — stored conversation records first, then one summary write carrying both the id removal and the figure correction — and what each failure leaves behind.
- The self-heal that runs when that summary write fails: a derivation from the surviving transcripts that also drops the dangling ids, and what each of its two outcomes means for the user.
- What the user is told when the self-heal also fails, and the notification's gate on there having been an attributable correction (so one of the two failure branches is silent).
- The in-place meter replacement the panel performs on success, the deliberate omission of it when nothing was attributable, and the refresh control the replacement markup always carries.

**Out of scope (boundaries)**

- Writing the per-conversation share in the first place, including the one-carrier-per-conversation rule and the turn-less carrier record (see [245 — Commit-Pipeline Conversation Token Attribution]).
- The segment semantics, the cache-read exclusion, and the flat-rate estimator (see [243 — Token Usage Extraction and Cost Estimation]).
- The price table, the cost formula, and the verification stamp (see [257 — Multi-Provider Pricing and Cost Estimation]).
- The summary node's usage/cost field group and the tree-aggregation helpers that read it (see [04 — Summary Tree Structure]).
- The panel that hosts the detach control, its read-only gates, and the conversations list it renders (see [109 — VS Code Summary Webview Panel]).
- The meaning and lifecycle of a node's transcript-id list, and the tree-wide id removal the self-heal writes through (see [185 — V5 UUID Identity and Migration]).
- The derivation the self-heal runs — its evidence contract, its forward-only gate, its idempotence, and its other two consumers (see [333 — Conversation Usage Recomputation from Transcripts]).
- What a regeneration replaces and preserves (see [334 — Summary Regeneration Field Contract]).
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

Each id resolves to **at most one** owner, because the root and its folded children
each carry their own figures and the tree aggregation display surfaces use walks
both — an id counted at two nodes is counted twice everywhere.

Two independent kinds of evidence are consulted, in this order. (This rule is shared
with the derivation in [333 — Conversation Usage Recomputation from Transcripts] and
is stated in full in both places.)

1. **A claim.** A post-order walk restricted to the ids actually being detached, so
   an unrelated tree-wide index costs nothing. A node claims an id the moment it
   lists that id and no descendant already claimed it; claims propagate upward so a
   parent can tell whether its own listing is a claim or just an index entry. This is
   what stops a consolidated root's index from outranking the leaf whose figures
   actually cover the id.
2. **The commit identifier.** A stored conversation record is written under the
   commit identifier of the commit whose conversations it holds, so a node whose own
   commit identifier equals the id is the node those conversations were counted at.

Resolution per id:

- **Two or more claimants** → unresolved (see the outcomes below).
- **No claimant** → look tree-wide for nodes whose commit identifier equals the id.
  Exactly one match owns it; zero or several leave it unresolved.
- **Exactly one claimant** → look for a commit-identifier match **inside that
  claimant's own subtree**, the claimant itself included. Exactly one match owns it;
  zero or several leave the claimant as the owner.

The identifier match may only move ownership **down**, within the claimant's subtree.
A match elsewhere in the tree is ignored on purpose: a stale id that happens to equal
an unrelated node's commit identifier would otherwise be handed someone else's
conversations, and the claim is the stronger evidence there.

**The second tier is what makes a memory in the post-upgrade shape correctable at
all.** The one-shot identity upgrade puts every descendant's commit identifier on the
root's list and leaves the children with no list of their own, so the root is the sole
claimant of ids a child's figures cover — and the identifier tier pushes ownership
back down to that child. A tree in that shape used to resolve to the root or not at
all, so the correction either corrupted the wrong node or refused; it now lands on the
child. The same tier is the only evidence available on a pre-upgrade tree, where no
node lists anything.

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

1. **No claimant, and no unique commit-identifier match.** The memory and the stored
   records disagree about what belongs to this memory, and nothing in the tree was
   written under that identifier either. Note that "no claimant" alone is no longer
   an unattributable outcome: a single identifier match resolves it.
2. **Two or more claimants.** Sibling nodes can both list an id without either
   being the other's descendant, so there is no deepest one. Subtracting at both
   would double-subtract; picking one arbitrarily would corrupt the other. The
   identifier tier is not consulted here — the ambiguity is in the stronger evidence.
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
  figures. Both are then attacked by the self-heal below, which re-derives the
  figures from the surviving conversations and drops the dangling ids from **every**
  node in the same write. The panel's rendering is unaffected either way — it
  intersects the memory's ids with the conversation records that actually exist
  before rendering anything from them — but the dangling id is a real durable defect,
  not a display artefact, and removing it is part of the repair rather than a
  cosmetic tidy-up.
- **Ids first (the rejected order)** was rejected because the id strip is durable
  while the record batch can still fail, so the user's retry would recompute the
  correction against a memory in which **no node lists the detached id**. Ownership
  would then rest entirely on the commit-identifier tier, which resolves only for an
  id that happens to equal exactly one node's commit identifier — never for an
  opaquely-minted one. The detach would "succeed" on the second attempt with the
  figures stale and the orphaned records referenced by nothing.

The correction is deliberately **not** published to the in-memory memory before the
writes succeed. An already-subtracted in-memory value surviving a failed write
would let the user's retry apply the same subtraction a second time — and the
zero-floor would then collapse the meter to "not reported", indistinguishable from
a memory that never reported usage. Only what is durable is published.

### When the summary write fails — re-derive first, warn only if that fails too

The write is **not** retried, and the subtrahend this run held in memory is gone
with it: it was read from the removed conversations' own persisted shares, which
are only readable while those conversations are still in the records, and a second
detach attempt finds nothing to remove and completes as a plain acknowledgement.

The correction is nonetheless recoverable **from the other side**. Deriving the
figures from the conversations that are *left* needs no subtrahend at all, so the
failure handler runs exactly one such derivation (see
[333 — Conversation Usage Recomputation from Transcripts]) before deciding what to
tell the user. Three properties of the moment it runs in are what make it work:

- It reads the memory the panel still holds in memory — the **pre-correction** one,
  since nothing was published — so every id the detach was about to strip is still
  listed and every node's figures are still the stored ones.
- The records themselves have already changed, so the derivation sees exactly the
  conversations that survive.
- The ids whose records the detach deleted now have no backing record, so the same
  run identifies them as dangling and drops them **from every node** in the one write
  it performs. Healing the figures without them would leave the memory referencing
  conversations that no longer exist.

The derivation never throws out of the handler; a failure inside it is swallowed and
answered as "nothing derived", because the handler's next step is a warning and a
second error toast in its place would be a worse report.

Two outcomes follow, and only one of them is visible:

- **Something was derived.** The figures are replaced, the dangling ids are gone,
  **no notification of any kind is raised**, and the acknowledgement carries a
  rebuilt meter exactly as on the success path. Nothing was lost, so nothing is
  said.
- **Nothing was derived** (every owning node's evidence was incomplete, or the
  heal's own write failed). Only now is the user warned, and the warning is further
  **gated on there having been an attributable correction to lose**:
  - **Something was attributable.** A **warning notification** states that the
    conversation was detached but the memory's token and cost figures could not be
    updated and still include it.
  - **Nothing was attributable.** The write that would have run carried only the
    transcript-id removal, and its failure produces **no notification at all** — a
    log line and nothing on screen. The memory keeps a dangling id and figures that
    were already stale before this detach began. This is the less honest of the two
    outcomes: the user is told nothing, and the same "stale figure with no trace"
    this behavior exists to avoid is exactly what they are left with. It is a gap in
    the reporting, not a designed exemption — the figures being *already* wrong is
    not a reason to stay silent about a write that failed.

Two limits on the heal are worth stating here, because they decide whether the
detach's own damage actually gets repaired:

- **It is forward-only in the same way the subtraction is.** A node one of whose
  surviving conversations records no usage share keeps its stored figures, so a
  memory old enough to lack per-conversation shares derives nothing and lands in the
  warning branch.
- **The dangling-id cleanup only engages when the memory's root carries an id list
  at all.** A memory whose root has no list — every pre-upgrade memory, and any
  memory whose root list was lost while its children still list ids — yields an empty
  dangling set, so the heal can re-derive figures there but drops no stale id. See
  [333] for the rule.

Either way the row is still acknowledged to the panel — the records really did
change, and leaving the row on screen would only invite the no-op retry.

### Success path: in-place meter replacement

On success the panel is told the conversation was detached, and — **only when the
figures actually changed** — is handed a freshly-built token meter to swap in place.
The row is removed and the meter replaced without a full re-render, so a single-row
change does not collapse scroll position and expanded sections. When nothing was
attributable the meter is deliberately omitted and keeps its current value, which is
the honest reading of "we cannot know" (see [109 — VS Code Summary Webview Panel]).

"The figures actually changed" is satisfied by **either** the subtraction or the
heal, so the failure path can also carry a meter.

The replacement markup is always built **with the meter's own refresh control
present**, unconditionally — the flag that would suppress it is hard-coded on, so
the swap can never drop a control the first render emitted. The first render instead
decides that control's presence from whether the panel is read-only, and the two
agree only because two *other* gates keep this handler off a read-only panel: a
panel showing another repository's memory is refused by the message dispatcher
before the handler runs, and a panel showing a superseded commit is refused by the
stale-commit guard at the top of it. Neither of those is the read-only flag; the
markup itself makes no check (see [109 — VS Code Summary Webview Panel]).

## State Transitions

Per detach: collect removed shares (last readable moment) → resolve ownership over
the whole tree → classify each id (owner found / unattributable) → subtract at each
owner and re-derive its cost → write stored records → write the summary once
(ids + figures) → refresh the panel's id set → acknowledge the row, with a rebuilt
meter only if the figures changed.

On a failed summary write the tail becomes: re-derive the figures from the surviving
conversations and drop the dangling ids in one write → if that produced a change,
finish exactly as on the success path and say nothing → otherwise warn, but only when
the subtraction had attributed something → acknowledge the row regardless.

Nothing is retried at any step, and the derivation runs at most once. Every step
before the record write is pure computation over the input tree; the tree itself is
never mutated in place.

## Notable Behavior

- **The per-conversation share is the entire reason this is possible.** A memory
  records only the post-merge aggregate with no record of who contributed what, so
  before the share was persisted, detaching a conversation could not update the
  figures at all. Everything here is forward-only for that reason. (Notable; see
  [245].)
- **A node listing an id does not mean it owns it.** On a consolidated root the id
  list is a tree-wide index while the node's figures cover only its delta (or
  nothing). Ownership must be computed post-order — deepest claimant wins.
  (Surprising; intentional.)
- **Ownership has a second evidence tier, and it rescues the shapes that used to be
  uncorrectable.** A node whose own commit identifier equals the id is evidence in
  its own right: used alone when nothing claims the id (which is every pre-upgrade
  memory, where no node lists anything), and used to move ownership **down** inside a
  sole claimant's subtree (which is every post-upgrade memory, where the root claims
  ids its children's figures cover). A match outside the claimant's subtree is
  ignored, because a stale id that coincides with an unrelated node's commit
  identifier would otherwise be handed someone else's conversations. (Surprising;
  load-bearing — shared verbatim with [333].)
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
- **Records are written before the summary, and the reverse order was rejected.**
  Writing ids first makes the id strip durable while the record batch can still
  fail, so a retry computes the correction against a memory in which no node lists
  the id — leaving ownership to rest on a commit-identifier coincidence that an
  opaquely-minted id can never satisfy — and the records orphaned. (Surprising;
  intentional.)
- **A failed summary write is no longer the end of it — the handler re-derives the
  figures from the conversations that survive.** The lost subtrahend does not have
  to be recovered, because a derivation needs none; it runs against the memory the
  panel still holds (which nothing published a correction into), so every id is
  still listed and every figure still stored. (Surprising; this replaced an outcome
  that really was permanent.)
- **A successful heal is completely silent.** No notification of any kind, on the
  grounds that nothing was lost — the user sees only the meter change under the
  detached row, exactly as on the success path. (Notable.)
- **The failure path can end up MORE correct than the success path.** The heal is
  reachable only from the write's failure handler, so a detach whose share was
  unattributable but whose write *succeeded* keeps its stale figures untouched,
  while the same detach with a *failed* write gets them re-derived. Nothing on the
  success path re-derives anything. (Surprising; a real asymmetry.)
- **The warning now means "the repair failed too", not "the write failed".** It is
  raised only when the heal derived nothing *and* the subtraction had attributed
  something. Both other combinations are silent, and the nothing-attributable one is
  still the reporting gap it always was — the user is told nothing about a write
  that failed against figures that were already wrong. (Surprising; the silent
  branch is a gap, not a designed exemption.)
- **The heal drops dangling ids from every node, and that is a durable repair rather
  than a cosmetic one.** The panel's own rendering already tolerates a dangling id
  by intersecting the memory's ids with the records that exist, so the removal buys
  nothing on screen — it exists because the memory would otherwise reference
  conversations that are gone. (Notable.)
- **The dangling-id half of the heal does nothing on a memory whose root carries no
  id list**, which includes every pre-upgrade memory — exactly the shape whose id
  list the failed write was going to create. The figures can still be re-derived
  there; only the cleanup is skipped. (Surprising; see [333].)
- **The meter is swapped in place, and omitted only when neither the subtraction nor
  the heal changed anything.** No full re-render for a single-row change, and no
  meter update at all when nothing could be attributed or derived — the old value
  stands rather than being replaced by a guess. (Notable.)
- **The swapped-in meter always carries the refresh control, unconditionally.** Both
  places that build a replacement meter hard-code it as present rather than deriving
  it from the panel's read-only state, so the swap cannot silently drop a control the
  first render emitted. What keeps that from painting a write affordance into a
  read-only panel is not the markup but two unrelated gates: the dispatcher refuses
  the detach on a foreign-repository panel, and the stale-commit guard refuses it on
  a superseded one. (Surprising; correct only by coincidence of the gates.)
- **The handler's own foreign-repository check can never run.** The message
  dispatcher default-denies every command absent from its read-only allow-list, and
  the detach is not on it, so a foreign panel is refused before the handler is
  entered. The check inside the handler is dead code. (Unreachable path; not a live
  protection — the dispatcher is.)

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
- The derivation the failure handler runs — its evidence contract, its
  all-or-nothing per-node gate, its idempotence, the panel-side evidence read it
  shares with the user-pressable control, and its two other consumers — is
  [333 — Conversation Usage Recomputation from Transcripts]. The ownership rule
  stated above is shared verbatim with it.
- The transcript-id list whose per-node meaning drives ownership resolution, the
  shape the one-shot identity upgrade leaves behind, and the tree-wide id removal the
  heal writes through are defined in [185 — V5 UUID Identity and Migration].
- What a regeneration replaces and preserves — including that it re-derives these
  same figures but never drops a dangling id — is
  [334 — Summary Regeneration Field Contract].
- The panel that offers the detach control, gates it in read-only modes, hides
  turn-less carrier records from its conversations list, and performs the in-place
  meter swap is [109 — VS Code Summary Webview Panel].
