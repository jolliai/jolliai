# Jolli CLI

The `@jolli.ai/cli` package has two main uses:

## 1. Jolli Memory — automatic AI session summaries

Turns your AI coding sessions into structured development documentation attached to every commit, without any extra effort. When you work with AI agents like Claude Code, Codex, Gemini CLI, OpenCode, Cursor IDE, GitHub Copilot CLI, or VS Code Copilot Chat, the reasoning behind every decision lives in the conversation: *why this approach was chosen, what alternatives were considered, what problems came up along the way*. The moment you commit, that context is gone. Jolli Memory captures it automatically.

**What it does:**

- **Automatic capture** — after each commit, reads your AI transcripts + diff, calls the LLM, and stores a structured summary alongside the commit. The commit returns instantly; the summary is generated in a detached background process (~10–20 s).
- **Catch up on existing history** — `jolli backfill` creates memories for commits you made before enabling Jolli.
- **Seven supported agents** — Claude Code, Codex, Gemini CLI, OpenCode, Cursor IDE (Composer), GitHub Copilot CLI, and VS Code Copilot Chat.
- **Dual storage** — every memory is written to a dedicated git orphan branch (`jollimemory/summaries/v3`, the source of truth) **and** to a human-browsable Memory Bank folder on disk (canonical JSON + Markdown).
- **Worktree-aware** — hooks and summaries work across `git worktree` checkouts.
- **Squash / amend / rebase safe** — a unified operation queue migrates or consolidates summaries when commits are rewritten, so memories are never lost.
- **Session context recall** — `jolli recall` (or the `/jolli-recall` skill) loads complete branch history back into your AI agent so it can pick up where you left off. A lightweight briefing is also injected at the start of every Claude Code session.
- **Cross-branch search** — `jolli search <keyword>` ranks every branch's memories with BM25 and returns the best-matching hits in a single pass.
- **MCP server for AI agents** — `jolli mcp` exposes your history to Claude Code (and any MCP-aware agent) so it can search memories, recall a branch, and trace a decision's history without leaving the chat. Registered automatically on `jolli enable`.
- **Knowledge wiki** — `jolli compile` folds the work scattered across many commits into per-topic pages and a browsable `_wiki/` folder in your Memory Bank, updated automatically after each commit.
- **Knowledge graph** — `jolli graph` exports the wiki's topics as an interactive, self-contained HTML map of categories, knowledge units, and the typed links between them. Built incrementally alongside the wiki on every commit.
- **Issue, page & conversation references** — Linear, Jira, GitHub, Notion, Slack, Zoom, Confluence, Asana, and monday.com items mentioned in your AI conversations are captured and attached to the relevant memory.
- **Privacy-first** — transcripts and diff go straight to Anthropic (with your `apiKey`) or via the Jolli LLM proxy (in-memory, never persisted). Raw transcripts are never uploaded to Jolli Space.

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

## Jolli Memory

## How It Works

After each commit, Jolli Memory reads your AI session transcripts and the code diff, calls the LLM to produce a structured summary, and stores it alongside the commit silently in the background. Your commit returns instantly — the summary is generated in the background (~10-20 seconds).

Jolli Memory runs entirely in the background using two types of hooks:

### AI Agent Hooks — knowing which sessions are active

When you use an AI coding agent, Jolli Memory keeps track of your active sessions so it knows where to find conversation context at commit time. These hooks **only record session metadata** (like a session ID and file path), they never read your conversation content until commit time.

