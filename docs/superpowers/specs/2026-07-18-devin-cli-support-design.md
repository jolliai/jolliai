# 设计：支持 Devin CLI 作为 TranscriptSource

**日期**：2026-07-18
**分支**：`feature/support-devin-cli`
**范围**：把 Devin CLI 接入为一个新的 `TranscriptSource`，使其会话在 post-commit 时被读取、参与 commit summary 生成。**不含** MCP 注册、skill 安装、references 抽取（经确认排除）。

---

## 背景

jollimemory 已支持一组 AI 编码 agent 作为 `TranscriptSource`（claude / codex / gemini / opencode / cursor / copilot / copilot-chat）。非 Claude、无 hook 的源（codex / opencode / cursor / copilot）各有一套 **Detector + SessionDiscoverer + TranscriptReader 三件套**，在 `QueueWorker` 的 post-commit 路径上被枚举、发现、读取。Devin CLI 属于同一类（SQLite + WAL、无 hook、按 `working_directory` 匹配 repo），最接近的模板是 **Cursor 三件套**。

---

## Observed Reality（实地勘探结论）

> 依据 `integrating-external-systems` 技能，以下均来自本机活体 Devin CLI 安装（含 WAL 未 checkpoint 状态）的实测，非脑造 fixture。

**数据位置**
- macOS/Linux：`~/.local/share/devin/cli/sessions.db`（XDG data dir 下）。
- 伴生文件：`sessions.db-wal`、`sessions.db-shm`（实测 WAL 609 KB，主库仅 86 KB——**绝大多数数据在 WAL 里未 checkpoint**）。
- 其它目录（本设计不读）：`~/.config/devin/`（config）、`~/.cache/devin/`、`~/.local/share/devin/mcp`（Devin 自身 ACP/MCP host 配置）。

**运行时状态**
- `PRAGMA journal_mode = wal`。必须用能读 WAL 的 SQLite 后端。
- 代码库既有 `SqliteHelpers.withSqliteDb` 使用 Node 原生 `node:sqlite`（`DatabaseSync`，静态链接、**全 WAL 支持**），lazy-import + `hasNodeSqliteSupport()` 版本门控（VSCode 的 Node 18 宿主优雅降级）。
- **烟测（skill step 4）**：已用 `node:sqlite` 对活库（WAL 未 checkpoint）读到会话并重建主链成功。sql.js 那类纯 JS/WASM 后端读不到 WAL——本设计不使用它。

**表结构（相关部分）**
```sql
sessions(
  id TEXT PRIMARY KEY,          -- 形如 "languid-hydrangea" 的 slug
  working_directory TEXT,       -- 会话所在仓库路径（实测就是一个 worktree 绝对路径）
  workspace_dirs TEXT,          -- 附加工作目录（JSON）
  backend_type TEXT, model TEXT, agent_mode TEXT,
  title TEXT,                   -- 原生标题（实测为中文 "查看当前分支"）
  main_chain_id INTEGER,        -- 主链 tip 的 node_id
  created_at INTEGER, last_activity_at INTEGER,  -- epoch 秒
  hidden INTEGER NOT NULL DEFAULT 0
)
message_nodes(
  row_id INTEGER PRIMARY KEY,
  session_id TEXT,
  node_id INTEGER,              -- 会话内节点 id
  parent_node_id INTEGER,       -- NULL 为根
  chat_message TEXT NOT NULL,   -- JSON，见下
  created_at INTEGER,
  UNIQUE(session_id, node_id)
)
tool_call_state(...)  -- ACP ToolCall JSON，本设计不读
rendered_commits(...) -- 渲染 HTML，本设计不读
```

**`message_nodes.chat_message` 形状（真实 JSON）**
```json
{
  "message_id": "…uuid…",
  "role": "system" | "user" | "assistant" | "tool",
  "content": "…纯字符串…",
  "metadata": { "created_at": "2026-07-18T07:57:11.879943Z", "is_user_input": true, "extensions": {…} }
}
```
- `content` 为纯字符串（非结构化 block 数组）。
- `role` 四态。`is_user_input` 标记真实用户输入。
- `metadata.created_at` 为 ISO 8601。

**消息森林 & 主链**
- `message_nodes` 是**森林**：`node_id`/`parent_node_id` 构树。存在同一 `parent_node_id` 下的兄弟节点（实测 node 26/27 同 parent、node 29/30 同 parent）——即被丢弃的**重生成分支**。
- 规范对话 = 从 `sessions.main_chain_id`（tip 节点）沿 `parent_node_id` 上溯到根、再反转。烟测结果：11 节点主链，含 user/assistant/tool，正确跳过兄弟分支。
- 同一 session 内还观察到重复的根前缀（node 0-2 / 7-9 / 14-16 message_id 相同）——是重试残留；主链 walk 天然规避。

---

## 架构

新增三件套，置于 `cli/src/core/`，与 Cursor 同构：

### DevinDetector.ts
- `getDevinSessionsDbPath(home?: string): string` → `<XDG_DATA_HOME|~/.local/share>/devin/cli/sessions.db`。
- `isDevinInstalled(): Promise<boolean>` = `hasNodeSqliteSupport()` **且** `sessions.db` 文件存在（`stat().isFile()`）。Node<22.5 时先返回 false 并 info 日志，与 `isCursorInstalled` 完全对齐。

