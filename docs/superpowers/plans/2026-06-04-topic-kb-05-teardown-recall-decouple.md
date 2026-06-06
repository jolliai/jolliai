# Topic KB Sub-project 5 — Teardown, Recall Decouple & Backfill Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Delete the dormant branch-compile/merge code, decouple recall from the compiled-cache layer (recall → raw summaries), and add a Memory Bank panel toolbar button that runs compile (backfill).

**Architecture:** Pure subtraction + one ContextCompiler edit + one VS Code button. Deletions run in dependency-safe order (remove consumers before the symbols they consume) so `npm run typecheck` stays green at every commit. Safety net = typecheck + `npm run all` + coverage floor.

**Tech Stack:** TypeScript (ESM), Vitest, Biome. CLI floor 97/96/97/97. VS Code esbuild bundle inlines `cli/src`.

**Spec:** [SP5](../specs/2026-06-04-topic-kb-05-teardown-recall-decouple-design.md) · **Parent:** [Topic-Centric KB](../specs/2026-06-02-topic-centric-knowledge-base-design.md)

---

## ⚠️ Hazards (read before any deletion)

1. **Dual `mergeBranches`** — DELETE `cli/src/core/KnowledgeCompiler.ts`'s `mergeBranches`; **NEVER touch** `cli/src/sync/AggregateMerge.ts`'s `mergeBranches` (BranchEntry sync merge) or its `ConflictResolver.ts` caller. Target by file path.
2. **KnowledgeCompiler.ts is half-kept** — DELETE the branch-compile/merge functions; KEEP `parseCompileResponse`, `extractField`, `formatSummaryForCompile`, `normalizeSlug`, `slugifyTitle` (reused by SP2). Do not delete the file.
3. **VS Code bundles `cli/src`** — after each deletion run `npm run typecheck` (catches orphaned imports in `cli/`); a final `npm run build` catches orphaned `vscode/src` imports.

---

## Verified facts

- `compiledTopics` / `CompiledContextTopic` are produced+typed only in `ContextCompiler.ts` + the `CompiledContext` type. No live cli consumer reads `context.compiledTopics` (grep over cli/src). **Plan still greps `vscode/src` for `compiledTopics`** (Task 1) in case a recall/briefing renderer there reads it.
- `loadSummaries` (ContextCompiler.ts:477) already has the "load all" path (the `else` branch); decoupling collapses to it.
- `MergedKnowledge`/`CompiledKnowledge` live readers: Types.ts (defs), ContextCompiler, CompiledStore, KnowledgeCompiler, WikiMarkdownBuilder, FolderStorage — all either deleted or decoupled by SP5; the types become orphaned (Task 9).
- QueueWorker dispatches `isCompileOperation`→`runCompileFromQueue` (~L445), `isCompileMergeOperation`→`runCompileMergeFromQueue` (~L454); `runCompileFromQueue` fans out via `enqueueCompileMergeOperation` (the last `MergeTrigger` caller).
- VS Code button mirrors `jollimemory.syncNow`: `vscode/package.json` cmd (L227-231), `SidebarScriptBuilder.ts` `iconButton` (L396) + click case (L481), host command in `sync/SyncCommands.ts` style, progress via `vscode.window.withProgress`, refresh via `sidebarProvider.refreshKnowledgeBaseFolders()`.

---

## Task 1: Decouple ContextCompiler (recall → raw summaries)

**Files:** Modify `cli/src/core/ContextCompiler.ts`, `cli/src/Types.ts`, `cli/src/core/ContextCompiler.test.ts`. Grep `vscode/src` for `compiledTopics`.

- [ ] **Step 1: Grep for external consumers**

Run: `grep -rn "compiledTopics" cli/src vscode/src --include='*.ts' | grep -v "\.test\.ts"`
If any `vscode/src` file reads `context.compiledTopics` / `.compiledTopics`, note it — Step 4 must drop that render too. (The merge-prompt `{{compiledTopics}}` in PromptTemplates.ts + `compiledTopicsText` in KnowledgeCompiler are unrelated and are removed in Task 6.)

- [ ] **Step 2: Update the failing test first**

In `ContextCompiler.test.ts`, change/﻿add assertions so recall no longer expects `compiledTopics` and no longer simulates cache hit/stale. Add/keep a test:

```typescript
it("returns raw-summary context with no compiledTopics field", async () => {
	// (use the file's existing index/summary fixture setup)
	const ctx = await compileTaskContext({ branch: "main" }, cwd);
	expect(ctx.summaries.length).toBeGreaterThan(0);
	expect((ctx as { compiledTopics?: unknown }).compiledTopics).toBeUndefined();
});
```