| Agent | How sessions are tracked |
| -- | -- |
| **Claude Code** | A lightweight `StopHook` fires after each AI response; a `SessionStartHook` injects a mini-briefing at session start |
| **Gemini CLI** | An `AfterAgent` hook fires after each agent completion |
| **Codex CLI** | No hook needed — sessions are discovered automatically by scanning the filesystem. Linear/Jira/GitHub/Notion/Slack/Zoom/Confluence/Asana/monday.com references in Codex MCP calls are extracted on the VS Code sidebar's 60s polling tick (not at commit time) |
| **OpenCode** | No hook needed — sessions are discovered automatically by reading OpenCode's global SQLite database at `~/.local/share/opencode/opencode.db` (requires Node 22.5+) |
| **Cursor IDE** (Composer) | No hook needed — sessions are discovered automatically by reading Cursor's local SQLite stores (`globalStorage/state.vscdb` plus per-workspace `workspaceStorage/` databases under your platform's Cursor user-data directory) |
| **GitHub Copilot CLI** | No hook needed — sessions are discovered automatically by scanning Copilot CLI's session log |
| **VS Code Copilot Chat** | No hook needed — sessions are discovered automatically by reading the Copilot Chat conversation cache |

### Git Hooks — generating summaries on commit

When you run `git commit`, three standard git hooks handle the rest:

1. **Before the commit** (`prepare-commit-msg`): detects if this is a squash operation so existing memories can be merged instead of regenerated
2. **After the commit** (`post-commit`): detects the operation type (commit, amend, squash, cherry-pick, revert), enqueues it, and spawns a background worker that reads the AI conversation + code diff, calls the LLM, and writes the summary
3. **After rebase/amend** (`post-rewrite`): enqueues migration entries so summaries are re-associated with the new commit hashes

Every memory is dual-written to **both** the git orphan branch `jollimemory/summaries/v3` (the source of truth — completely separate from your code history) and the **Memory Bank** folder on disk, so you always have a plain-Markdown copy you can read, `grep`, or pipe into other tools without going through the CLI. The Memory Bank folder has two layers — a hidden `<localFolder>/<repo>/.jolli/summaries/<commitHash>.json` for canonical JSON, and a visible `<localFolder>/<repo>/<branch>/<slug>-<hash8>.md` for human-readable Markdown — and `<localFolder>` is your configured Memory Bank root (one root can hold multiple repos, each in its own `<repo>/` subfolder). Raw AI conversation transcripts are dual-written the same way — to `transcripts/<commitHash>.json` on the orphan branch and to `<localFolder>/<repo>/.jolli/transcripts/<commitHash>.json` in the Memory Bank folder.

**Worktree-aware:** hooks and summaries work across `git worktree` checkouts — each worktree tracks its own current branch and its memories stay consistent.

## Installation

**Requirements** — **Node.js 22.5 or later**. OpenCode session discovery uses Node's built-in `node:sqlite`, which first ships in Node 22.5; the `engines` field refuses installation on older runtimes. If you use Node 18 or 20, please upgrade before installing.

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
- **MCP server registration** — adds the JolliMemory MCP server to your project's `.mcp.json` so Claude Code can query your memories (see [`jolli mcp`](#jolli-mcp))
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

A few shared artifacts are deliberately left in place: **global-scope MCP registrations** (the Gemini / Codex / OpenCode / Copilot host files) and the **global instruction blocks** in `~/.claude/CLAUDE.md` / `~/.gemini/GEMINI.md` / `~/.codex/AGENTS.md` are shared by every repo on the machine, so removing them during one uninstall would break Jolli for your other repos; and the generated `SKILL.md` files are left untouched because they may sit alongside skills of your own. Remove those by hand if you want a completely bare machine.

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

Shows the current installation status, including CLI version, hook state, authentication state, active sessions, supported integrations (Claude, Codex, Gemini, OpenCode, Cursor, Copilot CLI, Copilot Chat), and summary count.

```bash
jolli status
jolli status --json   # machine-readable output
```

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

