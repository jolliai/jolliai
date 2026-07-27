# 13. Squash Consolidation Summary

## Topic Statement
Produce a single summary for a new commit that resulted from squashing N source commits, by consolidating the source commits' already-generated topic lists, recaps, ticket ids, and metadata into one consolidated topic list and one consolidated recap. The consolidation is driven by an LLM call when usable input exists; otherwise (or on repeated LLM failure) it falls back to a mechanical concatenation that preserves all source content.

## Scope
**In scope:**
- Inputs: the new squash commit's metadata and a list of N source-commit summaries.
- The expansion step that converts each source summary (which itself may be a v4 root, a v3 squash root with children, or a v3 amend root) into a flat list of per-source-commit consolidation inputs.
- The outer-ticket-id hint extraction from the squash commit message.
- The single LLM call (and its single-shot strict-retry path on format failure).
- The mechanical fallback when the LLM call returns no usable content, fails, or repeatedly produces a format-incompliant response.
- The post-call ticket-id resolution priority chain.
- The atomic write of the consolidated root summary plus stripped-children placeholders, including hoisted functional metadata fields, in a single ref-update.
- Re-association of plans and notes from the source commits to the new squash commit.
- The two paths into this consolidation: a queue-driven squash entry, and a queue-driven squash-rebase entry — both served by one implementation, whichever host produced the squash.

**Out of scope (boundaries):**
- The per-commit summarization that produced the sources (covered by "Multi-Topic Commit Summary Generation").
- The recap regeneration that operates on a single already-existing summary (covered by "Recap Paragraph Generation").
- Generation of the squash commit message itself (a separate concern, performed before the consolidation queue entry runs).
- The plumbing that detects "this post-commit is a squash" and enqueues an entry — owned by the queue worker.
- The amend pipeline, which uses the same consolidation primitive but with a different "old + delta" source list and a three-tier short-circuit dispatch.

## Data Contracts

### Inputs
- `squashCommitMessage`: the new commit's message string.
- `ticketId` (optional): an outer ticket-id hint already extracted from the squash commit message; when absent the consolidation extracts it itself using the shared product-ticket regex.
- `sources`: an unordered list of per-source-commit consolidation inputs.
- `config`: LLM credentials and model selection.

