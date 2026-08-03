# Claude Plugin 与 Codex Plugin 双 Bootstrap 共存审计

> 审计日期：2026-07-24  
> 修订日期：2026-07-30  
> 范围：当前 Jolli 源码设计

## 0. 修订记录

**P0 第 3 条已实现，且方案与初版建议不同。** 初版建议「引入 repo/host-scoped provider
preference」；实际采用的是更简单的方案：seeding 的值按宿主取，自动路径先到先得不拉锯，显式
`/jolli:init` 覆盖，设置不对由用户手改。§4.2 和 §6 已按实际实现重写，理由记在 §4.2.1。

初版另一处前提也已过时：初版写作时 `localAgentTool` 只允许 `claude-code`。`be69a608` 之后
四个 backend（claude-code / codex / cursor-agent / opencode）都已注册，所以"Codex 侧没有
合法值"不再成立——这恰恰让冲突从单向污染升级为双向竞态，见 §4.2。

## 1. 结论

**两个插件可以共存，但 Codex Plugin 不能直接复用当前 Claude 专用的 `PluginBootstrapHook` 或 `repoHooksOnly` 安装模式。**

并发执行本身通常不会把 Git Hooks 或 runtime registry 写坏，因为现有实现具备 repo lifecycle lock、runtime registry lock、原子写入和同 source 防降级机制。真正的风险集中在四个方面：

1. ~~当前 Bootstrap 包含 `.claude/**` 专属副作用~~ —— **`install()` 侧已修复**
   （2026-07-30，见 §4.1.1）；`PluginBootstrapHook` 自身的 Claude 专属步骤仍待 P0 第 1 条
   拆分；
2. ~~machine-global runtime winner 可能把某一宿主的编译期 client kind 泄漏到另一宿主~~ ——
   **已核实并修复，但缺陷位置与此描述不同**（2026-07-30，见 §4.3.1）；
3. ~~Claude Bootstrap 会静默写入全局 `local-agent + claude-code` provider~~ —— **已修复**
   （2026-07-30，见 §4.2）；
4. uninstall 没有安装来源所有权，单个插件可能删除另一插件仍依赖的共享 Git Hooks。

因此，推荐在开发 Codex Plugin 前先拆分“共享 Bootstrap Core”和“宿主 Adapter”。

## 2. 风险分级

| 区域 | 当前判断 | 风险 | 说明 |
|---|---|---:|---|
| Repo lifecycle lock | 可共存 | 低 | 同一 repo 的 Hook reconcile 串行执行，超时不会无锁继续 |
| Runtime registry lock | 可共存 | 低 | `dist-paths/<sourceTag>` 在机器级锁内更新 |
| Git Hook 文件 | 基本可共存 | 低 | marker、dispatcher、Hook 逻辑是共享且幂等的 |
| `manuallyDisabled` | 可共存 | 低 | repo-wide 标志应由两个自动 Bootstrap 共同尊重 |
| Skill revision upsert | 可共存 | 低 | Jolli-owned Skill 不降级；非 Jolli 同名 Skill不覆盖 |
| `.claude/**` 操作 | 已修复 | ~~高~~ | `repoHooksOnly` 按宿主参数化，非 Claude 宿主不写 `.claude/**`（§4.1.1） |
| AI provider 默认值 | 已修复 | ~~高~~ | 值改为按宿主 source tag 取；自动路径先到先得，显式 init 覆盖（§4.2） |
| Runtime winner | 已修复 | ~~高~~ | 两个 resolver 枚举顺序已对齐；共享 worker 的 client kind 仅用于日志（§4.3.1） |
| Dispatcher 更新 | 版本冲突 | 中高 | atomic write 防撕裂，但没有 schema/version 防止旧插件覆盖新 launcher |
| Uninstall | 会冲突 | 高 | 没有 source lease/refcount，任一完整卸载都会删除共享 Git Hooks |
| `sessions.json` | 可能丢更新 | 中 | atomic write 不等于原子 read-modify-write；两个宿主并发保存可能相互覆盖 |
| 全局 `config.json` | 可能丢更新 | 中 | `load → merge → atomicWrite` 未受专用锁保护 |
| Plugin MCP/Skills | 可能重复配置 | 中 | Codex Plugin 已携带 MCP/Skills 时，不应再修改全局 Codex 配置 |

