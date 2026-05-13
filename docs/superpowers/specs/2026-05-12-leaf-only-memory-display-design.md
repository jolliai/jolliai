# Leaf-Only Memory Display — Cleanup Visible `.md` Files After Amend / Rebase

**Date:** 2026-05-12
**Status:** Approved for implementation
**Branch:** `fix-change-other-repo-memory`

## Background

After `git commit --amend` or interactive rebase reorders a chain of related commits, the user ends up with three views in Jolli that show different counts of the "same" memory:

| View | Source | Count for a 5-amend chain |
|---|---|---|
| Memory Bank tree (folder browse) | enumerates `<localFolder>/<repo>/<branch>/*.md` on disk | 5 |
| Timeline / KB Memories list | `JolliMemoryBridge.listSummaryEntries` (current filter: `parentCommitHash != null` + dedup by `commitHash`, sorted by date) | 2 (only chain roots) |
| Branch tab Memories — workspace mode | `JolliMemoryBridge.listBranchCommits` → `git log mergeBase..HEAD` enriched with index | 1 (only the commit on HEAD) |
| Branch tab Memories — foreign mode | `JolliMemoryBridge.listBranchMemories` (no parent filter) | 5 |

Each view's behavior is documented and intentional, but the inconsistency is confusing. The user's intent: **all three views should agree, showing only the tip of each chain — the surviving commit after amend / rebase.**

The archive layers (the orphan branch `jollimemory/summaries/v3` and the hidden `<localFolder>/<repo>/.jolli/` JSON store) remain a permanent record. Only the *visible* layer changes.

## Goals

- **Display alignment.** Memory Bank tree, Timeline / KB Memories list, and Branch tab Memories all show exactly one row per `(branch, chain)` — the chain's leaf.
- **Disk alignment.** Visible Markdown files under `<localFolder>/<repo>/<branch>/*.md` contain only chain leaves. Stale `.md` files from amended-away commits are deleted on the next QueueWorker pass and during a one-shot startup migration that drains the existing backlog.
- **Archive preservation.** The orphan branch and the hidden `.jolli/` JSON store (summaries, transcripts, index) keep every revision in the chain. Nothing in this design touches them.

## Non-goals

- Self-healing missing leaf `.md` files (current dual-write blind spot — out of scope).
- A "trash quarantine" with N-day retention for deleted `.md` files (delete is happy-path lossy; archive layers remain the recovery surface).
- Changes to the orphan branch / `.jolli/index.json` schema. The chain relationship (`parentCommitHash`) already exists; this design only adds a derived filter on top.
- IntelliJ plugin parity. The Kotlin port has its own read paths; pinning the contract for CLI + VS Code first, IntelliJ catches up in a separate work item.

## Design decisions (locked)

1. **Cleanup scope.** Delete *only* the visible `<branch>/<slug>-<hash8>.md` layer. The orphan branch and `<repo>/.jolli/` (summaries, transcripts, plans, notes, `index.json`) stay intact.
2. **Existing data.** One-shot migration at extension / CLI startup drains the backlog; QueueWorker maintains the invariant going forward.
3. **Leaf definition.** Per `(repoName, branch)` scope. A `SummaryIndexEntry` `e` is a leaf iff there is **no other entry `e'` with the same `repoName` and `branch` such that `e'.parentCommitHash === e.commitHash`**. Cross-branch `parentCommitHash` links (rebase-pick `c1` from branch X to branch Y producing `c1'`) do **not** demote `c1` to non-leaf when viewed under branch X. Cross-repo links similarly do not cross repo boundaries. Each `(repo, branch)` judges its own tips.
4. **Implementation slicing.** Single PR (Approach A). All five workstreams ship together so there is no observable inconsistency window.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Display layer  (3 read surfaces — all leaf-only)        │
│   • Memory Bank tree (folder browse)                     │
│   • Timeline / KB Memories list                          │
│   • Branch tab Memories (workspace + foreign)            │
└────────────────────┬────────────────────────────────────┘
                     │ reads via
                     ▼
