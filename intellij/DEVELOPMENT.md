# JolliMemory IntelliJ Plugin — Development Guide

---

## First-time Setup

```bash
# Ensure JDK 21 is available
export JAVA_HOME=/opt/homebrew/opt/openjdk@21  # macOS with Homebrew

# From repo root, enter the plugin directory and build
cd intellij
./gradlew build
```

After a successful build, install the plugin from disk (see README.md) or run a sandbox IDE:

```bash
./gradlew runIde
```

---

## Iterative Development

The fastest development loop uses the IntelliJ sandbox:

```bash
./gradlew runIde
```

This launches a separate IntelliJ instance with the plugin pre-installed. Code changes require restarting the sandbox (`Ctrl+C` then re-run).

### Building for install-from-disk

```bash
./gradlew buildPlugin
# Output: build/distributions/jollimemory-intellij-*.zip
```

Then in your main IntelliJ: **Settings > Plugins > Install Plugin from Disk**, select the zip, and restart.

### Running tests

```bash
./gradlew test
```

Uses JUnit 5, MockK for mocking, and Kotest assertions.

### Build artifacts

| Artifact | Location | Purpose |
| -- | -- | -- |
| Plugin zip | `build/distributions/jollimemory-intellij-*.zip` | Full plugin distribution for install-from-disk |
| Hooks JAR | `build/libs/jollimemory-hooks-*.jar` | Standalone fat JAR for git hooks (bundled inside the zip) |

---

## How it works

JolliMemory installs hooks into the user's project, split into two categories:

### AI Agent Hooks — Session Tracking

These hooks track which AI sessions are active. They only record session metadata (ID, transcript path, timestamp) — **they never read conversation content or make LLM calls.**

| Agent | Hook | How it works |
|-------|------|-------------|
| **Claude Code** | `StopHook` | Triggered after each AI response; writes session info to `sessions.json` |
| **Gemini CLI** | `AfterAgent` hook | Same stdin format as Claude's StopHook; additionally outputs `{}` to stdout (Gemini hook spec) |
| **Codex CLI** | _(no hook)_ | Sessions discovered by scanning `~/.codex/sessions/` at post-commit time |

### Git Hooks — Summary Generation Pipeline

| Hook | When | What it does |
|------|------|-------------|
| **prepare-commit-msg** | Before commit | Detects squash/amend scenarios and writes pending files for the Worker |
| **post-commit** | After commit | Spawns a background Worker that reads transcripts + diff, calls the LLM, and writes the summary to the orphan branch |
| **post-rewrite** | After rebase/amend | Migrates existing summaries to match new commit hashes (1:1 hash remapping) |

Summaries are stored in a git orphan branch (`jollimemory/summaries/v3`) using a v3 tree format.

---

## Architecture

