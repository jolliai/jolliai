# Note Archival on Commit

## Topic Statement

The behavior, run as part of the per-commit summarization pipeline, that takes uncommitted note entries recorded in the local note registry, snapshots their current content into the orphan-branch storage under an identifier-and-hash filename, and rewrites the registry so future panel queries hide them while a guard entry detects subsequent edits to the original content.

## Scope

**In scope:**
- The selection rule that determines which note entries are eligible for archival on a given commit.
- The two note formats supported (snippet and markdown) and how the format affects what is read and what is attached to the summary.
- The filename convention under which a snapshot is stored.
- The single-entry rewrite of the local registry: the original identifier's row becomes a guard entry. No second row is created under the identifier-with-hash key.
- The note-reference structure attached to the new commit summary.
- The content-hash guard that prevents re-archival when the source content is unchanged.
- Behavior when the original source is missing.

**Out of scope:**
- The relevance-ranker that decides which uncommitted notes are AI-soft-excluded from a given commit (see [258 — AI Context-Relevance Filtering]). This spec documents only how an exclusion *affects* archival: the caller removes the excluded note id from the set handed to this path and never associates it with the commit (see "Interaction with exclusions").
- The user hard-exclude set (see [188 — Commit Exclusion Selection Store]).
- The creation of new notes via the editor surface (covered by the note-service topic).
- Plan archival on commit (covered by its own topic).
- The display-time filtering rules used by the panel (covered by the note-service topic).
- Re-association of note references during amend, squash, or rebase — the separate step in those pipelines that moves a prior summary's note references onto the new hash (covered by those pipelines). The amend and squash pipelines run that step *in addition to*, not instead of, the archival documented here; see "Which commits archive".

## Data Contracts

### Registry note entry

A single record in the local note registry, with these fields relevant to archival:

- **identifier** (required, string): a deterministic identifier of the note, generated when the note is created.
- **title** (required, string).
- **format** (required, enumerated): one of two values:
  - **snippet**: the note's textual content was originally entered inline; it is stored as a file under the per-repository state directory and the source path points at that file. On archival, the local file is removed because the canonical copy has moved to the orphan branch.
  - **markdown**: the note references a separate markdown file at an arbitrary path the user supplied; the source path points at that file. On archival, the file is left intact because the user owns its location.
- **source path** (required when present, string): the absolute path on disk to the file backing the note.
- **commit hash** (required, nullable string): null while the note is uncommitted; set to a commit hash once associated.
- **content hash at commit** (optional, hex string): the SHA-256 of the source content at the moment of archival; presence of this field marks the entry as a guard.
- **added at**, **updated at** (required, ISO timestamps).

### Note registry shape

The note registry shares its persisted file with the plan registry — both live as keyed maps inside the same per-repository state record, the notes side keyed by identifier rather than slug. Loading the registry returns both maps; the archival path operates only on the notes map.

### Note reference

The entry attached to a commit summary's note-reference list. Fields:

- **identifier** (required, string): the new "id-shorthash" identifier; the eight-character prefix of the commit hash is appended to the original identifier.
- **title** (required, string).
- **format** (required, enumerated): the original format value, propagated forward.
- **content** (optional, string): for snippet-format notes, the content snapshot at archive time is embedded directly on the reference. For markdown-format notes, the field is omitted because the content is reachable via the orphan-branch snapshot.
- **added at**, **updated at** (required, ISO timestamps).
- Optional server-side identifiers populated later by the push pipeline.

### Snapshot file

The archived note content is stored on the orphan branch at a conventional path under a "notes/" prefix, keyed by the new identifier.

## Behavior

### Selection of eligible entries

1. Load the registry; access the notes map (which may be absent in legacy registries — treat as empty).
2. Collect every entry whose commit-hash field is null and whose content-hash-at-commit field is absent.

These two conditions express "this entry is genuinely uncommitted and not yet archived". There is no per-row hidden flag consulted here: user hard-exclude is handled entirely by the separate commit-exclusion store (see [188]), and any row the registry reader finds carrying a legacy `ignored === true` marker is deleted outright on read rather than kept as a hidden variant. Selection is branch-independent, because a registry entry carries no branch to select on. Every genuinely-uncommitted entry in the worktree's registry is eligible for the commit being processed, whichever branch that commit is on. The commit's own branch is the only branch attribution an archived note ever acquires.

### Per-entry archival

For each eligible entry:

1. If the source-path field is missing or the file at that path does not exist, skip this entry.
2. Read the file's full content.
3. Compute the SHA-256 of the content as the content hash.
4. Form the new identifier by appending a hyphen and the eight-character prefix of the commit's hash to the original identifier.
5. Append the snapshot to the batch destined for orphan-branch storage, keyed by the new identifier.
6. Append a note reference (new identifier, title, format, optional embedded snippet content, timestamps) to the list that will be returned to the summary-construction caller. The embedded content is included only for snippet-format entries.
7. Stage the registry rewrite in an in-memory accumulator: replace the original identifier's entry with a guard variant (commit-hash set to the new commit, content-hash-at-commit set, updated-at refreshed). This is the only registry row touched — no second row is created under the new identifier-with-hash key.

