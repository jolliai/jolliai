# 13. Squash Consolidation Summary

## Topic Statement
Produce a single summary for a new commit that resulted from squashing N source commits, by consolidating the source commits' already-generated topic lists, recaps, ticket ids, and metadata into one consolidated topic list and one consolidated recap, and by archiving onto that commit the working-area Context still active when the squash landed. The consolidation is driven by an LLM call when usable input exists; otherwise (or on repeated LLM failure) it falls back to a mechanical concatenation that preserves all source content.

## Scope
**In scope:**
- Inputs: the new squash commit's metadata and a list of N source-commit summaries.
- The expansion step that converts each source summary (which itself may be a v4 root, a v3 squash root with children, or a v3 amend root) into a flat list of per-source-commit consolidation inputs.
- The outer-ticket-id hint extraction from the squash commit message.
- The single LLM call (and its single-shot strict-retry path on format failure).
- The mechanical fallback when the LLM call returns no usable content, fails, or repeatedly produces a format-incompliant response.
- The post-call ticket-id resolution priority chain.
- The atomic write of the consolidated root summary plus stripped-children placeholders, including hoisted functional metadata fields, in a single ref-update.
- The two published-document identities hoisted newest-child-wins — the memory article and the commit-level skill article — and the four sources that feed the orphaned-identifier list they both contribute losers to.
- The invalidation of the cached AI relevance ranking at the head of the pipeline, and why it happens before the model call rather than after it.
- The single read of the persisted user-exclusion selection that every later step of this path shares.
- The archival of uncommitted skill usage onto the squash commit, its position **before** both the Context consumption and the merge, and the user-exclusion set it honors.
- The consumption of the **working-area Context** onto the squash commit itself — the plans, notes and external references the user activated during the session that ended in this squash, plus a second pass over skill usage: its position between the model call and the atomic write, the branch resolution it files under, and the empty AI soft-exclude set it is given.
- The union of those freshly-archived plan / note / reference pointers onto the consolidated root, and the archived-file identity that union is keyed by.
- Re-association of plans, notes and skill guards from the source commits to the new squash commit, including the collapsed-hash set the skill guard match needs — and why external references need no re-association at all.
- The two paths into this consolidation: a queue-driven squash entry, and a queue-driven squash-rebase entry — both served by one implementation, whichever host produced the squash.

**Out of scope (boundaries):**
- The per-commit summarization that produced the sources (covered by "Multi-Topic Commit Summary Generation").
- The recap regeneration that operates on a single already-existing summary (covered by "Recap Paragraph Generation").
- Generation of the squash commit message itself (a separate concern, performed before the consolidation queue entry runs).
- The plumbing that detects "this post-commit is a squash" and enqueues an entry — owned by the queue worker.
- The amend pipeline, which uses the same consolidation primitive but with a different "old + delta" source list and a three-tier short-circuit dispatch.
- The per-item AI relevance ranking. This path never issues one; it only invalidates whatever ranking was cached and then behaves as if none existed.
- The plan-progress evaluation. It runs on the plain-commit path only — this path consumes the working-area Context without evaluating any plan's progress against the squash.
- The mechanics of archiving one plan, note, external reference or skill (content snapshot, guard row, archive key), which this path invokes but does not define.

## Data Contracts

### Inputs
- `squashCommitMessage`: the new commit's message string.
- `ticketId` (optional): an outer ticket-id hint supplied by the caller. It is **not** run through the ticket whitelist and it short-circuits the whole resolution chain below, so whatever the caller passes is what gets persisted (see Notable Behavior).
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
- `ticketId`: the outer hint when present, unvalidated; otherwise the first source ticket id found while scanning sources oldest-first **that passes the ticket whitelist**, in its canonicalized form — a legacy non-conforming source value is skipped rather than winning by position; otherwise absent.

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
  - The most-recent-by-activity child's **memory-article** identifier and URL.
  - The most-recent-by-activity child's **commit-level skill-article** identifier and URL — the same rule applied a second time to a second document (see "Two documents, one rule" below).
  - The accumulated list of orphaned document identifiers, drawn from four sources and now covering two document families rather than one.
  - Plans, notes and external references carried up from any child, **unioned with** the ones this pipeline archived onto the squash commit itself.
  - Skill-usage references accumulated from every child together with the ones archived onto the squash commit.
  - The combined E2E test scenario list (when any child carried one).
- A computed diff-stats block describing the squash commit's own diff against its parent.
- A `children` array containing each source summary, each first passed through a "strip Hoist-managed fields" function so that the root remains the sole carrier of the Hoist family. That family is defined by the shared strip helper, not by this topic; as it stands today it covers consolidated topics, recap, plans, notes, external references, the memory-article identifier and URL, **the commit-level skill-article identifier and URL**, the orphaned-doc-id list, the unresolved-orphan-hash list, and E2E scenarios. Two fields a reader might expect are deliberately **not** in it: the ticket identifier (children keep their own) and skill references (see Notable Behavior).

