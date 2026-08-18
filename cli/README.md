# Jolli CLI

The `@jolli.ai/cli` package has two main uses:

## 1. Jolli Memory — automatic AI session summaries

Turns your AI coding sessions into structured development documentation attached to every commit, without any extra effort. When you work with AI agents like Claude Code, Codex, Gemini, Antigravity, OpenCode, Cursor IDE (Composer), Cursor CLI (`cursor-agent`), GitHub Copilot CLI, VS Code Copilot Chat, Cline (VS Code extension and CLI), Devin CLI, or Kimi Code, the reasoning behind every decision lives in the conversation: *why this approach was chosen, what alternatives were considered, what problems came up along the way*. The moment you commit, that context is gone. Jolli Memory captures it automatically.

**Why teams pick it:**

- **100% open source** — the CLI, editor integrations, and on-disk memory format are all in the open, so you can inspect how Jolli works end to end.
- **Bring your AI agent and key** — keep using the agent you already like, with your own Anthropic key, a Jolli account, or a local agent login depending on your setup.
- **Local-first and private** — memories are written to your repo and Memory Bank on disk first, and you decide if or when anything is synced out.

**What it does:**

- **Automatic capture** — after each commit, reads your AI transcripts + diff, calls the LLM, and stores a structured summary alongside the commit. The commit returns instantly; the summary is generated in a detached background process (~10–20 s).
- **Catch up on existing history** — `jolli backfill` creates memories for commits you made before enabling Jolli.
- **Eleven supported agents** — Claude Code, Codex, Gemini CLI, Antigravity, OpenCode, Cursor (Composer IDE + `cursor-agent` CLI), GitHub Copilot CLI, VS Code Copilot Chat, Cline (CLI + VS Code), Devin CLI, and Kimi Code.
- **Dual storage** — every memory is written to a dedicated git orphan branch (`jollimemory/summaries/v3`, the source of truth) **and** to a human-browsable Memory Bank folder on disk (canonical JSON + Markdown).
- **Worktree-aware** — hooks and summaries work across `git worktree` checkouts.
- **Squash / amend / rebase safe** — a unified operation queue migrates or consolidates summaries when commits are rewritten, so memories are never lost.
- **Session context recall** — `jolli recall` (or the `/jolli-recall` skill) loads complete branch history back into your AI agent so it can pick up where you left off. A lightweight briefing is also injected at the start of every Claude Code session.
- **Cross-branch search** — `jolli search <keyword>` ranks every branch's memories with BM25 and returns the best-matching hits in a single pass.
- **MCP server for AI agents** — `jolli mcp` exposes your history to Claude Code (and any MCP-aware agent) so it can search memories, recall a branch, and trace a decision's history without leaving the chat. Registered automatically on `jolli enable`.
- **Knowledge wiki** — `jolli compile` folds the work scattered across many commits into per-topic pages and a browsable `_wiki/` folder in your Memory Bank. It rebuilds when you ask (a command, a dashboard button, or a sidebar button), and both the dashboard and the sidebar tell you how far behind it is; set `wikiRebuild=auto` to have it keep up after every commit instead.
- **Knowledge graph** — `jolli graph` exports the wiki's topics as an interactive, self-contained HTML map of categories, knowledge units, and the typed links between them. Built incrementally alongside the wiki, so it refreshes whenever the wiki does.
- **Issue, page & conversation references** — Linear, Jira, GitHub, Notion, Slack, Zoom, Confluence, Asana, and monday.com items mentioned in your AI conversations are captured and attached to the relevant memory, along with context7 library-documentation lookups, Vercel deployments, Figma design files, Sentry issues, and Jolli's own memory lookups (`recall` / `search` / `get_decision_timeline` — the question asked is recorded, never the memory that came back). Fifteen sources in all. Vercel, Figma, and Sentry are **track-only** — archived, displayed, and shared like any other reference but never fed to the model that writes the memory, because a failed build or a stacktrace is the *input* to the work and would read as a reason for the change. **Claude Code, Codex, and Kimi Code only:** every other supported agent's transcript format discards the tool calls this reads, so references are simply never captured there. Kimi Code covers a subset today — **Linear, GitHub, context7, Vercel, Figma, Sentry, and Jolli's own lookups**; the remaining sources are recognised by the tool names Claude's first-party connectors use, which a Kimi install does not produce.
- **Skill usage** — the agent skills entered while doing the work are captured alongside plans, notes, and references, with their token cost and the commit they belong to. **Claude Code, OpenCode, and Kimi Code** expose a real skill tool, so *which* skills ran is observed rather than guessed on all three — but the token figure only comes with it on **Claude Code** and **OpenCode**; Kimi's transcript carries no usage data, so its rows show no token cost. **Codex** has no skill tool at all (its only signal is a shell command reading a `SKILL.md`), so its rows are flagged as heuristic and likewise carry no token figure. Every other supported agent reports nothing, for one of two reasons: Gemini, Antigravity, Cline, and Devin CLI have no skill concept on disk at all, while Cursor and GitHub Copilot CLI do ship skills but leave no record of *entering* one in anything they write to disk.
- **Per-repo push control** — `jolli push-control` decides whether *this* repo's memories are pushed to a Jolli Space. Capture keeps running locally either way, and memory retained while pushing was off is synced when you turn it back on.
- **Privacy-first** — transcripts and diff go straight to Anthropic (with your `apiKey`) or via the Jolli LLM proxy (in-memory, never persisted). Raw transcripts are never included when you share a memory to a team Jolli Space; mirroring them into your own personal space is a separate opt-in (`syncTranscripts`), off by default.