┌─────────────────────────────────────────────────────────┐
│ ChainLeafFilter  (new, single source of truth)          │
│   getBranchLeaves(entries) → Set<commitHash>             │
└────────────────────┬────────────────────────────────────┘
                     │ called by
       ┌─────────────┼─────────────┬──────────────┐
       ▼             ▼             ▼              ▼
  listSummary    listBranch    Migration     QueueWorker
   Entries       Memories      v2 step       incremental
                                                cleanup
                                ▼              ▼
                        ┌──────────────────────────┐
                        │ FolderStorage            │
                        │   deleteVisibleMarkdown  │  (new, narrow API)
                        └──────────────────────────┘
                                ▼
                  <localFolder>/<repo>/<branch>/*.md
                  (only leaves remain on disk)

  Archive (untouched):
  • orphan branch jollimemory/summaries/v3
  • <localFolder>/<repo>/.jolli/summaries/<hash>.json
  • <localFolder>/<repo>/.jolli/transcripts/<hash>.json
  • <localFolder>/<repo>/.jolli/index.json
```

## Components

### 1. `ChainLeafFilter` (new, `cli/src/core/ChainLeafFilter.ts`)

Pure function. Two exported helpers:

```ts
/** Returns the set of commitHashes that are leaves of their chain on their branch. */
export function getBranchLeaves(
  entries: Iterable<SummaryIndexEntry>,
): Set<string>;

/** Convenience: returns only the entries whose commitHash is a branch leaf. */
export function filterToBranchLeaves<T extends SummaryIndexEntry>(
  entries: Iterable<T>,
): T[];
```

**Algorithm** (linear, two-pass):

```
1. byScope: Map<(repoName ?? '') + '\0' + branch, SummaryIndexEntry[]>
       ← group entries by (entry.repoName, entry.branch)
2. for each (scope, list) in byScope:
     parentedInScope = { e.parentCommitHash for e in list if e.parentCommitHash != null }
     for each e in list:
         if e.commitHash NOT in parentedInScope:
             leaves.add(e.commitHash)
3. return leaves
```

**Why scope on `(repoName, branch)`, not branch alone:** the same branch name (`main`, `feature/x`) frequently exists across repos. Grouping by `branch` alone would let entries from repo A demote entries from repo B (or vice-versa) when their parent / child relationships happen to land on the same hash. Scoping on the tuple keeps each repo's chains independent — same algorithm, narrower scope. For single-repo inputs (entries without `repoName`, e.g. the bare result of `getIndexEntryMap` before `listSummaryEntries`'s merge step), `repoName ?? ''` degenerates to one repo-scope and the behavior is identical to single-repo branch grouping.

Cycle safety: a malicious / corrupted index where `parentCommitHash` forms a loop (`a→b, b→a` in the same `(repoName, branch)` scope) means **neither** `a` nor `b` is a leaf (each is parented by the other in scope). That collapses an entire cycle to zero displayed rows; acceptable — bad data hides itself rather than crashing the renderer. Documented in the function header.

Used by:
- `JolliMemoryBridge.listSummaryEntries` (replaces existing `parentCommitHash != null` filter; the dedup by `commitHash` stays because cross-repo aliasing is orthogonal to chain collapse).
- `JolliMemoryBridge.listBranchMemories` (current path has no filter; adds this one).
- `MigrationEngine` v2 step.
- `QueueWorker.cleanupBranchVisibleMarkdown` (new step, see below).

### 2. `FolderStorage.deleteVisibleMarkdown` (new method, `cli/src/core/FolderStorage.ts`)

```ts
/**
 * Removes only the visible Markdown file at <kbRoot>/<branch>/<slug>-<hash8>.md.
 * Does NOT touch .jolli/summaries/<hash>.json, .jolli/index.json, or the orphan
 * branch. Idempotent: a missing file is not an error.
 */
async deleteVisibleMarkdown(entry: SummaryIndexEntry): Promise<void>;
```

- Recomputes the same path that `FolderStorage` uses to *write* the visible md (slug derivation via `FolderStorage.slugify()`, `<hash8>` suffix). If the slug derivation changes in the future, this stays in lockstep because both writer and deleter share the same private helper.
- `ENOENT` swallowed (idempotent). Other errors propagate.
- Leaves the `<branch>/` directory in place even if it becomes empty (avoids ENOENT race with the next write).

### 3. `MigrationEngine` v2 step (extend `cli/src/core/MigrationEngine.ts`)

Adds a new step run after the existing v1 (dual-write enablement) migration.

**Trigger:** Extension `activate()` and CLI commands that hit `MigrationEngine.runMigration` (existing entry points). Idempotent.

**Logic:**

```
for each repo discovered under localFolder (current + foreign):
    map = read .jolli/index.json into SummaryIndexEntry list
    leaves = ChainLeafFilter.getBranchLeaves(map.values())
    for each entry where entry.commitHash ∉ leaves:
        FolderStorage.deleteVisibleMarkdown(entry)
