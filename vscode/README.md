# Jolli Memory

> *Every commit deserves a Memory. Every memory deserves a Recall.*

**Jolli Memory** automatically turns your AI coding sessions into structured development documentation attached to every commit, without any extra effort.

When you work with AI agents like Claude Code, Codex, Gemini CLI, or OpenCode, the reasoning behind every decision lives in the conversation: *why this approach was chosen, what alternatives were considered, what problems came up along the way*. The moment you commit, that context is gone. Jolli Memory captures it automatically.

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

1. Click the Jolli icon in the activity bar to open the sidebar.
2. In the **Status** panel, either click **Sign In to Jolli** (OAuth) or open the **Settings** gear icon and paste an Anthropic API key.
3. Click `(⊘)` in the Status panel to install git hooks in the current repository.
4. Restart any active AI agent session (Claude Code / Codex / Gemini / OpenCode) so hooks take effect.
5. Make a commit as usual — the summary appears in the **Commits** panel within ~10-20 seconds.

---

## What it does

After each commit, Jolli Memory reads your selected AI session transcripts and the code diff, calls the LLM to produce a structured summary, and stores it alongside the commit silently in the background. The VS Code extension surfaces everything in a sidebar so you can manage plans, stage files, write AI-assisted commit messages, review summaries, and share them, without leaving your editor.

### The sidebar has five panels

| Panel | What it shows |
| -- | -- |
| **Status** | Whether Jolli Memory is enabled, active AI agent sessions (Claude, Codex, Gemini, OpenCode), and how many memories are stored. Toggle Jolli Memory on/off with the `(●)` / `(⊘)` buttons; sign in or out of your Jolli account via the **Sign In to Jolli** / **Sign Out of Jolli** actions in the same panel toolbar. |
| **Memories** | Every stored memory across all branches, with instant search and filter. Click `(🔍)` in the panel title bar to filter by keyword, or click the **Load More** item at the bottom of the list to fetch older entries. |
| **Plans & Notes** | Plans auto-detected from Claude Code sessions, plus your own notes (text snippets or imported Markdown files). Edit, remove, or associate items with commits. Use the **+ Add** dropdown to add a plan, a Markdown file, or a quick text snippet. |
| **Changes** | All changed files with checkboxes to stage or unstage. Supports an exclude filter for hiding irrelevant files. |
| **Commits** | Every commit on the current branch not yet in main. Click `(👁)` to open the full AI summary. |

---

## How it works

Jolli Memory runs entirely in the background using two types of hooks, you don't need to do anything special.

### AI Agent Hooks: knowing which sessions are active

When you use an AI coding agent, Jolli Memory keeps track of your active sessions so it knows where to find conversation context at commit time. These hooks **only record session metadata** (like a session ID and file path), they never read your conversation content.

| Agent | How sessions are tracked |
| -- | -- |
| **Claude Code** | A lightweight `StopHook` fires after each AI response; a `SessionStartHook` injects a mini-briefing at session start |
| **Gemini CLI** | An `AfterAgent` hook fires after each agent completion |
| **Codex CLI** | No hook needed — sessions are discovered automatically by scanning the filesystem |
| **OpenCode** | No hook needed — sessions are discovered automatically by reading OpenCode's global SQLite database (requires a host VS Code with Node 22.5+) |

### Git Hooks — generating summaries on commit

When you run `git commit`, three standard git hooks handle the rest:

1. **Before the commit**: detects if this is a squash or amend (so existing memories can be merged instead of regenerated)
2. **After the commit**: spawns a background process that reads the AI conversation + code diff, calls the LLM, and writes the summary. **Your commit returns instantly**, the summary is generated in the background (~10-20 seconds)
3. **After rebase/amend**: migrates existing summaries to match the new commit hashes, so nothing is lost

Everything is stored in a git orphan branch (`jollimemory/summaries/v3`), completely separate from your code history. Raw AI conversations are optionally preserved alongside the summaries and can be viewed, edited, or deleted from the extension.

