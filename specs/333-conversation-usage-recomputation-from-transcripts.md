# 333. Conversation Usage Recomputation from Transcripts

## Topic Statement

Re-derive a committed memory's token and cost figures, per node, from the sessions
its owned transcripts still hold — replacing the stored figures outright rather
than adjusting them by a delta, leaving untouched any node whose evidence is
incomplete, and reporting every id it declined to derive from.

## Scope

**In scope**

- Why a derivation exists at all: it needs no record of what changed, so it can run
  after the fact and it can correct a figure that was already wrong.
- The evidence contract — transcript id to the sessions that file currently holds —
  and the two different meanings of "no entry" versus "an entry holding nothing".
- The transcript-ownership rule that decides which single node's figures cover a
  given transcript id (stated in full here; it is shared with the detach
  correction).
- The set of ids the derivation takes an interest in, which is wider than the set
  the caller supplied evidence for.
- The all-or-nothing per-node gate, the summation, the per-model merge, the
  cost re-derivation and re-stamping, and the strip-never-zero rule.
- Value-based change detection and the reference-preserving tree rebuild that make
  the derivation idempotent.
- The three consumers — the post-detach self-heal, the user-pressable control on the
  usage meter, and regeneration — and what each supplies as evidence, what each does
  with the result, and where they differ.
- The panel-side evidence read shared by the first two consumers, including its
  dangling-id detection and the outcome reporting.
- What the derivation deliberately does not repair.

**Out of scope (boundaries)**

- Correcting the same figures by subtracting a detached conversation's persisted
  share, and everything that surrounds a detach (see
  [306 — Conversation Detach Usage Correction]).
- Writing the per-session share onto a stored conversation record in the first place
  (see [245 — Commit-Pipeline Conversation Token Attribution]).
- Segment semantics, the cache-read exclusion, and the flat-rate estimator (see
  [243 — Token Usage Extraction and Cost Estimation]).
- The price table, the cost formula, the unpriced-model rule and the verification
  stamp (see [257 — Multi-Provider Pricing and Cost Estimation]).
- The usage/cost field group itself, the "absent means not reported" display
  contract, and the tree-aggregation helpers every display surface reads it through
  (see [04 — Summary Tree Structure]).
- The lifecycle and per-node meaning of a node's transcript-id list, and the
  one-shot upgrade that produced today's shapes (see
  [185 — V5 UUID Identity and Migration]).
- Everything else regeneration replaces or preserves (see
  [334 — Summary Regeneration Field Contract]).
- The panel that hosts the meter and its control, its read-only gates, and its
  message dispatch (see [109 — VS Code Summary Webview Panel]).

## Data Contracts

### The usage field group

Each node of a memory can carry a scalar token total, a three-segment breakdown
(input / output / cached), a list of per-model buckets, an estimated cost, and the
price-table verification stamp that cost was computed under. The derivation owns all
of them together: it either rewrites the whole group on a node or leaves the whole
group alone. It never writes some members and leaves others standing.

### Evidence

A map from transcript id to the sessions that transcript currently holds. Each
session contributes an optional per-segment usage share and an optional per-model
split.

Two absences mean opposite things and must not be conflated:

- **An entry holding an empty list** means "that transcript is known to hold nothing
  any more" — the file is gone, or it was emptied. Its owner derives to nothing and
  its figures are stripped.
- **No entry at all** means "unknown" — the caller could not read it, or did not try.
  Its owner is skipped and keeps its stored figures.

Mapping an unreadable id to an empty list is therefore a data-loss bug: it is
indistinguishable from "the transcript is gone" and would strip usage the memory
legitimately still has.

**The caller's evidence must be complete for the whole tree**, meaning one entry per
id that *any node* lists — not just the ids the root advertises. Attribution is per
node, so evidence gathered from the root's index alone leaves every child-listed id
unread and skips exactly the child that needed repairing.

### Result

- The memory with derived figures — the same reference when nothing changed, and
  structurally sharing every untouched subtree so a caller can compare by reference.
- A changed flag, true when at least one node's group was rewritten.
- A list of skipped ids: those with no single owning node, plus those whose evidence
  was missing or incomplete. The figures for the nodes behind them are untouched.

