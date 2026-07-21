# 设计：支持 Cursor CLI（cursor-agent）作为 TranscriptSource

> 日期：2026-07-21
> Linear：[JOLLI-2023](https://linear.app/jolliai/issue/JOLLI-2023/integrate-cursor-cli-cursor-agent-as-a-transcript-source)
> 范围：summary 三件套（会话捕获 → memory）+ VS Code 一等公民接线。**不含** MCP 注册、**不含** references 提取。

## 背景

Cursor CLI（`cursor-agent`）与既有的 Cursor IDE（Composer）是**两个不同的产品**，磁盘布局完全不同。代码库目前只接了 IDE 侧（`cursor` source，`CursorSessionDiscoverer.ts`，读全局 VS Code 风格 `state.vscdb`）。CLI 需要自己的 detector + discoverer + reader 三件套和一个新的 `TranscriptSource` id。

本 issue 从 JOLLI-2015 拆出。JOLLI-2015 引入的共享目录匹配器 `SessionDirMatch.ts`（`sessionDirBelongsToRepo`）尚未合并进本分支——本设计**不依赖它**，改用与 Devin/Cline CLI 一致的 `normalizePathForCompare` 内联精确匹配（见下）。

## Observed Reality（实地勘探结论）

在真实 macOS 安装上逆向（`~/.cursor/`，binary 符号链接 `~/.local/bin/cursor-agent → ~/.local/share/cursor-agent/versions/<ver>/cursor-agent`）。**未依赖任何文档，全部核对真实字节。**

### 两个数据位置

| 位置 | 形态 | 用途 |
|---|---|---|
| `~/.cursor/chats/<md5(cwd)>/<uuid>/` | `meta.json` + `store.db`(SQLite) + `prompt_history.json` | **权威索引**（cwd + 时间戳 + 标题） |
| `~/.cursor/projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl` | 明文 JSONL | **规范转录文本** |

- `chats/<hash>` 的 hash **实测 = `md5(cwd)`**（两条真实数据逐字符匹配）。
- `meta.json` 字段：`{schemaVersion, createdAtMs, updatedAtMs, hasConversation, title, cwd}`。时间戳是 **epoch 毫秒**；`cwd` 是**精确工作目录**。
- `store.db`：`PRAGMA journal_mode=wal`（带 `-wal`/`-shm` sidecar），schema 仅 `blobs(id TEXT, data BLOB)` + `meta(key,value)`。`blobs` 是**内容寻址 Merkle-DAG**，序列化为 **protobuf**（root blob 原始字节 `\n\x20<32B SHA256 引用>…`，无 `.proto` schema 无法可靠解析）。`meta` 的 value 是 hex 编码 JSON，含 `latestRootBlobId`。
- `projects/<encoded-cwd>` 的 `/`↔`-` 编码**有损歧义**（`…jollimemory-vscode` 无法区分 `jollimemory/vscode` 与 `jollimemory-vscode`）；且实测 `cwd=jollimemory/vscode` 的会话落在 `projects/…/jollimemory/` 桶（git root），说明 **cursor-agent 按 git root 分桶、按精确 cwd 记 meta**。
- `agent-transcripts/<uuid>/` 内**只有 JSONL**，无 cwd/时间戳元数据。
- JSONL 行只有两种形状：`{role, message:{content:[{type:"text"|"tool_use", …}]}}`（role=user/assistant）与 `{type, status}`（控制行，如 `turn_ended`）。**JSONL 内无时间戳、无 cwd。**
- `chats/` 是**近期裁剪**的（今日会话在，5/6 月的老会话只留在 `projects/agent-transcripts/`）；`projects/` 是持久归档。

### 由此得出的两个关键设计结论（均偏离 issue 原假设）

1. **不用 `node:sqlite`。** issue 假设镜像 Devin 读 store.db，但 store.db 是无 schema 的 protobuf DAG + WAL（正是 OpenCode PR #834 那个 100% 生产失败的 WAL 坑）。改走纯 JSON 路径：`meta.json`（发现）+ JSONL（转录）。比 Devin 更简单，天然规避 WAL/native 依赖与 Node-18 bundle 的 feature-gate 问题。**最贴近的样板是 `ClineCliSessionDiscoverer`（纯 JSON、无 sqlite gate），而非 Devin。**
2. **归属信号只信 `meta.json.cwd`。** `projects/<encoded-cwd>` 目录名编码有损、且是 git root 而非精确 cwd，不可作归属。用 `chats/*/*/meta.json` 的精确 `cwd` 走 `normalizePathForCompare` 精确相等匹配。

## 命名与品牌

- source id：**`cursor-cli`**，display label **"Cursor CLI"**（对齐 `cline`/`cline-cli` 先例，与 IDE source `cursor` 区分）。
- 徽章**复用 Cursor 现有品牌图标/配色**（视觉即 Cursor）。

## 架构

三件套，镜像 `ClineCli*`，**无 SQLite**。

### CursorCliSessionDiscoverer.ts（含 colocated 检测）

- `getCursorCliChatsDir(home?)` → `<home>/.cursor/chats`；`getCursorCliProjectsDir(home?)` → `<home>/.cursor/projects`。
- `isCursorCliInstalled(home?)`：`chats/` 目录存在即 detected（纯 JSON，无 `hasNodeSqliteSupport` gate）。
- `scanCursorCliSessions(projectDir, home?)` → `{ sessions, error? }`：
  1. 枚举 `chats/<hash>/<uuid>/meta.json`，逐个 `JSON.parse`（坏文件容错跳过，不 throw）。
  2. `normalizePathForCompare(meta.cwd) === normalizePathForCompare(projectDir)` 精确相等；否则跳过。
  3. `updatedAtMs < Date.now() - SESSION_STALE_MS(48h)` 跳过。非有限时间戳跳过并 warn。
  4. 按 uuid 定位 `projects/*/agent-transcripts/<uuid>/<uuid>.jsonl`；找不到则跳过该会话。
  5. 产出 `SessionInfo{ sessionId: uuid, transcriptPath: <jsonl 绝对路径>, updatedAt: new Date(updatedAtMs).toISOString(), source: "cursor-cli", title }`。
- `discoverCursorCliSessions(projectDir)`：仅返回数组的 back-compat 包装。
- **子目录限制**：精确相等意味着从 repo 子目录跑的会话不归属到 repo root——与 Devin/OpenCode/Cline CLI 完全一致的、有意记录的 hookless 限制（obs 849）。用合约测试钉住。

### CursorCliTranscriptReader.ts

- `readCursorCliTranscript(transcriptPath)` → `{ entries }`。
- 逐行读 JSONL：`{role, message:{content}}` → role `user`→`human`、`assistant`→`assistant`；拼接 `text` part 为 content；`tool_use` part 按 Cline/Devin reader 惯例呈现（planning 时对齐）。`{type,status}` 控制行跳过。坏行跳过不 throw。
- user 文本剥离 `<user_query>…</user_query>` / `<timestamp>…</timestamp>` 包裹（planning 时定最终形式）。

## 中枢接线（ripple 点，source id `cursor-cli`）

**CLI（`cli/src/`）**
- `Types.ts`：`TRANSCRIPT_SOURCES` 追加 `"cursor-cli"`；`JolliMemoryConfig.cursorCliEnabled?`；`InstallStatus` 三字段 `cursorCliDetected/cursorCliEnabled/cursorCliScanError`。
- `core/TranscriptSourceLabel.ts`：`"cursor-cli": "Cursor CLI"`。
- `core/TranscriptLoader.ts`：`cursor-cli` dispatch 分支 + 加入 `JsonlSource` 的 `Exclude`。
- `core/TranscriptMessageCounter.ts`：`case "cursor-cli"`。
- `core/ActiveSessionAggregator.ts`：`loadCursorCli` + 加入 `Promise.allSettled` fan-out。
- `hooks/QueueWorker.ts`：import、discovery 块（`config.cursorCliEnabled !== false && isCursorCliInstalled()`）、read dispatch。
- `core/SessionTracker.ts`：`filterSessionsByEnabledIntegrations` 追加 `cursorCliEnabled === false` 过滤块。
- `install/Installer.ts`：detect + scan-on-demand + emit 进 `InstallStatus`。
- `commands/ConfigureCommand.ts`：可编辑 key + 布尔强制 + 描述符。
- `commands/StatusCommand.ts`：状态行 `"Cursor CLI:"`。
- `core/SessionTitleResolver.ts`：map 追加条目（native title 来自 discoverer）。

**VS Code（`vscode/src/`）**
- `providers/StatusTreeProvider.ts`：集成行（含 scanError 分支）。
- `views/SettingsHtmlBuilder.ts`：`buildToggleRow("cursorCliEnabled", "Cursor CLI", …)`。
- `views/SettingsScriptBuilder.ts`：各处 source 枚举（getElementById / at-least-one-enabled / payload / dirty-check / listener / hydrate）。
- `views/SettingsWebviewPanel.ts`：state 字段 + 读配置 + 写回。
- `views/SidebarCssBuilder.ts` + `views/ConversationDetailsHtmlBuilder.ts`：`.badge.transcript-source-cursor-cli` 品牌色（复用 Cursor 色）。
- `views/NextMemoryScriptBuilder.ts` / `SidebarScriptBuilder.ts` / `SummaryScriptBuilder.ts`：label switch + 品牌 SVG map（三处 lockstep，复用 Cursor 图标）+ `SummaryScriptBuilder` 的 `sourceOrder` 数组。
- `views/ConversationDetailsHtmlBuilder.ts`：label `case "cursor-cli"`。

**不适用**（已确认，Devin 也未动）：`KnownSourceId`/`SOURCE_META`/`CLAUDE_TOOL_PREFIXES`（references 引用系统，与 transcript source 正交）；`SessionDirMatch.ts`（不存在）。

## 错误处理

- meta.json / JSONL 坏文件、缺失：容错跳过，永不让单个坏文件 sink 整个 scan（同 Devin `parseWorkspaceDirs` 风格）。
- 转录 JSONL 缺失：该会话跳过（不产出无转录的 SessionInfo）。
- `loadTranscript` 的 `cursor-cli` 分支包 try/catch，ENOENT 静默、其余 warn 后返回 `[]`（同现有各 reader）。
- 无 SQLite → 无 `SqliteScanError`；`cursorCliScanError` 字段保留以对齐 InstallStatus 形状但常为 undefined（planning 时定：是否复用通用 scanError 类型或省略该字段）。

## 测试策略

- fixture **钉真实文件**（integrating-external-systems + 记忆 feedback）：至少一份真实 `meta.json` 与一份真实 `<uuid>.jsonl` 落到 `cli/src/testUtils/`。
- `CursorCliSessionDiscoverer.test.ts`：md5(cwd) 布局、精确匹配命中/不命中、**子目录不匹配合约测试**、staleness 窗口、坏 meta.json 容错、缺失转录跳过、Windows 路径分隔符。
- `CursorCliTranscriptReader.test.ts`：user/assistant 行、tool_use 行、控制行跳过、`<user_query>` 剥离、坏行容错、空文件。
- 各 ripple 点枚举全 source 的现有测试补 `cursor-cli` 期望（CLI + VS Code 共约十余个 `.test.ts`）。
- `npm run all` 通过；不回退 CLI 覆盖率阈值。

## 交付顺序（供实现计划参考）

1. Types.ts + TranscriptSourceLabel（打开 union，其余文件才能引用）。
2. CursorCliSessionDiscoverer + 测试 + fixture。
3. CursorCliTranscriptReader + 测试 + fixture。
4. CLI 中枢接线（QueueWorker / ActiveSessionAggregator / TranscriptLoader / TranscriptMessageCounter / SessionTracker / Installer / ConfigureCommand / StatusCommand / SessionTitleResolver）+ 各测试期望。
5. VS Code 接线（StatusTree / Settings 三件 / 品牌色 / 三处 SVG+label / sourceOrder）+ 各测试期望。
6. `npm run all`，末尾一次性提交（不每 task commit）。
