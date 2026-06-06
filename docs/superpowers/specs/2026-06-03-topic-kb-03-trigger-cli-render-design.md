# Topic KB — Sub-project 3: Trigger Integration, CLI & Wiki Render

**Date:** 2026-06-03
**Status:** Design approved; ready for implementation-plan.
**Parent:** [Topic-Centric Knowledge Base — Architecture & Decomposition](2026-06-02-topic-centric-knowledge-base-design.md)
**Builds on:** [SP1 — Data Model](2026-06-02-topic-kb-01-data-model-timeline-design.md), [SP2 — Ingest Pipeline](2026-06-03-topic-kb-02-ingest-pipeline-design.md)

---

## 1. Purpose

Make the topic-KB ingest pipeline (SP2) run automatically and on demand, and render the human-browsable `_wiki/` layer from topic pages:

- **Cut over** the post-merge / recall-miss triggers from the old per-branch compile + cross-branch merge to a single repo-wide **ingest** operation.
- **Reshape `jolli compile`** to `compile` (= ingest pending) and `compile --rebuild` (= reset + replay).
- **Render `_wiki/`** from topic pages after each ingest, on folder-capable storage only.

## 2. Decisions (locked in brainstorming)

- **Direct cutover.** SP3 stops enqueuing the old branch-compile / compile-merge ops and enqueues `ingest` instead. Recall (still reading per-branch artifacts) degrades until SP4 — accepted; recall is de-prioritized.
- **Single repo-wide ingest op** replaces (N branch-compile ops + 1 merge op).
- **Per-cwd ingest cooldown, 5 minutes** (debounce), in a new `ingest-cooldown.json`, `--force`-overridable.
- **CLI:** `jolli compile` = `drainIngest`; `jolli compile --rebuild` = reset + replay. Old `--all`/`--merge`/`--force`*(repurposed)*/`[branches...]` removed.
- **Wiki render:** full rebuild (wipe + rewrite all topic pages) after `drainIngest`, folder-capable storage only.

## 3. Out of scope

- Recall changes. (Original SP4 "re-point recall at the topic KB" is **cancelled** — see parent spec §4.4.) Recall keeps its raw per-branch summary path; the dormant compiled-layer calls it still makes are stripped in SP5.
- Removing the now-dormant branch-compile/merge code (`compileBranch`, `mergeBranches…`, `runCompileFromQueue`, `runCompileMergeFromQueue`, `CompileOperation`/`CompileMergeOperation`, `MergeTrigger`) — SP5. SP3 leaves them present but **unreferenced by any enqueue site**.
- History backfill (SP5) — though `compile --rebuild` provides a manual full replay now.

## 4. Trigger cutover

### 4.1 New queue operation

`Types.ts`: add `IngestOperation { type: "ingest"; triggeredBy: "post-merge" | "recall-miss" | "manual"; createdAt: string }` to the `GitOperation` union; add `isIngestOperation(op): op is IngestOperation`. Repo-wide — no `branch` field.

`QueueWorker.processQueueEntry`: add a top-level branch (beside `isCompileOperation`/`isCompileMergeOperation`) — `if (isIngestOperation(op)) { await runIngestFromQueue(op, cwd); return; }`.

`runIngestFromQueue(op, cwd)`: load LLM config (same credential-missing silent-skip as `runCompileFromQueue`), call `drainIngest(cwd, config)`, then render the wiki (§6.3). No merge fan-out.

### 4.2 New trigger module — `IngestTrigger.ts`

Mirrors `MergeTrigger` (per-cwd cooldown), not `BackgroundCompileTrigger` (per-branch):

- `ingest-cooldown.json` holding `{ lastIngestedAt: ISO8601 }`; `INGEST_COOLDOWN_MS = 5 * 60 * 1000`.
- `isIngestWithinCooldown(cwd, now?)`, `markIngestTouched(cwd, now?)`.
- `enqueueIngestOperation(cwd, triggeredBy, opts?: { force?: boolean })`: skip if within cooldown (unless `force`); else build the `IngestOperation`, `enqueueGitOperation(op, cwd)`, `markIngestTouched(cwd)`. (Dedup: if an `ingest` op is already queued, do not add a second — a single pending ingest drains everything.)

