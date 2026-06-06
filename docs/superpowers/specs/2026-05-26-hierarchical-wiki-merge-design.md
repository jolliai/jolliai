# Hierarchical wiki merge — full-coverage `_wiki/`

## Motivation

The 2026-05-26 `--all` spec kept the cross-branch wiki merge capped at the
LRU top-20 branches by mtime, on the rationale that the merge is "a single
LLM call whose prompt size scales with branch count". With 64K output
ceilings (`MERGE_MAX_TOKENS`) and streaming guardrail handling already in
place, the constraint is now per-call, not per-merge-operation. A two-level
merge lifts the cap without raising any single LLM call's input.

The user-visible consequence of the old cap: in a repo with more than 20
branches, `<kbRoot>/_wiki/` only ever reflected the 20 most-recently-compiled
branches, and because each merge wholesale-wipes and rebuilds `_wiki/`, the
long-tail branches were permanently absent from the wiki (their per-branch
`compiled/<branch>.json` caches remained searchable, but the synthesized wiki
never covered them). Hierarchical merge makes the wiki a true full-coverage
synthesis.

## Surface

No CLI flag changes. The change is transparent:

- `jolli compile --all --merge` — now merges **every** branch with a
  compiled cache, not the top-20.
- `jolli compile --merge` — now rebuilds the wiki from **every** compiled
  cache on disk, not the top-20.
- The auto-merge path in `QueueWorker.runCompileMergeFromQueue` (PostCommitHook
  driven) — same.

A new constant `HIERARCHICAL_BATCH_SIZE = 20` lives in `KnowledgeCompiler.ts`.
It is the batch size used to split work into level-1 merges. Each level-1
call sees ≤ `HIERARCHICAL_BATCH_SIZE` branches' worth of compiled topics,
exactly matching the empirical safety envelope of the prior flat-merge cap.

## Design

Two new exports in `cli/src/core/KnowledgeCompiler.ts`:

- `mergeOfMerges(level1Results, config, cwd)` — the level-2 merger. Takes the
  `MergedKnowledge` outputs of level-1 batch merges, formats each as a
  `"Batch i/n"` labeled block (reusing the `formatTopicsForMerge` helper), and
  runs one `merge`-action LLM call. The result's `branches` is the sorted union
  of all inputs' branches; `sourceCompiledFingerprints` and `sourceCompilations`
  are the flattened concatenation of all inputs'.

- `mergeBranchesHierarchical(branches, config, cwd)` — the orchestrator. The
  single entry point all three callers use:
  - `N <= HIERARCHICAL_BATCH_SIZE`: delegate to flat `mergeBranches` (1 LLM
    call). Identical to pre-hierarchical behavior.
  - `N > HIERARCHICAL_BATCH_SIZE`: sort branches by name, chunk into batches,
    run `mergeBranches` per batch (level 1), then `mergeOfMerges` over the
    level-1 results (level 2). Total LLM calls: `ceil(N/B) + 1`.

## Invariants

- **Output shape parity.** `mergeBranchesHierarchical(allBranches, ...)`
  returns a `MergedKnowledge` indistinguishable in shape from a hypothetical
  flat `mergeBranches(allBranches, ...)`. `branches` is the sorted union,
  `sourceCompiledFingerprints` is the flattened union, on-disk path is the
  same `compiled/merged/<sha256(canonical-branches)>.json` (because
  `buildMergeSlug` hashes the sorted branch set). `FolderStorage.generateWikiPages`
  and `CacheValidator` see no shape difference and need no changes.
- **Deterministic batching.** Branches are sorted by name before chunking,
  so the same input set always produces the same batch composition across
  runs and machines. Level-1 artifacts are addressable + cacheable per batch.
  (mtime is no longer used for selection — every branch participates.)
- **Fast path preserved.** When `N <= HIERARCHICAL_BATCH_SIZE`,
  `mergeBranchesHierarchical` delegates directly to flat `mergeBranches`.
  Small repos pay no overhead and behave identically.
- **Fail-loud on truncation.** A `max_tokens` stop reason at either level
  returns `null`. Partial merges are never persisted. Matches the existing
  flat-merge guard. The orchestrator aborts the whole merge if any level-1
  batch returns null.

## What is explicitly out of scope

- Adaptive batch size (shrink-on-retry after truncation). Future work.
- Topic-level caching across batches (level-1 reuse when only one batch's
  underlying compiled artifacts changed). Level-1 results are currently
  in-memory intermediates (`mergeBranches(..., { persist: false })`) — they are
  NOT written to `compiled/merged/`, so there is no on-disk level-1 cache to
  reuse yet. Persisting them under batch slugs (with wiki generation suppressed)
  is the natural extension if cross-run batch caching is wanted. Tracked
  separately.
- A dedicated LLM prompt template for level-2. The level-2 call reuses the
  same `merge` action with each input formatted as a `"Batch i/n"` labeled
  block. If quality measurement shows level-2 needs different guidance, that
  is a prompt-engineering follow-up, not a structural one.
- Parallel level-1 batch execution. Batches run sequentially to avoid LLM
  rate-limit storms and keep the detached-worker logs readable.
