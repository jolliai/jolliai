# Antigravity 作为 transcript source —— 设计

- 日期：2026-07-19
- 分支：`feature/support-antigravity`
- 状态：设计草案（待评审）

## 1. 背景与目标

Antigravity 是 Google 基于 VS Code 内核、由 Gemini 驱动的 agentic IDE（含 CLI）。本设计把它接入为 Jolli Memory 的**第 8 个 transcript source**，让在 Antigravity 里进行的开发对话能像 Claude/Codex/Cursor 等一样，在 post-commit 时被读取并生成 summary。

现有 7 个 source：`claude`、`codex`、`gemini`、`opencode`、`cursor`、`copilot`、`copilot-chat`（见 [`cli/src/Types.ts`](../../../cli/src/Types.ts) 的 `TRANSCRIPT_SOURCES`）。

### 成功标准

- 在 Antigravity 中对某仓库进行对话并提交后，该对话被发现、读取并纳入 summary 生成，与其他 source 行为一致。
- 支持增量续读（只读上次游标之后的新消息）。
- 正确按仓库归属（含 git worktree 场景）。
- 不需要往用户的 Antigravity 里安装任何 hook / 改任何配置；可追溯已有历史对话。
- CLI 覆盖率满足仓库门槛（97/96/97/97）。

## 2. 关键调研结论（真机验证）

调研在真实安装的 Antigravity 上完成，并用两次真实对话（工作区 `/Users/flyer/jolli/code/jollimemory`）验证了运行时落盘状态。要点：

- **加密与明文并存**：`~/Library/Application Support/Antigravity*/`（VS Code 外壳层）的 `state.vscdb` 中 `trajectorySummaries` / `chat.ChatSessionStore.index` 均为空；`~/.gemini/<variant>/implicit/*.pb` 是**加密** blob（熵 ≈ 8.0、无压缩 magic、per-file 随机首字节）。**这些都不用读。**
- **真正可读的数据**在 `~/.gemini/<variant>/` 下，每次对话产生：

  ```
  ~/.gemini/<variant>/
  ├── conversations/<convId>.db                     SQLite（WAL 模式：.db / .db-shm / .db-wal）
  │      └─ trajectory_metadata_blob(id='main')      protobuf，含 workspace file:// URI + git remote
  └── brain/<convId>/.system_generated/logs/
         ├── transcript.jsonl                         明文；可能被 CHECKPOINT 截断
         └── transcript_full.jsonl                    明文，完整历史  ← 本设计读这份
  ```

- **变体**：`antigravity`（2.0 App）、`antigravity-ide`（IDE）、`antigravity-cli`（CLI）。三者布局一致。本机存在前两个。
- **无全局"对话→workspace"索引**：归属信息只在每个 `<convId>.db` 的 `trajectory_metadata_blob` 里。
- **WAL 陷阱**：`.db` 是 WAL 模式，读取必须用能感知 WAL 的 `node:sqlite`（已封装于 [`SqliteHelpers`](../../../cli/src/core/SqliteHelpers.ts)），不能用 sql.js 裸读主库。

### transcript_full.jsonl 逐行结构（真实样本）

每行一个 JSON 对象，字段 `step_index`、`source`、`type`、`status`、`created_at`（ISO8601 UTC），多数带 `content`；`PLANNER_RESPONSE` 可带 `tool_calls: [{ name, args }]`。

映射到 [`TranscriptEntry`](../../../cli/src/Types.ts)（`{ role: "human" | "assistant"; content; timestamp? }`）：

| `type` | 处理 |
| :-- | :-- |
| `USER_INPUT` | → `human`。剥掉 `<USER_REQUEST>…</USER_REQUEST>` 包裹，丢弃 `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` 等系统块 |
| `PLANNER_RESPONSE` | → `assistant`。取 `content`；若有 `tool_calls`，附加为可读摘要 |
| `RUN_COMMAND` | → 归到前一条 assistant 轮的工具结果（或独立 assistant 内容），保留命令输出 |
| `CHECKPOINT` / `CONVERSATION_HISTORY` | skip（截断/历史占位标记） |

## 3. 架构：直接扫描发现（方案 A）

不装 hook。detector + discoverer + reader 三件套，与 [`Cursor*`](../../../cli/src/core/CursorSessionDiscoverer.ts) 源同构（per-conversation SQLite + home-dir 存储 + 按 workspace 归属）；差异在于 **content 读取的是旁挂的明文 JSONL 而非 SQLite blob**。

### 3.1 `cli/src/core/AntigravityDetector.ts`

```
getAntigravityRoots(home?): string[]        // 存在的变体根：~/.gemini/{antigravity,antigravity-ide,antigravity-cli}
getAntigravityVariants(home?): {variant, root, conversationsDir, brainDir}[]
isAntigravityInstalled(): Promise<boolean>  // 任一变体 conversations/ 下有 *.db，且 hasNodeSqliteSupport()
```

- 变体名硬编码为三者全扫（决策已确认）。
- `hasNodeSqliteSupport()` 门控：Node < 22.5 时视为未安装（与 opencode/cursor 一致）。VSCode bundle 目标 Node 18，故 discoverer/reader 走 lazy-import，缺 `node:sqlite` 时静默降级。

