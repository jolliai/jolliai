# 本地 Agent CLI 生成后端（订阅 OAuth）设计

> 日期：2026-07-16
> 状态：设计已确认，待写实现计划
> 范围：CLI core（`LlmClient`）+ VS Code Settings 下拉。IntelliJ 后续。

## 1. 背景与目标

jollimemory 今天所有 LLM 生成（summary / squash / plan-progress / rank-context /
ingest route+reconcile / knowledge graph）都从单点 [`cli/src/core/LlmClient.ts`](../../../cli/src/core/LlmClient.ts)
的 `callLlm()` 收口，仅有两条后端：

- **`callDirect`** —— `@anthropic-ai/sdk`，`x-api-key` 直连 `api.anthropic.com`（需 Anthropic API Key，计费）。
- **`jolli-proxy`** —— `fetch` 打 Jolli 后端网关 `/api/push/llm/complete`（用 `sk-jol-` key）。

由 `resolveLlmCredentialSource`（`LlmClient.ts:206`）+ config 的 `aiProvider` 字段路由。

**目标**：新增第三条后端——**把 prompt 交给本地已安装、已登录的 Claude Code CLI 无头执行，
蹭用户的订阅（Pro/Max）OAuth 登录态，绕开 API Key 计费**。定位为新增的第三个可选 provider，
选中后带一个二级下拉选具体的本地 Agent 工具（v1 只有 Claude Code，抽象层预留 Codex / Cursor 等）。

参考实现：claude-mem（`/Users/flyer/jolli/code/claude-mem`）——它把 Claude Code 当可编程无头
runtime 来用，但走的是 Agent SDK（见下方选型章节的方案 B）。

## 2. 非目标（Out of scope）

- **IntelliJ（Kotlin 侧）**——独立工程，后续单独做。
- **Codex / Cursor backend**——只留注册位和接口，不实现。
- **temperature 控制**——`claude` CLI 无此 flag，拿不到 `temperature:0`。
- **session 复用 / 流式输出 / rate-limit 配额快照**——方案 B 的特性，不做。
- **自动切换 provider / 失败静默回退**——明确不做（见 §7）。

## 3. 方案选型：A（print-mode 子进程）vs B（Agent SDK `query()`）

两种无头驱动 Claude Code 的方式。**最终选 A。** 本节留决策痕迹。

### 3.1 两种机制

- **方案 A（选中）：print-mode 子进程。** spawn 用户已装的 `claude` 二进制：
  `claude -p --output-format json --model … --system-prompt … --tools "" --permission-mode dontAsk --no-session-persistence`，
  prompt 走 stdin，解析结果 JSON 取 `.result`。单发即走。
- **方案 B：Agent SDK `query()`（claude-mem 的做法）。** 引入
  `@anthropic-ai/claude-agent-sdk`，用流式 `query()` + hardened options + 可复用
  session，自己从 keychain 读 OAuth token 注入隔离 env。

### 3.2 优缺点对比

| 维度 | A：`claude -p` print-mode | B：Agent SDK `query()` |
|---|---|---|
| 新增依赖 | 零（只 spawn 已装二进制） | 一个重 npm 依赖 |
| 认证 | 蹭用户 `claude` 登录态，**不碰 keychain**；只需 env 抹掉 `ANTHROPIC_API_KEY` | 隔离 env，须**自己读 keychain OAuth token** 注入 |
| 多工具泛化（下拉框） | 天然对称：每工具=它自己的 CLI，一套接口到底 | **Claude-only**，Codex/Cursor 无此 SDK，抽象分裂 |
| 确定性 | 无 `--temperature`（丢 temperature:0），靠 strict 重试 + `--json-schema` 兜 | 同样无 temperature |
| 结构化输出 | 原生 `--json-schema`，graph 直接受益 | SDK options 里配等价项，更绕 |
| 延迟/性能 | 每调用 spawn 一进程（真机 ~5.6s）+ 每次重付系统 prompt cache-creation | 可复用 session 摊薄开销、少 spawn（**B 唯一实质优势**） |
| 进程/生命周期复杂度 | 单发即走，简单 | SpawnFactory + 进程注册表 + 并发闸门 + PID 复用检测 + 回收，复杂度高一个量级 |
| 可观测性 | 只有最终 JSON 的 usage/cost | 流式 message + rate-limit 配额快照 |
| 与现架构契合 | 极好（`callLlm` 本就是单点收口 + 单发语义） | 流式 session 语义与"一 prompt 一结果"不匹配，要适配层 |
| 打包 | 零依赖，绕开 | jollimemory CLI 是发布到 npm 的多入口 Vite lib，重依赖会拖给每个 `npm i -g` 用户 |

