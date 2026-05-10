# Jolli Memory

> *Every commit deserves a Memory. Every memory deserves a Recall.*

**Jolli Memory** automatically turns your AI coding sessions into structured development documentation attached to every commit, without any extra effort. It also includes **Jolli Site** — generate polished documentation sites from Markdown and OpenAPI specs with a single command.

When you work with AI agents like Claude Code, Codex, Gemini CLI, OpenCode, Cursor IDE, GitHub Copilot CLI, or VS Code Copilot Chat, the reasoning behind every decision lives in the conversation: *why this approach was chosen, what alternatives were considered, what problems came up along the way*. The moment you commit, that context is gone. Jolli Memory captures it automatically.

## How It Works

After each commit, Jolli Memory reads your AI session transcripts and the code diff, calls the LLM to produce a structured summary, and stores it alongside the commit silently in the background. Your commit returns instantly — the summary is generated in the background (~10-20 seconds).

Jolli Memory runs entirely in the background using two types of hooks:

### AI Agent Hooks — knowing which sessions are active

When you use an AI coding agent, Jolli Memory keeps track of your active sessions so it knows where to find conversation context at commit time. These hooks **only record session metadata** (like a session ID and file path), they never read your conversation content until commit time.

| Agent | How sessions are tracked |
| -- | -- |
| **Claude Code** | A lightweight `StopHook` fires after each AI response; a `SessionStartHook` injects a mini-briefing at session start |
| **Gemini CLI** | An `AfterAgent` hook fires after each agent completion |
| **Codex CLI** | No hook needed — sessions are discovered automatically by scanning the filesystem |
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

```bash
jolli enable
```

### `jolli disable`

Removes all Jolli Memory hooks. Existing summaries are preserved in the orphan branch.

```bash
jolli disable
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

Searches stored memories with a two-phase pipeline: Phase 1 returns a catalog of matching commits (hash + branch + date + recap + topic titles); Phase 2 takes a comma-separated `--hashes` list and returns full topic bodies for those commits.

```bash
# Phase 1 — catalog of matches on the current branch
jolli search "rate limiter"

# Filter to recent commits, cap entries, JSON for skills/agents
jolli search "auth refactor" --since 2026-04-01 --limit 5 --format json

# Phase 2 — load full topic bodies for chosen hashes
jolli search "rate limiter" --hashes deadbeef,cafe1234 --format json

# Cap the token budget on the catalog output
jolli search "windows path" --budget 8000 --format json
```

Available flags: `--since` (ISO date or relative `7d`/`2w`/`1m`/`3y`; bad values are rejected with exit 1), `--hashes`, `--limit`, `--budget`, `--format` (`json` default; `text` for terminal-friendly output), `--output`, `--cwd`. There is **no `--branch` flag** — the catalog is scanned across every branch in the repo by design.

### Site generation: `jolli new` / `build` / `start` / `dev`

Generates a Nextra v4 documentation site from a `Content_Folder` of Markdown plus optional OpenAPI specs. Designed for product / API documentation alongside (or instead of) your AI commit memories.

```bash
# Scaffold a new site (creates Content_Folder/ + site.json)
jolli new my-docs

# Build the static site to <out>/dist
jolli build

# Serve the built site
jolli start

