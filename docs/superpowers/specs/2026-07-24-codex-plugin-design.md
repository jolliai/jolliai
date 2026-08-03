# Jolli Claude Plugin 与 Codex Plugin 对比及开发方案

> 研究日期：2026-07-24
> 修订日期：2026-07-31
> 范围：当前仓库实现、OpenAI Codex 官方文档、OpenAI Codex 官方源码

## 0. 修订记录

初版研究是在 worktree 的 `f9c837b2` 基线上做的，而该基线**不包含** `be69a608`（"Add
Codex, Cursor, and OpenCode local-agent backends"，2026-07-23）。因此初版读到的是过时代码，
两类结论已作废并在 2026-07-30 重写：

1. **Codex local-agent backend 已经存在**（`cli/src/core/localagent/CodexBackend.ts`）。原
   §10「`local-agent` 是最大的产品差异」整节和 Phase 3 的绝大部分已经落地，MVP 的产品承诺
   可以对齐 Claude Plugin，不再需要引导用户先配 Jolli/Anthropic key。
2. **`agents/pr-writer.md` 与 `jolli-pr` Skill 都已从仓库移除**（`14bd6f0a`）。`jolli-pr`
   现在列在 `SkillInstaller.ts` 的 `REMOVED_SKILL_NAMES` 里，`jolli enable` 会主动清理它。
   凡是「把 pr-writer 合并进 jolli-pr」的建议都已失效。

另有一项在本次修订期间实现：宿主取值的 local-agent seeding（见
[dual-plugin-bootstrap-design](2026-07-24-dual-plugin-bootstrap-design.md) 的 P0 第 3 条）。

## 1. 结论

Jolli 的正式 Codex Plugin 已经落地。分发外壳、Codex 专用 bootstrap、11 个 Skills、MCP、
runtime bundle、重复 skill 清理、宿主感知认证恢复以及本地/开发/生产/zip 发布脚本都已实现。
剩余事项不再是代码功能缺口，而是需要真实外部环境的发布验证：Windows/Linux 后台登录 E2E、
独立 marketplace 仓库推送，以及公共 Plugins Directory 的资料与审核。

建议采用以下架构：

1. 新建独立的 `codex-plugin/` 分发树，不直接把 `claude-plugin/` 改成双宿主目录。
2. 复用现有 CLI、MCP server、Git hooks、workers、Codex transcript discovery、Codex
   local-agent backend 和通用 Skills。
3. 新增 Codex manifest、Codex SessionStart bootstrap、Codex 专用 Skills 和发布脚本。
4. **第一版即可承诺"仅安装插件就能用 Codex 订阅生成记忆"**，与 Claude Plugin 对称：
   `CodexBackend` 已实现，`localAgentTool` 支持 `codex`。（初版的相反结论基于过时基线，见 §0。）
   Codex bootstrap 必须以 `codex-plugin` 作为 source tag 走**共享**的 seeding 路径，不要新写。
5. ~~Codex 插件的 `.mcp.json` 必须显式设置 `cwd: "."`，并使用相对入口 `./dist/Cli.js`，不能照搬 `${CLAUDE_PLUGIN_ROOT}`。~~
   **已废弃 —— 插件不再携带 `.mcp.json`。** `cwd: "."` 会被 Codex 展开为 plugin root，
   而 MCP server 是从 cwd 推断它服务的仓库，于是插件启动的 server 会对着插件缓存目录
   回答 `recall` / `search` / `status`。改为由 bootstrap 把 server 注册进全局
   `~/.codex/config.toml`（该条目无 cwd，Codex 用**会话 cwd** 启动）。实测数据与完整
   推理见 §7.2。

## 2. 当前 Claude Plugin 是如何工作的

现有实现位于：

```text
claude-plugin/
├── .claude-plugin/marketplace.json
└── plugins/jolli/
    ├── .claude-plugin/plugin.json
    ├── .mcp.json
    ├── commands/
    ├── skills/
    ├── hooks/hooks.json
    ├── scripts/build.mjs
    └── dist/
```

### 2.1 组成

| 组件 | 当前实现 | 作用 |
|---|---|---|
| Marketplace | `claude-plugin/.claude-plugin/marketplace.json` | 发布和安装入口 |
| Manifest | `plugins/jolli/.claude-plugin/plugin.json` | 名称、版本、作者、描述 |
| MCP | `plugins/jolli/.mcp.json` | 运行内嵌的 `dist/Cli.js mcp` |
| Commands | `commands/init.md` 等 | `/jolli:init`、登录、状态、时间线 |
| Skills | `skills/recall`、`search`、`push` | 自动或显式调用工作流 |
| Bootstrap Hook | `hooks/hooks.json` | SessionStart 时执行插件初始化 |
| Runtime bundle | `scripts/build.mjs` | 将 CLI、Hooks 和 Workers 打包到 `dist/` |

### 2.2 启动流程

`PluginBootstrapHook.ts` 在 Claude SessionStart 时执行：

