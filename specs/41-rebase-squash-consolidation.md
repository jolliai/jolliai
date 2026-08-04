# Rebase-Squash Consolidation

## Topic Statement

The path that, when a rebase collapses N original commits into a single rewritten commit, consolidates the N source summaries into one new root keyed by the rewritten hash, sharing its language-model consolidation pipeline with the non-rebase squash path.

## Scope

**In scope:**
- Inputs identifying the N-to-one mapping from a list of prior commit hashes to one new commit hash.
- Loading of source summaries by hash, with graceful handling of missing source entries.
- Expansion of source summaries into per-commit consolidation sources, preserving chronological grouping.
- Extraction of the outer ticket-identifier hint from the rewritten commit's message.
- The language-model consolidation call and its mechanical fallback.
- The construction of a new root with all source summaries attached as stripped children.
- The invalidation of the cached relevance ranking at the head of the path.
- The archival of uncommitted skill usage onto the rewritten commit, ahead of that construction.
- The consumption of the working-area Context — activated plans, notes and external references — onto the rewritten commit, ahead of that construction, and the resolution of the branch its archive is filed under.
- The union of those freshly-archived plan, note and reference records with the ones hoisted from the children, and the identity they are keyed on.
- Re-association of plan references, note references and skill guard rows with the new commit hash.
- Aggregation of orphaned article identifiers and other hoisted child-level metadata.

**Out of scope:**
- The detection of the rewrite and its mappings (covered by the operation queue topic).
- The one-to-one variant produced by a plain rebase pick (covered by the rebase-pick migration topic).
- The squash-pending handoff used by non-rebase squashes (covered by the squash-pending handoff topic) — although the same consolidation pipeline runs here, the upstream evidence path differs.
- The squash-consolidation language-model call's prompt and rule structure (covered by the squash consolidation pipeline topic).
- The summary-tree hoist invariant in detail (covered by the summary-tree topic).

## Data Contracts

### Migration input

A single grouped record carrying:

- **prior commit hashes** (required, list of strings, length ≥ 2): every original commit that the rebase collapsed into the rewritten commit.
- **new commit hash** (required, string): the rewritten commit hash to which the consolidated summary will be attached.
- **operation source** (optional): which surface initiated the rebase (a CLI client or an editor plugin); recorded on the new root for provenance.
- **branch hint** (optional, string): the branch as read by the rewrite hook at the moment the operation was enqueued, shared by every group the same rebase produces. It is a hint, not a requirement: the hook omits the field when its own branch read fails or yields an empty label, and entries written by versions that predate the field carry it not at all. Consumed only when the working-area Context archive needs a destination branch (see Behavior); nothing else on this path depends on it.

The producer of this operation groups the rebase's old-to-new mapping pairs by new-hash; a group of size greater than one becomes this operation. A group of size one becomes the rebase-pick variant covered elsewhere.

### Source summaries and consolidation sources

Each prior commit hash is resolved to a stored summary. Each loaded summary is then expanded into one or more consolidation sources via the same expansion rule used by the non-rebase squash path:

- A unified-format summary expands to one source built from its own root.
- A legacy nested summary expands to one source per original child commit, plus, for legacy amend nodes, the root itself as an additional source so any delta-only narrative on the root is not lost.

Each consolidation source carries: commit hash, commit message, commit date, optional ticket identifier, topics, and optional recap.

### Outer ticket-identifier hint

