# Changelog

## 0.97.8

- **Fix scheduled-for-removal API** — replace `PluginId.findId()` with `PluginId.getId()` to resolve Plugin Verifier warnings
- **Add Plugin Verifier to CI** — verify binary compatibility against IntelliJ 2024.3, 2025.1, and 2026.1 on every build

## 0.97.7

- **Bump version** — version bump for standalone repository migration

## 0.97.6

- **Marketplace readiness** — add plugin icons (`pluginIcon.svg` with dark variant), configure Gradle plugin signing and publishing, add Apache 2.0 LICENSE

## 0.97.5

- **Install Gemini CLI hooks** — the Enable button now writes the AfterAgent hook to `.gemini/settings.json`, matching the VS Code extension
- **Auto-refresh panels after commit** — COMMITS and CHANGES panels now subscribe to `GIT_REPO_CHANGE` events directly, so they update automatically after IntelliJ UI commits
- **Fix stale "disabled" state after enable** — prevent a slow initial background refresh from overwriting the correct UI state
- **Fix VFS listener bus scope** — CHANGES panel now subscribes to `VFS_CHANGES` on the application-level message bus
- **Fix TypesJVMKt binary incompatibility** — exclude `TypesJVMKt` from hooks fat JAR in addition to `TypeVariableImpl` to resolve Plugin Verifier `NoSuchClassError` on IntelliJ 2026.1+
- **Fix tool window icon** — correct SVG icon rendering in the sidebar
- **Refactor panel layout** — panels now use JPanel rows for better alignment and consistency
- **Harden hook installation** — fix CLI file permissions and scope the package name
- **Update export path** — SummaryExporter now writes to `~/Documents/jollimemory/`

## 0.97.4

- **Fix TypeVariable binary incompatibility** — exclude `kotlin/reflect/**` from hooks fat JAR to resolve IntelliJ 2026.1+ (build 261) compatibility; `TypeVariableImpl` was missing `getAnnotatedBounds()`, causing Plugin Verifier to flag an `AbstractMethodError`
- **kotlin-stdlib as compileOnly** — the plugin no longer bundles kotlin-stdlib (IntelliJ provides it at runtime); only the hooks JAR bundles its own copy via a separate `hooksRuntime` Gradle configuration

## 0.97.3

- Bump plugin version for distribution

## 0.97.2

- **Fix UTF-8 bridge corruption** — resolve encoding issues in git command output parsing that could corrupt non-ASCII characters in commit messages and file paths
- **Improved UI layout** — collapsible panels with AccordionLayout, ResizeDivider for manual panel resizing, and inline action toolbars per panel
- **Panel management** — configurable panel visibility via gear menu, PanelRegistry for state persistence

## 0.97.1

- **Improved panel management** — refined collapsible panel headers, expand/collapse animations, and panel toolbar layout

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
- **Multi-agent support** — session tracking for Claude Code (StopHook), Gemini CLI (AfterAgent hook), and Codex CLI (filesystem discovery)
- **Orphan branch storage** — summaries stored in `jollimemory/summaries/v3` with tree-hash aliases
- **Push to Jolli Space** — publish summaries to team knowledge base via API
- **Create & Update PR** — GitHub PR management via `gh` CLI with summary markers
- **Settings page** — Anthropic API key, model selection, Jolli API key at Settings > Tools > Jolli Memory
- **Compatibility**: IntelliJ IDEA 2024.3+ (build 243–262.*)
