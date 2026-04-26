# JolliMemory Local Knowledge Base — Technical Journey

## Starting Point: Architecture Before Step 1.1

Before this project began, the JolliMemory IntelliJ plugin had only one way to store data: the **orphan branch**.

### What is an orphan branch?

In git, an orphan branch is a branch completely isolated from the main code history. It has its own commit history but shares no common ancestor with `main`, `feature/*`, or any working branches. JolliMemory uses `jollimemory/summaries/v3` as its orphan branch to store all data.

Users don't see it in `git branch` output (the name is long and easy to overlook), and `git log` doesn't show its commits. It's an "invisible" database hidden inside the `.git/` directory.

### What does the orphan branch store?

```
jollimemory/summaries/v3 (orphan branch)
├── index.json                          ← index of all commit summaries
├── summaries/
│   ├── abc12345...json                 ← full summary for each commit (JSON)
│   ├── def45678...json
│   └── ...
├── transcripts/
│   ├── abc12345...json                 ← AI conversation records
│   └── ...
├── plans/
│   ├── my-plan.md                      ← Claude Code plan files
│   └── ...
└── plan-progress/
    ├── my-plan.json                    ← plan progress evaluations
    └── ...
```

### How is data written?

JolliMemory uses git plumbing commands to directly manipulate the orphan branch, never checking it out:

```
User makes a git commit
  → git post-commit hook fires
  → PostCommitHook spawns a background worker process
  → Worker reads AI conversation transcript
  → Worker calls Anthropic API to generate summary
  → Worker writes to orphan branch using git plumbing:
      git hash-object -w --stdin     ← create blob
      git mktree                      ← create tree
      git commit-tree                 ← create commit
      git update-ref                  ← update branch ref
```

All of this lived in `SummaryStore.kt`'s `writeFilesToBranch()` method, mixed together. Reading data used `git show jollimemory/summaries/v3:path/to/file`.

### Problems with this architecture

1. **Users can't see their data** — data is hidden inside git internals, inaccessible from Finder or file editors
2. **Not portable** — data is bound to the git repo, can't be copied elsewhere
3. **Unfriendly format** — everything is JSON, not human-readable markdown
4. **No offline sync** — no standalone folder that could be synced via iCloud/Dropbox

---

## Step 1.1: StorageProvider Interface Extraction

### Goal

Extract the scattered git plumbing calls from `SummaryStore.kt` into a clean interface, preparing for new storage backends.

### What was done

**New `StorageProvider.kt`** — defines a 5-method interface:

```kotlin
interface StorageProvider {
    fun readFile(path: String): String?           // read a file
    fun writeFiles(files: List<FileWrite>, message: String)  // write multiple files (atomic)
    fun listFiles(prefix: String): List<String>   // list files
    fun exists(): Boolean                          // is storage initialized?
    fun ensure()                                   // ensure storage is initialized
}
```

**New `OrphanBranchStorage.kt`** — git plumbing logic moved here from SummaryStore:

```kotlin
class OrphanBranchStorage(private val git: GitOps) : StorageProvider {
    override fun readFile(path: String): String? {
        return git.readBranchFile(ORPHAN_BRANCH, path)
        // actually runs: git show jollimemory/summaries/v3:{path}
    }
    
    override fun writeFiles(files: List<FileWrite>, message: String) {
        // git hash-object → mktree → commit-tree → update-ref
    }
    // ...
}
```

**Refactored `SummaryStore.kt`** — no longer calls git commands directly, uses StorageProvider interface:

```kotlin
// Before:
val json = git.readBranchFile(ORPHAN_BRANCH, "index.json")

// After:
val json = storage.readFile("index.json")
```

SummaryStore has a backward-compatible constructor that defaults to OrphanBranchStorage:

```kotlin
class SummaryStore(cwd: String, git: GitOps, storage: StorageProvider) {
    // Backward compat: SummaryStore(cwd, git) auto-uses OrphanBranchStorage
    constructor(cwd: String, git: GitOps) : this(cwd, git, OrphanBranchStorage(git))
}
```

### Key principle

This step was a **pure refactor** — behavior completely unchanged, all existing tests pass. Data still only writes to the orphan branch.

---

## Step 1.2 + 1.3: FolderStorage + MetadataManager

### Goal

Implement the second StorageProvider — filesystem folder-based storage.