### 3.3 代码量校准

claude-mem 为走方案 B 实际维护 6 个实质模块，A 只需其中一小部分：

| claude-mem 模块 | 职责 | A 是否需要 |
|---|---|---|
| `find-claude-executable.ts` | 二进制发现 + 能力探针 | ✅ A/B 都要 |
| `oauth-token.ts` | keychain/CredMan/libsecret 读 token | ❌ A 不需要 |
| `EnvManager.ts` | 隔离 env + 抹除 + spawn 时注入 token | A 只需极简版（抹 3 个 env） |
| `hardened-options.ts` | 六层零工具锁死 SDK options | ❌ A 用两个 flag 替代 |
| `ClaudeProvider.ts` | `query()` + 流式生成器 + 消费流 | ❌ B 专属，最大块 |
| `process-registry.ts` | SpawnFactory + 注册表 + 回收 | ❌ B 专属，第二大块 |

**A 实际需要**：1 个新 backend + 复用二进制发现（A/B 共享）+ 极简 env 抹除。

### 3.4 选 A 的三条决定性理由

1. **零依赖 + 不碰 keychain**：spawn 用户的 `claude`（非 `--bare` 模式）会自己读由
   Claude Desktop 持续刷新的 keychain 凭证；claude-mem 写整个 `oauth-token.ts` 是因为
   Agent SDK 走隔离 env 才不得不自己读。A 把整块平台相关凭证代码省了。
2. **支持多工具下拉**：Agent SDK 是 Claude 专属；print-mode 每个工具=它自己的 CLI，抽象
   天然可扩展到 Codex/Cursor。
3. **打包干净**：jollimemory CLI 是发布到 npm 的多入口 lib，A 不引入任何运行时依赖。

方案 B 唯一优势（session 复用摊薄开销）在 jollimemory 的 detached 后台异步场景收益有限——
用户不等 QueueWorker，且每 commit 的几次调用 prompt 彼此独立、共享 session 反有串味风险。

## 4. 架构：插在哪

唯一改动点是 `LlmClient` 收口。`resolveLlmCredentialSource` 增加返回值 `local-agent`；
`callLlm` 增加第三条分派 → `callLocalAgent()`。**7 类生成管线全部自动切过去，无需逐个改**，
因为它们都经 `callLlm` 且 `callLocalAgent` 返回同形的 `LlmResult`。

## 5. 组件

新增目录 `cli/src/core/localagent/`：

```
LocalAgentBackend (interface)          # 多工具抽象；v1 只注册一个实现
  ├─ id: "claude-code"
  ├─ discoverExecutable(): Promise<ResolvedExe>
  ├─ buildInvocation(req): { file, args, stdin, env }
  └─ parseResult(stdout): LlmResult    # JSON → { text, inputTokens, outputTokens, cachedTokens, costUsd }

ClaudeCodeBackend implements LocalAgentBackend   # v1 唯一实现
ClaudeExecutableResolver               # 移植 claude-mem 的精简版发现+能力探针
LocalAgentRunner                       # spawn + 超时 watchdog + SIGTERM→SIGKILL + stderr 尾保留
BackendRegistry                        # id → backend；Codex/Cursor 留 TODO 注册位
```