1. 定位当前 Git worktree。
2. 安装裸 `/jolli` 菜单。
3. 尊重 repo 的 `manuallyDisabled` 标记。
4. 保存当前 Claude session 元数据。
5. 注册插件自身的 runtime dist path。
6. 安装 Git hooks 和 Claude Stop/SessionStart hooks。
7. 默认把 AI provider 设为 `local-agent + claude-code`。
8. 注入 branch briefing 和登录/认证提醒。

因此 Claude Plugin 的核心产品承诺是：**安装插件后，不要求另装全局 CLI，并可直接借用用户的 Claude Code 登录生成记忆。**

## 3. Codex Plugin 官方模型

截至研究日期，Codex 已有正式 Plugin 协议。标准目录为：

```text
my-plugin/
├── .codex-plugin/plugin.json
├── skills/
├── hooks/hooks.json
├── .mcp.json
├── .app.json
└── assets/
```

Manifest 可引用：

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "...",
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "hooks": "./hooks/hooks.json"
}
```

Marketplace 的推荐路径：

- Repo：`$REPO_ROOT/.agents/plugins/marketplace.json`
- Personal：`~/.agents/plugins/marketplace.json`
- Codex 还会发现 legacy-compatible 的 repo 级 `.claude-plugin/marketplace.json`，但这只代表 marketplace 发现兼容，不代表 `.claude-plugin/plugin.json` 可替代 Codex manifest。

Codex 会把插件安装到：

```text
~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/
```

### 3.1 Codex Plugin 可携带的正式组件

| 能力 | Codex Plugin | 备注 |
|---|---:|---|
| Skills | 支持 | 标准 `SKILL.md`，可显式 `$skill` 或隐式触发 |
| MCP servers | 支持 | `.mcp.json` |
| Lifecycle hooks | 支持 | `hooks/hooks.json`，command handler |
| Apps/connectors | 支持 | `.app.json` |
| UI assets | 支持 | 图标、Logo、截图、默认提示词 |
| Claude-style `commands/*.md` | 源码存在迁移支持 | 会迁移成 Skill，但官方插件结构未将其列为核心组件，不建议作为新实现基础 |
| Claude-style `agents/*.md` | 不支持自动加载 | Codex subagent 使用 `.codex/agents/*.toml`，插件 manifest 当前无 agents 组件 |

## 4. Claude Plugin 与 Codex Plugin 的关键区别

| 维度 | Claude Plugin | Codex Plugin | Jolli 处理方式 |
|---|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` | 分开维护 |
| Marketplace | `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json` | 分开发布；可复用发布脚本框架 |
| 命令 | `commands/*.md` 形成 `/jolli:*` | 以 Skills 为主，显式 `$skill` | 将 init/login/status 等改写成标准 Skills |
| Skills | 支持，插件命名空间 | 支持，插件命名空间 | 复用通用 Skill 内容 |
| Agent | `agents/*.md` 可由插件携带，但 Jolli 已不带任何 agent | subagent 是 `.codex/agents/*.toml`，插件不自动携带 | 两边都不带 agent；无需迁移 |
| MCP 根路径 | `${CLAUDE_PLUGIN_ROOT}` 可直接用于参数 | MCP 参数不展开 `${PLUGIN_ROOT}`，相对 `cwd` 按 plugin root 展开 | **不带 plugin MCP entry**：唯一能写的形状会让 server 服务插件缓存目录而非用户仓库；改由 bootstrap 注册全局 `~/.codex/config.toml`（见 §7.2） |
| Hook 根路径 | `${CLAUDE_PLUGIN_ROOT}` | Hook 提供 `${PLUGIN_ROOT}`，也提供 Claude 兼容变量 | Codex Hook 使用 `${PLUGIN_ROOT}` |
| Hook 信任 | Claude 插件机制 | 非 managed plugin hooks 需用户审查信任 | 安装文档必须明确提示 `/hooks` 审查 |
| SessionStart 输出 | 支持 Claude 专用 `reloadSkills` 等 | 支持 `additionalContext`，协议不完全相同 | 新建 Codex bootstrap，不直接复用输出对象 |
| 本地订阅生成 | `claude -p`，可借 Claude 登录 | `codex exec --json`，可借 ChatGPT 订阅（`CodexBackend` 已实现） | 两边对称：MVP 即可默认 local-agent，无需 API key |
| Session 捕获 | Stop hook 主动记录 | 当前仓库已在 commit 时扫描 Codex transcript | 继续使用现有 discoverer，不依赖 transcript hook 格式 |
| Transcript 稳定性 | Claude transcript 已有适配 | Codex 官方声明 hook 的 transcript 内部格式非稳定接口 | 保留现有隔离 parser + fixtures，避免在新 Hook 中解析 transcript |

## 5. 当前仓库已经具备的 Codex 能力

### 5.1 已实现，可直接复用

1. **Codex session discovery**  
   `cli/src/core/CodexSessionDiscoverer.ts`
   - 扫描 `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
   - 扫描 `~/.codex/archived_sessions/*.jsonl`
   - 按 cwd、repo 和 nested repo 做作用域匹配

2. **Codex transcript parsing/loading**  
   `cli/src/core/TranscriptParser.ts`、`TranscriptLoader.ts`、`TranscriptReader.ts`

3. **Codex references/plans discovery**  
   `cli/src/core/CodexDiscovery.ts`

4. **Codex MCP 注册器**  
   `cli/src/install/mcp/CodexTomlWriter.ts`
   - 已支持向 `~/.codex/config.toml` 写入 `[mcp_servers.jollimemory]`
   - 对传统 CLI/IDE 安装仍有价值

5. **跨宿主 Skills**  
   `cli/src/install/SkillInstaller.ts`
   - `jolli:recall`
   - `jolli:search`
   - `jolli:local-run`
   - `jolli:remote-run`
   - `jolli`

   （`jolli-pr` 已删除，见 §0 修订记录。）

6. **全局 Codex 指令**  
   `cli/src/install/GlobalInstructionsInstaller.ts`
   - 显式 opt-in 后写入 `~/.codex/AGENTS.md`

7. **通用 runtime 和 Git hooks**  
   - dist-path registry
   - source-neutral Git hooks
   - QueueWorker / PrePushWorker
   - orphan branch + Memory Bank 双写

8. **Codex local-agent backend**（`be69a608` 已实现）  
   `cli/src/core/localagent/CodexBackend.ts`
   - `codex exec --json --skip-git-repo-check -s read-only -C <全新临时 cwd>`
   - 逐行解析 JSONL 事件流：`item.completed`/`agent_message` 取文本，
     `turn.completed.usage` 取 token 数
   - 登录失效抛 `LocalAgentAuthError`；剥离 `OPENAI_API_KEY` / `OPENAI_BASE_URL`
     以确保走订阅而非 API key 计费
   - re-entry guard 复用 `AgentReentry`；真实 fixtures 在 `__fixtures__/codex/`
   - `LocalAgentToolId` 含 `codex`，注册于 `LlmClient.ts`，doctor / status / enable /
     MCP status / VS Code 设置都经 `ToolMeta` 取标签和登录提示

9. **宿主取值的 local-agent seeding**（2026-07-30 实现）  
   `cli/src/core/localagent/PluginDefaults.ts`
   - `claude-plugin → claude-code`、`codex-plugin → codex`，按 **source tag** 索引
   - SessionStart 自动路径先到先得、永不覆盖；`/jolli:init` 显式路径覆盖
     `localAgentTool` 但不动付费 provider

### 5.2 2026-07-31 对齐结果

- `codex-plugin/`、manifest、marketplace、MCP、hook 和 self-contained runtime 已实现。
- `codex-plugin` client kind、runtime source tag、宿主感知 bootstrap 和不触碰 `.claude/`
  的安装模式已实现。
- 11 个标准 Codex Skills 已实现；静态文件由 canonical builders 生成，并有 byte-for-byte
  防漂移测试。
- **skill 目录名不带 `jolli-` 前缀**（`recall` 而非 `jolli-recall`），与 Claude Plugin 的
  `skills/recall/` 一致。codex-cli 0.146.0 上用 `codex debug prompt-input` 实测：插件技能
  以 `<plugin>:<skill>` 呈现（`j:worktree`、`pdf:pdf`），而 `~/.codex/skills/` 与仓库
  `.agents/skills/` 呈现裸名；仓库里的 `worktree` 与插件的 `j:worktree` 同时存在、互不遮蔽。
  初版加前缀的理由是"三处共享一个扁平命名空间，裸 `recall` 会撞名"，实测不成立，前缀只换来
  `jolli:jolli-recall` 这种叠字。四个共享 builder 仍声明 CLI 的前缀名（`.agents/skills/`
  没有命名空间，那里 `jolli-recall` 才是对的），所以 `renderCodexPluginSkill` 负责给 bundle
  副本换头并把兄弟引用改指 `jolli:<name>`。
- `$jolli` 已改为状态感知入口，与 Claude Plugin 的 `/jolli` 及 CLI 的
  `runGuidedFrontDoor` 走同一条 ladder：Step 0 确认可路由 → 读 `status` → 按
  provider 判断 can generate、按 Jolli 凭据判断 can sync → 未就绪走 `jolli:init`
  → 就绪打快照（含 `local agent set (not signed in to Jolli)` 等 CLI 原文案）→
  路由动作。can sync 为假时给一行**非阻塞**登录提醒并交给 `jolli:login`
  （CLI 的 `offerOptionalJolliLogin` 对应物；静态 SKILL.md 无处持久化
  "don't ask again"，所以只在单次调用内 ask-once）。setup/login/logout/status/
  timeline/push/workflow 全部出现在菜单里。两个变体的共享文案由
  `CodexPluginSkills.test.ts` 的 parity 测试逐条钉住。
- **Codex bootstrap 不再清理 `.agents/skills/`（已回滚，2026-08-03）。** 它现在完全不拥有
  任何 skill 资产 —— 与 Claude bootstrap 不同，Claude 有 `.claude/skills/` 这个单一消费者的
  私有槽位可以拥有，Codex 读的是共享目录，没有对应物。原实现按插件 inventory 删掉
  `.agents/skills/` 里带 Jolli 所有权标记的目录，用来消除 Codex 选择器里的重复行；但
  `.agents/` 是 Cursor / Gemini / OpenCode / Windsurf / Copilot 共读的目录，删除等于静默拿走
  那些 host 的唯一副本，并与后续每次 `jolli enable` / 启动自愈来回抖动 —— 用多个 host 的功能
  损失换一个 host 的观感收益。所有权标记挡不住这类问题：被删的文件确实是 Jolli 自己的，
  **所有权和消费方是两个正交维度**。团队决定先接受 Codex 里的重复（`jolli:recall` 与
  `jolli-recall` 并存），改法留到后续讨论：要么插件不再 bundle 那四个 host-neutral 技能，
  要么给每个 agent 写各自的私有 skill 目录（`.opencode/skills/`、`.codex/skills/`、
  `.claude/skills/` 实测都存在）。retired 名字的清理保留 —— 产品已不发布的名字对所有 host
  都是死的。
- 本地生成认证失败会根据实际 backend 给出 `codex login`、`claude login`、
  `cursor-agent login` 或 `opencode auth login`，不再硬编码 Claude。
- SessionStart hook 信任步骤、首次使用流程和登录边界已写入 `codex-plugin/README.md`。
- `publish-local.sh`、`publish-dev.sh`、`publish-prod.sh` 与 `publish-zip.sh` 已覆盖本地、
  Git marketplace 和离线审阅包；Git 发布强制 DCO sign-off、版本防重发和完整性检查。
- `sessions.json`、普通/发现游标以及 `config.json` 的跨进程读改写已加锁，避免多个
  agent/plugin 同时运行时丢失状态。

真实账号、不同操作系统和公共目录审核仍属于发布环境验收，不可能由单一开发 worktree
静态完成；见 §10.2、§11 Phase 3/4 和 §15。

## 6. 推荐目录结构

```text
codex-plugin/
├── .agents/
│   └── plugins/
│       └── marketplace.json
├── plugins/
│   └── jolli/
│       ├── .codex-plugin/
│       │   └── plugin.json
│       ├── hooks/                     # 无 .mcp.json —— 见 §7.2
│       │   └── hooks.json
│       ├── skills/
│       │   ├── jolli/
│       │   ├── init/
│       │   ├── login/
│       │   ├── logout/
│       │   ├── status/
│       │   ├── timeline/
│       │   ├── push/
│       │   ├── recall/
│       │   ├── search/
│       │   ├── local-run/
│       │   └── remote-run/
│       ├── scripts/
│       │   └── build.mjs
│       ├── assets/
│       └── dist/
└── scripts/
    ├── publish-local.sh
    ├── publish-dev.sh
    ├── publish-prod.sh
    └── publish-zip.sh
```

## 7. 关键配置建议

### 7.1 Codex manifest

```json
{
  "name": "jolli",
  "version": "1.0.0",
  "description": "Project memory for Codex development workflows.",
  "author": {
    "name": "jolli.ai",
    "url": "https://jolli.ai"
  },
  "homepage": "https://jolli.ai",
  "repository": "https://github.com/jolliai/jolliai",
  "license": "Apache-2.0",
  "keywords": ["memory", "recall", "pr", "git", "context"],
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "Jolli Memory",
    "shortDescription": "Recall decisions and preserve development context",
    "developerName": "jolli.ai",
    "category": "Productivity",
    "capabilities": ["Read", "Write"],
    "websiteURL": "https://jolli.ai",
    "defaultPrompt": [
      "Recall the context for this branch.",
      "Search Jolli Memory for a prior decision.",
      "Create or update the PR using Jolli Memory."
    ]
  }
}
```

### 7.2 MCP 配置

**结论：插件不携带 `.mcp.json`。** MCP server 由 bootstrap（`enable --repo-hooks-only
--source-tag codex-plugin`）注册进全局 `~/.codex/config.toml`。Codex 在会话启动时读取
MCP 注册，所以工具从**安装后的下一个会话**起可用；第一个会话由 skills 里既有的
`run-cli` 回落路径覆盖。

#### 为什么 plugin MCP entry 不可用

MCP 链路不替换 `${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`，所以 plugin entry 只能写
相对 command + `cwd: "."`（OpenAI 自家两个 stdio 插件就是这个形状），而 Codex 把相对
`cwd` 按 **plugin root** 展开。Jolli 的每个记忆工具都从 cwd 推断它服务的仓库，于是
plugin 启动的 server 会对着插件缓存目录回答 `recall` / `search` / `status`：结果为空
但"成功"，并且顺带以版本号目录名在 Memory Bank 里建出一个占位仓库。

codex-cli 0.146.0 探针实测：

| 探测项 | plugin `.mcp.json`（`cwd: "."`） | 全局 `config.toml`（无 cwd） |
|---|---|---|
| server `process.cwd()` | `~/.codex/plugins/cache/<mp>/<plugin>/<version>` | 会话目录 |
| client `roots` capability | 未声明（server 主动 `roots/list` → `{"roots": []}`） | 同上 |
| 传给 server 的 env | `HOME LOGNAME PATH SHELL TMPDIR USER __CF_USER_TEXT_ENCODING` | 同上 |

env 白名单与协议面都没有任何会话/工作区信息，所以 plugin 启动的 server **无法**自行
找回仓库 —— 这不是"再想个办法"的问题，是这条路径本身不可修。`startMcpServer` 因此在
cwd 落在插件缓存下时直接拒绝启动，让重新引入 manifest entry 立刻显式失败，而不是悄悄
服务错误的仓库。

#### launcher 剩下的用途

`dist/McpLauncher.js` 保留，但只服务一个窄场景：**win32 的全局 entry**。POSIX 的 entry
是 `run-cli`，本身就在 spawn 时解析胜出 dist；win32 无法直接 spawn 这个无扩展名 bash
脚本，registrar 退回 `node <解析出的 Cli.js>`，那会把 runtime **版本**冻结在注册时刻。
把该 entry 指向 launcher，则冻结的只是路径，版本仍在每次启动时重新解析。解析逻辑复用
`pickBestDistPath` / `traverseDistPaths`，不新增第三份实现。见 `cli/src/McpLauncher.ts`
与 `install/mcp/HostRegistrars.ts` 的 `codexEntry`。注意 `McpLauncher.js` 只存在于
Codex 插件的 dist 里，所以该分支是存在性检查后的**渐进增强**；把它提升为
`REQUIRED_RUNTIME_FILES` 会让所有已安装的旧 dist 立即变成"不完整"而自我注销。

### 7.3 Hook 配置

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${PLUGIN_ROOT}/dist/CodexPluginBootstrapHook.js\"",
            "statusMessage": "Initializing Jolli Memory"
          }
        ]
      }
    ]
  }
}
```

Codex 会为 plugin hook 提供 `PLUGIN_ROOT`、`PLUGIN_DATA`，并兼容提供 `CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`。新实现应使用 Codex 原生变量。

## 8. Bootstrap 不能直接复用的原因

现有 `repoHooksOnly` 模式实际带有 Claude 语义：

- 写 `.claude/skills/jolli/`
- 清理 Claude legacy skills
- 安装 Claude Stop/SessionStart hooks
- 根据 `claudeEnabled` 决定行为

Codex Plugin 不能直接调用该模式，否则安装 Codex Plugin 可能意外修改 `.claude/`。

建议新增明确的插件宿主模式：

```ts
pluginBootstrap?: "claude" | "codex"
```

共享行为：

- 注册 runtime dist path
- 安装 dispatch scripts
- 初始化 `.jolli/jollimemory/`
- 安装 source-neutral Git hooks
- 尊重 `manuallyDisabled`
- **local-agent 默认 provider 的 seeding** —— 共享同一段代码，值按各自的 source tag 取
  （`PluginDefaults.ts`，见 §10.1）。这一条初版列在 Claude-only 里，现已改为共享：Codex
  bootstrap 不要新写一份 seeding 逻辑

Claude-only：

- 裸 `/jolli` 菜单
- Claude Stop/SessionStart hooks

Codex-only：

- 不写 `.claude/`
- 不重复注册插件已经携带的 MCP/Skills
- 使用现有 Codex transcript discoverer
- 注入 branch briefing，但不解析 hook 提供的 transcript 内容

## 9. Skills 迁移策略

### 9.1 直接复用

以下通用 Skills 已经适用于 Codex：

- `jolli:recall`
- `jolli:search`
- `jolli:local-run`
- `jolli:remote-run`
- `jolli`

### 9.2 从 Claude commands 转换为标准 Skills

| Claude command | Codex Skill |
|---|---|
| `/jolli:init` | `$jolli:init` |
| `/jolli:login` | `$jolli:login` |
| `/jolli:logout` | `$jolli:logout` |
| `/jolli:status` | `$jolli:status` |
| `/jolli:timeline` | `$jolli:timeline` |
| `/jolli:push` | `$jolli:push` |

虽然 Codex 源码会把部分 `commands/*.md` 迁移成 Skills，但这属于兼容路径，且有 frontmatter、模板语法和大小限制。新插件应直接提供标准 Skills。

### 9.3 Agent / PR 相关资产：无需迁移

初版这里讨论的是「把 Claude `agents/pr-writer.md` 转成什么」。该问题已经消失：
`agents/pr-writer.md` 和 `jolli-pr` Skill 都已从仓库移除（`14bd6f0a`），`jolli-pr` 现在
列在 `SkillInstaller.ts` 的 `REMOVED_SKILL_NAMES` 里，`jolli enable` 会主动清理残留。

因此 Codex Plugin **不要**携带 `jolli-pr`，也不需要任何 `.codex/agents/*.toml`。PR 相关
能力目前由 MCP 的 `get_pr_description` + `queue_status` 两个工具提供，两边宿主都能直接用。

### 9.4 防止 Skill 内容漂移

不要长期手工维护第三份 Skill 文本。建议：

1. Codex plugin build 时从 `SkillInstaller.ts` 的 canonical builders 生成静态 `SKILL.md`；或
2. 暂时保存静态副本，但增加测试，将插件 Skill 与 builder 输出做 byte-for-byte 对比。

修改 Skill 时仍必须遵守当前 CLI、VS Code、IntelliJ 的 revision lockstep 规则。

## 10. `local-agent` 已经对称（本节 2026-07-30 重写）

初版把 `local-agent` 判为两个插件之间最大的产品差异，理由是配置只允许
`localAgentTool = claude-code`。该前提在 `be69a608` 之后不成立：

```text
LocalAgentToolId = "claude-code" | "codex" | "cursor-agent" | "opencode"
```

四个 backend 都已注册（`LlmClient.ts`）。所以：

- **MVP 即可默认 `local-agent`**，和 Claude Plugin 对称。Codex 用户借自己的 ChatGPT
  订阅生成记忆，不需要 Jolli 登录、不需要 Anthropic key。
- 初版建议的「init 引导用户三选一」**不再需要**，可以直接砍掉。

### 10.1 seeding 的取值必须跟着宿主走

对称之后出现一个新问题：`aiProvider` / `localAgentTool` 是**机器全局**的，而生成发生在
post-commit 的共享 worker 里（不在会话内），所以宿主身份在使用时已经丢失，只能从配置里”回忆”。
如果两个插件都硬编码自己的默认值去写这一个全局值，就变成「谁先跑谁赢」，且赢家被静默固化。

已实现的处理（`PluginDefaults.ts`，细节见
[dual-plugin-bootstrap-design](2026-07-24-dual-plugin-bootstrap-design.md) P0 第 3 条）：

- seeding 的 tool 值按 **source tag** 查表得来，不再硬编码 `claude-code`；
- SessionStart 自动路径先到先得、永不覆盖（防拉锯）；
- `/jolli:init` 显式路径覆盖 `localAgentTool`，但不动已选的付费 provider；
- 设置不对时用户手动改（`jolli configure --set localAgentTool=…` 或 VS Code 设置）。

**Codex Plugin 的实现要求**：它的 bootstrap 必须以 `codex-plugin` 作为 source tag 走同一条
路径，不要新写一份 seeding 逻辑；它的 init recipe 必须显式传 `--source-tag codex-plugin`
（`clientKind` 在 `run-cli` 路径上不可信，见 `PluginDefaults.ts` 的注释）。

### 10.2 发布环境仍需验证的

`CodexBackend` 已覆盖初版列出的绝大部分未知项：非交互参数与输出格式（`codex exec --json`，
有真实 fixture）、登录失效识别（`LocalAgentAuthError`）、sandbox/approval（`-s read-only`
+ `--skip-git-repo-check`）、re-entry guard、模型选择（`-m`）。剩下三项仍未验证：

- **后台 worker 环境能否访问用户 Codex 登录** —— 与 Claude 的 OAuth 漂移问题同类，需要真实
  验证；
- **限流 / 并发行为** —— 需要真实订阅和高并发环境。

`costUsd: 0` 不是漏接 Codex 字段：当前 `codex exec --json` 的 `turn.completed.usage` 只提供
token 数，不提供金额；ChatGPT 订阅调用也没有可归因到单次请求的 API 账单金额。reasoning
继续沿用用户 Codex 配置，插件不强行覆盖用户的全局 `model_reasoning_effort`。

## 11. 分阶段实施计划

### Phase 1：可安装 MVP（已完成）

目标：Codex 能安装插件，并正常使用 Jolli MCP 与 Skills。

1. 创建 `codex-plugin/` 目录和 marketplace。
2. 添加 `.codex-plugin/plugin.json`。
3. ~~添加 `.mcp.json`，固定 `cwd: "."`。~~ 改为：不加 `.mcp.json`，让 bootstrap 的
   `enable --repo-hooks-only --source-tag codex-plugin` 注册全局 Codex MCP 条目（§7.2）。
4. 复制/生成通用 Skills，并新增 init/login/logout/status/timeline/push Skills。
5. 添加 Codex build，打包 `Cli.js` 和所有 Git hook/worker runtime。
6. 增加 `codex-plugin` client kind 和服务端 allowlist。
7. 增加 manifest、MCP cwd、build entry 和 Skill 同步测试。
8. init recipe 显式传 `--source-tag codex-plugin`（见 §10.1）。

验收：安装后 MCP tools 可用，`$jolli:recall`、`$jolli:search` 可运行；`$jolli:init` 后
`localAgentTool` 为 `codex`。

### Phase 2：自动 bootstrap（已完成）

目标：安装插件后，在 Git repo 的 Codex SessionStart 自动启用捕获与 branch briefing。

1. 新增 `CodexPluginBootstrapHook.ts`。
2. 抽取 Claude/Codex 共享 bootstrap core。
3. 为 Installer 增加 host-aware plugin bootstrap mode。
4. 确保 Codex bootstrap 不写 `.claude/`。
5. 输出 Codex 支持的 `additionalContext`，不输出 Claude-only `reloadSkills`。
6. 添加 hook trust 指引和测试。

验收：新 session 自动安装 Git hooks；手工禁用后不被重新启用；不会修改 Claude 配置。

### Phase 3：Codex local-agent backend（大部分已完成）

目标：通过用户 Codex 登录生成记忆。原计划的 5 项里 4 项已由 `be69a608` 落地：

1. ~~实现 `CodexBackend`~~ —— 已完成。
2. ~~扩展 `localAgentTool` 类型、配置、doctor 和修复流程~~ —— 已完成（`ToolMeta` 驱动
   doctor / status / enable / MCP / VS Code 设置）。
3. ~~加入 re-entry guard~~ —— 已完成（复用 `AgentReentry`）。
4. ~~添加真实 Codex CLI fixtures 和登录失败测试~~ —— 已完成（`__fixtures__/codex/`，
   `CodexBackend.test.ts` 9 例）。
5. **在 macOS/Linux/Windows 验证后台 worker** —— 仍未做。代码里有 win32 路径分支，但没有
   跨平台 E2E，也没验证 detached worker 能否访问用户的 Codex 登录（见 §10.2）。

因此本阶段代码已完成；只剩第 5 项和 §10.2 所列的外部环境矩阵验证。它**不再是 Codex Plugin
的前置条件**。

验收：无 Jolli/Anthropic key 时，Codex local-agent 在三个平台的后台 worker 中都能稳定生成总结。

### Phase 4：发布（代码完成，外部发布待执行）

1. 本地 repo marketplace 和 zip 打包脚本已实现并纳入完整性检查。
2. 开发/生产 Git marketplace 发布脚本已实现；实际远端仓库创建和 push 需要发布权限。
3. 发布脚本执行 build、完整性检查、版本防重发、DCO commit 和同步。
4. 默认提示词和 README 已完成；公共目录所需 Logo、截图、隐私政策、服务条款仍需产品资料。
5. 内部 workspace 分享验证后，再提交公共 Plugins Directory 审核。

## 12. 测试策略

至少覆盖：

1. `plugin.json` 必填字段、相对路径和文件存在性。
2. 插件树**不得**出现 `.mcp.json`，manifest 不得声明 `mcpServers`；bootstrap 必须写出
   全局 Codex MCP 条目，且该条目不带 `cwd`；`startMcpServer` 必须拒绝插件缓存 cwd。
3. 构建输出必须包含：
   - `Cli.js`
   - Codex bootstrap
   - 5 个 Git hooks
   - 2 个 workers
   - 共享 SessionStart 所需模块
4. Codex SessionStart input/output fixture。
5. Codex bootstrap 不创建或修改 `.claude/**`。
6. `manuallyDisabled` 生效。
7. worktree-aware 安装和 runtime registry。
8. 插件 Skills 与 canonical builders 不漂移。
9. `x-jolli-client: codex-plugin/<version>`。
10. 从模拟 `~/.codex/plugins/cache/...` 路径启动 MCP，验证相对 cwd。
11. **local-agent seeding**：Codex bootstrap 以 `codex-plugin` tag seed 出
    `localAgentTool: "codex"`；Claude 先跑时 Codex 的自动路径不覆盖它；`$jolli:init`
    显式覆盖成 `codex`。（`claude-plugin` 侧的对应用例已在
    `PluginDefaults.test.ts` / `Installer.test.ts` / `SessionStartHook.test.ts` 中。）
12. 最终执行仓库要求的 `npm run all`。

## 13. 风险与约束

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Codex Hooks 协议仍在演进 | 字段行为可能变化 | 只使用官方当前明确支持的 command handler 和 additionalContext |
| Plugin hooks 需要用户信任 | 自动初始化可能未执行，包括 MCP 注册 | 安装后明确引导审查 `/hooks`；Skills 先经 `run-cli` 回落可用 |
| plugin MCP entry 的 cwd 是 plugin root | server 会服务插件缓存目录而非用户仓库（空结果 + 占位 Memory Bank 仓库） | 不带 `.mcp.json`，改注册全局 `config.toml`；`startMcpServer` 拒绝插件缓存 cwd（§7.2） |
| Codex transcript 格式非稳定接口 | parser 可能随升级失效 | 保持隔离 parser、真实 fixtures、fail-soft discovery |
| Node 不在 PATH | 内嵌 CLI 无法启动 | 安装检查给出明确诊断；后续评估 standalone executable |
| Skill 多份副本漂移 | 各宿主行为不一致 | build-time generation 或 byte-identical 测试 |
| local-agent 误用另一宿主的 backend | Codex 用户被指向未安装的 `claude`，生成在后台静默失败 | seeding 按 source tag 取值 + 自动路径先到先得 + `/jolli:init` 显式覆盖（已实现，见 §10.1） |
| 双插件同时安装 | runtime、hooks 竞争 | 继续使用 versioned dist registry、locks 和 source-neutral hooks |

## 14. 推荐的第一批代码改动

按提交拆分：

1. ~~`feat(cli): derive the local-agent seed from the plugin host`~~ —— **已完成**
   （2026-07-30，`PluginDefaults.ts`）。这是 P0 的第 3 条，也是 Codex Plugin 发布前
   必须先落地的一条：它必须在 Codex Plugin 上线**之前**进入，否则盘上会出现无法区分
   「竞态写入」和「用户手选」的 `localAgentTool` 值，届时只能靠猜写迁移逻辑。
2. ~~`feat(codex-plugin): scaffold manifest marketplace and skills`~~ —— 已完成
3. ~~`build(codex-plugin): bundle CLI hooks and workers`~~ —— 已完成
4. ~~`feat(cli): add codex-plugin client and dist source`~~ —— 已完成
5. ~~`refactor(cli): add host-aware plugin bootstrap mode`~~ —— 已完成
6. ~~`feat(codex-plugin): install repo hooks on session start`~~ —— 已完成
7. ~~`test(codex-plugin): cover manifest MCP cwd and bootstrap isolation`~~ —— 已完成
8. ~~`docs(codex-plugin): add install development and release guide`~~ —— 已完成

每个 commit 必须带 DCO sign-off，且最终运行 `npm run all`。

## 15. 证据边界与研究限制

两条最容易踩错的支持边界（结论摘要，展开见 §3.1 与 §9.2）：

- **Commands**：Codex 官方源码存在把部分 `commands/*.md` 迁移成 Skills 的兼容路径，但正式
  plugin manifest 不把 commands 列为核心组件，且该路径受 frontmatter、模板语法和大小限制。
  适合兼容旧内容，**不适合作为新插件的架构基础** —— Jolli 应直接提供标准 Skills。
- **Agents**：Codex manifest 当前没有 agents 字段，Claude 的 `agents/*.md` **不会**作为
  Codex subagent 自动加载；Codex 自定义 subagent 用 `.codex/agents/*.toml`。而 Jolli 现在
  两边都不带 agent，所以这条只是"不要误以为能带"的防错记录。

当前开发机已经可以执行 Codex CLI，并能只读检查登录状态；完整 hook 信任仍需要用户在 Codex
交互界面确认，公共 marketplace 安装还需要实际远端仓库。关键协议除官方文档外，已通过
OpenAI Codex 官方源码核验，特别是：

- plugin MCP 的 cwd/path 解析；
- MCP 不做 `${PLUGIN_ROOT}` 参数替换；
- hooks 才注入并展开 plugin root 变量；
- `commands/*.md` 的迁移路径；
- plugin manifest 当前没有 agents 组件。

发布前仍应在 macOS/Linux/Windows 的当前稳定版 Codex 上各完成一次真实缓存安装验证。

## 16. 主要参考资料

### OpenAI 官方文档

- Codex Plugins：<https://developers.openai.com/codex/plugins/build>
- Codex Skills：<https://developers.openai.com/codex/skills>
- Codex Hooks：<https://developers.openai.com/codex/hooks>
- Codex MCP：<https://developers.openai.com/codex/mcp>
- Codex AGENTS.md：<https://developers.openai.com/codex/guides/agents-md>
- Codex Customization：<https://developers.openai.com/codex/concepts/customization>

### OpenAI 官方源码核验点

基准提交：`openai/codex@81da9deb065d7adb283816b19b40f89bcc484276`

- `core-plugins/src/loader.rs`：plugin root 传入 MCP 解析
- `codex-mcp/src/plugin_config.rs`：plugin MCP cwd 规范化
- `core/src/session/mcp_runtime.rs`：host plugin 默认 cwd
- `rmcp-client/src/stdio_server_launcher.rs`：stdio command/args 启动
- `hooks/src/engine/discovery.rs`：plugin hook 环境变量与替换
- `core-plugins/src/store.rs`、`command_migration/plugin.rs`：commands 到 Skills 的迁移
- `plugin/src/manifest.rs`：Codex plugin manifest 组件

### 当前仓库关键文件

- `claude-plugin/plugins/jolli/scripts/build.mjs`
- `claude-plugin/plugins/jolli/commands/init.md`（显式 init recipe，传 `--source-tag`）
- `cli/src/hooks/PluginBootstrapHook.ts`
- `cli/src/hooks/SessionStartHook.ts`（`ensurePluginDefaultProvider`）
- `cli/src/install/Installer.ts`（显式 init 的 provider 写入，`!automatic` 门禁）
- `cli/src/install/SkillInstaller.ts`
- `cli/src/install/mcp/CodexTomlWriter.ts`
- `cli/src/core/CodexSessionDiscoverer.ts`
- `cli/src/core/CodexDiscovery.ts`
- `cli/src/core/localagent/CodexBackend.ts`
- `cli/src/core/localagent/PluginDefaults.ts`
- `cli/src/core/localagent/ToolMeta.ts`

### 相关设计文档

- [2026-07-23-multi-tool-local-agent-design](2026-07-23-multi-tool-local-agent-design.md)
  —— Codex / Cursor / OpenCode backend 的设计
- [2026-07-24-dual-plugin-bootstrap-design](2026-07-24-dual-plugin-bootstrap-design.md)
  —— 双插件共存审计与 P0 清单
