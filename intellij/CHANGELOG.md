# Changelog

## Unreleased

### Changes

- **The `/jolli-pr` skill has been removed** — only `jolli-recall` and `jolli-search` are installed now. Generating a PR description from a branch's memories is still available through the `get_pr_description` MCP tool and the `jolli pr-description` command; upgrading removes any previously-installed `jolli-pr` skill file automatically.

## 0.99.8

### New Features

- **Slack thread references** — Slack threads read through the Slack MCP server in your AI conversations are now captured as a fifth reference source, right alongside Linear, Jira, GitHub, and Notion, and shown in the committed-memory and working-memory views. A pasted thread permalink is picked up with zero configuration (including from plain-text messages); without one, a `slack.workspaceUrl` configured in Settings reconstructs the link — the URL is validated (HTTPS, `slack.com` host) when you save it.
- **Smarter about what goes into a memory** — plans, notes, and references are now ranked for relevance against your change in one batched AI call before summarizing. Items judged clearly unrelated are left out of the summary and kept in the working area for a later commit; excluded items stay visible in the memory detail view and the folder Markdown for traceability. If the ranking call fails, summarization proceeds with the full set — it never blocks a commit.
- **Agent guidance is now opt-in** — Jolli only teaches your AI agents to prefer it (via a managed block in `~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, and `~/.codex/AGENTS.md`) once you turn it on under **Settings → Agents**. The decision is stored in the shared config, so the CLI, VS Code, and IntelliJ all honor the same choice. All three skills (`jolli-recall`, `jolli-search`, `jolli-pr`) are now installed with the current MCP-preferring content.
- **Token usage travels with pushed memories** — the article pushed to your Jolli Space now carries the same **Task usage** line as the CLI and VS Code (token total, estimated cost, input/output/cached split), and the raw token figures are sent along with the push.

### Fixes & Improvements

- Auto-sync on push can now sync the queued summaries synchronously in one batch during `git push`, instead of only handing them to the background worker
- Reference discovery no longer drops tool calls split across a scan boundary, so references near chunk edges are reliably captured
- The CLI, VS Code, and IntelliJ stopped rewriting each other's installed skill files — skill updates are now guarded by a shared revision number instead of per-tool version strings
- More reliable anonymous usage telemetry (still content-free): events carry deduplication ids, are batched and flushed in the background and at exit, benign no-op ingests are no longer reported as errors, and new or upgraded installs and key panel actions are counted

## 0.99.7

### New Features

- **Auto-sync on push** — `git push` now automatically syncs the pushed commits' summaries to your Jolli Space in the background. The pre-push hook is lightweight (config read, stdin parse, one JSON write, spawn) and never blocks the push; the actual network sync runs in a detached worker. Failed syncs are retried on the next push, after the queue worker finishes a post-commit drain, and each time the IDE or CLI activates — so nothing is lost even if the network is flaky. Opt out with `syncOnPush: false` in config.
- **More accurate cost estimates** — each memory is now priced by the model that actually generated it (Opus / Sonnet / Haiku) instead of a flat Sonnet rate.

### Fixes & Improvements

- Safer pushing — the pre-push step now tidies up leftover memory data and retries the sync if a push races with it, so nothing gets left behind
- Stale push-pending entries are pruned automatically after 7 days, keeping the state directory clean between pushes

## 0.99.6

### Fixes & Improvements

- Bug fixes

## 0.99.5

### New Features

- **Build memory from your history** — open a repository that has no memory yet (or has recent commits without one) and a **BUILD MEMORY** card now offers to generate summaries for those past commits. Pick which commits to reconstruct — each row shows how many AI conversations were attributed to it — then watch per-commit progress and a final summary. Run a full back-fill any time from **Settings → Memory Bank → Generate Missing Summaries**, and dismiss the card per repository (the choice is shared with the VS Code extension, so a dismiss in one is honored in the other).
- **Share a memory to Jolli** — share an individual commit memory to your Jolli site straight from the memory detail view via an inline overlay (no separate dialog). Creating a pull request continues to share that PR's memories in the same step, so sharing works at both the single-memory and the PR level.
- **Token usage & estimated cost** — the memory detail view and the Committed Memories list now show token usage (input / output / cached) and an estimated USD cost — your stored per-model figure when available, otherwise a Sonnet-rate estimate for token-only memories — aggregated across squash/amend trees. The same **Task usage** line is now included in the memory you share or export to Jolli, so the cost estimate travels with the memory.
- **Resume a Codex session** — Codex conversations can now be resumed directly, using the correct session-ID lookup.

### Changes

- **Force-push protection** — the push and Create PR flows now detect when the remote branch has been rewritten (a non-fast-forward) and gate the force-push behind a confirmation; the git checks run off the UI thread so the IDE stays responsive.
- **Minimum IDE is now IntelliJ IDEA 2025.1** (build 251). This lets the plugin use current, non-deprecated platform APIs (e.g. the file-save dialog), clearing a Marketplace compatibility warning.

### Fixes & Improvements

- **Self-healing MCP config** — `.mcp.json` is repaired automatically when it points at an extension dist that has been removed.
- Fixed a NUL-delimiter parsing bug in the IntelliJ post-commit hook.

## 0.99.4

### New Features

- **Redesigned Create PR view** — the **Create pull request (PR)** button now opens a dedicated, branch-level Create PR tab that matches the new design: a branch → main header with diff stats, the drafted title and a rendered-markdown body, the memories included in the PR, the E2E test guide, and the changed files.
- **Create a PR and share to Jolli in one step** — when you're signed in to Jolli, creating (or updating) the PR now **automatically syncs the PR's memory summaries to your Jolli site** in the same action — no separate "Share in Jolli" step. Signed out, you get a one-click sign-in hint and the PR is still created as a normal git PR.
- **Working Memory review — token meter + inline edit** — the review now shows a token-usage meter (input / output / cached breakdown, aggregated from the included conversations, with a graceful "recorded at commit" state when a source doesn't report usage), and each conversation / context row has an inline **✕ leave out** / **+ add back** toggle so you can shape exactly what the next memory captures without leaving the review

### Changes

- **Selection is now a one-time discard** — unchecking a conversation, plan, note, or reference in CONTEXT now removes it from the working area when you commit, instead of keeping it around to re-check later. Unchecked conversations are consumed (they leave the list) but their content is dropped from the summary; unchecked plans/notes/references have their working-area entries removed without being saved into committed memory. Your own `~/.claude/plans` files and external note sources are never deleted
- **Plans surface from your session** — plans now appear in CONTEXT via transcript discovery (matching the VS Code extension) rather than scanning `~/.claude/plans`, so a plan shows up only once you actually create or edit it in a session, and the panel refreshes live as plans and references are discovered
- **Working-area items follow you across branches** — uncommitted plans, notes, and references are no longer hidden when you switch branches; only committed memory stays branch-tagged

### Fixes & Improvements

- **Working Memory review selection stays in sync** — removing or adding a conversation / context item in the review now updates the sidebar's selection immediately and is honored at commit; the review, the sidebar, and the commit all read and write the same commit-selection state
- **Committed Memories clears on a new branch** — creating a branch off a feature or release branch no longer shows the parent branch's committed memories as the new branch's own; the panel now measures each branch's commits from its true creation point
- Fixed a race condition when opening a file from the Current Memory review
- Cleared a JetBrains Marketplace verifier warning for the terminal-based "Resume in terminal" action

## 0.99.3

### UI

- **Memory panel polish** — consistent row hover, full-text wrapping, vertically centered icons, and tighter, aligned section headers across the Pinned, Current Memory, and Committed Memories sections
- **Open committed items inline** — click a conversation, context entry, or file inside a committed memory to read its content in an editor tab, reusing the stored transcript when the original is gone

### Fixes & Improvements

- **Share in Jolli** — fixed "Invalid or disabled API key" on push: credentials are now shared across surfaces, and a rejected key triggers a one-time silent re-authenticate & retry instead of failing
- Fixed the Jolli API key parser to scan every token segment, keeping it in lockstep with the CLI
- Fixed an IDE freeze when applying Settings — install, uninstall, and Memory Bank migration now run off the UI thread
- Added opt-out anonymous usage telemetry (content-free — never code, paths, or memory content). Disable it under Settings → General

## 0.99.2

### New Features

- **Reference extraction** — automatically extracts Linear, Jira, GitHub, and Notion references from Claude and Codex transcripts and surfaces them in summaries. Includes per-source envelope parsers, a persistent `ReferenceStore`, and transcript-level discovery at both StopHook and post-commit time
- **References in Plans panel** — plan entries now show clickable "Open in \<Source\>" links instead of static source labels, with a Select All toolbar action
- **PR history strip** — the summary viewer shows previously merged or closed PRs for the same branch alongside the active PR. Uses `gh pr list --state all` so reopened or multi-PR branches no longer lose history
- **Conversation multi-select** — active conversation rows now have a checkbox ("Include in next memory") and a Select All toolbar action

### Fixes & Improvements

- Removed periodic polling timer for branch updates; the tool window now updates on events only
- Resolved JetBrains Marketplace Plugin Verifier internal-API warnings — plugin version and install path are derived from pure JVM APIs instead of `PluginManager`
- Commit selection state is now tracked via `CommitSelectionStore`

## 0.99.1

### New Features

- **Active Conversations** — a new panel showing in-progress AI agent sessions live, with inline transcript editing, message counts, and the ability to hide sessions
- **Knowledge Wiki** — build a browsable topic wiki from your Memory Bank via an LLM ingest pipeline. Trigger it with the **Build Knowledge Wiki** button or let it auto-compile after each commit; supports both Anthropic and Jolli summarization providers
- **Full-text search & MCP server** — search across all memories, plus an MCP server that exposes your memory to AI tools, with ingest-phase progress UI
- **Full vault sync pipeline** — sync your Memory Bank to your Jolli space with live UI feedback, a space-binding dialog, and binding-required (412) handling
- **Quick Recap** — generate, regenerate, and edit a branch recap section
- **Memory scope filter** — filter the Memories panel by scope; auto-refreshes on branch switch
- **Discard selected** — discard multiple selected files at once in the Changes panel
- **"Push to Jolli" is now "Share in Jolli"** — the cloud-publish button is relabeled across all surfaces. Behavior is unchanged; only the label was updated

### UI

- **Tool window redesign** — breadcrumb navigation and foreign-mode support
- **Summary panel redesign** — realigned to match the VS Code layout
- **LLM provider attribution** — summary footers now show which provider generated the summary

### Fixes & Improvements

- Fixed Jolli API key clearing not triggering the status indicator, and not saving as `null` when cleared
- Fixed SSH/HTTPS remote mismatch that split Memory Banks and created duplicate repo entries; repo identity is now canonicalized on merge
- Fixed Migrate-to-Memory-Bank creating duplicate repo folders; consolidated onto the base folder name
- Auto-clear stale sync-status badges in the status bar
- Windows: mark the `.jolli` directory as hidden, fix path-separator drift in the storage layer, and fix the build & test suite
- Fixed SQLite JDBC driver loading
- Fixed a stderr deadlock and refined the sync poll interval
- Fixed OnboardingPanel font rendering and added an API key help tooltip
- Added `client_version` to OAuth login URLs

## 0.99.0

### Memory Bank

- **Memory Bank** — a new local storage layer that keeps human-readable Markdown summaries, plans, and notes alongside canonical JSON in a user-configurable folder. Summaries are dual-written to both the git orphan branch (system of record) and the Memory Bank folder by default
- **Memory Bank explorer** — browse your Memory Bank as a tree view in the tool window with commit/plan/note badges, double-click to open the formatted summary viewer. Supports file operations (New Folder, File, Import, Rename, Move, Delete) and drag-and-drop
- **Auto-migration** — existing orphan branch data is automatically migrated to the Memory Bank folder on plugin startup

### AI Agent Support

- **Claude Code** — StopHook after each response, SessionStartHook briefing at startup
- **Gemini CLI** — AfterAgent hook after each agent completion
- **Codex CLI** — automatic filesystem discovery, no hook needed
- **OpenCode** — session discovery via SQLite database scan
- **Cursor IDE** — Composer session discovery via SQLite database scan
- **GitHub Copilot CLI & Copilot Chat** — session discovery via filesystem scan

### Settings & Setup

- **Simplified setup flow** — hooks auto-install on credential save and auto-remove on credential clear; no separate Enable/Disable step
- **Onboarding screen** — detects existing API keys (config or `ANTHROPIC_API_KEY` env var) and skips onboarding automatically
- **Tabbed Settings dialog** — reorganized into five tabs: General, AI Agents, AI Summary, Sync to Jolli, and Memory Bank
- **AI Summary provider selection** — choose between Anthropic and Jolli as the summarization provider
- **Pause toggle** — temporarily disable hooks without losing configuration

### Plugin Distribution

- **Reduced plugin size** — stripped unused platform natives from sqlite-jdbc (FreeBSD, Android, ARM32, RISC-V, ppc64) and deduplicated the sqlite-jdbc dependency between the plugin and hooks JAR. Plugin zip reduced from 31 MB to 7 MB
- **Quality improvements** — resolved JetBrains Marketplace internal API warnings, fixed binary compatibility issues across IntelliJ versions, improved UI layout and panel management, fixed encoding issues, and added Plugin Verifier to CI

## 0.97.9

- **Privacy consent notice** — display a privacy notice with link to privacy policy at the top of the Settings page, satisfying JetBrains Marketplace guideline 2.2 for explicit user consent before data processing

## 0.97.0

- **Initial IntelliJ plugin release** — pure Kotlin port of the VS Code extension
- **Four-panel tool window**: STATUS, PLANS & NOTES, CHANGES, COMMITS in a right sidebar with collapsible panels
- **AI Commit** — generate commit messages from staged diffs using Anthropic API
- **Squash** — squash selected commits with LLM-generated combined message and automatic memory merging
- **Push** — git push with force-push confirmation dialog
- **View Summary** — JCEF-based HTML viewer for commit summaries with dark/light theme support
- **Plans & Notes** — auto-detect Claude Code plans, add custom notes (Markdown files or text snippets)
- **Hook installation** — pure Kotlin file I/O, no Node.js; installs git hooks and Claude Code stop hook
- **Standalone hooks JAR** — git hooks run as `jollimemory-hooks.jar` fat JAR outside the IDE
- **Orphan branch storage** — summaries stored in `jollimemory/summaries/v3` with tree-hash aliases
- **Push to Jolli Space** — publish summaries to team knowledge base via API
- **Create & Update PR** — GitHub PR management via `gh` CLI with summary markers
- **Settings page** — Anthropic API key, model selection, Jolli API key at Settings > Tools > Jolli Memory
- **Compatibility**: IntelliJ IDEA 2024.3+ (build 243–262.*)
