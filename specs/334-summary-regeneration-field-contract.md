# 334. Summary Regeneration Field Contract

## Topic Statement

An end-to-end regeneration of an already-summarized commit rewrites one specific set
of fields around a fresh model call, derives the conversation usage group afresh from
the archived transcripts, and carries every other field over from the stored memory
unchanged.

## Scope

**In scope**

- The normalization that runs before anything else and what it guarantees about the
  shape the rest of the run reads from.
- Which transcript ids are read, and why that set is wider than the memory's own
  advertised list.
- The fields rebuilt by the run, field by field — which of them come from the
  model's answer, which are counted off the transcripts this run read, and which is
  simply the stored value fed through the call and written back.
- The failure marker that is cleared, and why it is cleared by explicit erasure
  rather than by omission.
- The conversation usage group: derived from the transcripts just read where the
  evidence is complete, preserved verbatim where it is not.
- The fields carried over untouched, and the fact that "untouched" is the default
  for anything not named.
- What regeneration deliberately does not do to the archive or to the memory's own
  bookkeeping.
- The single write the caller performs with the result, and the partial repaint that
  follows it.

**Out of scope (boundaries)**

- The model call itself: prompt assembly, topic extraction, recap extraction, the
  provider, and the retry behaviour.
- The normalization's internals — which fields are hoisted, how, and the version
  chain it collapses (see [04 — Summary Tree Structure] and
  [06 — Summary Schema Migration]).
- The derivation rule that produces the usage figures, its ownership resolution, its
  forward-only gate, and its other two consumers (see
  [333 — Conversation Usage Recomputation from Transcripts]).
- The token/cost field group's meaning and display contract (see
  [04 — Summary Tree Structure]) and the pricing behind the cost (see
  [257 — Multi-Provider Pricing and Cost Estimation]).
- The panel's regenerate affordance, its confirmation dialog, its in-flight message
  gate, its cancellation, and its stale-commit re-check (see
  [109 — VS Code Summary Webview Panel]).
- The storage primitives the forced write goes through.

## Data Contracts

### Field disposition

| Field | Disposition |
| --- | --- |
| Topics | **Replaced** from the model's answer. |
| Recap | **Replaced** unconditionally — an empty string when the answer omits one, so a stale recap is never silently preserved. |
| Diff statistics | **Rewritten with the value this run fed the model**, which is the memory's own stored statistics (falling back to the legacy field, then to zeros when it carries neither). The rebuilt diff is prompt input; nothing re-measures it. |
| Transcript-entry count | **Replaced** with the number of entries across the transcripts this run read. |
| Conversation turn count | **Replaced** with the number of human turns across those same transcripts. The write is guarded on the value being supplied, but this run always supplies one, so the "stored value survives" branch is **unreachable here**. |
| Model-call metadata | **Replaced** from the call that just ran. |
| Generation timestamp | **Replaced** with the current time. |
| Generation-failure marker | **Erased**, explicitly. |
| Conversation usage group (total, segment breakdown, per-model buckets, cost, price stamp) | **Derived** from the transcripts just read, per node, where the evidence for that node is complete; **preserved** where it is not. |
| Ticket identifier | Preserved. |
| E2E test guide | Preserved. |
| Plans, notes, external references | Preserved. |
| Commit type and commit source | Preserved. |
| Published document URL and identifier, orphaned document identifiers, unresolved orphan identifiers | Preserved. |
| Skill records and their per-session usage splits | Preserved. |
| Transcript-id lists, on every node | Preserved. |
| Everything else | Preserved. |

Preservation is the default: the memory is copied wholesale and the replacements are
written over it, so a field nobody named survives by construction.

## Behavior

### Normalization first

The run opens by collapsing the stored memory into the unified shape everything
downstream assumes: the root holds the authoritative hoisted fields, unioned across
the whole tree, so child-only attachments and pending-cleanup document identifiers
surface to the root; every descendant is stripped of its own hoisted fields; and the
version marker is stamped to that shape's version.

