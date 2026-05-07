# JOLLI-1309: Local Knowledge Base — IntelliJ Implementation Plan

---

## Context

The IntelliJ plugin is a **complete Kotlin-native rewrite** — it shares zero code with the VS Code/CLI TypeScript implementation. It uses the same orphan branch storage format (`jollimemory/summaries/v3`, `index.json` v3) but all code is independent: `SummaryStore.kt` for storage, `GitOps.kt` for git plumbing, `PostCommitHook.kt` for the worker pipeline, and JCEF-based webviews for the UI.

This plan maps the same 6-phase architecture to IntelliJ's Kotlin codebase, identifying the exact files, classes, and methods that need to change.

## Current IntelliJ Architecture

```
PostCommitHook (JAR subprocess)
  → SessionTracker (lock, sessions, cursors)
  → TranscriptReader (JSONL parsing)
  → Summarizer (Anthropic HTTP API)
  → SummaryStore.writeFilesToBranch()
      → GitOps (hash-object, mktree, commit-tree, update-ref)
      → orphan branch: jollimemory/summaries/v3

JolliMemoryService (project-level service)
  → SummaryReader → SummaryStore (read index, read summaries)
  → GitOps (branch commits, status, diff)
  → NIO WatchService (monitors .git/refs/heads/jollimemory/)
  → PanelRegistry → UI Panels (Status, Memories, Plans, Changes, Commits)
```

## New Architecture

```
PostCommitHook (JAR subprocess)
  → SessionTracker
  → TranscriptReader
  → Summarizer
  → SummaryStore → StorageProvider (interface)
                      ├── OrphanBranchStorage (wraps current GitOps calls)
                      ├── FolderStorage (new: ~/Documents/jollimemory/<project>/)
                      └── DualWriteStorage (transition wrapper)

JolliMemoryService
  → SummaryReader → StorageProvider
  → GitOps (branch commits, status, diff — unchanged)
  → NIO WatchService (now also monitors KB folder)
  → PanelRegistry → UI Panels (3-tab layout)
```

---

## Phase 1: Foundation — Storage Abstraction + Folder Engine

**Issues:** JOLLI-1312, JOLLI-1315, JOLLI-1310

### Step 1.1: StorageProvider Interface + OrphanBranchStorage Wrapper

Extract all orphan branch I/O from `SummaryStore.kt` into a clean interface.

**New file — `core/StorageProvider.kt`:**
```kotlin
interface StorageProvider {
    suspend fun readFile(path: String): String?
    suspend fun writeFiles(files: List<FileWrite>, message: String)
    suspend fun listFiles(prefix: String? = null): List<String>
    suspend fun exists(): Boolean
    suspend fun ensure()
}
```

**New file — `core/OrphanBranchStorage.kt`:**
- Move `writeFilesToBranch()` logic from `SummaryStore.kt` (the git plumbing: hash-object → mktree → commit-tree → update-ref)
- Move `readFileFromBranch()` calls (currently `gitOps.readBranchFile()`)
- Move `listFilesInBranch()` calls (currently `gitOps.listBranchFiles()`)
- Wrap them behind `StorageProvider` interface