### Single registry write

After all eligible entries have been processed, the accumulated guard rewrites are persisted to the registry in a single write. This batching avoids reload-write thrash when multiple notes are archived against the same commit.

### Storage write

After the registry has been persisted, the accumulated snapshots are written in a single atomic batch to the orphan-branch storage, with a commit message naming the count of notes and the commit's short hash. When the batch is empty, no write is performed.

### Local snippet file cleanup

For snippet-format entries whose original source path was a file managed inside the per-repository state directory, that file is deleted by the dedicated note-service archival path used by the editor surface. The queue-worker archival path described here, when called from the per-commit pipeline, leaves the file in place — the dedicated path is the one that performs cleanup. (The two paths are otherwise equivalent in their effect on the registry and orphan-branch storage; they differ in whether they were initiated explicitly by a user action or implicitly by a commit.)

For markdown-format entries the source file is always left intact regardless of which path archived the entry, because the file lives at a path the user owns.

### Note-reference output

The set of note references is returned to the caller (the summary construction step) for inclusion in the new summary's note-reference list.

## State Transitions

For a single registry note entry, archival induces this transition:

- **Uncommitted** (commit-hash null, no content hash) → **Guard** (commit-hash set to the new commit, content hash set, updated-at refreshed). The original identifier key continues to exist; only its fields change. No second registry row is created — the identifier-with-hash key exists only as the orphan-branch snapshot filename and as the note reference on the commit summary, never as a registry row.

The guard entry's role thereafter:

- **Guard** + (source content unchanged) → still **Guard**, hidden from panel queries.
- **Guard** + (source content changes so its hash diverges from the stored content hash) → **Visibly edited** (the panel surfaces the entry again as if it were uncommitted). Subsequent commits archive it again, producing a fresh orphan-branch snapshot under a new identifier-and-hash key while the same original-identifier guard row is rewritten in place.

Re-association on amend, squash, or rebase splits the archived key carried on the prior summary's note reference and updates the guard row directly, rather than looking up a row under the identifier-with-hash key.

## Notable Behavior

### Which commits archive

Archival is not specific to a plain commit. It runs on every route that generates or rewrites a commit summary and can therefore carry note references:

- a plain commit, and the cherry-pick and revert variants that go through the same summarization;
- every amend route, whichever tier the amend takes;
- the squash-consolidation route — whether the squash was performed directly against the working tree or came from an interactive rebase's squash/fixup, since both go through one shared consolidation pipeline and therefore archive identically.

The one summary-rewriting route that never archives is the 1:1 rebase reapply, which only moves the prior summary's note references onto the new hash.

The squash route was previously the gap. A note the user activated during a session that ended in a squash was never snapshotted: its uncommitted registry row survived untouched and the consolidated summary held no note reference to it, because the only note work the route did was re-association — moving the squashed-away commits' *already-archived* references onto the new hash, which by construction can never reach a note that was never archived. Such a note is now archived like any other commit's, and the resulting note reference is attached to the consolidated summary.

Archival is bound to storing a summary, and every route carries at least one bail-out that reaches no summary — a plain commit with neither transcript activity nor file changes, an amend with nothing meaningful to record, a squash whose source commits have no stored summaries. None of those is an exception to the list above; they are the same rule seen from the other side: no summary, nothing for a note reference to hang on, so nothing is archived and the registry entry stays uncommitted for the next commit.

### Snippet vs markdown asymmetry

Snippet-format and markdown-format entries archive identically with one exception: the note-reference attached to the summary embeds the snapshot content for snippet-format entries and omits it for markdown-format entries. The orphan-branch snapshot itself contains the full content for both formats; the embedding is a convenience for downstream consumers that want snippet text inline with a summary's metadata.

### The original identifier is intentionally preserved as a guard, not deleted

If the original identifier were deleted on archival, the system would lose its only handle for detecting subsequent edits to the source. The guard entry is the mechanism by which "this note was archived under exactly this content; if the source changes, surface it again" is enforced.

### Branch attribution begins at archival

Neither archival nor the panel filters by branch, because a registry entry carries no branch. A pending note is worktree-scoped: it stays visible regardless of which branch is checked out, exactly like uncommitted code. Archival is where a branch first enters the picture, and it is a branch the **calling pipeline** supplies, never anything the registry held. On the routes that generate a summary from scratch it is the commit's own branch, the same one recorded on that commit's stored summary. Any branch value found on a row is purged when the registry is read, and the purge marks the registry as changed so the next write-back persists the cleaned shape; because this path reads through that same normalization, the guard rewrite has no branch to preserve.