## 3. 当前已经安全的部分

### 3.1 Repo 与 runtime 锁

`cli/src/core/Locks.ts` 已区分：

- repo hooks/profile 生命周期锁；
- machine-global runtime registry 锁。

两种锁不得同时持有，可避免跨 repo 与全局 registry 的锁顺序死锁。自动 Bootstrap 的短超时策略也不会在锁失败后绕过保护直接写文件。

### 3.2 Git Hooks 重复安装

共享 Git Hooks 使用统一 marker 和 dispatcher，并在 repo lifecycle lock 内 reconcile。Claude 与 Codex 先后执行安装时，通常只会得到“已经存在”或内容一致的结果，不会生成两套串联 Hook。

但这里的安全性仅限于“Hook 文件不会因重复安装损坏”，不代表其最终选择的 runtime 一定具备正确宿主语义。

### 3.3 Runtime source 独立登记

`DistPathWriter.ts` 为每个来源写独立文件：

```text
~/.jolli/jollimemory/dist-paths/claude-plugin
~/.jolli/jollimemory/dist-paths/codex-plugin
```

同一 source 已有完整且版本不低的 runtime 时不会降级，因此两个插件不会直接覆盖同一个 source entry。

### 3.4 Skills revision 规则

`SkillInstaller.ts` 的核心规则是：

```ts
if (!isJolliOwnedSkill(existing)) {
  return;
}

if (parseRevision(existing) >= myRevision) {
  return;
}
```

所以较旧插件不会降级较新 Skill，非 Jolli 所有的同名 Skill也不会被覆盖。前提是严格遵守“相同 revision 必须对应相同内容”的发布契约，最好增加 byte-for-byte 同步测试。

## 4. 明确冲突点

### 4.1 Codex 不能调用当前 Claude Bootstrap

`cli/src/hooks/PluginBootstrapHook.ts` 直接执行：

```ts
await installPluginJolliMenu(worktreeRoot);
await removeClaudeLegacySkills(worktreeRoot);
```

随后调用：

```ts
await install(worktreeRoot, {
  repoHooksOnly: true,
  sourceTag: "claude-plugin",
  respectManualDisable: true,
  automatic: true,
});
```

而 `Installer.ts` 的 `repoHooksOnly` 分支仍会执行 Claude 菜单、Claude legacy skill 清理及 Claude agent hook reconcile。因此它并不是通用的”只安装 repo hooks”模式，而是 Claude Plugin 模式。

**影响：** 如果 Codex Bootstrap 复用它，安装或启动 Codex Plugin 会修改 `.claude/**`；若 Claude Plugin 版本不同，还可能升级、清理或重写 Claude 侧资产。

#### 4.1.1 已修复：`repoHooksOnly` 现在按宿主参数化（2026-07-30）

**实际做法与初版建议不同**，这里记录真实形状。初版设想抽出一个独立的
`reconcileSharedRepoRuntime()`，由两个 bootstrap 分别调用。实现时没有这么做，理由是：
`install()` 本身**就是**那个共享核心 —— worktree 枚举、repo/runtime 双锁、dist-path 注册、
source-neutral Git hooks 全在它里面。把其中一部分搬出去会造出**两个入口进入同一套加锁生命周期**，
风险高于收益，而且那条路径的测试覆盖极密（改动面越大回归面越大）。

改成给这个模式加宿主参数：

```ts
const pluginHost = pluginBootstrapHost(sourceTag);   // "claude" | "codex"
```

`Installer.ts` 的 `repoHooksOnly` 分支据此分成两层：

