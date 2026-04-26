# JolliMemory 本地知识库（Local Knowledge Base）技术演进全记录

## 起点：Step 1.1 之前的架构

在开始这个项目之前，JolliMemory IntelliJ 插件的数据存储只有一种方式：**orphan branch**。

### 什么是 orphan branch？

在 git 里，orphan branch 是一个跟主代码历史完全隔离的分支。它有自己的 commit 历史，但跟 `main`、`feature/*` 等工作分支没有任何关系。JolliMemory 用 `jollimemory/summaries/v3` 这个 orphan branch 来存储所有数据。

用户在终端 `git branch` 看不到它（因为它太长了，通常被忽略），`git log` 也看不到它的 commit。它是一个"隐形"的数据库，藏在 `.git/` 目录内部。

### Orphan branch 里存了什么？

```
jollimemory/summaries/v3 (orphan branch)
├── index.json                          ← 所有 commit 的索引目录
├── summaries/
│   ├── abc12345...json                 ← 每个 commit 的完整摘要（JSON 格式）
│   ├── def45678...json
│   └── ...
├── transcripts/
│   ├── abc12345...json                 ← AI 对话记录
│   └── ...
├── plans/
│   ├── my-plan.md                      ← Claude Code 的计划文件
│   └── ...
└── plan-progress/
    ├── my-plan.json                    ← 计划进度评估
    └── ...
```

### 数据怎么写进去的？

JolliMemory 用 git 底层命令（plumbing commands）直接操作 orphan branch，从不 checkout 它：

```
用户做了一次 git commit
  → git post-commit hook 触发
  → PostCommitHook 启动后台 worker 进程
  → worker 读取 AI 对话记录（transcript）
  → worker 调用 Anthropic API 生成摘要
  → worker 用 git plumbing 写入 orphan branch：
      git hash-object -w --stdin     ← 创建 blob
      git mktree                      ← 创建 tree
      git commit-tree                 ← 创建 commit
      git update-ref                  ← 更新 branch ref
```

这些操作全在 `SummaryStore.kt` 的 `writeFilesToBranch()` 方法里，混在一起。读取数据则用 `git show jollimemory/summaries/v3:path/to/file`。

### 这种架构的问题

1. **用户看不到数据** — 数据藏在 git 内部，用户无法用 Finder 或文件编辑器浏览
2. **不可移植** — 数据绑定在 git repo 里，不能拷贝到其他地方
3. **格式不友好** — 全是 JSON，不是人类可读的 markdown
4. **无法离线同步** — 没有独立的文件夹可以用 iCloud/Dropbox 等同步

---

## Step 1.1: StorageProvider 接口抽取

### 目标

把 `SummaryStore.kt` 里散落的 git plumbing 调用抽取成一个干净的接口，为后续添加新的存储方式做准备。

### 做了什么

**新建 `StorageProvider.kt`** — 定义了 5 个方法的接口：

```kotlin
interface StorageProvider {
    fun readFile(path: String): String?           // 读文件
    fun writeFiles(files: List<FileWrite>, message: String)  // 写多个文件（原子）
    fun listFiles(prefix: String): List<String>   // 列出文件
    fun exists(): Boolean                          // 存储是否已初始化
    fun ensure()                                   // 确保存储已初始化
}
```

**新建 `OrphanBranchStorage.kt`** — 把 git plumbing 逻辑从 SummaryStore 搬到这里：

```kotlin
class OrphanBranchStorage(private val git: GitOps) : StorageProvider {
    override fun readFile(path: String): String? {
        return git.readBranchFile(ORPHAN_BRANCH, path)
        // 实际执行: git show jollimemory/summaries/v3:{path}
    }
    
    override fun writeFiles(files: List<FileWrite>, message: String) {
        // git hash-object → mktree → commit-tree → update-ref
    }
    // ...
}
```

**重构 `SummaryStore.kt`** — 不再直接调用 git 命令，改为通过 StorageProvider 接口：

```kotlin
// 重构前：
val json = git.readBranchFile(ORPHAN_BRANCH, "index.json")

// 重构后：
val json = storage.readFile("index.json")
```

SummaryStore 有一个向后兼容的构造函数，默认使用 OrphanBranchStorage：

```kotlin
class SummaryStore(cwd: String, git: GitOps, storage: StorageProvider) {
    // 向后兼容：旧代码 SummaryStore(cwd, git) 自动用 OrphanBranchStorage
    constructor(cwd: String, git: GitOps) : this(cwd, git, OrphanBranchStorage(git))
}
```

