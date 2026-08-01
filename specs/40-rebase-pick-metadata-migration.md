# Rebase-Pick Metadata Migration

## Topic Statement

The path that, when a rebase rewrites a commit hash without changing the commit's content, carries the existing summary forward to the new hash purely as a metadata operation, with no language-model call and no transcript reread.

## Scope

**In scope:**
- Inputs identifying the one-to-one mapping from a prior commit hash to a new commit hash.
- The data preserved verbatim from the prior summary, including the skill references copied onto the new root.
- The fields recomputed for the new commit.
- The construction of a new root with the prior summary attached as a stripped child, and the one metadata kind that is deliberately *not* stripped from it.
- Re-association of plan references, note references and skill guard rows with the new commit hash.
- Index reclassification of the prior entry from root to descendant.
- Behavior when no prior summary exists for the source hash.

**Out of scope:**
- The detection of the rewrite and its mapping (covered by the operation queue topic).
- The N-to-one variant produced by interactive squash or fixup (covered by the rebase-squash consolidation topic).
- The language-model-driven amend path (covered by the amend migration topic).
- The summary-tree hoist invariant in detail (covered by the summary-tree topic).

## Data Contracts

### Migration input

A single mapping carrying:

- **prior commit hash** (required): the source-side hash whose summary is to be migrated.
- **new commit hash** (required): the rebased-side hash to which the summary is being attached.
- **operation source** (optional): which surface initiated the rebase (a CLI client or an editor plugin); recorded on the new summary for provenance.

Multiple mappings produced by the same rebase are processed independently; this topic covers exactly one such mapping.

### Preserved fields (carried forward unchanged)

Copied from the prior summary onto the new root:

- The prior topics, resolved via the legacy-aware effective-topics rule (so summaries written under older nested formats still surrender their accumulated topics).
- The prior recap, when present.
- The prior ticket identifier, when present.
- Article-style metadata (a server-side article identifier and its public URL).
- The accumulated list of orphaned article identifiers awaiting cleanup.
- Plan references, note references, external-entity references, and skill references — all copied onto the new root, no merge needed.
- End-to-end test guidance scenarios.
- The branch name (rebase-pick is treated as branch-preserving for this purpose).

Skill references are copied for the same reason references are: without the copy, a rebase-picked commit loses its skill record from the root, and the PR-wide aggregate, the sidebar skill rows and the exported skill table all read nothing — the references would survive only on the wrapped child, which none of those read paths walk. Each field is written only when the prior summary carried it.

### Recomputed fields

- All commit metadata (commit hash, message, author, dates) is sourced from the rebased commit, not from the prior one.
- The per-node generated-at timestamp is set to the migration's wall-clock time.
- The diff statistics field is recomputed against the new commit's own parent. (The content is unchanged from the source commit's perspective, but the new hash has a different parent in the rebased line, so the statistics are computed afresh as a defensive measure.)
- The commit-type marker is set to a "rebase" classification.
- The operation-source marker is propagated when supplied.

### Output shape

The new root is a unified-format summary node whose own children list is exactly the prior summary, hoist-stripped (its narrative and metadata fields are stripped from the embedded copy because the new root is now authoritative for them).

## Behavior

### Migration

1. Look up the prior summary by the prior commit hash. If absent, skip — there is nothing to migrate.
2. Resolve the prior summary's effective topics via the legacy-aware helper.
3. Compute the new commit's full diff statistics against its parent; on diff failure (no parent reachable, etc.), fall back to a zeroed statistics record rather than aborting.
4. Build the new root: copy the preserved fields, set the recomputed fields, set the commit-type marker to "rebase", and attach the prior summary, hoist-stripped, as the sole entry in the children list.
5. Persist the new root and the updated index in one atomic batch under the new commit hash. The atomic batch checks for an existing index entry at the new hash and short-circuits if one is already present.
6. Re-associate plan, note and skill references from the prior summary with the new commit hash by updating each registry entry's commit-hash field in the local state files. The skill arm re-anchors a guard row (not an artifact row), is driven by the reference's archive key, and is passed the set of every hash in the collapsed subtree — here the prior summary and its descendants — so a reference hoisted by an earlier rewrite still finds its already-migrated guard. The shared match rule is stated in full by the rebase-squash consolidation topic.