write metadata { v2: { completedAt: <iso> } }
```

**State file:** Extend `MetadataManager`'s migration-state object with a `v2` block. A repo with `v2.completedAt` set is skipped on subsequent boots. Forced re-run (manual `v2` reset) is a no-op against an already-leaf-only disk.

**Failure mode:** If a delete throws (non-ENOENT), the step logs and continues — partial cleanup is fine because the next boot resumes and is idempotent. `completedAt` is written only when the whole repo finishes without exceptions.

### 4. `QueueWorker.cleanupBranchVisibleMarkdown` (new step, `cli/src/hooks/QueueWorker.ts`)

A single new step appended to every op-pipeline tail (post-commit, amend, rebase-pick, rebase-squash, squash). Receives `branch: string`, performs:

```
entries = getIndexEntryMap(cwd, storage).values().filter(e => e.branch === branch)
leaves = ChainLeafFilter.getBranchLeaves(entries)
for each entry where entry.commitHash ∉ leaves:
    FolderStorage.deleteVisibleMarkdown(entry)
```

**Why uniform across op types:** the cleanup is purely a function of the index's current state, not which op produced it. Sharing one step means the four pipelines all converge on the same invariant. The migration v2 step calls the same code module (different scope: iterates branches under a repo).

### 5. Read-path filter replacements (`vscode/src/JolliMemoryBridge.ts`)

**`listSummaryEntries`** — current:

```ts
this.cachedRootEntries = merged
    .filter((e) => {
        if (e.parentCommitHash != null || seen.has(e.commitHash)) return false;
        seen.add(e.commitHash);
        return true;
    })
    .sort(...);
```

→ replaces the `parentCommitHash != null` rejection with `ChainLeafFilter.filterToBranchLeaves`. Because the merge step already stamps `repoName` onto every entry before this filter runs, `ChainLeafFilter` groups correctly on `(repoName, branch)`. Dedup by `commitHash` stays — it handles a different concern (cross-repo tree-hash aliasing collapses the same physical commit appearing under two repos).

**`listBranchMemories`** — current returns every matching `entry.branch === branchName`. Wraps the iteration in `ChainLeafFilter.getBranchLeaves(entries)` and filters to those.

**No display-layer change.** Webview and tree provider stay agnostic; once the bridge returns leaf-filtered lists, the existing renderers do the right thing.

### 6. `KbFoldersService.listChildren` (no code change)

Reads disk. Migration + worker incremental cleanup guarantee the disk only contains leaf `.md` files. No filter needed.

### 7. CLI parity audit (verify, expected zero code change)

CLI commands (`jolli search`, `jolli list`, etc.) read through `SummaryStore` / `getIndexEntryMap` — the same modules `JolliMemoryBridge` uses. Filter replacements in shared code propagate automatically. The audit step is a grep + spot-check to confirm no command bypasses the shared read path.

## Data flow (example: user makes 5 amends)

```
Each `git commit --amend` fires post-commit hook → QueueWorker enqueue.

Per op the worker now runs:
  1. (existing) generate summary for new HEAD
        → orphan: commit-tree linking parent
        → .jolli/summaries/<new>.json
        → <branch>/<slug>-<new8>.md
        → .jolli/index.json append (parent = old hash)
  2. (NEW) cleanupBranchVisibleMarkdown(branch)
        → read index entries for this branch
        → ChainLeafFilter.getBranchLeaves
        → for each non-leaf: FolderStorage.deleteVisibleMarkdown
        → disk converges to leaf-only

