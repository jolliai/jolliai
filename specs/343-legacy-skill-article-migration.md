# 343. Legacy Skill-Article Migration

## Topic Statement

Convert the per-(skill, commit) article identifiers a previously-shipped model recorded on a memory's individual skill records into the single commit-level skill-article identifier the current model uses — adopting one of them as the commit's article so the next push updates it in place, and queueing every other one for deletion so no already-published article is left on the server with nothing pointing at it.

## Scope

**In scope:**

- When the conversion runs (immediately before a memory is pushed, on both push implementations) and how its result is persisted.
- The three per-record legacy fields it consumes and the rule that they are **deleted**, not blanked.
- Which of several legacy identifiers is adopted as the commit's article, and the ordering that decides it.
- What happens to the identifiers that are *not* adopted, including identifiers a fold had already banked as superseded but that nothing has drained yet.
- The already-migrated case, which is deliberately **not** a no-op.
- Idempotence, and the fact that it is achieved by stripping rather than by a version marker.
- The identity-return contract that lets callers detect "nothing was rewritten".

**Out of scope (boundaries):**

- The fold that banks a superseded identifier onto a skill record in the first place, and the merge rules that decide which identifier a folded row keeps — owned by the summary-tree spec.
- The commit-level skill-article identifier's own hoisting across a squash or an in-place rewrite — owned by the squash-consolidation and tree specs.
- The actual deletion of the queued identifiers, and every other aspect of assembling and pushing a skill article — owned by **Jolli Space Push Article Assembly**.
- The wire request that publishes or deletes a document — owned by **Summary Push to Jolli Space**.
- How a memory is stored or written back — owned by the storage specs.

## Data Contracts

### The two article models

| | Previously shipped | Current |
| --- | --- | --- |
| Articles per commit | one per skill the commit recorded | exactly one, covering all of them |
| Where the published id/URL live | on each individual **skill record** | on the **memory** itself |
| Field names | the uniform per-item document-id / document-URL names | the memory's own commit-level skill-article id / URL names |

### Fields this conversion reads and clears

Three per-skill-record fields, all legacy:

| Field | Meaning |
| --- | --- |
| legacy article id | The document this skill's own article was published as. |
| legacy article URL | The article URL that id was minted with. Rides with the id, because the id-reuse gate recovers the owning backend from the URL's origin. |
| banked superseded ids | Identifiers a fold discarded when it collapsed several commits' records into one row, recorded so they can still be deleted. |

And two fields on the memory:

| Field | Meaning |
| --- | --- |
| commit-level skill-article id / URL | The current model's answer to "which article covers this commit's skills?". |
| orphaned-document-id list | The shared cleanup queue a later push drains by deleting each id. It is the **only** thing the cleanup path ever reads, which is why an identifier that is not put here is unreachable forever. |

### Return contract

The conversion returns the memory **unchanged by identity** whenever there is nothing to migrate, so callers can use reference comparison to detect a rewrite.

## Behavior

### When it runs

Immediately at the start of pushing one memory, **before anything else reads that memory's skill records**, and never at load time: the conversion only matters for a memory that is about to be published, and its result is persisted by that same push's own write-back — there is no separate write. Doing it on every read would rewrite stored memories that may never be pushed at all.

Both push implementations run it at that point, and both do so on the *original* memory before any other step sees it.

### Steps, in execution order

1. **No skill records** (field absent or empty) → return unchanged.
2. **Collect two sets:**
   - the records carrying a numeric legacy article id (call these *published*), and
   - every record's banked superseded ids, flattened.

   **The banked set is read here, before every early return below.** Those identifiers leak in exactly the same way a live legacy id does, and — like the live id — nothing but this conversion can see them: the cleanup path reads only the memory's orphaned-id list.
3. **Nothing to reclaim** (no published ids and no banked ids):
   - If any record still carries a legacy article *URL*, return a copy with the three legacy fields stripped from every record. There is no article to reclaim, but leaving the field would make the record's shape ambiguous on the next pass.
   - Otherwise return unchanged.
4. **Already migrated** — the memory already carries a commit-level skill-article id. **Do not adopt**: re-pointing a live aggregate article at an old per-skill one would abandon the article the commit is actually published as. But this is deliberately *not* a no-op:
   - Append every published record's legacy id and every banked id to the memory's orphaned-id list, then deduplicate the whole list.
   - Strip the legacy fields from every record.
   - The orphaned-id list is written only when the result is non-empty.

   This case is reachable through a mixed-vintage fold tree: the commit-level id can be hoisted onto a consolidated root from one source while the per-record fold keeps another, older-vintage source's per-record legacy id on the surviving row. That kept id is by construction in **no** banked set (the fold banks only the identifier it discards), so returning unchanged here would strand its article permanently.
