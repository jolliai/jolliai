# Jolli Memory

> *Every commit deserves a Memory. Every memory deserves a Recall.*

**Jolli Memory** automatically turns your AI coding sessions into structured development documentation attached to every commit, without any extra effort.

When you work with AI agents like Claude Code, Codex, Gemini, OpenCode, Cursor IDE, GitHub Copilot CLI, or VS Code Copilot Chat, the reasoning behind every decision lives in the conversation: *why this approach was chosen, what alternatives were considered, what problems came up along the way*. The moment you commit, that context is gone. Jolli Memory captures it automatically.

---

## Installation

Install from the VS Code Marketplace:

```bash
code --install-extension jolli.jollimemory-vscode
```

Or search for **Jolli Memory** in the Extensions sidebar (`⌘⇧X` / `Ctrl+Shift+X`) and click **Install**.

### Requirements

- **VS Code 1.80 or newer** for core features.
- **VS Code ~1.99+ (bundled Node 22.5+)** only if you want **OpenCode** session discovery. On older hosts the extension runs normally — OpenCode is quietly skipped while every other integration works.
- **GitHub CLI (`gh`)** only for **Create & Update PR**; every other feature works without it.
- An **Anthropic API key** *or* a **Jolli account** (via **Sign In to Jolli**) for summary generation — see [Sign In to Jolli](#sign-in-to-jolli) below.

### First run

On a fresh install, the sidebar opens to an **onboarding panel** that walks you through the three steps below. Once one repo is enabled, every newly opened workspace auto-enables in the background — clicking **Disable** is recorded as a durable opt-out and respected on every subsequent activation.

1. Click the Jolli icon in the activity bar to open the sidebar — git hooks auto-install in the background on first activation (unless you've previously clicked **Disable** in this repo).
2. In the onboarding panel, either click **Sign In / Sign Up** (browser OAuth) or **Configure API Key** to paste an Anthropic API key inline. Authentication is what summary generation needs — without it, hooks still capture session metadata, but the LLM call at commit time has nothing to authenticate with. (You can also open the **Settings** gear later.)
3. Restart any active AI agent session (Claude Code / Codex / Gemini / OpenCode / Cursor / Copilot) so hooks take effect.
4. Make a commit as usual — the summary appears in the **Memories** section of the Current Branch view within ~10-20 seconds.

---

## What it does

After each commit, Jolli Memory reads your selected AI session transcripts and the code diff, calls the LLM to produce a structured summary, and stores it alongside the commit silently in the background. The VS Code extension surfaces everything in a sidebar so you can manage plans, stage files, write AI-assisted commit messages, review summaries, and share them, without leaving your editor.

### The sidebar

The panel leads with a segmented **Current Branch / Memory Bank** switch under the "JOLLI MEMORY" title bar, plus a `repo / branch` breadcrumb you can click to jump between repos and branches. Two actions live in the title bar itself — **Settings** (`$(gear)`) and **Status** (`$(pulse)`); Status opens as an overlay rather than a third tab. This is two primary views and one overlay:

| View | What it shows |
| -- | -- |
| **Current Branch** *(breadcrumb shows the current `repo / branch`)* | Four collapsible sections for the current branch: **Conversations** (recent AI coding sessions across every supported tool, with title / agent / message count; the list polls in the background so it stays current), **Plans & Notes** (auto-detected Claude Code plans plus your own text/Markdown notes), **Changes** (all changed files with checkboxes to stage/unstage, plus an exclude filter), and **Memories** (every commit on the current branch not yet in main; click a row to open the full AI summary, or expand it in place to see the **evidence** — the files and conversations behind it, grouped by type). Every section has a **Select / Deselect All** toggle, and per-item checkboxes — unchecked items are excluded from the next commit's memory and the exclusion sticks across commits and restarts. |
| **Memory Bank** | A cross-branch / cross-repo view of every stored memory on disk, with the repo you're working in pinned to the top. Toggle between **Tree** (folder structure by repo / branch) and **Timeline** (chronological by date) modes from the toolbar, and search across everything. The same data is mirrored on the orphan branch — this view reads from the dual-written Memory Bank folder, and cross-repo browsing routes reads through the folder layer so opening a memory from a sibling repo never invokes git plumbing in the wrong working tree. |
| **Status overlay** *(pulse icon in the title bar)* | Whether Jolli Memory is enabled, active AI agent sessions (Claude, Codex, Gemini, OpenCode, Cursor, Copilot CLI, Copilot Chat), the **AI Summary Provider** row showing what the next commit will actually use (Anthropic / Anthropic (env) / Jolli / Local agent — clicking it opens Settings), the API-key warning when neither provider has credentials, and per-integration "detected but disabled" rows. The overlay's own toolbar holds either **Sign In to Jolli** or **Sign Out of Jolli** (mutually exclusive based on auth state), **Disable Jolli Memory** (`$(circle-slash)`), and **Refresh** (`$(refresh)`). When the extension is currently disabled, an **Enable Jolli Memory** (`$(circle-filled)`) button is shown instead. A small busy indicator appears while a queue worker is running. |

---

## How it works

Jolli Memory runs entirely in the background using two types of hooks, you don't need to do anything special.

### AI Agent Hooks: knowing which sessions are active

When you use an AI coding agent, Jolli Memory keeps track of your active sessions so it knows where to find conversation context at commit time. These hooks **only record session metadata** (like a session ID and file path), they never read your conversation content.

| Agent | How sessions are tracked |
| -- | -- |
| **Claude Code** | A lightweight `StopHook` fires after each AI response; a `SessionStartHook` injects a mini-briefing at session start |
| **Gemini** | An `AfterAgent` hook fires after each agent completion |
| **Codex** | No hook needed — sessions are discovered automatically by scanning the filesystem |
| **OpenCode** | No hook needed — sessions are discovered automatically by reading OpenCode's global SQLite database (requires a host VS Code with Node 22.5+) |
| **Cursor IDE** (Composer) | No hook needed — sessions are discovered automatically by reading Cursor's SQLite stores at `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (macOS; equivalent paths on Linux/Windows) and the corresponding per-workspace `workspaceStorage/` databases |
| **GitHub Copilot CLI** | No hook needed — sessions are discovered automatically by scanning the Copilot CLI session log |
| **VS Code Copilot Chat** | No hook needed — sessions are discovered automatically by reading the Copilot Chat conversation cache |

### Git Hooks — generating summaries on commit

When you run `git commit`, three standard git hooks handle the rest:

1. **Before the commit**: detects if this is a squash or amend (so existing memories can be merged instead of regenerated)
2. **After the commit**: spawns a background process that reads the AI conversation + code diff, calls the LLM, and writes the summary. **Your commit returns instantly**, the summary is generated in the background (~10-20 seconds)
3. **After rebase/amend**: migrates existing summaries to match the new commit hashes, so nothing is lost

Every memory is dual-written to **both** the git orphan branch `jollimemory/summaries/v3` (the source of truth — completely separate from your code history) and the **Memory Bank** folder on disk. The orphan-branch copy is what the sidebar Branch tab and Summary Webview read from; the Memory Bank folder gives you a plain-Markdown copy you can read, `grep`, or pipe into other tools without going through the extension. Raw AI conversations are dual-written the same way (orphan branch + Memory Bank `transcripts/` subfolder, kept as JSON) and can be viewed, edited, or deleted from the extension.

**Worktree-aware:** switching branches (including across `git worktree` checkouts) refreshes every sidebar tab automatically — the current branch and its memories stay accurate regardless of which worktree you're in.

---

## Features

### AI Commit

Click **AI Commit** (sparkle icon, `$(sparkle)`) in the **Changes** section toolbar (inside the Branch tab) to generate a commit message from your staged changes. The LLM produces a focused one-line message; a picker lets you review and edit it before committing or amending.

### Push

Click **Push** (cloud-upload icon, `$(cloud-upload)`) to push the branch. If the push is rejected, a Force Push option is offered with a confirmation step.

### Squash

Select two or more commits, then click **Squash** (git-merge icon, `$(git-merge)`). The LLM generates a commit message using the topics and decisions captured in each commit's memory. Two actions are offered: squash only, or squash and push together.

Existing memories for all squashed commits are then consolidated by a second LLM call (`generateSquashConsolidation`) that produces a single rich summary preserving decision detail from every source commit — replacing the older mechanical merge that tended to lose context. The mechanical merge is still kept as a fallback for when the LLM call fails (e.g. offline / quota exhausted), so squash never silently drops memories.

### Summary Webview

Click the eye icon (`$(eye)`) on any commit to open a full memory panel. It shows:

* **All Conversations** (Private Zone): raw AI conversation transcripts stored locally on your machine. Browse by session tab, edit, delete, or restore entries. Your private data, nothing is uploaded unless you choose to.
* **Properties**: commit hash, branch, author, date, duration (working days), conversation count, and code change stats
* **Plans & Notes**: associated plans and notes with edit, remove, and add actions (plans, Markdown files, or inline text snippets)
* **Issue, page & conversation references** (Linear / Jira / GitHub / Notion / Slack / Zoom / Confluence / Asana / monday.com): any issues, tickets, pages, tasks, items, Slack threads, or Zoom meetings referenced in the AI conversation (via the corresponding MCP server) are extracted and rendered as first-class items — title, status / identifier where available, and a deep link back to the source. They follow the commit through squash / rebase the same way Plans and Notes do. For **Claude Code** these are extracted at commit time; for **Codex** (which has no commit-time hook) they are extracted on the sidebar's 60s polling tick.
* **E2E Test Guide**: AI-generated test scenarios with preconditions, steps, and expected results. Click "Generate" to create them on demand.
* **Source Commits** (for squash/amend): all contributing commits with diff stats and conversation counts
* **Topics**: each topic structured as:
  * ⚡ **Why This Change**: the trigger from the AI conversation
  * 💡 **Decisions Behind the Code**: key technical trade-offs and choices
  * ✅ **What Was Implemented**: what was actually built
* **Footer**: shows the **LLM provider** that produced this memory (Anthropic / Anthropic (env) / Jolli / Local agent), so a glance tells you which credential the call went through.

Action buttons:

* **Copy Markdown**: copies the full summary to clipboard
* **Share in Jolli**: publishes the summary (and associated plans and notes) to your Jolli Space. The Memory Bank folder on disk already holds a Markdown copy of every memory automatically — Share in Jolli is purely about cloud publishing.
* **Regenerate**: re-runs the LLM against the current commit's transcripts + diff, normalizes the result to the v4 tree, and replaces the previous summary in place. While the call is in flight, the panel enters a **regenerating-read-only** state (topics + recap dim, write actions disable, an inline banner explains the wait) and a final stale-write guard re-checks the commit hash inside the race window — so an amend / squash that lands mid-regenerate cannot clobber the new history.
* **Create & Update PR**: manages a GitHub PR for this commit

**Stale-commit read-only mode** — if the commit shown in the webview is rewritten by an amend / squash / rebase / branch switch while the panel is open, the panel stays open in a persistent **stale read-only** mode with an inline warning banner instead of silently disappearing mid-edit. All write paths (push, edit, regenerate, plan / note add-remove, …) re-check the commit hash inside the race window and bail out cleanly if the hash has moved on disk.

### Share in Jolli Space

Click **Share in Jolli** to publish the summary to your team's Jolli Space knowledge base. Jolli Space allows you to recall individual or shared memory for multiple devices or for different coding agent setups. Space team members can recall specific commits within the team.

Plans and notes (both Markdown files and text snippets) are each uploaded as separate articles first, so their URLs appear in the summary. The summary itself is published last. Each shared memory carries a **Task usage** line — total tokens, a cost estimate, and the input / output / cached split, aggregated across squashed and amended commits.

Requires a Jolli API Key configured via Settings (or auto-filled by **Sign In to Jolli** from the Status overlay).

### Local copies of memories

Every memory is automatically dual-written to your **Memory Bank** folder on disk alongside the canonical orphan-branch copy. See the [Memory Bank](#memory-bank) section below for how to point that folder at any location on disk you choose. The previous "Push to Jolli & Local" toggle has been retired — Memory Bank covers the local-copy use case automatically and on every commit, not just when you manually click Push.

### Plans & Notes

Jolli Memory automatically detects Claude Code Plan files from your session transcripts and displays them in the **Plans & Notes** section of the Branch tab. You can also add your own notes — short text snippets or imported Markdown files — to capture context that doesn't live in the AI conversation.

When you commit, active plans and notes are archived as snapshots in the orphan branch and associated with the commit.

**Adding items** — use the **+ Add** dropdown in the section toolbar (Branch tab → Plans & Notes), or inside the Summary Webview:

| Option | What it does |
| -- | -- |
| **Add Plan** | Pick from detected plans in `~/.claude/plans/` |
| **Add Markdown File** | Import an external `.md` file |
| **Add Text Snippet** | Open an inline form to write a quick note (title + content) |

From the Summary Webview, you can:

* **Preview** a committed plan or note
* **Edit** the item inline (changes are saved to the orphan branch)
* **Remove** a plan or note association from a commit
* **Associate** additional plans or notes with a commit

Text snippets display their content inline in the Summary Webview; Markdown notes show the filename. Hovering any plan in the Branch tab's Plans & Notes section shows a card with the title, source path, last-updated time, and a snippet of the plan body, so you can scan plans without opening each one.

### Memory Bank sync (cross-device)

Memory Bank **cloud sync** keeps your personal Memory Bank consistent across every device you sign in to. It runs **on demand**: open **Settings → Memory Bank** and click **Sync to Personal Space Now** (or run `jolli sync-memory-bank` from the CLI). There is no background timer running by default.

How it works:

1. Each time you trigger it, the bundled sync engine runs one round. Sync is a manual action — no background polling runs by default, and the old post-commit auto-trigger was removed to keep `git commit` instant.
2. Each round mints a short-lived credential from Jolli, clones (first time) or fetches your private vault repo, mirrors the local Memory Bank folder into the vault tree, commits, and pushes. The vault repo is **private** and visible only to you.
3. On the very first sync of a personal space that has Web-UI-only history, the plugin imports that legacy content into a `legacy/` subtree, pushes it, and tells Jolli to flip the space to git-backed. After that, every device sees the same git history.
4. If two devices push concurrently and conflict, the engine resolves the four `.jolli/<aggregate>.json` files deterministically (no prompts); other content conflicts go through an AI merge (if you've configured an Anthropic key) and finally a manual binary pick.

The status bar reflects the engine's state:

| Icon / text | Meaning |
| -- | -- |
| `$(check) Jolli Memory` | Synced — last round succeeded. |
| `$(sync~spin) Syncing…` | A round is in flight. |
| `$(warning) N conflicts` | One or more files are awaiting your manual choice; click the icon to open them. |
| `Jolli Memory` (neutral) | Last round hit a transient failure (network blip, backend hiccup); the next poll tick will retry. |
| `$(circle-slash) Offline` etc. | A persistent terminal failure (auth, repo missing, vault mismatch, …) exhausted retries — click for details. |

UI does not expose any GitHub-specific terminology — the vault repo is treated as an implementation detail. If your Memory Bank folder (`localFolder`) is **also** synced by iCloud / Dropbox / Syncthing, **turn one of them off** — overlapping syncs corrupt each other.

### Memory Bank tab

The **MEMORY BANK** tab is a cross-branch / cross-repo file tree of every stored memory. It reads from the dual-written Memory Bank folder on disk, so the same view works whether you're inside the current repo or browsing memories from a sibling repo whose memories have been migrated into the same root folder.

Tab toolbar actions (when the Memory Bank tab is active):

| Action | What it does |
| -- | -- |
| **Search** (`$(search)`) | Full-text search across every branch and repo in the Memory Bank; press **Enter** with empty input or click **Clear Filter** (`$(close)`) to reset. |
| **Tree / Timeline modes** | Toggle between **Tree** (folder hierarchy by repo / branch, the default — codicon `$(list-tree)`) and **Timeline** (chronological flat list by commit date — codicon `$(history)`). |
| **Reset** | Re-detect repo identities and rebuild the tree from disk. |
| **Build Knowledge Wiki** | Compile every repo in the Memory Bank into a topic-organized knowledge wiki (see below). |

**Knowledge wiki** — **Build Knowledge Wiki** gathers the memories scattered across your commits and folds work on the same theme into per-topic pages, so a feature touched by ten commits reads as one evolving page instead of ten disconnected entries. A browsable `_wiki/` folder is written into your Memory Bank, and the same topic pages back the MCP server's search and decision-timeline tools. You rarely need to click it: after each commit the extension incrementally folds new memories into the wiki in the background; the button is for an immediate, repo-wide rebuild. Needs an API key (same as summary generation).

**Knowledge graph** — each repo row in the Memory Bank tree has a **View knowledge graph** button (`$(type-hierarchy)`) that opens an interactive map of that wiki: categories, the knowledge units inside each (decisions, mechanisms, fixes), and the typed links between them (`extends`, `caused-by`, `supersedes`, `contradicts`, `related-to`). Click a unit to zoom in and reveal its related neighbors. The graph rebuilds incrementally in the background after each commit — if a repo doesn't have one yet, build the wiki first. The same visualization can be exported to a shareable HTML file from the CLI with `jolli graph`.

**Per-memory context menu** (right-click any memory file in the tree):

* **Copy Recall Prompt** — copies a prompt string designed to be pasted into your AI agent so it can recall that memory's context.
* **Open in Claude Code** — launches Claude Code with the recall prompt pre-loaded (requires Claude Code installed).
* **View Memory** — opens the full Summary Webview.

The legacy "Memories" panel and its **Search / Refresh / Open Settings / Enable / Disable** toolbar items have moved: search and reset live on the Memory Bank view itself, **Open Settings** is now in the view's title bar, and **Enable / Disable** moved to the **Status overlay**. The old in-extension **Export to Markdown** action has been retired — Memory Bank already keeps a Markdown copy of every memory on disk in your `localFolder`, so an explicit "export" step is redundant; if you still want a flat `.md` dump for a single branch, run `jolli export` from the CLI (writes to `~/Documents/jollimemory/`).

### Sign In to Jolli

From the **Status overlay**, click **Sign In to Jolli** to authenticate with a Jolli account via browser OAuth:

1. VS Code opens your default browser at the Jolli sign-in page.
2. After you sign in (or sign up), the browser tab closes automatically.
3. The extension receives an OAuth `authToken` and a `jolliApiKey` (`sk-jol-…`) and writes them to `~/.jolli/jollimemory/config.json`.

The `jolliApiKey` serves two purposes: it lets the LLM proxy handle summary generation (so you don't need to manage an Anthropic key directly), and it authorises pushing summaries to your Jolli Space. You can still set a manual Anthropic `apiKey` in Settings if you prefer your own account.

Click **Sign Out of Jolli** from the same toolbar to clear the stored credentials.

### Settings Panel

Click the gear icon (`$(gear)`) in the view's title bar (or any **Open Settings** action — there's also `Jolli Memory: Open Settings` in the command palette) to open a dedicated Settings webview. The layout is split into five tabs so each task is one-click reachable:

| Tab | What it controls |
| -- | -- |
| **AI Agents** | Per-source toggles for Claude / Codex / Gemini / OpenCode / Cursor / Copilot session tracking. Copilot CLI and VS Code Copilot Chat share a single switch. A **Global Instructions** toggle controls whether Jolli adds its "prefer these skills" note to your machine-global AI instruction files (`~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`) — off until you turn it on (or accept the one-time notice shown when you enable), and turning it off removes the note. |
| **AI Summary** | **Provider** dropdown (**Anthropic** / **Jolli** / **Local Agent**). The Anthropic card holds `apiKey`, `model`, and `maxTokens`. The Jolli card shows your sign-in state — *Signed-in & ready*, *Signed-in but missing key*, or *Signed-out* — and exposes `jolliApiKey` under an **Advanced** disclosure for power users. The Local Agent card selects the agent tool (`localAgentTool`, currently Claude Code) and drives that CLI's own subscription login — no API key needed. |
| **Sync to Jolli** | Sign-in / sign-out for pushing memories to your Jolli Space. |
| **Memory Bank** | The on-disk Markdown copy of your memories: pick a folder via **Browse…**, then optionally click **Migrate to Memory Bank** to re-migrate the current repo into a fresh `-N`-suffixed folder (the previous folder is left untouched). |
| **Others** | `excludePatterns` for the Changes section in the Branch tab, plus the **DCO sign-off** toggle — when on, **AI Commit** appends `Signed-off-by: <user.name> <user.email>` to its generated commit messages so they pass a DCO-gated CI without manual editing. Off by default. |

Changes are validated on save and persisted to `~/.jolli/jollimemory/config.json`. Click **Apply Changes** in the action bar to commit them.

### Changes section (Branch tab)

The **Changes** section in the Branch tab mirrors VS Code's Source Control view with a few extras:

* **Select / Deselect All** (`$(check-all)`) — stage or unstage everything visible in one click.
* **AI Commit** (`$(sparkle)`) — generate a commit message from the staged diff (see above).
* **Discard Changes** (right-click a file) — reverts unstaged changes for one file.
* **Discard Selected Changes** (toolbar, `$(discard)`) — reverts unstaged changes for every checked file after a confirmation prompt.
* **Exclude filter** — files matching the `excludePatterns` globs (configured in Settings) are hidden and auto-unstaged if they were previously staged.

### Memories section (Current Branch view)

The **Memories** section in the Current Branch view lists every commit on the current branch that isn't yet in main. Click a row to open its Summary Webview, or expand it in place to see the evidence (files and conversations) behind the memory.

* **Select / Deselect All** (`$(check-all)`) — choose which commits to squash.
* **Squash** (`$(git-merge)`) — merges selected commits with an LLM-generated message (see above).
* **Push** (`$(cloud-upload)`) — appears when only a single commit is selected or the branch has one commit ahead of its upstream; see Push above.
* **Copy Commit Hash** (right-click) — yanks the full SHA.

Once your branch is merged into main, the section switches to a **merged (read-only) mode** — summaries remain accessible for review while squash/push actions are hidden.

### Create & Update PR

Jolli Memory opens a dedicated **Create PR** view where you can review and edit the generated PR before it's opened:

* **Create PR**: pre-fills the description from your branch's memories (Plans, an E2E Test Guide, and a topic-by-topic summary, all folded so it stays scannable). Edit the title and body before you open it, and copy the body with one click. Creating the PR also shares the branch's memories with your team.
* **Update PR**: once the PR exists, the same view becomes **Update PR** and refreshes the summary as you add more work — without touching anything you wrote by hand. The button dims when there's nothing new to push.
* **Multi-commit PRs**: when a branch has several commits, the description rolls all of them up into one.

Jolli won't overwrite commits that only exist on the remote. Requires the `gh` CLI to be installed and authenticated.

### Memory Bank

Every repo automatically gets a plain-Markdown copy of every memory on disk, alongside the canonical storage on the `jollimemory/summaries/v3` orphan branch. The Memory Bank folder is created the first time the extension activates on a repo, and any pre-existing memories on the orphan branch are migrated into it without any action on your part.

From then on, every new memory is **dual-written**: the orphan branch remains the source of truth, and the Memory Bank folder holds a `.md` copy you can open, search, and version like any other file.

To change where the folder lives, open **Settings → Memory Bank**, click **Browse…** to pick a location, then click **Migrate to Memory Bank**. A fresh `-N`-suffixed folder is created at the new location and the previous folder is left in place on disk; nothing is deleted.


## Session Context Recall

Jolli Memory feeds prior development context back into your AI agent so it can pick up where you (or a teammate) left off.

**Automatic briefing** — every time a new Claude Code session starts, a `SessionStartHook` injects a lightweight briefing (~300–500 tokens) into the conversation: branch name, commit count, date range, and last commit message. If it has been more than 3 days since the last commit, it suggests running the full recall command. This runs in under 200 ms and never blocks session startup.

**Full recall** — run `/jolli-recall` inside Claude Code (or any agent that supports it) to load the complete branch history: summaries, plans, decisions, and file-change statistics (default budget ≈ 50,000 tokens; pass `--budget` on the underlying `jolli recall` to adjust). The agent then reports what the branch is implementing, key technical decisions, what was last worked on, and the main files involved — so you can continue without re-reading the code.

If the current branch has no memories, the command shows a catalog of branches that do, letting you pick one to recall. You can also pass a branch name or keyword as an argument (e.g. `/jolli-recall auth-refactor`).

**Ask your agent directly (MCP server)** — when the extension enables a repo, it also registers a JolliMemory **MCP server** in that project's `.mcp.json`. The next time Claude Code starts, it can query your history conversationally — search past memories, recall a branch, trace how a decision evolved, and list which branches have memories — without you running any command. The `.mcp.json` entry is added to `.git/info/exclude` so it never gets committed (it points at a machine-local path). The server is bundled with the extension, so no separate CLI install is required.

---

## Configuration

Most settings live behind the gear icon in the view's title bar. `authToken` is written automatically by **Sign In to Jolli** (in the Status overlay), and `logLevel` is editable via the `jolli configure` CLI. All settings are stored globally in `~/.jolli/jollimemory/config.json` and shared across every project on your machine:

| Field | Type | Default | Description |
| -- | -- | -- | -- |
| `apiKey` | string | `$ANTHROPIC_API_KEY` | Your Anthropic API key for AI summarization (generate one at [platform.anthropic.com](https://platform.claude.com/)) |
| `aiProvider` | enum | (auto) | Pin which provider generates summaries: `"anthropic"` (use `apiKey` / `$ANTHROPIC_API_KEY`), `"jolli"` (use `jolliApiKey`), or `"local-agent"` (drive a locally-installed AI CLI). When unset, the resolver picks the first available in the order `apiKey` → `$ANTHROPIC_API_KEY` → `jolliApiKey`, so existing configs keep working. The **AI Summary** Settings tab writes this field. |
| `localAgentTool` | enum | `claude-code` | Which local Agent CLI to drive when `aiProvider` is `"local-agent"`. Currently only `claude-code`. |
| `localAgentPath` | string | (PATH) | Explicit path to the local agent binary, overriding `PATH` discovery. Used only when `aiProvider` is `"local-agent"`. |
| `model` | string | `claude-sonnet-4-6` | Model used for summarization. Accepts an alias (`sonnet`, `haiku`) or a full model ID. |
| `maxTokens` | integer | model default | Max output tokens per summarization call |
| `jolliApiKey` | string | — | Jolli Space API key for pushing summaries to your team knowledge base |
| `authToken` | string | — | OAuth token set automatically by **Sign In to Jolli** — not edited manually |
| `logLevel` | enum | `info` | Verbosity of `debug.log`: `debug`, `info`, `warn`, `error` (set via `jolli configure` CLI) |
| `claudeEnabled` | boolean | auto-detect | Enable Claude Code session tracking |
| `codexEnabled` | boolean | auto-detect | Enable Codex session discovery |
| `geminiEnabled` | boolean | auto-detect | Enable Gemini session tracking |
| `openCodeEnabled` | boolean | auto-detect | Enable OpenCode session discovery (requires a host VS Code with Node 22.5+) |
| `cursorEnabled` | boolean | auto-detect | Enable Cursor IDE (Composer) session discovery |
| `copilotEnabled` | boolean | auto-detect | Enable GitHub Copilot CLI **and** VS Code Copilot Chat session discovery (single shared switch) |
| `localFolder` | string | — | Memory Bank folder root — every memory is dual-written here as Markdown alongside the orphan-branch copy. Set via Settings → Memory Bank → Browse…. |
| `excludePatterns` | string[] | — | Glob patterns for hiding files from the Changes section in the Branch tab |
| `syncTranscripts` | boolean | `false` | When syncing, also mirror raw conversation transcripts (not just summaries) into the personal vault. Off by default so transcripts stay local unless you opt in. |
| `dcoSignoff` | boolean | `false` | Append `Signed-off-by: <user.name> <user.email>` to commits created by **AI Commit**. Off by default; turn on if your project's CI gates merges on a DCO sign-off. Set via Settings → Others. |

---

## Summary Format

Each memory uses a **v3 tree structure**: a single commit can cover multiple independent topics, and commits related through amend/squash operations form parent-child trees.

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

**Topic fields**: `trigger` (what prompted the work), `response` (what was built), `decisions` (design rationale — may include Markdown tables), `todo` (optional follow-up), `category` (one of `feature`, `bugfix`, `refactor`, `tech-debt`, `performance`, `security`, `test`, `docs`, `ux`, `devops`), `importance` (`major` or `minor`).

For CLI export usage (`jolli export`) and programmatic consumption, see the [`@jolli.ai/cli` README](https://github.com/jolliai/jolliai/tree/main/cli#summary-format).

## Privacy

### At summary generation time (after each commit)

To produce a summary, Jolli Memory reads your active AI session transcripts and the git diff locally, then sends them together to a summarization backend:

* If an **Anthropic `apiKey`** is configured — transcripts + diff are sent **directly to Anthropic**.
* If only a **`jolliApiKey`** is configured (you signed in with **Sign In to Jolli**) — transcripts + diff are sent to the **Jolli LLM proxy**, which forwards them to Anthropic on your behalf. The proxy **does not persist the transcripts or diff, and does not write them to any Jolli-side log** — payloads are held in memory only for the duration of the request and discarded once Anthropic responds.

The generated summary is then dual-written locally — to the git orphan branch (the source of truth) and to the Memory Bank folder on disk (canonical JSON at `<localFolder>/<repo>/.jolli/summaries/<commitHash>.json` plus human-readable Markdown at `<localFolder>/<repo>/<branch>/<slug>-<hash8>.md`), where `<localFolder>` is your configured Memory Bank root (one root can hold multiple repos, each in its own `<repo>/` subfolder). Raw transcripts are dual-written the same way: to `transcripts/<commitHash>.json` on the orphan branch and to `<localFolder>/<repo>/.jolli/transcripts/<commitHash>.json` in the Memory Bank folder. The Summary Webview's **All Conversations** section reads from the orphan-branch copy.

### At Share in Jolli time (only when you click Share)

Only the **generated summary** (Markdown + properties) and any **associated plans and notes** are uploaded to your Jolli Space. **Raw transcripts are never sent to Jolli Space** — they stay local.

### Session metadata

Session IDs, transcript file paths, and timestamps are stored locally in `<projectDir>/.jolli/jollimemory/sessions.json` (per-project, gitignored). Never uploaded anywhere.

### What stays 100% local

Two `.jolli/jollimemory/` directories carry local state, both stay on your disk unless one of the specific actions above is triggered:

- `~/.jolli/jollimemory/` (machine-global) — `config.json` (apiKey / authToken / jolliApiKey), hook entry scripts, dist-path indirection.
- `<projectDir>/.jolli/jollimemory/` (per-project, gitignored) — `sessions.json` (session metadata), `plans.json`, `notes/`, `cursors.json`, `git-op-queue/`, `briefing-cache.json`, `debug.log`, and the manual-disable opt-out marker.

Every entry on the `jollimemory/summaries/v3` orphan branch — and its mirror in the Memory Bank folder, including the raw transcripts shown in **All Conversations** — also stays on your disk unless the specific actions above are triggered.

### Usage telemetry (anonymous, opt-out)

Separately from your memory content, Jolli Memory collects **anonymous, content-free usage telemetry** to understand which features are used and where things break. It is **on by default** and you'll see a one-time notice on first run with **Learn more** and **Turn off** buttons.

- **What is sent** — event names (e.g. `app_installed`, `ingest_completed`, `sync_completed`), the surface and version (`vscode` + version), OS / arch / runtime version, a random `installId` (a UUID generated on this machine), and coarse, bucketed counts. Nothing else.
- **What is never sent** — your code, file paths, commit messages, diffs, transcripts, memory/summary content, repo names, branch names, API keys, or any account identifier. Property values are scrubbed before they leave your machine, and the payload carries no account ID.

**Turn it off (any one of these):**

- VS Code's own telemetry setting — `telemetry.telemetryLevel: "off"` disables Jolli telemetry too (we honor `vscode.env.isTelemetryEnabled`, and changes take effect immediately).
- Click **Turn off** on the first-run notice.
- Run `jolli telemetry off` in a terminal, or set `DO_NOT_TRACK=1`.

See <https://jolli.ai/telemetry> for the full event list.

## Support

* **Issues & feature requests** — [GitHub Issues](https://github.com/jolliai/jolliai/issues)
* **Jolli Space onboarding / enterprise** — support@jolli.ai
* **CLI reference & troubleshooting** — see the [`@jolli.ai/cli` README](https://github.com/jolliai/jolliai/tree/main/cli)

## License

[Apache License 2.0](https://github.com/jolliai/jolliai/blob/main/LICENSE)
