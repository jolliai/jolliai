# Changelog

## 0.99.4

### Changes

- **Selection is now a one-time discard** — unchecking a conversation, plan, note, or reference in CONTEXT now removes it from the working area when you commit, instead of keeping it around to re-check later. Unchecked conversations are consumed (they leave the list) but their content is dropped from the summary; unchecked plans/notes/references have their working-area entries removed without being saved into committed memory. Your own `~/.claude/plans` files and external note sources are never deleted
- **Plans surface from your session** — plans now appear in CONTEXT via transcript discovery (matching the VS Code extension) rather than scanning `~/.claude/plans`, so a plan shows up only once you actually create or edit it in a session, and the panel refreshes live as plans and references are discovered
- **Working-area items follow you across branches** — uncommitted plans, notes, and references are no longer hidden when you switch branches; only committed memory stays branch-tagged

### Fixes & Improvements

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