### Two documents, one rule

The consolidated root hoists **two** published-document identities from its children, and both follow exactly the same rule — deliberately, so a reader does not have to learn a second one:

| | Memory article | Commit-level skill article |
| --- | --- | --- |
| What it publishes | the commit's memory | all of that commit's skill records, as one article |
| Candidate requires | an identifier **and** a URL on the node | an identifier **and** a URL on the node |
| Winner | latest by activity date | latest by activity date |
| Losers | appended to the orphaned-identifier list | appended to the orphaned-identifier list |
| Recursion | grandchildren compete, each carrying its own dates | grandchildren compete, each carrying its own dates |
| Stripped off the retained children | yes | yes |

Adopting a winner rather than minting fresh is the point in both cases: a squash root's content is not any child's content, but exactly one child's document can be **updated in place** instead of deleted and replaced. That is fewer round-trips and one fewer way to fail — cleanup is best-effort, so a mint-a-new-one policy leaves every stale article beside the new one until a failed delete is retried, rather than all-but-one beside the live one.

Two details of the recursion are load-bearing and identical on both:

- **A winner travels with its own dates.** A deeper round's winner re-enters the outer round wearing the dates that won it that round, not the parent node's. Re-stamping it with the parent's dates diverges twice over: a grandchild that won on a fresh generation stamp loses to a sibling it should beat, and a node that holds an article *and* has children produces two candidates with identical dates, where a stable sort silently prefers the shallower one.
- **A deeper round's losers are already orphaned by that round**, so only its winner competes further up; the outer round never re-reports them.

**A node carrying an identifier but no URL is not a candidate at all** — for either document. It is neither hoisted nor orphaned, so its article is left published with nothing referring to it. (Notable; the same shape on both documents.)

### What lands in the orphaned-identifier list

Four sources, concatenated in this order: the memory-article hoist's losers, the skill-article hoist's losers, every child's own already-pending queue, and the identifiers the skill-reference fold banked as superseded (the legacy per-(skill, commit) articles). The field is written only when the result is non-empty.

**The concatenation is not deduplicated on this path** — unlike the legacy-to-unified normalization, which builds the same union through a set. A duplicate therefore reaches the push-side cleanup twice; the cleanup is best-effort and idempotent-in-effect, so the cost is a redundant delete rather than a wrong one. (Notable; a real asymmetry between two callers of the same rule.)

The children are sorted by activity-date descending (newest child first) before being stripped and attached.

### Working-area Context lifecycle on this path
A squash commit touches the working-area Context in two independent ways, and both are required for the consolidated memory to be complete:

1. **Archival (before the write).** Anything still sitting in the working area — an active plan, an active note, a newly consulted external reference, unfrozen skill usage — is frozen onto the *new* squash commit hash exactly as it would be onto a plain commit, and the resulting pointers are handed to the write so the root carries them.
2. **Re-association (after the write).** The pointers the *source* commits already carried are re-anchored: the plan and note registry rows are pointed at the new commit hash, and each skill's guard row is migrated to it. External references have no registry row to re-anchor.

The first half was absent before: the pipeline only ever re-associated, so a plan, note or reference the user activated during the session that ended in the squash was never archived — its registry row stayed in the working area and the consolidated memory held no pointer to it. Both squash routes share the pipeline, so both were affected.

### One read of the user-exclusion selection
The persisted user-exclusion selection is read **once** for the whole path and that one value is shared by every step that needs it. Two reads would straddle an intervening parallel-ref write and could disagree, leaving the skill-archival half and the Context-consumption half honouring different exclusion sets.

## Behavior

### Pipeline entry
There is **one** implementation of this pipeline, invoked from two queue-driven paths:

1. A queue entry of type "squash" — produced by either a host "Squash" button (which writes a squash-pending marker and an optional host-source marker before resetting and committing) or a "merge --squash" workflow (which writes the standard squash-message file).
2. A queue entry of type "rebase-squash" — produced when the rewrite hook detects that the rebase todo list contained a squash or fixup operation.

Both host surfaces feed path 1 the same way: the Squash button writes the squash-pending marker **through the shared session-state layer** rather than writing the file itself, and the shared commit-message-preparation hook and queue worker then consume it. The JVM-hosted surface drives the git mutations (write-tree, reset, commit, force-push-with-lease) in process, but contributes no consolidation logic of its own.

All paths carry the new commit's identity and a list of source summaries. The handler loads each source summary by hash; missing sources are warned about but the pipeline continues with whichever sources exist (skipping entirely if zero sources resolve).

### Step 0 — Invalidate the cached AI relevance ranking
As the pipeline's first action — before source expansion, before the model call — the cached AI relevance ranking for this project is cleared: the per-item ranking list is emptied and the stored change fingerprint dropped. The user's hard-exclusion sets in the same store are left untouched.

