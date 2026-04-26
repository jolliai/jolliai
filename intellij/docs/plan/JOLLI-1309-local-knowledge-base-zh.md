# JOLLI-1309：本地知识库 — IntelliJ 实施计划

---

## 背景

IntelliJ 插件是**完全独立的 Kotlin 原生重写** — 与 VS Code/CLI 的 TypeScript 实现零共享代码。它使用相同的孤儿分支存储格式（`jollimemory/summaries/v3`、`index.json` v3），但所有代码独立实现：`SummaryStore.kt` 负责存储、`GitOps.kt` 负责 git 底层操作、`PostCommitHook.kt` 负责 Worker 流水线、JCEF 负责 Webview 渲染。

本计划将相同的 6 阶段架构映射到 IntelliJ 的 Kotlin 代码库，精确标注需要改动的文件、类和方法。

## 当前 IntelliJ 架构

```
PostCommitHook（JAR 子进程）
  → SessionTracker（锁、会话、游标）
  → TranscriptReader（JSONL 解析）
  → Summarizer（Anthropic HTTP API）
  → SummaryStore.writeFilesToBranch()
      → GitOps（hash-object、mktree、commit-tree、update-ref）
      → 孤儿分支：jollimemory/summaries/v3

JolliMemoryService（项目级服务）
  → SummaryReader → SummaryStore（读取索引、读取摘要）
  → GitOps（分支提交、状态、差异）
  → NIO WatchService（监听 .git/refs/heads/jollimemory/）
  → PanelRegistry → UI 面板（Status、Memories、Plans、Changes、Commits）
```

## 新架构

```
PostCommitHook（JAR 子进程）
  → SessionTracker
  → TranscriptReader
  → Summarizer
  → SummaryStore → StorageProvider（接口）
                      ├── OrphanBranchStorage（包装当前 GitOps 调用）
                      ├── FolderStorage（新：~/Documents/jollimemory/<project>/）
                      └── DualWriteStorage（过渡期包装器）

JolliMemoryService
  → SummaryReader → StorageProvider
  → GitOps（分支提交、状态、差异 — 不变）
  → NIO WatchService（现在同时监听知识库文件夹）
  → PanelRegistry → UI 面板（三标签布局）
```

---

## 第一阶段：基础 — 存储抽象层 + 文件夹引擎

**关联 Issue：** JOLLI-1312、JOLLI-1315、JOLLI-1310

### 步骤 1.1：StorageProvider 接口 + OrphanBranchStorage 适配器

将 `SummaryStore.kt` 中所有孤儿分支 I/O 提取为清晰的接口。

**新建文件 — `core/StorageProvider.kt`：**
```kotlin
interface StorageProvider {
    suspend fun readFile(path: String): String?
    suspend fun writeFiles(files: List<FileWrite>, message: String)
    suspend fun listFiles(prefix: String? = null): List<String>
    suspend fun exists(): Boolean
    suspend fun ensure()
}
```

**新建文件 — `core/OrphanBranchStorage.kt`：**
- 将 `SummaryStore.kt` 中的 `writeFilesToBranch()` 逻辑移入（git 底层操作：hash-object → mktree → commit-tree → update-ref）
- 将 `readFileFromBranch()` 调用移入（当前为 `gitOps.readBranchFile()`）
- 将 `listFilesInBranch()` 调用移入（当前为 `gitOps.listBranchFiles()`）
- 以 `StorageProvider` 接口封装