### No language-model call

The migration is purely structural. No transcript is read. No diff content is sent to a language model. No new narrative is produced. The persisted topics, recap, and ticket identifier are byte-for-byte identical to those resolved off the prior summary.

### No new skill archival

Unlike the squash and plain-commit paths, this migration archives **no** new skill rows: a rebase-pick lands no new work, so there is nothing uncommitted to freeze. The only skill-related work is the copy onto the new root described above and the guard migration in the re-association step below.

### Skills are copied to the root but NOT stripped from the child

The hoist-strip applied to the embedded prior summary has no skill arm — unlike references, which it does strip — so the root and the child it wraps end up holding the same skill references. That is the established shape rather than a leak, and it is safe only because the tree-level skill accumulation deduplicates by archive key before summing: a later squash's recursive walk meets each of those references from both ends, and blind accumulation would inflate every count by one generation per collapse.

### Absent-prior-summary fallback

When the prior commit hash has no recorded summary (rare: the original commit was never summarized, or its summary was administratively removed), the operation is skipped with a warning. The new commit gets no summary on this path; if the user wants one, the normal commit pipeline handles it through a separate path on a fresh commit, not through this migration.

## State Transitions

For a single (prior hash, new hash) pair:

- **Not migrated** → **Migrated** on first successful run.
- **Migrated** → **Migrated** on re-run: the new hash already has an index entry, so the atomic-batch short-circuit prevents a duplicate write.

The prior summary's index entry transitions from a root to a descendant (its parent link gains a value pointing at the new root), inherited from the underlying summary-store upsert. The prior summary's payload file is never deleted; a direct lookup by the prior commit hash continues to resolve to it.

## Notable Behavior

### One-to-one identification

The producer of this operation distinguishes one-to-one from N-to-one rewrites by grouping the mapping pairs by new-hash. A group of size one becomes a rebase-pick (this topic); a group of size greater than one becomes a rebase-squash (a separate topic). This topic only covers groups of size one.

### No diff regeneration of textual narrative

Because no diff content is sent to the model, the topics are not refreshed against the rebased diff. The prior topics travel forward unchanged. The diff-statistics field is the only diff-derived field that gets recomputed, and only because the new parent could differ from the original parent.

### Idempotency on re-run

The atomic batch checks the index for the new hash before writing. When the entry already exists, the migration treats itself as already performed and returns without rewriting either the payload or the index.

### Re-association of plan, note and skill references

Plan-reference, note-reference and skill-reference entries from the prior summary are walked and the corresponding registry entries are updated to point at the new commit hash. This step is unconditional within the migration when the prior summary exists, and runs even though the embedded child copy retains the references — the user-facing registries live in independent local state files, not in the summary tree, so they need an explicit update.

### Operation-source propagation

The migration carries the operation-source marker forward onto the new root when supplied. This makes the migrated summary record whether the rebase was driven from a CLI client or from an editor plugin, matching the convention used by the amend and squash paths.

## Shared Behavior

- **Operation queue** — the migration is the handler for an enqueued rebase-pick operation; one queue entry per one-to-one mapping group.
- **Summary-tree format** — the unified-format root, the legacy-aware effective-topics resolver, the hoist-stripping rule applied to the embedded prior summary (and its lack of a skill arm), and the skill accumulation whose archive-key deduplication is what makes the duplicated root/child skill references safe.
- **Summary index** — the upsert path that reclassifies the prior summary's entry from root to descendant during the same atomic batch as the payload write.
- **Plan registry** and **note registry** — the local state files updated by the explicit re-association step. The skill working record whose guard rows are migrated in the same step is owned by spec 319; the shared guard match rule is stated by the rebase-squash consolidation topic.
- **Cross-process lock** — gates the atomic write of the new payload and updated index.
- **Rebase-squash consolidation** — the sibling topic covering the N-to-one variant.