A squash always moves the branch tip, so the fingerprint that ranking was keyed on no longer describes the working change and a *later* commit must not reuse its exclude decisions. Two properties of the placement are load-bearing:

- It happens **up front, before the model window**, not after. Clearing at the end would risk overwriting a ranking a concurrent host re-rank produced while this pipeline was inside its consolidation call.
- It is **best-effort**. A failure to clear is logged and swallowed; it must never abort consolidation.

### Step 1 — Expand sources
For each loaded old source summary, run the expansion described in Data Contracts to produce one or more per-source-commit inputs. Flatten across all old summaries into one list.

### Step 2 — Extract outer-ticket-id hint
Apply the shared product-ticket regex to the squash commit message; the first match (uppercased) becomes the outer ticket-id hint. When no match is found, the hint is absent.

### Step 3 — Decide whether the LLM is worth calling
- If the source list is empty, return null.
- If every source has zero topics and no recap, return null. (No content to consolidate; the caller will not even mechanically merge — there is nothing to merge.)

### Step 4 — Render the prompt and call the LLM
1. Render an oldest-first source-commits block. Each source produces a numbered block (`Commit i of N`) with the short hash, the date prefix, the message, the optional source ticket, the optional recap, and one sub-block per topic listing title, trigger, response, decisions, optional todo, optional category, optional importance, and optional files list. Missing fields drop entire lines (no placeholder strings — the prompt explicitly forbids "None" / "N/A" output).
2. Compute the ticket line shown to the model: outer hint (unvalidated) > the earliest source ticket id that passes the ticket whitelist, canonicalized > a literal "No ticket associated" string.
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
1. The outer hint passed into the pipeline. Taken as-is: it is **not** whitelist-checked, and its presence short-circuits both steps below.
2. The earliest source ticket id, scanning oldest-first, **that passes the ticket whitelist** — returned canonicalized (upper-cased project-key form). A source whose stored value does not conform is skipped, so the scan can reach a later, conforming source; if no source conforms the chain falls through to step 3.
3. The ticket id parsed out of the LLM response (top-level field) — itself already whitelist-validated at parse time, so it can only be a conforming value or absent.

Otherwise, the result has no ticket id.

The same guarded scan is used in all three places that need a ticket: the prompt's ticket line, this post-call resolution, and the mechanical no-model fallback. The three cannot disagree about which source wins.

### Step 7 — Build the consolidated payload
- On LLM success: take the LLM's parsed topics, parsed recap, the resolved ticket id, and the LLM-call metadata.
- On null return from the LLM pipeline: run the mechanical fallback. Its topics are the oldest-first concatenation; its recap is the blank-line-joined sequence of source recaps; its ticket id follows the same priority chain (with the LLM-extracted slot omitted because there was no LLM result).

Either way the payload has the same shape; the only difference is whether `llm` metadata is present.

### Step 7b — Archive uncommitted skill usage onto the squash commit

A squash lands new work, so any skill usage the working-area registry has not yet frozen onto a commit belongs on the squash commit exactly as it would on a plain commit. This step runs **before** the atomic write below, not after it, because the resulting references have to be hoisted onto the root that write produces — there is no second write to patch them in afterwards. Unlike plans and notes there is no separate "detect what is active" step: the archival step reads the registry itself.

1. Read the persisted user-exclusion selection for the project **once** — this is the only read of it on this path, and Step 7c below is given the same value. Take its skill set (absent means "nothing excluded").
2. Invoke the shared skill-archival step with the new squash commit hash, the branch taken from the first source summary, and that exclusion set. It returns two things: a list of skill references to place on the new root, and a list of raw working-file bytes to store.
3. If the byte list is non-empty, write it to the parallel ref under a message naming the count and the abbreviated squash hash.
4. Pass the returned references into the merge step below as an **additional** set, alongside the ones collected from the children — unioned with the skill references Step 7c produces.

The exclusions are applied **inside** the archival step, not as a filter on its result. The step both guards the working-area row and emits parallel-ref bytes, so post-filtering would leave an excluded skill archived on the ref while merely hiding it from the summary.

This step is deliberately ordered **before** Step 7c rather than after it: writing skill bytes to the parallel ref is an operation that can fail, and every such operation sitting between Step 7c and the atomic write widens the stranding window that Step 7c's placement exists to keep narrow.

### Step 7c — Consume the working-area Context for the squash commit

Freeze the working-area Context onto the new squash commit hash, using the exclusion selection already read in Step 7b:

1. **Resolve the branch to file under**, from three sources in order, degrading rather than failing:
   1. The branch captured when the queue entry was enqueued. Preferred, because the worker drains asynchronously and the branch tip may have moved since the commit.
   2. A live read of the current branch. Reachable by design — both enqueue paths deliberately omit the captured branch when their own read fails, and entries written by older versions never carried the field at all.
   3. The source summaries' own branch. Already in hand, performs no I/O, and therefore cannot fail.