**重构 — `core/SummaryStore.kt`：**
- 将所有直接的 `gitOps.readBranchFile()` / `writeFilesToBranch()` 调用替换为 `storageProvider.readFile()` / `storageProvider.writeFiles()`
- 通过构造函数注入 `StorageProvider`（当前 SummaryStore 接收 `gitOps: GitOps` + `cwd: String`）
- **受影响的方法：**
  - `storeSummary()` — 使用 `writeFilesToBranch()`
  - `migrateOneToOne()` — 使用 `writeFilesToBranch()`
  - `mergeManyToOne()` — 使用 `writeFilesToBranch()`
  - `loadIndex()` — 使用 `gitOps.readBranchFile("index.json")`
  - `getSummary()` — 使用 `gitOps.readBranchFile("summaries/$hash.json")`
  - `readTranscript()` — 使用 `gitOps.readBranchFile("transcripts/$hash.json")`
  - `readPlanFromBranch()` — 使用 `gitOps.readBranchFile("plans/$slug.md")`
  - `readPlanProgress()` — 使用 `gitOps.readBranchFile("plan-progress/$slug.json")`
  - `writeTranscriptBatch()` — 使用 `writeFilesToBranch()`
  - `writePlanToBranch()` — 使用 `writeFilesToBranch()`
  - `storePlanFiles()` — 使用 `writeFilesToBranch()`
  - `scanTreeHashAliases()` — 使用 `writeFilesToBranch()` 写入别名缓存
  - `migrateIndexToV3()` — 使用 `writeFilesToBranch()`

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/StorageProvider.kt`（新建）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/OrphanBranchStorage.kt`（新建）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/SummaryStore.kt`（重构）

**验证：** 所有现有测试无修改通过 — 纯重构。

### 步骤 1.2：FolderStorage 实现

**新建文件 — `core/FolderStorage.kt`：**

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

**实现细节：**
- 原子写入：`Files.write(tmpPath, ...) → Files.move(tmpPath, targetPath, ATOMIC_MOVE)`
- 文件锁：`.jolli/lock`，使用 `FileChannel.tryLock()`（Java NIO — 比文件存在性检查更可靠）
- 分支名转码：`feature/jolli-400` → `feature-jolli-400`
  - 替换 `/`、`\`、`:`、`*`、`?`、`~`、`^` → `-`
  - 替换 `..` → `--`，合并连续 `-`，去除首尾 `.` 和 `-`
- 智能折叠：按类型统计 manifest 条目数，达到 2 时创建子文件夹
- Markdown 渲染：复用 `SummaryMarkdownBuilder` 模式，生成带 YAML frontmatter 的 `.md` 输出

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/FolderStorage.kt`（新建）

### 步骤 1.3：.jolli/ 元数据层（JOLLI-1315）

**新建文件 — `core/MetadataManager.kt`：**

管理 `.jolli/` 目录的所有内容：

```kotlin
class MetadataManager(private val jolliDir: Path) {
    // .jolli/manifest.json — AI 生成文件跟踪
    fun readManifest(): Manifest
    fun updateManifest(entry: ManifestEntry)
    fun removeFromManifest(fileId: String)

    // .jolli/branches.json — 分支 ↔ 文件夹映射
    fun resolveFolderForBranch(branchName: String): String
    fun updateBranchMapping(folder: String, branch: String)

    // .jolli/index.json — 可重建缓存
    fun rebuildIndex()

    // .jolli/config.json — 知识库设置
    fun readConfig(): KBConfig
    fun saveConfig(config: KBConfig)
}
```

**数据类**（在 `core/Types.kt` 或新建 `core/KBTypes.kt`）：
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

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/MetadataManager.kt`（新建）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/KBTypes.kt`（新建）

### 步骤 1.4：知识库根目录配置（JOLLI-1310）

**修改 — `settings/JolliMemoryConfigurable.kt` + `settings/SettingsDialog.kt`：**
- 添加"知识库"设置区域：
  - 文件夹路径字段 + 浏览按钮（`JBTextField` + `FileChooserDescriptor`）
  - 默认值：`~/Documents/jollimemory/{project}/`
  - 排序切换：按日期 / 按名称（`ComboBox`）

**修改 — `core/Types.kt` 或配置数据类：**
```kotlin
data class JolliMemoryConfig(
    // ... 现有字段 ...
    val knowledgeBasePath: String?,     // 新增
    val knowledgeBaseSort: String?,     // "date" | "name"，新增
)
```

**修改 — `bridge/SessionTracker.kt`：**
- `loadConfig()` / `saveConfig()` — 处理新字段

