# Amend Summary Migration

## Topic Statement

The pipeline that, when a commit is rewritten in place to produce a new commit hash, carries the existing summary forward to the new hash, recomputes only what the rewrite actually changed, and consolidates new conversational evidence with the prior narrative without losing accumulated context.

## Scope

**In scope:**
- Inputs identifying the prior commit hash and the new commit hash.
- The three-tier dispatch by which the pipeline either skips both the language-model calls, runs only the delta call, or runs both the delta and the consolidation call.
- Which fields are preserved verbatim from the prior summary, including both published-document identities.
- How published document identity survives the skill union, which mints no banked-superseded marker for a later drain.
- Which fields are regenerated against the rewritten commit.
- The construction of a new root with the prior summary attached as a stripped child.
- The fall-back when no prior summary exists.
- Idempotency on re-run of the same migration.
- Re-association of plans and notes with the new commit hash.

**Out of scope:**
- The mechanism by which an amend is detected and enqueued (covered by the operation queue topic) — including which producer writes an amend entry, which is what makes the executing-session input below unreachable.
- The transcript reading and per-session attribution rules (covered by the transcript pipeline topic). One of those rules now reaches this pipeline's inputs from outside it: the machine-global ownership ledger can contribute candidate sessions this checkout never ran, and can floor where such a session's transcript is first read from, so an amend's evidence window may be bounded by an owner edge even though this pipeline's own ownership backfill never runs. The ledger, its edges and that floor are covered by the **Claude session-ownership** topic.
- The squash and rebase variants (covered by their respective topics).
- The summary-tree node hoist invariant in detail (covered by the summary-tree topic).
- When the Amend action is offered to the user vs. hidden (gating by own-commits check, author check, shared-tip check, and fork-point resolution) — that is part of the VS Code AI commit surface, covered by the VS Code AI Commit From Checkbox Selection topic.

## Data Contracts

### Migration input

The pipeline receives:

- **prior commit hash** (required): the commit hash whose summary is to be carried forward.
- **new commit hash** (required): the commit hash produced by the rewrite.
- **operation source** (optional): which surface initiated the rewrite (a CLI client or an editor plugin); recorded on the new summary so downstream consumers know where the action originated.
- **enqueue timestamp** (required): used as a transcript time-cutoff for attributing new conversational entries to this rewrite.
- **executing-session id** (optional): the agent session whose process ran the rewrite, as recorded on the queue entry. It travels in the same metadata bundle as the operation source and is threaded on into transcript loading, where a present value would trigger a commit-time ownership backfill for that session before owners are resolved. **It is never populated in practice** — see "The executing-session input is unreachable on this path" under Notable Behavior — so the arm that consumes it is dead on every real amend, and the parameter documents a capability this pipeline does not have.

### Delta diff vs full diff

Two distinct diff scopes are computed:

- **Delta diff**: the textual difference between the prior commit and the new commit. Drives whether new content needs language-model attention and supplies the textual input when it does.
- **Full commit diff**: the standard "this commit vs. its parent" diff for the new commit. This is what gets persisted on the new summary as its own diff statistics, identical in semantics to the diff statistics carried by any other summary node.

### Preserved fields (carried forward unchanged)

Regardless of which dispatch tier runs, these fields on the new root are copied directly from the prior summary when present:

- Article-style metadata for **two** published documents, each a straight copy of the prior summary's: the memory article's identifier and URL, and the commit-level skill article's identifier and URL — the one document a commit's whole skill set publishes as. The second travels for exactly the reason the first does: an in-place rewrite is the same commit under a new hash, so neither article's content has changed and the next push must update both in place rather than mint siblings and strand the originals under a hash the branch no longer has.
- The accumulated list of orphaned article identifiers awaiting cleanup, **extended** with any identifier the skill reconciliation below displaced (see "Published identity across the skill union"). The extension must be spread after the copy of the prior summary's own fields, or that copy wins and the displaced identifiers are silently dropped.
- Plan references, note references, external-entity references, and skill references.
- End-to-end test guidance scenarios.