2. **Associate the active plans, notes and external references** on that branch with the new commit hash, minus the user's hard exclusions, and with an **empty** AI soft-exclude set (see below). Each kind's content snapshot lands on the parallel ref and its working-area row becomes a guard (or, for references, is torn down); the step returns the resulting pointers.
3. **Archive skill usage again** — the consumption step covers skills too, so this is a second pass over the same registry. Its references are unioned with Step 7b's.
4. Hand the returned plan / note / reference pointers to the merge step as an additional set (Step 8).

Two constraints on this step are correctness requirements, not preferences:

- **Its position: immediately before the atomic write, and after the consolidation model call.** Once the step has returned, every item it consumed has a snapshot on the parallel ref and nothing yet refers to it — the summary that will is written afterwards. So every operation awaited between the step and that write is a window in which a failure leaves those snapshots permanently unreferenced, with no working-area state that would produce a pointer on a later commit: an external reference's registry row and local file are gone outright, a plan's or note's row survives only as a guard already stamped with this commit (which re-archives only if the user edits the file again), and a skill's row has had its claimed baseline advanced past the increment just archived. Running the step here leaves exactly one operation in that window: the write itself. Running it at the head of the pipeline would put the whole model window, the retry, and the skill archival inside it. This mirrors the amend full path, which also consumes only once its model call has returned. (The per-kind ordering *inside* the step is not uniform — see Notable Behavior — but the window above turns on the state the step leaves behind once complete, which is the same for all of them.)
- **The AI soft-exclude set it is given is empty.** This path issues no relevance model call at all — it consolidates existing topic structures rather than re-deriving them from a diff and a transcript — so there is no soft-exclude verdict to honour. The user's full selection is associated, minus only their hard exclusions. This is the same choice the amend short-circuit paths make.

Excluded items are skipped from association, never deleted: they keep no commit hash, their registry rows and backing files stay intact, and they remain available to be included on a later commit.

### Step 8 — Write the consolidated root atomically
1. Compute the squash commit's diff-stats by diffing it against its parent.
2. Hoist functional metadata from sources: most-recent-activity **memory-article** identity, most-recent-activity **commit-level skill-article** identity (same rule, second document — see Data Contracts), the four-source concatenation of orphaned identifiers, the combined E2E scenarios, and:
   - **Plans, notes and external references** — the pointers collected from the children **unioned with** the ones Step 7c just archived. The union is mandatory: the child-collection helpers can only see pointers the children already carry, so without it the snapshots Step 7c just wrote to the parallel ref would have no pointer from any summary at all. New pointers win on collision, because the new one is the one whose bytes were just written.
   - **The union is keyed by archived-FILE identity — the per-commit hash stamp included — not by logical item.** A squash root hoists from N children, and two children can legitimately hold the same logical item at different commits: consult an external ticket on the first commit, consult it again on the third, and the branch carries both snapshots as two separate files on the parallel ref. Nothing on this path renames or deletes a child's snapshot (re-association only re-anchors registry rows), so both files outlive the squash and both need a pointer. Keying by logical item would keep whichever child was visited last and strand the other's file. These are the same keys the child-collection helpers already deduplicate by, so the union is order-preserving and idempotent. (The in-place-rewrite path keys the same union the *other* way — see Notable Behavior.)
   - **Skill references** — the **accumulation** of every source's references together with the freshly-archived ones from *both* Step 7b and Step 7c, folded through the shared skill accumulation, which deduplicates by archive key before summing (see the summary-tree spec). That fold also decides which of two legacy per-record article identifiers survives and banks the displaced ones; **this is the one place those banked identifiers are drained** — into the same orphaned-identifier list the superseded memory articles use — and the marker is then removed from every persisted reference so a later squash cannot re-report identifiers that are already queued. Skills need no archived-identity union of their own, for a narrower reason than it might appear: the accumulation folds per skill and **sums** the counting fields, so no commit's contribution is dropped by a key choice. What it does not preserve is a pointer per archived record — the surviving row carries a single archive key (the one from whichever record the fold reached first), so a skill archived at several commits leaves the other commits' files on the parallel ref with nothing referring to them. That is the accumulation's own trade, described in the summary-tree spec, and it is materially different from a plan / note / reference, whose pointer is the item's only carrier in the memory.

   Each field is written only when its result is non-empty.