**可与步骤 1.1–1.3 并行开发**（纯 UI 工作）。

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/settings/JolliMemoryConfigurable.kt`（修改）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/settings/SettingsDialog.kt`（修改）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/bridge/SessionTracker.kt`（修改）

---

## 第二阶段：安全迁移 — 双写 + 批量迁移

**关联 Issue：** JOLLI-1312（迁移部分）

### 步骤 2.1：双写存储

**新建文件 — `core/DualWriteStorage.kt`：**

```kotlin
class DualWriteStorage(
    private val primary: OrphanBranchStorage,
    private val shadow: FolderStorage,
    private val logger: Logger
) : StorageProvider {
    override suspend fun writeFiles(files: List<FileWrite>, message: String) {
        primary.writeFiles(files, message)
        try { shadow.writeFiles(files, message) }
        catch (e: Exception) { logger.warn("FolderStorage 影子写入失败", e) }
    }
    override suspend fun readFile(path: String): String? = primary.readFile(path)
    // ...
}
```

**修改 — `services/JolliMemoryService.kt`：**
- 从配置读取 `storage.mode`
- 实例化对应的 `StorageProvider`：
  - `"orphan"` → `OrphanBranchStorage`（默认，向后兼容）
  - `"dual-write"` → `DualWriteStorage`
  - `"folder"` → `FolderStorage`
- 传入 `SummaryStore` 构造函数

**同时修改 — `hooks/PostCommitHook.kt`：**
- Worker 创建自己的 `SummaryStore` 实例 — 必须同样读取 `storage.mode` 并使用正确的 Provider
- JAR 子进程需要访问相同的配置

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/DualWriteStorage.kt`（新建）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/services/JolliMemoryService.kt`（修改）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/hooks/PostCommitHook.kt`（修改）

### 步骤 2.2：批量迁移引擎

**新建文件 — `core/MigrationEngine.kt`：**

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

**迁移流程：**
1. 通过 `orphanStorage` 从孤儿分支读取 `index.json`
2. 过滤根条目（parentCommitHash == null）
3. 对每个根条目：
   a. 读取 `summaries/{hash}.json` → 解析 `CommitSummary`
   b. 渲染为 Markdown（复用 `SummaryMarkdownBuilder.buildMarkdown()` — IntelliJ 中已有）
   c. 通过 `metadataManager.resolveFolderForBranch()` 确定分支文件夹
   d. 应用智能折叠规则
   e. 写入 `.md` 文件到知识库文件夹
   f. 更新 `manifest.json`
   g. 更新 `.jolli/migration.json` 进度
4. 同时迁移：`plans/*.md`、`notes/*.md`、`transcripts/*.json`
5. 验证：比对 `index.entries.count { it.parentCommitHash == null }` 与 `manifest.files.size`

**进度状态：** `.jolli/migration.json`
- 幂等（通过 manifest 中的 fileId 跳过）
- 可恢复（从 `lastMigratedHash` 继续）

**与 UI 集成：**
- `StatusPanel.kt` — 显示迁移进度条/通知
- 非阻塞：在 `Dispatchers.IO` 协程上运行

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/MigrationEngine.kt`（新建）

### 步骤 2.3：读取切换 + 孤儿分支退役

**修改 — `services/JolliMemoryService.kt`：**
- 迁移验证通过后，将 `storage.mode` 切换为 `"folder"`
- `FolderStorage` 成为唯一 Provider
- 孤儿分支引用保留（永不删除）

**修改 — `settings/SettingsDialog.kt`：**
- 添加"移除旧存储"按钮（删除孤儿分支引用）
- 仅在 `storage.mode == "folder"` 且孤儿分支存在时显示

---

## 第三阶段：流水线改造 — 提交记忆写入文件夹

**关联 Issue：** JOLLI-1311

### 步骤 3.1：改造 PostCommitHook Worker

**修改 — `hooks/PostCommitHook.kt`：**
- Worker 当前调用 `summaryStore.storeSummary()`，后者调用 `writeFilesToBranch()`
- 经过第一阶段重构后，这将自动通过 `StorageProvider` 流转
- **额外工作：** 生成带 YAML frontmatter 的 Markdown 文件（不仅仅是 JSON 摘要）

**`FolderStorage` 写入的新输出格式：**
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

**修改 — `core/SummaryStore.kt`：**
- 使用 `FolderStorage` 时，`storeSummary()` 必须：
  1. 写入 Markdown 文件（可见）：`<hash8>-<slug>.md`，通过 `SummaryMarkdownBuilder`
  2. 写入 JSON 摘要（隐藏）：`.jolli/summaries/<hash>.json`（供程序化访问）
  3. 更新 `manifest.json` 和 `index.json`
  4. 应用智能折叠规则

**简化/移除：**
- `JolliApiClient.kt` 推送流程 — 当前从孤儿分支读取 → 改为从文件夹读取
- 所有重复的孤儿分支 → 文件夹复制的导出代码

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/hooks/PostCommitHook.kt`（修改）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/SummaryStore.kt`（修改）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/services/JolliApiClient.kt`（修改）

