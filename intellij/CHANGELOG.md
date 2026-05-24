# Changelog

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
