# 245 — Commit-Pipeline Conversation Token Attribution

## Topic Statement

Attribute transcript token usage per conversation during commit-summary
generation, so that excluded conversations and overlay-deleted turns are dropped
from the token total that is stored on the commit summary — while every
conversation's cursor still advances.

## Scope

**In scope**

- The per-conversation token bucket keyed by `(source, sessionId)`, accumulated as each session's pending transcript slice is read during a commit / amend / squash / rebase pipeline run.
- The rule that every session is read (so its cursor advances) even when it is excluded or its turns are overlay-deleted.
- Drop rule (a): a conversation named in the exclusion store has its bucket removed from the stored total — its cursor still advanced.
- Drop rule (b): a session whose post-overlay entry count is lower than its pre-overlay count has its whole bucket zeroed for that session only; edit-only overlays keep their bucket; zero-entry usage-only sessions are never flagged.
- The stored per-commit token total and its per-segment breakdown, and the strictly-positive guard applied at every write site so a literal zero is never persisted.
- The per-conversation bucket's **per-model usage map**, merged in the same overlay-reconciliation loop as the scalar/breakdown totals, so both drop rules apply to it identically.
- The single write-time helper that turns surviving per-model usage into the commit summary's usage/cost fields, generalizing the strictly-positive guard into a three-way state (no usage / usage-but-unpriced / usage-priced) — see [257 — Multi-Provider Pricing and Cost Estimation] for the pricing side of that decision.

**Out of scope (boundaries)**

- Extracting a per-turn breakdown from a transcript line and the cache-read exclusion (see [243 — Token Usage Extraction and Cost Estimation]).
- Pricing the stored total into a dollar figure with the Sonnet-only estimator (see [243 — Token Usage Extraction and Cost Estimation]), and pricing per-model usage against the multi-provider price table (see [257 — Multi-Provider Pricing and Cost Estimation]) — this spec only carries the per-model usage as far as the write-time helper's input, it does not price it.
- The whole-conversation, cursorless review-panel meter (see [244 — Conversation Token Totals for the Review Panel]).
- The exclusion store's file format, keys, and read/write API — consumed here as a black box (see [188 — Commit Exclusion Selection Store]).
- The overlay store's identity-matching and rule lifecycle — consumed here only as a per-session entry-count delta (see [183 — Conversation Overlay Store]).
- The cutoff rule that decides which slice of a transcript belongs to this commit (see [16 — Claude Code Transcript Reading] and [36 — Summary Attribution by Transcript Cutoff]).
- The summary record fields that receive the stored total (see [04 — Summary Tree Structure]).

## Data Contracts

### Per-conversation token bucket