**Worktree-aware:** switching branches (including across `git worktree` checkouts) refreshes every sidebar panel automatically — the current branch and its memories stay accurate regardless of which worktree you're in.

---

## Features

### AI Commit `(✦)`

Click **✦ AI Commit** in the Changes panel toolbar to generate a commit message from your staged changes. The LLM produces a focused one-line message; a picker lets you review and edit it before committing or amending.

### Push `(↑)`

Click **↑ Push** to push the branch. If the push is rejected, a Force Push option is offered with a confirmation step.

### Squash `(⊞)`

Select two or more commits, then click **⊞ Squash**. The LLM generates a commit message using the topics and decisions captured in each commit's memory. Two actions are offered: squash only, or squash and push together.

Existing memories for all squashed commits are automatically merged — no extra AI call needed for that step.

### Summary Webview `(👁)`

Click **👁** on any commit to open a full memory panel. It shows:

* **All Conversations** (Private Zone): raw AI conversation transcripts stored locally on your machine. Browse by session tab, edit, delete, or restore entries. Your private data, nothing is uploaded unless you choose to.
* **Properties**: commit hash, branch, author, date, duration (working days), conversation count, and code change stats
* **Plans & Notes**: associated plans and notes with edit, remove, and add actions (plans, Markdown files, or inline text snippets)
* **E2E Test Guide**: AI-generated test scenarios with preconditions, steps, and expected results. Click "Generate" to create them on demand.
* **Source Commits** (for squash/amend): all contributing commits with diff stats and conversation counts
* **Topics**: each topic structured as:
  * ⚡ **Why This Change**: the trigger from the AI conversation
  * 💡 **Decisions Behind the Code**: key technical trade-offs and choices
  * ✅ **What Was Implemented**: what was actually built

Action buttons:

* **Copy Markdown**: copies the full summary to clipboard
* **Push to Jolli** / **Push to Jolli & Local**: publishes the summary (and associated plans and notes) to your Jolli Space. The **& Local** variant additionally saves a Markdown copy to the folder configured in **Settings → Local Memories**. Pick the default mode from that same Settings section.
* **Create & Update PR**: manages a GitHub PR for this commit

### Push to Jolli Space

Click **Push to Jolli** to publish the summary to your team's Jolli Space knowledge base. Jolli Space allows you to recall individual or shared memory for multiple devices or for different coding agent setups. Space team members can recall specific commits within the team.

Plans and notes (both Markdown files and text snippets) are each uploaded as separate articles first, so their URLs appear in the summary. The summary itself is published last. 

Requires a Jolli API Key configured in the **Status** panel settings. Please contact support@jolli.ai with your name and email address.

### Local Memories

As an alternative — or a complement — to Jolli Space, you can save every pushed memory as a Markdown file on your own machine. Useful for archiving, syncing via Dropbox/Drive, or keeping an offline record.

**Configure** (Settings → **Local Memories**):

1. Click **Browse…** to choose a target folder — stored as the `localFolder` config.
2. Under **Default Push Action**, pick one:
   * **Push to Jolli only** (default) — the Push button publishes to your Jolli Space.
   * **Push to Jolli & Local** — the Push button publishes to Jolli Space **and** writes a Markdown copy to the folder above.
3. The **Push to Jolli & Local** option is disabled until a local folder is selected.

Once configured, the Summary Webview's Push button label reflects the chosen mode.

### Plans & Notes

Jolli Memory automatically detects Claude Code Plan files from your session transcripts and displays them in the **Plans & Notes** sidebar panel. You can also add your own notes — short text snippets or imported Markdown files — to capture context that doesn't live in the AI conversation.

When you commit, active plans and notes are archived as snapshots in the orphan branch and associated with the commit.

**Adding items** — use the **+ Add** dropdown in the panel toolbar or inside the Summary Webview:

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

Text snippets display their content inline in the Summary Webview; Markdown notes show the filename.

### Memories Panel

The **Memories** panel lists every stored memory across all branches of this repository. Toolbar actions:

| Action | Icon | What it does |
| -- | -- | -- |
| **Search Memories** | `(🔍)` | Filter memories by keyword; click **Clear Filter** `(✕)` to reset |
| **Refresh Memories** | `(⟳)` | Re-read the orphan branch |
| **Export Memories to Markdown** | `(↗)` | Write every memory on the current branch as `.md` files to `~/Documents/jollimemory/` |
| **Open Settings** | `(⚙)` | Open the Settings panel (see below) |
| **Enable / Disable Jolli Memory** | `(●)` / `(⊘)` | Install or remove hooks |

**Load More** at the bottom of the list fetches older entries on long branches.

**Per-memory context menu** (right-click any memory):

* **Copy Recall Prompt** — copies a prompt string designed to be pasted into your AI agent so it can recall that memory's context.
* **Open in Claude Code** — launches Claude Code with the recall prompt pre-loaded (requires Claude Code installed).
* **View Memory** — opens the full Summary Webview.

### Sign In to Jolli

From the **Status** panel toolbar, click **Sign In to Jolli** to authenticate with a Jolli account via browser OAuth:

1. VS Code opens your default browser at the Jolli sign-in page.
2. After you sign in (or sign up), the browser tab closes automatically.
3. The extension receives an OAuth `authToken` and a `jolliApiKey` (`sk-jol-…`) and writes them to `~/.jolli/jollimemory/config.json`.

