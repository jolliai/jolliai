# Claude Code 插件 Marketplace 提交指南

> 面向 Jolli 插件（`claude-plugin/`）的提交参考。整理自 Claude Code 官方文档
> [Create plugins → Submit your plugin to the community marketplace](https://code.claude.com/docs/en/plugins#submit-your-plugin-to-the-community-marketplace)。
> 最后核对：2026-07-20。

---

## 1. 两个官方 Marketplace 的定位

Anthropic 维护两个公共的 Claude Code 插件市场，定位完全不同：

| Marketplace | 定位 | 谁来收录 | 用户添加 / 安装方式 |
|---|---|---|---|
| **`claude-plugins-official`** | Anthropic **精选（curated）** 的一组插件 | 由 Anthropic 自行策展、自行决定 | 首次交互式启动 Claude Code 时**自动注册**；非交互脚本需在首次启动前手动执行 `claude plugin marketplace add anthropics/claude-plugins-official` |
| **`claude-community`** | **公共社区市场**，第三方提交经审核后落地 | 任何第三方均可提交，走审核流程 | `/plugin marketplace add anthropics/claude-plugins-community`，安装时用 `@claude-community` 后缀 |

除此之外，你还可以**自托管**一个 marketplace（一个含 `.claude-plugin/marketplace.json` 的 git 仓库），用户通过 `/plugin marketplace add <你的仓库/URL>` 添加。这条路不经过 Anthropic、无审核、你完全自控——Jolli 目前用的就是这种方式（`jolli-plugin-dev/claude-plugin-marketplace`）。三条路互不冲突，可以并存。

---

## 2. 哪个能自行提交、哪个不能

### ✅ `claude-community` —— 可以自行提交申请

官方文档原文：

> "`claude-community`: the public community marketplace where third-party submissions land after review."

第三方提交、经审核后上架。**这是你能主动申请的唯一官方入口。**

### ❌ `claude-plugins-official` —— 无法自行申请

官方文档原文：

> "The official marketplace, `claude-plugins-official`, is curated separately. Anthropic decides which plugins to include at its discretion. **There is no application process, and the submission form does not add plugins to the official marketplace.**"

即：官方精选市场由 Anthropic 单独策展、自行决定收录范围，**没有申请通道**，社区市场的提交表单也**不会**把插件加进官方市场。只能靠产品被官方看中。

> 补充：如果 Anthropic 主动把你的插件收进官方市场，你的 CLI 可以反过来提示用户安装它，见
> [Recommend your plugin from your CLI](https://code.claude.com/docs/en/plugin-hints)。这是"被收录之后"的能力，不是申请入口。

---

## 3. 如何提交到 `claude-community`

### 3.1 需要准备什么

1. **公开的 git 仓库**，包含插件本体。
2. **插件清单** `.claude-plugin/plugin.json`（位于插件根目录）。最小字段：

   ```json
   {
     "name": "jolli",
     "description": "What your plugin does",
     "version": "1.0.0",
     "author": { "name": "jolli.ai" }
   }
   ```

   | 字段 | 说明 |
   |---|---|
   | `name` | 唯一标识，也是 skill 命名空间（如 `/jolli:recall`）；不能有空格 |
   | `description` | 在插件管理器中展示 |
   | `version` | 可选。设了就只有你 bump 时用户才收到更新；不设则用 git commit SHA，每个 commit 都算一次新版本 |
   | `author` / `homepage` / `repository` / `license` / `keywords` | 可选，建议补全 |

   > 目录约定：`skills/`、`agents/`、`hooks/`、`.mcp.json` 等都放在**插件根目录**，**不要**放进 `.claude-plugin/`（里面只放 `plugin.json`）。

3. **`README.md`**：安装与使用说明（强烈建议）。
4. **本地校验通过**（审核流水线跑的是同一个校验，务必先过）：

   ```bash
   claude plugin validate
   ```

### 3.2 提交流程

提交走**站内表单**，不是提 GitHub PR。二选一：

| 入口 | URL | 适用对象 |
|---|---|---|
| **claude.ai** | `https://claude.ai/admin-settings/directory/submissions/plugins/new` | 需 Team/Enterprise 组织 + directory 管理权限（组织 Owner 默认有） |
| **Console** | `https://platform.claude.com/plugins/submit` | 个人作者（不属于 Team/Enterprise 组织）走这个 |

步骤：

1. 本地 `claude plugin validate` 通过。
2. 补齐 `README.md` 与 `plugin.json`。
3. 打开上面任一表单，填写插件名、描述、公开 git 仓库地址、作者/维护者信息。
4. 提交后进入审核：**同一套 `claude plugin validate` 校验 + 自动安全扫描**。
5. 通过后：
   - 插件被 pin 到你仓库的某个 **commit SHA**，写入
     [`anthropics/claude-plugins-community`](https://github.com/anthropics/claude-plugins-community) 目录；
   - 之后你 push 新 commit，**CI 自动 bump** 这个 pin；
   - 公共目录**每晚从审核流水线同步**，所以「审核通过」到「用户可安装」之间有延迟。
6. 验证是否已上架：在
   [community catalog 的 marketplace.json](https://github.com/anthropics/claude-plugins-community/blob/main/.claude-plugin/marketplace.json)
   里搜索你的插件名。

### 3.3 用户安装（提交通过后）

```
/plugin marketplace add anthropics/claude-plugins-community
/plugin install jolli@claude-community
```

---

## 参考链接

- [Create plugins（含 Submit 一节）](https://code.claude.com/docs/en/plugins#submit-your-plugin-to-the-community-marketplace)
- [Discover and install plugins](https://code.claude.com/docs/en/discover-plugins)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Create and distribute a plugin marketplace（自托管）](https://code.claude.com/docs/en/plugin-marketplaces)
- [Recommend your plugin from your CLI](https://code.claude.com/docs/en/plugin-hints)
- 社区目录仓库：<https://github.com/anthropics/claude-plugins-community>