| 步骤 | 归属 |
|---|---|
| `ensureJolliMemoryDir` + `sessions.json` 引导 | host-neutral |
| `removeRetiredSkills`（只扫 `.agents/skills/`） | host-neutral |
| source-neutral Git hooks、dist-path、dispatch scripts | host-neutral |
| `installPluginJolliMenu`（写 `.claude/skills/jolli/`） | `pluginHost === "claude"` |
| `removeClaudeLegacySkills` | `pluginHost === "claude"` |
| `addGitExcludePaths(PLUGIN_JOLLI_MENU_…)` | `pluginHost === "claude"` |
| `reconcileClaudeAgentHooks`（按 `claudeEnabled`） | `pluginHost === "claude"` |

一个关键的分类依据：`removeRetiredSkills` 看似 Claude 相关，实际 host-neutral —— `SKILL_TARGETS`
里**只有** `.agents/skills/`（`.claude/skills/` 已按 2026-07-21 的决定移出），而 `.agents/` 正是
Codex 自己读的目录，所以这一步必须继续为非 Claude 宿主执行。

**未改名。** 审计原文建议避免 `repoHooksOnly` 这个名字继续承载 Claude 语义，但
`--repo-hooks-only` 是**已发布的 CLI 表面**，旧版插件 bundle 会把它传给新版 CLI —— 改名会破坏
dist registry 存在的意义（跨版本派发）。改为在选项定义处写明”这是插件 bootstrap 模式，按宿主
参数化，读作『某一个宿主的 repo 生命周期』而不是『Claude』”。

**遗留一处，归 P0 第 1 条处理。** `PluginBootstrapHook.ts` 在 repo 被手动禁用时调用
`uninstall(worktreeRoot, { preserveMenu: true, repoLockHeld: true })`，这会拆掉 Claude 侧资产。
Codex 的 bootstrap hook 尚不存在，所以它该如何处理禁用路径（以及按 source ownership 卸载，
见 §4.5）留给 `CodexPluginBootstrapHook.ts` 落地时一并决定。

### 4.2 全局 provider 的宿主竞态（已修复，2026-07-30）

**问题。** `SessionStartHook.ts` 原先为 Claude Plugin 硬编码写入：

```ts
await saveConfig({
  aiProvider: "local-agent",
  localAgentTool: "claude-code",
});
```

该配置是 machine-global，不是宿主局部配置。而记忆生成并不发生在会话内 —— AI agent hook 只记
session 元数据，真正调 LLM 的是 `git commit` 之后 `post-commit` spawn 的 detached
`QueueWorker`。于是写和读被 commit 隔开：写发生在某个宿主的 SessionStart，读发生在几天后、
另一个 repo、另一个宿主的一次 commit 之后，而那时宿主身份已经丢失，worker 只能从这个全局单值
里”回忆”。

具体失败时间线：周一在任意 repo 开一次 Claude Code → 全局被写成 `claude-code`；周三全程用
Codex 干活并 commit → worker 读到 `claude-code` → spawn `claude -p` → 机器没装 `claude`
或其 OAuth 已过期 → 生成失败，落 `local-agent-auth` marker → 下次会话提示用户”去跑
`claude auth login`”，而他从头到尾在用 Codex。失败还发生在后台进程里，只落 `debug.log`，
延迟数天且跨 repo，极难察觉。

`be69a608` 让四个 backend 都合法之后，这从”Claude 单向污染 Codex”升级为**双向竞态**：谁先跑
谁把全局值写死；因为门禁是 `aiProvider === undefined`，第二个宿主会看到”用户已表态”而礼貌地
什么都不做 —— 竞态结果被静默固化，没有任何提示。

**已实现的方案**（`cli/src/core/localagent/PluginDefaults.ts`）：

| 路径 | `localAgentTool` | `aiProvider` |
|---|---|---|
| SessionStart（`automatic: true`） | 仅当 `aiProvider === undefined` 时按宿主取值写入，**永不覆盖** | 同左，先到先得 |
| `/jolli:init`（无 `--automatic`） | **总是**改成发起宿主的 tool | 仍然先到先得，不覆盖 |

三条要点：