The `jolliApiKey` serves two purposes: it lets the LLM proxy handle summary generation (so you don't need to manage an Anthropic key directly), and it authorises pushing summaries to your Jolli Space. You can still set a manual Anthropic `apiKey` in Settings if you prefer your own account.

Click **Sign Out of Jolli** from the same toolbar to clear the stored credentials.

### Settings Panel

Click the gear icon `(⚙)` in the Memories panel toolbar (or any **Open Settings** action) to open a dedicated Settings webview with grouped sections:

* **Authentication** — Anthropic `apiKey`, `model`, `maxTokens`, `jolliApiKey`
* **Integrations** — toggles for Claude / Codex / Gemini / OpenCode session tracking
* **Local Memories** — `localFolder` + default `pushAction` (see above)
* **Files** — `excludePatterns` for the Changes panel

Changes are validated on save and persisted to `~/.jolli/jollimemory/config.json`.

### Changes Panel

The **Changes** panel mirrors VS Code's Source Control view with a few extras:

* **Select / Deselect All** `(✓)` — stage or unstage everything visible in one click.
* **AI Commit** `(✦)` — generate a commit message from the staged diff (see above).
* **Discard Changes** (right-click a file) — reverts unstaged changes for one file.
* **Discard Selected Changes** (toolbar) — reverts unstaged changes for every checked file after a confirmation prompt.
* **Exclude filter** — files matching the `excludePatterns` globs (configured in Settings) are hidden and auto-unstaged if they were previously staged.

### Commits Panel

The **Commits** panel lists every commit on the current branch that isn't yet in main. Click `(👁)` on any commit to open its Summary Webview.

* **Select / Deselect All** `(✓)` — choose which commits to squash.
* **Squash** `(⊞)` — merges selected commits with an LLM-generated message (see above).
* **Push** `(↑)` — appears when only a single commit is selected or the branch has one commit ahead of its upstream; see Push above.
* **Copy Commit Hash** (right-click) — yanks the full SHA.

Once your branch is merged into main, the panel switches to a **merged (read-only) mode** — summaries remain accessible for review while squash/push actions are hidden.

### Create & Update PR

At the bottom of every memory panel, Jolli Memory can create or update a GitHub Pull Request:

* **Create PR**: pre-fills the PR description with a structured summary: Jolli Memory URL → Plans → E2E Test Guide → Topics (Why → Decisions → What → Future Enhancements → Files). All topic bodies are folded by default so the PR stays scannable.
* **Update PR**: refreshes the summary section in place (using `<!-- jollimemory-summary -->` markers) without affecting any text you've added manually.

Requires the `gh` CLI to be installed and authenticated.


## Session Context Recall

Jolli Memory feeds prior development context back into your AI agent so it can pick up where you (or a teammate) left off.

**Automatic briefing** — every time a new Claude Code session starts, a `SessionStartHook` injects a lightweight briefing (~300 tokens) into the conversation: branch name, commit count, date range, and last commit message. If it has been more than 3 days since the last commit, it suggests running the full recall command. This runs in under 200 ms and never blocks session startup.

**Full recall** — run `/jolli-recall` inside Claude Code (or any agent that supports it) to load the complete branch history: summaries, plans, decisions, and file-change statistics (up to ~30 000 tokens). The agent then reports what the branch is implementing, key technical decisions, what was last worked on, and the main files involved — so you can continue without re-reading the code.

If the current branch has no memories, the command shows a catalog of branches that do, letting you pick one to recall. You can also pass a branch name or keyword as an argument (e.g. `/jolli-recall auth-refactor`).

---

## Configuration

Most settings can be configured directly from the **Status** panel in the sidebar — `authToken` is written automatically by the **Sign In to Jolli** action on the Status panel toolbar, and `logLevel` is editable via the `jolli configure` CLI. All settings are stored globally in `~/.jolli/jollimemory/config.json` and shared across every project on your machine:

| Field | Type | Default | Description |
| -- | -- | -- | -- |
| `apiKey` | string | `$ANTHROPIC_API_KEY` | Your Anthropic API key for AI summarization (generate one at [platform.anthropic.com](https://platform.claude.com/)) |
| `model` | string | `claude-haiku-4-5-20251001` | Model used for summarization. Accepts an alias (`sonnet`, `haiku`) or a full model ID. |
| `maxTokens` | integer | model default | Max output tokens per summarization call |
| `jolliApiKey` | string | — | Jolli Space API key for pushing summaries to your team knowledge base |
| `authToken` | string | — | OAuth token set automatically by **Sign In to Jolli** — not edited manually |
| `logLevel` | enum | `info` | Verbosity of `debug.log`: `debug`, `info`, `warn`, `error` (set via `jolli configure` CLI) |
| `claudeEnabled` | boolean | auto-detect | Enable Claude Code session tracking |
| `codexEnabled` | boolean | auto-detect | Enable Codex CLI session discovery |
| `geminiEnabled` | boolean | auto-detect | Enable Gemini CLI session tracking |
| `openCodeEnabled` | boolean | auto-detect | Enable OpenCode session discovery (requires a host VS Code with Node 22.5+) |
| `localFolder` | string | — | Absolute path where **Push to Jolli & Local** writes Markdown copies of pushed summaries |
| `pushAction` | enum | `jolli` | Default Push action: `jolli` (Jolli Space only) or `both` (Jolli Space + local folder) |
| `excludePatterns` | string[] | — | Glob patterns for hiding files from the Changes panel |

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

The generated summary is then written to the git orphan branch locally, and the raw transcripts are preserved alongside it so you can review them later in the Summary Webview's **All Conversations** section.

### At Push to Jolli time (only when you click Push)

Only the **generated summary** (Markdown + properties) and any **associated plans and notes** are uploaded to your Jolli Space. **Raw transcripts are never sent to Jolli Space** — they stay local.

### Session metadata

Session IDs, transcript file paths, and timestamps are stored locally in `~/.jolli/jollimemory/`. Never uploaded anywhere.

### What stays 100% local

Every file under `~/.jolli/jollimemory/`, every entry on the `jollimemory/summaries/v3` orphan branch, and every raw transcript fragment shown in **All Conversations** — all of it is read-only on your disk unless the specific actions above are triggered.

## Support

* **Issues & feature requests** — [GitHub Issues](https://github.com/jolliai/jolliai/issues)
* **Jolli Space onboarding / enterprise** — support@jolli.ai
* **CLI reference & troubleshooting** — see the [`@jolli.ai/cli` README](https://github.com/jolliai/jolliai/tree/main/cli)

## License

[Apache License 2.0](https://github.com/jolliai/jolliai/blob/main/LICENSE)
