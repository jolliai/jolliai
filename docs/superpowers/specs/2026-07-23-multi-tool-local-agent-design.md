# 多工具本地 Agent 后端（Codex / Cursor / OpenCode）设计

> 日期：2026-07-23
> 状态：设计已确认，待写实现计划
> 范围：CLI core（`localagent/` + `LlmClient` 注册 + config 枚举）+ CLI 交互流程 + VS Code Settings 下拉 / 状态行。IntelliJ 后续。
> 前置：本设计是 [`2026-07-16-local-agent-cli-provider-design.md`](2026-07-16-local-agent-cli-provider-design.md) 的直接延续。那一版建立了 `local-agent` provider 的整套骨架并只实现 Claude Code；本版把预留的扩展点填上 Codex、Cursor、OpenCode 三个工具。

## 1. 背景与目标

`local-agent` provider 已经存在（v0.99 系列，JOLLI-1937）：所有七条生成管线（summary / squash / plan-progress / rank-context / ingest route+reconcile / knowledge graph 各 action）都从 [`cli/src/core/LlmClient.ts`](../../../cli/src/core/LlmClient.ts) 的 `callLlm()` 收口，`local-agent` 分支走 `callLocalAgent()` → `getBackend(config.localAgentTool ?? "claude-code")` → `backend.discoverExecutable()` / `buildInvocation()` / `runInvocation()` / `parseResult()`。

`BackendRegistry` 的注释已明说自己是"future tools (Codex, Cursor)"的扩展点，`localAgentTool` 字段的注释也写着"reserved for future tools"。

**目标**：实现 `CodexBackend` / `CursorAgentBackend` / `OpenCodeBackend` 三个 `LocalAgentBackend`，注册进 registry，扩宽 `localAgentTool` 枚举，并把选择贯通到 config / CLI 交互 / VS Code UI / doctor / 归属 footer。生成管线（memory / wiki / graph）**零改动**——它们已经 provider-agnostic。

## 2. 非目标（Out of scope）

- **IntelliJ（Kotlin 侧）**——独立工程，后续单独做。
- **跨厂商 model 映射**——不把 `haiku`/`sonnet` 语义映射到各工具的模型；见 §6。
- **给三个 backend 造共享基类**——输出形状本质不同（单信封 / JSONL / 纯文本），共性已下沉在 `LocalAgentRunner`；再抽 print-mode 基类是过度设计。唯一的新抽象是 executable resolver（§4）。
- **新增 `LlmCredentialSource`**——三个工具仍共用 `"local-agent"` 这一个 source；工具区分只活在 `localAgentTool`。
- **改变 `callLlm` / 生成管线 / `LocalAgentRunner`**——全部复用。

## 3. 认证姿态：逐工具区分

Claude backend 靠"擦除凭证 env → 强制订阅 OAuth → 免 API 计费"立身。三个新工具的认证模型不同，本设计**逐工具区分**：

| 工具 | env 擦除 | 结果 |
|---|---|---|
| Cursor | 擦 `CURSOR_API_KEY` | 强制走 Cursor 订阅登录态 |
| Codex | 擦 `OPENAI_API_KEY`（+ `OPENAI_BASE_URL` 待确认） | 强制走 ChatGPT 订阅 OAuth |
| OpenCode | **不擦** | 用其 `~/.local/share/opencode/auth.json` 已登录的 provider auth（BYOK） |

**ToS 说明**：Codex 走 ChatGPT 订阅做程序化调用属于灰色地带（OpenAI 通用条款有"不得 programmatically 访问"的措辞，但 `codex exec` 本身即官方 headless 特性）；API-key 路径是干净的。本设计默认按订阅擦除路径实现，用户可通过自行保留 env 中的 API key 改走计费路径。OpenCode 是 BYOK，"免 API 计费"这一卖点对它**不成立**——花的是用户配置的 provider 的钱；UI 文案需对 OpenCode 单独说明（不标"用订阅免计费"）。

## 4. 架构：复用 + 一个新抽象

### 4.1 完全复用（零改动）
- `LocalAgentRunner.runInvocation` —— 通用子进程执行：stdin 喂 prompt、15 分钟墙钟超时、SIGTERM→SIGKILL、stderr tail、UTF-8 跨 chunk 安全，以及关键的"退出码非 0 但有 stdout → resolve 交给 parser"（Cursor 出错信封、Codex 退出行为都依赖这条）。
- `LocalAgentBackend` 接口、错误 taxonomy（`LocalAgentSetupError` / `LocalAgentAuthError` / `LocalAgentTransientError`）、`LocalAgentOutcome`。
- `AgentReentry`（`LOCAL_AGENT_CHILD_ENV` 哨兵）、temp cwd 隔离、`LlmClient.callLocalAgent` 里按 `LOCAL_AGENT_TMP_PREFIX` 前缀的 temp 清理。