5. **Nothing to adopt, but banked ids exist** — strip the legacy fields from every record and set the orphaned-id list to the deduplicated union of the existing list and the banked ids.
6. **Adopt.** Order the published records **newest first** by their last-used stamp (compared as a string), breaking ties **ascending on archive key** so the choice is deterministic across runs. Then:
   - The first record's legacy id becomes the memory's commit-level skill-article id. Its legacy article URL is carried across too, when it has one — adopting an id without its minting URL would leave the id unusable rather than merely untagged, because the reuse gate decides which backend owns an id from that URL's origin.
   - Every *other* published record's id, plus every banked id, is appended to the orphaned-id list and the result deduplicated (written only when non-empty).
   - The legacy fields are stripped from every record.

   The next push therefore **updates** the adopted article — retitling and rewriting it into the commit-level aggregate — while the rest are deleted by the ordinary cleanup pass. N per-skill articles become one aggregate in a single push, with no leak and no separate migration pass.

### Stripping

The three legacy per-record fields are **removed as keys**, never set to a null-like value: records are serialized as JSON, where a null reads back as a field that exists, and a record that still looked published would be re-adopted on the next pass and undo the migration. A record carrying none of the three fields is returned unchanged by identity.

### Idempotence

There is no version marker and no migrated flag. Idempotence falls out of the strip: because every record the conversion touches loses all three fields, a second call finds no published ids, no banked ids and no legacy URLs, so it takes the nothing-to-reclaim branch and returns by identity.

### Direction

The conversion is **one-way**. Nothing converts a commit-level identifier back into per-record ones.

## State Transitions

For one memory:

| From | Condition | To |
| --- | --- | --- |
| No skill records | — | unchanged |
| Records with no legacy ids, no banked ids, no legacy URLs | — | unchanged |
| Records with a legacy URL only | — | records stripped; nothing queued |
| Commit-level id already present | any legacy or banked ids remain | records stripped; every remaining id queued for deletion |
| No commit-level id, banked ids only | — | records stripped; banked ids queued |
| No commit-level id, published ids present | — | newest published id adopted as the commit's article (with its URL); all other published ids + all banked ids queued; records stripped |

## Notable Behavior

- **The banked-superseded set is read before the early returns, not after.** It is a leak of exactly the same kind as a live legacy id, and it is reachable from nowhere else — so an early return that skipped it would strand articles silently. (Surprising; safety-relevant.)
- **"Already migrated" is not "do nothing".** A mixed-vintage fold tree can leave a per-record legacy id on a memory that already has a commit-level id, and that id is one the fold *kept*, so it is in no banked set either. Skipping only the adopt step — and reclaiming the rest — is what stops it being stranded forever. (Surprising; this is the case the obvious implementation gets wrong.)
- **Idempotence is achieved by stripping, not by a marker.** There is no "migrated" flag; a second pass simply finds nothing. That also means the strip must delete the keys rather than blank them, or a re-read would resurrect the pre-migration shape. (Surprising; the two rules depend on each other.)
- **A record carrying only a legacy URL still forces a rewrite.** Nothing is reclaimed — there is no id — but the field is removed anyway so the record's shape is unambiguous next time. (Notable.)
- **The adopted article is the most recently used one, tie-broken deterministically.** Same "most recent activity wins" rule the fold paths use to pick a survivor, so a reader does not have to learn a second rule. (Notable.)
- **The logged counts are computed from the pre-deduplication concatenation, so they can overstate.** In the already-migrated case the line reports the new list's length minus the old list's length before duplicates are removed; in the adopt case it reports the *whole* concatenated list's length as the number orphaned, including identifiers that were already queued before this call. The persisted list is deduplicated either way — only the log numbers are loose. (Bug; recorded as reality.)
- **Adoption carries the URL with the id, and dropping it would be worse than dropping both.** The reuse gate recovers an id's owning backend from the URL it was minted with; an id with no URL is treated as env-agnostic and reused unconditionally, so an id adopted without its URL could be sent as an update target to a backend that never minted it. (Surprising; safety-relevant.)
- **This runs on the push path, so a memory that is never pushed is never migrated.** Its records keep the legacy fields indefinitely, and the conversion happens the first time — if ever — that memory is published. (Notable.)

## Shared Behavior

- The commit-level skill article itself — what it contains, how it is titled, and the push that publishes it — is defined by **Jolli Space Push Article Assembly**.
- The orphaned-document-id list this conversion writes into is drained (best-effort, failures retried on the next push) by **Jolli Space Push Article Assembly**.
- The document-id reuse gate that makes the minting URL load-bearing is defined by **Jolli Space Push Article Assembly**.
- The pairwise fold that banks a superseded identifier onto a skill record, and the archive-key deduplication that precedes it, are defined by **Summary Tree Structure**.
- The consolidation that can produce a mixed-vintage tree — a commit-level id hoisted from one source while another source's per-record id survives on a folded row — is defined by **Squash Consolidation Summary**.