### 4.3 Repointed sites

| Site | Was | Becomes |
|---|---|---|
| `PostMergeHook.handlePostMerge` (per-branch loop, ~L90-92) | `enqueueCompileOperation(branch, "post-merge", cwd)` per merged branch | one `enqueueIngestOperation(cwd, "post-merge")` (drop the per-branch loop) |
| `BackgroundCompileTrigger` / `ContextCompiler` recall-miss (`ContextCompiler.ts:401`) | `triggerBackgroundCompile(branch, cwd, "recall-miss")` → `enqueueCompileOperation` | `enqueueIngestOperation(cwd, "recall-miss")` (branch arg dropped) |
| `QueueWorker.runCompileFromQueue` post-compile fan-out (~L549-550) | `enqueueCompileMergeOperation(cwd, "post-compile")` | **removed** (no branch compile → no fan-out) |

`BackgroundCompileTrigger`'s recall-miss entry can either be repointed internally or bypassed by `ContextCompiler` calling `enqueueIngestOperation` directly. **Decision:** repoint inside `BackgroundCompileTrigger` so its existing cooldown/test surface is reused; rename its public function to reflect ingest, or keep the name and swap the body (finalize in plan — prefer keeping `ContextCompiler`'s call site stable).

`PostCommitHook` is unchanged — it only enqueues the commit op and never triggered compile.

## 5. CLI reshape — `CompileCommand.ts`

```
jolli compile            → drainIngest(cwd, config) then render wiki; print {batches, ingested, touched}
jolli compile --rebuild  → reset: clear processed.json + every topics/<slug>.json + index.json,
                           then drainIngest from scratch, then render. Confirms count rebuilt.
```

- Remove `[branches...]`, `--all`, `--merge`, `--force`. The CLI path calls `drainIngest` directly (it never goes through the queue cooldown), so a cooldown-bypass flag would be meaningless here — the cooldown only gates the auto-enqueued (`IngestTrigger`) path.
- API-key guard unchanged (error if no key).
- `--rebuild` reset writes `emptyProcessedSet` (`ProcessedSourceStore`) + `emptyTopicIndex` (`TopicIndexStore`). **No page deletion** — there is no general delete primitive on `StorageProvider`, and none is needed: with an empty index the route step treats every topic as new, so reconcile rebuilds pages from scratch (`current=null`) and `saveTopicPage` overwrites same-slug files; index-driven render/recall (see §6.3) ignore any orphaned old page files.

## 6. Wiki render

### 6.1 Shape-agnostic render core — `WikiMarkdownBuilder.ts`

Refactor `renderTopic(topic: CompiledTopic, merged: MergedKnowledge, ctx)` → keep it as a thin wrapper delegating to a new `renderTopicImpl(topic: CompiledTopic, branches: string[], lastUpdatedAt: string, ctx: WikiRenderContext): string` (the only `merged` fields used are `branches` and `mergedAt`). No behavior change for the existing branch-merge path (SP5 deletes that path).

### 6.2 `StorageProvider.renderTopicWiki?` (new optional method)

Add `renderTopicWiki?(pages: ReadonlyArray<TopicPage>): Promise<void>` to the `StorageProvider` interface:

- `FolderStorage.renderTopicWiki` — implements it: `wipeWikiArtifacts` + `buildWikiRenderContext`, then for each `TopicPage` render via `renderTopicImpl(asCompiledTopic(page), page.relatedBranches, page.lastUpdatedAt, ctx)` → write `_wiki/topic--<slug>.md`, plus `_wiki/_index.md`, tracking manifest `type:"wiki"` (mirrors `generateWikiPages`).
- `DualWriteStorage.renderTopicWiki` — delegates to its inner `FolderStorage`.
- `OrphanBranchStorage` — does **not** implement it (orphan-only → render is a no-op, callers use `storage.renderTopicWiki?.(pages)`).