1. **值按 source tag 取，不再硬编码。** `claude-plugin → claude-code`、
   `codex-plugin → codex`。不能用编译期 `clientKind`：`/jolli:init` 经 `run-cli` 派发，
   同版本时 `cli` 赢（`b09ac518` 的团队决策刻意不带 `JOLLI_DIST_PREFER_SOURCE`），
   `__JOLLI_CLIENT_KIND__` 在那条路径上会读成 `"cli"`。只有 recipe 显式传的
   `--source-tag` 在两条路径上都可信。
2. **自动路径的 `undefined` 门禁就是防拉锯的机制。** 第二个启动的宿主看到已有值就完全不动。
   `Installer.ts` 里那个 `!options?.automatic` 门禁是 load-bearing 的：SessionStart 的
   bootstrap 走的是**同一个** `install()` 且带着插件 source tag，漏掉它就会每次会话覆盖一次。
3. **`aiProvider` 与 `localAgentTool` 分开对待。** 前者决定花谁的钱，已选 `jolli` /
   `anthropic` 的用户不能因为在某个 agent 里跑了 init 就被拖到 local-agent；后者只在 provider
   是 local-agent 时才有意义，可以被显式 init 改写。

#### 4.2.1 为什么不做 host-scoped provider preference

初版建议给配置分宿主分区（`hosts.claude.localAgentTool` 之类）。放弃的理由：

- **消费方是共享的 source-neutral worker。** 一个 commit 可能同时含多个宿主的会话，
  “该用哪个宿主的设置”在 commit 时没有唯一答案。
- 配置面要在 CLI / VS Code / IntelliJ 三处设置 UI 同步扩展，白踩三方 lockstep。
- 团队最终选择了更简单的语义：先到先得 + 显式 init 覆盖 + 设错了手动改
  （`jolli configure --set localAgentTool=…`，取值列表已从 `LOCAL_AGENT_TOOLS` 注册表派生，
  四个 tool 都能选）。

曾经评估过的第三种方案是按被总结会话的 transcript source 动态探测可用 backend。它能自愈，但
需要一张 source→backend 偏映射（id 不一对一，且 gemini/copilot/devin/antigravity 没有
backend）、要把 source 信号顺着 `LlmCallOptions` 传下去、还要处理 backfill 无 source 的情形。
团队判断复杂度不值得，改用手动覆盖。

#### 4.2.2 排期约束

现存盘上的 `localAgentTool: "claude-code"` 都是合法值：seeding 门禁是
`clientKind === "claude-plugin"`，`enable` 的 `autoSelectClaudeCode` 还要求
`isClaudeCodeUsable()` 探针先通过。所以**不需要数据迁移** —— 前提是本修复在 Codex Plugin
发布**之前**落地。否则盘上会出现无法区分”竞态写入”和”用户手选”的值，届时只能靠猜写迁移逻辑。

### 4.3 Runtime winner 与 client kind 泄漏

Plugin bundle 通过编译期常量 `__JOLLI_CLIENT_KIND__` 区分 `claude-plugin` 与未来的 `codex-plugin`。但 machine-global dispatcher 会从所有 `dist-paths/*` 中选择一个 runtime winner。

当前 `DistPathResolver.ts` 的显式优先级只有：

```ts
export const SOURCE_PREFERENCE_ORDER = ["cli", "vscode", "cursor"];
```

Claude/Codex Plugin 都未列入。两者 core version 相同时，winner 缺少明确、跨 Node/shell 一致的 tie-break 契约。更重要的是，即使增加固定优先级，只要共享 Git worker 内仍依赖编译期 client kind，就可能在另一宿主触发时带入错误身份、header、提示或分支逻辑。

**建议：**

- 共享 Git/runtime 路径必须 host-neutral；
- 宿主身份通过显式参数或环境变量传入；
- Claude/Codex SessionStart 应调用自己的宿主入口，不通过 machine-global winner 推断宿主；
- 为 `claude-plugin`、`codex-plugin` 增加确定性的 resolver 测试，但不要把 tie-break 当成宿主隔离方案。