```
src/main/kotlin/ai/jolli/jollimemory/
├── JolliMemoryIcons.kt              # Icon resource loader
├── actions/                         # IntelliJ AnAction classes (19 actions)
│   ├── EnableAction.kt              # Install hooks and Claude Code stop hook
│   ├── DisableAction.kt             # Uninstall hooks
│   ├── CommitAIAction.kt            # AI-powered commit message generation + commit
│   ├── SquashAction.kt              # Squash selected commits with LLM message
│   ├── PushAction.kt                # Git push with force-push confirmation
│   ├── ViewSummaryAction.kt         # Open commit summary in JCEF viewer
│   ├── AddPlanAction.kt             # Add a plan from ~/.claude/plans/
│   ├── AddNoteAction.kt             # Add a Markdown file or text snippet note
│   ├── SelectAllFilesAction.kt      # Toggle selection of all changed files
│   ├── SelectAllCommitsAction.kt    # Toggle selection of all commits
│   ├── SearchMemoriesAction.kt      # Open the Memories panel keyword filter
│   ├── ClearMemoryFilterAction.kt   # Clear the active Memories filter
│   ├── StatusSettingsAction.kt      # Open settings dialog
│   ├── TogglePanelAction.kt         # Toggle panel visibility
│   └── Refresh*Action.kt            # Refresh individual panels (Status, Memories, Plans, Changes, Commits — 5 actions)
├── auth/                            # Auth credential storage (shared with CLI/VSCode at ~/.jolli/jollimemory/config.json)
│   ├── JolliConfigStore.kt          # Read/write authToken and space metadata
│   └── JolliUrlConfig.kt            # Resolves the Jolli site URL from saved metadata
├── bridge/                          # Native Kotlin bridge to git, hooks, and summaries
│   ├── GitOps.kt                    # Git command execution via ProcessBuilder
│   ├── HookInstaller.kt             # Hook script installation/removal (pure file I/O)
│   ├── SkillInstaller.kt            # Installs the /jolli-recall slash command into Claude Code's skills directory
│   └── SummaryReader.kt             # Read summaries from orphan branch
├── core/                            # Pure Kotlin core (no IntelliJ dependencies)
│   ├── AnthropicClient.kt           # HTTP client for Anthropic API (Java 21 HttpClient)
│   ├── LlmClient.kt                 # Abstraction over the LLM provider — picks Anthropic direct vs Jolli proxy by config
│   ├── Summarizer.kt                # LLM prompt construction and response parsing
│   ├── SummaryStore.kt              # Orphan branch read/write (git plumbing)
│   ├── SummaryTree.kt               # Tree-structured summary index
│   ├── PlanProgressEvaluator.kt     # Derives "active vs done" plan progress from transcript signals
│   ├── TranscriptReader.kt          # JSONL transcript parser with cursor resumption
│   ├── TranscriptParsers.kt         # Agent-specific transcript format parsers
│   ├── SessionTracker.kt            # Active session registry (sessions.json) + global config dir resolution
│   ├── CodexSessionDiscoverer.kt    # Auto-discover Codex sessions from filesystem
│   ├── GeminiSupport.kt             # Gemini CLI session integration
│   ├── Types.kt                     # Data classes, enums, and type definitions (incl. JolliMemoryConfig with authToken)
│   └── JmLogger.kt                  # File-based logger for hooks (no IDE dependency)
├── hooks/                           # Standalone hook entry points (bundled in hooks JAR)
│   ├── HookRunner.kt                # Main-Class entry point for jollimemory-hooks.jar; dispatches by first arg
│   ├── PostCommitHook.kt            # Post-commit: spawn background summarization
│   ├── PostRewriteHook.kt           # Post-rewrite: migrate summaries after rebase/amend
│   ├── PrepareMsgHook.kt            # Prepare-commit-msg: detect squash/amend
│   ├── StopHook.kt                  # Claude Code stop hook: track session metadata
│   ├── GeminiAfterAgentHook.kt      # Gemini CLI after-agent hook
│   └── HookUtils.kt                 # Shared hook utilities
├── services/                        # IntelliJ project-level services
│   ├── JolliMemoryService.kt        # Central service: install/uninstall, status, branch ops
│   ├── JolliMemoryStartupActivity.kt# Auto-detect and install hooks on project open
│   ├── JolliAuthService.kt          # OAuth flow: opens browser, runs a local callback listener, stores credentials
│   ├── JolliApiClient.kt            # HTTP client for Jolli Space API (Push to Jolli)
│   ├── PlanService.kt               # Plan detection and registry management
│   └── PrService.kt                 # GitHub PR creation/update via gh CLI
├── settings/
│   └── JolliMemoryConfigurable.kt   # Settings page (Settings > Tools > Jolli Memory) — Sign In/Out + API keys + model
└── toolwindow/                      # UI components (Swing / JCEF)
    ├── JolliMemoryToolWindowFactory.kt # Tool window entry point + Sign In banner
    ├── AccordionLayout.kt           # Collapsed panels shrink to header-only
    ├── CollapsiblePanel.kt          # Header with title, arrow, inline toolbar
    ├── ResizeDivider.kt             # Drag-to-resize between panels
    ├── PanelRegistry.kt             # Panel visibility state management
    ├── StatusPanel.kt               # STATUS panel (hook status, sessions, summary count)
    ├── MemoriesPanel.kt             # MEMORIES panel (search + paginated list of stored summaries)
    ├── PlansPanel.kt                # PLANS & NOTES panel
    ├── ChangesPanel.kt              # CHANGES panel (file selection with checkboxes)
    ├── CommitsPanel.kt              # COMMITS panel (branch history with metadata)
    ├── SummaryViewerDialog.kt       # JCEF-based HTML summary viewer dialog
    ├── SummaryEditorProvider.kt     # Editor tab provider for summary webview
    ├── SummaryFileEditor.kt         # File editor wrapper for summary content
    ├── SummaryPanel.kt              # Summary rendering panel
    ├── SummaryVirtualFile.kt        # Virtual file for summary content
    ├── SettingsDialog.kt            # Inline settings dialog
    └── views/                       # HTML/CSS/JS builders for summary rendering
```