Starts a Model Context Protocol (MCP) server over stdio so AI agents can query your memories directly. It exposes nine tools: **search** (full-text search over your historical decisions and implementations), **recall** (load a branch's complete context), **get_decision_timeline** (trace how one decision evolved across commits), **list_branches** (catalog of branches that have memories), **get_pr_description** (build a PR title and description from a branch's memories), **queue_status** (report whether summary generation is still in progress — call before building a PR so fresh commits are included), **bind_space** (bind this repo to a Jolli Space), **list_spaces** (list the Jolli Spaces you can bind to), and **push_memory** (push a branch's memories to the bound Jolli Space as articles).

```bash
# Start the server (normally launched by your agent, not by hand)
jolli mcp

# Rebuild the local search index from source and exit
jolli mcp --reindex
```

On top of these nine built-in tools, the server also surfaces **platform tools** defined by the Jolli backend (on by default), so a connected agent can act on your Jolli Space directly. Turn them off with `jolli configure --set mcpPlatformToolsEnabled=false`.

`jolli enable` registers this server automatically in your project's `.mcp.json`, so Claude Code picks it up on its next start — no manual setup. The search index is a disposable local cache (never written to the orphan branch); `--reindex` forces a fresh rebuild if you ever want to clear it.

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

You normally don't need to run this by hand — after each commit, Jolli Memory incrementally folds new sources into the wiki in the background (the editor extensions expose the same action as a **Build Knowledge Wiki** button). Running `jolli compile` is for an on-demand refresh or a full `--rebuild`. Requires an API key (same as summary generation).

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

The graph is built automatically right after the knowledge wiki on each commit and updated incrementally — only topics whose content changed are re-distilled — so it stays current without a full rebuild. It's stored folder-locally (`<localFolder>/<repo>/.jolli/graph/graph.json`) and regenerable, never written to the orphan branch. Run `jolli compile` first if a repo has no graph yet. The editor extensions expose the same visualization via a **View knowledge graph** button.

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

Supported keys: `apiKey`, `aiProvider`, `localAgentTool`, `localAgentPath`, `model`, `maxTokens`, `jolliApiKey`, `authToken`, `claudeEnabled`, `codexEnabled`, `geminiEnabled`, `openCodeEnabled`, `cursorEnabled`, `copilotEnabled`, `globalInstructions`, `mcpPlatformToolsEnabled`, `localFolder`, `logLevel`, `excludePatterns`, `syncTranscripts`. `globalInstructions` (`enabled` / `disabled`, unset = undecided) records whether the skill-preference note is written into your machine-global AI instruction files. Setting it to `enabled` writes the block immediately; `disabled` removes it. `jolli enable` never prompts — it only applies the current value (`enabled` → write, `disabled` → remove, unset → no change). `aiProvider` pins the summarization backend (`"anthropic"`, `"jolli"`, or `"local-agent"`); when omitted, the dispatcher falls back to the legacy precedence (`apiKey` > `ANTHROPIC_API_KEY` > `jolliApiKey`). `local-agent` drives a locally-installed AI CLI (Claude Code today) to generate memories instead of calling an API — `localAgentTool` selects the tool (currently only `claude-code`) and `localAgentPath` optionally points at the binary when it isn't on your `PATH`. `copilotEnabled` controls both GitHub Copilot CLI and VS Code Copilot Chat as a single switch. `mcpPlatformToolsEnabled` (boolean, on by default) controls whether the `jolli mcp` server surfaces the backend-defined platform tools; set it to `false` to expose only the built-in tools. `localFolder` is the Memory Bank root on disk where every memory is dual-written. `syncTranscripts` opts raw transcripts into cloud sync — see [Memory Bank cloud sync](#memory-bank-cloud-sync) below; run a round on demand with `jolli sync-memory-bank`. Run `jolli configure --list-keys` for descriptions and types. Unknown keys and malformed values (e.g. `maxTokens=8192abc`, `logLevel=banana`) are rejected with exit code 1.

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
```

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
| `localAgentTool` | enum | `claude-code` | Which local Agent CLI to drive when `aiProvider` is `"local-agent"`. Currently only `claude-code`; reserved for future tools (Codex, Cursor). Ignored otherwise. |
| `localAgentPath` | string | (PATH) | Explicit path to the local agent binary, overriding `PATH` discovery. Used only when `aiProvider` is `"local-agent"`. |
| `model` | string | `claude-sonnet-4-6` | Model used for summarization. Accepts an alias (`sonnet`, `haiku`) or a full model ID. |
| `maxTokens` | integer | model default | Max output tokens per summarization call |
| `jolliApiKey` | string | — | Jolli Space API key for pushing summaries to your team knowledge base |
| `authToken` | string | — | OAuth auth token (set automatically by `jolli auth login`) |
| `logLevel` | enum | `info` | Log level for `debug.log`: `debug`, `info`, `warn`, `error` |
| `claudeEnabled` | boolean | auto-detect | Enable Claude Code session tracking |
| `codexEnabled` | boolean | auto-detect | Enable Codex CLI session discovery |
| `geminiEnabled` | boolean | auto-detect | Enable Gemini CLI session tracking |
| `openCodeEnabled` | boolean | auto-detect | Enable OpenCode session discovery (requires Node 22.5+) |
| `cursorEnabled` | boolean | auto-detect | Enable Cursor IDE (Composer) session discovery |
| `copilotEnabled` | boolean | auto-detect | Enable GitHub Copilot CLI **and** VS Code Copilot Chat session discovery (single shared switch) |
| `localFolder` | string | — | Memory Bank root on disk — every memory is dual-written here as Markdown alongside the orphan-branch copy. Set via the editor extensions' Memory Bank Settings tab. |
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

Each summary uses a **v3 tree structure**. A single commit can cover multiple independent topics, and commits related through amend/squash operations form parent-child trees:

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

The [Jolli Memory VS Code Extension](https://marketplace.visualstudio.com/items?itemName=jolli.jollimemory-vscode) adds a sidebar with three tabs (Branch / Memory Bank / Status) and a per-commit Summary Webview, plus a 5-tab Settings page. If you have both the CLI and the extension installed, they share the same data — the extension bundles the CLI inline so it works whether or not a global CLI install is also present.

## Plugins

Starting in 0.99.2, `@jolli.ai/cli` can discover and load allow-listed plugin packages and let them register additional subcommands. Discovery is bounded: the CLI walks `node_modules/` directories upward from the current working directory, stopping at the nearest `.git` ancestor (or your home directory if none is found), and also consults the global npm root. The allow-list is fixed at the CLI level, so a malicious package cannot register itself merely by being on disk.

The two shipping plugins are **`@jolli.ai/site-cli`** (the Jolli Site documentation generator) and **`@jolli.ai/space-cli`** (Jolli Space commands). Both are listed in `KNOWN_PLUGINS` in [`cli/src/KnownPlugins.ts`](https://github.com/jolliai/jolliai/blob/main/cli/src/KnownPlugins.ts), which is the source of truth for the allow-list.

```bash
# Install (your existing jolli install is unchanged)
npm install -g @jolli.ai/site-cli      # or @jolli.ai/space-cli

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

The CLI itself does not push summaries to Jolli Space — that action lives in the VS Code and IntelliJ extensions (**Share in Jolli** button). When triggered there, only the **generated summary** and its **associated plans and notes** are uploaded. The pushed article (and the clipboard export) carries a **Task usage** line — total tokens, a cost estimate, and the input / output / cached split, aggregated across squashed and amended commits. **Raw transcripts are never sent to Jolli Space.**

### Session metadata

Session IDs, transcript file paths, and timestamps are stored locally in `<projectDir>/.jolli/jollimemory/sessions.json` (per-project, gitignored). Never uploaded anywhere.

### What stays 100% local

Two `.jolli/jollimemory/` directories carry local state, both stay on your disk unless one of the specific actions above is triggered:

- `~/.jolli/jollimemory/` (machine-global) — `config.json` (apiKey / authToken / jolliApiKey), hook entry scripts, dist-path indirection.
- `<projectDir>/.jolli/jollimemory/` (per-project, gitignored) — `sessions.json` (session metadata), `plans.json`, `notes/`, `cursors.json`, `git-op-queue/`, `briefing-cache.json`, `debug.log`.

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

- **Issues & feature requests** — [GitHub Issues](https://github.com/jolliai/jolliai/issues)
- **Jolli Space onboarding / enterprise** — support@jolli.ai
- **VS Code extension reference** — see the [VS Code README](https://github.com/jolliai/jolliai/tree/main/vscode)

## License

[Apache License 2.0](https://github.com/jolliai/jolliai/blob/main/LICENSE)