#### 4.3.1 已修复，但问题不在审计说的位置（2026-07-30）

落地时逐处核对了代码，**上面对"共享 Git worker 依赖编译期 client kind"的判断与实际不符**，而真正的
缺陷在另外两处。如实记录，免得后来的人按错误的地图去改。

**（a）共享 worker 没有行为泄漏。** `resolveClientKind()` 在 `QueueWorker.ts` 里只有一处调用，
且只喂给 `buildWorkerStartupBanner()` —— 一行 `debug.log` 诊断。banner 里的 `source` 字段还是从
`distDir` 反推的，不是从 kind 推的。共享 worker 不存在依赖 client kind 的分支逻辑、header 或提示，
所以"在另一宿主触发时带入错误身份"目前只会表现为**日志里的来源名写错**，不影响行为。未改动。

**（b）真正的行为缺陷在 `PluginLoader`。** 插件发现门禁原先是：

```ts
if (isClaudePluginBuild()) return { known, found: [], skipped: true };
```

它的存在理由是：插件内嵌的 CLI 只用来跑 `mcp` 和 `enable --repo-hooks-only`，是固定命令面，不是
plugin host；不拦住它，每次调用都会扫描用户的全局 npm root，然后为一堆它根本不用的 host-CLI 插件
（site-cli / space-cli）打印 peer-mismatch 警告和升级提示。

这个理由对 **Codex bundle 完全同样成立**，但门禁只认 Claude 的 kind —— Codex 插件一上线就会漏进
standalone-CLI 行为。改成 `isPluginBundleBuild()`（`claude-plugin` 或 `codex-plugin`）。判定逻辑
拆成纯函数 `isPluginBundleKind(kind)` 才能被测到：`__JOLLI_CLIENT_KIND__` 在 vitest 里是被
`define:` 固定成 `"cli"` 的字面量，读它的谓词永远只能观测到 false。

**（c）resolver 的不确定性是真的，但位置也不同。** 不是缺少 tie-break 契约，而是**两个 resolver 的
枚举顺序不一致**：

| resolver | 枚举方式 | 是否有序 |
|---|---|---|
| `resolve-dist-path`（shell） | glob `dist-paths/*` | **有序**（POSIX glob 按 collation 排序） |
| `traverseDistPaths`（TS） | `readdirSync` | **无序**（文件系统顺序） |

`pickBestDistPath` 的版本比较是严格 `>`，所以平局时取**先见到的那个**——枚举顺序就是最终 tie-break。
两侧顺序不一致，就意味着同一个目录下 shell 和 TS 可能选出**不同的 winner**（shell 是 git hook 实际
使用的，TS 是 status/doctor 等进程内路径使用的）。这个 bug **今天就已潜伏**：`intellij` 和
`claude-plugin` 都不在 `SOURCE_PREFERENCE_ORDER` 里，同版本时即可触发；第二个插件宿主只是让它变常见。

修法是给 `traverseDistPaths` 的 `readdirSync` 加 `.sort()`，与 shell 的 glob 对齐。**没有**把插件 tag
加进 `SOURCE_PREFERENCE_ORDER` —— 那与 `b09ac518` 的团队决策冲突（同版本时 cli 必须赢）。也就是说
审计最后那句"不要把 tie-break 当成宿主隔离方案"被保留为硬约束：排序只保证**选择稳定**，不表达宿主
语义，任何依赖"哪个 bundle 赢"来决定宿主行为的代码都是错的。

**（d）一处 vestigial，未处理。** `isClaudePluginBuild()` 余下的两个消费者（`McpTools.ts` 的
`isClaudePlugin` 字段、`StatusCommand.ts`）最终都流向 `resolveClaudeHookActive(status, _isClaudePlugin)`,
而该函数**已经忽略这个参数**（保留只为调用点稳定）。对 Codex 而言返回 `false` 恰好也是对的（Codex 没有
agent hook），所以功能上无需改动；但这个字段名有误导性，属于独立的清理项，不在本次范围内。