---

## Key Design Decisions

### Pure Kotlin — No Node.js Dependency

Unlike the VS Code extension (which bundles a Node.js CLI), the IntelliJ plugin implements everything in Kotlin:

- **Git operations** use `ProcessBuilder` to execute git plumbing commands directly
- **HTTP calls** use Java 21's built-in `HttpClient` (for both Anthropic API and Jolli Space API)
- **Hook installation** is pure file I/O — writes shell scripts that invoke `java -jar jollimemory-hooks.jar`
- **Transcript parsing** reads JSONL line-by-line with cursor-based resumption (supports files up to 50MB)

### Hooks as Standalone Fat JAR

Git hooks must run outside the IDE (commits happen from the terminal too). The `hookJar` Gradle task (ShadowJar) produces `jollimemory-hooks.jar` — a self-contained JAR with:

- All hook entry points (`PostCommitHook`, `PostRewriteHook`, `PrepareMsgHook`, `StopHook`, `GeminiAfterAgentHook`)
- Core classes (`Summarizer`, `SummaryStore`, `TranscriptReader`, etc.)
- Gson for JSON parsing
- Kotlin stdlib (bundled via separate `hooksRuntime` configuration)

The JAR excludes IntelliJ platform classes (`com/intellij/**`, `org/jetbrains/**`) and Kotlin reflect (`kotlin/reflect/**`) to avoid binary incompatibility with newer JDKs.

The plugin's `kotlin-stdlib` dependency is `compileOnly` — IntelliJ provides it at runtime. Only the hooks JAR bundles its own copy.

### Orphan Branch Storage

Summaries are stored in `jollimemory/summaries/v3` — a git orphan branch with no connection to your working tree. The `SummaryStore` uses git plumbing commands (`update-ref`, `cat-file`, `ls-tree`, `mktree`, `hash-object`) for atomic reads and writes. A lightweight index file enables fast lookups without loading individual summary files.

Tree-hash aliases allow matching summaries across branches (e.g., after cherry-pick) when commit hashes differ but the code tree is identical.

### JCEF Summary Viewer

The summary viewer uses IntelliJ's built-in JCEF (Chromium Embedded Framework) to render rich HTML summaries with dark/light theme support. This mirrors the VS Code extension's webview approach.

### Accordion Layout

The four-panel tool window uses a custom `AccordionLayout` where collapsed panels shrink to header-only height and expanded panels share the remaining space. `ResizeDivider` components between panels allow manual drag-to-resize.

---

## Testing

```bash
# Run all tests
./gradlew test

# Run with verbose output
./gradlew test --info
```

The test suite uses:
- **JUnit 5** for test framework
- **MockK** for mocking IntelliJ platform services and git operations
- **Kotest assertions** for expressive assertion syntax

Test files are in `src/test/kotlin/ai/jolli/jollimemory/` mirroring the main source structure.

---

## Versioning

The plugin version is set in `build.gradle.kts`:

```kotlin
version = "0.97.9"
```

Compatibility range is also defined there:

```kotlin
ideaVersion {
    sinceBuild = "243"     // IntelliJ 2024.3
    untilBuild = "262.*"   // Up to IntelliJ 2026.2.x
}
```