Remove any existing cache-hit/stale tests in this file (they assert behavior being deleted).

- [ ] **Step 3: Run — expect FAIL** (`npm run test -w @jolli.ai/cli -- src/core/ContextCompiler.test.ts`) until the edit lands.

- [ ] **Step 4: Edit ContextCompiler.ts**

Remove imports of `validateCache` (`./CacheValidator.js`), `triggerBackgroundCompile` (`./BackgroundCompileTrigger.js`), and `CacheStatus`/`CompiledContextTopic` types that become unused. In `compileTaskContext`, delete Step 4 (`validateCache`), Step 4.5 (`triggerBackgroundCompile`), and Step 6 (`buildCompiledTopics`). The summary load + empty-guard collapse to:

```typescript
	// Load all head summaries (recall's raw-summary path — no compiled cache).
	const summaries = await loadSummaries(headEntries, cwd);
	if (summaries.length === 0) {
		return emptyContext(branch);
	}
```

Drop `compiledTopics` from the returned object and set `commitCount: summaries.length`. Simplify `loadSummaries` to drop the `cacheStatus` param + the `stale` branch (keep only the load-all loop). Delete the `buildCompiledTopics` function.

**Types.ts:** remove the `compiledTopics?: ReadonlyArray<CompiledContextTopic>` field from `CompiledContext` and delete the `CompiledContextTopic` interface (confirm no other reader after Step 1).

If Step 1 found a `vscode/src` reader, remove that render block there too (it would now be `undefined`).