**The branch label never gates archival.** On the squash-consolidation route the label is resolved from three sources in order, each a fallback for the one before: the branch recorded when the commit was queued for processing (preferred, because the queue drains asynchronously and the tip may have moved by the time archival runs); then a live read of the current branch; and finally the branch carried by the source summaries being consolidated, which is already in hand and cannot fail. A branch that cannot be read therefore never costs the archive. Degrading rather than skipping is deliberate: a sibling archival step on the same route takes its branch from the source summaries and would have proceeded regardless, so skipping here would have left the consolidated memory *partial* rather than merely smaller.

Two consequences of that chain. The label can be stale relative to the tip — that is exactly why the live read is only the second choice, not the first. And it can differ from the branch recorded on the consolidated summary, which is always the source summaries' branch. Both are cheap: the label only affects how the snapshot is filed for human browsing, while the snapshot itself is stored and retrieved by its identifier-and-hash key independently of any branch.

### Idempotency rests on the guard

A second archival of the same note against the same commit hash short-circuits at the selection rule: the entry's content-hash-at-commit field is already set, so it is no longer eligible. There is no separate idempotency check at the storage layer.

### Interaction with exclusions (skipped from archival, never discarded)

Before invoking this path, the pipeline removes two kinds of note ids from the candidate set it hands to archival: the user's **hard-excluded** notes (the "leave out of this memory" set) and the notes the AI relevance ranker **soft-excluded** for this commit (see [258]). Both are now treated **identically**:

- A hard-excluded or soft-excluded note is **skipped from association only**. No commit hash is assigned to it, no content-hash guard is written, and its uncommitted registry row and backing file (snippet file or externally-owned markdown file) are left completely intact. The note is **neither archived nor deleted** — it stays in the working area (commit-hash still null, no content hash) and the panel surfaces it again on the next refresh, eligible for re-evaluation on the next commit.

There is **no discard pass** for notes. An earlier design permanently deleted a user hard-excluded note's registry row and product-owned snippet backing file on the excluding commit; that behavior has been **removed entirely**. "Leave out of this memory" is a one-commit skip, not a delete — the user's hard-exclude and the AI's soft-exclude now converge on the same sticky leave-out.

**A route that runs no relevance judgement has no soft-exclude set.** The soft-exclude set exists only where a relevance judgement was made for the commit being processed; where none was, the set handed to archival is empty and the user's full working-area selection is archived, minus only their hard excludes. The squash-consolidation route is one such route: it consolidates the topic structures the squashed-away commits already carry rather than re-deriving anything from the diff and transcript, so there is nothing for a relevance judgement to rank and none is made.

**Contrast with conversations (the discard exception):** excluded *conversations* are the one item kind that is still a one-time discard — an excluded conversation is read only to advance its cursor to the commit boundary and is then dropped from the summary, so it never reappears. That discard is owned by the transcript-loading path, not this one; notes (like plans and references) are the sticky, skip-only kind.

### Skipping happens in three places

- An entry's registry record is missing — skipped silently with a debug log.
- An entry has no source-path field, or the file at the source path does not exist — skipped.
- An entry's commit-hash field is already non-null or its content-hash-at-commit field is set — already-archived guard or already-associated, skipped before the source is read.

In all three cases the archival batch simply does not include the skipped entry.

### Local snippet files become canonical only on the orphan branch after archival

For snippet-format notes archived via the dedicated note-service path, the local file under the per-repository state directory is deleted after the orphan-branch write succeeds. The orphan-branch snapshot is thereafter the only retrievable copy. The guard entry's source-path field still names the now-absent local file; the panel's "uncommitted note whose file was deleted" hide-rule, combined with the guard's content-hash-at-commit field, keeps the entry suppressed from the panel without reintroducing the deleted file.

### Co-location with the plan registry

The note registry shares its persisted file with the plan registry. Reads load both maps; writes serialize both maps. Updates to the note side leave the plan side intact.

## Shared Behavior

- **Note registry** — the local state file (shared with plans) whose notes map is read for selection and rewritten with guard and archived variants.
- **Orphan-branch storage** — the destination for the snapshot batch, written through the same primitive used by summary writes and plan archival.
- **Per-commit summary pipeline** — the caller that supplies the commit hash and consumes the returned note-reference list to attach to the new summary.
- **Note service display** — the panel-query layer that interprets the guard entries and hides them while their content hash matches.
- **Re-association on rewrite** — the amend, squash, and rebase pipelines that walk a prior summary's note-reference list and update each entry's commit-hash field in the registry. On the amend and squash routes that step runs alongside the archival documented here, and after it, so a guard revived and re-archived under the new hash is not migrated a second time.
- **Plan archival on commit** — the parallel path for plan entries; this topic only covers notes.
- **AI context-relevance filtering (spec 258)** and **commit-exclusion store (spec 188)** — a soft-excluded note and a user hard-excluded note are treated identically: both are removed from the candidate set fed here and neither is discarded (each stays uncommitted, row and file intact, for re-evaluation on the next commit). Only excluded conversations are a one-time discard, and that is owned elsewhere.