### 关键原则

这一步是**纯重构** — 行为完全不变，所有现有测试照过。数据仍然只写 orphan branch。

---

## Step 1.2 + 1.3: FolderStorage + MetadataManager

### 目标

实现第二个 StorageProvider — 基于普通文件夹的存储。

### FolderStorage（第一版）

第一版是一个"笨"的文件 I/O 层，直接把文件写到文件夹里：

```kotlin
class FolderStorage(
    private val rootPath: Path,           // ~/Documents/jolli/{project}/
    private val metadataManager: MetadataManager
) : StorageProvider {
    override fun readFile(path: String): String? {
        // 直接读: rootPath/path
    }
    override fun writeFiles(files: List<FileWrite>, message: String) {
        // 用原子写入: 写临时文件 → rename
        // 用文件锁: FileChannel.tryLock() 防并发
    }
}
```

### MetadataManager

管理 KB 文件夹里的 `.jolli/` 元数据目录：

```
~/Documents/jolli/{project}/.jolli/
├── manifest.json      ← 追踪哪些文件是 AI 生成的（路径、类型、指纹）
├── branches.json      ← git 分支名 → 文件夹名的映射（feature/login → feature-login）
├── config.json        ← KB 级别配置（排序方式、repo identity）
├── index.json         ← 索引缓存
└── migration.json     ← 迁移状态
```

**分支名转码**：git 分支名可以包含 `/`、`:`、`*` 等文件系统不允许的字符，需要转成安全的文件夹名：

```
feature/login     → feature-login
user/name/thing   → user-name-thing
refs..heads       → refs--heads
```

### KBTypes.kt

新的数据类：

```kotlin
data class ManifestEntry(
    val path: String,          // "main/add-login-abc12345.md"
    val fileId: String,        // commit hash
    val type: String,          // "commit" | "plan" | "note"
    val fingerprint: String,   // SHA-256 of content
    val title: String?,        // 人类可读标题 "Add login feature"
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

## Step 1.4: KB 路径配置

### KBPathResolver

解决"KB 文件夹放在哪里"的问题：

- 默认路径：`~/Documents/jolli/{repoName}/`
- 用户可以在 Settings 里自定义路径
- **同名 repo 冲突处理**：如果两个不同的 repo 叫同一个名字（比如都叫 `app`），通过 `.jolli/config.json` 里的 `remoteUrl` 判断是否同一个 repo。不同 repo → 自动加后缀 `app-2`

### Settings UI

在 Settings dialog 里加了 "Knowledge Base" 区域：
- Folder Path — 文本框 + 浏览按钮
- Sort Order — 下拉框（date / name）

### 自动初始化

在 `JolliMemoryService.initialize()` 里，每次打开项目自动：
1. 解析 KB 路径
2. 创建文件夹
3. 写入 repo identity（remoteUrl + repoName）

---

## Phase 2: 双写（DualWriteStorage）

### 目标

让每次 commit 同时写入 orphan branch 和 KB 文件夹，确保两边数据一致。

### DualWriteStorage

```kotlin
class DualWriteStorage(
    private val primary: OrphanBranchStorage,  // 主存储：orphan branch
    private val shadow: FolderStorage,         // 影子存储：KB 文件夹
) : StorageProvider {
    override fun writeFiles(files: List<FileWrite>, message: String) {
        primary.writeFiles(files, message)     // 先写 orphan branch
        try {
            shadow.writeFiles(files, message)  // 再写 folder
        } catch (e: Exception) {
            log.warn("Shadow write failed")    // folder 写失败不影响主流程
        }
    }
    override fun readFile(path: String): String? {
        return primary.readFile(path)          // 读取只走 orphan branch
    }
}
```

### StorageFactory

根据 `config.json` 里的 `storageMode` 字段创建对应的 StorageProvider：

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

### 全面接入

把所有创建 SummaryStore 的地方（7 处）都改为使用 StorageFactory：

- JolliMemoryService（3 处）
- PostCommitHook（1 处）
- PostRewriteHook（1 处）
- SummaryPanel（1 处）
- StatusPanel（1 处）

### 激活方式

用户在 `~/.jolli/jollimemory/config.json` 里加：
```json
{ "storageMode": "dual-write" }
```

---

## FolderStorage 重构：从"笨写"到"智能写"

### 问题

第一版 FolderStorage 只是把跟 orphan branch 一样的 JSON 文件写到文件夹里。用户打开文件夹看到的是：

```
~/Documents/jolli/testJolli/
├── summaries/abc12345.json     ← 原始 JSON，看不懂
├── index.json                  ← 索引，看不懂
└── transcripts/abc12345.json   ← 对话记录，看不懂
```

这完全没有达到"用户可以浏览"的目标。

### 重构后的 FolderStorage

FolderStorage 的 `writeFiles()` 现在会**拦截** summary 文件的写入，自动做两件事：

**1. 隐藏写入** — 把 JSON 数据文件路由到 `.jolli/` 子目录：

```
SummaryStore 写: "summaries/abc12345.json"
FolderStorage 实际写到: ".jolli/summaries/abc12345.json"  ← 隐藏

