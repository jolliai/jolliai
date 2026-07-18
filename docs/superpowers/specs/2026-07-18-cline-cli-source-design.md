# Cline 会话源接入设计（CLI + VS Code 扩展）

> 日期：2026-07-18
> 范围：summary 三件套（会话捕获 → memory），**两个独立源**：Cline CLI + Cline VS Code 扩展。不含 MCP 注册、不含 references 提取。

## 目标

让 jollimemory 能捕获 **Cline** 两种形态产生的会话，在 post-commit 时读取 transcript 并生成 commit summary，与现有 Cursor / Copilot Chat / OpenCode 等"无 hook 源"一致：

1. **Cline CLI** — `~/.cline/`，终端 TUI，`cline` 二进制。
2. **Cline VS Code 扩展** — `saoudrizwan.claude-dev`，数据在 VS Code globalStorage。

两者**存储位置、文件名、message schema 完全不同**（见 Observed Reality），因此实现为**两个独立三件套**，但按 CLAUDE.md 规则（Copilot CLI + Copilot Chat 同产品共用一个 `copilotEnabled`）**共用一个 `clineEnabled` config flag**。

**明确不做（本次）**：MCP 注册（Cline 支持，读 `cline_mcp_settings.json`，另开 PR）、references 提取（`ClineEnvelopeParser`，另开 PR）、git-hook 安装改动（Cline 无 hook）。

## 源 id 与命名

沿用 Copilot 先例（裸名文件 = 裸名 source id）。**扩展是 Cline 旗舰形态（用户远多于 CLI），占用裸名**：

| 形态 | `TranscriptSource` id | Label | 三件套文件前缀 |
|---|---|---|---|
| VS Code 扩展 | `"cline"` | `Cline (VS Code)` | `Cline*`（`ClineDetector.ts` 等） |
| CLI | `"cline-cli"` | `Cline CLI` | `ClineCli*` |

## Observed Reality（真机实测，2026-07-18）

> 本节由 integrating-external-systems 强制要求：所有结论来自本机真实运行态字节，非文档、非脑补 fixture。两种形态均已在本机跑真实任务并抓取。

### A. Cline CLI

- 数据根：`~/.cline/data/` = `<home>/.cline/data`，**home-relative，跨平台一致**（Windows `%USERPROFILE%\.cline\data`、Linux `$HOME/.cline/data`）；plan 阶段确认是否有 `CLINE_DIR`/XDG 环境变量覆盖，有则优先。
- 布局：

```
~/.cline/data/
├── db/sessions.db(+.db-wal/.db-shm)   ← SQLite, journal_mode=WAL
├── sessions/<id>/<id>.json            ← 元数据 sidecar（明文）
└── sessions/<id>/<id>.messages.json   ← transcript（明文，单 JSON 对象）
```

- **WAL 陷阱 — live 复现**：`sessions.db` 主库仅 **4096 字节（空）**，那 1 行 session 数据全在 `sessions.db-wal`（~99KB）。系统 `sqlite3`（native, WAL-aware）能读；`sql.js`（纯 JS/WASM，OpenCode PR #834 同款）只读主库 → **0 session**。**故 CLI 发现层不读 SQLite，扫明文 `sessions/<id>/` 目录树。**
- sidecar `<id>.json` 顶层：`session_id, source("cli"), started_at, status, provider, model, cwd, workspace_root, prompt, metadata{git.{url,branch}, checkpoint, title, usage}, messages_path`。**缺 `updated_at`** → 用 `<id>.messages.json` 的 mtime。
- transcript `<id>.messages.json`：**单 JSON 对象** `{version, updated_at, agent, sessionId, messages[], system_prompt}`。message：`{id, role:"user"|"assistant", content:[blocks], ts:epochMs, modelInfo?, metrics?}`。
- block 四类：`text{text}` / `thinking{thinking}` / `tool_use{id,name,input}` / `tool_result{tool_use_id,name,content:[{query,result,success}]}`。
- **特例**：user 文本包 `<user_input mode="act|plan|yolo">…</user_input>`，reader/title 需剥壳。
- transcript 为**整文件覆盖写**（顶层 `updated_at`），非 JSONL → 游标按 message 下标。

### B. Cline VS Code 扩展