**Refactor — `core/SummaryStore.kt`:**
- Replace all direct `gitOps.readBranchFile()` / `writeFilesToBranch()` calls with `storageProvider.readFile()` / `storageProvider.writeFiles()`
- Inject `StorageProvider` via constructor (currently SummaryStore takes `gitOps: GitOps` + `cwd: String`)
- **Methods affected:**
  - `storeSummary()` — uses `writeFilesToBranch()`
  - `migrateOneToOne()` — uses `writeFilesToBranch()`
  - `mergeManyToOne()` — uses `writeFilesToBranch()`
  - `loadIndex()` — uses `gitOps.readBranchFile("index.json")`
  - `getSummary()` — uses `gitOps.readBranchFile("summaries/$hash.json")`
  - `readTranscript()` — uses `gitOps.readBranchFile("transcripts/$hash.json")`
  - `readPlanFromBranch()` — uses `gitOps.readBranchFile("plans/$slug.md")`
  - `readPlanProgress()` — uses `gitOps.readBranchFile("plan-progress/$slug.json")`
  - `writeTranscriptBatch()` — uses `writeFilesToBranch()`
  - `writePlanToBranch()` — uses `writeFilesToBranch()`
  - `storePlanFiles()` — uses `writeFilesToBranch()`
  - `scanTreeHashAliases()` — uses `writeFilesToBranch()` for alias cache
  - `migrateIndexToV3()` — uses `writeFilesToBranch()`

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/StorageProvider.kt` (new)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/OrphanBranchStorage.kt` (new)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/SummaryStore.kt` (refactor)

**Validation:** All existing tests pass unchanged — pure refactor.

### Step 1.2: FolderStorage Implementation

**New file — `core/FolderStorage.kt`:**

```kotlin
class FolderStorage(
    private val rootPath: Path,   // ~/Documents/jollimemory/<project>/
    private val metadataManager: MetadataManager
) : StorageProvider {
    override suspend fun readFile(path: String): String? { ... }
    override suspend fun writeFiles(files: List<FileWrite>, message: String) { ... }
    override suspend fun listFiles(prefix: String?): List<String> { ... }
    override suspend fun exists(): Boolean = rootPath.exists()
    override suspend fun ensure() { ... }
}
```

**Implementation details:**
- Atomic writes: `Files.write(tmpPath, ...) → Files.move(tmpPath, targetPath, ATOMIC_MOVE)`
- File lock: `.jolli/lock` via `FileChannel.tryLock()` (Java NIO — more robust than file-existence check)
- Branch name transcoding: `feature/jolli-400` → `feature-jolli-400`
  - Replace `/`, `\`, `:`, `*`, `?`, `~`, `^` → `-`
  - Replace `..` → `--`, collapse consecutive `-`, trim leading/trailing `.` and `-`
- Smart collapse: count manifest entries per type, create subfolder at threshold 2
- Markdown rendering: port or reuse `SummaryHtmlBuilder` patterns for `.md` output with YAML frontmatter

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/FolderStorage.kt` (new)

### Step 1.3: .jolli/ Metadata Layer (JOLLI-1315)

**New file — `core/MetadataManager.kt`:**

Manages all `.jolli/` directory contents:

```kotlin
class MetadataManager(private val jolliDir: Path) {
    // .jolli/manifest.json — AI-generated file tracking
    fun readManifest(): Manifest
    fun updateManifest(entry: ManifestEntry)
    fun removeFromManifest(fileId: String)

    // .jolli/branches.json — branch ↔ folder mapping
    fun resolveFolderForBranch(branchName: String): String
    fun updateBranchMapping(folder: String, branch: String)

    // .jolli/index.json — rebuildable cache
    fun rebuildIndex()

    // .jolli/config.json — KB settings
    fun readConfig(): KBConfig
    fun saveConfig(config: KBConfig)
}
```

**Data classes** (in `core/Types.kt` or new `core/KBTypes.kt`):
```kotlin
data class Manifest(val version: Int = 1, val files: List<ManifestEntry>)
data class ManifestEntry(
    val path: String,
    val fileId: String,
    val type: String,       // "commit" | "plan" | "note"
    val fingerprint: String,
    val source: ManifestSource
)
data class BranchMapping(val folder: String, val branch: String, val createdAt: String)
data class BranchesJson(val version: Int = 1, val mappings: List<BranchMapping>)
```

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/MetadataManager.kt` (new)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/KBTypes.kt` (new)

### Step 1.4: KB Root Folder Configuration (JOLLI-1310)

**Modify — `settings/JolliMemoryConfigurable.kt` + `settings/SettingsDialog.kt`:**
- Add "Knowledge Base" section with:
  - Folder path field + Browse button (`JBTextField` + `FileChooserDescriptor`)
  - Default: `~/Documents/jollimemory/{project}/`
  - Sort toggle: by date / by name (`ComboBox`)

**Modify — `core/Types.kt` or config data class:**
```kotlin
data class JolliMemoryConfig(
    // ... existing fields ...
    val knowledgeBasePath: String?,     // new
    val knowledgeBaseSort: String?,     // "date" | "name", new
)
```

