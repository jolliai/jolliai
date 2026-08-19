# 373. Archived Conversation Grouping

## Topic Statement

How a memory's stored conversation slices collapse into the conversation rows a user sees — what counts as one conversation, which stored sessions are not conversations at all, how the slices of one session spread across several commits merge, and what order the merged turns end up in.

## Scope

**In scope:**

- The identity two slices must share to be the same conversation, and the default applied to a slice that records no producer.
- The grouped row's contract: which slice's session record represents the conversation, which owning key it carries, and the merged turn list.
- The result's two halves — an ordered key list and a keyed map — and the guarantee that lets a caller zip them.
- The carrier-versus-real split: which stored sessions are hidden, and the exact predicate, including which slice's recorded usage the predicate reads.
- Cross-commit merging, and the fact that the emitted row order is whatever order the caller handed its transcripts in.
- Chronological slice reordering: the start time of a slice, the comparator, and what happens to a slice that has no parseable timestamp.
- The stage each rule is applied at — merged turns rather than per slice, and the re-filter that keeps the two halves of the result in step.

**Out of scope (referenced, not duplicated):**

- Where a stored transcript comes from and what a stored session's other fields mean — owned by the storage and summary-tree topics. This topic reads only the producer, the session identifier, the turn list, and whether a per-segment usage share was recorded.
- Which transcript identifiers a memory names, and the pre-migration fallback that derives them from the commit tree.
- Why a turn-less usage carrier is written in the first place, and what a detach subtracts using it — owned by the commit-pipeline token-attribution and conversation-detach topics. This topic only hides the carrier from display.
- How a conversation's *title* is resolved, and each surface's own fallback ladder over the archived, live and derived answers.
- Row rendering: badges, tooltips, count chips, per-row actions, what a row click opens — owned by the two consuming surfaces' own topics.
- Why a memory has no conversations at all, and the sentence an empty list prints — owned by the transcript-repair topic.

## Data Contracts

### Conversation identity

`<producer>:<sessionId>`. A slice that records no producer defaults to the historical one (Claude) — the same back-compatibility default the transcript reader applies, the same one a source label falls back to, and the same one a detach matches on, so one session keys identically everywhere.

### Input

An ordered sequence of `(key, stored transcript)` pairs, each transcript carrying a list of stored sessions. The key is the identifier of the transcript the slice came from — a transcript identifier on current data, and a commit hash on pre-migration data, where the two are the same string.

**The membership is not exactly "the transcripts the memory names", and each consumer departs from that in a different direction.** The dashboard deliberately **keeps** a linked transcript the memory's own list does not name, appending it behind the named ones — a link the store holds is still a real conversation. The editor **intersects** the memory's identifiers with the transcripts actually present, so one whose stored file is gone is silently omitted rather than yielding an empty slice.

**Input order is the contract, not an incidental detail.** The emitted row order is the order the caller supplied, and the caller's order also decides which slice's session record represents the conversation. Both consumers therefore order their input by the memory's own transcript list rather than by whatever their storage returns — one of them has to sort its query rows explicitly, because the link table it reads is a set with no stored position and its rows arrive ordered by an opaque identifier (which is also why its unnamed extras keep their query position behind the named ones rather than being interleaved).

### The grouped row

| Field | Contract |
| --- | --- |
| session | The **first-seen** slice's stored session record — the source of the row's producer, session identifier and archived title. |
| owning key | The **first-seen** transcript key the conversation appeared under. |
| entries | Every slice's turns, chronologically reordered and flattened into one list. |

### The result

Two halves:

- An ordered list of identity keys, in first-seen order.
- A map from key to grouped row.

**Every key in the list resolves in the map.** The list is re-filtered after the hiding rule is applied, so a caller may zip the two without guarding for a key that was just removed.

### Slice start time

The epoch milliseconds of the first turn in a slice that carries a parseable timestamp; undefined when no turn in the slice does. Turns with no timestamp, and turns whose timestamp does not parse, are skipped rather than treated as zero.