### 5.1 `ClaudeCodeBackend.buildInvocation`

```
claude -p --output-format json
  --model <resolveModelId(model)>      # 复用 Summarizer.ts:43 的别名解析
  --system-prompt <system>             # 替换默认 system prompt，去掉编码助手前言
  --tools ""                           # 禁全部内建工具（= claude-mem 的 tools:[]）
  --permission-mode dontAsk
  --no-session-persistence
```

- prompt 走 **stdin**（`--input-format text` 默认）。
- **cwd = 全新 `mkdtemp` 临时目录**：避免 `claude` auto-discover 到 repo 的 `CLAUDE.md` 塞进
  system prompt（污染总结 + 白烧 token），对应 claude-mem 的 `cwd` 监狱。
- **env 抹除**：`ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL /
  CLAUDE_CODE_OAUTH_TOKEN / CLAUDECODE`——强制走订阅 OAuth。**不注入任何凭证**（交给 `claude`
  自己读 keychain）。
- **不使用 `--bare`**：bare 模式明确禁 OAuth/keychain、只认 `ANTHROPIC_API_KEY`，与本 feature 相反。

### 5.2 二进制发现（`ClaudeExecutableResolver`，移植精简版）

移植 claude-mem `find-claude-executable.ts` 的核心，精简为：

- 候选枚举：`which -a claude`（取全部，防旧 binary 抢先）+ `~/.local/bin/claude` +
  `~/.claude/local/claude`（`existsSync` 门控）+ 可选 `config.localAgentPath` 覆盖优先。
- **能力探针**：用**我们实际会传的 flag** `--permission-mode dontAsk --version`（不是裸
  `--version`）——旧 CLI 不认 `dontAsk` 会在 flag 解析阶段退出，据此判 capable/incompatible/broken。
  用 `execFile`（不经 shell，防注入）。
- 选最高版本的 capable，PATH 顺序仅作平局裁决。
- **成功结果缓存 15min，失败不缓存**（CLI 升级后下次自动重探）。

理由：QueueWorker 是静默后台，旧 CLI 不认新 flag 会造成"worker 健康但零记忆"的隐性故障。
这是唯一必须从 claude-mem 移植的部分。

## 6. 数据流

```
config.json { aiProvider:"local-agent", localAgentTool:"claude-code" }
  → resolveLlmCredentialSource() → "local-agent"
  → callLocalAgent(req)
      → BackendRegistry.get("claude-code")
      → discoverExecutable()            (缓存命中则跳过)
      → buildInvocation()
      → LocalAgentRunner.run()          (spawn claude, stdin=prompt, 抹除 env, temp cwd)
      → parseResult(stdout JSON)         → { text, inputTokens, outputTokens, cachedTokens, costUsd }
  → 原样返回给 Summarizer / GraphDistiller / IngestPipeline（契约不变）
```

## 7. 错误处理 —— 不静默回退

分派进 `local-agent` 后**只走这条**，失败**绝不静默回退**到 anthropic/jolli（对齐历史决策
"prevent silent fallback" 与 no-silent-failure 原则；静默回退会让用户在不知情下被 API 计费，
直接违背本 feature 初衷）。失败时暴露错误、**不消费队列项**，留待 QueueWorker 后续重试。

错误分类（借 claude-mem `classifyClaudeError` 精简）：

| 情形 | 判定 | 处理 |
|---|---|---|
| 二进制找不到/太旧 | 发现阶段 | `setup_required`：提示装/升级 claude 或换 provider；失败不缓存 |
| 未登录订阅 | JSON `is_error` + 401/403 | `auth_invalid`：提示"终端跑 `claude` 登录"；可写 stale marker 供 UI 提示 |
| 订阅配额耗尽 | `is_error` + 429 | `rate_limit`/`transient`：不消费队列项，留待重试 |
| 超时 | runner watchdog | SIGTERM →(超时) SIGKILL，抛 `transient` |
| JSON 解析失败 | parseResult | 保留 2KB stderr 尾写 debug.log，抛错 |