SummaryStore 写: "index.json"  
FolderStorage 实际写到: ".jolli/index.json"  ← 隐藏
```

**2. 可见写入** — 解析 JSON，生成人类可读的 markdown 文件：

```
FolderStorage 检测到写的是 "summaries/abc12345.json"
  → 解析 JSON 为 CommitSummary 对象
  → 调用 SummaryMarkdownBuilder.buildMarkdown() 生成 markdown
  → 加上 YAML frontmatter（commitHash, branch, author, date 等）
  → 写到: "main/add-login-feature-abc12345.md"  ← 用户可见
  → 更新 manifest.json（记录这个 markdown 文件是 AI 生成的）
```

### 重构后的文件夹结构

```
~/Documents/jolli/testJolli/
├── main/                                          ← 用户可见
│   └── add-login-feature-abc12345.md
├── feature-about-dialog/                          ← 用户可见
│   ├── add-about-dialog-b2b584ac.md
│   └── update-about-title-c886d8c5.md
├── .jolli/                                        ← 隐藏（元数据 + 备份）
│   ├── summaries/abc12345.json                    ← 原始 JSON 备份
│   ├── summaries/b2b584ac.json
│   ├── index.json
│   ├── manifest.json
│   ├── branches.json
│   ├── config.json
│   └── migration.json
```

### Markdown 文件格式

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

## 数据迁移（MigrationEngine）

### 目标

把 orphan branch 上已有的历史数据迁移到 KB 文件夹。

### 工作原理

```
MigrationEngine 做的事：

1. 从 orphan branch 读 index.json，找到所有 root entries
2. 对每个 entry：
   a. 读 orphan branch 上的 summaries/{hash}.json
   b. 调用 FolderStorage.writeFiles() 写入
   c. FolderStorage 自动：
      - 把 JSON 存到 .jolli/summaries/
      - 生成 markdown 存到 {branch}/ 文件夹
      - 更新 manifest