### Merged reference fields (old ∪ new, new wins)

The four reference kinds above are not copied blindly: the hoisted (prior) set is unioned with whatever the amend itself newly detected, keyed per kind, with the new entry winning a collision. Each merged field is written only when non-empty, and each must be listed explicitly on the new root — the hoist spread alone would silently keep the old value, and an omission would read as "the amend reverted this artifact".

The key each kind merges on differs, and one of them differs deliberately:

| Kind | Merge key |
| --- | --- |
| plan | the slug with its trailing archive-hash suffix stripped |
| note | the identifier with its trailing archive-hash suffix stripped |
| reference | `<source>:<nativeId>` |
| skill | `<source>:<skill>`, **verbatim — no suffix strip** |

Skills are the exception because they do not carry the archive hash in the identifier they are keyed on. A plan or note ref embeds it (`<slug>-<hash8>`), so the suffix has to be stripped to recover a base key; a skill ref keeps its hash in its separate archive key and leaves the skill id raw. Stripping anyway would silently truncate any skill id that happens to end in eight hex characters, folding two distinct skills into one row here while the exclusion audit below and the tree accumulation both kept them apart — three derivations of one key that have to agree.

All four keys therefore name the logical **item**, never the archived file the item was last snapshotted into. That is what lets an artifact re-archived under the rewrite's new hash list once instead of twice, and it is sound here only because the union has exactly **one** prior summary to draw its old side from. The consolidation that folds *many* prior summaries into a single commit performs the same union with the same new-wins rule over its plan, note and external-reference fields, but keys it on the **archived file** (archive-hash suffix retained): two of its sources can legitimately hold the same logical item snapshotted at different commits, nothing in that pipeline renames or deletes a source's snapshot, so both archived files outlive the fold and both need a summary referring to them. This topic's keys used there would keep whichever source was walked last and leave the other archived file stranded on the parallel ref with nothing referring to it — the failure class the two key families exist to keep apart. They are not interchangeable in either direction; the consolidated variant's key rule is stated by the summary-tree topic and the pipeline that supplies its caller-side refs by the squash-consolidation topic.

### Published identity across the skill union

Skills are the one kind whose old and new sides can both already be published, and this pipeline **unions** them rather than folding them. That matters because the fold is where published identity is normally protected: folding two records of one skill leaves a single row that can point at only one document, so the fold banks the displaced identifier on the surviving row for a later drain. A union mints no such marker, and nothing downstream drains one — so identity has to be reconciled here, by hand, and it is:

1. Before the union runs, the prior summary's skill references are indexed by the same `<source>:<skill>` key the union merges on, recording the published identifier and URL of each one that has them.
2. Every row that survives the union is then checked against that index:
   - **no prior entry** — the row is left exactly as it is;
   - **prior entry, and the surviving row carries no identifier of its own** — it adopts the prior identifier and URL, so the next push rewrites that same article (retitling it to the new hash) instead of creating a sibling beside it;
   - **both sides published, and to different articles** — the surviving row keeps its own identifier, because overwriting it would push this content at the older article, and the prior identifier is appended to the new root's orphaned-identifier queue rather than dropped.

A row that came through the union unopposed is its own prior entry, so it matches on identifier and nothing is queued.

So the union **preserves** the published identity the fold is careful about: every identifier either survives on the row that replaced it, or is queued for cleanup. What the union deliberately does not carry over is the losing row's *counting* payload — a skill reference is one commit's increment, and folding the old increment into the new row would have it counted a second time when a later consolidation walks the tree and meets the same reference from both ends. That is sound only because the losing reference survives verbatim on the retained child, which is where the tree walk finds it.

These per-item identifiers are the residue of an earlier model in which every skill on a commit published its own article; the commit-level article that replaced them travels separately, as a straight copy of the prior summary's own field (see Preserved fields). Both are handled because a stored summary can still carry either.

### Regenerated or recomposed fields

These fields on the new root are recomposed:

- The diff statistics field, always recomputed against the new commit's own parent.
- The commit metadata (commit hash, message, author, dates), all sourced from the rewritten commit, not from the prior one.
- The branch label, taken from the **branch name captured when the rewrite was enqueued**, falling back to the live current branch only for legacy queue entries that predate the captured field. A commit carries no branch of its own, so this value cannot come from the rewritten commit; using the captured branch (rather than reading the live branch at migration time) keeps the summary filed under the branch the rewrite actually landed on even if the user checked out a different branch — or a sibling worktree advanced — between enqueue and drain.
- The per-node generated-at timestamp, set to the migration's wall-clock time.
- The narrative fields (topics, recap, ticket identifier), which depend on which dispatch tier runs (see Behavior).
- The language-model call metadata, present only when the migration actually invoked a language model.

### Output shape

The new root is a unified-format summary node whose own children list is exactly the prior summary, hoist-stripped (its narrative and metadata fields are stripped from the embedded copy because the new root is now authoritative for them).

## Behavior

### Tier A: trivial-delta short-circuit (zero language-model calls)

Conditions:

- A prior summary exists.
- No new conversational entries fall within the migration's time window.
- The delta diff is small (its inserted-plus-deleted line count does not exceed an implementation-defined small threshold, intended to absorb cosmetic changes such as message-only amends, version bumps, formatter passes, signature re-application).

Action:

1. Resolve the prior summary's effective topics and recap (with legacy-format awareness so older nested formats still surrender their topics).
2. Build the new root with those topics, that recap, the prior ticket identifier, the preserved fields enumerated above, and the new commit's own metadata.
3. Persist the root with no transcript artifact (no new conversation occurred).
4. Re-associate the prior summary's plan references and note references with the new commit hash.

### Tier B: empty-delta short-circuit (one language-model call)

Conditions: a prior summary exists and Tier A did not apply, but the delta-summarization language-model call returned no topics and no recap (i.e., the rewrite altered text that the model judged unworthy of narrative).

Action: as in Tier A, except that the captured conversational transcript is persisted alongside the new summary because the model did read it. The narrative fields still come from the prior summary, not from the empty model output. Language-model call metadata is intentionally omitted because the topics and recap on this node were not produced by the call; it is stored on the persisted transcript context only.

### Tier C: full path (two language-model calls)

Conditions: a prior summary exists, Tier A did not apply, and the delta call returned non-empty narrative content.

Action:

1. The first language-model call summarizes the delta diff in light of the new conversational entries.
2. The result is fed, as one source, into a consolidation call together with the prior summary expanded into its consolidation-source representation. The outer ticket identifier hint is the prior ticket identifier, falling back to one extracted from the delta call.
3. On consolidation success, its topics, recap, and resolved ticket identifier populate the new root, along with that call's metadata.
4. On consolidation failure (transient call errors), a mechanical merge of the consolidation sources substitutes for the model output so the invariant "root carries narrative" never fails.
5. The new root attaches the prior summary as a stripped child and persists with the transcript artifact.
6. Plan and note references on the prior summary are re-associated with the new commit hash.

### Fresh-leaf fallback (no prior summary)

When no prior summary exists for the prior commit hash (rare: the original commit was never summarized):

- If the delta is trivial under the same threshold used for Tier A, the migration is skipped — there is nothing useful to record.
- Otherwise, the delta-call output is stored as a fresh leaf summary at the new commit hash, with the new commit's own full-diff statistics and the captured transcript artifact, but with no children. The fresh leaf is filed under the enqueue-captured branch (legacy-entry fallback to the live branch), and the plans, notes, and references currently active on **that** branch — minus any the user deselected in the sidebar — are associated with the new commit hash (the prior-summary tiers migrate references via re-association instead, since a fresh leaf has no prior summary to migrate from).

### AI-exclusion audit on the new root