- [ ] **Step 5: Run — expect PASS** + `npm run typecheck:cli`

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/ContextCompiler.ts cli/src/Types.ts cli/src/core/ContextCompiler.test.ts
git commit -s -m "refactor(topic-kb): decouple recall from compiled cache (raw summaries only)"
```

---

## Task 2: Remove QueueWorker compile/compile-merge handlers

**Files:** Modify `cli/src/hooks/QueueWorker.ts`, `cli/src/hooks/QueueWorker.test.ts`

- [ ] **Step 1: Update tests** — delete the QueueWorker test cases that feed a `compile` / `compile-merge` op and assert `runCompileFromQueue`/`runCompileMergeFromQueue`. Keep ingest + commit/squash/rebase cases.

- [ ] **Step 2: Edit QueueWorker.ts** — delete the two dispatch `if (isCompileOperation(op))` / `if (isCompileMergeOperation(op))` branches in `processQueueEntry`, and delete the `runCompileFromQueue` + `runCompileMergeFromQueue` function bodies + their now-unused imports (`isCompileOperation`, `isCompileMergeOperation`, `compileBranch`, `mergeBranchesHierarchical`, `enqueueCompileMergeOperation`, `listCompiledWithMtime`, etc.). A queue entry of an unknown legacy type now falls through the dispatch (no handler) — acceptable (no such ops exist in the wild; §2 of spec).

- [ ] **Step 3: Run** `npm run typecheck:cli && npm run test -w @jolli.ai/cli -- src/hooks/QueueWorker.test.ts` — expect PASS.

- [ ] **Step 4: Commit**

```bash
git add cli/src/hooks/QueueWorker.ts cli/src/hooks/QueueWorker.test.ts
git commit -s -m "refactor(topic-kb): remove dormant compile/compile-merge queue handlers"
```

---

## Task 3: Delete CacheValidator + BackgroundCompileTrigger

**Files:** Delete `cli/src/core/CacheValidator.ts` (+`.test.ts`), `cli/src/core/BackgroundCompileTrigger.ts` (+`.test.ts`)

- [ ] **Step 1: Confirm orphaned** — `grep -rn "CacheValidator\|validateCache\|BackgroundCompileTrigger\|triggerBackgroundCompile" cli/src vscode/src --include='*.ts' | grep -v "\.test\.ts" | grep -vE "CacheValidator\.ts|BackgroundCompileTrigger\.ts"` → expect no hits (Task 1 removed the only consumers).

- [ ] **Step 2: Delete the four files**

```bash
git rm cli/src/core/CacheValidator.ts cli/src/core/CacheValidator.test.ts cli/src/core/BackgroundCompileTrigger.ts cli/src/core/BackgroundCompileTrigger.test.ts
```

- [ ] **Step 3: Run** `npm run typecheck:cli` — expect PASS (no dangling imports).

- [ ] **Step 4: Commit**

```bash
git commit -s -m "refactor(topic-kb): delete CacheValidator and BackgroundCompileTrigger"
```

---

## Task 4: Delete MergeTrigger

**Files:** Delete `cli/src/core/MergeTrigger.ts` (+`.test.ts`)

- [ ] **Step 1: Confirm orphaned** — `grep -rn "MergeTrigger\|enqueueCompileMergeOperation\|markMergeTouched\|isMergeWithinCooldown" cli/src vscode/src --include='*.ts' | grep -v "\.test\.ts" | grep -v "MergeTrigger\.ts"` → expect no hits (CompileCommand stopped using it in SP3; QueueWorker in Task 2).

- [ ] **Step 2: Delete** — `git rm cli/src/core/MergeTrigger.ts cli/src/core/MergeTrigger.test.ts`

- [ ] **Step 3: Run** `npm run typecheck:cli` — expect PASS.

- [ ] **Step 4: Commit**

```bash
git commit -s -m "refactor(topic-kb): delete MergeTrigger (no enqueue callers remain)"
```

---

## Task 5: Remove Compile/CompileMerge operation types

**Files:** Modify `cli/src/Types.ts`

- [ ] **Step 1: Edit** — delete `CompileOperation`, `CompileMergeOperation`, `isCompileOperation`, `isCompileMergeOperation`; remove both from the `GitOperation` union (leaving `CommitGitOperation | IngestOperation`); update the JSDoc at ~L138/L142 that references `compileBranch`/`mergeBranches`/`isCompileOperation`.

- [ ] **Step 2: Run** `grep -rn "CompileOperation\|CompileMergeOperation\|isCompileOperation\|isCompileMergeOperation" cli/src vscode/src --include='*.ts' | grep -v "\.test\.ts"` → expect no hits. Then `npm run typecheck:cli` — expect PASS.

- [ ] **Step 3: Commit**

```bash
git add cli/src/Types.ts
git commit -s -m "refactor(topic-kb): drop CompileOperation/CompileMergeOperation types"
```

---

## Task 6: Remove branch-compile/merge functions from KnowledgeCompiler

**Files:** Modify `cli/src/core/KnowledgeCompiler.ts`, `cli/src/core/KnowledgeCompiler.test.ts`

- [ ] **Step 1: Update tests** — in `KnowledgeCompiler.test.ts`, delete the `compileBranch`/`compileBranches`/`mergeBranches`/`mergeOfMerges`/`mergeBranchesHierarchical`/`fingerprintCompiled` cases. KEEP `parseCompileResponse` + `extractField` + `formatSummaryForCompile` cases.

- [ ] **Step 2: Edit KnowledgeCompiler.ts** — delete the functions `compileBranch`, `compileBranches`, `mergeBranches`, `mergeOfMerges`, `mergeBranchesHierarchical`, `fingerprintCompiled`, the constants `MERGE_MAX_TOKENS`/`COMPILE_MAX_TOKENS`/`HIERARCHICAL_BATCH_SIZE`, and the private helpers used only by them (`formatCompiledForMerge`, `formatTopicsForMerge`, `formatUserKnowledgeForCompile`). Remove their now-unused imports (`readCompiled`/`saveCompiled`/`readMerged`/`saveMerged` from `./CompiledStore.js`, `listUserKnowledge`, `createReadStorage`, `callLlm`, `resolveModelId`, etc. — keep only what `parseCompileResponse`/`formatSummaryForCompile` need: `collectAllTopics`, types). KEEP: `parseCompileResponse`, `extractField`, `formatSummaryForCompile`, `normalizeSlug`, `slugifyTitle`.

- [ ] **Step 3: Run** `npm run typecheck:cli && npm run test -w @jolli.ai/cli -- src/core/KnowledgeCompiler.test.ts` — expect PASS. Confirm SP2 reuse still resolves: `npm run test -w @jolli.ai/cli -- src/core/SourceContent.test.ts src/core/ReconciledPage.test.ts` — expect PASS.

- [ ] **Step 4: Commit**

```bash
git add cli/src/core/KnowledgeCompiler.ts cli/src/core/KnowledgeCompiler.test.ts
git commit -s -m "refactor(topic-kb): remove branch-compile/merge fns, keep parse+format helpers"
```

---

## Task 7: Delete CompiledStore

**Files:** Delete `cli/src/core/CompiledStore.ts` (+`.test.ts`)

- [ ] **Step 1: Confirm orphaned** — `grep -rn "CompiledStore\|saveCompiled\|readCompiled\|saveMerged\|readMerged\|listCompiledWithMtime\|listCompiled\b\|slugifyBranch" cli/src vscode/src --include='*.ts' | grep -v "\.test\.ts" | grep -v "CompiledStore\.ts"` → expect no live hits (only comments, if any). If a comment mentions it, that's fine.

- [ ] **Step 2: Delete** — `git rm cli/src/core/CompiledStore.ts cli/src/core/CompiledStore.test.ts`

- [ ] **Step 3: Run** `npm run typecheck:cli` — expect PASS.

- [ ] **Step 4: Commit**

```bash
git commit -s -m "refactor(topic-kb): delete per-branch CompiledStore"
```

---

## Task 8: Remove old wiki render path

**Files:** Modify `cli/src/core/FolderStorage.ts`, `cli/src/core/WikiMarkdownBuilder.ts`, their `.test.ts`

- [ ] **Step 1: Update tests** — remove `generateWikiPages` cases from `FolderStorage.test.ts` and `renderTopic`(old wrapper)/`renderIndex` cases from `WikiMarkdownBuilder.test.ts`. KEEP `renderTopicWiki`, `renderTopicImpl`, `renderTopicKBIndex`, `topicPageToCompiledTopic` cases.

- [ ] **Step 2: Edit FolderStorage.ts** — delete the private `generateWikiPages` method and the `writeFiles` branch (~L116) that calls it on `compiled/merged/*.json`. Keep `renderTopicWiki`, `wipeWikiArtifacts`, `buildWikiRenderContext`, `atomicWrite`.

- [ ] **Step 3: Edit WikiMarkdownBuilder.ts** — delete the old `renderTopic(topic, merged, ctx)` wrapper and `renderIndex(merged, ctx)`. Keep `renderTopicImpl`, `renderTopicKBIndex`, `topicPageToCompiledTopic`, `WikiRenderContext`. Remove now-unused `MergedKnowledge` import here.

- [ ] **Step 4: Run** `npm run typecheck:cli && npm run test -w @jolli.ai/cli -- src/core/FolderStorage.test.ts src/core/WikiMarkdownBuilder.test.ts` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/FolderStorage.ts cli/src/core/WikiMarkdownBuilder.ts cli/src/core/FolderStorage.test.ts cli/src/core/WikiMarkdownBuilder.test.ts
git commit -s -m "refactor(topic-kb): remove old MergedKnowledge wiki render path"
```

---

## Task 9: Remove orphaned MergedKnowledge/CompiledKnowledge types

**Files:** Modify `cli/src/Types.ts` (+ any remaining importer)

- [ ] **Step 1: Confirm orphaned** — `grep -rn "MergedKnowledge\|CompiledKnowledge\|CompiledTopic\b" cli/src vscode/src --include='*.ts' | grep -v "\.test\.ts" | grep -v "Types\.ts"`. If `CompiledTopic` is still used by `topicPageToCompiledTopic`/`renderTopicImpl` (it is — keep `CompiledTopic`), only remove `MergedKnowledge`/`CompiledKnowledge` (and `CompiledStore`-only helper types) if they have ZERO live hits. **Keep whatever still has a reader.**

- [ ] **Step 2: Edit** — delete only the confirmed-orphaned type defs from Types.ts. (`CompiledTopic` almost certainly stays — `renderTopicImpl`/`topicPageToCompiledTopic` use it.)

- [ ] **Step 3: Run** `npm run typecheck:cli` — expect PASS.

- [ ] **Step 4: Commit** (skip if nothing was orphaned)

```bash
git add cli/src/Types.ts
git commit -s -m "refactor(topic-kb): drop orphaned MergedKnowledge/CompiledKnowledge types"
```

---

## Task 10: VS Code "Build Knowledge Wiki" toolbar button

**Files:** Modify `vscode/package.json`, `vscode/src/views/SidebarScriptBuilder.ts`; Create `vscode/src/CompileCommand.ts` (or add to an existing command module) + a test.

- [ ] **Step 1: Write the failing host-command test**

Create `vscode/src/CompileCommand.test.ts` mirroring `sync/SyncCommands.test.ts` (if present) — mock the cli imports and assert:

```typescript
// Mock drainIngest, renderTopicKBWiki, createStorage, setActiveStorage, loadConfig.
// 1) No API key -> shows an information message, does NOT call drainIngest.
// 2) With key -> setActiveStorage(createStorage()), drainIngest called, renderTopicKBWiki called,
//    success toast, refreshKnowledgeBaseFolders() called.
// Follow the project's vscode test harness (vi.mock on the cli/src module paths + vscode mock).
```

- [ ] **Step 2: Run — expect FAIL** (`npm run test:vscode -- src/CompileCommand.test.ts`)

- [ ] **Step 3: Implement the command** (register `jollimemory.compileNow`)

```typescript
// Mirror sync/SyncCommands.ts. Pseudocode-accurate shape:
vscode.commands.registerCommand("jollimemory.compileNow", async () => {
	const cwd = /* resolve active project dir, same as other panel commands */;
	const { loadConfig } = await import("../../cli/src/core/SessionTracker.js");
	const config = await loadConfig();
	if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
		await vscode.window.showInformationMessage(
			"Building the knowledge wiki needs an API key. Open Settings → Memory Bank to sign in or configure a key, then try again.",
		);
		return;
	}
	const { createStorage } = await import("../../cli/src/core/StorageFactory.js");
	const { setActiveStorage } = await import("../../cli/src/core/SummaryStore.js");
	const { drainIngest } = await import("../../cli/src/core/IngestPipeline.js");
	const { renderTopicKBWiki } = await import("../../cli/src/core/TopicWikiRenderer.js");
	const storage = await createStorage(cwd, cwd);
	setActiveStorage(storage);
	try {
		const { ingested } = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "Jolli Memory: Building knowledge wiki…", cancellable: false },
			async () => {
				const r = await drainIngest(cwd, config);
				await renderTopicKBWiki(cwd, storage);
				return r;
			},
		);
		await vscode.window.showInformationMessage(`Knowledge wiki updated: ${ingested} source(s).`);
	} catch (err) {
		await vscode.window.showErrorMessage(`Knowledge wiki build failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	sidebarProvider.refreshKnowledgeBaseFolders();
});
```

Wire its registration into activation alongside the other command registrations (match how `jollimemory.syncNow` is registered + added to `context.subscriptions`). `sidebarProvider` is the same handle the post-sync refresh uses.

- [ ] **Step 4: Add the toolbar button + package.json command**

`vscode/package.json` `contributes.commands` (after `syncNow`):

```json
{ "command": "jollimemory.compileNow", "title": "Build Knowledge Wiki", "icon": "$(database)", "category": "Jolli Memory" }
```

`vscode/src/views/SidebarScriptBuilder.ts` — add the toolbar item near the sync button (L396) and its click case (L481):

```javascript
items.push(iconButton('compile-now', 'Build Knowledge Wiki', 'database'));
// ... in the action switch:
} else if (action === 'compile-now') {
	vscode.postMessage({ type: 'command', command: 'jollimemory.compileNow' });
```

- [ ] **Step 5: Run — expect PASS** (`npm run test:vscode -- src/CompileCommand.test.ts`)

- [ ] **Step 6: Commit**

```bash
git add vscode/package.json vscode/src/views/SidebarScriptBuilder.ts vscode/src/CompileCommand.ts vscode/src/CompileCommand.test.ts cli/src # if Extension.ts wiring changed
git commit -s -m "feat(topic-kb): add Build Knowledge Wiki toolbar button to Memory Bank panel"
```

---

## Task 11: Full gate

- [ ] **Step 1:** `npm run all` — build (incl. vscode esbuild bundle) + lint + test. Expect green except the known `GitClient`/`sync`/`KBPathResolver` concurrency-flaky (re-run those in isolation to confirm). Coverage stays above floor (deleting code + its tests preserves the ratio).

- [ ] **Step 2:** If lint flags formatting: `npm run lint:fix`, re-run, commit `style(topic-kb): biome formatting`.

---

## Self-review notes

- **Spec coverage:** §5 removals → Tasks 2–9; §6 ContextCompiler decouple → Task 1; §8 backfill GUI + §11 button → Task 10; teardown order keeps typecheck green (consumers in Task 1–2 before files deleted in 3–8). §4 dual-`mergeBranches` hazard called out at top + Task 6 targets KnowledgeCompiler by path only.
- **Order rationale:** Task 1 (ContextCompiler) + Task 2 (QueueWorker) remove the only consumers, so Tasks 3–4 (delete CacheValidator/BackgroundCompileTrigger/MergeTrigger) and Task 6–7 (KnowledgeCompiler fns/CompiledStore) are orphan-deletes that typecheck-clean. Each task ends green + committed.
- **Not deleted (verified reused):** `parseCompileResponse`/`extractField`/`formatSummaryForCompile`/slug helpers; `renderTopicImpl`/`renderTopicKBIndex`/`topicPageToCompiledTopic`; `CompiledTopic` type; SP1–3 modules; `sync/AggregateMerge.mergeBranches`.
- **No-placeholder exceptions (decisions to finalize against real code):** Task 1 vscode-`compiledTopics` grep result; Task 9 which types are actually orphaned; Task 10 cwd-resolution + activation wiring + the exact vscode test harness — each names what to read.