## 8. Config schema + VS Code UI

- [`cli/src/Types.ts`](../../../cli/src/Types.ts)：`aiProvider` 扩为
  `"jolli" | "anthropic" | "local-agent"`。
- 新增 `localAgentTool?: "claude-code"`（可扩展 enum，v1 只此一项，预留 codex/cursor）；
  可选 `localAgentPath?: string`（等价 `CLAUDE_CODE_PATH` 覆盖）。
- **VS Code Settings webview**：AI provider 加第三项 "Local Agent (subscription)"；选中后**联动出
  二级下拉** `localAgentTool`（结构就位，v1 只有 "Claude Code"）。遵守 webview 铁律：切显隐用
  `.hidden` class、不用 inline style/事件、动态样式走 CSS class、单行更新不整树 reset。

## 9. 订阅下的 token / cost 语义

- token 直接映射：`usage.input_tokens → inputTokens`、`output_tokens → outputTokens`、
  `cache_read_input_tokens → cachedTokens`。
- 真机确认：**即便走订阅，`total_cost_usd` 仍会报**（名义 API 等价成本）→ 存下来，打上 provider
  标记。UI 语义定为"**订阅内、边际 $0**，此为等价参考成本"。cost 段 UI 文案微调留后续，v1 先把
  数据存对。
- 已知开销：即便 `--system-prompt` + `--tools ""`，真机仍见 ~4.7k token 的系统脚手架被 cache；
  `--no-session-persistence` + 每次新 spawn 意味着**每调用都重付这份 cache-creation**。接受此开销。

## 10. 测试策略（守 CLI 97% 覆盖率）

- **依赖注入**：`LocalAgentRunner` 的 spawn、`ClaudeExecutableResolver` 的 fs/exec 均可注入，
  单测**不真起 claude**。
- **真实 fixture**（对齐"external parser 必须用真实 fixture"教训）：用真机冒烟拿到的 JSON 信封
  固化为 fixture，测 `parseResult` 的 success / `is_error` / 畸形三条路径。
- 覆盖点：invocation 参数构造、env 抹除、发现阶段 capable/incompatible/broken 分类、错误分类、
  不回退行为。

## 11. 真机验证记录（2026-07-16，`claude` 2.1.210）

冒烟命令（temp cwd，抹除 `ANTHROPIC_API_KEY`）：

```
printf 'Reply with exactly the word: PONG' | ANTHROPIC_API_KEY= claude -p \
  --output-format json --model claude-haiku-4-5-20251001 \
  --system-prompt "You output only what is asked, nothing else." \
  --tools "" --permission-mode dontAsk --no-session-persistence
```

真实返回信封（节选）：

```json
{ "type":"result", "subtype":"success", "is_error":false,
  "result":"PONG",
  "total_cost_usd":0.010476,
  "usage":{ "input_tokens":10, "output_tokens":198,
            "cache_read_input_tokens":0, "cache_creation_input_tokens":4738 },
  "session_id":"…" }
```

确认：`result` 为文本产物；usage 字段可直接映射；订阅下仍报 cost；单发 ~5.6s。

## 12. 风险与取舍

- **无 temperature:0**：总结/graph 的确定性下降，靠 `summarize-strict` 重试 + `--json-schema` 校验缓解。
- **每调用 spawn 延迟 ~5s + 重复 cache-creation**：QueueWorker 后台异步，用户不等，可接受；如需并发
  加一个小并发闸门（默认 2）即可。
- **依赖 `claude` CLI flag 稳定性**：能力探针挡旧版；flag 若变需更新探针参数（与 `buildInvocation` 保持同步）。
- **cwd 用临时目录**：牺牲 repo CLAUDE.md 上下文换干净输出——对 jollimemory 的总结任务是正确取舍
  （它要的是会话记录压缩，不是 repo 编码上下文）。