---

## 第四阶段：资源管理器 UI — 浏览知识库

**关联 Issue：** JOLLI-1313、JOLLI-1314、JOLLI-1318

### 步骤 4.1：资源管理器面板 — 知识库文件夹树（JOLLI-1313）

**新建文件 — `toolwindow/ExplorerPanel.kt`：**

使用 `JBTreeTable` 或 `Tree` 配合自定义 `TreeModel` 的 IntelliJ 树组件：

```kotlin
class KBTreeModel(private val kbRoot: Path, private val metadataManager: MetadataManager) : TreeModel {
    // 根子节点 = 分支文件夹（按日期或名称排序）
    // 分支子节点 = 文件 + 子文件夹（commits/、plans/、notes/）
    // 叶节点 = Markdown 文件，带来自 manifest 的 C/P/N 徽章
}
```

**树节点渲染** 通过 `ColoredTreeCellRenderer`：
- 分支文件夹：文件夹图标 + 分支名
- 带徽章的文件：`[C]` 紫色 / `[P]` 蓝色 / `[N]` 绿色（来自 manifest 类型）
- 用户文件：无徽章

**交互：**
- 点击提交（C）→ 打开 `SummaryFileEditor`（现有 JCEF webview）
- 点击计划/笔记（P/N）→ 在 IntelliJ 文本编辑器中打开
- 点击用户文件 → 在对应编辑器中打开
- 右键 → 上下文菜单：新建文件、新建文件夹、重命名、删除、导入文件...
- 拖放 → 在文件夹间移动文件

**自动刷新：** 在知识库根文件夹上使用 NIO `WatchService`（扩展 `JolliMemoryService` 中现有的监听器）

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/ExplorerPanel.kt`（新建）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/KBTreeModel.kt`（新建）

### 步骤 4.2：导入与整理用户文件（JOLLI-1314）

**修改 — `toolwindow/ExplorerPanel.kt`：**
- 右键操作"导入文件..." → `FileChooser.chooseFiles()` → 复制到知识库文件夹
- AI 生成文件移动/重命名时 → `metadataManager.updateManifest()` 更新路径
- 支持任意文件类型

**新建 Action — `actions/ImportFilesAction.kt`：**
- 注册在 `JolliMemory.ExplorerActions` 组中

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/ExplorerPanel.kt`（修改）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/actions/ImportFilesAction.kt`（新建）

### 步骤 4.3：UI 重新设计 — 三标签布局（JOLLI-1318）

**已分配给 sanshi.zhang** — 独立工作流。

**修改 — `toolwindow/JolliMemoryToolWindowFactory.kt`：**
- 将当前 5 面板手风琴布局替换为 3 标签 `JBTabbedPane`：
  - 标签 1：记忆（ExplorerPanel — 知识库文件夹树）
  - 标签 2：分支（PlansPanel + ChangesPanel + CommitsPanel — 现有面板重新组合）
  - 标签 3：状态（StatusPanel — 现有面板）
- 标签 2 标题在切换分支时自动更新（通过 `JolliMemoryService` 分支监听器）

