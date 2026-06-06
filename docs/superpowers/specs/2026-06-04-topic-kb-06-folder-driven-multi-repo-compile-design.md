# Topic KB — Sub-project 6: Folder-driven plan/note + Multi-repo Compile

**Date:** 2026-06-04
**Status:** Design approved; ready for implementation-plan.
**Parent:** [Topic-Centric Knowledge Base — Architecture & Decomposition](2026-06-02-topic-centric-knowledge-base-design.md)
**Builds on:** [SP2 — Ingest Pipeline](2026-06-03-topic-kb-02-ingest-pipeline-design.md), [SP3 — Trigger / CLI / Wiki Render](2026-06-03-topic-kb-03-trigger-cli-render-design.md)

---

## 1. Purpose

Make `jolli compile` (and the VS Code **Build Knowledge Wiki** button) operate over **every repo in the Memory Bank folder**, not just the repo whose git working tree the command happens to run in.

Today compile is keyed entirely off `cwd`: `extractRepoName(cwd)` (from the git remote) → `resolveKBPath` → `<localFolder>/<repo>/`. Running it inside the `jolliai` worktree compiled only `<localFolder>/jolliai/`; the `jolli` repo's folder (`<localFolder>/jolli/`, 759 summaries on disk) was never looked at because no compile ran with a `cwd` whose remote resolves to `jolli`.

The one remaining hard dependency on a live git working tree is **plan/note ingestion** (enumerated via `loadPlansRegistry(cwd)` → `<cwd>/.jolli/jollimemory/plans.json`, content read via `entry.sourcePath`). Every other source — summaries, userfiles, the processed watermark, topic output — is already folder-resident. So this sub-project does two coupled things:

1. **Make plan/note folder-readable** so the ingest unit no longer needs the working repo.
2. **Add a core multi-repo sweep** (`compileAllRepos`) shared by the CLI and the VS Code button.

## 2. Decisions (locked in brainstorming)