**Modify — `bridge/SessionTracker.kt`:**
- `loadConfig()` / `saveConfig()` — handle new fields

**Can run in parallel** with Steps 1.1–1.3 (pure UI work).

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/settings/JolliMemoryConfigurable.kt` (modify)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/settings/SettingsDialog.kt` (modify)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/bridge/SessionTracker.kt` (modify)

---

## Phase 2: Safe Migration — Dual-Write + Bulk Migration

**Issues:** JOLLI-1312 (migration part)

### Step 2.1: DualWriteStorage

**New file — `core/DualWriteStorage.kt`:**

```kotlin
class DualWriteStorage(
    private val primary: OrphanBranchStorage,
    private val shadow: FolderStorage,
    private val logger: Logger
) : StorageProvider {
    override suspend fun writeFiles(files: List<FileWrite>, message: String) {
        primary.writeFiles(files, message)
        try { shadow.writeFiles(files, message) }
        catch (e: Exception) { logger.warn("FolderStorage shadow write failed", e) }
    }
    override suspend fun readFile(path: String): String? = primary.readFile(path)
    // ...
}
```

**Modify — `services/JolliMemoryService.kt`:**
- Read `storage.mode` from config
- Instantiate the appropriate `StorageProvider`:
  - `"orphan"` → `OrphanBranchStorage` (default, backward-compatible)
  - `"dual-write"` → `DualWriteStorage`
  - `"folder"` → `FolderStorage`
- Pass to `SummaryStore` constructor

**Also modify — `hooks/PostCommitHook.kt`:**
- Worker creates its own `SummaryStore` instance — must also read `storage.mode` and use correct provider
- The JAR subprocess needs access to the same config

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/DualWriteStorage.kt` (new)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/services/JolliMemoryService.kt` (modify)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/hooks/PostCommitHook.kt` (modify)

### Step 2.2: Bulk Migration Engine

**New file — `core/MigrationEngine.kt`:**

```kotlin
class MigrationEngine(
    private val orphanStorage: OrphanBranchStorage,
    private val folderStorage: FolderStorage,
    private val summaryStore: SummaryStore,
    private val metadataManager: MetadataManager
) {
    data class MigrationState(
        val status: String,          // "pending" | "in_progress" | "completed" | "failed"
        val totalEntries: Int,
        val migratedEntries: Int,
        val lastMigratedHash: String?
    )

    suspend fun runMigration(onProgress: (Int, Int) -> Unit)
    suspend fun resumeMigration()
    suspend fun validateMigration(): Boolean
}
```

**Migration flow:**
1. Read `index.json` from orphan branch via `orphanStorage`
2. Filter root entries (parentCommitHash == null)
3. For each root entry:
   a. Read `summaries/{hash}.json` → parse `CommitSummary`
   b. Render to markdown (reuse `SummaryMarkdownBuilder.buildMarkdown()` — already exists in IntelliJ)
   c. Determine branch folder via `metadataManager.resolveFolderForBranch()`
   d. Apply smart collapse rules
   e. Write `.md` file to KB folder
   f. Update `manifest.json`
   g. Update `.jolli/migration.json` progress
4. Also migrate: `plans/*.md`, `notes/*.md`, `transcripts/*.json`
5. Validation: compare `index.entries.count { it.parentCommitHash == null }` vs `manifest.files.size`

**Progress state:** `.jolli/migration.json`
- Idempotent (skip by fileId in manifest)
- Resumable (from `lastMigratedHash`)