- 数据根：`<vscodeUserDataDir>/User/globalStorage/saoudrizwan.claude-dev/`。**跨所有 VS Code flavor 扫描**（`Code` / `Code - Insiders` / `Cursor` / `Windsurf` / `VSCodium`）。
  - **实测现状**：`VscodeWorkspaceLocator.ts:24` 的 `VscodeFlavor` 当前只有 `"Cursor" | "Code"` 两个成员；CopilotChat **未**遍历多 flavor（无现成先例可仿）。
  - 因此本源需：(a) **扩展 `VscodeFlavor` union** 加入 Insiders/Windsurf/VSCodium（文件头注释已说明"只需扩 union"，含各自 `getVscodeUserDataDir` 路径映射）；(b) 新增一个 `ALL_VSCODE_FLAVORS` 列表并在 detector/discoverer 中遍历。多个 flavor 命中则合并会话。
- 布局：

```
globalStorage/saoudrizwan.claude-dev/
├── state/taskHistory.json          ← 发现索引（明文数组）
├── tasks/<taskId>/
│   ├── api_conversation_history.json   ← transcript（Anthropic 原生数组）
│   ├── ui_messages.json                ← UI 事件流（含 ts、command 等，本次不用）
│   ├── task_metadata.json              ← files_in_context / model_usage / env
│   └── focus_chain_taskid_*.md
├── settings/cline_mcp_settings.json    ← MCP（本次不用）
└── checkpoints/  cache/
```

- **无 transcript 数据库、无 WAL 陷阱**，全明文 JSON。
- 索引 `state/taskHistory.json`：**数组** `[{id, ulid, ts:epochMs, task, tokensIn/Out, totalCost, size, cwdOnTaskInitialization, isFavorited, modelId}]`。**项目归属用 `cwdOnTaskInitialization`**；`ts` 作 updatedAt；`task` 作 title。
- transcript `tasks/<id>/api_conversation_history.json`：**Anthropic 原生数组** `[{role, content:[blocks], ts:epochMs}]`。**每条带 `ts`**（keys=`content,role,ts`）→ `beforeTimestamp` 归属可直接用 `ts`，无需 correlate `ui_messages.json`。
- block：`text` / `thinking` / Anthropic 原生 `tool_use` / `tool_result`。仅 `text` 块承载文本 —— `thinking`/`tool_use`/`tool_result` 块被 reader 丢弃。
- **user turn 形状（与 CLI 的 `<user_input>` 不同）**：`role:"user"` turn **不是**裸人类文本。Cline 以平级 `text` 块注入：`# task_progress RECOMMENDED …` boilerplate（首轮）、`<environment_details>…</environment_details>` scaffolding（开着的 tab / 文件树 / 时钟，数 KB），以及因 Cline 重放 API 会话而把工具结果回显成的 `[<tool> …] Result:` 纯文本 —— 且这些回显挂在 **`user` 角色下（非 assistant）**。真正的人类文本包在 `<task>…</task>`（首轮）或 `<feedback>…</feedback>`（后续）里。reader 必须解 task/feedback 壳并丢弃 boilerplate + scaffolding + 工具结果回显，否则 ~6 字符的 task 会淹没在 ~7 KB 噪声里、工具输出被误当成人类发言。
- **provider 相关坑（实测）**：本次 fixture 用 deepseek-v4-flash，其工具**调用**以 **XML-in-text**（如 `<execute_command>…`）落在 `text` block，而非原生 `tool_use` block；Anthropic 系模型则用原生 block。reader 对 assistant 文本保持原样（XML-in-text 工具调用逐字保留 —— degrade gracefully），并丢弃原生 `tool_use`/`tool_result` 块（只取 `text`）。两种表示均由 `ClineTranscriptReader.test.ts` 覆盖。

## 架构

两套三件套（`cli/src/core/`），各自去掉不需要的复杂度：

### A. Cline CLI 三件套（扫明文目录，绕开 WAL）

- **`ClineCliDetector.ts`**：`getClineDataDir(home?)` → `<home>/.cline/data`；`getClineSessionsDir(home?)`；`isClineCliInstalled()` → `sessions/` 目录存在（**不加 `node:sqlite` gate**，不读 SQLite）。
- **`ClineCliSessionDiscoverer.ts`**：`ClineCliScanResult = {sessions, error?}`（导出 `ClineCliScanError`）；`scanClineCliSessions(projectDir)` 遍历 `sessions/*/` 读 sidecar，按 `workspace_root`（回退 `cwd`）用 `normalizePathForCompare` 归属；`updatedAt` = messages.json mtime；`transcriptPath = messages_path`；48h stale。`discoverClineCliSessions(projectDir)` 薄封装。
- **`ClineCliTranscriptReader.ts`**：`readClineCliTranscript(path, cursor?, beforeTimestamp?)` 整读 JSON→`messages[]`；**下标游标**（复用 `TranscriptCursor.lineNumber` 存已消费条数）；`ts` 过滤；block→`TranscriptEntry`（user 剥 `<user_input>` 壳）；末尾 `mergeConsecutiveEntries`。