### 4.4 Dispatcher 可能被旧插件降级

`installHookScripts()` 会更新 machine-global：

```text
resolve-dist-path
run-hook
run-cli
```

原子写入可以防止半文件，但当前 launcher 没有 schema/core version 的单调更新规则。若较旧插件后启动，它仍可能把新版 dispatcher 重写为旧内容。

**建议：** 给 dispatcher 增加 schema/version header，并拒绝旧 writer 覆盖新版本；或把 launcher 做成独立、稳定、向后兼容的版本化组件。

### 4.5 Uninstall 缺少 source ownership

当前完整卸载会直接执行：

```ts
await removeGitHook(projectDir);
await removePostRewriteHook(projectDir);
await removePrepareMsgHook(projectDir);
await removePostMergeHook(projectDir);
await removePrePushHook(projectDir);
```

没有检查 Claude/Codex/CLI/IDE 是否仍有有效 source 依赖这些 Hook。于是卸载 Claude Plugin 可能破坏 Codex Plugin，反之亦然。

**建议：**

- 建立 source lease/refcount；
- Plugin uninstall 只移除自己的宿主资产和 `dist-paths/<source>`；
- 仅最后一个有效 source 离开时移除共享 Git Hooks；
- repo-wide manual disable 可保留“强制拆除全部共享 repo hooks”的独立语义。

### 4.6 Session/config 并发丢更新

`SessionTracker.ts` 的 `saveSession()` 与 `saveConfigScoped()` 都是：

```text
读取当前 JSON → 内存合并 → atomicWrite
```

atomic write 只能防止文件撕裂，不能防止两个进程读取同一旧版本后互相覆盖。两个 SessionStart 同时触发时，Claude session 和 Codex session 可能只留下后写入者；全局配置也存在同类问题。

**建议：** 为 sessions/config 分别增加专用锁，并在获得锁后重新读取、合并、写入。不要复用 repo hooks lock，以免扩大临界区或破坏现有锁顺序。

## 5. 推荐架构

```text
Claude SessionStart                  Codex SessionStart
        │                                  │
        ▼                                  ▼
runClaudePluginBootstrap()       runCodexPluginBootstrap()
        │                                  │
        ├─ .claude menu/hooks              ├─ Codex context
        ├─ Claude session                  ├─ Codex session/discovery
        └─ Claude reminders                └─ no .claude writes
                 │                         │
                 └──────────┬──────────────┘
                            ▼
              reconcileSharedRepoRuntime()
                            │
              ├─ respect manuallyDisabled
              ├─ register source runtime
              ├─ update versioned dispatcher
              ├─ initialize .jolli state
              └─ reconcile source-neutral Git Hooks
```

建议的职责边界：

```ts
interface SharedBootstrapOptions {
  projectDir: string;
  sourceTag: "claude-plugin" | "codex-plugin";
  distDir: string;
  automatic: boolean;
}

async function reconcileSharedRepoRuntime(
  options: SharedBootstrapOptions,
): Promise<SharedBootstrapResult>;

async function runClaudePluginBootstrap(...): Promise<ClaudeBootstrapOutput>;
async function runCodexPluginBootstrap(...): Promise<CodexBootstrapOutput>;
```

共享 Core 只处理 source-neutral 资源；Adapter 只处理各自宿主协议与文件。避免继续让 `repoHooksOnly` 这个名称承载隐含 Claude 语义。

## 6. 实施优先级

### P0：Codex Plugin 开发前必须完成

1. 新建 `CodexPluginBootstrapHook.ts`，禁止直接复用现有 Claude Bootstrap。顺带决定它在
   repo 被手动禁用时的拆除语义（见 §4.1.1 末尾的遗留项）。
2. ~~抽取 `reconcileSharedRepoRuntime()`；Codex 路径不得写 `.claude/**`~~ —— **已完成**
   （2026-07-30），但形状与初版设想不同：没有抽出独立函数，而是给 `repoHooksOnly` 模式加了
   宿主参数。理由与分层表见 §4.1.1。