### The carrier predicate

A stored session is hidden when **both** hold: its merged turn list is empty **and** its session record carries a recorded per-segment usage share.

The usage half is load-bearing. "No turns at all" is a different case: a legacy or malformed stored session can omit its turn list entirely, and those are real conversations that stay listed with a turn count of zero. Only a carrier is identifiable by the conjunction.

## Behaviors (execution order)

### 1. Collect slices per identity

Walk the transcripts in the order given, and each transcript's sessions in the order stored. For each session:

- Compute its identity key.
- Take its turn list as one **slice**, treating an absent turn list as an empty slice so the flatten below can never yield an undefined turn.
- On first sight of the key: record it in the order list, and record the session record and the transcript key as the conversation's representative and owning key.
- On a repeat: append the slice only. The representative record and the owning key do not move.

Slices are collected separately rather than appended into one growing list, because a consolidated memory's transcript set is not in time order and appending as they arrive would interleave one conversation's turns wrongly.

### 2. Reorder each conversation's slices chronologically, then flatten

For each key in first-seen order, sort that conversation's slices by their start time and concatenate them.

The comparator returns **equal whenever either side's start time is undefined**. That makes it an *inconsistent* comparator rather than a total order, so the resulting arrangement is implementation-defined — and "the sort is stable" is not a valid justification, because stability only governs elements a comparator reports equal consistently. Measured on a four-slice input: an undatable slice sitting in the middle came out **last**, and the three datable slices around it came out in an order that was not their time order.

What does hold is the narrow property: an undatable slice **does not jump to the front**. That is what the strict alternative ("undefined sorts last") was rejected for, and it is all the shape guarantees.

Where every slice is datable — the normal case, and the one the comparator is consistent on — the reordering is sound because of a property of how slices are produced rather than of the sort: each slice is internally time-ordered, and one session's slices occupy disjoint time ranges (the read cursor consumes turns in order), so ordering slices by their first known timestamp reconstructs the true conversation order. It is the presence of an undatable slice that costs the guarantee, for the whole set rather than only for that slice.

### 3. Apply the carrier predicate to the merged result

Test the **merged** turn list, not each slice. A conversation that is turn-less in one commit's transcript and real in another must still appear, and testing per slice would have dropped it at the first one.

The record that survives into the test is the first-seen slice's — see Notable Behavior for what that means when only a later slice recorded usage.

### 4. Re-filter the order list

Drop from the ordered key list every key the predicate removed, so the list and the map describe the same population.

## State Transitions

Following one conversation as a memory grows through an amend or squash chain:

| From | Trigger | To |
| --- | --- | --- |
| Not present | First transcript names the session | One row: first-seen record, first-seen owning key, that slice's turns |
| One row | A later transcript names the same session | Still one row; the new slice is placed by its own start time and the owning key does not move |
| One row | Every slice is turn-less **and** the first-seen record carries a usage share | Hidden — absent from both the map and the order list |
| Hidden | A later transcript carries the session's real turns | Visible again, with the merged turns; still keyed to the first-seen owning key |

## Notable Behavior