### 4.2 新抽象：泛化 executable resolver
`ClaudeExecutableResolver` 里 `candidates → probe → 版本选优 → TTL 缓存 → .exe 过滤 + CVE-2024-27980 注意事项` 是与"输出差异"正交的真共性，四个工具几乎一致，只差三处。抽出参数化的 `resolveExecutable(spec, opts)`：

```ts
interface ExecutableSpec {
  binName: string;                       // "codex" | "cursor-agent" | "opencode" | "claude"
  knownPaths: (home: string) => string[]; // 各工具已知安装位置（POSIX / win32 各一份）
  probeArgs: readonly string[];          // capability 探针参数
}
```

- `ClaudeExecutableResolver` 改成薄封装调 `resolveExecutable`，保留现有行为与全部现存测试（回归保护）。
- 模块级缓存的 key 从 `overridePath` 扩成 `binName + overridePath` 复合键——否则多工具共用单例缓存会串味（codex 的解析结果被喂给 cursor）。

> 抽象判定线：**共性是否与工具差异正交**。resolver 的共性（找二进制）对所有工具一样 → 泛化；backend 的差异（输出信封形状）是每个工具的本质 → 不泛化。

### 4.3 新增文件（全在 `cli/src/core/localagent/`）
```
ExecutableResolver.ts     参数化 resolveExecutable(spec, opts)（从 ClaudeExecutableResolver 泛化）
CursorAgentBackend.ts     id="cursor-agent"
CodexBackend.ts           id="codex"
OpenCodeBackend.ts        id="opencode"
__fixtures__/<tool>/…     探针脚本抓取的真实输出样本
```

## 5. 每个工具的 invocation / parser

> 标记：✅ = 已由官方文档确认的顶层子命令；🔍 = 细粒度 flag / 字段，由探针脚本（§7）跑 `--help` + 真实调用钉死，**不硬编造**。

### 5.1 Cursor —— `CursorAgentBackend`，id `cursor-agent`（最像 Claude）
- **invocation** ✅ `agent -p --output-format json`；prompt 传法（位置参数 vs stdin）🔍；无独立 system-prompt flag 时把 `systemPrompt` 拼进 prompt 前缀 🔍。
- **env**：擦 `CURSOR_API_KEY`。**隔离**：非交互模式仍保留写权限（官方明说），temp cwd 既防 AGENTS.md 污染、又是"别在真仓库乱写"的安全带；是否有 deny-tools flag 🔍。
- **parser**：单信封 `{ type:"result", subtype, is_error, result, session_id, duration_ms }`。`text = result`；`is_error` → 按文案分类 Auth vs Setup；无 token/cost 字段 → 计 0，`stopReason = subtype ?? null`。

### 5.2 Codex —— `CodexBackend`，id `codex`（parser 最刁）
- **invocation** ✅ `codex exec --json`（别名 `--experimental-json`）；`--cd <tempdir>` 🔍、`--skip-git-repo-check` 🔍、sandbox 收紧只读 🔍。
- **env**：擦 `OPENAI_API_KEY`（+ `OPENAI_BASE_URL` 🔍）。
- **parser**：`--json` 是 **JSONL 事件流**。逐行 parse，挑最终 assistant 消息事件（事件 `type` 名 🔍）；token 用量在 usage 事件里 🔍。**必须靠真实 fixture**——这是全功能最大的智力风险点，规避仓库 `feedback_external_parser_real_fixture` 的自洽陷阱。依赖 runner 的"nonzero-with-stdout 也 resolve"。

### 5.3 OpenCode —— `OpenCodeBackend`，id `opencode`（BYOK）
- **invocation** ✅ `opencode run "<prompt>"`；`--model <provider/model>` 🔍；是否有结构化输出 flag 🔍（默认纯 stdout）。
- **env**：**不擦**（BYOK）；擦了反而可能破坏 env-key 登录态。**隔离**：仍用 temp cwd（读 AGENTS.md）。
- **parser**：无 json 模式则 `text = stdout.trim()`，token/cost 计 0；auth 失败靠 stderr/退出码 + 文案分类 🔍。有 json 模式则优先。

## 6. model 处理

管线传的 `req.model` 是 Claude 语义的 `haiku`/`sonnet`（经 `resolveModelId`），对其他工具无意义。**v1**：各 backend 的 `buildInvocation` 忽略 `req.model`、不传 `--model`，让工具用其默认模型；另加可选 `localAgentModel?` 配置（仿 `localAgentPath`），用户想指定则透传给对应工具。理由：跨厂商 model 映射是伪需求（YAGNI），工具默认模型本就是用户在该工具内的选择。