3. ~~移除插件静默设置 machine-global provider 的行为~~ —— **已完成**（2026-07-30）：seeding
   的值按 source tag 取，自动路径先到先得，`/jolli:init` 显式覆盖。见 §4.2。
   Codex Plugin 的 bootstrap 必须以 `codex-plugin` 作为 source tag 走同一条路径，
   **不要**新写一份 seeding；它的 init recipe 必须显式传 `--source-tag codex-plugin`。
4. ~~让共享 runtime 真正 host-neutral；宿主身份由入口显式传递~~ —— **已完成**（2026-07-30）。
   共享 worker 本就没有行为泄漏；真正修掉的是 `PluginLoader` 的发现门禁只认 Claude bundle，以及
   TS/shell 两个 dist-path resolver 的枚举顺序不一致。理由与证据见 §4.3.1。

### P1：双插件公开发布前必须完成

5. dispatcher schema/version 防降级。
6. source lease/refcount 与 source-aware uninstall。
7. sessions/config 专用锁。
8. 为 Claude/Codex source 增加确定性 resolver 测试。

### P2：强化项

9. 静态插件 Skills 与 canonical builder 做 byte-for-byte 测试。
10. 增加跨版本矩阵：旧 Claude + 新 Codex、新 Claude + 旧 Codex、同版本、不同版本。
11. 在多个 worktree 同时触发两个 SessionStart，验证锁超时、延期与最终收敛。

## 7. 最小测试矩阵

| 场景 | 预期结果 |
|---|---|
| Claude Bootstrap 先运行，Codex 后运行 | 两套宿主入口正常；共享 Hook 不重复；Codex 不��� `.claude/**` |
| Codex 先运行，Claude 后运行 | 同上；Claude 资产正常安装 |
| 两者同一时刻运行 | repo/runtime 锁串行化；sessions 均保留；没有丢配置 |
| 两插件同 core version | resolver 结果确定；共享 worker 不依赖 winner 的宿主身份 |
| 两插件 core version 不同 | 选最高兼容 runtime；dispatcher 不被旧插件降级 |
| 卸载 Claude Plugin | Codex source/runtime/共享 Git Hooks 继续可用 |
| 卸载 Codex Plugin | Claude source/runtime/共享 Git Hooks 继续可用 |
| 最后一个 source 卸载 | 共享 Hook 按设计移除 |
| repo 已 `manuallyDisabled` | 两个自动 Bootstrap 都不重新安装 Git Hooks；provider 也是零写入 |
| 同名非 Jolli Skill 已存在 | 两个插件均不覆盖用户内容 |
| Claude SessionStart 先跑，Codex SessionStart 后跑 | `localAgentTool` 停在 `claude-code`，Codex 的自动路径不改它（防拉锯） |
| 上一条之后在 Codex 里跑 `$jolli:init` | `localAgentTool` 变成 `codex`；`aiProvider` 不变 |
| 用户已选 `aiProvider=jolli`，在任一宿主跑 init | `aiProvider` 保持 `jolli`；只记下该宿主的 tool（provider 非 local-agent 时该值是惰性的） |

## 8. 最终判断

- **不会因为两个 Bootstrap 同时启动就天然把 Git Hook 写坏。** 当前锁和幂等机制已经覆盖了大部分文件级竞争。
- **会发生产品语义和生命周期冲突。** Claude Bootstrap 的 `.claude/**` 副作用、runtime winner
  和 uninstall 仍未完成双宿主隔离；全局 provider 这一条已于 2026-07-30 修复（§4.2）。
- **最关键的设计原则是：共享资源 source-neutral，宿主行为 host-scoped，卸载按 source ownership。**
  provider 那条修复是这条原则的一个特例：值本身仍是全局单值，但**取值来源**变成了显式传入的
  宿主 source tag，而不是共享 runtime 的编译期身份。
- 在完成剩余 P0 改造（第 1、2、4 条）前，不建议让 Codex Plugin 调用现有
  `PluginBootstrapHook` 或 `install(..., { repoHooksOnly: true })`。