A ticket identifier is extracted from the rewritten commit's own message via the standard message-pattern rule. When present, this hint outranks per-source ticket identifiers in the consolidation call's resolution chain. When absent, the inner resolution chain (earliest source's ticket identifier, then a model-extracted identifier) takes over.

### Output shape

The new root is a unified-format summary node. Its children list contains every prior summary, hoist-stripped (each child's narrative and metadata fields are stripped because the new root is now authoritative for them), sorted by display-date descending. The root carries:

- The consolidated topics, recap, and ticket identifier from the consolidation call (or its mechanical fallback).
- The language-model call metadata for the consolidation call (when the call ran successfully).
- A commit-type marker set to "squash".
- The operation-source marker when supplied.
- Aggregated end-to-end test guidance, article-style metadata, and orphaned-article identifiers, inherited from the children via the standard hoist rules.
- Plan references, note references and external-reference records: the set hoisted from the children **unioned with** the ones freshly archived onto the rewritten commit, keyed by archived-file identity (the per-commit hash stamp included, not stripped), with the freshly-archived entry winning a collision. Each field is written only when non-empty.
- Accumulated skill references — every child's, plus the ones freshly archived onto the rewritten commit — folded through the shared skill accumulation. Present only when non-empty.
- A diff-statistics field freshly computed against the new commit's own parent.

## Behavior

### Loading sources

1. For each prior commit hash, attempt to load the recorded summary.
2. Hashes whose summaries are missing are recorded in a warning but do not abort the operation; consolidation proceeds with whichever source summaries are available.
3. If no source summaries are recovered at all, the operation skips with a warning and writes nothing.

### Invalidating the cached relevance ranking

Before consolidation begins, the cached relevance ranking is discarded — both the per-item ranking and the change fingerprint it was computed against — while the user's own exclusion selection is left untouched. The ranking is consumed per commit, not sticky: a rebase-squash lands work, so a later commit over what looks like the same file set must not silently inherit this ranking's exclude decisions. The clear happens at the head of the path rather than after the model call so that a panel re-ranking running concurrently is not clobbered. It is best-effort: a failure is warned about and consolidation proceeds.

### Consolidation call

1. Each loaded source summary is expanded into per-commit consolidation sources using the expansion rule above. The flat result preserves per-commit grouping.
2. The outer ticket-identifier hint is extracted from the rewritten commit message.
3. The consolidation language-model call is invoked with the rewritten message, the optional outer ticket-identifier hint, and the list of consolidation sources.
4. On a successful call returning content, the result populates the new root's topics, recap, and resolved ticket identifier, and the call's metadata is recorded.
5. On a transport-level failure or a result lacking content, the mechanical fallback synthesizes the topics-and-recap result by concatenating source content; the call metadata is omitted because no successful call ran.

### Archiving uncommitted skill usage

Before the new root is built, the working-area skill registry's uncommitted rows are frozen onto the rewritten commit — a rebase-squash lands work exactly as a plain squash does. The branch this archive is filed under is the first source summary's own branch; the branch hint plays no part in it. The persisted user-exclusion selection's skill set is honored inside the archival step (never as a filter on its result, since archiving both guards the row and emits parallel-ref bytes). Any raw working-file bytes returned are stored on the parallel ref; the resulting references are handed to the root construction as an additional input, because there is no second write that could attach them afterwards.

The exclusion selection is read **once** here and reused for the Context consumption below, so both halves of the path honor the same set. A second read would straddle the parallel-ref write this step performs and could disagree with the first, leaving skills and Context filtered against different selections.

This step deliberately precedes the Context consumption below: it performs its own parallel-ref write, which can fail, and everything between the consumption and the atomic summary write is a window in which a failure strands an archived snapshot (see that section). Skill archival is not exposed the same way, though it is not unexposed either. It stamps its working-area row — including advancing the baseline that records how much of the row a commit has already claimed — *before* its bytes reach the parallel ref, and it never removes the row, so a failure of its own write strands nothing on the ref. What it does cost is the mirror-image defect: the increment whose bytes never landed has already been claimed, so no later commit archives it.

### Consuming the working-area Context

After the consolidation call and immediately before the atomic write, the Context the user has activated in the working area is consumed for the rewritten commit: every uncommitted plan, note and external reference is archived onto the rewritten commit hash and moved out of the working area (plan and note rows become guards stamped with the new hash; a reference's row and its local file are removed once its snapshot is on the parallel ref). This is what puts a plan, note or reference activated during the session that ended in the rebase-squash into the consolidated memory. Without it the path performed only the re-association described further below, which can migrate the source commits' already-archived records but can never archive something that was never archived — so such an item stayed in the working area with the consolidated memory holding no pointer to it.

Rules:

- The user's exclusion selection (the one read above) is applied **before** association, never as a filter on its result: association both stamps the working-area row and emits parallel-ref bytes, so a post-filter would leave an excluded item archived while merely hiding it from the memory. An excluded item is skipped, not deleted — it keeps no commit hash, keeps its row and backing file, and remains available to a later commit.
- No relevance soft-exclude set is supplied — the set is empty. Consolidation runs no relevance model call (it merges existing topic structures rather than re-deriving from a diff and a transcript), so there is nothing to soft-exclude, and the user's selection is associated in full minus their own exclusions.
- Skill usage is archived a **second** time as part of this consumption. It is normally inert, because the first archival already advanced each row's claimed baseline; but a skill first recorded between the two archivals yields a real second increment with its own archive identity and its own parallel-ref path. Both archivals' references are therefore folded together through the shared skill accumulation before being handed to the root construction, so those bytes cannot end up without a pointer. A repeat of the *same* skill is not a hazard: both archivals share the commit hash, so the second write lands on the same path and the first reference still points at it.
- The position is an ordering constraint, not a preference. Once the consumption has returned, every item it consumed has a snapshot on the parallel ref and no memory refers to it yet, so every step between the consumption and the atomic summary write is a window in which a failure (a write-lock timeout being the realistic one) leaves those snapshots permanently unreferenced with nothing in the working area that would archive the item again — a reference's row and local file are already removed, a plan's or note's row is a guard stamped with the rewritten hash, and a skill's claimed baseline has already moved past the increment. Consuming after the consolidation call reduces that window to the single atomic write. The ordering *within* the consumption is not uniform across the kinds and is not what the argument rests on (see Notable Behavior).

### The branch the Context archive is filed under

Resolution order, first available winning:

1. The branch hint carried on the queue entry. Preferred outright, and when present no live read is attempted at all: the worker drains asynchronously, so a live read can name whatever branch a later checkout — or a sibling worktree — left at the tip rather than the branch the rebase landed on.
2. A live read of the current branch. Reached whenever the hint is absent, which is a designed case rather than a corner: the rewrite hook omits the field when its own read fails, and entries written before the field existed never carry it.
3. The first source summary's own branch, used when the live read fails. It is already in hand and cannot fail, so resolution never aborts the path.

Step 3 exists because skipping archival on a failed live read produced a *partial* memory rather than a smaller one: the skill archival above resolves its branch from the source summaries and would have proceeded regardless, so the consolidated memory would have recorded skill usage but not plans, notes or references. A source summary's branch label can be stale relative to the tip — that is exactly why it is last — but a stale label costs at most a mis-filed archive, where skipping cost the pointer altogether.

The branch resolved here governs only where this archive is filed. Which items are detected as active does not depend on it (the working area is per-worktree), and neither does the consolidated root's own branch label, which is taken from the first source summary.

### Building the new root

1. Hoist child-level metadata up to the root: end-to-end test scenarios, plan references (deduped by slug, latest-update wins), note references (deduped by identifier, latest-update wins), external-reference records (deduped by archive identity, latest-referenced wins), skill references (**accumulated**, not deduped — deduplicated by archive key first, then summed per skill, together with the freshly-archived set from the steps above), the newest descendant's article-style metadata (with non-winners contributing to the orphaned-article-identifier list), and the existing orphaned-identifier list inherited from children.
2. Union the plan, note and external-reference sets just archived onto the rewritten commit over the hoisted sets, keyed by **archived-file identity** — the per-commit hash stamp kept, not stripped — with the newly-archived entry winning a collision. New-winning is required for integrity: the new entry is the one whose bytes were just written to the parallel ref, so preferring the old one would leave those bytes with no pointer. Keeping the hash stamp in the key is what distinguishes this from the amend paths, which strip it (see Notable Behavior).
3. Sort children by display-date descending (most recent activity first).
4. Hoist-strip each child copy attached to the new root.
5. Compute the new commit's full diff statistics against its parent; fall back to a zeroed record on diff failure.
6. Construct the new root with consolidated narrative, hoisted metadata, the diff-statistics field, the commit-type "squash" marker, and the operation-source marker when supplied.

### Persistence

The new payload and the updated index are written in one atomic batch. The atomic batch checks for an existing index entry at the new hash and short-circuits if one is already present. The prior summaries' payload files are never deleted; lookups by any prior commit hash continue to resolve directly to those originals.

### Re-association of plan, note and skill references

After the new root is persisted, every plan reference on every loaded source summary is walked and the corresponding plan-registry entry is updated to point at the new commit hash; the same is done for note references against the note-registry portion of local state. This is unconditional within the operation when source summaries are loaded.

This step runs **after** the archival steps above, not before them. A row that was revived and re-archived onto the rewritten commit has already had its guard stamped with the new hash by that archival; this pass matches a guard only when its recorded hash still begins with the short hash embedded in the source summary's own archived pointer, so it is simply a no-op for such a row rather than migrating it a second time. Both of that row's archived files — the child's and the rewritten commit's — survive on the parallel ref, and both keep a pointer thanks to the archived-file keying of the union above.

Skill references are walked in the same pass but re-anchor a **guard row** rather than an artifact row, and they are given one extra input: the set of every commit hash in the subtree being collapsed, roots included, computed by a recursive walk before the loop. A guard matches when its recorded hash starts with the archive key's own embedded short hash, or prefix-matches one of those collapsed hashes in either direction. The collapsed set is required because a hoisted skill reference keeps the archive key of the commit that originally archived it while its guard has already been migrated by an earlier rewrite; matching the embedded hash alone therefore worked once and then stranded the row on a commit that no longer exists. The guard's archived-totals baseline survives the migration untouched — it records what a commit already claimed, and rewriting commit metadata does not un-claim it.

## State Transitions

For a single (prior hashes, new hash) group:

- **Not consolidated** → **Consolidated** on first successful run.
- **Consolidated** → **Consolidated** on re-run: the new hash already has an index entry, so the atomic-batch short-circuit prevents a duplicate write.

Each prior summary's index entry transitions from a root to a descendant (its parent link gains a value pointing at the new root), inherited from the underlying summary-store upsert.

## Notable Behavior

### Shared pipeline with non-rebase squash

This path and the non-rebase squash path delegate to the same consolidation pipeline — including the relevance-ranking invalidation, the skill archival, the working-area Context consumption and the branch-resolution chain above, all of which the two routes reach identically. The user-visible result is identical regardless of whether the consolidation was triggered from an interactive rebase squash, a fixup, a plain squash merge, or a plugin-driven squash button. The differences are all upstream: how the source-hashes list is recovered (a stdin mapping for rebase, a state-file handoff for non-rebase), and which hook read the branch hint (the rewrite hook here, the post-commit hook there — each from its own read at enqueue time).

### The Context archive is filed by hint, not by a live read

The hint on the queue entry wins outright, and its presence suppresses the live read entirely. This is not merely an optimization: the worker drains asynchronously and the tip may have moved, so a live read is capable of naming a branch the rebase never touched. The live read exists only as the middle rung for entries that carry no hint.

### Branch resolution degrades, it never aborts

A failed live branch read costs at most a mis-filed archive, never the consolidated memory: the chain falls through to the first source summary's branch, which is already loaded and cannot fail. This matters because the two archival halves resolve their branch differently — skill archival always uses the source summaries' branch — so aborting on a failed read would have produced a memory carrying skill usage but no plans, notes or references, which is worse than one carrying all of them under a stale branch label.

### Squash unions references by archived file, amend by logical item

Both the rebase-squash root and the amend root union newly-archived references over the hoisted ones with the new entry winning, but they key that union differently, and the difference is load-bearing. An amend root wraps exactly one prior summary, and collapsing the per-commit hash stamp is chosen for that shape: a revived item re-archived under the new hash lists once instead of twice. That is a statement about the pipeline's shape, not about the prior summary's own record list — amending a consolidated commit is a supported shape, and such a prior root can already carry two archived records of one logical item, one of which the collapse drops (the amend summary migration topic records that consequence). A consolidated root hoists from many children, and two children can legitimately hold the same logical item archived at different commits — an external reference consulted on one commit and again on a later one leaves two separate archived files on the parallel ref, and nothing on this path renames or deletes a child's archived file. Both survive the collapse and both need a pointer, so this path keys by archived-file identity. Collapsing the stamp here would keep whichever child was visited last and strand the other's bytes.

### The consumption's position is a constraint, not a preference

When the Context consumption returns, every item it consumed has an archived snapshot on the parallel ref and no memory refers to it yet. Every step between the consumption and the atomic summary write is therefore a window in which a failure leaves those snapshots unreferenced with no working-area state that would archive the item again — a permanent, silent loss. Placing the consumption after the consolidation call, rather than at the head of the path, reduces that window to the single atomic write.

### Only external references are consumed write-ahead

The write-ahead ordering — snapshot committed to the parallel ref first, working-area state torn down second — is the external-reference half only, and it is what makes a failed snapshot write free there: the row stays active and the reference is re-archived on the next commit. Plans, notes and skills invert it, stamping the working-area row first (per item for plans, in one batched registry write for notes, inside the archival step for skills) and writing the snapshot batch afterwards. A failure in that gap is the opposite defect — the row reads as claimed by the rewritten commit while nothing was archived — rather than an unreferenced snapshot. The position argument above is unaffected, because it turns on the state the consumption leaves behind once complete rather than on the order in which it got there; what does not carry over is the write-ahead *reasoning*, which is specific to references.

### Mechanical fallback preserves the invariant

When the consolidation call fails at the transport level, the mechanical-merge fallback synthesizes the topics-and-recap result by concatenating source content. This guarantees the new root always carries a populated narrative regardless of model availability.

### Per-commit grouping is preserved for the model

The consolidation-source expansion is deliberately not a flat aggregation: each original commit becomes its own source so that the consolidation call's chronological reasoning remains valid. Flattening would lose the per-commit signal that the consolidation call's supersede-evidence rule depends on.

### Missing sources are tolerated

A consolidation operation that loads only a subset of its source summaries still proceeds. The warning logged for missing hashes is informational; correctness depends only on at least one source being recoverable.

### Idempotency on re-run

The atomic batch checks the index for the new hash before writing. When the entry already exists, the operation treats itself as already performed and returns without rewriting either the payload or the index.

### Re-association of plan, note and skill references

Plan-reference and note-reference entries from each loaded source summary are walked and the corresponding registry entries are updated to point at the new commit hash. This is what keeps the plan and note registries in sync with the rewrite, since those registries are independent local state files rather than fields of the summary tree. Skill guard rows are migrated in the same walk, against the collapsed-hash set described above.

Re-association only *moves* records that were already archived under one of the collapsed hashes. It is not a substitute for the Context consumption above and never was: an item the user activated during the session that ended in this rebase-squash has no archived record for it to move, so before that consumption existed such an item was simply left behind.

### Skills are hoisted but not stripped from the children

The hoist-strip applied to each attached child has no skill arm, so the root and the children it wraps hold the same skill references. That is the established shape, not a leak: the accumulation deduplicates by archive key before summing, so a later rewrite's recursive walk — which meets each hoisted reference from both ends — does not inflate the counts by one generation per collapse.

## Shared Behavior

- **Operation queue** — the consolidation is the handler for an enqueued rebase-squash operation; one queue entry per N-to-one mapping group.
- **Squash consolidation pipeline** — the language-model call, its prompt rules, the mechanical fallback, the consolidation-source expansion rule, the relevance-ranking invalidation, the skill archival, the working-area Context consumption and its branch-resolution chain are all shared with the non-rebase squash path.
- **Working-area Context consumption** — the detection of activated plans, notes and external references, the archival that stamps or removes their working-area rows, and the "excluded means skipped for this commit, not deleted" rule are the same ones the plain-commit and amend paths run.
- **Commit exclusion selection and relevance ranking** — the persisted store holding both the user's exclusion selection (read once here) and the cached per-item relevance ranking plus change fingerprint (invalidated at the head of this path) is spec 188; the ranker that produces that ranking, which this path never invokes, is spec 258.
- **Summary-tree format** — the unified-format root, hoist-stripping rules for embedded children, the legacy-aware expansion of nested formats.
- **Summary index** — the upsert path that reclassifies each source summary's entry from root to descendant during the same atomic batch as the payload write.
- **Plan registry** and **note registry** — the local state files updated by the explicit re-association step. The skill working record whose guard rows are migrated in the same step is owned by spec 319; the archival step that freezes them onto the rewritten commit is spec 322; the user-exclusion selection it honors is spec 188.
- **Summary-tree skill accumulation** — the fold that combines the children's and the freshly-archived references, its archive-key deduplication, and its usage / confidence / detection degradation rules.
- **Cross-process lock** — gates the atomic write of the new payload and updated index.
- **Rebase-pick migration** — the sibling topic covering the one-to-one variant.
- **Squash-pending handoff** — the transient state file used to identify source hashes for non-rebase squashes; not used by this rebase-driven path.