### FolderStorage (first version)

The first version was a simple file I/O layer that wrote files directly to a folder:

```kotlin
class FolderStorage(
    private val rootPath: Path,           // ~/Documents/jolli/{project}/
    private val metadataManager: MetadataManager
) : StorageProvider {
    override fun readFile(path: String): String? {
        // direct read: rootPath/path
    }
    override fun writeFiles(files: List<FileWrite>, message: String) {
        // atomic write: write temp file → rename
        // file lock: FileChannel.tryLock() for concurrency
    }
}
```

### MetadataManager

Manages the `.jolli/` metadata directory inside the KB folder:

```
~/Documents/jolli/{project}/.jolli/
├── manifest.json      ← tracks which files are AI-generated (path, type, fingerprint)
├── branches.json      ← git branch name → folder name mapping (feature/login → feature-login)
├── config.json        ← KB-level config (sort order, repo identity)
├── index.json         ← index cache
└── migration.json     ← migration state
```

**Branch name transcoding**: git branch names can contain `/`, `:`, `*` and other filesystem-unsafe characters, which need to be converted to safe folder names:

```
feature/login     → feature-login
user/name/thing   → user-name-thing
refs..heads       → refs--heads
```

### KBTypes.kt

New data classes:

```kotlin
data class ManifestEntry(
    val path: String,          // "main/add-login-abc12345.md"
    val fileId: String,        // commit hash
    val type: String,          // "commit" | "plan" | "note"
    val fingerprint: String,   // SHA-256 of content
    val title: String?,        // human-readable title "Add login feature"
    val source: ManifestSource,
)

data class BranchMapping(
    val folder: String,    // "feature-login"
    val branch: String,    // "feature/login"
    val createdAt: String,
)

data class KBConfig(
    val version: Int = 1,
    val sortOrder: String = "date",
    val remoteUrl: String?,    // repo identity
    val repoName: String?,
)
```

---

## Step 1.4: KB Path Configuration

### KBPathResolver

Solves "where does the KB folder go?":

- Default path: `~/Documents/jolli/{repoName}/`
- Users can set a custom path in Settings
- **Same-name repo collision handling**: if two different repos have the same name (e.g., both called `app`), uses `remoteUrl` in `.jolli/config.json` to determine if it's the same repo. Different repo → auto-suffix `app-2`

### Settings UI

Added "Knowledge Base" section to Settings dialog:
- Folder Path — text field + browse button
- Sort Order — dropdown (date / name)

### Auto-initialization

In `JolliMemoryService.initialize()`, every time a project is opened:
1. Resolve KB path
2. Create folder
3. Write repo identity (remoteUrl + repoName)

---

## Phase 2: Dual-Write (DualWriteStorage)

### Goal

Have every commit write to both the orphan branch and the KB folder, keeping both in sync.

### DualWriteStorage

```kotlin
class DualWriteStorage(
    private val primary: OrphanBranchStorage,  // primary: orphan branch
    private val shadow: FolderStorage,         // shadow: KB folder
) : StorageProvider {
    override fun writeFiles(files: List<FileWrite>, message: String) {
        primary.writeFiles(files, message)     // write orphan branch first
        try {
            shadow.writeFiles(files, message)  // then write folder
        } catch (e: Exception) {
            log.warn("Shadow write failed")    // folder failure doesn't block primary
        }
    }
    override fun readFile(path: String): String? {
        return primary.readFile(path)          // reads only from orphan branch
    }
}
```

### StorageFactory

Creates the appropriate StorageProvider based on the `storageMode` config field:

```kotlin
object StorageFactory {
    fun create(git: GitOps, projectPath: String): StorageProvider {
        val mode = config.storageMode ?: "orphan"
        return when (mode) {
            "orphan"     → OrphanBranchStorage(git)
            "dual-write" → DualWriteStorage(OrphanBranchStorage(git), FolderStorage(...))
            "folder"     → FolderStorage(...)
        }
    }
}
```

### Full integration

All 7 places that create SummaryStore were updated to use StorageFactory:

- JolliMemoryService (3 places)
- PostCommitHook (1 place)
- PostRewriteHook (1 place)
- SummaryPanel (1 place)
- StatusPanel (1 place)

### Activation

User adds to `~/.jolli/jollimemory/config.json`:
```json
{ "storageMode": "dual-write" }
```