The changed flag and the skipped list are independent: a tree can derive one owner
and skip another in the same pass.

## Behavior

### The interest set

The ids under consideration are the union of the ids the caller supplied evidence
for and the ids **listed** anywhere in the tree (every node's own list, root
included). Including the listed-but-unsupplied ids is what makes a missing file
visible: that id still resolves to an owner, and that owner is exactly the node
whose figures cannot be derived, so it is skipped rather than derived short.

When the interest set is empty the input memory is returned unchanged with nothing
skipped.

### Transcript ownership — the id list is not the ownership record

A node's transcript-id list means two different things depending on where it sits,
which is why ownership is computed rather than read off the field:

- On a **leaf**, the ids whose sessions that node's figures cover.
- On a **consolidated root**, a tree-wide index. Amend, rebase-pick and squash all
  re-list every descendant's ids at the root so that a lookup finds every file —
  while the root's own figures cover its delta only (amend, pick) or nothing at all
  (squash).

Each id resolves to **at most one** owner, because the root and its children each
carry their own figures and the tree aggregation every display surface uses walks
both — an id counted at two nodes is counted twice everywhere.

Two independent kinds of evidence are consulted, in this order:

1. **A claim.** A post-order walk over the tree, restricted to the ids of interest.
   A node claims an id the moment it lists that id and no descendant already claimed
   it; a claim made anywhere in a subtree propagates upward so the parent can tell
   whether its own listing is a claim or just an index entry. This is what stops a
   consolidated root's index from outranking the leaf whose figures actually cover
   the id.
2. **The commit identifier.** A transcript file is written under the commit
   identifier of the commit whose sessions it holds, so a node whose own commit
   identifier equals the transcript id is the node those sessions were counted at.

Resolution per id:

- **Two or more claimants** → unresolved. Sibling nodes can both list an id without
  either being the other's descendant, so there is no deepest one; subtracting or
  deriving at both would double-count, and picking one arbitrarily would corrupt the
  other.
- **No claimant** → look tree-wide for nodes whose commit identifier equals the id.
  Exactly one match owns it; zero or several leave it unresolved.
- **Exactly one claimant** → look for a commit-identifier match **inside that
  claimant's own subtree** (the claimant itself included). Exactly one match owns it;
  zero or several leave the claimant as the owner.

The identifier match may only move ownership **down**, within the claimant's subtree.
A match elsewhere in the tree is ignored on purpose: a stale id that happens to equal
an unrelated node's commit identifier would otherwise hand that node someone else's
sessions, and the claim is the stronger evidence there.

**This is what makes a memory in the post-upgrade shape attributable.** The one-shot
identity upgrade puts every descendant's commit identifier on the root's list and
leaves the children with no list at all, so the root is the sole claimant of ids a
child's figures cover — and the identifier tier is what pushes ownership back down to
that child. Trees in that shape used to be unattributable outright.

Unresolved ids are reported, never guessed at.

### Deciding per node, before rewriting anything

Owned ids are grouped by owning node. For each owner, every one of its ids must
resolve to evidence that is present **and** in which **every** session carries a
recorded usage share. One id missing from the evidence, or one usage-less session in
any of them, makes the whole owner unusable: that id is added to the skipped list and
the owner is left exactly as it is, never derived from its readable ids alone.

The gate is forward-only and deliberately conservative. A session written before
per-session shares existed — or produced by a source that reports none — would sum
short, and deriving there destroys usage the memory legitimately has.

### Deriving one node's figures

The owner's sessions are summed segment by segment, and the per-model buckets of
every session that reports them are merged by model name (the first bucket seen for a
model supplies its non-numeric attributes; later ones add their segment counts).

- If the three segments sum to **zero**, the whole field group is emitted as absent —
  stripped rather than written as zeros, because a stored zero renders as a real
  measurement of nothing while absence renders as "not reported". This is also the
  path an owner takes when its only owned transcript is known to hold nothing: the
  meter honestly falls back to "not reported".