**Integration with UI:**
- `StatusPanel.kt` — show migration progress bar / notification
- Non-blocking: run on `Dispatchers.IO` coroutine

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/MigrationEngine.kt` (new)

### Step 2.3: Read Switchover + Orphan Branch Retirement

**Modify — `services/JolliMemoryService.kt`:**
- After migration validated, switch `storage.mode` to `"folder"`
- `FolderStorage` becomes sole provider
- Orphan branch ref kept (never deleted)

**Modify — `settings/SettingsDialog.kt`:**
- Add "Remove legacy storage" button (deletes orphan branch ref)
- Only shown when `storage.mode == "folder"` and orphan branch exists

---

## Phase 3: Pipeline Rewire — Commit Memories to Folder

**Issues:** JOLLI-1311

### Step 3.1: Rewire PostCommitHook Worker

**Modify — `hooks/PostCommitHook.kt`:**
- Worker currently calls `summaryStore.storeSummary()` which calls `writeFilesToBranch()`
- After Phase 1 refactor, this flows through `StorageProvider` automatically
- **Additional work:** generate markdown file with YAML frontmatter (not just JSON summary)

**New output format** for `FolderStorage` writes:
```markdown
---
commitHash: abc12345deadbeef
branch: feature/jolli-400-new-auth
author: Summer Fang
date: 2026-04-20T10:30:00Z
type: commit
---

# Add OAuth flow for third-party integrations
...
```

**Modify — `core/SummaryStore.kt`:**
- When using `FolderStorage`, `storeSummary()` must:
  1. Write markdown file (visible): `<hash8>-<slug>.md` via `SummaryMarkdownBuilder`
  2. Write JSON summary (hidden): `.jolli/summaries/<hash>.json` (for programmatic access)
  3. Update `manifest.json` and `index.json`
  4. Apply smart collapse rules

**Simplify/Remove:**
- `JolliApiClient.kt` push flow — currently reads from orphan branch → re-reads from folder instead
- Any local export code that duplicated orphan branch → folder copying

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/hooks/PostCommitHook.kt` (modify)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/SummaryStore.kt` (modify)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/services/JolliApiClient.kt` (modify)

---

## Phase 4: Explorer UI — Browse Knowledge Base

**Issues:** JOLLI-1313, JOLLI-1314, JOLLI-1318

### Step 4.1: Explorer Panel — KB Folder Tree (JOLLI-1313)

**New file — `toolwindow/ExplorerPanel.kt`:**

IntelliJ tree using `JBTreeTable` or `Tree` with custom `TreeModel`:

```kotlin
class KBTreeModel(private val kbRoot: Path, private val metadataManager: MetadataManager) : TreeModel {
    // Root children = branch folders (sorted by date or name)
    // Branch children = files + subfolders (commits/, plans/, notes/)
    // Leaf nodes = markdown files with C/P/N badge from manifest
}
```

**Tree node rendering** via `ColoredTreeCellRenderer`:
- Branch folders: folder icon + branch name
- Files with badges: `[C]` purple / `[P]` blue / `[N]` green (from manifest type)
- User files: no badge

**Interactions:**
- Click commit (C) → open `SummaryFileEditor` (existing JCEF webview)
- Click plan/note (P/N) → open in IntelliJ text editor
- Click user file → open in appropriate editor
- Right-click → context menu: New File, New Folder, Rename, Delete, Import File(s)...
- Drag & drop → move files between folders

**Auto-refresh:** NIO `WatchService` on KB root folder (extend existing watcher in `JolliMemoryService`)

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/ExplorerPanel.kt` (new)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/KBTreeModel.kt` (new)

### Step 4.2: Import & Organize User Files (JOLLI-1314)

**Modify — `toolwindow/ExplorerPanel.kt`:**
- Right-click action "Import File(s)..." → `FileChooser.chooseFiles()` → copy to KB folder
- When AI-generated files moved/renamed → `metadataManager.updateManifest()` path
- Support any file type

**New action — `actions/ImportFilesAction.kt`:**
- Registered in `JolliMemory.ExplorerActions` group

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/ExplorerPanel.kt` (modify)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/actions/ImportFilesAction.kt` (new)

### Step 4.3: UI Redesign — 3-Tab Layout (JOLLI-1318)

**Assigned to sanshi.zhang** — independent track.

**Modify — `toolwindow/JolliMemoryToolWindowFactory.kt`:**
- Replace current 5-panel accordion with 3-tab `JBTabbedPane`:
  - Tab 1: Memories (ExplorerPanel — KB folder tree)
  - Tab 2: Branch (PlansPanel + ChangesPanel + CommitsPanel — existing panels, recomposed)
  - Tab 3: Status (StatusPanel — existing)