**It is gated on the version marker and returns the memory untouched when the marker
already reaches that shape**, which every memory written under the current schema
does — so the hoist runs only for memories stored under an older one. For those,
two consequences are worth stating as behaviour rather than as an implementation
step: a child-only e2e guide can **appear on the root** after a regeneration, which
is the deferred upgrade completing rather than a change of content; and descendants
are modified by the run even though no descendant's topics are re-summarized.

### Reading the conversation

Every transcript id **listed by any node** is read — the union over the tree, falling
back to the memory's advertised list when no node lists any. The sessions are
concatenated into one multi-session conversation for the prompt.

The union rather than the root's list alone is load-bearing because the same read is
also the evidence for the usage derivation, which attributes per node: an id only a
child lists would otherwise go unread, and that child would be the one node this
path — the one path that rebuilds everything else — could not repair. The union is a
superset on a well-formed memory and equal to the advertised list on every other, so
the conversation fed to the model can only gain sessions that a short index was
hiding.

The diff is rebuilt from the commit itself. Archived plans, notes and external
references are read back and reassembled into prompt blocks; they are prompt input
only and are never rewritten.

### Assembling the result

The normalized memory is copied, the replaced fields above are written over it, and
the failure marker is set to an explicit erasure rather than being left out — the
serialization drops erased keys, which is what makes the stored record come back
healthy and the panel's failure banner disappear.

The stored scalar token total is re-asserted onto the copy at this point when the
memory carries one. That assignment writes the value the copy already held, so it has
no effect, and the derivation below may replace it in any case.

### Deriving the usage group

After assembly, the conversation usage group is re-derived from the transcripts that
were just read, per node, rather than being carried over. Two failures nothing else
repairs are the reason: an aggregate inflated by the historical double-counting of a
single response, and an aggregate left stale by a detach whose summary write was lost
after the transcript files had already changed.

The evidence is exactly what the read returned: an id the read did not return is
**omitted**, never recorded as "holds nothing". On this path a missing entry means the
read did not produce it, which is indistinguishable from an unreadable file, and
treating it as a deletion would strip usage the memory still has.

The derivation is forward-only, so a node with any usage-less session — or with an
owned transcript this read did not return — keeps its stored figures untouched. Ids
it declined to derive from are logged at debug level and surfaced nowhere.

Because it is a derivation, it can also **remove** the group from a node whose owned
transcripts hold no sessions at all, leaving that node reporting no usage.

### What regeneration does not do

- **It does not touch the transcript-id lists.** A memory that lists a transcript
  with no file behind it still lists it afterwards, however correct the figures now
  are. Only the panel's own repair path drops such an id.
- **It does not correct per-skill usage splits.**
- **It does not rewrite any archive** — the plans, notes, references and transcripts
  it reads are inputs only.
- **It touches no cursor, lock, or queue entry**, so it is fully isolated from the
  live capture pipeline.
- **It does not re-summarize descendants.** The model's answer replaces the root's
  content only; the only way a descendant's content changes is the normalization and
  the per-node usage derivation.

### What the caller does with it

The single side effect is the returned memory, which the caller persists as a forced
write and adopts as the panel's current memory. The repaint that follows carries the
topics section, the recap section and the failure banner — **and nothing else**. The
usage meter is not among them, so a regeneration that changed the token or cost
figures leaves the on-screen meter showing the pre-regeneration values until the panel
is re-rendered in full.

## State Transitions

Per run: normalize → read every listed transcript and rebuild the diff and the prompt
blocks → call the model → copy the normalized memory and overwrite the replaced
fields → erase the failure marker → derive the usage group per node → return. The
caller then writes once, forced, and repaints three sections.

A run that is cancelled, or whose commit is found to have been rewritten while the
model call was in flight, discards the result entirely — nothing is written.

## Notable Behavior

