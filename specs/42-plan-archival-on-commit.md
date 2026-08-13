# Plan Archival on Commit

## Topic Statement

The behavior, run as part of the per-commit summarization pipeline, that takes uncommitted plan entries recorded in the local plan registry, snapshots their current file content into the orphan-branch storage under a slug-and-hash filename, and rewrites the registry so future panel queries hide them: the original slug's row is turned into a guard entry that detects subsequent edits to the original file.

## Scope

**In scope:**
- The selection rule that determines which registry entries are eligible for archival on a given commit, including the deterministic refusal of a plan whose source file belongs to a different repository.
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
- Re-association of plan references during amend, squash, or rebase — the separate step in those pipelines that moves a prior summary's plan references onto the new hash (covered by those pipelines). The amend and squash pipelines run that step *in addition to*, not instead of, the archival documented here; see "Which commits archive".

## Data Contracts

### Registry plan entry

A single record in the local plan registry, with these fields relevant to archival:

- **slug** (required, string): a deterministic identifier of the plan, derived from the file's location at registration time.
- **title** (required, string): the first heading text from the markdown file at registration time.
- **source path** (required, string): the absolute path to the plan's markdown file on disk.
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
2. Build a single per-run classifier that answers, for one source path, whether it belongs to **this** repository, to a **foreign** one, or to **neither** (see "Foreign-repository plans are refused inside the selection").
3. Admit an entry in either of two states — and in both, refuse it outright when the classifier calls its source path foreign:
   - **Fresh** — commit-hash field null and content-hash-at-commit field absent. This is "genuinely uncommitted and not yet archived".
   - **Revived guard** — commit-hash field non-null, content-hash-at-commit field set, a source path present, and the file's current SHA-256 no longer matching the stored content hash. The classification is checked **before the file is hashed**, so a foreign file is never read at all.

Every other shape is skipped. A guard whose file still hashes to the stored value — or whose file cannot be read at all — is an intact guard with nothing new to archive. An entry carrying a commit hash but no content hash, or no source path, matches neither state and is a committed snapshot or a record superseded elsewhere.

There is no per-row hidden flag consulted here: user hard-exclude is handled entirely by the separate commit-exclusion store (see [188]), and any row the registry reader finds carrying a legacy `ignored === true` marker is deleted outright on read rather than kept as a hidden variant.

Selection is branch-independent, because a registry entry carries no branch to select on. Every genuinely-uncommitted entry in the worktree's registry is eligible for the commit being processed, whichever branch that commit is on. The commit's own branch is the only branch attribution an archived plan ever acquires.

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

### Which commits archive

Archival is not specific to a plain commit. It runs on every route that generates or rewrites a commit summary and can therefore carry plan references:

- a plain commit, and the cherry-pick and revert variants that go through the same summarization;
- every amend route, whichever tier the amend takes;
- the squash-consolidation route — whether the squash was performed directly against the working tree or came from an interactive rebase's squash/fixup, since both go through one shared consolidation pipeline and therefore archive identically.

The one summary-rewriting route that never archives is the 1:1 rebase reapply, which only moves the prior summary's plan references onto the new hash.

The squash route was previously the gap. A plan the user activated during a session that ended in a squash was never snapshotted: its uncommitted registry row survived untouched and the consolidated summary held no plan reference to it, because the only plan work the route did was re-association — moving the squashed-away commits' *already-archived* references onto the new hash, which by construction can never reach a plan that was never archived. Such a plan is now archived like any other commit's, and the resulting plan reference is attached to the consolidated summary.

Archival is bound to storing a summary, and every route carries at least one bail-out that reaches no summary — a plain commit with neither transcript activity nor file changes, an amend with nothing meaningful to record, a squash whose source commits have no stored summaries. None of those is an exception to the list above; they are the same rule seen from the other side: no summary, nothing for a plan reference to hang on, so nothing is archived and the registry entry stays uncommitted for the next commit.

### Panel-hide depends solely on the content-hash guard

The panel-visibility rule is governed entirely by the content hash. A user can keep editing a plan after a commit; the guard's updated-at field advances as transcript scanning re-touches it, but the panel continues to hide the guard until the file's current SHA-256 no longer matches the stored content hash. This avoids re-surfacing plans that the user merely revisited without substantively changing.

### The original slug is intentionally preserved as a guard, not deleted

If the original slug were deleted on archival, the system would lose its only handle for detecting subsequent edits to the file. The guard entry is the mechanism by which "this plan was archived under exactly this content; if the file changes, surface it again" is enforced.

### The new slug encodes the commit short-hash

Multiple commits over the lifetime of a plan produce multiple archived snapshots under distinct slug-and-hash keys. These snapshots coexist only on the orphan-branch storage, where each is individually retrievable, and each is pointed to by a plan reference on its commit summary. They are **not** registry rows — the registry holds only the single guard row under the original slug, and the panel hides that guard while its content hash matches. The summary tree is the canonical pointer from a commit to its plan references.