---

## FolderStorage Refactor: From "Dumb Write" to "Smart Write"

### Problem

The first version of FolderStorage just wrote the same JSON files from the orphan branch into a folder. Users would see:

```
~/Documents/jolli/testJolli/
├── summaries/abc12345.json     ← raw JSON, unreadable
├── index.json                  ← index, unreadable
└── transcripts/abc12345.json   ← transcripts, unreadable
```

This completely failed the "users can browse" goal.

### Refactored FolderStorage

FolderStorage's `writeFiles()` now **intercepts** summary file writes and does two things:

**1. Hidden write** — routes JSON data files to the `.jolli/` subdirectory:

```
SummaryStore writes: "summaries/abc12345.json"
FolderStorage stores at: ".jolli/summaries/abc12345.json"  ← hidden

SummaryStore writes: "index.json"  
FolderStorage stores at: ".jolli/index.json"  ← hidden
```

**2. Visible write** — parses the JSON and generates a human-readable markdown file:

```
FolderStorage detects it's writing "summaries/abc12345.json"
  → Parses JSON into CommitSummary object
  → Calls SummaryMarkdownBuilder.buildMarkdown() to generate markdown
  → Adds YAML frontmatter (commitHash, branch, author, date, etc.)
  → Writes to: "main/add-login-feature-abc12345.md"  ← user-visible
  → Updates manifest.json (records this markdown file as AI-generated)
```

### Folder structure after refactor

```
~/Documents/jolli/testJolli/
├── main/                                          ← user-visible
│   └── add-login-feature-abc12345.md
├── feature-about-dialog/                          ← user-visible
│   ├── add-about-dialog-b2b584ac.md
│   └── update-about-title-c886d8c5.md
├── .jolli/                                        ← hidden (metadata + backup)
│   ├── summaries/abc12345.json                    ← raw JSON backup
│   ├── summaries/b2b584ac.json
│   ├── index.json
│   ├── manifest.json
│   ├── branches.json
│   ├── config.json
│   └── migration.json
```

### Markdown file format

```markdown
---
commitHash: abc12345deadbeef
branch: main
author: Alice
date: 2026-01-15T10:00:00Z
type: commit
filesChanged: 3
insertions: 50
deletions: 10
---

# Add login feature

- **Commit:** `abc12345deadbeef`
- **Branch:** `main`
- **Author:** Alice
- **Date:** January 15, 2026
- **Changes:** 3 files changed, +50 insertions, −10 deletions

---

## Summary (1)

### 01 · Login flow  `feature`

**⚡ Why This Change**

Need authentication for the app...

**💡 Decisions Behind the Code**

Use JWT tokens for session management...

**✅ What Was Implemented**

Added OAuth flow with...
```

---

## Data Migration (MigrationEngine)

### Goal

Migrate existing historical data from the orphan branch to the KB folder.

### How it works

```
What MigrationEngine does:

1. Reads index.json from orphan branch, finds all root entries
2. For each entry:
   a. Reads summaries/{hash}.json from orphan branch
   b. Calls FolderStorage.writeFiles() to write
   c. FolderStorage automatically:
      - Stores JSON to .jolli/summaries/
      - Generates markdown to {branch}/ folder
      - Updates manifest
3. Also migrates transcripts/, plans/, plan-progress/
4. Records progress in .jolli/migration.json
```

### Idempotency