- Tab 2 title auto-updates on branch switch (via `JolliMemoryService` branch listener)

**Reuse existing panels** — PlansPanel, ChangesPanel, CommitsPanel move into Tab 2 as stacked sections. StatusPanel moves to Tab 3. ExplorerPanel (new) is Tab 1.

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/JolliMemoryToolWindowFactory.kt` (major refactor)

---

## Phase 5: Sync Layer

**Issues:** JOLLI-1317, JOLLI-1316

### Step 5.1: Local to Personal Space Sync (JOLLI-1317)

**New file — `core/SyncEngine.kt`:**

```kotlin
class SyncEngine(
    private val kbRoot: Path,
    private val metadataManager: MetadataManager,
    private val httpClient: HttpClient
) {
    suspend fun pull(): SyncResult
    suspend fun push(): SyncResult
    suspend fun sync(): SyncResult  // pull then push
    fun getStatus(): SyncStatus     // synced | syncing | conflicts | offline
}
```

- Bidirectional sync via Jolli Space API
- Change detection: hash comparison (local vs synced vs server)
- Conflict resolution: markdown → 3-way merge; binary → last-modified-wins
- Offline: queue changes, auto-resume
- State: `.jolli/sync-state.json`
- Requires JOLLI-1319 (OAuth login) as prerequisite

**Modify — `toolwindow/StatusPanel.kt`:**
- Show sync status indicator

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/SyncEngine.kt` (new)
- `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/StatusPanel.kt` (modify)

### Step 5.2: Device-to-Device Sync (JOLLI-1316)

Built on top of Personal Space sync — no additional IntelliJ-specific code beyond first-time setup dialog.

**New file — `dialogs/SyncSetupDialog.kt`:**
- "Sync knowledge base from your Personal Space? (47 files)" → download all

---

## Phase 6: Dedicated Space & Agent Integration

**Issues:** JOLLI-1338, JOLLI-1337, JOLLI-1335, JOLLI-1336, JOLLI-1339

### Step 6.1: Space Backend API (JOLLI-1338)

Backend work — no IntelliJ plugin changes. Can start in parallel with Phase 1.

### Step 6.2: Push KB to Space (JOLLI-1337)

**Modify — `services/JolliApiClient.kt`:**
- Update push payload to include branch folder structure
- Push from KB folder (not orphan branch)
- Include `.jolli/manifest.json` and `.jolli/branches.json`
- Respect `.jolliignore`
- Add auto-push option (configurable in settings)

**Files:**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/services/JolliApiClient.kt` (modify)

### Step 6.3–6.4: Space UI + Agent Provider (JOLLI-1335, JOLLI-1336, JOLLI-1339)

Server-side / web UI work — no IntelliJ plugin changes needed.

---

## Execution Timeline & Parallelism

```
              Week 1-2         Week 3-4         Week 5-6         Week 7+
              ──────────       ──────────       ──────────       ──────────
Phase 1       [1.1 StorageProvider interface  ]
              [1.2 FolderStorage (Kotlin)     ]
              [1.3 MetadataManager            ]
              [1.4 Settings UI ]──────→ (parallel, pure UI)

Phase 2                        [2.1 DualWriteStorage   ]
                               [2.2 MigrationEngine    ]
                               [2.3 Read switchover    ]

Phase 3                                         [3.1 PostCommitHook rewire ]

Phase 4                                         [4.1 ExplorerPanel         ]
                                                [4.2 Import files action   ]

Phase 5                                                              [5.1 SyncEngine ]
                                                                     [5.2 Setup dialog]

Phase 6       [6.1 Backend API ]───────────────────────→ (parallel, server)
                                                [6.2 JolliApiClient update ]

