# Jolli Memory

> *Every commit deserves a Memory. Every memory deserves a Recall.*

**Jolli Memory** automatically turns your AI coding sessions into structured development documentation attached to every commit, without any extra effort.

When you work with AI agents like Claude Code, Codex, Gemini, Cursor, Copilot, Cline, Devin, OpenCode, or Antigravity, the reasoning behind every decision lives in the conversation: *why this approach was chosen, what alternatives were considered, what problems came up along the way*. The moment you commit, that context is gone. Jolli Memory captures it automatically.

---

## Installation

Install from the [JetBrains Marketplace](https://plugins.jetbrains.com/): open **Settings > Plugins > Marketplace**, search for **Jolli Memory**, and click **Install**. Restart the IDE when prompted (the plugin requires a restart; it does not support dynamic unloading).

Then open the **Jolli Memory** tool window from the right sidebar and follow the onboarding panel.

### Requirements

- **A JetBrains IDE on 2025.1 or newer** (build 251 through 262.\*). Works in any IDE on the platform, not just IDEA: the plugin depends only on the core platform and Git4Idea.
- **Node.js 22.13 or newer on your `PATH`.** The plugin drives the bundled Jolli CLI for storage, MCP registration, and the `jolli-recall` / `jolli-search` skills. 22.13 is the release where Node's built-in `node:sqlite` loads without an extra startup flag — the CLI reads AI session databases (OpenCode, Cursor Composer, GitHub Copilot, Devin, Antigravity) through it, and the git hooks the plugin installs deliberately pass no flags. Below that floor there is no degraded mode: the tool window shows the versions it found and stays blocked until a newer Node is available.
- **An Anthropic API key, a Jolli account, or a locally-installed agent CLI** for summary generation. The Local Agent provider drives that CLI on its own subscription login, so it needs no key. With none of the three, hooks still record session metadata but no summary is written.
- **GitHub CLI (`gh`)** only for **Create & Update PR**.

Building from source instead? See [DEVELOPMENT.md](DEVELOPMENT.md).

---

## What it does

After each commit, Jolli Memory reads your selected AI session transcripts and the code diff, calls the LLM to produce a structured summary, and stores it alongside the commit silently in the background. The IntelliJ plugin surfaces everything in a tool window so you can manage plans, stage files, write AI-assisted commit messages, review summaries, and share them, without leaving your IDE.

### The tool window

The tool window (right sidebar, titled **JOLLI MEMORY**) opens on a **Current Branch / Memory Bank** view switch.

**Current Branch** is a stack of three collapsible sections:

| Section | What it shows |
| -- | -- |
| **PINNED** | Memories you have pinned for quick access. Sizes to its content rather than taking an equal share of the panel. |
| **WORKING MEMORY** | Everything feeding the *next* commit's memory, folded into one section: **Conversations** (recent AI sessions across every supported tool), **Context** (auto-detected Claude Code plans, your own notes, and issue references from the conversation), and **Files** (changed files with staging checkboxes). Each sub-list caps at 6 rows with a "Show N more" expander. |
| **COMMITTED MEMORIES** | Every commit on the current branch not yet in main. Click one to open its full summary. Multi-select to squash. Switches to a read-only mode for branches already merged. |

**Memory Bank** is a cross-branch, cross-repo browser of every stored memory on disk, with **Tree** and **Timeline** modes, a search box (Timeline mode), a **Build Knowledge Wiki** action, and per-memory actions.

Two more surfaces sit outside the accordion: a **Status** card (hook state, active sessions, stored-memory counts, connected Jolli Site, detected integrations) toggled from the **Status** icon in the tool window's title bar, and an **onboarding** card shown until the plugin is configured, offering three ways to start: sign in to Jolli, paste an Anthropic API key, or pick a local agent CLI (Claude Code, Codex, Cursor, OpenCode, or Kimi Code) and drive it with its own login, which needs no API key at all. A dismissible **backfill** card appears at the top of the stack when you enable Jolli in a repo that already has history.

---

## How it works

Jolli Memory runs in the background using two kinds of hooks. You don't need to do anything special.

### AI agent sources: knowing which sessions are active

Twelve transcript sources are supported. Only two of them install a hook; the rest are discovered by scanning the tool's own local session store, so there is nothing to configure per tool.

| Agent | How sessions are tracked |
| -- | -- |
| **Claude Code** | A lightweight `StopHook` fires after each AI response; a `SessionStartHook` injects a mini-briefing at session start |
| **Gemini** | An `AfterAgent` hook fires after each agent completion |
| **Codex** | No hook needed, sessions are discovered by scanning the filesystem |
| **OpenCode** | No hook needed, discovered by reading OpenCode's local SQLite database |
| **Cursor** | No hook needed, covers both the Composer IDE (SQLite stores) and the `cursor-agent` CLI (plaintext session store) |
| **GitHub Copilot** | No hook needed, covers both the Copilot CLI session store and VS Code Copilot Chat's workspace storage |
| **Cline** | No hook needed, covers both the VS Code extension's task store and the Cline CLI's session files |
| **Devin CLI** | No hook needed, discovered from Devin's local SQLite database, scoped by working directory |
| **Antigravity** | No hook needed, discovered from its per-conversation SQLite plus the sibling plaintext transcript log |

Gemini's hook records only a session ID and file path. Claude's hook also scans the transcript as you work, to pick up plan files and issue references. The scan-based sources read transcript content too, at commit time to build the summary and on the sidebar's refresh to title recent conversations. All of that is local; see [Privacy](#privacy) for what is sent when a memory is generated.

The plugin's **Settings > AI Agents** tab exposes nine toggles, one per source: Claude Code, Codex, Gemini, OpenCode, Cursor IDE, Devin, GitHub Copilot, Cline, and Antigravity. Three of them cover a pair of sources each: Cursor covers the Composer IDE and the `cursor-agent` CLI, Copilot covers the CLI and VS Code Chat, and Cline covers the CLI and the VS Code extension.

### Git hooks: generating summaries on commit

Enabling Jolli installs standard git hooks that handle the rest:

1. **Before the commit** (`prepare-commit-msg`): detects a squash so existing memories can be consolidated rather than regenerated
2. **After the commit** (`post-commit`): enqueues the operation and spawns a background worker that reads the AI conversation and code diff, calls the LLM, and writes the summary. **Your commit returns instantly**; the summary lands about 10 to 20 seconds later
3. **After rebase or amend** (`post-rewrite`): migrates existing summaries onto the new commit hashes, so nothing is lost
4. **After merge or pull** (`post-merge`): folds newly arrived memories into the knowledge wiki
5. **Before push** (`pre-push`): syncs memories, and never blocks the push if it fails

By default every memory is **dual-written**: to the git orphan branch `jollimemory/summaries/v3` (the source of truth, completely separate from your code history) **and** to the **Memory Bank** folder on disk, which keeps a plain-Markdown copy you can read, `grep`, or pipe into other tools without going through the plugin. Raw AI conversations are dual-written the same way and can be viewed, edited, or deleted from the plugin.

**Worktree-aware:** hooks and summaries work across `git worktree` checkouts.

---

## Features

### AI Commit

Click the sparkle button in the Changes toolbar to generate a commit message from your staged changes. The LLM produces a focused one-line message; a dialog lets you review and edit it before committing.

### Push

Click Push to push the branch. If the push is rejected, a Force Push option is offered with a confirmation step.

### Squash

Select two or more memories, then click Squash. Squash is a deliberate two-step action: the first click enters squash mode so checkboxes appear, and the second runs the squash on what you picked. That guard exists because consolidating memories is irreversible.

The LLM generates the combined commit message from the topics and decisions captured in each commit's memory. The memories themselves are then consolidated by a second LLM call that produces one rich summary preserving decision detail from every source commit; a mechanical merge remains as the fallback when that call fails (offline, quota exhausted), so squash never silently drops memories.

### Summary Viewer

Click any commit to open a full memory panel. It shows:

* **Properties**: commit hash, branch, author, date, duration (working days), conversation count, and code change stats
* **Plans & Notes**: associated plans and notes with edit, remove, and add actions
* **Issue, page & conversation references**: Linear, Jira, GitHub, Notion, Slack, Confluence, Asana, monday.com and Zoom (meetings and docs) items referenced in the AI conversation are extracted and rendered as first-class items with a deep link back to the source, alongside Context7 library-documentation lookups and Jolli's own memory lookups. They follow the commit through squash and rebase the same way plans and notes do. Extraction is **Claude Code and Codex only** — every other agent's transcript format discards the tool calls this reads
* **E2E Test Guide**: AI-generated test scenarios with preconditions, steps, and expected results
* **Source Commits** (for squash/amend): all contributing commits with diff stats and conversation counts
* **Summaries**: each topic structured as ⚡ **Why This Change** → 💡 **Decisions Behind the Code** → ✅ **What Was Implemented**

Action buttons: **Copy Markdown**, **Share in Jolli**, and **Create & Update PR**.

### Create & Update PR

Opens a dedicated **Create PR** editor tab where you can review and edit the generated PR before it is opened.

* **Create PR** pre-fills the description from your branch's memories: a Jolli Memory URL, plans, an E2E test guide, and a topic-by-topic summary. It deliberately omits anything already visible on the GitHub PR page.
* **Update PR** refreshes the summary section in place between the `<!-- jollimemory-summary-start -->` and `<!-- jollimemory-summary-end -->` markers, without touching text you wrote by hand.

Requires the `gh` CLI, installed and authenticated.

### Share in Jolli Space

Click **Share in Jolli** to publish the summary to your team's Jolli Space knowledge base, so teammates and your other devices can recall it. Plans and notes are uploaded as separate articles first so their URLs appear in the summary; the summary is published last. When token usage was recorded for a memory, the shared copy carries a **Task usage** line: total tokens, a cost estimate, and the input / output / cached split, aggregated across squashed and amended commits.

Requires a Jolli account (**Sign In to Jolli**) or a manually configured Jolli API Key.

### Memory Bank

Every repo gets a plain-Markdown copy of every memory on disk, alongside the canonical orphan-branch copy. The **Memory Bank** view browses it across branches and repos, in **Tree** or **Timeline** mode.

Set the folder location under **Settings > Memory Bank**. Existing memories on the orphan branch are migrated into it for you.

### Knowledge wiki

The **Build Knowledge Wiki** action in the Memory Bank toolbar folds work scattered across many commits into per-topic pages, so a feature touched by ten commits reads as one evolving page instead of ten disconnected entries. A browsable `_wiki/` folder is written into your Memory Bank, and the same topic pages back the MCP server's search and decision-timeline tools. Requires a Jolli sign-in or an Anthropic API key.

You rarely need to click it: the wiki is folded forward incrementally in the background after each commit. The knowledge **graph** visualization is not yet available in the IntelliJ plugin; export one from the CLI with `jolli graph` or use the VS Code extension.

### Backfill

Enabling Jolli in a repo that already has commits offers to write memories for that existing history, so your past work shows up too. Dismissing the card is remembered.

### Memory Bank sync

A status-bar widget reports cross-device sync state for your personal Memory Bank, so you can see at a glance whether the last round succeeded, is in flight, hit conflicts, or is offline.

### Sign In to Jolli

Open **Settings > Tools > Jolli Memory** (or click the Sign In button in the tool window banner) and click **Sign In**. The plugin opens your browser at the Jolli sign-in page and listens for the OAuth callback locally. It then stores an `authToken` and a `jolliApiKey` (`sk-jol-…`) in `~/.jolli/jollimemory/config.json`, the same file the CLI and the VS Code extension use, so signing in once works for every surface.

The `jolliApiKey` covers two flows: it lets the Jolli LLM proxy handle summary generation (so you don't need to manage an Anthropic key), and it authorises pushing summaries to your Jolli Space. A manual Anthropic API key takes precedence when no provider is pinned; explicitly choosing **Jolli** or **Local Agent** in Settings > AI Summary routes summaries there regardless.

### Plans & Notes

Jolli Memory auto-detects Claude Code plan files from your session transcripts and shows them in **WORKING MEMORY**. You can also add your own notes, either short text snippets or imported Markdown files, to capture context that doesn't live in the AI conversation. When you commit, active plans and notes are archived as snapshots in the orphan branch and associated with the commit.

Add items with the **+ Add** button (**Add Plan** from `~/.claude/plans/`, **Add Markdown File**, or **Add Text Snippet**). From the Summary Viewer you can preview, edit inline, remove an association, or associate additional items.

---

## Use your memory from your AI agent (MCP)

When you enable Jolli in a repo, the bundled CLI also registers a `jollimemory` **MCP server** into every AI host it detects: Claude Code and Cursor per-repo (via `.mcp.json` and `.cursor/mcp.json`), and Gemini, Codex, OpenCode, Copilot CLI, VS Code Copilot Chat, Cline, Devin and Antigravity machine-wide. Ten hosts in total. Restart your agent afterward so it picks up the server.

Ten tools are exposed: `search`, `recall`, `get_decision_timeline`, `list_branches`, `get_pr_description`, `queue_status`, `status`, plus `bind_space`, `list_spaces` and `push_memory` for Jolli Space. When you are signed in, your Jolli tenant's own platform tools are surfaced alongside them; turn that off with `mcpPlatformToolsEnabled=false`. You never call these by name; you ask a question and the agent picks the tool.

The server itself is a local stdio process your agent spawns. The seven memory tools answer entirely from local storage, so your memories are never uploaded to be queried. The three Jolli Space tools, and any tenant platform tools, do call your Jolli tenant, as their names imply.

The plugin detects a stale MCP registration (one pointing at a build that no longer exists) and repairs it on startup.

## Session Context Recall

Jolli Memory feeds prior development context back into your AI agent so it can pick up where you (or a teammate) left off.

Five skills are installed when you enable Jolli. The two you will reach for most are **`jolli-recall`** (load a branch's complete history: summaries, plans, decisions, and file-change statistics, default budget 20,000 tokens) and **`jolli-search`** (search across every branch's memories); the others are `jolli-local-run`, `jolli-remote-run`, and the `jolli` umbrella menu. If the current branch has no memories, recall shows a catalog of branches that do.

From the tool window's overflow menu, **Recall in Claude Code** and **Copy recall prompt for other tools** both put the recall prompt on your clipboard to paste into your agent. Individual memories have their own **Copy recall prompt** action.

---

## Configuration

Settings live in two places, and both write to `~/.jolli/jollimemory/config.json`, shared with `@jolli.ai/cli` and the VS Code extension.

**In the tool window** (gear icon), a five-tab dialog:

| Tab | What it controls |
| -- | -- |
| **AI Agents** | A toggle per source (Claude Code, Codex, Gemini, OpenCode, Cursor IDE, Devin, GitHub Copilot, Cline, Antigravity), plus a **Global Instructions** toggle that controls whether Jolli adds its "prefer these skills" note to your machine-global AI instruction files (`~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`). Off until you turn it on; turning it off removes the note. |
| **AI Summary** | **Provider** selector (Anthropic / Jolli / Local Agent). The Anthropic card adds the API key, model, and max-output-tokens; the Jolli card shows sign-in state; the Local Agent card picks which locally-installed AI CLI to drive (**Claude Code**, **Codex**, **Cursor**, **OpenCode**, or **Kimi Code**), using that tool's own subscription login, so no API key is needed. |
| **Sync to Jolli** | Sign-in state for pushing memories to your Jolli Space, plus a per-repository **Push this repository's memories to Jolli** toggle. Turning it off keeps capturing memory locally while blocking outbound sync for this repo. |
| **Memory Bank** | The on-disk folder path and sort order for your Markdown copies. |
| **Others** | Exclude patterns for the Changes list, commit options, telemetry, privacy, and a **Pause** switch that temporarily disables hooks without losing configuration. |

**Under Settings > Tools > Jolli Memory**: account sign-in/out, Anthropic API Key, Model, Jolli API Key, and Slack Workspace URL (used to build deep links for captured Slack thread references).

| Field | Type | Default | Description |
| -- | -- | -- | -- |
| `apiKey` | string | `$ANTHROPIC_API_KEY` | Your Anthropic API key for AI summarization (generate one at [platform.claude.com](https://platform.claude.com/)) |
| `model` | string | `claude-sonnet-4-6` | Model used for summarization. Accepts an alias (`sonnet`, `haiku`) or a full model ID. |
| `jolliApiKey` | string | — | Jolli Space API key. Auto-managed when you use **Sign In to Jolli**. |
| `authToken` | string | — | OAuth auth token set automatically by **Sign In to Jolli**, not edited manually. |
| `localFolder` | string | — | Memory Bank root on disk, where every memory is dual-written as Markdown. Written by Settings > Memory Bank, and shared verbatim with the CLI and the VS Code extension. (Configs from older IntelliJ builds used `knowledgeBasePath`; it is still read once, then migrated.) |
| `knowledgeBaseSort` | enum | `date` | Sort order for the Memory Bank tree: `date` or `name`. |
| `slack.workspaceUrl` | string | — | Your Slack workspace URL, used to build deep links for captured Slack references. |

---

## Privacy

**Read locally.** Gemini's hook records only a session ID and file path. Claude's hook also scans the transcript as you work, to pick up plan files and issue references. The scan-based sources read transcript content too: at commit time to build the summary, and on the sidebar's refresh to title your recent conversations. All of that happens on your machine.

**Sent when a memory is generated.** Writing a summary is an LLM call, so at commit time the transcript slice for that commit and the diff go to whichever provider you configured: Anthropic directly, the Jolli LLM proxy, or a local agent CLI. The Jolli proxy holds the payload in memory for the request only and never persists or logs it.

**Never sent to a team Jolli Space.** Sharing a memory uploads the summary and its plans and notes, not the raw transcript. Mirroring transcripts into your own personal space is a separate opt-in (`syncTranscripts`), off by default.

See the [root README](../README.md#how-it-works) and [`SECURITY.md`](../SECURITY.md) for the full picture.