An item cannot be both attached to a summary and listed on it as AI-excluded — that is a self-contradiction the display surfaces would render twice. So before the new root is emitted, the AI-excluded list is filtered against the set of base keys that are actually attached, computed per kind from the merged reference fields above. All four kinds are audited — plan, note, reference and **skill** — even though only references collide in practice (a re-referenced item committed earlier has no guard row, so it can re-enter the soft-exclude set while its old snapshot is still hoisted; plans and notes skip committed guards upstream). The skill set is built from the same `<source>:<skill>` key the merge uses, which is why the three derivations of that key have to agree.

### Persistence

In every tier the new root is written through the same summary-store entry point used by leaf commits, which atomically updates the index alongside the payload. Storing the new root never deletes the prior summary's payload file — the prior commit hash still resolves directly to its own original payload.

## State Transitions

For a single (prior hash, new hash) pair the migration is one-shot:

- **Not migrated** → **Migrated** on first successful run, regardless of which tier fired.
- **Migrated** → **Migrated** on re-run: the index entry for the new hash is already present and the migration short-circuits, leaving the existing root intact.

The prior summary's index entry transitions from a root to a descendant (its parent link gains a value pointing at the new root), inherited from the underlying summary-store upsert.

## Notable Behavior

### Idempotency on re-run

The pipeline checks whether the new commit hash already has an index entry before writing. When it does, the migration is treated as already performed and no payload is rewritten.

### Re-association of plan, note and skill references is unconditional

Every tier ends with a re-association step that walks the plan-reference list, the note-reference list and the skill-reference list on the prior summary, updating each entry in the corresponding registries to point at the new commit hash. Those registries are independent of the summary store — they live in local state files — so the re-association is what keeps them in sync with the rewrite. The skill arm re-anchors a guard row rather than an artifact row and is driven by the reference's archive key, alongside the set of every collapsed hash in the subtree (a single-element set here, plus its descendants); its match rule is stated in full by the squash-consolidation topic, which shares the step.

### The merge key is chosen for one prior summary, not for one snapshot per item

Logical-item keying is chosen for the shape of the *pipeline* — one prior summary on the old side — not for the shape of that prior summary's own reference fields. When the prior summary is itself a consolidated root, its plan/note/reference field can already carry two archived snapshots of one logical item, which is precisely what the consolidation's own archived-file keying preserves. This union then collapses the pair, keeping whichever of the two is listed last in the prior summary's array (a newly-detected ref for the same item still wins over both), and the other snapshot's archived file survives on the parallel ref with nothing referring to it. Rewriting a consolidated commit in place is a supported tree shape, so this is reachable rather than theoretical. (Notable; a direct consequence of the key choice recorded in Data Contracts.)

### Skill refs merge on the raw registry key, not through the archive-hash strip

Plans and notes carry the archive short hash inside the identifier they are keyed on, so their merge key is that identifier with the suffix stripped. A skill ref does not: its hash lives in a separate archive key and its skill id stays raw. Applying the same strip to it would truncate any id ending in eight hex characters and silently fold two distinct skills into one row at this one site — while the exclusion audit and the tree-level accumulation, which both derive the same key without stripping, kept them apart. The deliberate asymmetry is what keeps those three derivations in agreement.

### The union mints no banked marker, and loses no published identity

This is the one pipeline that merges skill references without the shared accumulation, so it is also the one that produces no banked-superseded marker for anyone to drain. That is not a gap: the two things the fold's marker exists to protect are handled directly here. The commit-level skill article is copied off the prior summary onto the new root, unconditionally, exactly like the memory article — an in-place rewrite publishes the same content under a new hash, so the next push must update those two articles rather than mint siblings. And the legacy per-item identifiers are reconciled through an index built from the prior summary before the union runs: an unpublished winner adopts the prior identifier, a winner with an identifier of its own keeps it and sends the prior one to the commit's cleanup queue, and a row with no prior counterpart is untouched. Nothing is dropped along either arm. (Notable; a deliberate divergence from the consolidation path, reached by a different mechanism to the same guarantee.)

### Skills are hoisted onto the new root and left on the child

The child copy attached to the new root is hoist-stripped, but the strip has no skill arm, so the root and the wrapped prior summary hold the same skill references. The tree accumulation deduplicates by archive key before summing, precisely so a later squash's recursive walk — which meets each hoisted reference from both ends — does not inflate the counts. The field is emitted on the root only when the merged result is non-empty.