3. 同样迁移 transcripts/、plans/、plan-progress/
4. 在 .jolli/migration.json 记录进度
```

### 幂等性

- 如果一个 commit 已经在 manifest 里（通过 fileId/commitHash 检查），跳过
- 如果已有条目缺少 title 字段（旧版本生成的），自动补充
- 迁移可以中断后恢复（从 migration.json 的 lastMigratedHash 继续）

### 自动迁移

插件启动时（`JolliMemoryService.initialize()`），如果检测到：
- Orphan branch 存在
- Migration 状态不是 "completed"

会自动运行迁移。用户也可以在 Settings 里手动点 "Migrate to Knowledge Base" 按钮。

---

## Phase 4: Explorer UI（Memories 面板）

### 工具窗口结构

在原来的 "JOLLI MEMORY" 工具窗口（改名为 "JOLLI"）里，加了第二个 Content：

```
JOLLI 工具窗口
├── 📚 Memories  ← 新增：KB 文件夹浏览器
└── 🌿 main      ← 原有：5 个折叠面板（STATUS/MEMORIES/PLANS/CHANGES/COMMITS）
```

使用 IntelliJ 的 ContentManager，标题栏出现下拉箭头切换。🌿 tab 的标题会自动显示当前分支名。

### KBExplorerPanel

树形文件浏览器，显示 KB 文件夹的内容：

- 隐藏 `.jolli/` 目录
- 从 manifest.json 读取 badge 和 title
- 文件旁边显示徽标：`C`（commit 紫色）、`P`（plan 蓝色）、`N`（note 绿色）
- 显示 manifest 里的 title（如 "Add login feature"）而不是文件名
- 双击 commit 文件 → 打开 JCEF webview（格式化显示，跟 eye 图标一样）
- 双击其他文件 → 用 IntelliJ 编辑器打开

### 右键菜单

- New Folder / New Markdown File / Import File(s)...
- Rename / Move to... / Delete
- Open in Finder

所有操作涉及 manifest 追踪的文件时，自动同步 `manifest.json` 和 `branches.json`。

### Drag and Drop

- 树内拖拽：移动文件/文件夹 → 更新 manifest
- 从 Finder 拖入：拷贝文件到 KB 文件夹

### 外部变更检测（Reconcile）

每次 refresh 时，`MetadataManager.reconcile()` 检测文件夹的实际状态 vs manifest 记录：

- 文件被删除 → 从 manifest 移除
- 文件被移动 → 通过 SHA-256 fingerprint 匹配找到新位置 → 更新 manifest
- 新文件出现 → 不处理（显示为无 badge 的用户文件）

---

## 三份数据的关系

当前双写模式下，一次 commit 产生三份数据：

```
PostCommitHook → DualWriteStorage
│
├─ OrphanBranchStorage（primary）
│  写入 orphan branch：
│    summaries/abc12345.json    ← 原始 JSON
│    index.json                 ← 索引
│    transcripts/abc12345.json  ← 对话记录
│
└─ FolderStorage（shadow）
   写入 KB 文件夹：
     .jolli/summaries/abc12345.json    ← JSON 备份（跟 orphan branch 一样的内容）
     .jolli/index.json                 ← 索引（跟 orphan branch 一样的内容）
     .jolli/transcripts/abc12345.json  ← 对话记录
     .jolli/manifest.json              ← 更新追踪信息
     main/add-login-feature-abc12345.md ← 人类可读的 markdown（独有）
```

### 数据一致性

| 存储位置 | 内容 | 可修改？ | 用途 |
|---------|------|---------|------|
| Orphan branch `summaries/*.json` | 原始 JSON | 不可（git plumbing 只追加） | 主数据源，用于读取和 API push |
| `.jolli/summaries/*.json` | 原始 JSON（副本） | 不应该改 | 自包含备份，用于重建 markdown |
| `{branch}/*.md` | Markdown | 用户可以改 | 人类可读，可浏览，可编辑 |

### 数据恢复链

```
如果 markdown 被用户改乱了：
  → 从 .jolli/summaries/*.json 重建（Rebuild 按钮）

如果 .jolli/ 目录被删了：
  → 从 orphan branch 重新迁移（Migrate 按钮）

如果 orphan branch 也没了（比如 storageMode = "folder"）：
  → 只要 .jolli/summaries/*.json 在，就能重建 markdown
  → 如果 .jolli/ 也被删了 → 数据丢失，无法恢复
```

---

## 未来演进方向

当 folder 方案稳定后，可以逐步：

1. **默认开启双写** — 新安装的插件自动 `storageMode: "dual-write"`
2. **切换为 folder 优先** — 读取从 orphan branch 改为 folder
3. **停止写 orphan branch** — `storageMode: "folder"`，只写 folder
4. **orphan branch 成为可选备份** — 用户可以选择保留或删除

`.jolli/summaries/*.json` 作为自包含备份，确保即使没有 orphan branch，数据也可以恢复。

---

## 一路修复的 Bug

| Bug | 原因 | 修复 |
|-----|------|------|
| Rebase 后 eye 图标消失 | `getSummary()` 没解析 commit alias | 先 `resolveAlias()` 再读文件 |
| Squash root commit 失败 | `git rev-parse $hash^` 对首次 commit 失败 | 检测 root commit，用 `update-ref -d HEAD` |
| 新分支 CommitsPanel 显示旧 commit | `getBranchCommits()` fallback 到最近 20 条 | 返回空列表 |
| Settings Apply 丢失 storageMode | `saveConfigToDir` 直接覆写 | 合并现有 config 的不受管理字段 |
| Memories panel 不刷新 | 没有定时刷新 | 加 3 秒轮询 + status listener |
| Branch tab 标题不更新 | 只监听 `GIT_REPO_CHANGE` | 加 VCS listener + 2 秒轮询 |
| KBExplorerPanel 一直显示 Loading | 后台线程初始化逻辑问题 | 简化为 factory 调用 `load()` + 定时 refresh |
| KB 路径旧版不匹配 | 旧 config 没有 repoName | `isSameRepo` 对 null repoName 容错 |