# Hot-reload dev server (watches Content_Folder/ and re-syncs on change)
jolli dev
```

Highlights:

- **Theme packs** — `theme.pack` in `site.json` accepts `"forge"` (clean dev docs, sidebar-first, Inter; the default), `"atlas"` (editorial, dark default, serif), or `"default"` (vanilla Nextra layout, no custom styling). Customize `accentHue`, `fontFamily`, logos, and default theme mode in `site.json`.
- **Header / footer config**: `header.items` supports per-item dropdowns; `footer` supports copyright, link columns, and social icons.
- **OpenAPI rich pipeline**: each endpoint is compiled into a per-endpoint MDX page with auto-generated cURL / JS / TS / Python / Go code samples — no `swagger-ui-react` runtime.

See [`docs/site-json-reference.md`](docs/site-json-reference.md) and [`examples/`](examples/) for runnable configurations.

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

Supported keys: `apiKey`, `aiProvider`, `model`, `maxTokens`, `jolliApiKey`, `authToken`, `claudeEnabled`, `codexEnabled`, `geminiEnabled`, `openCodeEnabled`, `cursorEnabled`, `copilotEnabled`, `localFolder`, `logLevel`, `excludePatterns`. `aiProvider` pins the summarization backend (`"anthropic"` or `"jolli"`); when omitted, the dispatcher falls back to the legacy precedence (`apiKey` > `ANTHROPIC_API_KEY` > `jolliApiKey`). `copilotEnabled` controls both GitHub Copilot CLI and VS Code Copilot Chat as a single switch. `localFolder` is the Memory Bank root on disk where every memory is dual-written. Run `jolli configure --list-keys` for descriptions and types. Unknown keys and malformed values (e.g. `maxTokens=8192abc`, `logLevel=banana`) are rejected with exit code 1.

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

## Jolli Site — documentation from your content folder

The CLI also includes a site generation surface that turns a plain folder of Markdown files and OpenAPI specs into a polished Nextra v4 documentation site.

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

Converts an existing Docusaurus documentation folder to Nextra-compatible structure. Creates a timestamped backup when converting in-place.

```bash
jolli convert                      # convert current directory
jolli convert ./old-docs           # convert specific folder
jolli convert --output ./new-docs  # output to a different folder
```

What it does: detects sidebar config, reorganizes directory structure, downgrades incompatible `.mdx` to `.md`, rewrites image paths, writes a clean `site.json`, and removes framework-specific files.

### How it works

1. **Content_Folder** — your Markdown files, images, and OpenAPI specs live in a plain folder. `site.json` at the root configures title, navigation, theme, and footer.
2. **Mirror + Render** — the CLI mirrors content into a hidden build directory (`~/.jolli/sites/<hash>/`), renders OpenAPI specs into interactive API docs, generates sidebar navigation from the folder structure, and runs Next.js under the hood.
3. **Theme Packs** — choose from `forge` (clean developer-docs, default), `default` (vanilla Nextra), or `atlas` (editorial, dark serif). Set in `site.json` under `theme.pack`.

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

## Session Context Recall

Jolli Memory feeds prior development context back into your AI agent so it can pick up where you (or a teammate) left off.

**Automatic briefing** — every time a new Claude Code session starts, a lightweight briefing (~300–500 tokens) is injected into the conversation: branch name, commit count, date range, and last commit message. If it has been more than 3 days since the last commit, it suggests running the full recall command. This runs in under 200 ms and never blocks session startup.

**Full recall** — run `/jolli-recall` inside Claude Code (or any agent that supports it) to load the complete branch history: summaries, plans, decisions, and file-change statistics (default budget ≈ 50,000 tokens; pass `--budget` to adjust). The agent then reports what the branch is implementing, key technical decisions, what was last worked on, and the main files involved — so you can continue without re-reading the code.

If the current branch has no memories, the command shows a catalog of branches that do, letting you pick one to recall. You can also pass a branch name or keyword as an argument (e.g. `/jolli-recall auth-refactor`).

**Targeted search** — run `/jolli-search <keyword>` (or `jolli search <keyword>` from the terminal) to search across every branch's memories. The raw CLI returns the catalog and full topic bodies (Phase 1 + Phase 2 via `--hashes`).

## Configuration

Settings are stored globally in `~/.jolli/jollimemory/config.json`. The recommended way to manage them is via `jolli configure` — see [the command reference above](#jolli-configure) — which validates keys and types and masks secrets on display.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | string | `$ANTHROPIC_API_KEY` | Anthropic API key for summarization ([get one here](https://platform.anthropic.com/)) |
| `aiProvider` | enum | (auto) | Pin which provider generates summaries: `"anthropic"` (use `apiKey` / `$ANTHROPIC_API_KEY`) or `"jolli"` (use `jolliApiKey`). When unset, the resolver falls back to the legacy precedence (`apiKey` → `$ANTHROPIC_API_KEY` → `jolliApiKey`). Each generated summary records the chosen source in its `LlmCallMetadata.source` field (`anthropic-config` / `anthropic-env` / `jolli-proxy`). |
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

The CLI itself does not push summaries to Jolli Space — that action lives in the VS Code and IntelliJ extensions (**Push to Jolli** button). When triggered there, only the **generated summary** and its **associated plans and notes** are uploaded. **Raw transcripts are never sent to Jolli Space.**

### Session metadata

Session IDs, transcript file paths, and timestamps are stored locally in `<projectDir>/.jolli/jollimemory/sessions.json` (per-project, gitignored). Never uploaded anywhere.

### What stays 100% local

Two `.jolli/jollimemory/` directories carry local state, both stay on your disk unless one of the specific actions above is triggered:

- `~/.jolli/jollimemory/` (machine-global) — `config.json` (apiKey / authToken / jolliApiKey), hook entry scripts, dist-path indirection.
- `<projectDir>/.jolli/jollimemory/` (per-project, gitignored) — `sessions.json` (session metadata), `plans.json`, `notes/`, `cursors.json`, `git-op-queue/`, `briefing-cache.json`, `debug.log`.

Every entry on the `jollimemory/summaries/v3` orphan branch — and its mirror inside the Memory Bank folder, including raw transcripts — also stays on your disk unless one of the specific actions above is triggered.

## Support

- **Issues & feature requests** — [GitHub Issues](https://github.com/jolliai/jolliai/issues)
- **Jolli Space onboarding / enterprise** — support@jolli.ai
- **VS Code extension reference** — see the [VS Code README](https://github.com/jolliai/jolliai/tree/main/vscode)

## License

[Apache License 2.0](https://github.com/jolliai/jolliai/blob/main/LICENSE)