UI (sanshi)   [4.3 3-Tab layout]───────────────────────→ (parallel throughout)
```

---

## IntelliJ-Specific Considerations

| Concern | Approach |
|---------|----------|
| **JAR subprocess** — PostCommitHook runs as separate Java process | JAR must bundle `FolderStorage` + `MetadataManager` classes; reads `storage.mode` from same config |
| **NIO WatchService** — currently watches `.git/refs/` only | Extend to also watch KB folder root for external file changes (user edits via Finder/terminal) |
| **JCEF webview** — SummaryPanel renders HTML | No change needed for storage migration; ExplorerPanel uses native Swing tree (not webview) |
| **FileChannel locking** — Java NIO file locks | More robust than file-existence checks; use `FileChannel.tryLock()` for `.jolli/lock` |
| **Coroutines** — IntelliJ uses `kotlinx.coroutines` | `FolderStorage` I/O on `Dispatchers.IO`; migration progress via `Flow` |
| **Git plumbing in OrphanBranchStorage** — hash-object, mktree, etc. | Stays in `OrphanBranchStorage.kt`, called via `GitOps.exec()` as before |
| **Cross-platform paths** — Windows backslashes | Use `java.nio.file.Path` throughout (already platform-aware) |

---

## Key Files Summary

| File | Change | Phase |
|------|--------|-------|
| `core/StorageProvider.kt` | **New** — interface | 1.1 |
| `core/OrphanBranchStorage.kt` | **New** — extract from SummaryStore | 1.1 |
| `core/SummaryStore.kt` | **Refactor** — use StorageProvider | 1.1 |
| `core/FolderStorage.kt` | **New** — folder-based storage | 1.2 |
| `core/MetadataManager.kt` | **New** — .jolli/ metadata | 1.3 |
| `core/KBTypes.kt` | **New** — data classes | 1.3 |
| `settings/SettingsDialog.kt` | **Modify** — KB path setting | 1.4 |
| `bridge/SessionTracker.kt` | **Modify** — config fields | 1.4 |
| `core/DualWriteStorage.kt` | **New** — transition wrapper | 2.1 |
| `services/JolliMemoryService.kt` | **Modify** — storage mode switch | 2.1 |
| `hooks/PostCommitHook.kt` | **Modify** — use StorageProvider | 2.1, 3.1 |
| `core/MigrationEngine.kt` | **New** — bulk migration | 2.2 |
| `services/JolliApiClient.kt` | **Modify** — push from folder | 6.2 |
| `toolwindow/ExplorerPanel.kt` | **New** — KB tree view | 4.1 |
| `toolwindow/KBTreeModel.kt` | **New** — tree data model | 4.1 |
| `actions/ImportFilesAction.kt` | **New** — import user files | 4.2 |
| `toolwindow/JolliMemoryToolWindowFactory.kt` | **Major refactor** — 3-tab layout | 4.3 |
| `core/SyncEngine.kt` | **New** — sync engine | 5.1 |
| `toolwindow/StatusPanel.kt` | **Modify** — sync status + migration progress | 2.2, 5.1 |

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Data loss during migration | Orphan branch never deleted; dual-write validates first |
| JAR subprocess out of sync with IDE plugin | Both read `storage.mode` from same `config.json`; version-gate the config format |
| Concurrent writes (worker + user editing KB) | `FileChannel.tryLock()` on `.jolli/lock` — NIO-level, more robust than file-existence |
| Smart collapse breaks on user reorg | Count from `manifest.json`, not filesystem |
| Interrupted migration | `migration.json` cursor + idempotent writes |
| Plugin downgrade | Orphan branch intact, old plugin reads it fine |
| NIO WatchService overflow | Debounce (existing 500ms pattern) + periodic full refresh fallback |

---

## Verification

1. **Unit tests:** `StorageProvider` implementations — read/write/list parity between `OrphanBranchStorage` and `FolderStorage`
2. **Migration test:** Create orphan branch with test data → `MigrationEngine.runMigration()` → verify all `.md` files in KB folder
3. **E2E test:** Commit code → verify `.md` file appears in KB folder with correct YAML frontmatter
4. **Smart collapse test:** 1 commit → file in branch root; 2nd commit → both moved to `commits/`
5. **Rollback test:** Switch `storage.mode` back to `"orphan"` → verify reads still work
6. **JAR subprocess test:** Worker writes via `FolderStorage` → IDE reads via same path → data consistent
7. **Concurrent test:** Worker writing + user moving file simultaneously → no corruption (NIO lock)