3. Strip the Hoist-managed fields from each source so that the children list contains only un-hoisted summary skeletons — the set enumerated in Data Contracts, which today is topics, recap, plans, notes, external references, memory-article id and URL, **commit-level skill-article id and URL**, orphaned-doc-ids, unresolved-orphan hashes, and E2E scenarios. Stripping is recursive into descendants. Stripping the skill-article pair is what keeps a *later* squash honest: the merge has already adopted one child's skill article and orphaned the rest, so an identifier left on a retained child would make that later squash re-report an article that is gone.
4. Build the new root with the consolidated payload, the hoisted metadata, the stripped children sorted newest-first.
5. Run an idempotency check: if the new commit hash is already an indexed root, skip the write.
6. Flatten the new root into index entries (each child's commit hash reclassified with the new root as its parent), merge with the existing index entries in a map, and assemble a new index document.
7. Issue a single atomic ref-update that writes the new root summary file, the updated index file, and any other related files as one commit on the parallel ref.

### Step 9 — Re-associate plans, notes and skill guards
All three kinds work the same way: every pointer recorded on any source is an **archive key** whose trailing short hash is split off to recover the registry key directly, and the row found there — its **guard row** — has its recorded commit hash moved to the new squash hash. A pointer that is not in archive-key form is skipped, as is a row that carries no content-hash guard or whose recorded hash fails the anchor test below. Plan and note migrations also refresh the row's updated-at timestamp; the skill migration does not.

The one genuine difference is the skill anchor test. Skill re-association is additionally passed the set of **every** commit hash in the subtree being folded away — roots included, computed by a recursive walk over the source summaries and their children before the loop starts. A skill guard matches when its recorded hash either starts with the archive key's own embedded short hash **or** prefix-matches (in either direction) one of those collapsed hashes. Plans and notes accept only the first of those two tests.

The collapsed-hash set is what makes a repeated squash work. A hoisted skill pointer keeps the archive key of the commit that *originally* archived it, while the guard has since been migrated by an earlier squash — so matching on the embedded hash alone worked once and then silently stopped, stranding the row on a commit that no longer existed, where nothing could ever archive it again.

Every skipped row (no guard, or no anchor match) is logged at debug level and nothing else happens to it. A migrated skill guard keeps its **archived-totals baseline**: it records how much of the row a commit already claimed, and rewriting commit metadata does not un-claim any of it — dropping it would make the row's whole history look uncommitted again and republish it onto the next commit. The content-hash anchor is likewise left untouched for all three kinds, so an uncommitted edit to the source file still revives the guard on a later commit.

This whole step runs **after** the archival of Steps 7b and 7c, and the order matters: if a revived guard row was re-archived by those steps, its recorded commit hash has already moved to the new squash hash, so no anchor test above matches it and it is left alone rather than migrated a second time. Same ordering rationale as the amend short-circuit path.

**External references are not re-associated, and need not be.** Committing a reference deletes its working-area entry outright, so there is no guard row left to re-anchor; a source commit's reference pointers reach the new root through child collection (Step 8) instead. That half of the reference lifecycle was already correct and is unchanged.

### LLM-call decision summary
The LLM is called in both the squash and squash-rebase paths whenever there is at least one source with non-empty topics or a non-empty recap, on every surface — all of them run this one pipeline. There is no scenario in which the squash path skips the LLM unconditionally — the README phrasing "the worker skips LLM for squash" is out of date relative to current behavior.

The mechanical fallback is reached on:
- Both LLM calls failing.
- The LLM producing a format-compliant but empty response.
- The strict retry also failing format checks or also producing nothing usable.
- The strict retry call itself failing.

In every case the writer ends up with a non-null consolidated payload (either LLM-derived or mechanical), so the root is never written without a topics array.

## State Transitions

### Pipeline-level
- Loaded → Ranking-invalidated: the pipeline's first action clears the cached AI relevance ranking and its change fingerprint (best-effort; a failure does not stop the transition). The user's hard exclusions survive. This precedes source expansion, the model call, and every state below.
- Loaded → Decided (no-content): zero sources, or all sources empty → return null; no write performed.
- Loaded → Decided (LLM): one LLM call (and possibly one strict retry) → success result, or null on failure.
- Decided (null) → Mechanical: caller layer runs the mechanical fallback to produce a consolidated payload.
- Consolidated → Skills archived: uncommitted skill rows are guarded at the new hash and their bytes stored on the parallel ref.
- Skills archived → Context consumed: the active plans, notes and external references on the resolved branch move out of the working area onto the new commit hash — each item's snapshot lands on the parallel ref and its working-area row becomes a guard stamped with the new hash, or, for an external reference, is removed once that snapshot is written — and skill archival runs a second time. Between this state and the next there is exactly one operation that can fail, which is what bounds the stranding window.
- Context consumed → Persisted: single atomic ref-update writes the new root, the stripped children, the updated index, and the hoisted metadata — including both the union of child-carried and freshly-archived plan / note / reference pointers, and the accumulated skill references from both archival passes.
- Persisted → Re-associated: the source commits' plan and note registry rows point at the new commit hash; their skill guard rows are migrated to it. A row already moved by the archival states above is matched by neither test and left alone.

### Working-area-item-level
For a single plan / note / reference / skill, this path is one of the transitions its own lifecycle defines, with the squash commit as the target hash:

- **Active in the working area** → **Archived onto the squash commit** (Step 7c/7b), when the user did not hard-exclude it.
- **Active in the working area** → **Active in the working area** (unchanged), when the user hard-excluded it. Not deleted, not archived; available again on the next commit.
- **Archived onto a source commit** → **Archived onto the squash commit** (Step 9), for plans, notes and skills. The snapshot file on the parallel ref is never renamed or removed by this, which is why two children's snapshots of the same logical item both survive and both keep a pointer.

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
- **Hoisting includes published-document identity from the most-recent-activity child only — and it now does this for TWO documents, not one.** The memory article and the commit-level skill article each pick the child whose activity date is latest and append every other candidate's identifier to the orphaned-identifier accumulator. The rules are identical on purpose (same candidate test, same comparison, same recursion, same strip off the retained children), so a reader who understands one understands both; a divergence between them would be a difference in which document gets updated in place versus deleted. (Surprising; intentional, and the parity is the design.)
- **A node with a published identifier but no URL competes for neither document.** It is not a candidate, so it is neither adopted nor orphaned, and its article stays published with nothing pointing at it. Requiring both is what keeps an adopted identifier usable — the push-side reuse gate recovers the owning backend from the URL — but the consequence is a silent leak for a half-written node. (Surprising; recorded as reality.)
- **The orphaned-identifier list on this path is a plain concatenation of four sources, not a set.** The legacy-to-unified normalization builds the same union through a set; this path does not, so a duplicate reaches the push-side cleanup twice. Best-effort cleanup makes that a redundant delete rather than a wrong one, but the two callers of one rule really do differ. (Notable.)
- **The skill fold's banked identifiers are drained here and nowhere else on this path.** Folding several commits' records of one skill into a single row supersedes the legacy per-record articles it can no longer point at; the fold banks them, this step moves them into the orphaned-identifier list, and the marker is stripped from the persisted references so a re-squash cannot re-report them. Leaving the marker in place would persist a live-looking field naming an article already queued for deletion. (Surprising; the strip is as load-bearing as the drain.)
- **Stripping is recursive.** Deeply nested squash trees (squash of squashes) have their Hoist-managed fields stripped at every depth, so only the new root carries authoritative copies. (Notable.)
- **Skills are hoisted but NOT stripped off the children.** The strip function has no skill arm, so a root and the child it wraps end up holding the same reference. That is the established squash shape rather than a leak: the accumulation deduplicates by archive key before summing, precisely so a later squash's recursive walk — which meets each hoisted reference from both ends — does not inflate the count by one generation per squash. (Surprising; intentional, and it depends entirely on that deduplication.)
- **Skill archival happens before the merge, not after it.** The consolidation writes the root once; there is no follow-up write that could attach references produced afterwards. So the freshly-archived references must exist before the merge runs and are handed to it as an extra input. (Notable; an ordering constraint, not a preference.)
- **A squash archives the working area, it does not merely re-anchor it.** The pipeline used to run re-association only, which migrates pointers the source commits already carried. It therefore could never record a plan, note or external reference the user activated during the session that ended in the squash: the item stayed in the working area and the consolidated memory held no pointer to it. Both squash routes share the pipeline, so the gap was identical on both. (Surprising; a real regression-closer.)
- **The Context consumption sits between the model call and the atomic write, and moving it is a correctness bug.** By the time the consumption returns, every item it consumed has a snapshot on the parallel ref and no summary refers to it yet. So every operation awaited between the consumption and the summary write is a window in which a failure — a write-lock timeout being the realistic one — leaves those snapshots permanently unreferenced, with nothing left in the working area that would archive the item again: an external reference's row and local file are already deleted, a plan's or note's row is a guard stamped with this commit, and a skill's claimed baseline has already advanced past the increment. Placing the consumption last narrows that window to the write itself; placing it at the head of the pipeline would put the model call, its retry, and the skill archival inside it. The in-place-rewrite full path makes the same choice for the same reason. (Surprising; an ordering constraint, not a preference.)
- **Only the external-reference half of the consumption is write-ahead; plans, notes and skills stamp the working-area row first.** A reference's snapshot is committed to the parallel ref and *then* its registry row and local file are removed, so a failed snapshot write costs nothing — the row is still active and is re-archived on the next commit. The other three invert that: the working-area row is stamped first (per item for plans, in one batched registry write for notes, and inside the archival step for skills) and only afterwards does the snapshot batch reach the ref. A failure in *that* gap is the opposite defect — the row reads as claimed by this commit while nothing was archived at all — not an unreferenced snapshot. Both defects are real; neither is the reason the step's *position* matters, which turns only on the state the step leaves behind once it has completed. (Surprising; the halves are not symmetric, and the write-ahead reasoning does not generalize across them.)
- **The consumption is given an EMPTY AI soft-exclude set, so the user's full selection is archived.** This path issues no relevance model call at all — it consolidates existing topic structures rather than re-deriving them from a diff and a transcript — so there is no soft-exclude verdict to honour and nothing is dropped for relevance. Only the user's own hard exclusions are subtracted. The in-place-rewrite short-circuit paths make the same choice. (Surprising; a reader expecting parity with the plain-commit path would expect a ranking to apply here.)
- **The cached AI relevance ranking is cleared at the head of the pipeline, before the model window — not at the end.** A squash always moves the branch tip, so the fingerprint that ranking was keyed on no longer describes the working change, and a later commit must not reuse its exclude decisions. Clearing at the end would risk overwriting a ranking a concurrent host re-rank produced while this pipeline sat inside its consolidation call. The clear is best-effort: a failure is logged and consolidation continues. (Surprising; the placement is about a concurrent writer, not about ordering within this path.)
- **The user-exclusion selection is read exactly once for the whole path, and that one value is shared.** The skill archival and the Context consumption are given the same read. Two reads would straddle an intervening parallel-ref write and could disagree, leaving the two halves of one commit's archival honouring different exclusion sets. (Surprising; a shared-read requirement, not an optimization.)
- **Branch resolution for the archival degrades through three tiers instead of failing.** The enqueue-captured branch is preferred (the worker drains asynchronously, so the tip may have moved since the commit); a live read is second; the source summaries' own branch is last, because it is already in hand and cannot fail. The third tier exists because *skipping* archival on a failed live read produced a **partial** memory rather than a smaller one: the skill archival on this path resolves its branch from those same source summaries and would have proceeded regardless, so the squash would have recorded skills but not plans, notes or references. A stale branch label costs at most a mis-filed archive; skipping cost the pointer entirely. Note the resulting asymmetry: the consolidated root's own branch field always comes from the first source summary, while the archival may file under the enqueue-captured branch. (Surprising; intentional, and the failure it avoids is a partial memory.)
- **The union of freshly-archived pointers onto the root is keyed by archived-FILE identity, while the in-place-rewrite path keys the same union by logical item.** Two children of a squash can legitimately hold the same logical item at different commits — consult an external ticket on the first commit, consult it again on the third — and the branch then carries both snapshots as two separate files. Nothing on this path renames or deletes a child's snapshot, so both files outlive the squash and both need a pointer; collapsing them by logical item would keep whichever child was visited last and strand the other's bytes. The in-place-rewrite path collapses the hash stamp deliberately, and that choice is made for the shape of *its pipeline* — exactly one prior summary on the old side, so an item re-archived under the rewrite's new hash lists once instead of twice. It is not a claim about the prior summary's own pointer list: when that prior summary is itself a consolidated root, its list can already carry two snapshots of one logical item, and the collapse keeps only one of them (the amend summary migration spec records that consequence). One merge, two key families, and picking the wrong one silently strands files. (Surprising; the single subtlest rule on this path.)
- **The skill references from BOTH archival passes are unioned, and the second pass is not always a no-op.** Because the Context consumption archives skills too, this path archives skills twice. The second pass normally yields nothing — once the first has advanced a row's archived baseline to its running total there is no increment left — but a skill entered for the *first* time between the two passes (the agent-stop hook writes the registry asynchronously) does yield a real increment. Being a different skill it gets its own archive key and its own path on the parallel ref, so dropping its pointer would strand those bytes *and* leave its row guarded, i.e. unable to ever re-archive — precisely the permanent silent stranding this consumption exists to prevent. A repeat of the *same* skill in that window is not this bug and needs no handling: both passes share the commit hash, so the archive key and the stored path are identical, the second write overwrites the first, and the first pass's pointer still resolves. The accumulation deduplicates such a repeat rather than summing it, so the window costs an undercount of the in-window increment, not bytes on the ref. (Surprising; the "normally a no-op" call is the one that must not be dropped.)
- **A user's skill exclusion is applied inside the archival step, never as a post-filter.** Archiving guards the working-area row *and* emits parallel-ref bytes, so filtering the returned references would leave an excluded skill's content on the ref while hiding it from the summary — the exclusion would be cosmetic. (Surprising; intentional, and the same rule the plain-commit path follows.)
- **Skill guard re-association needs the whole collapsed subtree, not just the source roots.** A hoisted skill reference keeps the archive key of the commit that first archived it, while the guard has already moved. Matching on the key's embedded hash alone therefore worked for the first squash and silently stopped for the second, stranding the row on a commit that no longer existed — where nothing could ever archive that skill again. Passing every hash in the folded-away subtree, roots included, is the fix. (Surprising; a real regression-closer.)
- **Old source summary files are never deleted.** The merge writes the new root and updates the index so that old hashes reclassify as children, but the per-hash summary file for each old hash remains in the parallel ref. A direct file read of an old hash continues to return its original (un-stripped) content. (Surprising; intentional.)
- **Atomicity is at the batch level.** The new root, the updated index, and any companion files land in a single commit on the parallel ref. There is no partial-write state visible to a reader. (Notable.)
- **No locking inside the consolidation primitive.** Concurrent writers race at the ref-update layer; one wins and the other's commit becomes unreachable. The queue worker serializes externally. (Notable.)
- **Format-compliance retry uses the same shared header as the per-commit retry.** The strict-retry template is the per-commit/squash-consolidate template prepended with a single shared correction header that embeds the truncated previous response. (Notable.)
- **Compliant-but-empty LLM response does NOT trigger a strict retry.** The LLM had its chance and produced nothing usable; retrying with the same input is unlikely to help. The mechanical fallback runs instead. (Surprising.)
- **Ticket-id priority chain reuses the earliest CONFORMING source value, not the first-encountered.** The fallback scans sources oldest-first for determinism regardless of caller order, and skips any source whose stored identifier fails the ticket whitelist — so a legacy bad value cannot win merely by being oldest, and a good value on a later source is reachable. (Notable.)
- **The outer ticket hint is the one remaining way a non-conforming identifier is written.** The hint is never whitelist-checked and short-circuits the entire guarded chain. On the squash path this is harmless: the hint is derived by scanning the squash commit message with the substring pattern, and anything that pattern yields would satisfy the whitelist anyway. The **amend** path is the ingress — it supplies the previous summary's *stored* ticket id as the outer hint, so if that stored value is a legacy non-conforming string (a plan slug, a hash, a placeholder), it wins the chain unexamined and is re-persisted verbatim onto the new amend root, once per amend, indefinitely. (Amend's short-circuit writers, which skip consolidation entirely, copy the stored identifier straight across for the same net effect.) The read-time guards then hide it at the two surfaces that re-validate, which is why the value survives without ever being seen. (Surprising; real behavior.)
- **All paths share one pipeline, on every surface.** A host-driven squash, a "merge --squash" via the standard squash-message file, and a `rebase --interactive` squash/fixup all converge on the same consolidation primitive; the user-visible result is identical no matter which host initiated it. The former JVM-based consolidation arm — and the whole set of parity gaps it carried (a flat source expansion, no outer-ticket-id hint, no note re-association, no strict retry, no orphaned-doc-id accumulation, and an LLM-less rebase-squash path) — is gone. There is nothing left to diverge. (Notable.)
- **A host Squash button is a producer, not an implementation.** The JVM-hosted Squash action still resets and re-commits in process, and it still writes the squash-pending marker and the host-source marker before doing so — but it writes both **through the shared session-state layer**, so the marker files have one writer. The commit-message-preparation hook and the queue worker then recognize the squash and run the pipeline above. (Notable.)