`asCompiledTopic(page: TopicPage): CompiledTopic` maps `{ title, stableSlug, content, relatedBranches, sourceCommits: <commit-type sourceRefs ids> }`. `TopicPage` has no `keyDecisions` → omit (the topic page's content already carries decisions). Live in `WikiMarkdownBuilder.ts` or a small adapter.

### 6.3 Render invocation

After `drainIngest` completes (in `runIngestFromQueue` and the `jolli compile` CLI path): read the pages named by the **authoritative `index.json`** (`readTopicIndex` → `readTopicPage` per entry — NOT a directory scan, so orphaned page files are excluded) and call `await storage.renderTopicWiki?.(pages)`. Full rebuild each time — handles deleted/renamed topics, no stale-file tracking. Skip when `renderTopicWiki` is absent (orphan-only).

## 7. Components / files

| File | Change |
|---|---|
| `cli/src/Types.ts` | add `IngestOperation` + `isIngestOperation`; extend `GitOperation` |
| `cli/src/core/IngestTrigger.ts` | new — cooldown + `enqueueIngestOperation` |
| `cli/src/hooks/QueueWorker.ts` | dispatch `isIngestOperation` → `runIngestFromQueue` (drain + render); remove compile→merge fan-out |
| `cli/src/hooks/PostMergeHook.ts` | replace per-branch compile enqueue with one ingest enqueue |
| `cli/src/core/BackgroundCompileTrigger.ts` | repoint recall-miss to enqueue ingest |
| `cli/src/commands/CompileCommand.ts` | reshape to `compile` + `--rebuild` |
| `cli/src/core/WikiMarkdownBuilder.ts` | add `renderTopicImpl` core + `asCompiledTopic` adapter; `renderTopic` becomes wrapper |
| `cli/src/core/StorageProvider.ts` | add optional `renderTopicWiki?` |
| `cli/src/core/FolderStorage.ts` | implement `renderTopicWiki` |
| `cli/src/core/DualWriteStorage.ts` | delegate `renderTopicWiki` |
| `cli/src/core/TopicWikiRenderer.ts` | new — `renderTopicKBWiki(cwd, storage)` reads index-named pages → `storage.renderTopicWiki?` |

## 8. Testing (CLI floor: 97% stmt / 96% br / 97% fn / 97% line)

- `IngestTrigger`: cooldown gates a second enqueue; `force` bypasses; dedup when an ingest op already queued; `markIngestTouched` round-trips.
- `QueueWorker`: an `ingest` op routes to drain+render; credential-missing skips silently; no merge fan-out remains for the ingest path.
- `PostMergeHook`: a merge enqueues exactly one ingest op (not N compile ops).
- `CompileCommand`: `compile` calls drain+render; `--rebuild` clears stores then drains; no-key guard.
- `WikiMarkdownBuilder`: `renderTopicImpl` output unchanged vs the old `renderTopic` for the same inputs (golden test); `asCompiledTopic` maps fields correctly.
- `FolderStorage.renderTopicWiki`: writes `_wiki/topic--<slug>.md` + `_index.md`, wipes stale pages from a prior render, registers manifest `type:"wiki"`; `DualWriteStorage` delegates; orphan-only path is a no-op.
- `TopicPageStore.deleteAllTopicPages`: removes only topic pages, not index/processed.

## 9. Risks / explicit trade-offs

- **Recall loses its compiled-density layer** (accepted; SP4 cancelled 2026-06-04). Once the trigger cuts over, per-branch compiled artifacts stop being refreshed, so `validateCache` returns stale/miss and recall falls back to its raw per-branch summaries/plans/notes path (its long-standing pre-compile behavior). Recall is **not** re-pointed at the topic KB — that data shape is unsuitable for branch-scoped recall (see parent spec §4.4). The dormant `compiledTopics`/`validateCache` calls in `ContextCompiler` are stripped in SP5.
- **Dormant old code until SP5.** `compileBranch`/`mergeBranches…`/`runCompileFromQueue`/`runCompileMergeFromQueue`/`MergeTrigger`/`CompileOperation`/`CompileMergeOperation` remain compiled but unreferenced by enqueue sites. They keep their tests green; SP5 removes them. (A queued compile/compile-merge op authored before upgrade still drains via the old handlers — backward-safe.)
- **Cooldown window (5 min)** is a guess; tune after dogfooding. `--force` / CLI path bypass it.
- **Full wiki rebuild** re-renders every page each ingest. No LLM, pure JSON→markdown; bounded by topic count. Accepted over incremental + stale-tracking.