- **The carrier predicate reads the first-seen slice's usage share, not any slice's.** The conversation is represented by the record the walk met first, so a share recorded only on a *later* slice never enters the test. A conversation whose merged turns are empty and whose first-seen slice recorded no share is therefore kept as a real conversation even though a later slice marks it as a carrier. No document states this; it follows from which record represents the row. (Surprising.)
- **A turn-less session with no recorded usage is deliberately listed, with a turn count of zero.** That is what keeps legacy and malformed stored data visible as the real conversations they are, and it is the whole reason the predicate is a conjunction rather than an emptiness test. (Surprising; intentional.)
- **An absent turn list and an empty turn list are treated identically as input**, but they are *not* interchangeable for the predicate — what separates the two outcomes is the usage share beside them, never the shape of the list. (Notable.)
- **The comparator is not a total order, and the guarantee is narrower than "an undatable slice holds its place".** Returning equal when either side is undefined makes it inconsistent, so from four slices upward the arrangement is implementation-defined: measured, an undatable slice in the middle of four came out last, and the datable slices around it came out unsorted. Only "it does not jump to the front" survives. The intent is real — a strict "undefined sorts last" rule would have reordered legacy data that nothing else in the product reorders — but the rule's own documentation over-claims the reach in the same way this entry used to. (Surprising; the intent is deliberate, the reach is not.)
- **Row order belongs to the caller, and getting it wrong is invisible.** The rule emits first-seen order over whatever sequence it is handed, so two surfaces feeding it the same memory in different orders list the same conversations differently — which is exactly what happened before both were ordered by the memory's own transcript list. A slice order that differs also silently changes which record titles the conversation and which owning key the row carries. (Notable.)
- **The two halves of the result are kept in step on purpose.** The order list is filtered after the hiding rule rather than before, so a caller that zips them cannot hit a key the predicate just removed. (Notable.)
- **The hiding rule is a display rule only.** A detach reads a memory's stored sessions directly and unfiltered, so a hidden carrier record stays subtractable — hiding it from the list must not make it unreachable to the correction it exists for. (Notable.)
- **The rule is product-owned, and its whole reason for existing is that it was not.** It lived in the editor's memory panel as presentation. It is now a product rule both consumers call, so "how many conversations does this memory have" has one answer wherever it is asked. (Notable.)
- **Two further sites in the editor host still restate parts of the rule instead of calling it, and one of them disagrees with it.** The sidebar's memory-evidence rows re-implement the collect-merge-filter sequence locally, sharing only the slice-start-time helper. The panel's transcript-statistics counter restates the identity key and the carrier predicate to avoid a second grouping pass — with the deliberate refinement that a carrier-shaped slice does not mark its conversation as seen, so a later slice carrying the real turns still counts it — but it reads a slice's turn list **unguarded** when adding to its running total, two lines before guarding that same field in the predicate. So on the absent-turn-list case the predicate exists for, it throws, the caller swallows the rejection, and the statistics line silently never arrives. Nothing checks either site against the shared rule. (Defect.)
- **The identity-key helper has no external production caller.** Every restating site — including the one in the dashboard that has to key a lookup the same way — hand-spells the `<producer>:<sessionId>` string instead. So the identity contract has no compile-time coupling anywhere, which is the real force behind the two drift entries above and behind the three-places entry below. (Notable; unreachable as a shared entry point.)
- **The default producer appears in three independent places for one reason.** The identity key, the reader's back-compatibility, and the detach match key all default a producer-less stored session to the historical producer; a disagreement among them would split one conversation into two rows, or make a detach miss the row the user clicked. (Notable.)

## Shared Behavior

- **Stored transcripts and stored sessions** — the on-disk shape this rule consumes, including the forward-only fields (archived title, per-segment usage share, per-model split, tool tallies) that older memories simply do not carry. Owned by the storage and type-contract topics.
- **Which transcripts a memory names** — the explicit transcript list, and the pre-migration fallback that walks the commit tree. It is what both consumers order their input by.
- **Commit-pipeline conversation token attribution** — why a turn-less usage carrier is persisted at all, and the two independently-gated fields (the per-segment share this predicate reads, and the per-model split it does not) whose split means a record could in principle carry one without the other.
- **Conversation detach** — the unfiltered read of the same stored sessions, and the producer-and-identifier pair it matches on, which is this rule's identity key.
- **Session title resolution** — the ladder each consumer runs over the representative record's archived title, its live session row, and the merged turns' first user message.
- **The editor's memory panel and the dashboard's memory detail** — the two consumers. Each owns its own rows, count chips, per-row actions and empty state; both inherit the membership, merge order and turn counts from here.
- **Transcript repair and the empty-conversation verdict** — what an empty result means and which sentence a surface prints for it. This rule decides whether the list is empty; that one decides what the emptiness says.