Jump to: [Jolli Memory](#jolli-memory) · [How It Works](#how-it-works) · [Installation](#installation) · [CLI Commands](#cli-commands) · [Session Context Recall](#session-context-recall) · [Configuration](#configuration) · [Privacy](#privacy)

## 2. Jolli Site — documentation site generation

Turns a plain folder of Markdown files and OpenAPI specs into a polished documentation site with a single command. Designed for product or API documentation alongside your code.

> **Ships as a separate plugin.** Site generation lives in the `@jolli.ai/site-cli` package, not the core CLI. Install it with `npm install -g @jolli.ai/site-cli` and the host CLI discovers it automatically. Until it's installed, `jolli --help` still lists the site commands and running one prints a short install hint.

**What it does:**

- **Zero-config scaffolding** — `jolli new my-docs` creates a starter `Content_Folder` plus a `site.json` configuration file.
- **Hot-reload dev server** — `jolli dev` watches your content and re-syncs Markdown, MDX, and OpenAPI changes instantly via Next.js HMR.
- **Static builds with full-text search** — `jolli build` ships a Pagefind-indexed static site; `jolli start` builds + serves it locally.
- **OpenAPI rich pipeline** — each endpoint compiles into a per-endpoint MDX page with auto-generated cURL / JavaScript / TypeScript / Python / Go code samples (no `swagger-ui-react` runtime).
- **Theme packs** — choose `forge` (clean developer docs, sidebar-first, the default), `atlas` (editorial, dark serif), or `default`. Customize `accentHue`, fonts, logos, and default theme mode in `site.json`.
- **Header / footer / sidebar config** — `header.items` supports per-item dropdowns; `footer` supports copyright, link columns, and social icons; `sidebar` overrides folder labels.
- **Docusaurus migration** — `jolli convert` rewrites an existing Docusaurus folder to Jolli-compatible structure (with a timestamped backup when converting in-place).

Jump to: [Jolli Sites](#jolli-site--documentation-from-your-content-folder) · [`site.json` reference](#sitejson-reference) · [examples/](examples/)

---

## Use Jolli with your AI agent

Coding agents read your development history over MCP. Setup is two commands:

```bash
npm install -g @jolli.ai/cli
jolli enable            # run from your project root
```

`jolli enable` auto-registers a local MCP server named `jollimemory` into every AI host it detects on your machine — eleven of them: Claude Code, Cursor, Gemini, Antigravity, Codex, OpenCode, GitHub Copilot CLI, VS Code Copilot Chat, Cline (the VS Code extension), Devin CLI, and Kimi Code. A host qualifies by being **installed on disk**, which is deliberately a weaker test than "Jolli can read its conversations" — a host whose session store this runtime can't open still gets the MCP server. MCP registration is automatic: nothing to opt into, and no separate MCP install. Restart your agent afterward so it picks up the new server.

**CLI-hosted, not remote.** Jolli's MCP server is a local stdio process (`jolli mcp`) that each host spawns on your own machine. There is no remote URL and no `.well-known/mcp.json` to point a cloud MCP client at, and your memories never leave your machine to be queried.

**Tools your agent gets** (invoked in plain language, never called by name): `recall` and `search` (load or search your history), `get_decision_timeline`, `list_branches`, `get_pr_description`, `queue_status`, `status`, plus `bind_space`, `list_spaces`, and `push_memory` for Jolli Space.

`@jolli.ai/space-cli` is optional and only needed for git-backed local workflow runs; it is not required for MCP.

**Full onboarding docs:**

- [Getting Started with Jolli Memory](https://docs.jolli.ai/jolli-memory/getting-started-with-jolli-memory) - install, enable, and your first memory.
- [Connect Memory to Your AI Assistant (MCP)](https://docs.jolli.ai/jolli-memory/use-your-memory-from-any-ai-assistant-mcp) - the full per-host MCP setup.

## Jolli Memory

## How It Works

After each commit, Jolli Memory reads your AI session transcripts and the code diff, calls the LLM to produce a structured summary, and stores it alongside the commit silently in the background. Your commit returns instantly — the summary is generated in the background (~10-20 seconds).

Jolli Memory runs entirely in the background using two types of hooks:

### AI Agent Hooks — knowing which sessions are active

When you use an AI coding agent, Jolli Memory keeps track of your active sessions so it knows where to find conversation context at commit time. Gemini's hook records only a session ID and file path. Claude's hook also scans the transcript as you work, to pick up plan files and issue references. The scan-based sources read transcript content at commit time to build the summary. See [Privacy](#privacy) for what is sent off your machine.

| Agent | How sessions are tracked |
| -- | -- |
| **Claude Code** | A lightweight `StopHook` fires after each AI response; a `SessionStartHook` injects a mini-briefing at session start |
| **Gemini** | An `AfterAgent` hook fires after each agent completion |
| **Antigravity** | No hook needed — sessions are discovered automatically by reading the per-conversation SQLite for the workspace path and the sibling plaintext transcript log for the conversation content |
| **Codex** | No hook needed — sessions are discovered automatically by scanning the filesystem. Linear/Jira/GitHub/Notion/Slack/Zoom/Confluence/Asana/monday.com/Jolli-Memory references in Codex MCP calls are extracted on the VS Code sidebar's 60s polling tick (not at commit time) |
| **OpenCode** | No hook needed — sessions are discovered automatically by reading OpenCode's global SQLite database at `~/.local/share/opencode/opencode.db` (requires Node 22.13+) |
| **Cursor IDE** (Composer) | No hook needed — sessions are discovered automatically by reading Cursor's local SQLite stores (`globalStorage/state.vscdb` plus per-workspace `workspaceStorage/` databases under your platform's Cursor user-data directory) |
| **Cursor CLI** (`cursor-agent`) | No hook needed — sessions are discovered automatically from Cursor's plaintext `~/.cursor` session store (`meta.json` + JSONL); shares the **Cursor** toggle with the Composer IDE |
| **GitHub Copilot CLI** | No hook needed — sessions are discovered automatically by scanning Copilot CLI's session log |
| **VS Code Copilot Chat** | No hook needed — sessions are discovered automatically by reading the Copilot Chat conversation cache |
| **Cline** (CLI + VS Code) | No hook needed — sessions are discovered automatically from Cline's local session store (the CLI's `~/.cline/data` plaintext session files and the VS Code extension's task store) |
| **Devin CLI** | No hook needed — sessions are discovered automatically from Devin's local SQLite database (`~/.local/share/devin/cli/sessions.db`; `%APPDATA%\devin\cli` on Windows), scoped by working directory |
| **Kimi Code** | No hook needed — sessions are discovered automatically from Kimi Code's local session store (`~/.kimi-code/sessions/`), with references (Linear, GitHub, context7, Vercel, Figma, Sentry, and Jolli's own lookups) and skill usage extracted from its `wire.jsonl` transcript |

### Git Hooks — generating summaries on commit

When you run `git commit`, three standard git hooks handle the rest:

1. **Before the commit** (`prepare-commit-msg`): detects if this is a squash operation so existing memories can be merged instead of regenerated
2. **After the commit** (`post-commit`): detects the operation type (commit, amend, squash, cherry-pick, revert), enqueues it, and spawns a background worker that reads the AI conversation + code diff, calls the LLM, and writes the summary
3. **After rebase/amend** (`post-rewrite`): enqueues migration entries so summaries are re-associated with the new commit hashes

Every memory is dual-written to **both** the git orphan branch `jollimemory/summaries/v3` (the source of truth — completely separate from your code history) and the **Memory Bank** folder on disk, so you always have a plain-Markdown copy you can read, `grep`, or pipe into other tools without going through the CLI. The Memory Bank folder has two layers — a hidden `<localFolder>/<repo>/.jolli/summaries/<commitHash>.json` for canonical JSON, and a visible `<localFolder>/<repo>/<branch>/<slug>-<hash8>.md` for human-readable Markdown — and `<localFolder>` is your configured Memory Bank root (one root can hold multiple repos, each in its own `<repo>/` subfolder). Raw AI conversation transcripts are dual-written the same way — to `transcripts/<commitHash>.json` on the orphan branch and to `<localFolder>/<repo>/.jolli/transcripts/<commitHash>.json` in the Memory Bank folder.

**Worktree-aware:** hooks and summaries work across `git worktree` checkouts — each worktree tracks its own current branch and its memories stay consistent.

## Installation

**Requirements** — **Node.js 22.13 or later**. SQLite-backed features (the local dashboard, plus OpenCode/Cursor/Copilot/Devin/Antigravity session discovery) use Node's built-in `node:sqlite`. That module first appears in 22.5 but needs `--experimental-sqlite` until **22.13**, where it loads unflagged — and two surfaces cannot pass a Node flag at all (the VS Code extension host, and the git hooks, which run `node <Hook>.js` deliberately flag-free). So 22.13 is the floor the `engines` field enforces. If you are on Node 18 or 20, please upgrade before installing.

```bash
npm install -g @jolli.ai/cli
```

After installation:

```bash
# Enable Jolli Memory in your project (from the project root)
jolli enable

# Verify installation
jolli status
```

> **Prefer Claude Code or Codex?** Jolli also ships as a **Claude Code plugin** and a **Codex plugin**, each packaging the git hooks, the `jollimemory` MCP server, and the Jolli skills — add one from its plugin marketplace and it installs the same repo hooks (`jolli enable --repo-hooks-only`) without a separate CLI setup. On Codex the MCP tools are registered by the bootstrap rather than the manifest, so they become available from your second session onward. Install surfaces (CLI, VS Code, and the plugins) compete on version, so whichever is newest drives your hooks.

## Quick Start

```bash
# 1. Enable Jolli Memory — you'll be prompted to sign in or enter an API key
jolli enable

# 2. Restart your AI agent for the hooks to take effect

# 3. Work with your AI agent, make commits, then view summaries
jolli view
```

## CLI Commands

### `jolli enable`

Installs all hooks required for automatic summarization:
- **Claude Code Stop hook** in `.claude/settings.local.json` — captures session/transcript info
- **Claude Code SessionStart hook** — injects a mini-briefing at session start
- **Git post-commit hook** — triggers summary generation
- **Git post-rewrite hook** — migrates summaries on amend/rebase
- **Git prepare-commit-msg hook** — detects squash operations
- **Gemini AfterAgent hook** (if Gemini CLI detected) — tracks Gemini sessions
- **MCP server registration** — registers the `jollimemory` MCP server into every AI host Jolli detects (Claude Code and Cursor per-repo; Gemini, Antigravity, Codex, OpenCode, Copilot CLI, Copilot Chat, Cline, and Devin CLI machine-wide) so your agent can query your memories (see [`jolli mcp`](#jolli-mcp))
- **Skill preference** *(opt-in)* — can teach your AI agent to reach for Jolli by default when creating a PR, searching past work, or recalling a branch, by writing to your machine-global instruction files (`~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`). `jolli enable` no longer prompts — it only applies a decision you've already made. Turn it on with `jolli configure --set globalInstructions=enabled` (or the editor toggle); it stays off until you do.

```bash
jolli enable
```

### `jolli disable`

Removes all Jolli Memory hooks. Existing summaries are preserved in the orphan branch.

```bash
jolli disable
```

### `jolli uninstall`

Machine-wide cleanup: finds and removes Jolli Memory installs and configuration across surfaces — VS Code–family extensions (including forks like Cursor, Windsurf, VSCodium), JetBrains/Android Studio plugins, the global `@jolli.ai/cli` package and `jolli` shim, the machine-global `~/.jolli/jollimemory/` and per-project `.jolli/jollimemory/` state, and the current repo's hooks and **repo-scoped** MCP registration. Prints a grouped inventory first and supports interactive selection.

A few shared artifacts are deliberately left in place: **global-scope MCP registrations** (the Gemini / Antigravity / Codex / OpenCode / Copilot CLI / Copilot Chat / Cline / Devin CLI host files) and the **global instruction blocks** in `~/.claude/CLAUDE.md` / `~/.gemini/GEMINI.md` / `~/.codex/AGENTS.md` are shared by every repo on the machine, so removing them during one uninstall would break Jolli for your other repos; and the generated `SKILL.md` files are left untouched because they may sit alongside skills of your own. Remove those by hand if you want a completely bare machine.

Your memories are never touched — the summaries orphan branch and Memory Bank content are excluded by construction.

```bash
jolli uninstall              # preview + interactive selection
jolli uninstall --dry-run    # show what would be removed, change nothing
jolli uninstall --yes --scope all   # remove everything without prompting
```

### `jolli auth`

Manage authentication with your Jolli account. Authentication enables cloud sync and team features.

```bash
# Log in to your Jolli account (opens browser)
jolli auth login

# Show current authentication state
jolli auth status

# Clear stored credentials
jolli auth logout
```

The login flow opens your default browser for OAuth authentication. After completing sign-in, the browser tab closes automatically and the CLI receives your credentials.

**How it works**: The CLI starts a temporary local server on a random available port, opens the browser to the Jolli auth page, and waits for the OAuth callback. On success, the auth token and a `jolliApiKey` (`sk-jol-...`) are automatically generated and stored in `~/.jolli/jollimemory/config.json`. The `jolliApiKey` is used for LLM proxy calls and cloud sync — no manual API key configuration needed.

### `jolli status`

Shows the current installation status, including CLI version, hook state, authentication state, active sessions, supported integrations (Claude, Codex, Gemini, Antigravity, OpenCode, Cursor, Copilot CLI, Copilot Chat, Cline, Devin CLI), Memory Bank state, whether this repo pushes to a Jolli Space, and summary count.

```bash
jolli status
jolli status --json   # machine-readable output
```

### `jolli push-control`

Shows or sets whether **this** repo's memories are pushed to a Jolli Space. Capture is unaffected either way — turning push off keeps recording memories locally and only blocks outbound sync, both automatic and manual. Repos are allowed by default; anything retained while push was off is synced on the repo's next activity after you re-enable it. The VS Code extension exposes the same control for every tracked repo under **Settings → Sync to Jolli**.

```bash
# Show this repo's state
jolli push-control

# Stop sending this repo's memories (they are still recorded locally)
jolli push-control --disable

# Resume, and sync whatever was retained while it was off
jolli push-control --enable

# Machine-readable
jolli push-control --format json
```

If the setting store can't be read, every repo fails closed to **OFF** and the command tells you which file to repair. `--enable` also rebuilds the store, but from an empty set — it drops every repo's opt-out, so repair the file first if you have others turned off.

### `jolli view`

Displays stored commit summaries. Default mode shows a compact list; use `--commit` for full detail.

```bash
# Show a compact list of recent commits (default: 10)
jolli view

# Show the 20 most recent entries
jolli view --count 20

# View full summary for the latest commit (numeric index: 1 = latest)
jolli view --commit 1

# View full summary by commit SHA
jolli view --commit abc123def456

# Export a summary to file
jolli view --commit 1 --output summary.md

# JSON output
jolli view --commit 1 --format json
```

### `jolli export`

Exports every memory on the current branch as Markdown files into `~/Documents/jollimemory/`. Handy for sharing summaries or archiving them outside your git history.

```bash
jolli export
```

One `.md` file is written per commit, named after the commit and its short message.

### `jolli recall`

Recalls development context for a branch. Default output is a **terminal-friendly short summary** (branch name, commit count, topic counts, key decisions, top files); pass `--full` or `--output` to produce full markdown suitable for feeding to an AI agent. Also used by the `/jolli-recall` skill.

```bash
# Short summary for the current branch
jolli recall

# Short summary for a specific branch
jolli recall feature/auth-refactor

# Full markdown context (printed to terminal — can be large)
jolli recall --full

# Full markdown written to a file (implies --full).
# Use any path you like — the file is for sharing, CI archival,
# or feeding to any AI agent. The tool will create parent dirs as needed.
jolli recall --output jollimemory-context.md

# List all recorded branches
jolli recall --catalog

# JSON output for skills/agents — structured RecallPayload, not pre-rendered markdown
jolli recall --format json

# With token budget and JSON output (the payload is trimmed to fit the budget)
jolli recall --budget 30000 --format json
```

`--format json` returns a structured **`RecallPayload`** with discrete fields (`stats`, `plans[]`, `notes[]`, summaries…) so an agent skill can run its own grounded synthesis directly on the data instead of re-parsing a markdown blob. When `--budget` is set, lower-priority fields are trimmed first so the payload fits within the budget without truncating mid-record.

### `jolli search`

Searches stored memories with BM25 ranking (Orama) over the distilled summaries and returns the best-matching hits in a single pass. Each hit carries its `hash`, `branch`, `commitDate`, `slug`, `title`, and a content `snippet`, plus a relevance `score` and a `type` (`topic` or `commit`).

```bash
# Search every branch's memories
jolli search "rate limiter"

# Cap hits, JSON for skills/agents
jolli search "auth refactor" --limit 5 --format json

# Restrict to one branch and one result kind
jolli search "rate limiter" --branch feature/auth --type topic --format json
```

Available flags: `--limit` (max hits, default 20), `--branch` (restrict to one branch), `--type` (`topic` or `commit`), `--format` (`json` default; `text` for terminal-friendly output), `--output`, `--cwd`. With no `--branch`, every branch in the repo is searched.

### `jolli mcp`

Starts a Model Context Protocol (MCP) server over stdio so AI agents can query your memories directly. It exposes ten tools: **search** (full-text search over your historical decisions and implementations), **recall** (load a branch's complete context), **get_decision_timeline** (trace how one decision evolved across commits), **list_branches** (catalog of branches that have memories), **get_pr_description** (build a PR title and description from a branch's memories), **queue_status** (report whether summary generation is still in progress — call before building a PR so fresh commits are included), **status** (installation & configuration health for this repo — hooks, migration state, account/API-key configuration, detected integrations, and stored-memory count, the same data as `jolli status`), **bind_space** (bind this repo to a Jolli Space), **list_spaces** (list the Jolli Spaces you can bind to), and **push_memory** (push a branch's memories to the bound Jolli Space as articles).

```bash
# Start the server (normally launched by your agent, not by hand)
jolli mcp

# Rebuild the local search index from source and exit
jolli mcp --reindex
```

On top of these ten built-in tools, the server also surfaces **platform tools** defined by the Jolli backend (on by default), so a connected agent can act on your Jolli Space directly. Turn them off with `jolli configure --set mcpPlatformToolsEnabled=false`.

`jolli enable` registers this server automatically in your project's `.mcp.json`, so Claude Code picks it up on its next start — no manual setup. The search index is a disposable local cache (never written to the orphan branch); `--reindex` forces a fresh rebuild if you ever want to clear it.

**One server per worktree, not per session.** Each AI session still launches `jolli mcp` the same way, but that process is now a thin forwarder onto a single shared background server per git worktree, so opening several sessions on one checkout no longer loads your memories once per session. The shared server shuts itself down a few minutes after its last session disconnects, and a newer Jolli install takes over from an older one automatically. If a session cannot reach it for any reason it silently serves that session on its own, so nothing depends on the daemon being up. Set `JOLLI_MCP_NO_DAEMON=1` to opt a host out entirely.

### `jolli compile`

Builds your **knowledge wiki**: it ingests the memories that have accumulated across your commits and folds work on the same theme into per-topic pages, so a feature touched by ten commits reads as one evolving page instead of ten disconnected entries. The canonical topic pages are stored alongside your other memories, and a browsable `_wiki/` folder is generated in your Memory Bank. These topic pages also back the MCP server's `search` and `get_decision_timeline` tools.

```bash
# Compile every repo under your Memory Bank folder (the default sweep)
jolli compile

# Compile just one repo
jolli compile --cwd /path/to/repo

# Discard a repo's wiki and replay every source from scratch
jolli compile --cwd /path/to/repo --rebuild
```

**The wiki rebuilds when you ask it to, not after every commit.** Rebuilding costs an AI call per new source, so Jolli leaves the timing to you: commits and merges record what is pending, and you fold it in when it suits. There are three ways to do that — this command, the **Rebuild** button on the dashboard's Knowledge and Graph pages, and the **Build Knowledge Wiki** button in the editor extensions — and all three do the same incremental fold. Both the dashboard and the VS Code sidebar show how far behind you are ("N updates behind · rebuilt X ago") so you don't have to guess. If you'd rather it keep up on its own after every commit, set `jolli configure --set wikiRebuild=auto`. Requires an API key (same as summary generation).

### `jolli graph`

Exports your **knowledge graph** — an interactive visualization of the topics in your knowledge wiki — to a self-contained HTML file you can open in any browser or hand to a teammate. The graph shows your categories, the knowledge units inside each (decisions, mechanisms, fixes), and the typed relationships between them (`extends`, `caused-by`, `supersedes`, `contradicts`, `related-to`). Click a unit to zoom in and surface its related neighbors.

```bash
# Write <repo>-graph.html into a directory
jolli graph --export ./out

# Write to a specific file and open it in the browser
jolli graph --export ./out/graph.html --open

# Target a specific repo
jolli graph --export ./out --cwd /path/to/repo
```

The graph is built right after the knowledge wiki, so it refreshes whenever the wiki does — on a `jolli compile`, a **Rebuild** click, or every commit if you set `wikiRebuild=auto`. Updates are incremental: only topics whose content changed are re-distilled, so it catches up without a full rebuild. It's stored folder-locally (`<localFolder>/<repo>/.jolli/graph/graph.json`) and regenerable, never written to the orphan branch. Run `jolli compile` first if a repo has no graph yet. The editor extensions expose the same visualization via a **View knowledge graph** button.

### `jolli configure`

Manages settings stored in `~/.jolli/jollimemory/config.json`. API keys are masked in the display output.

```bash
# Show all current settings
jolli configure

# List all available config keys with descriptions
jolli configure --list-keys

# Set one or more values (repeat --set as needed)
jolli configure --set apiKey=sk-ant-... --set model=claude-haiku-4-5-20251001

# Set array values (comma-separated)
jolli configure --set excludePatterns=docs/**,*.log,node_modules

# Remove a value
jolli configure --remove jolliApiKey
```

Supported keys: `apiKey`, `aiProvider`, `localAgentTool`, `localAgentPath`, `localAgentModel`, `model`, `maxTokens`, `jolliApiKey`, `authToken`, `claudeEnabled`, `codexEnabled`, `geminiEnabled`, `openCodeEnabled`, `cursorEnabled`, `copilotEnabled`, `clineEnabled`, `devinEnabled`, `antigravityEnabled`, `kimiEnabled`, `globalInstructions`, `mcpPlatformToolsEnabled`, `localFolder`, `logLevel`, `excludePatterns`, `syncTranscripts`, `syncOnPush`, `syncPollIntervalSec`, `slack.workspaceUrl`. `globalInstructions` (`enabled` / `disabled`, unset = undecided) records whether the skill-preference note is written into your machine-global AI instruction files. Setting it to `enabled` writes the block immediately; `disabled` removes it. `jolli enable` never prompts — it only applies the current value (`enabled` → write, `disabled` → remove, unset → no change). `aiProvider` pins the summarization backend (`"anthropic"`, `"jolli"`, or `"local-agent"`); when omitted, the dispatcher falls back to the legacy precedence (`apiKey` > `ANTHROPIC_API_KEY` > `jolliApiKey`). `local-agent` drives a locally-installed AI CLI to generate memories instead of calling an API — `localAgentTool` selects which one (`claude-code` (default), `codex`, `cursor-agent`, `opencode`, or `kimi`) and `localAgentPath` optionally points at the binary when it isn't on your `PATH`. `localAgentModel` pins which model the agent is told to run, for the tools jollimemory pins one for (`claude-code` and `codex` today) — for Claude Code `sonnet` by default, or `haiku` / `opus`; for Codex `gpt-5.6-terra` by default, or `gpt-5.6-luna` / `gpt-5.6-sol` / `gpt-5.5`; and `inherit` on either to send no model flag and run whatever the tool is configured with. The other three tools always inherit. A value the tool in force does not offer falls back to that tool's own default rather than being sent. This is a different setting from `model`, which names an Anthropic API model for the `anthropic` / `jolli` providers and does not reach this one. Two things do differ by tool: only `claude-code` is capability-probed with the real run flags, and `opencode` deliberately keeps your provider credentials in its environment, so it spends your own provider credit. `copilotEnabled` controls both GitHub Copilot CLI and VS Code Copilot Chat as a single switch, and `cursorEnabled` likewise covers both Cursor's Composer IDE and the `cursor-agent` CLI. `clineEnabled`, `devinEnabled`, `antigravityEnabled`, and `kimiEnabled` enable the Cline, Devin CLI, Antigravity, and Kimi Code CLI sources respectively. `mcpPlatformToolsEnabled` (boolean, on by default) controls whether the `jolli mcp` server surfaces the backend-defined platform tools; set it to `false` to expose only the built-in tools. `localFolder` is the Memory Bank root on disk where every memory is dual-written. `syncTranscripts` opts raw transcripts into cloud sync — see [Memory Bank cloud sync](#memory-bank-cloud-sync) below; run a round on demand with `jolli sync-memory-bank`. Run `jolli configure --list-keys` for descriptions and types. Unknown keys and malformed values (e.g. `maxTokens=8192abc`, `logLevel=banana`) are rejected with exit code 1.

### Memory Bank cloud sync

Memory Bank cloud sync keeps your personal Memory Bank consistent across every device you sign in to. The sync engine mints credentials from Jolli, clones a private vault repo, mirrors your Memory Bank folder, and pushes. **Sync is on-demand** — there is no background timer running by default. You trigger a round either way:

```bash
# Sync this repo's Memory Bank with your Personal Space (needs jolliApiKey — sign in with `jolli auth login`)
jolli sync-memory-bank

# Include raw transcripts in this round (overrides syncTranscripts=false)
jolli sync-memory-bank --transcripts
```

…or, in the VS Code extension, click **Sync to Personal Space Now** in Settings. The CLI bundles the same engine (`cli/src/sync/` compiles into `dist/Cli.js` and is inlined into the VS Code extension). The only precondition is a valid `jolliApiKey`. Because the terminal has no diff viewer, the CLI **skips** conflicting files rather than prompting and prints their paths so you can resolve them in your editor.

The vault is an implementation detail; the user-facing surface is an on/off toggle, a "Sync now" button, and a four-state status indicator (`synced` / `syncing` / `conflicts` / `offline`). Conflicts on the four `.jolli/<aggregate>.json` files (manifest, index, branches, catalog) auto-merge deterministically; other-file conflicts run through an AI merge (when `apiKey` is set) and finally a manual binary pick.

### `jolli doctor`

Diagnoses **faults** that impair functionality and (with `--fix`) auto-repairs them. Checks: git hooks installed, Claude/Gemini hooks installed, orphan branch reachable, lock file not stuck, active session count, active git queue not overloaded, API key configured, dist-path resolvable.

```bash
# Run all diagnostic checks
jolli doctor

# Auto-fix failures (release stuck lock, reinstall missing hooks)
jolli doctor --fix

# List the database snapshots you can restore from, then restore one
jolli doctor --recover
jolli doctor --recover --from ~/jolli_back/memory-20260813T020000Z-1a2b3c4d.db

# Print the memory database's migration log — what ran, when, and how it went
jolli doctor --schema-log

# Record one migration as already applied by other means (see --schema-log)
jolli doctor --mark-migration <name>
```

`--schema-log` also flags any migration whose recorded text disagrees with the build you are running. That is a warning, never a refusal: a newer or older database is still opened and written normally. `--mark-migration` exists for the one state that cannot be repaired by re-running — the log lost a row while the change it describes is already in place, so a normal open would try to apply it again and fail. Deleting the database is never the answer; memories rebuild from git, but session usage and recall history have no second copy.

Doctor is deliberately narrow — it only flags conditions that *break* Jolli Memory. Stale-but-harmless data (old sessions, orphan files from amend/squash) is handled by `clean`.

### `jolli clean`

Removes redundant/expired data that accumulates over time but never breaks functionality:

- **Orphan summary files** — after amend/squash, old commits' summary files remain on the orphan branch but their content is already embedded as `children` in the new root's summary
- **Orphan transcript files** — same story for transcripts
- **Stale sessions** — session tracking entries older than 48 hours
- **Stale git queue entries** — older than 7 days
- **Stale squash-pending.json** — older than 48 hours

```bash
# Preview what would be removed (no confirmation, no deletion)
jolli clean --dry-run

# Run interactively — shows a summary, asks to confirm (default: N)
jolli clean

# Skip the confirmation prompt (required in CI / non-interactive shells)
jolli clean --yes
```

**Safety**: in a non-TTY environment (CI, pipes, redirected stdin), `clean` refuses to delete without `--yes` and exits with code 1. This prevents scripts from silently wiping data.

### `jolli heal-folder`

Restores missing Markdown files in the Memory Bank folder by re-rendering them from the canonical hidden JSON (`<localFolder>/<repo>/.jolli/summaries/<hash>.json`). Useful when you (or another tool) accidentally deleted a `.md` file you wanted to keep — the orphan-branch entry and the hidden JSON remain authoritative, so re-rendering brings the visible Markdown back without re-running the LLM.

```bash
# Heal the current repo's Memory Bank folder
jolli heal-folder

# Heal a specific project directory
jolli heal-folder --cwd /path/to/repo
```

Healing is also exposed by the editor extensions; running the CLI form is equivalent.

### `jolli backfill`

Creates memories for commits you made before enabling Jolli, so your existing history shows up too. Each commit is matched to the Claude transcripts recorded around it.

```bash
# Catch up on your recent commits (last 20 by default)
jolli backfill

# Go further back, or cover everything
jolli backfill --last 50
jolli backfill --all

# See what would be matched, without creating anything
jolli backfill --dry-run
```

Claude transcripts for now. Requires an API key (same as summary generation). The editor extensions offer to run this for you when you enable Jolli in a repo that already has commits.

### `jolli dashboard`

Serves a private web dashboard from your machine and opens it in your browser: your memories, per-repo stats, and a standup summary. Everything is served locally from your own data — nothing is uploaded. The command keeps running until you stop it with **Ctrl+C**.

Alongside **My Dashboard** it carries a **Daily Standup**, a **Memories** list, a **Knowledge** view that browses your knowledge wiki page by page, and a **Graph** view that renders the knowledge map in place (no `jolli graph --export` step needed). A repo picker in the topbar switches between the repositories you have registered — there is no separate Repositories page. Tool-usage rows break down per agent, so you can see which agent made which calls, and a list you open with **Show more** stays open across the page's 30-second refresh. When your knowledge wiki has fallen behind, a banner says how far ("N updates behind · rebuilt X ago") and rebuilds it on one click. A **Settings** modal mirrors the editor extensions' five sections — AI Agents, AI Summary, Sync to Jolli, Memory Bank, Others — saved through a single **Apply**; API keys are held server-side and only masked values ever reach the page.

On start-up it also looks back over the last 7 days of your AI agents' own session history, so conversations that were never recorded at the time still show up, and prints one line saying what it picked up.

```bash
# Serve the dashboard and open it in your browser (Ctrl+C to stop)
jolli dashboard

# Print the URL instead of opening a browser (still serves until Ctrl+C)
jolli dashboard --no-open

# Pick a port (default: 1818, then 18118 if taken)
jolli dashboard --port 3000
```

The server lives in this command's own process, so closing the terminal stops it. That also means the command does not return on its own — including with `--no-open` — so a script or CI job that runs it will block until something stops it. Requires Node 22.13+ (it reads a local SQLite database).

Launching it again replaces the dashboard that is already running rather than starting a second one beside it, so you always get a fresh server on the address you expect. Only a Jolli dashboard is ever stopped: an unrelated service holding port 1818 is left alone and the new dashboard moves to 18118 instead.

### `jolli cutover`

Makes a local SQLite database this repo's source of truth instead of the git orphan branch.

```bash
# See where this repo stands, changing nothing
jolli cutover --status

# Perform (or resume) the switch
jolli cutover

# After cutover: check the frozen orphan branch for drift
jolli cutover --probe
```

**This is effectively one-way.** Cutover freezes the repo's orphan branch, and `jolli enable` will not unfreeze it — only an explicit manual path in `jolli doctor` can. Run `--status` first; it reports the current repo only, not a list across repos. `--probe` reports any writer that has moved a frozen branch since cutover (an old client, or an IDE that was never restarted).

## Session Context Recall

Jolli Memory feeds prior development context back into your AI agent so it can pick up where you (or a teammate) left off.

**Automatic briefing** — every time a new Claude Code session starts, a lightweight briefing (~300–500 tokens) is injected into the conversation: branch name, commit count, date range, and last commit message. If it has been more than 3 days since the last commit, it suggests running the full recall command. This runs in under 200 ms and never blocks session startup.

**Full recall** — run `/jolli-recall` inside Claude Code (or any agent that supports it) to load the complete branch history: summaries, plans, decisions, and file-change statistics (default budget ≈ 50,000 tokens; pass `--budget` to adjust). The agent then reports what the branch is implementing, key technical decisions, what was last worked on, and the main files involved — so you can continue without re-reading the code.

If the current branch has no memories, the command shows a catalog of branches that do, letting you pick one to recall. You can also pass a branch name or keyword as an argument (e.g. `/jolli-recall auth-refactor`).

**Targeted search** — run `/jolli-search <keyword>` (or `jolli search <keyword>` from the terminal) to search across every branch's memories. The raw CLI returns BM25-ranked hits (hash, branch, slug, title, snippet) in a single pass.

## Configuration

Settings are stored globally in `~/.jolli/jollimemory/config.json`. The recommended way to manage them is via `jolli configure` — see [the command reference above](#jolli-configure) — which validates keys and types and masks secrets on display.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | string | `$ANTHROPIC_API_KEY` | Anthropic API key for summarization ([get one here](https://platform.anthropic.com/)) |
| `aiProvider` | enum | (auto) | Pin which provider generates summaries: `"anthropic"` (use `apiKey` / `$ANTHROPIC_API_KEY`), `"jolli"` (use `jolliApiKey`), or `"local-agent"` (drive a locally-installed AI CLI). When unset, the resolver falls back to the legacy precedence (`apiKey` → `$ANTHROPIC_API_KEY` → `jolliApiKey`). Each generated summary records the chosen source in its `LlmCallMetadata.source` field (`anthropic-config` / `anthropic-env` / `jolli-proxy` / `local-agent`). |
| `localAgentTool` | enum | `claude-code` | Which local Agent CLI to drive when `aiProvider` is `"local-agent"`: `claude-code`, `codex`, `cursor-agent`, `opencode`, or `kimi`. Only `claude-code` is capability-probed with the real run flags; `opencode` runs on your own provider credentials. Ignored when `aiProvider` is anything else. |
| `localAgentModel` | enum | per tool | Which model the local agent is told to run, for the tools jollimemory pins one for. Claude Code: `haiku`, `sonnet` (default), `opus`. Codex: `gpt-5.6-luna`, `gpt-5.6-terra` (default), `gpt-5.6-sol`, `gpt-5.5`. `inherit` on either sends no model flag, so the tool runs whatever it is configured with — the pre-0.99 behaviour, kept as an explicit choice. One shared field: a value the tool in force does not offer falls back to that tool's own default. The two Settings panels store it as unset when it equals that default; `jolli configure --set` stores what you type verbatim, default included — typing a name is a choice, selecting the default option in a picker is the absence of one. The difference shows when a default rotates: an unset value follows the new default, a literal one stays on the model you named. Distinct from `model`, which names an Anthropic API model for the `anthropic` / `jolli` providers and does not reach this one. Ignored for a tool with no pinned models. |
| `localAgentPath` | string | (PATH) | Explicit path to the local agent binary, overriding `PATH` discovery. Used only when `aiProvider` is `"local-agent"`. |
| `model` | string | `claude-sonnet-4-6` | Model used for summarization. Accepts an alias (`sonnet`, `haiku`) or a full model ID. |
| `maxTokens` | integer | model default | Max output tokens per summarization call |
| `jolliApiKey` | string | — | Jolli Space API key for pushing summaries to your team knowledge base |
| `authToken` | string | — | OAuth auth token (set automatically by `jolli auth login`) |
| `logLevel` | enum | `info` | Log level for `debug.log`: `debug`, `info`, `warn`, `error` |
| `claudeEnabled` | boolean | auto-detect | Enable Claude Code session tracking |
| `codexEnabled` | boolean | auto-detect | Enable Codex session discovery |
| `geminiEnabled` | boolean | auto-detect | Enable Gemini session tracking |
| `openCodeEnabled` | boolean | auto-detect | Enable OpenCode session discovery (requires Node 22.13+) |
| `cursorEnabled` | boolean | auto-detect | Enable Cursor session discovery — covers both the Composer IDE and the `cursor-agent` CLI (single shared switch) |
| `copilotEnabled` | boolean | auto-detect | Enable GitHub Copilot CLI **and** VS Code Copilot Chat session discovery (single shared switch) |
| `clineEnabled` | boolean | auto-detect | Enable Cline session discovery (CLI + VS Code extension) |
| `devinEnabled` | boolean | auto-detect | Enable Devin CLI session discovery |
| `antigravityEnabled` | boolean | auto-detect | Enable Antigravity session discovery |
| `kimiEnabled` | boolean | auto-detect | Enable Kimi Code session discovery |
| `localFolder` | string | — | Memory Bank root on disk — every memory is dual-written here as Markdown alongside the orphan-branch copy. Set via the editor extensions' Memory Bank Settings tab. |
| `backupFolder` | string | `~/jolli_back` | Where snapshots of the local memory database go. Deliberately outside `~/.jolli` (a backup must not share fate with the disaster) and independent of `localFolder`. Validated when you set it; if the folder later becomes unreachable — an unplugged drive, say — Jolli warns rather than quietly writing snapshots somewhere else. |
| `backupRetentionDays` | integer | `20` | How long snapshots are kept. A few of the most recent are always kept regardless of age, and old ones are only removed after a new one has been written and verified. |
| `wikiRebuild` | enum | `manual` | When the knowledge wiki and graph rebuild. `manual` (the default) records what is pending on each commit and waits for you to fold it in — with `jolli compile`, the dashboard's **Rebuild** button, or the editor extensions' **Build Knowledge Wiki** button — so a commit never spends AI credits on its own. `auto` rebuilds in the background after every commit and merge, the way earlier versions did. |
| `excludePatterns` | string[] | — | Glob patterns for file exclusion (set via `jolli configure --set excludePatterns=glob1,glob2`) |
| `syncTranscripts` | boolean | `false` | When the editor plugin's sync is enabled, also mirror raw conversation transcripts (not just summaries) into the personal vault. Off by default so transcripts stay local unless you opt in. |

**Authentication setup** — three options:

**Option 1: Jolli account (recommended)**
```bash
jolli auth login
```
Signs in via browser OAuth.

**Option 2: Manual API key**
```bash
jolli configure --set apiKey=sk-ant-...
```

**Option 3: Environment variable**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Config file `apiKey` takes precedence over the environment variable. Running `jolli enable` will prompt you to choose between these options interactively.

## Summary Format

A plain commit's summary is written as a **v3 tree**. A single commit can cover multiple independent topics, and commits related through amend/squash operations form parent-child trees. Amend and squash roots, and any regenerated summary, are normalized to **v4**, which hoists the authoritative topics, recap, plans, notes, references and skills onto the root so a consumer never has to walk the children to read them. Both versions carry the same topic fields:

```json
{
  "version": 3,
  "commitHash": "abc123...",
  "commitMessage": "Fix login validation and add rate limiting",
  "branch": "feature/login-fix",
  "commitType": "commit",
  "topics": [
    {
      "title": "Fix login email validation",
      "category": "bugfix",
      "importance": "major",
      "trigger": "Users were able to submit malformed emails, causing server-side 500 errors.",
      "response": "Added email format check in LoginForm component with RFC 5322 regex.",
      "decisions": "| Option | Pros | Cons | Chosen |\n|---|---|---|---|\n| Regex | No dependency | Complex pattern | yes |\n| Library | Robust | Extra dependency | |",
      "todo": "Consider adding disposable email detection in a follow-up."
    }
  ],
  "children": []
}
```

**Topic fields**:
- **trigger**: The problem or need that prompted the work
- **response**: What was built, fixed, or changed
- **decisions**: Design rationale — may include Markdown tables comparing options
- **todo** (optional): Deferred work or open questions
- **category**: One of `feature`, `bugfix`, `refactor`, `tech-debt`, `performance`, `security`, `test`, `docs`, `ux`, `devops`
- **importance**: `major` or `minor`

## VSCode Extension

The [Jolli Memory VS Code Extension](https://marketplace.visualstudio.com/items?itemName=jolli.jollimemory-vscode) adds a sidebar with a **Current Branch / Memory Bank** view switch (plus a Status overlay) and a per-commit Summary Webview, plus a 5-tab Settings page. If you have both the CLI and the extension installed, they share the same data — the extension bundles the CLI inline so it works whether or not a global CLI install is also present.

## Plugins

Starting in 0.99.2, `@jolli.ai/cli` can discover and load allow-listed plugin packages and let them register additional subcommands. Discovery is bounded: the CLI walks `node_modules/` directories upward from the current working directory, stopping at the nearest `.git` ancestor (or your home directory if none is found), and also consults the global npm root. The allow-list is fixed at the CLI level, so a malicious package cannot register itself merely by being on disk.

The three shipping plugins are **`@jolli.ai/site-cli`** (the Jolli Site documentation generator), **`@jolli.ai/space-cli`** (Jolli Space commands), and **`@jolli.ai/workflow-cli`** (running Jolli workflows locally and reporting remote runs — grouped under **Jolli Workflows** in `jolli --help`). All three are listed in `KNOWN_PLUGINS` in [`cli/src/KnownPlugins.ts`](https://github.com/jolliai/jolliai/blob/main/cli/src/KnownPlugins.ts), which is the source of truth for the allow-list.

```bash
# Install (your existing jolli install is unchanged)
npm install -g @jolli.ai/site-cli      # or @jolli.ai/space-cli, @jolli.ai/workflow-cli

# Disable plugin loading entirely
JOLLI_NO_PLUGINS=1 jolli <command>
```

Plugins use a small public API exported from `@jolli.ai/cli/api` (`PluginContext`, `PluginRegister`, `parseJolliApiKey`, `parseBaseUrl`). See [SECURITY.md](https://github.com/jolliai/jolliai/blob/main/SECURITY.md#operational-guidance) for the operational guidance and trust model.

## Error Handling

Jolli Memory is designed to **never interfere** with your development workflow:

- All errors are logged to `.jolli/jollimemory/debug.log`
- The git post-commit hook runs in a **detached background process** — git commit returns immediately
- API failures are retried once (2s delay), then a minimal record is saved so squash/rebase chains are not broken
- Missing sessions or transcripts are skipped silently
- Concurrent runs are prevented with a file lock (5-minute stale timeout)
- A unified operation queue ensures no summaries are lost during rapid commit/amend/rebase sequences

If something looks off, run `jolli doctor` to check for faults (stuck locks, missing hooks, invalid config) and `jolli clean --dry-run` to preview redundant data that can be safely removed.

## Privacy

### At summary generation time (after each commit)

To produce a summary, Jolli Memory reads your active AI session transcripts and the git diff locally, then sends them together to a summarization backend:

- If an **Anthropic `apiKey`** is configured — transcripts + diff are sent **directly to Anthropic**.
- If only a **`jolliApiKey`** is configured (you signed in with `jolli auth login`) — transcripts + diff are sent to the **Jolli LLM proxy**, which forwards them to Anthropic on your behalf. The proxy **does not persist the transcripts or diff, and does not write them to any Jolli-side log** — payloads are held in memory only for the duration of the request and discarded once Anthropic responds.

The generated summary is then dual-written locally — to the git orphan branch (the source of truth) and to the Memory Bank folder on disk (canonical JSON at `<localFolder>/<repo>/.jolli/summaries/<commitHash>.json` plus human-readable Markdown at `<localFolder>/<repo>/<branch>/<slug>-<hash8>.md`). Raw transcripts are dual-written the same way: to `transcripts/<commitHash>.json` on the orphan branch and to `<localFolder>/<repo>/.jolli/transcripts/<commitHash>.json` in the Memory Bank folder.

### Uploads to Jolli Space

`jolli push` sends a branch's memories to your bound Jolli Space from the CLI, and the VS Code and IntelliJ extensions expose the same action as a **Share in Jolli** button. `jolli push-control` decides whether this repo pushes at all. When triggered there, only the **generated summary** and its **associated plans and notes** are uploaded, and only if this repo's outbound push is on (see [`jolli push-control`](#jolli-push-control)). The pushed article (and the clipboard export) carries a **Task usage** line — total tokens, a cost estimate, and the input / output / cached split, aggregated across squashed and amended commits. **Raw transcripts are never sent to Jolli Space.**

### Session metadata

Session IDs, transcript file paths, and timestamps are stored locally in `<projectDir>/.jolli/jollimemory/sessions.json` (per-project, gitignored). Never uploaded anywhere.

### What stays 100% local

Two `.jolli/jollimemory/` directories carry local state, both stay on your disk unless one of the specific actions above is triggered:

- `~/.jolli/jollimemory/` (machine-global) — `config.json` (apiKey / authToken / jolliApiKey), `push-control.json` (which repos are allowed to push), hook entry scripts, dist-path indirection.
- `<projectDir>/.jolli/jollimemory/` (per-project, gitignored) — `sessions.json` (session metadata), `plans.json`, `notes/`, `skills/` (captured skill usage), `cursors.json`, `git-op-queue/`, `briefing-cache.json`, `debug.log`.

Every entry on the `jollimemory/summaries/v3` orphan branch — and its mirror inside the Memory Bank folder, including raw transcripts — also stays on your disk unless one of the specific actions above is triggered.

### Usage telemetry (anonymous, opt-out)

Separately from your memory content, Jolli Memory collects **anonymous, content-free usage telemetry** to understand which features are used and where things break. It is **on by default** and you can turn it off at any time.

- **What is sent** — event names (e.g. `app_installed`, `ingest_completed`, `sync_completed`), the surface and version (`cli` + version), OS / arch / Node version, a random `installId` (a UUID generated on this machine), and coarse, bucketed counts. Nothing else.
- **What is never sent** — your code, file paths, commit messages, diffs, transcripts, memory/summary content, repo names, branch names, API keys, or any account identifier. Property values are scrubbed before they leave your machine, and the payload carries no account ID.
- **How it leaves your machine** — events are written to a local buffer (`<projectDir>/.jolli/jollimemory/telemetry-queue.ndjson`) and flushed in small batches; the buffer is capped and never grows unbounded.

**Turn it off (any one of these):**

```bash
# Persisted opt-out (writes telemetry: "off" to the shared config)
jolli telemetry off

# Or set the standard env var (honored on every run)
export DO_NOT_TRACK=1
```

Jolli also honors your OS / IDE data-sharing setting. Check the current state with `jolli telemetry status`, print the exact buffered events with `jolli telemetry inspect`, and see <https://jolli.ai/telemetry> for the full event list.

---

## Jolli Site — documentation from your content folder

Site generation turns a plain folder of Markdown files and OpenAPI specs into a polished documentation site. It ships as the separate **`@jolli.ai/site-cli`** plugin — install it with `npm install -g @jolli.ai/site-cli` and the host CLI discovers it automatically, making the commands below available. The commands appear in `jolli --help` either way; running one without the plugin installed prints a short install hint.

### `jolli new [folder-name]`

Scaffolds a new Content_Folder with starter files: `site.json` (configuration), sample Markdown pages, and an example OpenAPI spec.

```bash
jolli new my-docs
cd my-docs
jolli dev          # live preview at localhost:3000
```

### `jolli dev [source-root]`

Starts a development server with hot reload. Edits to Markdown, MDX, or OpenAPI files in the source folder are mirrored and rendered instantly via Next.js HMR.

```bash
jolli dev                  # current directory
jolli dev ./my-docs        # specific folder
jolli dev --migrate        # re-detect framework config
jolli dev --verbose        # detailed build output
```

### `jolli build [source-root]`

Builds a static site with full-text search indexing (Pagefind). No server is started.

```bash
jolli build
```

### `jolli start [source-root]`

Builds the static site + search index, then serves it locally.

```bash
jolli start
```

### `jolli convert [source]`

Converts an existing Docusaurus documentation folder to Jolli-compatible structure. Creates a timestamped backup when converting in-place.

```bash
jolli convert                      # convert current directory
jolli convert ./old-docs           # convert specific folder
jolli convert --output ./new-docs  # output to a different folder
```

What it does: detects sidebar config, reorganizes directory structure, downgrades incompatible `.mdx` to `.md`, rewrites image paths, writes a clean `site.json`, and removes framework-specific files.

### How it works

1. **Content_Folder** — your Markdown files, images, and OpenAPI specs live in a plain folder. `site.json` at the root configures title, navigation, theme, and footer.
2. **Mirror + Render** — the CLI mirrors content into a hidden build directory (`~/.jolli/sites/<hash>/`), renders OpenAPI specs into interactive API docs, generates sidebar navigation from the folder structure, and runs Next.js under the hood.
3. **Theme Packs** — choose from `forge` (clean developer-docs, default), `default`, or `atlas` (editorial, dark serif). Set in `site.json` under `theme.pack`.

### `site.json` reference

```json
{
  "title": "My Docs",
  "description": "Project documentation",
  "nav": [
    { "title": "Home", "href": "/" },
    { "title": "API", "href": "/api/openapi" }
  ],
  "theme": { "pack": "forge" }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Site title (required) |
| `description` | string | Site description (required) |
| `nav` | array | Top navbar links (required) |
| `header` | object | Advanced dropdown navbar |
| `footer` | object | Copyright, columns, social icons |
| `sidebar` | object | Folder → navigation label overrides |
| `pathMappings` | object | Source → target folder remapping |
| `theme` | object | Pack, colors, fonts, logo |
| `favicon` | string | Path to favicon file |

---

## Support

- **Documentation:** [Getting Started with Jolli Memory](https://docs.jolli.ai/jolli-memory/getting-started-with-jolli-memory) and [Connect Memory to Your AI Assistant (MCP)](https://docs.jolli.ai/jolli-memory/use-your-memory-from-any-ai-assistant-mcp), plus the full guides and reference on [docs.jolli.ai](https://docs.jolli.ai/jolli-memory/getting-started-with-jolli-memory).
- **Issues & feature requests** — [GitHub Issues](https://github.com/jolliai/jolliai/issues)
- **Jolli Space onboarding / enterprise** — support@jolli.ai
- **VS Code extension reference** — see the [VS Code README](https://github.com/jolliai/jolliai/tree/main/vscode)

## License

[Apache License 2.0](https://github.com/jolliai/jolliai/blob/main/LICENSE)