### 3.2 `cli/src/core/AntigravitySessionDiscoverer.ts`

```
interface AntigravityScanResult { sessions: SessionInfo[]; error?: SqliteScanError }
scanAntigravitySessions(projectDir): Promise<AntigravityScanResult>
discoverAntigravitySessions(projectDir): Promise<ReadonlyArray<SessionInfo>>   // 薄包装
const SESSION_STALE_MS = 48 * 60 * 60 * 1000                                   // 同 Cursor/Devin
```

流程：

1. 遍历 `getAntigravityVariants()` 的每个 `conversationsDir` 下的 `*.db`。
2. 对每个 `.db` 用 `withSqliteDb`（WAL 安全）读 `trajectory_metadata_blob(id='main')` 的 protobuf blob，提取 workspace `file://` 路径。
3. 用 `normalizePathForCompare`（[`PathUtils`](../../../cli/src/core/PathUtils.ts)）+ worktree 归一，与 `projectDir` 匹配；不匹配则跳过。
4. 命中则定位对应 `brainDir/<convId>/.system_generated/logs/transcript_full.jsonl`；文件不存在则跳过（该对话尚未物化明文）。
5. 产出 `SessionInfo`：
   - `sessionId` = `<convId>`（UUID，跨变体极不可能冲突；必要时前缀变体名）
   - `transcriptPath` = 该 `transcript_full.jsonl` 的**真实绝对路径**（不用 `#` 合成路径，因 content 本就是独立文件）
   - `updatedAt` = `.db` mtime 或末条 `created_at`
   - `source` = `"antigravity"`
   - `title` = 首条 `USER_INPUT` 剥壳后的截断文本
6. `SESSION_STALE_MS` 过滤过旧对话。错误经 `classifyScanError` 归一到 `AntigravityScanResult.error`（不抛，走结构化错误通道）。

**workspace 提取的稳健性**：blob 是 protobuf。首版用受约束的字节扫描抓 `file://…` 与 git remote（真机样本已验证字段紧邻且稳定），配套真实 fixture 钉死格式；若后续发现字段漂移，再引入最小 protobuf 解析。**决策点见 §7。**

### 3.3 `cli/src/core/AntigravityTranscriptReader.ts`

```
readAntigravityTranscript(transcriptPath, cursor?, beforeTimestamp?): Promise<TranscriptReadResult>
```

- 逐行读 `transcript_full.jsonl`；游标复用现有 [`TranscriptCursor.lineNumber`](../../../cli/src/Types.ts)（逐行文件天然契合，**无需新增游标字段**）。
- 从 `cursor.lineNumber` 之后开始；`beforeTimestamp` 用 `created_at` 过滤。
- 按 §2 表映射，skip `CHECKPOINT` / `CONVERSATION_HISTORY`，剥 `USER_INPUT` 包裹标签。
- 复用 [`mergeConsecutiveEntries`](../../../cli/src/core/TranscriptReader.ts) 合并连续同角色轮。
- `usageTokens` 等：Antigravity 未在 transcript 暴露可靠 token 用量，首版**不提供**（`TranscriptReadResult` 中为可选，缺省即可）。

## 4. CLI 接线点

每处都是"在现有 Cursor 分支旁加一路 antigravity"：

1. [`cli/src/Types.ts`](../../../cli/src/Types.ts)：`TRANSCRIPT_SOURCES` 加 `"antigravity"`；`JolliMemoryConfig.antigravityEnabled?: boolean`；`StatusInfo` 加 `antigravityDetected?` / `antigravityEnabled?` / `antigravityScanError?`。
2. [`cli/src/core/TranscriptSourceLabel.ts`](../../../cli/src/core/TranscriptSourceLabel.ts)：`TRANSCRIPT_SOURCE_LABELS` 加 `antigravity: "Antigravity"`（穷举 Record，不加不过编译）。
3. [`cli/src/hooks/QueueWorker.ts`](../../../cli/src/hooks/QueueWorker.ts)：discovery gate（`antigravityEnabled !== false && await isAntigravityInstalled()` → `scanAntigravitySessions`）+ read dispatch（`else if (source === "antigravity")`）。
4. [`cli/src/core/TranscriptLoader.ts`](../../../cli/src/core/TranscriptLoader.ts)：reader dispatch；把 `antigravity` 从 `JsonlSource = Exclude<…>` 中排除（它走专用 reader，非通用 PARSERS）。
5. [`cli/src/core/TranscriptMessageCounter.ts`](../../../cli/src/core/TranscriptMessageCounter.ts)：`switch (source)` 加 `case "antigravity"`。
6. [`cli/src/core/SessionTitleResolver.ts`](../../../cli/src/core/SessionTitleResolver.ts)：`PARSE_LINE` Record 加项 + `parseAntigravityUserLine`（title 由 discoverer 提供，此处可返回 undefined）。
7. [`cli/src/core/ActiveSessionAggregator.ts`](../../../cli/src/core/ActiveSessionAggregator.ts)：`loadAntigravity(cwd)` + 注册进 `collectFromAllSources` 的 `Promise.all`。
8. [`cli/src/commands/ConfigureCommand.ts`](../../../cli/src/commands/ConfigureCommand.ts)：`antigravityEnabled` 加进 `VALID_CONFIG_KEYS`、布尔强转、`CONFIG_KEY_INFO`。
9. [`cli/src/commands/StatusCommand.ts`](../../../cli/src/commands/StatusCommand.ts)：状态表加 "Antigravity:" 行。
10. [`cli/src/install/Installer.ts`](../../../cli/src/install/Installer.ts)：`getStatus()` 探测 + 按 `antigravityEnabled !== false && detected` 做按需扫描，填 `antigravityScanError`。
11. [`cli/src/core/SessionTracker.ts`](../../../cli/src/core/SessionTracker.ts)：`filterSessionsByEnabledIntegrations` 在 `antigravityEnabled === false` 时丢弃 `source === "antigravity"`。