During a pipeline run, each conversation read accumulates into a bucket keyed by
its `(source, sessionId)` identity, holding a scalar token total, a
per-segment breakdown (input / output / cached), **and a per-model usage map**
(one entry per distinct model id the session's slice attributed tokens to). A
conversation that is read more than once merges into its existing bucket
rather than overwriting it, including the per-model map (same-model entries
sum their segments). A bucket is populated even for a slice that yields
**zero** displayable turns (a usage-only slice), so the per-conversation
subtraction downstream stays exact.

### Stored per-commit total

The commit summary receives a scalar conversation-token total, a matching
per-segment breakdown, and a per-model usage list, all computed as the sum of
the surviving buckets (and their per-model maps) after the two drop rules
below. The scalar total and breakdown are written together or not at all; the
per-model usage list and any resulting cost figure are decided by the
write-time helper described below, which layers a further condition on top
(see the three-way state in [257 — Multi-Provider Pricing and Cost
Estimation]).

## Behavior

### Read everything, then drop

All discovered sessions for the commit are read — including the ones the user
unchecked and the ones an overlay pruned — so that every session's cursor
advances past the slice attributed to this commit. Selection semantics are
"unchecked ⇒ one-time discard": an excluded conversation is still consumed (its
cursor moves to the commit boundary) so it leaves the working area, but its
content and its tokens are dropped from this commit. Attribution then applies two
independent drop rules to decide which buckets survive into the stored total.

### Drop rule (a) — explicit exclusion-store membership

For each session whose `(source, sessionId)` key is present in the exclusion
store's conversation set, the bucket — scalar total, breakdown, **and
per-model map together** — is removed at a single point from both the
surviving entry stream and the per-conversation token map. The cursor for that
session has already advanced (it was read like any other), but its tokens never
reach the stored total, and its per-model contribution never reaches the cost
estimate either. Removing it from the token map — not merely from the
entry stream — is essential, because the downstream reconciliation sums the token
map (per-model buckets included): a bucket left in the map would re-add its
tokens to the stored total (and so to the branch token bar and its model-aware
cost) even though the summary body and entry counts reflect only the kept
conversations.

### Drop rule (b) — per-session overlay-delete zeroing

After per-session conversation-edit overlays are applied, each session's
post-overlay entry count is compared to its pre-overlay entry count:

- If the post-overlay count is **lower** than the pre-overlay count, the overlay
  deleted turns from that session. That session's bucket is zeroed **entirely**,
  and only for that session. There is no per-turn token attribution to prorate
  with (usage is summed per raw line before turns are merged, and the merge
  discards the line-to-token mapping), so whole-session zeroing is the finest
  granularity available. Reconciling per session — rather than at the aggregate
  level — means a delete in one conversation does not wipe the untouched token
  counts of every other conversation in the same commit.
- If the count is **unchanged**, the overlay was edit-only (a content rewrite):
  those tokens were genuinely spent generating the original turns, so the bucket
  is kept in full rather than zeroed on a rewrite that has no token attribution
  either way.
- A **zero-entry usage-only session** (zero entries before and after) is never
  flagged as removed (0 is not lower than 0), so its tokens survive.

The surviving buckets — scalar total, per-segment breakdown, and per-model
map — are all summed in the same reconciliation loop: a session dropped by
either rule drops from all three simultaneously, so the per-model usage that
feeds cost estimation can never disagree with the scalar total or breakdown
about which sessions survived.

### Strictly-positive write guard, generalized to a three-way state

At every site that writes the commit summary — the normal commit leaf, both
amend branches (LLM and message-only), the squash / merge-squash root, and each
degraded-path fallback — a single write-time helper decides which usage/cost
fields to attach, given the surviving scalar total, breakdown, and per-model
map:

1. If the scalar total is not strictly greater than zero, none of the usage
   fields are attached at all — no token total, no breakdown, no per-model
   usage, no cost. A literal zero total is never persisted (matching the
   forward-only, absent-when-unknown contract of those fields in
   [04 — Summary Tree Structure]).
2. Otherwise the token total and breakdown are always attached, and the
   per-model usage is priced (see [257 — Multi-Provider Pricing and Cost
   Estimation]) to decide the remainder:
   - if the per-model usage list is non-empty, it is attached regardless of
     whether any of it priced;
   - a cost figure (and the price-table's verification stamp) is attached
     only when the priced total across that per-model usage is strictly
     greater than zero — an all-unpriced usage list (every model absent from
     the price table) keeps its per-model usage for future re-pricing but
     carries no cost figure.

This generalizes the original scalar/breakdown guard into the three-way state
also described in [257]: no usage at all; usage present but entirely unpriced;
usage present and (at least partially) priced.

## State Transitions

Within one pipeline run: read all sessions (advancing every cursor) → build
per-conversation buckets (scalar, breakdown, per-model) → drop exclusion-store
members from the token map (all three together) → apply overlays and zero any
session the overlay pruned (all three together) → sum surviving buckets →
invoke the write-time helper, which writes the total/breakdown only if
strictly positive, and further writes per-model usage and (conditionally) a
cost figure per the three-way state above.

Cursor advancement is decoupled from summary success: cursors are saved as each
session is read, so an excluded or overlay-pruned conversation still leaves the
working area even though it contributes nothing to the stored figure.

## Notable Behavior

- **Excluded conversations are read and their cursors advance.** This is the
  current reality and it deliberately reverses an earlier "keep excluded
  conversations visible so the user can re-check them" behavior — the per-item
  selection is now a one-time discard. (Surprising; intentional. Note this
  supersedes the older "excluded ⇒ do not read, do not advance cursor" statement
  documented in [188 — Commit Exclusion Selection Store]; the two drop paths —
  exclusion-store membership and overlay-delete — are independent.)
- **Exclusion must drop from the token map, not just the entry stream.** The
  reconciliation sums the map, so a bucket left in it would silently overcount
  the stored total and the branch token bar. (Surprising; intentional.)
- **Overlay-delete zeroes the whole session, not the deleted turns.** There is
  no per-turn token attribution to prorate, so a single overlay delete forfeits
  the entire conversation's token count for that commit — but only that one
  conversation's, never the whole commit's. (Surprising; intentional.)
- **Edit-only overlays keep their tokens.** An entry-count-preserving rewrite is
  not treated as a delete. (Notable.)
- **Zero-entry usage-only sessions survive.** A slice that carries usage lines
  but no merged turns is never flagged as pruned (0 vs 0) and keeps its tokens.
  (Notable.)
- **A literal zero is never stored.** The strictly-positive guard is applied at
  every write site, so absence of the token fields means "no usage-bearing
  conversation", never "zero usage". (Notable.)
- **Per-model usage rides the same drop rules as the scalar total, by
  construction.** Because the per-model map lives inside the same bucket that
  the exclusion and overlay drop rules already operate on, there was no
  separate code path to keep in sync when per-model usage was added — a
  session dropped for the scalar total is, in the same step, dropped for cost
  estimation. (Notable; a "for free" consequence of the bucket's shape rather
  than a rule that had to be separately implemented.)
- **An all-unpriced commit still keeps its per-model usage.** The write-time
  helper's three-way state means a commit whose only conversation used a model
  absent from the price table is not treated the same as a commit with no
  usage at all — the usage is preserved so a future price-table update can
  retroactively cost it without re-reading transcripts. (Notable; see [257].)

## Shared Behavior

- The per-conversation bucket sums the same per-turn breakdown produced by the
  shared extraction path, including the cache-read exclusion (see [243 — Token
  Usage Extraction and Cost Estimation]).
- The "read + one-time discard" of excluded working items — advancing the cursor
  while dropping the content from the commit — is the same discard behavior
  applied to excluded plans, notes, and references, and is shared with
  [36 — Summary Attribution by Transcript Cutoff] and [188 — Commit Exclusion
  Selection Store].
- The exclusion set is read as a black box from [188 — Commit Exclusion Selection
  Store]; the overlay result is consumed only as a per-session entry-count delta
  from [183 — Conversation Overlay Store].
- The stored total and breakdown land on the summary record and are aggregated
  across the consolidation tree per [04 — Summary Tree Structure].
- The write-time helper's pricing decision — how per-model usage becomes a cost
  figure, and why an unpriced model never contributes — is defined in
  [257 — Multi-Provider Pricing and Cost Estimation]; this spec only supplies
  that helper's input (the surviving per-model usage) and stores its output.