- **Preservation is structural, not enumerated.** The memory is copied and the
  replacements written over it, so any field nobody thought about survives a
  regeneration. The named preserved list is documentation of intent, not the
  mechanism. (Notable.)
- **The recap is always overwritten, including with emptiness.** When the answer
  omits a recap the field becomes an empty string rather than keeping the previous
  text, because the confirmation the user accepted promises the recap is overwritten.
  (Surprising; intentional.)
- **The turn count carries a guard that never fires here.** It is written only when
  the answer supplies a value, and this run counts one off the transcripts it read
  and always supplies it — so the branch preserving the stored count cannot be
  reached through a regeneration. (Unreachable path.)
- **The diff statistics are not re-measured.** The commit's diff is rebuilt for the
  prompt, but the statistics written back are the ones the run fed in — the memory's
  own stored figures — so a stored count that was wrong stays wrong, and a memory
  carrying neither the current nor the legacy field comes back with zeros.
  (Surprising; the field reads as refreshed and is not.)
- **A ticket identifier extracted by this run is discarded.** The answer can carry
  one, and the stored value is kept regardless — the identifier is stable and this
  re-run may not have seen the original in its inputs. (Surprising; intentional.)
- **The failure marker is erased rather than omitted.** Leaving the spread-in value
  alone would keep a stale marker; writing an explicit erasure makes the
  serialization drop the key and the stored record come back healthy. (Notable.)
- **The token figures are re-derived per node rather than carried over.** They come
  from the transcripts this run already had to read, which is what makes regeneration
  a repair path for an inflated or stale aggregate rather than a perpetuator of one.
  (Notable; the derivation itself is [333].)
- **The derivation can strip a node's figures, not only change them.** A node whose
  owned transcripts hold nothing comes back reporting no usage. (Notable.)
- **Regeneration re-derives the figures but never drops a dangling transcript id.**
  It can therefore leave a memory whose numbers are freshly correct while it still
  references transcripts that no longer exist. (Surprising; only the panel's repair
  path cleans those up.)
- **The re-assertion of the stored token total is a no-op.** It writes the value the
  copy already carried, on a line of its own, immediately before the derivation that
  may replace it. (Notable; no effect either way.)
- **The transcripts read is a union over the tree, not the root's index.** That
  widening was made for the usage derivation's sake, and its side effect is that the
  conversation fed to the model can only gain sessions that a short root index was
  hiding. (Notable.)
- **The repaint after a regeneration does not include the meter.** Three sections are
  swapped; a changed token or cost figure is not visible until the panel is rebuilt
  in full. (Surprising; a real gap between what was written and what is shown.)
- **Normalization changes descendants on a path that re-summarizes none of them.**
  Hoisted fields are stripped from every descendant and unioned onto the root, so a
  child-only e2e guide surfaces to the root as a side effect of regenerating — for a
  memory stored under an older schema only, since the pass returns immediately for
  anything already at the current one. (Surprising; the deferred upgrade completing.)

## Shared Behavior

- The per-node derivation of the usage group, its ownership resolution, its
  forward-only gate, its idempotence, and its other two consumers are owned by
  [333 — Conversation Usage Recomputation from Transcripts].
- The unified hoist shape the normalization produces, the usage field group's
  "absent means not reported" contract, and the tree-aggregation helpers display
  surfaces read it through are owned by [04 — Summary Tree Structure]; the version
  chain the normalization collapses is [06 — Summary Schema Migration].
- The transcript-id lists this path reads and deliberately never repairs are owned by
  [185 — V5 UUID Identity and Migration].
- The price table and the verification stamp the derived cost is stamped with are
  owned by [257 — Multi-Provider Pricing and Cost Estimation].
- The panel affordance that triggers a regeneration, its confirmation, its
  cancellation, its in-flight message gate and its stale-commit re-check are owned by
  [109 — VS Code Summary Webview Panel].
- The detach correction whose lost write this path can repair after the fact is
  [306 — Conversation Detach Usage Correction].