- If a commit is already in the manifest (checked by fileId/commitHash), skip it
- If an existing entry is missing the title field (generated by older version), backfill it
- Migration can be interrupted and resumed (from migration.json's lastMigratedHash)

### Auto-migration

On plugin startup (`JolliMemoryService.initialize()`), if detected:
- Orphan branch exists
- Migration status is not "completed"

Migration runs automatically. Users can also manually click "Migrate to Knowledge Base" in Settings.

---

## Phase 4: Explorer UI (Memories Panel)

### Tool window structure

Added a second Content to the existing "JOLLI MEMORY" tool window (renamed to "JOLLI"):

```
JOLLI tool window
├── 📚 Memories  ← new: KB folder browser
└── 🌿 main      ← existing: 5 collapsible panels (STATUS/MEMORIES/PLANS/CHANGES/COMMITS)
```

Uses IntelliJ's ContentManager, dropdown arrow appears in the title bar for switching. The 🌿 tab title auto-updates to show the current branch name.

### KBExplorerPanel

Tree-based file browser showing the KB folder contents:

- Hides `.jolli/` directory
- Reads badges and titles from manifest.json
- Shows badges next to files: `C` (commit, purple), `P` (plan, blue), `N` (note, green)
- Displays manifest title (e.g., "Add login feature") instead of filename
- Double-click commit file → opens JCEF webview (formatted display, same as eye icon)
- Double-click other files → opens in IntelliJ editor

### Context menu

- New Folder / New Markdown File / Import File(s)...
- Rename / Move to... / Delete
- Open in Finder

All operations involving manifest-tracked files automatically sync `manifest.json` and `branches.json`.

### Drag and Drop

- Internal drag: move files/folders between directories → updates manifest
- External drag: drop files from Finder into KB folder

### External Change Detection (Reconcile)

On every refresh, `MetadataManager.reconcile()` compares the actual filesystem state vs manifest records:

- File deleted → remove from manifest
- File moved → match by SHA-256 fingerprint to find new location → update manifest
- New file appears → no action (shown as badge-less user file)

---

## Three Copies of Data

In the current dual-write mode, each commit produces three copies of data:

```
PostCommitHook → DualWriteStorage
│
├─ OrphanBranchStorage (primary)
│  Writes to orphan branch:
│    summaries/abc12345.json    ← raw JSON
│    index.json                 ← index
│    transcripts/abc12345.json  ← conversation records
│
└─ FolderStorage (shadow)
   Writes to KB folder:
     .jolli/summaries/abc12345.json    ← JSON backup (same content as orphan branch)
     .jolli/index.json                 ← index (same content as orphan branch)
     .jolli/transcripts/abc12345.json  ← conversation records
     .jolli/manifest.json              ← tracking info update
     main/add-login-feature-abc12345.md ← human-readable markdown (unique to folder)
```

### Data consistency

| Storage location | Content | Modifiable? | Purpose |
|---------|------|---------|------|
| Orphan branch `summaries/*.json` | Raw JSON | No (git plumbing is append-only) | Primary data source, used for reads and API push |
| `.jolli/summaries/*.json` | Raw JSON (copy) | Should not be modified | Self-contained backup, used to rebuild markdown |
| `{branch}/*.md` | Markdown | User can modify | Human-readable, browsable, editable |

### Data recovery chain

```
If markdown files are messed up by user:
  → Rebuild from .jolli/summaries/*.json (Rebuild button)

If .jolli/ directory is deleted:
  → Re-migrate from orphan branch (Migrate button)

If orphan branch is also gone (e.g., storageMode = "folder"):
  → As long as .jolli/summaries/*.json exists, markdown can be rebuilt
  → If .jolli/ is also deleted → data is lost, cannot recover
```

---

## Future Evolution

Once the folder solution is stable, gradual transition:

1. **Enable dual-write by default** — new installs auto-set `storageMode: "dual-write"`
2. **Switch to folder-first reads** — reads go to folder instead of orphan branch
3. **Stop writing orphan branch** — `storageMode: "folder"`, only write folder
4. **Orphan branch becomes optional backup** — users can choose to keep or delete

`.jolli/summaries/*.json` as a self-contained backup ensures that even without the orphan branch, data can be recovered.

---

## Bugs Fixed Along the Way

| Bug | Cause | Fix |
|-----|-------|-----|
| Eye icon missing after rebase | `getSummary()` didn't resolve commit aliases | Call `resolveAlias()` before reading file |
| Squash root commit failed | `git rev-parse $hash^` fails for first commit | Detect root commit, use `update-ref -d HEAD` |
| New branch shows old commits | `getBranchCommits()` fell back to recent 20 | Return empty list |
| Settings Apply lost storageMode | `saveConfigToDir` directly overwrote | Merge unmanaged fields from existing config |
| Memories panel didn't refresh | No periodic refresh | Add 3-second polling + status listener |
| Branch tab title didn't update | Only listened to `GIT_REPO_CHANGE` | Add VCS listener + 2-second polling |
| KBExplorerPanel stuck on Loading | Background thread initialization issue | Simplified to factory calling `load()` + periodic refresh |
| KB path mismatch for old folders | Old config missing repoName | `isSameRepo` tolerates null repoName |
