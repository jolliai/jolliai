# Back-fill Commit Target Index

## Topic Statement

Build, in a single offline pass over the repository's version history, the set of real code commits that a historical back-fill attribution is allowed to point at, together with the lookup structures that let the attributor map a file edit observed in a transcript to the commit that carried that file. Bookkeeping commits produced by the product itself are excluded so they can never steal a match.

## Scope

**In scope:**
- Which commits are collected as valid attribution targets and which are filtered out.
- The two exclusion rules (product-bookkeeping subject; all-changed-paths-are-bookkeeping).
- The per-commit metadata recorded (author time, subject, optional branch).
- The reduction of a source ref to a short branch name.
- The file→commits and basename→commits lookup maps and their sort order.
- The single time-window lower-bound query the attributor runs against this index.
- Exclusion of the product's own summaries ref from the traversal.

**Out of scope (boundaries):**
- Scanning the on-disk transcripts (owned by **Back-fill Raw Transcript Scanning**).
- The attribution algorithm that consumes this index (owned by **Back-fill Commit Attribution Algorithm**).
- The orphan summaries branch's own layout and write protocol (owned by the storage specs).
- The overall back-fill run orchestration (owned by **Back-fill Engine Orchestration**).

## Data Contracts

### Author time

Every commit's timestamp in this index is its **author** time (the moment the work was originally authored), not its commit/committer time. Author time survives rebase and amend, so it aligns with when the on-disk transcript edits actually happened — which is the axis the attribution window is measured on. It is normalized to epoch **milliseconds**.

### Commit metadata (per collected commit)

| Field | Type | Notes |
|-------|------|-------|
| author time | epoch ms | see above |
| subject | string | first line of the commit message |
| branch | string, optional | short branch name of the ref this commit was reached from during the all-refs traversal; absent when that ref is not a branch |

### Changed-files list (per collected commit)

The repo-relative, forward-slash-normalized paths the commit changed, **after** dropping any bookkeeping paths (see exclusion rules). Only "real" files remain.

### File→commits and basename→commits maps

- File map: repo-relative forward-slash path → the list of commits that touched it.
- Basename map: file basename (last path segment) → the list of commits that touched any file with that basename.

Both lists are sorted by author time **ascending**. Ascending order is a contract: the attributor walks a list forward to find the latest commit at or before a given time. Each list entry is a `{ author-time, hash }` pair.

### Short-branch reduction

Given a source ref string:
- A local-branch ref (`refs/heads/<name>`) reduces to `<name>`.
- A remote-tracking ref (`refs/remotes/<remote>/<name>`) reduces to `<name>` — the remote-name segment is dropped. A remote ref with no further segment reduces to nothing.
- Any other ref (tag, detached `HEAD`, etc.) reduces to nothing (absent branch).

## Behavior

### Building the index

1. Determine whether the product's orphan **summaries** ref exists in this repo.
2. Traverse the entire commit history reachable from **all** refs in a single pass, recording for each commit: its hash, its author time, the short branch of the ref it was reached from, its subject, and the list of paths it changed. When the summaries ref exists, that ref (and only that ref) is excluded from the traversal so its bookkeeping commits are never even visited.
3. For each commit, compute its "real" changed-files list by dropping bookkeeping paths (see exclusion rules).
4. **Include the commit as a target only when both hold:**
   - Its subject does **not** begin with the product's *add*-summary bookkeeping prefix (the phrase the product uses when it first records a `<prefix> <hash>: <message>` bookkeeping commit — these echo the original commit's message and would otherwise steal message/file matches). This test matches **only** that one add-variant prefix: the product also writes an *overwrite*-variant bookkeeping subject (same shape, a different leading verb) when it re-records a summary, and that variant is **not** matched by this rule — such a commit is excluded only if it independently fails the non-empty-real-files test below. In practice bookkeeping commits touch only orphan-branch paths, so the real-files test catches them; the subject test alone does not.
   - Its real changed-files list is non-empty (i.e. the commit changed at least one non-bookkeeping file).
   A commit failing either test is skipped entirely: no metadata, no file-map entries.
5. For each included commit, record its metadata and changed-files list, and append its `{ author-time, hash }` pair to the file map (under each real path) and the basename map (under each real basename).
6. After all commits are processed, sort every file-map and basename-map list by author time ascending.

If the history traversal fails, the index is returned empty (all four structures empty) rather than throwing.

### Bookkeeping-path exclusion rules

A changed path is "bookkeeping" (dropped from the real-files list, and used to detect all-bookkeeping commits) when it is either:
- One of the fixed bookkeeping catalog/index filenames at the repo root, or
- Under one of the fixed orphan-branch content prefixes (the summaries, transcripts, plans, plan-progress, notes, and linear-issues directories).

A commit whose *every* changed path is bookkeeping ends up with an empty real-files list and is therefore excluded (rule 4).

### Attribution lower-bound query

Given a target commit's hash, its author time `T`, and a maximum look-back span:

1. Start the lower bound at `T − maxLookback` (the floor — a long-dormant file must not open an unbounded window).
2. For each of the commit's real files, find the **most recent commit time strictly earlier than `T`** among the commits that touched that file (using the ascending file map: walk forward keeping the last entry with time `< T`).
3. Raise the lower bound to the largest such earlier time found across all the commit's files.
4. Return the resulting lower bound.

This is "the last time any of this commit's files was committed before this commit," floored at the look-back cap. It gives the attributor a per-commit window floor so two consecutive commits touching overlapping files do not bleed conversation into each other.

## State Transitions

The index is a pure derived snapshot of history at build time; it holds no mutable state. History rewrites (squash/rebase) mean an original commit may be gone — pointing an edit of file F at the *current* commit that now carries F is the intended outcome, since that is where the work now lives.

## Notable Behavior

- **Author time, not commit time.** The whole index is keyed on author time so it stays aligned with rebased/amended history and with when transcript edits actually occurred. (Notable.)
- **The product's own bookkeeping commits are excluded — but the two rules are not equally reliable.** The subject-prefix test matches only the *add*-variant bookkeeping phrase, not the *overwrite* variant; the real-files test independently drops any commit whose entire diff is orphan-branch content. Because bookkeeping commits touch only orphan paths, the real-files test is the one that actually catches them all; the subject test is a narrower belt-and-suspenders that misses the overwrite variant. (Notable.)
- **The summaries ref is excluded from the traversal itself**, but only when it exists — so a fresh repo with no summaries ref traverses cleanly without a dangling exclusion. (Notable.)
- **A commit that changed only bookkeeping files is not a target**, even though it exists in history — it can never be something a human conversation was about. (Notable.)
- **Lower bound is per-file "previous commit," capped.** A brand-new file (no earlier commit) contributes nothing above the floor, so its window opens at `T − maxLookback`; a frequently-touched file tightens the window to its own last commit. (Notable.)
- **Ascending sort is load-bearing**, not cosmetic: the lower-bound walk and the attributor's cursor slicing both rely on time-ascending order.

## Unreachable / Not-live

None in this topic — every branch above is reachable from the index build or the lower-bound query.

## Shared Behavior

- The maximum look-back span used by the lower-bound query is the same span the attribution algorithm caps its windows at (see **Back-fill Commit Attribution Algorithm**) and the same margin the engine uses to gather cursor-boundary neighbors (see **Back-fill Engine Orchestration**).
- Path normalization to forward-slash form is the product-wide path convention shared by all storage and matching code.
- The orphan-branch content prefixes and bookkeeping filenames are the same set defined by the storage layer.
