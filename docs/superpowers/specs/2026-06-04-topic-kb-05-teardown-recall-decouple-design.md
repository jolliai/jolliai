# Topic KB — Sub-project 5: Teardown & Recall Decoupling

**Date:** 2026-06-04
**Status:** Design approved; ready for implementation-plan.
**Parent:** [Topic-Centric Knowledge Base — Architecture & Decomposition](2026-06-02-topic-centric-knowledge-base-design.md)
**Builds on:** SP1–SP3 (data model, ingest pipeline, trigger+CLI+render). **SP4 cancelled** (see parent §4.4) — its recall decoupling folds into this sub-project.

---

## 1. Purpose

Remove the now-dormant branch-compile / cross-branch-merge code and decouple recall from the compiled-cache layer, leaving recall on its raw per-branch summary path. This is the final sub-project: pure deletion + decoupling.

## 2. Why this is pure subtraction (no migration / cleanup / backfill code)

- **Branch-compile was never released.** It exists only on `feature/knowledge-compilation`. No user has `compiled/<branch>.json` / `compiled/merged/*.json` artifacts, so there is **nothing to migrate or clean up in code**. (Local dev artifacts on the author's machine are deleted by hand, outside this work.)
- **Backfill already exists.** The topic KB starts empty (`processed.json` empty); the first `jolli compile` (SP3) folds all historical sources from scratch. SP5 adds **no** backfill mechanism — only a docs note that the first build is manual.
- **No pre-upgrade queue entries.** Because branch-compile shipped to nobody, there are no in-the-wild `compile`/`compile-merge` queue ops to stay backward-compatible with. The queue worker's dispatch branches + handlers can be deleted outright.

## 3. Scope

Delete dormant code; decouple `ContextCompiler`; keep everything SP1–SP3 reuse. **One behavior addition** (§11): a Memory Bank panel **toolbar button** that runs compile — the GUI entry point for the otherwise-manual backfill.

## 4. ⚠️ Name-collision hazard (read first)

`mergeBranches` exists **twice** with unrelated meaning:

- `cli/src/core/KnowledgeCompiler.ts` `mergeBranches` — cross-branch knowledge merge. **DELETE.**
- `cli/src/sync/AggregateMerge.ts` `mergeBranches(local, remote): BranchEntry[]` + its caller `cli/src/sync/ConflictResolver.ts` — sync conflict-resolution for `branches.json`. **DO NOT TOUCH.**

Target removals by **file path**, never by a bare symbol-name grep-and-delete.

## 5. Removal inventory (reference graph verified 2026-06-04)

| Delete | Where | Justification |
|---|---|---|
| `compileBranch`, `compileBranches`, `mergeBranches`, `mergeOfMerges`, `mergeBranchesHierarchical`, `fingerprintCompiled`, and the constants/helpers used only by them (`MERGE_MAX_TOKENS`, `COMPILE_MAX_TOKENS`, `HIERARCHICAL_BATCH_SIZE`, `formatCompiledForMerge`, `formatTopicsForMerge`, `formatUserKnowledgeForCompile`) | `cli/src/core/KnowledgeCompiler.ts` | SP3 stopped enqueuing; only the deleted QueueWorker handlers called them |
| Whole file | `cli/src/core/CompiledStore.ts` (+ `.test.ts`) | only KnowledgeCompiler-branch-code + CacheValidator + QueueWorker handlers use it |
| Whole file | `cli/src/core/CacheValidator.ts` (+ `.test.ts`) | only `ContextCompiler` uses it; gone after §6 |
| Whole file | `cli/src/core/MergeTrigger.ts` (+ `.test.ts`) | no enqueue caller after SP3 |
| Whole file | `cli/src/core/BackgroundCompileTrigger.ts` (+ `.test.ts`) | recall no longer triggers ingest (this sub-project's decision) |
| `CompileOperation`, `CompileMergeOperation`, `isCompileOperation`, `isCompileMergeOperation`; remove from `GitOperation` union; fix JSDoc at L138/L142 | `cli/src/Types.ts` | SP3 produces neither op |
| `runCompileFromQueue`, `runCompileMergeFromQueue`, and their two dispatch `if` branches in `processQueueEntry` | `cli/src/hooks/QueueWorker.ts` | dormant handlers |
| `generateWikiPages` + the `writeFiles` trigger that calls it on `compiled/merged/*.json` (L116) | `cli/src/core/FolderStorage.ts` | replaced by `renderTopicWiki` (SP3) |
| old `renderTopic(topic, merged, ctx)` wrapper + `renderIndex(merged, ctx)` | `cli/src/core/WikiMarkdownBuilder.ts` | only `generateWikiPages` used them |

## 6. Recall decoupling (`ContextCompiler.ts`)

Remove the compiled-cache layer so recall always uses raw summaries:

- Delete the imports + calls: `validateCache` (L13/L394), `triggerBackgroundCompile` (L12/L401, the recall-miss trigger), `buildCompiledTopics` (L412/L512).
- `compileTaskContext` collapses to the former **cache-miss path**: load ALL head summaries, build plans/notes/decisions/diff-stats/period from them. No `cacheStatus` branching.
- Remove `compiledTopics` from the `CompiledContext` return + from the `CompiledContext` type, and from every consumer that renders it (recall command / briefing). `commitCount` becomes simply `summaries.length` (the old miss-path value).
- `loadSummaries` simplifies to "load all head summaries" (drop the `cacheStatus`-driven stale/hit branches).
- Keep `userKnowledgeTopics` (Memory Bank surfacing) — unrelated to the compiled cache.

Net recall behavior: identical to the pre-compile product (raw per-branch summaries + plans + notes + decisions + user-knowledge), depending on **no** compiled/ingested artifact.

## 7. Keep-list (SP1–SP3 reuse — must survive)

- `KnowledgeCompiler.ts`: `parseCompileResponse`, `extractField`, `formatSummaryForCompile`, `normalizeSlug`/`slugifyTitle` (used by parse + SP2 `SourceContent`/`ReconciledPage`). **Filename unchanged** (renaming would churn SP2/SP3 imports for no functional gain).
- `WikiMarkdownBuilder.ts`: `renderTopicImpl`, `renderTopicKBIndex`, `topicPageToCompiledTopic`, `WikiRenderContext`.
- `FolderStorage.ts`: `renderTopicWiki`, `wipeWikiArtifacts`, `buildWikiRenderContext`, `atomicWrite`.
- All SP1 stores, SP2 pipeline, SP3 `IngestTrigger`/`TopicWikiRenderer`/`IngestOperation`.
- `MergedKnowledge`/`CompiledKnowledge` types: check post-removal references; delete only if **zero** live readers remain (the wiki render no longer needs `MergedKnowledge`; verify in plan).

## 8. Backfill (manual — CLI + a new GUI button)

The first build folds all history (SP3 `drainIngest` from an empty `processed.json`). Two manual entry points:
- **CLI:** `jolli compile` (SP3, already exists). One-line README/help hint that a fresh repo is built by running it once.
- **GUI:** a Memory Bank panel toolbar button (§11). Same in-process work as the CLI command.

No automatic-on-upgrade trigger (cost-controlled per the brainstorming decision).

## 9. Testing (CLI floor: 97/96/97/97)

- Delete the `.test.ts` files for every whole-file removal (CompiledStore, CacheValidator, MergeTrigger, BackgroundCompileTrigger).
- `KnowledgeCompiler.test.ts`: drop the compile/merge cases; keep `parseCompileResponse`/`extractField`/`formatSummaryForCompile` cases.
- `ContextCompiler.test.ts`: assert raw-summary output, no `compiledTopics`; remove cache-hit/stale assertions.
- `QueueWorker.test.ts`: remove compile/compile-merge dispatch cases; keep ingest + commit/squash/rebase cases.
- `FolderStorage.test.ts` / `WikiMarkdownBuilder.test.ts`: remove `generateWikiPages`/old-`renderTopic`/`renderIndex` cases; keep `renderTopicWiki`/`renderTopicImpl`/`renderTopicKBIndex`.
- **Gate:** `npm run all` green (modulo the known `GitClient`/`sync` flaky); coverage stays above floor (deleting code + its tests keeps the ratio; new code already covered by SP1–3).

## 10. Risks / explicit trade-offs

- **Wrong-symbol deletion** (§4) — the dual `mergeBranches`. Mitigated by path-targeted edits + the full gate (deleting the sync one would break `ConflictResolver` tests loudly).
- **Hidden live reader of a "dormant" symbol** — mitigated by the verified reference graph + `npm run typecheck` (an orphaned import fails the build) + `npm run all`.
- **Recall output change** — losing the `compiledTopics` density section is visible to anyone who used recall on a compiled branch during SP1–3 dogfooding. Accepted (parent §4.4 / §6); recall returns the raw-summary context it always produced on cache miss.
- **`MergedKnowledge`/`CompiledKnowledge` type churn** — if any non-deleted code still imports them, leave the type; only remove once orphaned. Verify in plan, don't assume.
- **VS Code bundles `cli/src`** (esbuild inlines it). A deletion that orphans a `vscode/src/**` import of a removed CLI symbol breaks the extension build. The reference graph was run over `cli/src` only — the plan must also grep `vscode/src` for the removed symbols. `npm run build` (which builds the vscode bundle) is the backstop: an orphaned import fails it loudly.

## 11. VS Code: Memory Bank panel toolbar "Build Knowledge Wiki" button

A toolbar icon button on the Memory Bank panel (`jollimemory.mainView` webview sidebar), mirroring **"Sync to Personal Space"** (`jollimemory.syncNow`) exactly. Codicons are available in the sidebar (it loads `codicon.css`), so no CSP concern (unlike the Settings webview).

**Wiring (mirror the sync-now path):**

1. **`vscode/package.json`** `contributes.commands` — add (after the `syncNow` entry, L227-231):
   ```json
   { "command": "jollimemory.compileNow", "title": "Build Knowledge Wiki", "icon": "$(database)", "category": "Jolli Memory" }
   ```
   (`$(database)` reads as "knowledge base"; `$(combine)` is the alt. Final icon is a one-token tweak — confirm in review.)

2. **`vscode/src/views/SidebarScriptBuilder.ts`** — add a toolbar item beside sync (L396) and its click case (L481):
   ```javascript
   items.push(iconButton('compile-now', 'Build Knowledge Wiki', 'database'));
   // ...
   } else if (action === 'compile-now') {
     vscode.postMessage({ type: 'command', command: 'jollimemory.compileNow' });
   ```

3. **Host command** — register `jollimemory.compileNow` (a `CompileCommands.ts` mirroring `sync/SyncCommands.ts`, or inline in `Extension.ts`). Behavior:
   - Resolve the active project cwd (same resolution the other panel commands use).
   - `loadConfig()`; if no API key/jolliApiKey/`ANTHROPIC_API_KEY` → `vscode.window.showInformationMessage(...)` (mirror sync's sign-in guard) and return.
   - `setActiveStorage(await createStorage(cwd, cwd))`.
   - Wrap the work in `vscode.window.withProgress({ location: Notification, title: "Jolli Memory: Building knowledge wiki…", cancellable: false }, …)` running `drainIngest(cwd, config)` then `renderTopicKBWiki(cwd, storage)` (imports: `IngestPipeline.js`, `TopicWikiRenderer.js`, `StorageFactory.js`, `SummaryStore.js`, `SessionTracker.js` — all in-process, same as other commands).
   - On success: info toast `Knowledge wiki updated: <ingested> source(s)`. On error: error toast.
   - `sidebarProvider.refreshKnowledgeBaseFolders()` after completion (mirror the post-sync refresh).

**Scope notes:** the button runs **`compile`** (incremental `drainIngest`, which is the full backfill when the KB is empty) — **not** `--rebuild` (destructive reset stays CLI-only). Long-running by nature (folds whole history via many LLM calls); `withProgress` is the only progress affordance (no per-batch granularity in v1 — acceptable; `drainIngest` returns a final `{batches, ingested}`).

**Testing:** mirror the sync-command test (mock the imported pipeline/render + storage, assert the no-key guard toasts and returns, assert `drainIngest`+`renderTopicKBWiki`+refresh are called on the happy path). `npm run test:vscode` + `npm run build` (esbuild) must pass.