### Where an entry is skipped

- Its source path is classified as belonging to a foreign repository — refused inside the selection, on the fresh branch and on the revived-guard branch alike, and on the revived-guard branch before the file is even hashed.
- It carries a commit hash and a content hash, and the file's current hash still matches the stored one (or the file cannot be read at all) — an intact guard, nothing new to archive.
- It carries a commit hash but no content hash, or carries no source path at all — matching neither admitted state.
- Its registry record is missing when the archival loop looks it up — skipped silently with a debug log.
- Its source file is missing on disk at archival time — skipped.

In every case the archival batch simply does not include the skipped entry.

### Idempotency rests on the guard

A second archival of the same plan against the same commit hash short-circuits at the selection rule: archival just wrote the content-hash-at-commit field from the file's current bytes, so the file's live hash matches the stored one and the entry is neither fresh nor a revived guard. There is no separate idempotency check at the storage layer.

### Foreign-repository plans are refused inside the selection

Plans are discovered by scanning an agent transcript for the markdown files it read or wrote, so a session working in this repository that incidentally touches a markdown file in an unrelated checkout registers that other repository's file as one of *this* repository's plans. The selection rule refuses such an entry outright, with no model in the loop.

The decision is by git-repository **identity**, not by directory containment: a legitimate agent plan lives in a machine-global plan directory outside the worktree, so "outside the worktree, therefore foreign" would drop exactly the plans that matter most. A source path inside the current worktree is this repository's, decided without any git call; so is a path inside a whitelisted canonical agent plan directory; otherwise the enclosing repository's identity is compared against the current worktree's. A sibling checkout of the *same* repository is likewise this repository's, since linked worktrees of one repository share one identity.

**Uncertainty never excludes.** An entry with no source path, a file that lies in no repository at all, and a current worktree whose own identity cannot be resolved all classify as **neither**, and *neither* is always kept. The refusal fires only where foreignness was actually proved.

Consequences that do not follow the pattern the other exclusions set:

- **The refusal lives inside the selection, not in the caller.** The user's hard-exclude set and the relevance ranker's soft-exclude set are both applied by the caller, which subtracts their slugs from the candidate set this path returned. The foreign refusal happens while the candidates are being collected, so it is in force on every route that reaches this path at all, and no caller can hand a refused slug back in. Those routes are the plain commit, the squash-consolidation route and every amend shape — but not the 1:1 rebase reapply, which never reaches this path at all and therefore never applies the refusal either; it only re-points a prior summary's existing plan references, so it has no candidate set to classify.
- **A refused plan is refused on every future commit, forever.** Every other unarchived plan stays eligible for the next commit; a foreign one is re-classified identically each time and refused again for as long as its source path stays where it is. It is never archived — and equally never deleted: its uncommitted registry row and its backing file are left completely intact.
- **On some routes the refusal is silent.** The routes that build a fresh summarization prompt run their own upstream copy of the same classification and record one excluded-context entry per foreign plan on the stored summary, carrying a fixed reason, so a panel can show why the plan was left out. The squash-consolidation route, and the amend routes that carry the previous memory's topics forward instead of generating new ones, hand this path an **empty** excluded-context set — so on those, the plan is dropped from the archive with no audit row anywhere explaining the omission.

**Notable asymmetry: containment beats identity, in one direction only.** The in-worktree check short-circuits before any git call, so a plan file inside a submodule or an unrelated nested clone that happens to sit *under* the current worktree is classified as this repository's and archived into this repository's memory — no repository walk is performed. The very same submodule checked out *outside* the worktree is classified foreign and refused. Which answer a submodule gets therefore depends on where it is checked out, not on what it is.

### Interaction with exclusions (skipped from archival, never discarded)

Before invoking this path, the pipeline removes the user's **hard-excluded** plans (the "leave out of this memory" set) and the plans the AI relevance ranker **soft-excluded** for this commit (see [258]) from the set of candidates it hands to archival. A third exclusion also reaches archival — the deterministic foreign-repository refusal above — but it is not one of the caller's subtractions: it is applied *inside* the selection rule and cannot be handed back in. The two the caller subtracts are treated **identically**:

- A hard-excluded or soft-excluded plan is **skipped from association only**. No commit hash is assigned to it, no content-hash guard is written, and its uncommitted registry row and backing file are left completely intact. The plan is **neither archived nor deleted** — it stays in the working area (commit-hash still null, no content hash) and the panel surfaces it again on the next refresh, eligible for archival or a fresh relevance judgement on the next commit.

The foreign refusal shares the "neither archived nor deleted" half of that and **not** the "eligible on the next commit" half: a foreign plan's row and file are equally untouched, but the classification is deterministic and re-derived per commit, so the next commit refuses it again on exactly the same grounds. Only moving the file makes it eligible.