## 5. vscode 一等公民接线

- StatusTree 行：[`StatusTreeProvider.ts`](../../../vscode/src/providers/StatusTreeProvider.ts) 加 "Antigravity Integration"（带 `antigravityScanError` warn 分支）。
- Settings：[`SettingsHtmlBuilder.ts`](../../../vscode/src/views/SettingsHtmlBuilder.ts) 的 `buildToggleRow("antigravityEnabled", "Antigravity", …)`；[`SettingsScriptBuilder.ts`](../../../vscode/src/views/SettingsScriptBuilder.ts) 的 input + 校验 + dirty-check + save payload + hydration；[`SettingsWebviewPanel.ts`](../../../vscode/src/views/SettingsWebviewPanel.ts) 的 payload 字段 + 读写。
- 品牌图标：`SOURCE_ICON_SVG` 三处（[`SidebarScriptBuilder.ts`](../../../vscode/src/views/SidebarScriptBuilder.ts) / [`SummaryScriptBuilder.ts`](../../../vscode/src/views/SummaryScriptBuilder.ts) / [`NextMemoryScriptBuilder.ts`](../../../vscode/src/views/NextMemoryScriptBuilder.ts)）加 Antigravity 官方图标；`SummaryScriptBuilder.ts` 的 `sourceOrder` 数组加 `'antigravity'`；对应 `sourceLabel` case。
- badge 颜色：[`SidebarCssBuilder.ts`](../../../vscode/src/views/SidebarCssBuilder.ts) + [`ConversationDetailsHtmlBuilder.ts`](../../../vscode/src/views/ConversationDetailsHtmlBuilder.ts) 的 `.badge.transcript-source-antigravity` + `providerLabel` case。
- 注意：webview 严格 CSP，图标走 SVG-in-map、无 inline style/JS（见项目约定）。

## 6. 测试与 fixture

- 共享 fixture builder `cli/src/testUtils/antigravityFixture.ts`：造变体目录树 —— `conversations/<id>.db`（真实 `trajectory_metadata_blob` protobuf 形状 + WAL）+ 旁挂 `brain/<id>/.system_generated/logs/transcript_full.jsonl`。
- **铁律**：fixture 必须钉一份从真机对话导出的**真实样本**（transcript 行、metadata blob 字节），避免 parser 与 fixture 双脑补形成自洽却全错的闭环。
- 三件套各配 `.test.ts`：`AntigravityDetector.test.ts` / `AntigravitySessionDiscoverer.test.ts`（含 workspace 匹配、worktree、stale、WAL、坏 blob 的 error 通道）/ `AntigravityTranscriptReader.test.ts`（type 映射、包裹剥离、游标续读、`beforeTimestamp`）。
- 各接线点测试补 antigravity case（`ConfigureCommand`、`SessionTracker`、`TranscriptSourceLabel`、`QueueWorker`、`PostCommitHook`，vscode 侧 `StatusTreeProvider`、Settings 三件套、Sidebar/Summary/NextMemory、`ConversationDetailsHtmlBuilder`）。

## 7. 待评审的开放决策

1. **workspace 提取实现**：首版用受约束字节扫描（简单、真机已验证），还是直接引入最小 protobuf 解析（更稳健但更重）？倾向：**先字节扫描 + 真实 fixture 兜底**，字段漂移再升级。
2. **RUN_COMMAND / tool_calls 的呈现粒度**：是否把工具输出完整纳入 summary 输入，还是只留命令行 + 摘要以控制体积？倾向：保留命令行 + `toolSummary`，输出截断。
3. **sessionId 跨变体去重**：同一对话若同时存在于两个变体（迁移场景）是否需去重？倾向：以 `<convId>` 去重，取 mtime 最新的变体。

## 8. 明确不改（故意留白）

- 不读、不解密 `implicit/*.pb`。
- 不装 Antigravity hook、不写 `.agents/hooks.json`、不动用户的 `mcp_config.json`（MCP host / skills 接入是**独立后续工作**，不在本 PR 范围）。
- 不改运行时数据路径、包名、orphan 分支 refspec、storage provider。
- 不引入新的 `TranscriptCursor` 字段（`lineNumber` 已够用）。