**复用现有面板** — PlansPanel、ChangesPanel、CommitsPanel 作为堆叠区域移入标签 2。StatusPanel 移入标签 3。ExplorerPanel（新建）作为标签 1。

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/JolliMemoryToolWindowFactory.kt`（重大重构）

---

## 第五阶段：同步层

**关联 Issue：** JOLLI-1317、JOLLI-1316

### 步骤 5.1：本地 → 个人空间同步（JOLLI-1317）

**新建文件 — `core/SyncEngine.kt`：**

```kotlin
class SyncEngine(
    private val kbRoot: Path,
    private val metadataManager: MetadataManager,
    private val httpClient: HttpClient
) {
    suspend fun pull(): SyncResult
    suspend fun push(): SyncResult
    suspend fun sync(): SyncResult  // 先拉后推
    fun getStatus(): SyncStatus     // synced | syncing | conflicts | offline
}
```

- 通过 Jolli Space API 进行双向同步
- 变更检测：哈希比较（本地 vs 已同步 vs 服务器）
- 冲突解决：Markdown → 三路合并；二进制 → 最后修改者优先
- 离线：本地操作可用，变更排队，自动恢复
- 状态：`.jolli/sync-state.json`
- 需要 JOLLI-1319（OAuth 登录）作为前置条件

**修改 — `toolwindow/StatusPanel.kt`：**
- 显示同步状态指示器

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/SyncEngine.kt`（新建）
- `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/StatusPanel.kt`（修改）

### 步骤 5.2：设备间同步（JOLLI-1316）

基于个人空间同步构建 — 除首次设置对话框外无额外 IntelliJ 特定代码。

**新建文件 — `dialogs/SyncSetupDialog.kt`：**
- "从个人空间同步知识库？（47 个文件）" → 下载全部

---

## 第六阶段：专属空间与智能体集成

**关联 Issue：** JOLLI-1338、JOLLI-1337、JOLLI-1335、JOLLI-1336、JOLLI-1339

### 步骤 6.1：空间后端 API（JOLLI-1338）

后端工作 — 无 IntelliJ 插件改动。可与第一阶段并行启动。

### 步骤 6.2：推送知识库到空间（JOLLI-1337）

**修改 — `services/JolliApiClient.kt`：**
- 更新推送载荷，包含分支文件夹结构
- 从知识库文件夹推送（非孤儿分支）
- 包含 `.jolli/manifest.json` 和 `.jolli/branches.json`
- 遵守 `.jolliignore`
- 添加自动推送选项（可在设置中配置）

**涉及文件：**
- `intellij/src/main/kotlin/ai/jolli/jollimemory/services/JolliApiClient.kt`（修改）

### 步骤 6.3–6.4：空间 UI + 智能体上下文提供者（JOLLI-1335、JOLLI-1336、JOLLI-1339）

服务端/Web UI 工作 — 无需 IntelliJ 插件改动。

---

## 执行时间线与并行性

```
              第 1-2 周        第 3-4 周        第 5-6 周        第 7 周+
              ──────────       ──────────       ──────────       ──────────
第一阶段      [1.1 StorageProvider 接口       ]
              [1.2 FolderStorage（Kotlin）     ]
              [1.3 MetadataManager            ]
              [1.4 设置 UI     ]──────→（并行，纯 UI）

第二阶段                       [2.1 DualWriteStorage   ]
                               [2.2 MigrationEngine    ]
                               [2.3 读取切换           ]

第三阶段                                        [3.1 PostCommitHook 改造  ]

第四阶段                                        [4.1 ExplorerPanel        ]
                                                [4.2 导入文件 Action      ]

第五阶段                                                         [5.1 SyncEngine  ]
                                                                 [5.2 设置对话框  ]

第六阶段      [6.1 后端 API    ]───────────────────────→（并行，服务端）
                                                [6.2 JolliApiClient 更新  ]

UI (sanshi)   [4.3 三标签布局  ]───────────────────────→（全程并行）
```

---

## IntelliJ 特有注意事项

| 关注点 | 方案 |
|--------|------|
| **JAR 子进程** — PostCommitHook 作为独立 Java 进程运行 | JAR 必须打包 `FolderStorage` + `MetadataManager` 类；从相同 config 读取 `storage.mode` |
| **NIO WatchService** — 当前仅监听 `.git/refs/` | 扩展为同时监听知识库根文件夹，捕获外部文件变更（用户通过 Finder/终端编辑）|
| **JCEF Webview** — SummaryPanel 渲染 HTML | 存储迁移无需改动；ExplorerPanel 使用原生 Swing 树（非 Webview）|
| **FileChannel 锁** — Java NIO 文件锁 | 比文件存在性检查更可靠；使用 `FileChannel.tryLock()` 管理 `.jolli/lock` |
| **协程** — IntelliJ 使用 `kotlinx.coroutines` | `FolderStorage` I/O 在 `Dispatchers.IO` 上执行；迁移进度通过 `Flow` 传递 |
| **OrphanBranchStorage 中的 Git 底层操作** — hash-object、mktree 等 | 保留在 `OrphanBranchStorage.kt` 中，照旧通过 `GitOps.exec()` 调用 |
| **跨平台路径** — Windows 反斜杠 | 全程使用 `java.nio.file.Path`（已具备平台感知能力）|