Each per-source-commit consolidation input carries:
- `commitHash`, `commitDate`, `commitMessage`.
- Optional `ticketId` recorded for that source at its own summarize time.
- Optional `recap` paragraph from that source.
- A list of topic objects (the source's effective topics).

### Source-expansion contract
Sources are produced by walking each old source summary:
- If it is a unified-format (v4) root, produce one input from the root itself; the root's topics are authoritative even when empty (a recap-only commit is a legitimate source).
- If it is a legacy squash root, produce one input per stripped child, using each child's effective topics.
- If it is a legacy amend root, produce one input per child AND additionally append one input built from the root itself when the root carries its own delta topics or recap. (The legacy amend root contributed its own delta data alongside its child.)

The caller does not need to sort the expanded list; the consolidation pipeline sorts internally.

### Internal source ordering
Whenever the prompt or the post-call ticket-id resolution needs an ordering, sources are sorted oldest-first by commit date. The prompt's source block is rendered oldest-first and explicitly tells the model that "Commit 1 is the oldest, Commit N is the newest" — so rule references to "earlier" / "later" inside the prompt are anchored to the rendered ordering, not the model's own inference.

### Result (success)
- `topics`: an ordered list of consolidated topic objects (see the topic schema in "Multi-Topic Commit Summary Generation"; same shape).
- `recap` (optional): the consolidated recap paragraph(s).
- `ticketId` (optional): canonical-uppercase ticket string.
- `llm`: a metadata block with the model used, input/output token counts, total latency, and stop-reason. When the strict-retry branch fires, token counts and latency are summed across the two calls and the strict call's model identifier and stop-reason are taken.

### Result (no consolidation possible)
The pipeline returns null when:
- The source list is empty.
- All sources have empty topics AND empty recap (nothing to consolidate).
- Both LLM call attempts fail.

When null is returned, the pipeline calling layer falls back to the mechanical concatenation, so a final consolidated payload always reaches the writer.

### Mechanical fallback output
When the LLM cannot produce a result, the mechanical fallback produces:
- `topics`: source topics concatenated in oldest-first order (no merging, no de-duplication, no renumbering — what comes in goes out preserving multiplicity).
- `recap`: the joined sequence of source recaps separated by blank lines; absent if no source had one.
- `ticketId`: the outer hint when present; otherwise the first ticket id found while scanning sources oldest-first; otherwise absent.

The mechanical fallback is "complete but unconsolidated": duplicates and superseded items remain; no source content is dropped.

### Persisted root after consolidation
A single new-version root summary is written for the new squash commit hash, carrying:
- The new commit's identity (hash, message, author, date, branch from the first source).
- A schema version constant (currently 4).
- A generation timestamp.
- Commit-type metadata set to "squash" and a commit-source string indicating which surface (CLI vs. plugin) initiated the squash.
- The consolidated topics array and (when set) the consolidated recap.
- The consolidated ticket id (when set).
- The LLM metadata (when the topics came from an LLM call rather than the mechanical fallback).
- Functional metadata hoisted from the children:
  - The most-recent-by-activity child's documentation-article identifier and URL.
  - The accumulated list of orphaned documentation-article identifiers.
  - Plans and notes carried up from any child.
  - The combined E2E test scenario list (when any child carried one).
- A computed diff-stats block describing the squash commit's own diff against its parent.
- A `children` array containing each source summary, each first passed through a "strip Hoist-managed fields" function so that the root remains the sole carrier of consolidated topics, recap, ticket, plans, notes, doc URL, doc id, orphaned doc ids, and E2E scenarios.

The children are sorted by activity-date descending (newest child first) before being stripped and attached.

### Plans-and-notes re-association
After the root is written, every plan reference and every note reference recorded on any source is re-associated with the new squash commit hash in the local registries.

## Behavior

### Pipeline entry
There is **one** implementation of this pipeline, invoked from two queue-driven paths:

1. A queue entry of type "squash" — produced by either a host "Squash" button (which writes a squash-pending marker and an optional host-source marker before resetting and committing) or a "merge --squash" workflow (which writes the standard squash-message file).
2. A queue entry of type "rebase-squash" — produced when the rewrite hook detects that the rebase todo list contained a squash or fixup operation.

Both host surfaces feed path 1 the same way: the Squash button writes the squash-pending marker **through the shared session-state layer** rather than writing the file itself, and the shared commit-message-preparation hook and queue worker then consume it. The JVM-hosted surface drives the git mutations (write-tree, reset, commit, force-push-with-lease) in process, but contributes no consolidation logic of its own.

All paths carry the new commit's identity and a list of source summaries. The handler loads each source summary by hash; missing sources are warned about but the pipeline continues with whichever sources exist (skipping entirely if zero sources resolve).

### Step 1 — Expand sources
For each loaded old source summary, run the expansion described in Data Contracts to produce one or more per-source-commit inputs. Flatten across all old summaries into one list.

### Step 2 — Extract outer-ticket-id hint
Apply the shared product-ticket regex to the squash commit message; the first match (uppercased) becomes the outer ticket-id hint. When no match is found, the hint is absent.

### Step 3 — Decide whether the LLM is worth calling
- If the source list is empty, return null.
- If every source has zero topics and no recap, return null. (No content to consolidate; the caller will not even mechanically merge — there is nothing to merge.)

### Step 4 — Render the prompt and call the LLM
1. Render an oldest-first source-commits block. Each source produces a numbered block (`Commit i of N`) with the short hash, the date prefix, the message, the optional source ticket, the optional recap, and one sub-block per topic listing title, trigger, response, decisions, optional todo, optional category, optional importance, and optional files list. Missing fields drop entire lines (no placeholder strings — the prompt explicitly forbids "None" / "N/A" output).
2. Compute a ticket line: outer hint > earliest source's ticket id > a literal "No ticket associated" string.
3. Issue the call with action "squash-consolidate", maximum-output-tokens budget identical to the per-commit generator, the resolved model, and any direct or proxy credentials.
4. On a failure, retry the same call once. If the retry also fails, return null (caller will mechanical-fallback).

### Step 5 — Parse and decide
The response is parsed using the same delimited-plain-text parser as the per-commit generator (same top-level markers, same per-topic field markers, same code-fence stripping, same whole-text scan for top-level fields).

- If the parse yields at least one topic OR a non-empty recap, build the success result and return.
- If the parse is empty (no topics, no recap), inspect format compliance:
  - Compliant-but-empty (the model legitimately had nothing to say) — return null and let the caller fall back mechanically. Retrying would not help.
  - Non-compliant (markdown / prose first line) — issue a single strict-retry call with action "squash-consolidate-strict" and the same input parameters plus a truncated copy of the failed response. The strict-retry header is shared with the per-commit strict template.
- The strict retry's response is parsed identically. If it is now both compliant and yields topics-or-recap, accept it (combining token counts and latency). Otherwise return null.

### Step 6 — Resolve the final ticket id
Priority chain (first non-empty wins):
1. The outer hint passed into the pipeline (from the squash commit message).
2. The earliest source's ticket id (oldest-first scan).
3. The ticket id parsed out of the LLM response (top-level field).

Otherwise, the result has no ticket id.

### Step 7 — Build the consolidated payload
- On LLM success: take the LLM's parsed topics, parsed recap, the resolved ticket id, and the LLM-call metadata.
- On null return from the LLM pipeline: run the mechanical fallback. Its topics are the oldest-first concatenation; its recap is the blank-line-joined sequence of source recaps; its ticket id follows the same priority chain (with the LLM-extracted slot omitted because there was no LLM result).

Either way the payload has the same shape; the only difference is whether `llm` metadata is present.

### Step 8 — Write the consolidated root atomically
1. Compute the squash commit's diff-stats by diffing it against its parent.
2. Hoist functional metadata from sources: most-recent-activity documentation-article identity, the union of orphaned-doc ids, the union of plans and notes, the combined E2E scenarios.
3. Strip the eight Hoist-managed fields (doc id, doc URL, orphaned-doc-ids, plans, notes, E2E scenarios, topics, recap) from each source so that the children list contains only un-hoisted summary skeletons. Stripping is recursive into descendants.
4. Build the new root with the consolidated payload, the hoisted metadata, the stripped children sorted newest-first.
5. Run an idempotency check: if the new commit hash is already an indexed root, skip the write.
6. Flatten the new root into index entries (each child's commit hash reclassified with the new root as its parent), merge with the existing index entries in a map, and assemble a new index document.
7. Issue a single atomic ref-update that writes the new root summary file, the updated index file, and any other related files as one commit on the parallel ref.

### Step 9 — Re-associate plans and notes
For every plan slug recorded on any source's plans field, update the plans registry to point that slug at the new commit hash. For every note id recorded on any source's notes field, update the notes registry to point that note at the new commit hash.

### LLM-call decision summary
On the CLI/VS Code surface, the LLM is called in both the squash and squash-rebase paths whenever there is at least one source with non-empty topics or a non-empty recap. On the JVM (IntelliJ) surface, the LLM is called only when credentials are available and the path is the plugin-driven squash path; the rebase-squash path always falls back mechanically (credentials are not passed by the post-rewrite hook — see Notable Behavior). There is no scenario on the CLI/VS Code surface in which the squash path skips the LLM unconditionally — the README phrasing "the worker skips LLM for squash" is out of date relative to current behavior.

On the JVM surface, the LLM is additionally skipped (mechanical fallback always runs) when no credentials are configured, regardless of path.

The mechanical fallback is reached on:
- Both LLM calls failing.
- The LLM producing a format-compliant but empty response.
- The strict retry also failing format checks or also producing nothing usable.
- The strict retry call itself failing.
- (JVM only) No credentials available.
- (JVM only) Path is the rebase-squash path (credentials not forwarded by the post-rewrite hook).

In every case the writer ends up with a non-null consolidated payload (either LLM-derived or mechanical), so the root is never written without a topics array.

## State Transitions

### Pipeline-level
- Loaded → Decided (no-content): zero sources, or all sources empty → return null; no write performed.
- Loaded → Decided (LLM): one LLM call (and possibly one strict retry) → success result, or null on failure.
- Decided (null) → Mechanical: caller layer runs the mechanical fallback to produce a consolidated payload.
- Consolidated → Persisted: single atomic ref-update writes the new root, the stripped children, the updated index, and the hoisted metadata.
- Persisted → Re-associated: plan and note registries point at the new commit hash.

### Index-level
The new index entry tree replaces the existing entries: each previously-root source becomes a child entry of the new squash root. The old root summaries' files are NOT deleted from the parallel ref (the storage invariant), so a direct file read of an old hash continues to return that commit's original summary.

## Notable Behavior

- **The LLM is called for squash; the mechanical merge is a fallback, not the default.** Earlier docs claimed the worker skipped the LLM for squash. The worker actually runs the same LLM consolidation pipeline for both rebase-squash and plain squash; the mechanical merge runs only when the LLM cannot be useful or has failed. (Surprising vs. legacy docs.)
- **Source expansion preserves commit-level grouping for the LLM.** Flat aggregation of all topics into one undifferentiated pool would lose the chronological signal the prompt's "supersede / merge" rule depends on. Expansion produces one per-source-commit input even when expanding a v3 squash root that itself contains stripped children. (Notable.)
- **A v3 amend root contributes its delta as an additional source.** The amend root has a child plus its own root-level topics/recap (the delta from the amend). Both are surfaced as separate sources so neither layer is silently dropped. (Surprising; legacy compatibility.)
- **Topics are not "merged" by the consolidation primitive itself.** The LLM is asked to consolidate (de-duplicate, drop superseded, preserve independent topics, combine decisions); the mechanical fallback simply concatenates. Topic numbering is incidental to rendering; consolidation produces an ordered list. (Notable.)
- **Diff-stats on the root are recomputed from the squash commit itself.** The persisted root's diff-stats are obtained by diffing the squash commit against its parent, not by aggregating children's stats. This avoids over-counting files modified by multiple source commits. (Notable.)
- **Idempotency guard on already-indexed hash.** If the new squash hash is already present as an indexed root, the merge step short-circuits and writes nothing. (Notable.)
- **Children are sorted newest-first before stripping.** Display layers iterate children in arrival order; sorting at write time keeps the most recent source first. (Notable.)
- **Hoisting includes documentation-article identity from the most-recent-activity child only.** When several children carry their own doc id / URL, the one whose activity date is latest wins; the others' doc ids are appended to the orphaned-doc-ids accumulator for later cleanup. (Surprising; intentional.)
- **Stripping is recursive.** Deeply nested squash trees (squash of squashes) have their Hoist-managed fields stripped at every depth, so only the new root carries authoritative copies. (Notable.)
- **Old source summary files are never deleted.** The merge writes the new root and updates the index so that old hashes reclassify as children, but the per-hash summary file for each old hash remains in the parallel ref. A direct file read of an old hash continues to return its original (un-stripped) content. (Surprising; intentional.)
- **Atomicity is at the batch level.** The new root, the updated index, and any companion files land in a single commit on the parallel ref. There is no partial-write state visible to a reader. (Notable.)
- **No locking inside the consolidation primitive.** Concurrent writers race at the ref-update layer; one wins and the other's commit becomes unreachable. The queue worker serializes externally. (Notable.)
- **Format-compliance retry uses the same shared header as the per-commit retry.** The strict-retry template is the per-commit/squash-consolidate template prepended with a single shared correction header that embeds the truncated previous response. (Notable.)
- **Compliant-but-empty LLM response does NOT trigger a strict retry.** The LLM had its chance and produced nothing usable; retrying with the same input is unlikely to help. The mechanical fallback runs instead. (Surprising.)
- **Ticket-id priority chain reuses the earliest-source value, not the first-encountered.** The fallback scans sources oldest-first to ensure a deterministic outcome regardless of caller order. (Notable.)
- **All paths share one pipeline, on every surface.** A host-driven squash, a "merge --squash" via the standard squash-message file, and a `rebase --interactive` squash/fixup all converge on the same consolidation primitive; the user-visible result is identical no matter which host initiated it. The former JVM-based consolidation arm — and the whole set of parity gaps it carried (a flat source expansion, no outer-ticket-id hint, no note re-association, no strict retry, no orphaned-doc-id accumulation, and an LLM-less rebase-squash path) — is gone. There is nothing left to diverge. (Notable.)
- **A host Squash button is a producer, not an implementation.** The JVM-hosted Squash action still resets and re-commits in process, and it still writes the squash-pending marker and the host-source marker before doing so — but it writes both **through the shared session-state layer**, so the marker files have one writer. The commit-message-preparation hook and the queue worker then recognize the squash and run the pipeline above. (Notable.)

## Shared Behavior
- The per-source-commit topics, recaps, and ticket ids consumed by this consolidation are produced by the per-commit generator described in "Multi-Topic Commit Summary Generation".
- The recap content rules (forbidden subjects, forbidden connectives, paragraph balance) are shared with the per-commit and standalone-recap templates; see "Recap Paragraph Generation".
- The Hoist-stripping function used to clean children is the same one used by amend and 1:1 rebase migration.
- Persistence of the new root and its companion index entries is performed via the storage primitive described in "Orphan Branch Summary Storage".
- The summary tree shape (root + stripped children, the eight Hoist-managed fields) is described in the summary tree structure spec.