After 5 amends:
  orphan:                 5 commits        ← archive intact
  .jolli/summaries/*.json: 5 files          ← archive intact
  .jolli/index.json:       5 entries (c5 leaf, chain c5→c4→c3→c2→c1)
  <branch>/*.md:           1 file (c5)      ← cleaned
  Memory Bank tree:        1 row            ← disk
  Timeline:                1 row            ← ChainLeafFilter
  Branch tab workspace:    1 row            ← git log
  Branch tab foreign:      1 row            ← ChainLeafFilter
```

## Edge cases

1. **Rebase pick `c1` (branch X) → `c1'` (branch Y).** Leaf-by-branch keeps `c1` as a leaf under X (no entry on X parents `c1`) and `c1'` as a leaf under Y. Two branches, two leaves. ✓
2. **Squash N commits → 1 commit.** The existing LLM-driven `generateSquashConsolidation` pipeline creates the new entry with `parentCommitHash` referencing the chain it absorbed. The new cleanup step deletes the N old `.md` files; the squashed commit's `.md` survives. ✓
3. **Migration idempotency.** Per-repo `v2.completedAt` gate; deletes are idempotent. Re-running against a leaf-only disk is a no-op.
4. **Migration mid-run crash.** `completedAt` written only after success. Next boot re-scans. `deleteVisibleMarkdown` ignores `ENOENT`.
5. **User manually deleted a leaf's `.md`.** Cleanup does not restore (current dual-write blind spot — out of scope per non-goals). Recovery: rerun migration or trigger any new amend (dual-write recreates the leaf md on next write).
6. **Concurrent worktree amends.** QueueWorker's existing 5-minute file lock serializes; cleanup runs inside the lock.
7. **Empty `<branch>/` directory after cleanup.** Left in place. Avoids ENOENT race with the next write into that branch.
8. **Cross-repo foreign view.** Foreign-repo read path already instantiates `FolderStorage` against the target `kbRoot` and reads its `index.json` — `ChainLeafFilter` works without git context. ✓
9. **Corrupted `parentCommitHash` (loop, dangling pointer).** Loop → all loop members lost to display (both parent each other). Dangling pointer → child is leaf normally; orphan entry treated as a root. Documented in `ChainLeafFilter`. No crash.
10. **Branch rename / deletion in git after memories were recorded.** `entry.branch` is whatever the worker captured at commit time. Cleanup keys off the stored branch string, not the live git ref — orphaned branch directories (`<old-branch>/`) keep their leaves intact (a separate housekeeping concern).

## Testing strategy

| Layer | Type | Coverage |
|---|---|---|
| `ChainLeafFilter` | unit (cli) | single chain / parallel chains / cross-branch isolation / dangling parent / cycle (a↔b) / empty input / single entry |
| `FolderStorage.deleteVisibleMarkdown` | unit (cli) | file exists → removed; file missing → no-op; .jolli/-side file with same hash → untouched; subdir contents undisturbed |
| `MigrationEngine` v2 step | integration (vscode) | fresh repo no-op; existing chain converges; multiple branches each converge; `v2.completedAt` gate respected; partial-failure restart |
| `QueueWorker` incremental cleanup | integration (cli) | post-amend / post-rebase-pick / post-squash / post-rebase-squash each result in correct disk state; cross-branch op leaves the other branch's `.md` files alone |
| `listSummaryEntries` filter | unit (vscode bridge) | clean chain `c1(root)→c2→c3`: old filter returned `c1` (root with `parent==null`), new filter returns `c3` (leaf). This intentional behavior flip is the headline change — the Timeline / KB Memories list now reflects the *latest* commit of each chain rather than the original. Dangling-parent chain (`c1` removed from index, `c2→c3` remain): old returned empty, new returns `c3`. |
| `listBranchMemories` filter | unit (vscode bridge) | foreign view returns leaves only; cross-branch rebase-pick keeps both branches' leaves visible |

CI gate: existing `npm run all` (CLI 97% coverage floor) plus the new tests above. Migration test uses tmpdir-rooted FolderStorage to avoid touching real `.jolli/`.

## Risks & rollback

- **Risk: bug in leaf computation hides legitimate entries from display.** Mitigation: archive layers untouched — flipping a single read path back to the prior filter recovers display while a fix is prepared. Hotfix surface is a single function.
- **Risk: migration deletes too aggressively.** Mitigation: deletes only target the visible `.md` layer; `.jolli/summaries/<hash>.json` and `index.json` retain the data needed to regenerate any `.md` via the existing dual-write writer path.
- **Risk: worker cleanup races with a manual disk edit.** Mitigation: existing 5-minute file lock; worker cleanup is the same scope as the rest of the pipeline (not a new lock domain).
- **Rollback plan:** revert the single PR. Existing chains regrow their visible `.md` files as soon as the next dual-write runs (each amend rewrites the new leaf's `.md` already; the orphaned older ones would not return — that asymmetry is acceptable because they are still present in `.jolli/` and the orphan branch).

## Implementation order (single PR — Approach A)

Within the PR, components land in this order so each diff is reviewable in isolation:

1. `ChainLeafFilter` + unit tests.
2. `FolderStorage.deleteVisibleMarkdown` + unit tests.
3. Replace `listSummaryEntries` / `listBranchMemories` filters; update existing bridge tests.
4. `MigrationEngine` v2 step + integration test.
5. `QueueWorker.cleanupBranchVisibleMarkdown` wired into op pipelines + integration tests.
6. CLI parity audit (grep + spot-check; expected zero code change).
7. Run `npm run all`, hand-verify against a real chain on a scratch repo.