There is **no discard pass** for plans. An earlier design permanently deleted a user hard-excluded plan's registry row and product-owned backing file on the excluding commit; that behavior has been **removed entirely**. "Leave out of this memory" is a one-commit skip, not a delete — the user's hard-exclude and the AI's soft-exclude now converge on the same sticky leave-out.

**A route that runs no relevance judgement has no soft-exclude set — but it still refuses foreign plans.** The soft-exclude set exists only where a relevance judgement was made for the commit being processed; where none was, the set handed to archival is empty and the user's full working-area selection is archived, minus their hard excludes *and* minus any plan the selection rule classifies as foreign. The squash-consolidation route is one such route: it consolidates the topic structures the squashed-away commits already carry rather than re-deriving anything from the diff and transcript, so there is nothing for a relevance judgement to rank and none is made — yet a foreign plan is still dropped there, and dropped **silently**, because the empty excluded-context set that route passes means no audit row is written to say so.

**Contrast with conversations (the discard exception):** excluded *conversations* are the one item kind that is still a one-time discard — an excluded conversation is read only to advance its cursor to the commit boundary and is then dropped from the summary, so it never reappears. That discard is owned by the transcript-loading path, not this one; plans (like notes and references) are the sticky, skip-only kind.

### Branch attribution begins at archival

Neither archival nor the panel filters by branch, because a registry entry carries no branch. A pending plan is worktree-scoped: it stays visible regardless of which branch is checked out, exactly like uncommitted code. Archival is where a branch first enters the picture, and it is a branch the **calling pipeline** supplies, never anything the registry held. On the routes that generate a summary from scratch it is the commit's own branch, the same one recorded on that commit's stored summary. Any branch value found on a row is purged when the registry is read, and the purge marks the registry as changed so the next write-back persists the cleaned shape; because this path reads through that same normalization, the guard rewrite has no branch to preserve.

**The branch label never gates archival.** On the squash-consolidation route the label is resolved from three sources in order, each a fallback for the one before: the branch recorded when the commit was queued for processing (preferred, because the queue drains asynchronously and the tip may have moved by the time archival runs); then a live read of the current branch; and finally the branch carried by the source summaries being consolidated, which is already in hand and cannot fail. A branch that cannot be read therefore never costs the archive. Degrading rather than skipping is deliberate: a sibling archival step on the same route takes its branch from the source summaries and would have proceeded regardless, so skipping here would have left the consolidated memory *partial* rather than merely smaller.

Two consequences of that chain. The label can be stale relative to the tip — that is exactly why the live read is only the second choice, not the first. And it can differ from the branch recorded on the consolidated summary, which is always the source summaries' branch. Both are cheap: the label only affects how the snapshot is filed for human browsing, while the snapshot itself is stored and retrieved by its slug-and-hash key independently of any branch.

### Discovery is upstream

The registry entries that this path reads are populated by an entirely separate mechanism (transcript scanning at agent turn end). This path never re-scans transcripts and never inspects the user's plan directory directly; it trusts the registry to enumerate eligible candidates.

## Shared Behavior

- **Plan registry** — the local state file whose entries are read for selection and rewritten with guard and archived variants.
- **Orphan-branch storage** — the destination for the snapshot batch, written through the same primitive used by summary writes.
- **Per-commit summary pipeline** — the caller that supplies the commit hash and consumes the returned plan-reference list to attach to the new summary.
- **Plan progress evaluator** — the downstream consumer of the new-slug-to-raw-markdown map produced as a side-channel.
- **Plan service display** — the panel-query layer that interprets the guard entries and hides them while their content hash matches.
- **Re-association on rewrite** — the amend, squash, and rebase pipelines that walk a prior summary's plan-reference list and update each entry's commit-hash field in the registry. On the amend and squash routes that step runs alongside the archival documented here, and after it, so a guard revived and re-archived under the new hash is not migrated a second time.
- **Note archival on commit** — the parallel path for note entries; this topic only covers plans.
- **AI context-relevance filtering (spec 258)** and **commit-exclusion store (spec 188)** — a soft-excluded plan and a user hard-excluded plan are treated identically: both are removed from the candidate set fed here and neither is discarded (each stays uncommitted, row and file intact, for re-evaluation on the next commit). Only excluded conversations are a one-time discard, and that is owned elsewhere.
- **Plan source-path classification** — the repository-identity rules the selection above consults (what counts as this repository, what counts as foreign, and the "uncertainty is kept" default) are owned by their own topic; this spec owns only how the answer gates archival. The pre-commit surfaces that fold the same classification into what they present as claimable, and the excluded-context row the fresh-prompt routes write for a refused plan, are owned by those surfaces' topics.
