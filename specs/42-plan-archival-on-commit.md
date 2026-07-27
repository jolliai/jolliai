# Plan Archival on Commit

## Topic Statement

The behavior, run as part of the per-commit summarization pipeline, that takes uncommitted plan entries recorded in the local plan registry, snapshots their current file content into the orphan-branch storage under a slug-and-hash filename, and rewrites the registry so future panel queries hide them: the original slug's row is turned into a guard entry that detects subsequent edits to the original file.

## Scope

**In scope:**
- The selection rule that determines which registry entries are eligible for archival on a given commit.
- The filename convention under which a snapshot is stored.
- The single-entry rewrite of the local registry: the original slug's row becomes a guard entry. No second row is created under the slug-with-hash key.
- The plan-reference structure attached to the new commit summary.
- The content-hash guard that prevents re-archival when the file is unchanged.
- Behavior when the original plan file is missing.

**Out of scope:**
- The relevance-ranker that decides which uncommitted plans are AI-soft-excluded from a given commit (see [258 — AI Context-Relevance Filtering]). This spec documents only how an exclusion *affects* archival: the caller removes the excluded slug from the set handed to this path and never associates it with the commit (see "Interaction with exclusions").
- The user hard-exclude set (see [188 — Commit Exclusion Selection Store]).
- The discovery of new plans during transcript scanning (covered by the plan-detection topic) — the worker only reads the registry, never re-scans transcripts.
- Note archival on commit (covered by its own topic).
- Cross-commit plan progress evaluation (covered by the plan-progress topic).
- The display-time filtering rules used by the panel (covered by the plan-service topic).
- Re-association of plan references during amend, squash, or rebase (covered by those pipelines).

## Data Contracts

### Registry plan entry

A single record in the local plan registry, with these fields relevant to archival:

- **slug** (required, string): a deterministic identifier of the plan, derived from the file's location at registration time.
- **title** (required, string): the first heading text from the markdown file at registration time.
- **source path** (required, string): the absolute path to the plan's markdown file on disk.
- **branch** (optional, string): the branch the plan was added on. Optional — a record legitimately carries no branch when the current-branch query failed at registration time (the field is omitted rather than stored as a literal `unknown`), and legacy records predating branch-stamping also lack it.
- **commit hash** (required, nullable string): null while the plan is uncommitted; set to a commit hash once associated.
- **content hash at commit** (optional, hex string): the SHA-256 of the file content at the moment of archival; presence of this field marks the entry as a guard.
- **added at**, **updated at** (required, ISO timestamps).

### Plan reference

The entry attached to a commit summary's plan-reference list. Fields:

- **slug** (required, string): the new "slug-shorthash" identifier; the eight-character prefix of the commit hash is appended to the original slug.
- **title** (required, string).
- **added at**, **updated at** (required, ISO timestamps).
- Optional server-side identifiers populated later by the push pipeline.

### Snapshot file

The archived plan content is stored on the orphan branch at a conventional path under a "plans/" prefix, keyed by the new slug.

## Behavior

### Selection of eligible entries

1. Load the plan registry.
2. Collect every entry whose commit-hash field is null and whose content-hash-at-commit field is absent.

These two conditions express "this entry is genuinely uncommitted and not yet archived". Entries that already carry a content hash are guard records from a prior archival; entries with a non-null commit hash are either committed snapshots or stale records superseded elsewhere. There is no per-row hidden flag consulted here: user hard-exclude is handled entirely by the separate commit-exclusion store (see [188]), and any row the registry reader finds carrying a legacy `ignored === true` marker is deleted outright on read rather than kept as a hidden variant.

The selection rule does not filter by branch. The branch-aware visibility logic that hides plans from other branches is applied later by the panel display layer, not at archival time. As a result, the archival path will associate a plan with the current commit even when the plan's recorded branch differs from the commit's branch, on the principle that the registry's branch field reflects the user's intent at registration.

### Per-entry archival

For each eligible entry:

1. Resolve the on-disk markdown file at the source-path field.
2. If the file no longer exists, skip this entry.
3. Read the file's full content.
4. Compute the SHA-256 of the content as the content hash.
5. Extract the title from the first heading line of the markdown content; fall back to the slug when no heading is present.
6. Form the new slug by appending a hyphen and the eight-character prefix of the commit's hash to the original slug.
7. Append the snapshot to the batch destined for orphan-branch storage, keyed by the new slug.
8. Append a plan reference (new slug, title, timestamps) to the list that will be returned to the summary-construction caller.
9. Rewrite the registry: replace the original slug's entry with a guard variant (same fields, but with the commit-hash field set to the new commit, the content-hash-at-commit field set, and the updated-at timestamp refreshed). This is the only registry row touched — no second row is created under the new slug-with-hash key. Persist the registry after each entry is processed.

### Storage write

After all eligible entries have been processed, the accumulated snapshots are written in a single atomic batch to the orphan-branch storage, with a commit message naming the count of plans and the commit's short hash. When the batch is empty, no write is performed.

### Plan-reference output

The set of plan references is returned to the caller (the summary construction step) along with two side-channel maps used downstream by the plan-progress evaluator: the new-slug-to-raw-markdown map and the new-slug-to-original-slug map.

## State Transitions

For a single registry entry, archival induces this transition:

- **Uncommitted** (commit-hash null, no content hash) → **Guard** (commit-hash set to the new commit, content hash set, updated-at refreshed). The original-slug key continues to exist; only its fields change. No second registry row is created — the slug-with-hash key exists only as the orphan-branch snapshot filename and as the plan reference on the commit summary, never as a registry row.

The guard entry's role thereafter:

- **Guard** + (file content unchanged on disk, or file deleted) → still **Guard**, hidden from panel queries.
- **Guard** + (file content changes on disk so the file's hash diverges from the stored content hash) → **Visibly edited** (the panel surfaces the entry again as if it were uncommitted). Subsequent commits archive it again, producing a fresh orphan-branch snapshot under a new slug-and-hash key while the same original-slug guard row is rewritten in place.

Re-association on amend, squash, or rebase splits the archived key carried on the prior summary's plan reference and updates the guard row directly, rather than looking up a row under the slug-with-hash key.

## Notable Behavior

### Panel-hide depends solely on the content-hash guard

The panel-visibility rule is governed entirely by the content hash. A user can keep editing a plan after a commit; the guard's updated-at field advances as transcript scanning re-touches it, but the panel continues to hide the guard until the file's current SHA-256 no longer matches the stored content hash. This avoids re-surfacing plans that the user merely revisited without substantively changing.

### The original slug is intentionally preserved as a guard, not deleted

If the original slug were deleted on archival, the system would lose its only handle for detecting subsequent edits to the file. The guard entry is the mechanism by which "this plan was archived under exactly this content; if the file changes, surface it again" is enforced.

### The new slug encodes the commit short-hash

Multiple commits over the lifetime of a plan produce multiple archived snapshots under distinct slug-and-hash keys. These snapshots coexist only on the orphan-branch storage, where each is individually retrievable, and each is pointed to by a plan reference on its commit summary. They are **not** registry rows — the registry holds only the single guard row under the original slug, and the panel hides that guard while its content hash matches. The summary tree is the canonical pointer from a commit to its plan references.

### Skipping happens in three places

- An entry's registry record is missing — skipped silently with a debug log.
- An entry's source file is missing on disk — skipped.
- An entry's commit-hash field is already non-null or its content-hash-at-commit field is set — already-archived guard or already-associated, skipped before reading the file.

In all three cases the archival batch simply does not include the skipped entry.

### Idempotency rests on the guard

A second archival of the same plan against the same commit hash short-circuits at the selection rule: the entry's content-hash-at-commit field is already set, so it is no longer eligible. There is no separate idempotency check at the storage layer.

### Interaction with exclusions (skipped from archival, never discarded)

Before invoking this path, the pipeline removes two kinds of slugs from the set of candidates it hands to archival: the user's **hard-excluded** plans (the "leave out of this memory" set), and the plans the AI relevance ranker **soft-excluded** for this commit (see [258]). Both are now treated **identically**:

- A hard-excluded or soft-excluded plan is **skipped from association only**. No commit hash is assigned to it, no content-hash guard is written, and its uncommitted registry row and backing file are left completely intact. The plan is **neither archived nor deleted** — it stays in the working area (commit-hash still null, no content hash) and the panel surfaces it again on the next refresh, eligible for archival or a fresh relevance judgement on the next commit.

There is **no discard pass** for plans. An earlier design permanently deleted a user hard-excluded plan's registry row and product-owned backing file on the excluding commit; that behavior has been **removed entirely**. "Leave out of this memory" is a one-commit skip, not a delete — the user's hard-exclude and the AI's soft-exclude now converge on the same sticky leave-out.

**Contrast with conversations (the discard exception):** excluded *conversations* are the one item kind that is still a one-time discard — an excluded conversation is read only to advance its cursor to the commit boundary and is then dropped from the summary, so it never reappears. That discard is owned by the transcript-loading path, not this one; plans (like notes and references) are the sticky, skip-only kind.

### Branch handling is permissive at archival, strict at display

The archival path does not filter by branch. The registry entry retains its branch field unchanged through the guard rewrite. The display layer reads the branch field at panel-query time and hides entries whose branch does not match the current branch. As a result, an archived plan's registry trail is consistent across branch switches while the panel remains uncluttered.

### Discovery is upstream

The registry entries that this path reads are populated by an entirely separate mechanism (transcript scanning at agent turn end). This path never re-scans transcripts and never inspects the user's plan directory directly; it trusts the registry to enumerate eligible candidates.

## Shared Behavior

- **Plan registry** — the local state file whose entries are read for selection and rewritten with guard and archived variants.
- **Orphan-branch storage** — the destination for the snapshot batch, written through the same primitive used by summary writes.
- **Per-commit summary pipeline** — the caller that supplies the commit hash and consumes the returned plan-reference list to attach to the new summary.
- **Plan progress evaluator** — the downstream consumer of the new-slug-to-raw-markdown map produced as a side-channel.
- **Plan service display** — the panel-query layer that interprets the guard entries and hides them while their content hash matches.
- **Re-association on rewrite** — the amend, squash, and rebase pipelines that walk a prior summary's plan-reference list and update each entry's commit-hash field in the registry.
- **Note archival on commit** — the parallel path for note entries; this topic only covers plans.
- **AI context-relevance filtering (spec 258)** and **commit-exclusion store (spec 188)** — a soft-excluded plan and a user hard-excluded plan are treated identically: both are removed from the candidate set fed here and neither is discarded (each stays uncommitted, row and file intact, for re-evaluation on the next commit). Only excluded conversations are a one-time discard, and that is owned elsewhere.