- **plan/note timestamp → manifest.** `FolderStorage` records `updatedAt` (+ `branch`) on each plan/note manifest entry when it writes them. Compile reads the timestamp from the manifest (the timeline-fold ordering key). Folders predating this change fall back to the hidden-file mtime, with `branch` reverse-derived from the visible path prefix. No forced migration — entries self-heal on the next dual-write.
- **Default sweep all repos.** Bare `jolli compile` and `jollimemory.compileNow` both compile every discovered repo. `QueueWorker` (commit/merge-triggered) stays single-repo. `jolli compile --cwd <dir>` is the single-repo escape hatch.
- **FS scan is the discovery source of truth.** A direct child of `localFolder` containing `.jolli/index.json` is a compile target. `repos.json` is **not** used for discovery (it is the sync engine's `repoIdentity → folder` map and is incomplete for local-only repos — it currently lists only `jolliai`, which would reproduce the original bug). `repos.json` is consulted only to attach a `repoIdentity` label for logging/summary.
- **Folder-exclude config, default empty.** New config key `compileExcludeFolders: string[]`. Default `[]` (exclude nothing). The user opts in to skip test/scratch folders (`temp`, `test2`, …). Not folded into `excludePatterns` (that is the AI-source file glob list — different semantics).
- **Swept repos write folder-only.** A swept repo is not the current git working tree, so its orphan branch is unreachable; topic output (topics/*.json, processed.json, _wiki/) is written to the folder only. The in-tree single-repo path still dual-writes. Reads in folder/dual-write mode already come from the folder, so this is self-consistent.

## 3. Out of scope

- Concurrency across repos — the sweep is sequential (LLM-bound; per-repo isolation via the global active-storage swap relies on sequencing).
- Backfilling `repos.json` to become a complete inventory.
- Changing recall, QueueWorker single-repo semantics, or orphan-only mode behavior.
- A one-time migration to populate `updatedAt`/`branch` in existing manifests (self-heal on next write is sufficient).

## 4. plan/note folder reader

### 4.1 New module — `FolderPlanNoteSource.ts`

Reads plan/note sources for a given `kbRoot`, replacing the `loadPlansRegistry`-based reads in `SourceTimeline` (enumeration) and `SourceContent` (content + headline) when the active/read storage is folder-backed.

- **Enumerate:** read `<kbRoot>/.jolli/manifest.json`, take entries with `type === "plan" | "note"`. From each: `id`/`slug` (from `fileId`, shapes `plan:<slug>` / `note:<id>`), `title`, `branch`, `updatedAt`.
- **Content:** read `<kbRoot>/.jolli/plans/<slug>.md` / `<kbRoot>/.jolli/notes/<id>.md`. No `entry.sourcePath`.
- **Timestamp:** prefer manifest `updatedAt`; if absent, fall back to the hidden file's mtime.
- **Branch:** prefer manifest `branch`; if absent, reverse-derive from the visible path's first segment via `branches.json` (mirrors `MemoryBankScanner.resolveBranchFolder`).
- **Missing source:** entry present but hidden `.md` unreadable → return null (drops cleanly from the fold), WARN.

### 4.2 Mode-aware resolution

`SourceTimeline.collectAllSourceRefs` and `SourceContent.loadSourceContent`/`loadSourceHeadline` choose the plan/note source by storage kind:

- Folder / dual-write (active read storage is `FolderStorage`) → `FolderPlanNoteSource` keyed by the storage's `kbRoot`.
- Orphan-only (no folder) → existing `loadPlansRegistry(cwd)` path, unchanged. This preserves orphan-only users.

`FolderStorage` exposes a read-only `kbRoot` getter so callers can resolve the folder root from the active storage instead of re-deriving from `cwd`'s git remote.

### 4.3 userfile by root

Add `listUserKnowledgeFromRoot(kbRoot, branch?)` alongside the existing `listUserKnowledge(cwd, branch?)`; the latter becomes a thin wrapper that resolves `kbRoot` from `cwd` then delegates. The sweep path uses the by-root form so it never touches `cwd`'s git remote.

## 5. FolderStorage write side — manifest enrichment

When `FolderStorage` writes a plan or note, its `manifest.json` entry gains:

- `updatedAt: string` — from `PlanEntry.updatedAt` / `NoteEntry.updatedAt`.
- `branch: string` — the entry's branch.

Additive, optional fields — older readers ignore them; `FolderPlanNoteSource` falls back to mtime/path when absent.

## 6. Multi-repo sweep

### 6.1 Repo discovery — `MemoryBankRepoDiscovery.ts`

`discoverRepos(localFolder, excludeFolders): RepoTarget[]` where `RepoTarget = { folder: string; kbRoot: string; repoIdentity?: string }`.

- List direct children of `localFolder`; keep those with `<child>/.jolli/index.json`.
- Drop any whose folder name matches `compileExcludeFolders` (exact name or glob).
- Attach `repoIdentity` from `repos.json` mappings when the folder matches.
- Deterministic order: folder name ascending.

### 6.2 Core sweep — `compileAllRepos(localFolder, config, opts?)`

Shared by CLI and VS Code. For each `RepoTarget`:

1. Build a **folder-only** storage at `kbRoot` (new `createFolderStorageAtRoot(kbRoot)` in `StorageFactory`, constructs `new FolderStorage(kbRoot, metadata)` directly — no `cwd`/git).
2. `setActiveStorage(storage)`.
3. `drainIngest(target, config)` + `renderTopicKBWiki(target, storage)` — the folder-driven ingest unit (§4) keyed by `kbRoot`.
4. Per-repo `try/catch`: on failure record `{ folder, error }` and continue (no aborting the sweep, no silent swallow).

Returns `{ repos: Array<{ folder; repoIdentity?; ingested; batches; error? }>; totalIngested; failed }`.

### 6.3 Ingest unit re-key

`drainIngest` / `ingestPendingBatch` and their helpers thread a resolved `kbRoot` (or the target storage) instead of relying on `cwd` for plan/note + userfile resolution. Summary/index/processed/topic stores already key off active storage and are unchanged. The single-repo callers (`--cwd`, QueueWorker, the in-tree path) resolve `kbRoot` from `cwd` once at the top and pass it through — preserving their dual-write behavior.

### 6.4 Call sites

- **CLI `CompileCommand.ts`:** no `--cwd` → `compileAllRepos(config.localFolder, config)`, print per-repo + total summary. With `--cwd` → existing single-repo path (dual-write). `--rebuild` resets processed+index per repo in the sweep.
- **VS Code `CompileCommand.ts`:** `compileNow` → `compileAllRepos(config.localFolder, config)` inside the progress notification; summary message `"Knowledge wiki updated: N source(s) across M repo(s)"`; `refreshKnowledgeBaseFolders()` once at the end.
- **`QueueWorker.ts`:** unchanged — single-repo `drainIngest(cwd)` + `renderTopicKBWiki(cwd)`.

## 7. Components / files

| File | Change |
|------|--------|
| `cli/src/core/FolderPlanNoteSource.ts` | **new** — manifest-driven plan/note enumeration + content read |
| `cli/src/core/MemoryBankRepoDiscovery.ts` | **new** — `discoverRepos(localFolder, exclude)` |
| `cli/src/core/MultiRepoCompile.ts` | **new** — `compileAllRepos(...)` |
| `cli/src/core/SourceTimeline.ts` | plan/note enumeration → mode-aware resolver; re-key by kbRoot |
| `cli/src/core/SourceContent.ts` | plan/note content + headline → mode-aware resolver |
| `cli/src/core/MemoryBankScanner.ts` | add `listUserKnowledgeFromRoot(kbRoot, branch?)`; `listUserKnowledge` delegates |
| `cli/src/core/FolderStorage.ts` | add `kbRoot` getter; write `updatedAt`+`branch` on plan/note manifest entries |
| `cli/src/core/StorageFactory.ts` | add `createFolderStorageAtRoot(kbRoot)` |
| `cli/src/core/IngestPipeline.ts` | `drainIngest`/`ingestPendingBatch` re-keyed by kbRoot target |
| `cli/src/commands/CompileCommand.ts` | default sweep; keep `--cwd` single-repo |
| `cli/src/core/SessionTracker.ts` (config types) | add `compileExcludeFolders?: string[]` |
| `vscode/src/CompileCommand.ts` | `compileNow` → `compileAllRepos` |

## 8. Testing (CLI floor: 97% stmt / 96% br / 97% fn / 97% line)

- **`FolderPlanNoteSource`:** manifest with/without `updatedAt`; mtime fallback; branch reverse-derive; plan vs note; missing hidden file → null + WARN; content read.
- **Mode-aware resolver:** dual-write/folder → folder source; orphan-only → `loadPlansRegistry` path.
- **`discoverRepos`:** picks dirs with `index.json`; excludes by name/glob; empty localFolder → `[]`; attaches `repoIdentity` from repos.json; deterministic order.
- **`compileAllRepos`:** multi-repo loop; one repo failing does not abort the rest; summary aggregation; `--rebuild` resets per repo.
- **FolderStorage write side:** plan/note manifest entries carry `updatedAt`+`branch`.
- **Call sites:** CLI bare = sweep, `--cwd` = single; VS Code `compileNow` = sweep; QueueWorker unchanged (regression guard).

## 9. Risks / explicit trade-offs

- **Folder-only writes for swept repos.** Swept repos get topic output in the folder only, not their orphan branch. Acceptable because folder/dual-write reads come from the folder; if such a repo is later compiled in-tree, the folder-resident `processed.json` watermark prevents re-ingest. Documented, not silently dropped.
- **mtime fallback drift.** Folders synced/copied before the manifest enrichment lands order plan/note by mtime, which sync/copy can reset. Self-heals once `FolderStorage` rewrites the entries with `updatedAt`. Bounded to pre-existing folders.
- **`repos.json` deliberately not the discovery source.** It is incomplete for local-only repos (would skip `jolli`). FS scan is authoritative; repos.json is label-only.

## 10. Explicitly unchanged

- `QueueWorker` single-repo ingest semantics.
- Orphan-only mode plan/note behavior (`loadPlansRegistry`).
- Existing data sources for summaries / userfiles / topic output.
- `<projectDir>/.jolli/jollimemory/` runtime dirs; orphan branch refspec.
- `repos.json` sync write logic; `excludePatterns` semantics.