## Shared Behavior
- The per-source-commit topics, recaps, and ticket ids consumed by this consolidation are produced by the per-commit generator described in "Multi-Topic Commit Summary Generation".
- The recap content rules (forbidden subjects, forbidden connectives, paragraph balance) are shared with the per-commit and standalone-recap templates; see "Recap Paragraph Generation".
- The Hoist-stripping function used to clean children is the same one used by amend and 1:1 rebase migration.
- Persistence of the new root and its companion index entries is performed via the storage primitive described in "Orphan Branch Summary Storage".
- The summary tree shape (root + stripped children, the Hoist-managed field family enumerated in Data Contracts) and the skill accumulation this consolidation folds through — including why it accumulates rather than dedupes, why it dedupes by archive key first, and the inherit-never-overwrite / bank-the-displaced / drop-the-survivor rules whose banked output this path drains — are described in the summary tree structure spec.
- The commit-level skill article whose identity is hoisted here — what it contains, how it is titled, and the push that publishes it — is owned by **Jolli Space Push Article Assembly** (231). The push-side cleanup that drains the orphaned-identifier list, and the reuse gate that makes an identifier's minting URL load-bearing, are owned by the same spec and by **VS Code Push Orchestration** (236). The conversion of a previously-shipped model's per-record identifiers into the commit-level one — which is the reason a mixed-vintage squash tree can exist — is **Legacy Skill-Article Migration** (343).
- The skill-archival step invoked at Step 7b and again inside Step 7c, the working-area registry row it guards, and the "uncommitted delta" rule that decides how much of a row belongs on this commit are owned by spec 322 (with the working record itself owned by spec 319).
- The archival of a plan and of a note invoked at Step 7c — the content snapshot, the slug-and-hash archive key, and the guard row the working-area row becomes — are owned by spec 42 (plan archival on commit) and spec 43 (note archival on commit). Those specs also own the re-association operation Step 9 drives. For external references, the per-reference working file and the content hash used as the archive-time guard are owned by spec 179.
- The user-exclusion selection read once at Step 7b and the cached AI-relevance layer Step 0 clears are two layers of one persisted store, owned by spec 188. That store serializes its **writes** cross-process, which is what makes Step 0's clear safe against a concurrent host re-rank; reads take no lock, so two separate reads on this path could genuinely observe different contents.
- The relevance ranking that produces a soft-exclude set on the plain-commit path is owned by spec 258. This path never issues one, which is why Step 7c passes an empty set.
- The in-place-rewrite (amend) pipeline referenced throughout for its ordering and keying choices — the same Context consumption, the same association-before-re-association order, and the deliberately *different* union key — is owned by the amend summary migration spec.