- Otherwise the total and the breakdown are written from the sums.
- The per-model list is emitted whenever **any** session reported models, not only
  when all of them did. That matches how the write path stores it, which is what
  keeps the derivation idempotent on a healthy memory — gating on every session
  having reported models would delete a legitimately partial list on the first press
  of the control. A partial list does mean the cost covers only the sessions that
  reported a model; the meter labels that figure an estimate.
- The cost is computed **from the merged buckets** and attached, together with the
  price table's current verification stamp, only when it is strictly positive.
  Nothing is scaled from the previous figure: the sessions that remain may run
  different — or unpriced — models than the ones that were there before. A node whose
  remaining models are all unpriced therefore keeps its tokens and loses its cost.

The re-applied stamp can **post-date the memory itself**. It dates the pricing, not
the memory.

### Change detection is by value, not by identity

Before rewriting a node, its current group and the derived group are reduced to a
canonical form and compared:

- The per-model list is sorted by model name using a plain byte-order comparison, not
  a locale-aware one — a locale-sensitive sort would reorder identical data under a
  non-English locale and turn an unchanged node into a rewrite.
- Every value is projected positionally before serialization; nothing is serialized
  as a whole object. A stored breakdown was parsed off disk, so its key order is
  whatever the writer used, and serializing it whole would differ from the derived
  form on values that are equal — rewriting the node, and therefore writing to
  storage, on every single pass of a routine whose contract is idempotence.

Equal canonical forms return the node unchanged. Unequal ones **strip all five
members and then write the derived ones**, so a node cannot keep, say, a cost
belonging to sessions that are no longer there.

### Rebuilding the tree

The tree is walked only when at least one owner produced a derived group. Each node's
children array is rebuilt only when some descendant actually changed, so untouched
subtrees keep their identity and a caller can compare by reference. The input tree is
never mutated.

### What it deliberately does not repair

- **The pre-de-duplication inflated history.** A memory whose aggregate counted one
  response once per transcript line predates per-session shares entirely — its
  sessions carry none, so the forward-only gate skips those nodes and the inflated
  figure is preserved. Repairing that corpus would require the per-session shares to
  be written onto those archived transcripts first.
- **Per-skill usage splits.** Those are corrected by key deletion elsewhere; deriving
  them would mean pruning keys not seen in the transcripts, which is only safe when
  the evidence covers the whole tree, and an amend hoists a child's skill rows onto
  the root so a key legitimately absent from the root's own files would look
  detached.
- **Dangling transcript ids**, except on the panel path below — the derivation itself
  never touches an id list.

## The Panel Path

Two consumers share one read-and-persist routine on the memory panel.

### Reading the evidence

1. Resolve the ids: the union of every node's own list, falling back to the
   memory's advertised list when no node lists any (a pre-upgrade tree, whose ids are
   commit identifiers, and a memory whose list is legitimately empty).
2. Read the set of transcript files that actually exist.
3. Ids with a file are **present**; ids without one are **dangling** — but the
   dangling set is computed **only when the root carries an id list at all**.
4. Read the present ids' transcripts. Each id that came back maps to its sessions;
   each dangling id maps to an empty list; an id whose file could not be read or
   parsed is **omitted**, so its owner skips rather than being zeroed.
5. Every listed id with no evidence entry is recorded as **unread**, which is a
   different fact from "carries no recorded usage" and is reported differently.

Read failures are deliberately not swallowed here — the caller aborts instead. An
empty-set fallback would look exactly like "every transcript file is gone".

On a pre-upgrade memory the ids are commit identifiers and most commits never had a
conversation, so a missing file means nothing at all; those ids are simply left out of
the evidence and their owners keep their stored figures.

### Persisting

- Nothing derived and no dangling ids → return without writing.
- Otherwise, when there are dangling ids, the derived memory is routed through the
  tree-wide id removal, which strips those ids from **every** node's list and performs
  one write carrying both the removal and the derived figures.
- When there are no dangling ids, the derived memory is written directly.
- The panel adopts the persisted memory and refreshes its own transcript-id set.
- The count of dropped ids is taken from whether the removal actually produced a new
  memory, not from the size of the dangling set.

### Consumer 1 — the self-heal after a failed detach