## 7. 探针脚本（fixture 获取）

`scripts/probe-local-agents.mjs`（一次性，用户本地跑）：对每个工具——
1. `<tool> --help` 和子命令 `--help` → 落 `*.help.txt`（钉死所有 🔍 flag）。
2. 用一个固定 prompt（要求输出一小段严格 JSON，模拟 summarize 的输出契约）真实调一次 headless，原样落 `stdout` / `stderr` / `exitCode`。
3. 在临时目录跑、不碰仓库、只读已登录态、不传危险 flag。
4. 落到 `cli/src/core/localagent/__fixtures__/<tool>/`。auth 失败样本可选（能造则造）。

parser 与 fixture **不同源**。这是 `integrating-external-systems` 技能要求的"落地前先拿真实运行态样本"，作为实现计划的第 0 步、先于任何 parser 编码。

## 8. wiring 改动点（精确到文件）

- **`cli/src/Types.ts`** —— `localAgentTool?: "claude-code"` 扩成 `"claude-code" | "codex" | "cursor-agent" | "opencode"`；`aiProvider` 枚举不动；新增可选 `localAgentModel?`。
- **`cli/src/core/LlmClient.ts`** —— 模块加载处多三行 `registerBackend(...)`；`callLocalAgent` 已泛用，不动。
- **`cli/src/core/LlmCredentials.ts`** —— `local-agent` 仍无条件 self-sufficient，不动。
- **`cli/src/core/SummaryFormat.ts`** —— 归属 footer 从笼统 "Local Agent" 收敛成 **`Local agent - <工具名>`**（`Claude Code` / `Codex` / `Cursor` / `OpenCode`），由 `localAgentTool` 派生。落地时 grep 确认拼 footer 的唯一入口。与 `feedback_jolli_memory_footer_intentional`（footer 是产品签名）一致。
- **CLI 流程** —— `EnableCommand.ts`（local-agent 选中后追加二级"选工具"）、`ConfigureCommand.ts`（接受 `--local-agent-tool` / `--local-agent-model`）、`GuidedFrontDoor.ts`、`AuthCommand.ts`（doctor）。
- **doctor** —— 按 `localAgentTool` 跑对应工具的 login 探针，给针对性登录指引（`cursor-agent login` / `codex login` / `opencode auth login` 🔍）。
- **VS Code** —— `SettingsHtmlBuilder.ts` 的 agent-tool 下拉从 1 项变 4 项；`StatusTreeProvider.ts` 状态行显示当前工具名。遵守 `feedback_vscode_webview_csp_no_inline`（样式走 class、事件走 addEventListener）。

## 9. 测试策略

- 每个 backend：`buildInvocation`（argv / env 擦除 / cwd 前缀断言）+ `parseResult`（喂真实 fixture，断言 text/tokens/错误分类）+ resolver（注入 `probe`/`candidates`/`platform` 桩，复用现有 `ClaudeExecutableResolver.test` 模式）。
- 泛化后的 `ExecutableResolver` 必须让现存 Claude resolver 测试继续绿。
- **覆盖率**：CLI 硬性 97%/96%/97%/97%，新代码不拉低；不可达分支用 `/* v8 ignore start/stop */` 块（`feedback_v8_ignore_next_broken_use_start_stop`）。
- 平台：resolver 测试控 `process.platform`（win32 `.exe` 过滤 + `where`）；路径断言处理 `\` vs `/`（`feedback_windows_path_separator_and_case`）。
- 节奏：各 task 只写代码（测试 + 实现），**最后一次性** `npm run all` + 单次 commit（DCO `-s`，无 Claude 署名）——遵守 `feedback_no_per_task_commit_and_test` / `feedback_no_claude_coauthor`。

## 10. 风险

- **Codex JSONL parser** —— 最大风险；强依赖真实 fixture。缓解：探针脚本第 0 步，parser 与 fixture 不同源。
- **各工具是否稳定吐严格 JSON** —— summarize/graph 的 prompt 是为 Claude 调的，其他模型的 JSON 遵从度可能差。缓解：探针的固定 prompt 就检验这点；若某工具遵从度差，记录在案，可能需要 prompt 的工具特定加固（超出 v1，先观测）。
- **Codex 订阅路径 ToS 灰区** —— 见 §3；已在设计与 UI 文案层面显式标注，不隐瞒。
- **多工具缓存串味** —— 见 §4.2，复合 key 已在设计阶段堵掉。

## 11. 交付节奏

plan 分阶段：**第 0 步探针 → Cursor（打通 config/UI/footer/doctor 横向链路，解析风险最低）→ Codex → OpenCode**。Cursor 先行把非解析的横向改动一次性验通，后两个工具就只剩各自 parser 一个变量。
