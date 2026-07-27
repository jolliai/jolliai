# Amend Summary Migration

## Topic Statement

The pipeline that, when a commit is rewritten in place to produce a new commit hash, carries the existing summary forward to the new hash, recomputes only what the rewrite actually changed, and consolidates new conversational evidence with the prior narrative without losing accumulated context.

## Scope

**In scope:**
- Inputs identifying the prior commit hash and the new commit hash.
- The three-tier dispatch by which the pipeline either skips both the language-model calls, runs only the delta call, or runs both the delta and the consolidation call.
- Which fields are preserved verbatim from the prior summary.
- Which fields are regenerated against the rewritten commit.
- The construction of a new root with the prior summary attached as a stripped child.
- The fall-back when no prior summary exists.
- Idempotency on re-run of the same migration.
- Re-association of plans and notes with the new commit hash.

**Out of scope:**
- The mechanism by which an amend is detected and enqueued (covered by the operation queue topic).
- The transcript reading and per-session attribution rules (covered by the transcript pipeline topic).
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

### Delta diff vs full diff

Two distinct diff scopes are computed:

- **Delta diff**: the textual difference between the prior commit and the new commit. Drives whether new content needs language-model attention and supplies the textual input when it does.
- **Full commit diff**: the standard "this commit vs. its parent" diff for the new commit. This is what gets persisted on the new summary as its own diff statistics, identical in semantics to the diff statistics carried by any other summary node.

### Preserved fields (carried forward unchanged)

Regardless of which dispatch tier runs, these fields on the new root are copied directly from the prior summary when present:

- Article-style metadata (a server-side article identifier and its public URL).
- The accumulated list of orphaned article identifiers awaiting cleanup.
- Plan references and note references.
- End-to-end test guidance scenarios.

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

### Re-association of plan and note references is unconditional

Every tier ends with a re-association step that walks both the plan-reference list and the note-reference list on the prior summary, updating each entry in the corresponding registries to point at the new commit hash. The plan and note registries are independent of the summary store — they live in local state files — so the re-association is what keeps them in sync with the rewrite.

### Conservative thresholds favor running the model

The Tier-A short-circuit is intentionally conservative: any captured conversation, or any delta beyond the small line threshold (whitespace included), forces at least Tier B. False positives in this guard would silently drop new amend information; false negatives only spend an extra model call.

### Mechanical fallback preserves the invariant

When the consolidation call fails at the transport level, the mechanical-merge fallback synthesizes a topics-and-recap result by concatenating source content. This guarantees the new root always carries a populated narrative regardless of model availability.

### Branch attribution uses the enqueue-time branch, not the live branch

Across every tier — the prompt-context gathering of active plans/notes/references and the branch label written on the fresh leaf — the branch is the one captured when the rewrite was enqueued, not the branch read live at migration time. Because the migration runs asynchronously under the worker drain, the live branch may have moved (rapid amend/squash/rebase sequences, or a sibling worktree on another branch) by the time the model call completes; reading it live would file the summary and its plan/note/reference associations under the wrong branch. A legacy queue entry with no captured branch is the only case that falls back to the live branch. (Notable; mirrors the worker's tail-cleanup and diff steps, which guard against the same drift.)

### The prior summary remains independently retrievable

The prior summary's payload file is never deleted by this pipeline. A subsequent lookup by the prior commit hash continues to return the original summary directly, bypassing the new root, because the summary store's read path checks for a direct payload before resolving aliases or descendants.

## Shared Behavior

- **Operation queue** — the pipeline runs as the handler for an enqueued amend operation; it does not detect the rewrite itself.
- **Summary-tree format** — the unified-format root, hoist-stripping rules for the embedded prior summary, the legacy-aware "effective topics" resolver, and the consolidation-source expansion.
- **Summary index** — the index upsert that paired with the new payload write reclassifies the prior summary entry from root to descendant.
- **Plan registry** and **note registry** — the independent state files updated by the unconditional re-association step.
- **Transcript pipeline** — provides the conversational entries within the migration's time window and the persisted transcript artifact.
- **Cross-process lock** — gates all writes to the summary store during the migration.