### Conservative thresholds favor running the model

The Tier-A short-circuit is intentionally conservative: any captured conversation, or any delta beyond the small line threshold (whitespace included), forces at least Tier B. False positives in this guard would silently drop new amend information; false negatives only spend an extra model call.

### Mechanical fallback preserves the invariant

When the consolidation call fails at the transport level, the mechanical-merge fallback synthesizes a topics-and-recap result by concatenating source content. This guarantees the new root always carries a populated narrative regardless of model availability.

### Branch attribution uses the enqueue-time branch, not the live branch

Across every tier — the prompt-context gathering of active plans/notes/references and the branch label written on the fresh leaf — the branch is the one captured when the rewrite was enqueued, not the branch read live at migration time. Because the migration runs asynchronously under the worker drain, the live branch may have moved (rapid amend/squash/rebase sequences, or a sibling worktree on another branch) by the time the model call completes; reading it live would file the summary and its plan/note/reference associations under the wrong branch. A legacy queue entry with no captured branch is the only case that falls back to the live branch. (Notable; mirrors the worker's tail-cleanup and diff steps, which guard against the same drift.)

### The executing-session input is unreachable on this path

The pipeline accepts an executing-session id and forwards it into transcript loading, but nothing ever supplies one. Two facts close the gap from both ends: amend entries are produced **exclusively** by the post-rewrite hook, which does not stamp the field at all; and the one producer that does read the environment for it — the post-commit hook — returns early the moment its detector reports an amend, before it builds any entry. So every tier of this pipeline loads transcripts with no executing-session id, and the commit-time ownership backfill that a present value would drive never runs for a rewrite. Attribution here is served by the forward ledger alone: the owner edges the end-of-turn session-recording hook wrote on earlier turns, which still contribute candidate sessions and still floor where each is read from.

The reachable consequence follows from *when* the two mechanisms record. A session that edits one checkout's files and then amends in a different checkout inside a single turn commits before the session-recording hook that would have written the authoring edge has run, so at drain time nothing in the ledger names this checkout as an owner, no session is a candidate, and the rewrite gets no conversation attached. What happens next is the ordinary tier dispatch reading an empty evidence window: a trivial delta satisfies Tier A's "no new conversational entries" condition and carries the prior commit's topics and recap forward verbatim, while a larger delta still runs the delta call but with no conversation to interpret it against. Either way the narrative moves less than the work did, with nothing marking the omission. (Surprising; the parameter exists on this path and the arm behind it is dead, so a reader should not infer the capability from the signature.)

### The prior summary remains independently retrievable

The prior summary's payload file is never deleted by this pipeline. A subsequent lookup by the prior commit hash continues to return the original summary directly, bypassing the new root, because the summary store's read path checks for a direct payload before resolving aliases or descendants.

## Shared Behavior

- **Operation queue** — the pipeline runs as the handler for an enqueued amend operation; it does not detect the rewrite itself.
- **Summary-tree format** — the unified-format root, hoist-stripping rules for the embedded prior summary (and the absence of a skill arm in them), the skill accumulation and its archive-key deduplication, the legacy-aware "effective topics" resolver, and the consolidation-source expansion.
- **Skill working record and archival** — the registry rows behind the merged skill references, and the guard migration the re-association step performs for them, are owned by specs 319 and 322.
- **Summary index** — the index upsert that paired with the new payload write reclassifies the prior summary entry from root to descendant.
- **Plan registry** and **note registry** — the independent state files updated by the unconditional re-association step.
- **Transcript pipeline** — provides the conversational entries within the migration's time window and the persisted transcript artifact.
- **Claude session-ownership** — the machine-global owner-edge ledger that can contribute candidate sessions this checkout never ran, and the owner-derived floor on a candidate's first read; the commit-time backfill it also offers is the arm this pipeline never reaches.
- **Cross-process lock** — gates all writes to the summary store during the migration.