Runs inside the detach's own failure handler and **never throws**: its caller's next
step is to warn the user, and a second failure must not replace that warning with an
error toast. On success it logs that the figures were re-derived; when nothing was
derived it logs which ids were skipped and whether the reason was unreadable
transcripts or unrecorded usage. Its boolean answer is what decides whether the detach
warns the user at all. See [306].

### Consumer 2 — the control on the usage meter

Reachable from the meter itself whenever the panel is not read-only.

- A foreign-repository check sits at the top of the handler and is **unreachable**:
  the panel's message dispatcher default-denies every command absent from its
  read-only allow-list, and this command is not on it, so a foreign panel never
  reaches the handler. The same dead check pre-exists on the detach handler.
- A stale-commit guard **does** run, and short-circuits when the panel is showing a
  memory whose commit was rewritten — which is also what keeps the write out of a
  superseded panel.
- The outcome is **always** reported, because a silent no-op reads as a broken control
  and a partial derivation the user is not told about reads as a settled figure. Four
  branches:
  - **Some ids were skipped** → an informational message naming how many archived
    conversations were affected, worded either as "could not be read" or as "carry no
    recorded per-conversation usage", and prefixed differently depending on whether
    anything else was derived ("partly updated" versus "left as they are"). The
    "could not be read" wording additionally points at the log.
  - **Nothing was read at all** → "this memory has no archived conversations to derive
    from". Reporting "already match" there would claim the figures were verified when
    nothing was read.
  - **Read something, derived nothing** → "figures already match the stored
    conversations".
  - A dropped-dangling-ids sentence is appended to whichever of the reporting
    branches fired. It cannot appear on the nothing-was-read branch, since a dangling
    id is itself an evidence entry.
- When something changed, the panel is handed a freshly built meter to swap in place
  rather than re-rendering the whole page.

### Consumer 3 — regeneration

Regeneration reads every listed transcript to rebuild the conversation it feeds the
model, then reuses that same read as the evidence. Three differences from the panel
path:

- It maps **nothing** to an empty list. A missing entry there means the read did not
  return it, which is indistinguishable from an unreadable file.
- It therefore never strips a node's figures for a deleted transcript, and it
  **never drops a dangling id** — only the panel path does that.
- Skipped ids are logged at debug level and surfaced nowhere.

See [334] for the rest of what regeneration replaces and preserves.

## State Transitions

Per run: build the interest set → resolve ownership over the whole tree → group
owned ids per owner → gate each owner all-or-nothing → derive each usable owner's
group → compare canonically → rebuild only the nodes that changed. Nothing is
retried and the input tree is never mutated.

Per node, the outcome is one of: derived and rewritten, derived to nothing and
stripped, derived and found identical (unchanged), or skipped for incomplete
evidence or unresolved ownership.

## Notable Behavior

- **A derivation, not an adjustment — which is the whole point.** It needs no
  subtrahend, so it can run after the fact on a memory whose correction was already
  lost, and it can replace an aggregate that was wrong before anything was detached.
  (Notable; this is what makes one routine serve a self-heal, a manual control, and
  regeneration.)
- **Ownership now has two evidence tiers, and the second one rescues the
  post-upgrade shape.** A node whose own commit identifier equals the transcript id
  is a claim in its own right — used alone when nothing claims the id, and used to
  move ownership down inside a sole claimant's subtree. Memories whose descendant ids
  were all hoisted to the root are attributable because of it. (Surprising;
  load-bearing.)
- **An identifier match outside the claimant's subtree is ignored.** A stale id that
  happens to equal an unrelated node's commit identifier would otherwise be handed
  someone else's sessions. (Notable.)
- **One usage-less session poisons the whole node, not just its own share.** A
  partial sum is a silent under-report, so the node keeps its stored figures and the
  id is reported instead. (Surprising; intentional — a stale figure with a trace
  beats an invented one that reads as settled truth.)
- **An entry holding nothing strips the node; a missing entry preserves it.** The two
  absences are opposite instructions, and mapping an unreadable id to "nothing" is
  the way to lose data with this routine. (Surprising; the caller contract exists
  entirely for this.)
- **Evidence must cover ids the root does not advertise.** Attribution is per node,
  so reading only the root's index leaves child-listed ids unread and skips exactly
  the child that needed repairing — which is the shape a lost write leaves behind,
  i.e. when the repair is needed most. (Surprising; intentional.)