### B. Cline 扩展三件套（source id `cline`，扫 globalStorage，全明文）

- **`ClineDetector.ts`**：`getClineStorageDirs()` → 遍历 `ALL_VSCODE_FLAVORS`（扩展后的 `VscodeFlavor`）各自的 `getVscodeUserDataDir(flavor)` + `User/globalStorage/saoudrizwan.claude-dev`，返回**存在的** flavor 目录列表；`isClineInstalled()` → 任一 flavor 有 `state/taskHistory.json` 或 `tasks/`。
- **`ClineSessionDiscoverer.ts`**：`scanClineSessions(projectDir)` **对每个命中 flavor** 读其 `state/taskHistory.json` 数组并合并，按 `cwdOnTaskInitialization` 归属；`updatedAt` = 条目 `ts`；`transcriptPath` = 该 flavor 下 `tasks/<id>/api_conversation_history.json`；`title` = `task`；48h stale。`discoverClineSessions` 薄封装。
- **`ClineTranscriptReader.ts`**：`readClineTranscript(path, cursor?, beforeTimestamp?)` 整读 Anthropic 原生数组；**下标游标**；`ts` 过滤；仅取 `text` 块（原生 `tool_use`/`tool_result`/`thinking` 丢弃）；user turn 解 `<task>`/`<feedback>` 壳并丢弃 `# task_progress` boilerplate / `<environment_details>` / `[…] Result:` 工具结果回显，assistant 文本保持原样；`mergeConsecutiveEntries`。

> 两个 reader 都是"整读 JSON 数组 + 下标游标"，可考虑抽一个共享 helper（如 `readJsonArrayTranscript`），plan 阶段按去重收益决定；但**两源的 block→Entry 映射不同**（envelope 形状 + 剥壳差异），映射逻辑不共享。

## 接线点（ripple map，两源各加一条）

> 后台 Explore agent 已核对锚点；下列每处需为 **`cline`（扩展）与 `cline-cli`（CLI）各加一个分支**。

1. `cli/src/Types.ts`：`TRANSCRIPT_SOURCES` 加 `"cline"`, `"cline-cli"`；`JolliMemoryConfig` 加 `clineEnabled?`（**单 flag 管两源**）；`StatusInfo` **合并展示**：加单组 `clineDetected?`（扩展或 CLI 任一命中即 true）/ `clineEnabled?` / `clineScanError?`（两源错误取其一或合并信息）——不为两源各开一组字段。
2. `TranscriptSourceLabel.ts`：`cline:"Cline (VS Code)"`, `cline-cli:"Cline CLI"`。
2b. `cli/src/core/VscodeWorkspaceLocator.ts`：**扩展 `VscodeFlavor` union**（`"Cursor" | "Code"` → 加 `"Code - Insiders" | "Windsurf" | "VSCodium"`），并在 `getVscodeUserDataDir` 里补各 flavor 的目录名映射；新增导出 `ALL_VSCODE_FLAVORS`。（注意：这是共享工具，改动会影响所有用 `VscodeFlavor` 的源；plan 阶段确认现有 Cursor/CopilotChat 调用点不受影响——它们传字面量，union 变宽是安全的。）
3. `QueueWorker.ts`：发现循环两块（`clineEnabled!==false && isClineInstalled()` / `…isClineCliInstalled()`）；reader dispatch switch 两 arm。
4. `TranscriptMessageCounter.ts`：dispatch 两 case。
5. `TranscriptLoader.ts`：两个 JSON-file 分支；`JsonlSource` 的 `Exclude<…>` 补 `"cline" | "cline-cli"`。
6. `ActiveSessionAggregator.ts`：`Promise.all` 加 `loadCline`（扩展）+ `loadClineCli`（CLI）。
7. `SessionTracker.ts`：`clineEnabled === false` 过滤两源。
8. `SessionTitleResolver.ts`：`PARSE_LINE` 加 `cline`（扩展，裸 task 文本）+ `cline-cli`（CLI，剥 `<user_input>` 壳）。
9. `Installer.ts`：detect 两个、auto-enable（`clineEnabled === undefined` → `true`）、status/scan 两组。
10. `StatusCommand.ts`：**合并为单行 "Cline"**（展示扩展 + CLI 合并后的 detected/enabled 状态，如"Cline: enabled (VS Code + CLI)"），不为两源各占一行。
11. `ConfigureCommand.ts`：`clineEnabled` 入 keys / boolean guard / descriptions（单 flag）。

