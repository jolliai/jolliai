# Jolli Memory

> *Every commit deserves a Memory. Every memory deserves a Recall.*

**Jolli Memory** automatically turns your AI coding sessions into structured development documentation attached to every commit, without any extra effort.

When you work with AI agents like Claude Code, Codex, or Gemini CLI, the reasoning behind every decision lives in the conversation: *why this approach was chosen, what alternatives were considered, what problems came up along the way*. The moment you commit, that context is gone. Jolli Memory captures it automatically.

---

## What it does

After each commit, Jolli Memory reads your selected AI session transcripts and the code diff, calls the LLM to produce a structured summary, and stores it alongside the commit silently in the background. The VS Code extension surfaces everything in a sidebar so you can manage plans, stage files, write AI-assisted commit messages, review summaries, and share them, without leaving your editor.

### The sidebar has five panels

| Panel | What it shows |
| -- | -- |
| **Status** | Whether Jolli Memory is enabled, active AI agent sessions (Claude, Codex, Gemini), and how many memories are stored. Toggle on/off with the `(●)` / `(⊘)` buttons. |
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

### Git Hooks — generating summaries on commit

When you run `git commit`, three standard git hooks handle the rest:

1. **Before the commit**: detects if this is a squash or amend (so existing memories can be merged instead of regenerated)
2. **After the commit**: spawns a background process that reads the AI conversation + code diff, calls the LLM, and writes the summary. **Your commit returns instantly**, the summary is generated in the background (~10-20 seconds)
3. **After rebase/amend**: migrates existing summaries to match the new commit hashes, so nothing is lost

Everything is stored in a git orphan branch (`jollimemory/summaries/v3`), completely separate from your code history. Raw AI conversations are optionally preserved alongside the summaries and can be viewed, edited, or deleted from the extension.

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
* **Summaries**: each topic structured as:
  * ⚡ **Why This Change**: the trigger from the AI conversation
  * 💡 **Decisions Behind the Code**: key technical trade-offs and choices
  * ✅ **What Was Implemented**: what was actually built

Action buttons:

* **Copy Markdown**: copies the full summary to clipboard
* **Push to Jolli**: publishes the summary (and associated plans and notes) to your Jolli Space
* **Create & Update PR**: manages a GitHub PR for this commit

### Push to Jolli Space

Click **Push to Jolli** to publish the summary to your team's Jolli Space knowledge base. Jolli Space allows you to recall individual or shared memory for multiple devices or for different coding agent setups. Space team members can recall specific commits within the team.

Plans and notes (both Markdown files and text snippets) are each uploaded as separate articles first, so their URLs appear in the summary. The summary itself is published last. 

Requires a Jolli API Key configured in the **Status** panel settings. Please contact support@jolli.ai with your name and email address.

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

### Create & Update PR

At the bottom of every memory panel, Jolli Memory can create or update a GitHub Pull Request:

* **Create PR**: pre-fills the PR description with a streamlined summary: Jolli Memory URL → Plans → E2E Test Guide → Summaries (Why → Decisions → What). Only includes information not already visible on the GitHub PR page.
* **Update PR**: refreshes the summary section in place (using `<!-- jollimemory-summary -->` markers) without affecting any text you've added manually.

Requires the `gh` CLI to be installed and authenticated.


## Session Context Recall

Jolli Memory feeds prior development context back into your AI agent so it can pick up where you (or a teammate) left off.

**Automatic briefing** — every time a new Claude Code session starts, a `SessionStartHook` injects a lightweight briefing (~300 tokens) into the conversation: branch name, commit count, date range, and last commit message. If it has been more than 3 days since the last commit, it suggests running the full recall command. This runs in under 200 ms and never blocks session startup.

**Full recall** — run `/jolli-recall` inside Claude Code (or any agent that supports it) to load the complete branch history: summaries, plans, decisions, and file-change statistics (up to ~30 000 tokens). The agent then reports what the branch is implementing, key technical decisions, what was last worked on, and the main files involved — so you can continue without re-reading the code.

If the current branch has no memories, the command shows a catalog of branches that do, letting you pick one to recall. You can also pass a branch name or keyword as an argument (e.g. `/jolli-recall auth-refactor`).

---

## Configuration

All settings can be configured directly from the **Status** panel in the sidebar, no need to edit files manually. They are stored globally in `~/.jolli/jollimemory/config.json` and shared across every project on your machine:

| Field | Type | Default | Description |
| -- | -- | -- | -- |
| `apiKey` | string | `$ANTHROPIC_API_KEY` | Your Anthropic API key for AI summarization (generate one at [platform.anthropic.com](https://platform.claude.com/)) |
| `model` | string | `claude-haiku-4-5-20251001` | Model used for summarization |
| `jolliApiKey` | string | — | Jolli Space API key for pushing summaries to your team knowledge base |
| `excludePatterns` | string[] | — | Glob patterns for hiding files from the Changes panel |