### DevinSessionDiscoverer.ts
- `discoverDevinSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>>`。
- `withSqliteDb`（readOnly）打开 → `SELECT … FROM sessions WHERE hidden = 0` → 用 `working_directory` 及 `workspace_dirs` 与 `projectDir` 匹配（路径归一化用 `toForwardSlash` / `normalizePathForCompare`，处理 darwin 大小写不敏感）。
- 产出 `SessionInfo { sessionId: id, transcriptPath: "<dbPath>#<id>", updatedAt: ISO(last_activity_at), source: "devin", title }`。
- synthetic path 约定 `<dbPath>#<sessionId>`（与 Cursor/OpenCode 一致）。
- 错误经 `classifyScanError` 分类（沿用 Cursor 的 `SqliteScanError` 通道）。

### DevinTranscriptReader.ts
- `readDevinTranscript(transcriptPath, cursor?, beforeTimestamp?): Promise<TranscriptReadResult>`。
- 解析 synthetic path → `SELECT node_id, parent_node_id, chat_message FROM message_nodes WHERE session_id=?` + `SELECT main_chain_id FROM sessions WHERE id=?`。
- **主链重建**：从 `main_chain_id` 沿 `parent_node_id` 上溯，`visited` 集合防环，遇断链（父节点不存在）即停止，反转得规范顺序。`main_chain_id` 为 NULL 时回退到 `created_at` 最大的节点作为 tip（防御）。
- **role 映射**（已确认）：
  - `user` → `human`
  - `assistant` → `assistant`
  - `system` → 丢弃
  - `tool` → 丢弃（与 Cursor `other → skipped` 约定一致）
  - `content` 空串 → 跳过（实测 tool-call 空回合 node 27）
- `timestamp` = `metadata.created_at`。游标沿用 Cursor 的"链内已消费位置 / lastConsumedIndex"模型，`beforeTimestamp` 做增量裁剪。

---

## 中枢接线

| 文件 | 改动 |
|---|---|
| `Types.ts` | `TRANSCRIPT_SOURCES` 追加 `"devin"`；`Config` 加 `devinEnabled?: boolean`；status 类型加 `devinDetected?: boolean` |
| `hooks/QueueWorker.ts` | 源枚举块追加 `if (config.devinEnabled !== false && await isDevinInstalled()) allSessions += discoverDevinSessions(cwd)` |
| `core/TranscriptLoader.ts` | 加 `source === "devin"` 分支：动态 `import("./DevinTranscriptReader.js")`，try/catch 降级为 `[]`，ENOENT 静默 |
| `core/SessionTracker.ts` | `filterSessionsByEnabledIntegrations` 增加 devin 分支（`devinEnabled === false` 时过滤） |
| `core/TranscriptSourceLabel.ts` | `"devin"` → `"Devin"` |
| `commands/ConfigureCommand.ts` / `commands/StatusCommand.ts` | 暴露 `devinEnabled` toggle 与检测态 |
| `commands/GuidedFrontDoor.ts` | onboarding 列出 Devin |
| `core/TranscriptMessageCounter.ts` / `core/ActiveSessionAggregator.ts` / `core/SessionTitleResolver.ts` | active-session 侧栏计数 / 标题解析纳入 devin |
| `core/UserProfile.ts` / `core/TelemetryDoc.ts` | source-mix 遥测加 `"devin"`（仅源名，无 PII） |

**故意不改**（证明扫荡范围经过判断）：
- 无 `McpHostRegistrar`——不把 `jolli mcp` 注册进 Devin（范围外）。
- 无 `SkillInstaller` 条目——Devin 不装 skill（范围外）。
- 无 `Installer` / `DispatchScripts` / dist-path 改动——Devin **无 agent hook**，纯 post-commit 发现，与 Cursor/Codex 一致。
- 无 references 子系统改动——不解析 `tool_call_state`（范围外）。

---

## 错误处理

- 一切 SQLite I/O 走 `withSqliteDb`（readOnly，WAL-safe，已烟测）；discoverer 错误经 `classifyScanError`。
- Reader 抛错（缺文件 / 锁 / schema drift / 动态 import 失败）在 `TranscriptLoader` catch → `[]`；ENOENT 静默（与既有 reader 一致）。
- 主链断裂 / 成环：`visited` 防环，遇断链停止上溯并返回已收集部分，不抛。

---

## 测试策略

遵守"外部 parser 必须钉真实 fixture"铁律：
- 从本机活库导出**真实** session（含森林 + 重生成兄弟分支 + tool 回合 + 空内容回合）固化为 SQLite fixture 或 JSON 快照；不脑造形状。
- 用例覆盖：
  - 主链重建正确、跳过兄弟分支（26/29）与重复根前缀。
  - role 映射（user/assistant 保留，system/tool 丢弃，空内容跳过）。
  - `main_chain_id` NULL 的回退。
  - 断链 / 成环防御。
  - `working_directory` 匹配当前 worktree（含大小写不敏感 / 路径分隔符）。
  - WAL 未 checkpoint 时能读到数据（`node:sqlite` 路径）。
  - `hasNodeSqliteSupport()` 为 false 时 detector 报未安装。
- 满足 CLI 覆盖率门槛（97% statements / 96% branches / 97% functions / 97% lines）。

---

## 交付顺序（供实现计划参考）

1. `Types.ts`（`TRANSCRIPT_SOURCES` + config/status 字段）——先落类型，编译期驱动其余改动。
2. Detector → SessionDiscoverer → TranscriptReader 三件套 + 各自测试（TDD，先固化真实 fixture）。
3. `TranscriptLoader` 分发 + `QueueWorker` 枚举接线。
4. 外围接线：SessionTracker / TranscriptSourceLabel / Configure / Status / GuidedFrontDoor / 计数三件 / 遥测。
5. `npm run all`（末尾一次，不每 task 跑）。
