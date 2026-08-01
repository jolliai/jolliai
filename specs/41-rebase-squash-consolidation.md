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
- The archival of uncommitted skill usage onto the rewritten commit, ahead of that construction.
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
- Aggregated end-to-end test guidance, plans, notes, article-style metadata, and orphaned-article identifiers, inherited from the children via the standard hoist rules.
- Accumulated skill references — every child's, plus the ones freshly archived onto the rewritten commit — folded through the shared skill accumulation. Present only when non-empty.
- A diff-statistics field freshly computed against the new commit's own parent.

## Behavior

### Loading sources

1. For each prior commit hash, attempt to load the recorded summary.
2. Hashes whose summaries are missing are recorded in a warning but do not abort the operation; consolidation proceeds with whichever source summaries are available.
3. If no source summaries are recovered at all, the operation skips with a warning and writes nothing.

### Consolidation call

1. Each loaded source summary is expanded into per-commit consolidation sources using the expansion rule above. The flat result preserves per-commit grouping.
2. The outer ticket-identifier hint is extracted from the rewritten commit message.
3. The consolidation language-model call is invoked with the rewritten message, the optional outer ticket-identifier hint, and the list of consolidation sources.
4. On a successful call returning content, the result populates the new root's topics, recap, and resolved ticket identifier, and the call's metadata is recorded.
5. On a transport-level failure or a result lacking content, the mechanical fallback synthesizes the topics-and-recap result by concatenating source content; the call metadata is omitted because no successful call ran.

### Archiving uncommitted skill usage

Before the new root is built, the working-area skill registry's uncommitted rows are frozen onto the rewritten commit — a rebase-squash lands work exactly as a plain squash does. The persisted user-exclusion selection's skill set is honored inside the archival step (never as a filter on its result, since archiving both guards the row and emits parallel-ref bytes). Any raw working-file bytes returned are stored on the parallel ref; the resulting references are handed to the root construction as an additional input, because there is no second write that could attach them afterwards.

### Building the new root

1. Hoist child-level metadata up to the root: end-to-end test scenarios, plan references (deduped by slug, latest-update wins), note references (deduped by identifier, latest-update wins), skill references (**accumulated**, not deduped — deduplicated by archive key first, then summed per skill, together with the freshly-archived set from the step above), the newest descendant's article-style metadata (with non-winners contributing to the orphaned-article-identifier list), and the existing orphaned-identifier list inherited from children.
2. Sort children by display-date descending (most recent activity first).
3. Hoist-strip each child copy attached to the new root.
4. Compute the new commit's full diff statistics against its parent; fall back to a zeroed record on diff failure.
5. Construct the new root with consolidated narrative, hoisted metadata, the diff-statistics field, the commit-type "squash" marker, and the operation-source marker when supplied.

### Persistence

The new payload and the updated index are written in one atomic batch. The atomic batch checks for an existing index entry at the new hash and short-circuits if one is already present. The prior summaries' payload files are never deleted; lookups by any prior commit hash continue to resolve directly to those originals.

### Re-association of plan, note and skill references

After the new root is persisted, every plan reference on every loaded source summary is walked and the corresponding plan-registry entry is updated to point at the new commit hash; the same is done for note references against the note-registry portion of local state. This is unconditional within the operation when source summaries are loaded.

Skill references are walked in the same pass but re-anchor a **guard row** rather than an artifact row, and they are given one extra input: the set of every commit hash in the subtree being collapsed, roots included, computed by a recursive walk before the loop. A guard matches when its recorded hash starts with the archive key's own embedded short hash, or prefix-matches one of those collapsed hashes in either direction. The collapsed set is required because a hoisted skill reference keeps the archive key of the commit that originally archived it while its guard has already been migrated by an earlier rewrite; matching the embedded hash alone therefore worked once and then stranded the row on a commit that no longer exists. The guard's archived-totals baseline survives the migration untouched — it records what a commit already claimed, and rewriting commit metadata does not un-claim it.

## State Transitions

For a single (prior hashes, new hash) group:

- **Not consolidated** → **Consolidated** on first successful run.
- **Consolidated** → **Consolidated** on re-run: the new hash already has an index entry, so the atomic-batch short-circuit prevents a duplicate write.

Each prior summary's index entry transitions from a root to a descendant (its parent link gains a value pointing at the new root), inherited from the underlying summary-store upsert.

## Notable Behavior

### Shared pipeline with non-rebase squash

This path and the non-rebase squash path delegate to the same consolidation pipeline. The user-visible result is identical regardless of whether the consolidation was triggered from an interactive rebase squash, a fixup, a plain squash merge, or a plugin-driven squash button. The only differences upstream are how the source-hashes list is recovered (a stdin mapping for rebase, a state-file handoff for non-rebase).

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

### Skills are hoisted but not stripped from the children

The hoist-strip applied to each attached child has no skill arm, so the root and the children it wraps hold the same skill references. That is the established shape, not a leak: the accumulation deduplicates by archive key before summing, so a later rewrite's recursive walk — which meets each hoisted reference from both ends — does not inflate the counts by one generation per collapse.

## Shared Behavior

- **Operation queue** — the consolidation is the handler for an enqueued rebase-squash operation; one queue entry per N-to-one mapping group.
- **Squash consolidation pipeline** — the language-model call, its prompt rules, the mechanical fallback, and the consolidation-source expansion rule are shared with the non-rebase squash path.
- **Summary-tree format** — the unified-format root, hoist-stripping rules for embedded children, the legacy-aware expansion of nested formats.
- **Summary index** — the upsert path that reclassifies each source summary's entry from root to descendant during the same atomic batch as the payload write.
- **Plan registry** and **note registry** — the local state files updated by the explicit re-association step. The skill working record whose guard rows are migrated in the same step is owned by spec 319; the archival step that freezes them onto the rewritten commit is spec 322; the user-exclusion selection it honors is spec 188.
- **Summary-tree skill accumulation** — the fold that combines the children's and the freshly-archived references, its archive-key deduplication, and its usage / confidence / detection degradation rules.
- **Cross-process lock** — gates the atomic write of the new payload and updated index.
- **Rebase-pick migration** — the sibling topic covering the one-to-one variant.
- **Squash-pending handoff** — the transient state file used to identify source hashes for non-rebase squashes; not used by this rebase-driven path.