- **The per-model list is emitted when ANY session reported models.** Requiring all
  of them would delete a legitimately partial list that the write path had stored,
  on the first press of the control — turning an idempotent routine into a
  destructive one. (Surprising; matches the write path deliberately.)
- **Change detection is canonical, and both halves of that are load-bearing.** A
  locale-aware model sort and a whole-object serialization each turn an unchanged
  node into a rewrite — and a rewrite here is a storage write per press. (Surprising;
  intentional.)
- **The field group is stripped, never zeroed.** A node whose owned transcripts hold
  nothing loses the whole group so the meter reads "not reported" rather than showing
  a measured zero. (Notable; same contract as at write time — see [04].)
- **Cost is re-derived and re-stamped, never scaled.** The stamp can post-date the
  memory, and a node whose remaining models are all unpriced keeps its tokens and
  loses its cost. (Notable.)
- **The inflated pre-de-duplication corpus is deliberately not repaired.** Those
  memories predate the per-session share entirely, so the forward-only gate skips
  them and the inflated figure survives. The manual control reports exactly that
  rather than pretending to have checked. (Notable.)
- **The dangling-id cleanup does nothing on the very shape it exists for — when the
  root has no id list.** The dangling set is computed only when the root carries a
  list, so a memory whose root lost its list while its children still list ids yields
  zero dangling ids and the cleanup is a silent no-op, even though the derivation
  itself still runs over that tree. (Surprising; a real gap.)
- **Regeneration re-derives but never cleans up.** It runs the same derivation, yet
  it maps nothing to "gone" and drops no stale id — so it can leave a memory with
  correct figures and dead transcript references. (Surprising; the two consumers
  supply deliberately different evidence.)
- **The manual control's foreign-repository check can never run.** The dispatcher's
  default-deny allow-list rejects the command before the handler is entered. The
  handler's own check is dead code, and the same dead check pre-exists on the detach
  handler. (Unreachable path; not a live protection.)
- **The "unreadable" wording is decided by ONE id and applied to all of them.** The
  reporting branch counts every skipped id but picks its sentence from whether *any*
  of them was unread — so a single unreadable transcript makes every skipped
  conversation report as unreadable, including the ones that were read fine and
  simply record no usage. The code comment beside it claims the opposite collapse
  had been the problem. (Surprising; the collapse is still there, in the other
  direction.)
- **A dangling-id cleanup with no figure change still writes, and still reports.**
  Saying only "already match" would hide that the memory was modified and make the
  conversations list silently losing a row look like a bug. (Notable.)
- **A dangling-set that is non-empty always produces a write.** Every dangling id is,
  by construction of the id resolution, listed by some node, and the removal filters
  every node — so the guarded "the removal turned out to be a no-op" arm of the drop
  count is not reachable through this read path. (Unreachable path.)

## Shared Behavior

- The per-session share this derivation consumes — including why exactly one stored
  record per conversation carries it, and why an all-zero share is never persisted —
  is written by [245 — Commit-Pipeline Conversation Token Attribution].
- The segment semantics and the flat-rate estimator behind those shares are defined
  in [243 — Token Usage Extraction and Cost Estimation].
- The price table, the cost formula, the unpriced-model rule and the verification
  stamp re-applied here are defined in
  [257 — Multi-Provider Pricing and Cost Estimation].
- The usage/cost field group, the "absent means not reported" contract, and the
  tree-aggregation helpers every display surface reads it through are defined in
  [04 — Summary Tree Structure].
- The ownership rule stated above is shared verbatim with
  [306 — Conversation Detach Usage Correction], which resolves the same question for
  its subtraction.
- The transcript-id list whose per-node meaning drives ownership, the shape the
  one-shot upgrade leaves behind, and the tree-wide id removal the panel path writes
  through are defined in [185 — V5 UUID Identity and Migration].
- The panel that hosts the meter, its control, its read-only gates and its message
  dispatch is [109 — VS Code Summary Webview Panel].
- The rest of regeneration's field contract is [334 — Summary Regeneration Field
  Contract].
