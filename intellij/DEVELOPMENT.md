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

These hooks track which AI sessions are active. Gemini's `AfterAgent` and Claude's `SessionStartHook` only record session metadata (ID, transcript path, timestamp). Claude's `StopHook` records that too, but **also reads the transcript**, incrementally scanning it for plans, references and skills. **None of them make LLM calls.**

| Agent | Hook | How it works |
|-------|------|-------------|
| **Claude Code** | `StopHook` | Triggered after each AI response; writes session info to `sessions.json` |
| **Gemini** | `AfterAgent` hook | Same stdin format as Claude's StopHook; additionally outputs `{}` to stdout (Gemini hook spec) |
| **Codex** | _(no hook)_ | Sessions discovered by scanning `~/.codex/sessions/` at post-commit time |

### Git Hooks — Summary Generation Pipeline

| Hook | When | What it does |
|------|------|-------------|
| **prepare-commit-msg** | Before commit | Detects squash/amend scenarios and writes pending files for the Worker |
| **post-commit** | After commit | Spawns a background Worker that reads transcripts + diff, calls the LLM, and writes the summary to the orphan branch |
| **post-rewrite** | After rebase/amend | Migrates existing summaries to match new commit hashes (1:1 hash remapping) |
| **pre-push** | Before push | Syncs the pushed commits' memory to Jolli Space. **Does not use the Kotlin JAR**: the sync engine (`push-pending.json` queue + Space doc upload) lives only in the Node CLI, so this hook reuses the shared `run-hook pre-push` dispatcher (written by `enableIntegrations` → bundled `jolli enable --integrations-only`), guarded so a missing dispatcher / absent Node never aborts the push. `CliIntegrations.retryPendingPushes` drains any pending commits for catch-up — from both plugin startup (offline pushes) and the **post-commit drain's tail** (blocking), so a push that raced ahead of summary generation syncs once the summary lands, without a restart (the Kotlin QueueWorker's analog of the TS `triggerPushForNewSummaries`). |

Summaries are stored in a git orphan branch (`jollimemory/summaries/v3`) using a v3 tree format.

---

## Architecture

```
src/main/kotlin/ai/jolli/jollimemory/
├── JolliMemoryIcons.kt              # Icon resource loader
├── actions/                         # IntelliJ action classes (14: 13 AnAction + 1 ToggleAction, all DumbAware)
│   ├── AddContextAction.kt          # The CONTEXT "+" — Add Plan / Add Markdown Note / Add Text Snippet
│   ├── CommitAIAction.kt            # AI-powered commit message generation + commit
│   ├── SquashAction.kt              # Squash selected commits with LLM message
│   ├── PushAction.kt                # Git push with force-push confirmation
│   ├── DiscardSelectedAction.kt     # Discard changes for all selected files in the Changes panel
│   ├── ViewSummaryAction.kt         # Open commit summary in JCEF viewer
│   ├── SelectAllCommitsAction.kt    # Toggle selection of all commits
│   ├── StatusSettingsAction.kt      # Open settings dialog
│   ├── TogglePanelAction.kt         # Toggle panel visibility
│   └── Refresh*Action.kt            # Refresh individual panels (Status, Conversations, Plans, Changes, Commits — 5 actions)
├── auth/                            # Auth credential storage (shared with CLI/VSCode at ~/.jolli/jollimemory/config.json)
│   ├── JolliConfigStore.kt          # Read/write authToken and space metadata
│   └── JolliUrlConfig.kt            # Resolves the Jolli site URL from saved metadata
├── bridge/                          # Native Kotlin bridge to git, hooks, and summaries
│   ├── GitOps.kt                    # Git command execution via ProcessBuilder
│   ├── HookInstaller.kt             # Hook script installation/removal (pure file I/O)
│   ├── SkillInstaller.kt            # Installs the /jolli-recall slash command into Claude Code's skills directory
│   └── SummaryReader.kt             # Read summaries from orphan branch
├── core/                            # Pure Kotlin core (no IntelliJ dependencies) — a selection, not the full listing
│   ├── SummaryStore.kt              # Orphan branch read/write (git plumbing)
│   ├── SummaryTree.kt               # Tree-structured summary index
│   ├── SessionTracker.kt            # Active session registry (sessions.json) + global config dir resolution
│   ├── WorkingContext.kt            # Adapter over the CLI's `working-context` ide-bridge action (plans / notes / references)
│   ├── CommitSelectionStore.kt      # Adapter over the CLI-owned "leave out of this memory" exclude set
│   ├── KBFolderReader.kt            # Native reader for .jolli/manifest.json + index.json — LOCKSTEP with the CLI's schemas
│   ├── LocalAgentTools.kt           # DEFAULT_TOOLS — hand-maintained mirror of the CLI's LOCAL_AGENT_TOOLS
│   ├── HookEnv.kt                   # The ONLY place production code may touch JVM globals (see check-global-state.sh)
│   ├── Types.kt                     # Data classes, enums, and type definitions (incl. JolliMemoryConfig with authToken)
│   ├── JmLogger.kt                  # File-based logger for hooks (no IDE dependency)
│   ├── plans/                       # ClaudePlanScanner.kt — enumerates ~/.claude/plans
│   ├── references/                  # ReferenceStore / ReferenceTypes / SourceDisplay — types field-for-field with the CLI
│   └── telemetry/                   # Consent + buffering + flush (TelemetryFlusher is check-no-direct-llm-http's one allowlist entry)
├── hooks/                           # Standalone hook entry points (bundled in hooks JAR)
│   ├── HookRunner.kt                # Main-Class entry point for jollimemory-hooks.jar; dispatches by first arg
│   ├── PostCommitHook.kt            # Post-commit: spawn background summarization
│   ├── PostRewriteHook.kt           # Post-rewrite: migrate summaries after rebase/amend
│   ├── PrepareMsgHook.kt            # Prepare-commit-msg: detect squash/amend
│   ├── StopHook.kt                  # Claude Code stop hook: track session metadata
│   ├── GeminiAfterAgentHook.kt      # Gemini after-agent hook
│   └── HookUtils.kt                 # Shared hook utilities
├── services/                        # IntelliJ project-level services
│   ├── JolliMemoryService.kt        # Central service: install/uninstall, status, branch ops
│   ├── JolliMemoryStartupActivity.kt# Auto-detect and install hooks on project open
│   ├── JolliAuthService.kt          # OAuth flow: opens browser, runs a local callback listener, stores credentials
│   ├── JolliApiClient.kt            # HTTP client for Jolli Space API (Share in Jolli)
│   └── PrService.kt                 # GitHub PR creation/update via gh CLI
├── settings/
│   └── JolliMemoryConfigurable.kt   # Preferences > Tools > Jolli Memory entry — bridge only, opens SettingsDialog
└── toolwindow/                      # UI components (Swing / JCEF)
    ├── JolliMemoryToolWindowFactory.kt # Tool window entry point + Sign In banner
    ├── AccordionLayout.kt           # Collapsed panels shrink to header-only
    ├── CollapsiblePanel.kt          # Header with title, arrow, inline toolbar
    ├── ResizeDivider.kt             # Drag-to-resize between panels
    ├── PanelRegistry.kt             # Panel visibility state management
    ├── StatusPanel.kt               # STATUS panel (hook status, sessions, summary count)
    ├── MemoriesPanel.kt             # MEMORIES panel (search + paginated list of stored summaries)
    ├── PlansPanel.kt                # PLANS & NOTES panel
    ├── ChangesPanel.kt              # FILES panel (per-row discard + leave-out toggle)
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

### LLM traffic delegates to the bundled CLI

The plugin used to talk to Anthropic directly from Kotlin (`AnthropicClient` / `LlmClient` / `Summarizer` on top of Java 21's `HttpClient`). All of that is gone — every AI-facing feature (commit-message generation, squash-message consolidation, E2E-test guides, recap, plan translation) now spawns the plugin-bundled `Cli.js` via `CliIntegrations.generate` and reads a single-line JSON response. Provider routing (`anthropic` / `jolli-proxy` / `local-agent`) lives entirely in the CLI's `callLlm`, so the IDEs and the CLI stay behavior-identical by construction and adding a provider is a one-place change. **Node.js 22.13+ is therefore a hard requirement for the plugin as a whole**, not just for AI features — `JolliMemoryStartupActivity` returns early and the tool window swaps in a blocking panel when no usable runtime is found (see `NodeRuntime.MIN_SUPPORTED_MAJOR` / `MIN_SUPPORTED_MINOR` for why the floor is 22.13, `CliIntegrations.resolveNode`, and the "Node missing" surface warnings — every one of which spells the version with `NodeRuntime.MIN_SUPPORTED_DISPLAY`).

What stays Kotlin-side:

- **Git operations** use `ProcessBuilder` to execute git plumbing commands directly
- **Jolli Space HTTP** (Share in Jolli, push/list-spaces) still uses Java 21's built-in `HttpClient` from `JolliApiClient` / `JolliAuthService` / `TelemetryFlusher`
- **Transcript parsing** reads JSONL line-by-line with cursor-based resumption (supports files up to 50MB)
- **Hook installation** delegates to the bundled CLI's `enable` / `disable` (the plugin no longer writes hook bodies itself)

### Hooks as Standalone Fat JAR

Git hooks must run outside the IDE (commits happen from the terminal too). The `hookJar` Gradle task (ShadowJar) produces `jollimemory-hooks.jar` — a self-contained JAR with:

- All hook entry points (`PostCommitHook`, `PostRewriteHook`, `PrepareMsgHook`, `StopHook`, `GeminiAfterAgentHook`)
- Core classes (`SummaryStore`, `TranscriptReader`, etc.)
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

### Toolbar buttons: `DumbAware` + an explicit refresh

Two platform behaviours conspire to leave the tool window's toolbar buttons dead, and every action in `actions/` needs both fixes. Both failed silently — the buttons simply looked disabled.

**1. Every action must be `DumbAware`.** The platform force-disables a non-dumb-aware action for the whole of indexing, *ignoring whatever `update()` computes*. None of these actions read the PSI or an index — they run git, call the CLI bridge and drive Swing — so all of them carry the marker. On a large project this was minutes of a dead toolbar after every IDE open, and it read exactly like a broken button. Note the plugin's `FileEditorProvider`s were already dumb-aware; only the actions were missed.

Enforced by [`scripts/check-actions-dumbaware.sh`](scripts/check-actions-dumbaware.sh), a `test` dependency alongside the global-state and no-direct-LLM-http gates. It exists because nothing else can see the regression: a new action without the marker compiles, lints and leaves the suite green, and only a human opening a freshly-indexed large project notices. The gate reads the *comment-stripped* source (one action explains its own `[DumbAware]` choice in KDoc, so a bare grep would pass a file that merely talks about the marker) and fails when it finds **zero** action classes, so a moved package or a supertype spelling it stops recognising can't report a cheerful pass having checked nothing. Its scope is `actions/` only — the `FileEditorProvider`s are not covered.

**2. Something must ask the toolbar to re-run `update()`.** These actions gate `isEnabled` on `JolliMemoryService.getStatus()`, which is null until the first async `refreshStatus()` lands — and in a fresh linked worktree it then reports `enabled=false` until `initialize()`'s auto-install finishes and refreshes a second time. An `ActionToolbar` updates when it is shown or when asked; 2025.1 dropped the platform's periodic re-poll. So the panels that own toolbars (`CurrentMemoryPanel` for the three section headers, `JolliMemoryToolWindowFactory` for the three `CollapsiblePanel` headers) call `updateActionsAsync()` from a service status listener. Use the async form, not `updateActionsImmediately()` — these actions declare `ActionUpdateThread.BGT`.

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
version = "0.99.9"
```

Compatibility range is also defined there:

```kotlin
ideaVersion {
    sinceBuild = "251"     // IntelliJ 2025.1
    untilBuild = "262.*"   // Up to IntelliJ 2026.2.x
}
```

---

## MCP Server (manual setup)

The CLI ships a `jolli mcp` stdio MCP server that exposes JolliMemory's search + recall tools to AI agents. The CLI and VS Code extension auto-register it; **the IntelliJ plugin does not register it yet**. IntelliJ users add it manually to their project's `.mcp.json`:

```json
{ "mcpServers": { "jollimemory": { "command": "jolli", "args": ["mcp"] } } }
```

This requires the `jolli` CLI to be on `PATH` (`npm install -g @jolli.ai/cli`).