---

## 关键文件汇总

| 文件 | 变更 | 阶段 |
|------|------|------|
| `core/StorageProvider.kt` | **新建** — 接口 | 1.1 |
| `core/OrphanBranchStorage.kt` | **新建** — 从 SummaryStore 提取 | 1.1 |
| `core/SummaryStore.kt` | **重构** — 使用 StorageProvider | 1.1 |
| `core/FolderStorage.kt` | **新建** — 基于文件夹的存储 | 1.2 |
| `core/MetadataManager.kt` | **新建** — .jolli/ 元数据 | 1.3 |
| `core/KBTypes.kt` | **新建** — 数据类 | 1.3 |
| `settings/SettingsDialog.kt` | **修改** — 知识库路径设置 | 1.4 |
| `bridge/SessionTracker.kt` | **修改** — 配置字段 | 1.4 |
| `core/DualWriteStorage.kt` | **新建** — 过渡期包装器 | 2.1 |
| `services/JolliMemoryService.kt` | **修改** — 存储模式切换 | 2.1 |
| `hooks/PostCommitHook.kt` | **修改** — 使用 StorageProvider | 2.1、3.1 |
| `core/MigrationEngine.kt` | **新建** — 批量迁移 | 2.2 |
| `services/JolliApiClient.kt` | **修改** — 从文件夹推送 | 6.2 |
| `toolwindow/ExplorerPanel.kt` | **新建** — 知识库树视图 | 4.1 |
| `toolwindow/KBTreeModel.kt` | **新建** — 树数据模型 | 4.1 |
| `actions/ImportFilesAction.kt` | **新建** — 导入用户文件 | 4.2 |
| `toolwindow/JolliMemoryToolWindowFactory.kt` | **重大重构** — 三标签布局 | 4.3 |
| `core/SyncEngine.kt` | **新建** — 同步引擎 | 5.1 |
| `toolwindow/StatusPanel.kt` | **修改** — 同步状态 + 迁移进度 | 2.2、5.1 |

---

## 风险缓解

| 风险 | 缓解措施 |
|---|---|
| 迁移中数据丢失 | 孤儿分支永不删除；双写先验证 |
| JAR 子进程与 IDE 插件不同步 | 两者从相同 `config.json` 读取 `storage.mode`；对配置格式做版本控制 |
| 并发写入（Worker + 用户编辑知识库） | `FileChannel.tryLock()` 管理 `.jolli/lock` — NIO 级别，更可靠 |
| 用户重组织导致智能折叠失败 | 从 `manifest.json` 计数，而非文件系统 |
| 迁移中断 | `migration.json` 游标 + 幂等写入 |
| 插件降级 | 孤儿分支完整，旧插件正常读取 |
| NIO WatchService 溢出 | 防抖（现有 500ms 模式）+ 定期全量刷新兜底 |

---

## 验证

1. **单元测试：** `StorageProvider` 各实现 — `OrphanBranchStorage` 与 `FolderStorage` 之间的读/写/列表一致性
2. **迁移测试：** 创建含测试数据的孤儿分支 → `MigrationEngine.runMigration()` → 验证知识库文件夹中所有 `.md` 文件
3. **端到端测试：** 提交代码 → 验证 `.md` 文件出现在知识库文件夹中，YAML frontmatter 正确
4. **智能折叠测试：** 1 次提交 → 文件在分支根目录；第 2 次提交 → 两个文件均移至 `commits/`
5. **回滚测试：** 将 `storage.mode` 切换回 `"orphan"` → 验证读取仍正常
6. **JAR 子进程测试：** Worker 通过 `FolderStorage` 写入 → IDE 通过相同路径读取 → 数据一致
7. **并发测试：** Worker 写入 + 用户同时移动文件 → 无损坏（NIO 锁）