**不动**：`references/**`、git-hook installer、`SkillInstaller`、MCP `HostRegistrars`、SQLite 依赖。

## 数据流

```
post-commit → QueueWorker.loadSessionTranscripts
  ├─ [cline-cli] clineEnabled!==false && isClineCliInstalled()
  │    → discoverClineCliSessions(cwd)  // 扫 ~/.cline/data/sessions/*/，按 workspace_root
  │    → readClineCliTranscript(messages_path, cursor, beforeTs)
  └─ [cline]     clineEnabled!==false && isClineInstalled()
       → discoverClineSessions(cwd)     // 读 taskHistory.json，按 cwdOnTaskInitialization
       → readClineTranscript(api_conversation_history.json, cursor, beforeTs)
  → 汇入既有 summary 管线（与其它源无差异）
```

## 错误处理

- 根目录/索引不存在 → 对应 `isXInstalled()` 返 `false`，该源静默跳过。
- 单 session/task 读失败或 JSON 损坏 → 计入对应 `ScanError`，不影响其它、不抛。
- transcript 解析失败 → reader 返回空 entries + 原 cursor（不推进）。
- CLI `<user_input>` 壳缺失 / 扩展 XML-in-text 工具 → 宽容匹配，退化为裸文本。

## 测试策略

- 新增 6 个 triplet 测试文件（`ClineCli*` ×3 = CLI、`Cline*` ×3 = 扩展）。
- **fixture（block 结构本机真机抓取 2026-07-18，内联进 reader 测试并带 provenance 注释；路径/时间戳已脱敏）**：
  - CLI（`ClineCliTranscriptReader.test.ts`）：覆盖 text/thinking/原生 `tool_use`/`tool_result` + `<user_input>` 壳。
  - 扩展（`ClineTranscriptReader.test.ts`）：覆盖 `<task>`/`<feedback>` 解壳、`# task_progress` boilerplate + `<environment_details>` 剥离、`[…] Result:` 工具结果回显（user 角色）丢弃、**XML-in-text** 工具（deepseek 系），以及一条专门的**原生 `tool_use`/`tool_result`** 用例。
- 更新共享 dispatch 测试补两个源分支：`TranscriptMessageCounter(.dispatch).test.ts`、`TranscriptLoader.test.ts`、`ActiveSessionAggregator.test.ts`、`SessionTracker.test.ts`、`SessionTitleResolver.test.ts`、`TranscriptSourceLabel.test.ts`、`QueueWorker.test.ts`、`Installer.test.ts`、`StatusCommand.test.ts`、`ConfigureCommand.test.ts`。
- 覆盖率红线：`cli/vite.config.ts` 97/96/97/97（`Types.ts` 免测）。

## 未决 / plan 阶段确认

- 两 reader 是否抽共享 `readJsonArrayTranscript` helper（去重 vs 边界清晰）。
- `TranscriptEntry` 对 tool_use/tool_result/thinking 的承载字段（对齐现有 reader）；扩展 XML-in-text 工具的解析策略。
- 确认 CLI 是否有 `CLINE_DIR`/XDG 环境变量覆盖数据根。
- `metadata.git.branch`（CLI）/ checkpoint 是否用于增强归属（默认 YAGNI，走 `beforeTimestamp`）。

## 已定案（历史决策记录）

- 源 id：裸名 `cline` = VS Code 扩展（旗舰），`cline-cli` = CLI。
- CLI 与扩展共用单个 `clineEnabled` flag（仿 Copilot）。
- 扩展跨所有 VS Code flavor 扫描（Code/Insiders/Cursor/Windsurf/VSCodium）。
- Status 合并为单行 "Cline"（不为两源各占一行/各开字段组）。
- 发现层均不读 SQLite（CLI 扫明文目录规避 WAL；扩展本无 DB）。
