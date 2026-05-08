# Jolli Memory VS Code Extension — Development Guide

---

## First-time Setup

```bash
# 1. Install workspace dependencies (npm workspaces — run once at the repo root, covers cli + vscode)
npm install

# 2. Build the jollimemory core (the extension bundles it at build time via esbuild)
npm run build:cli

# 3. Deploy (bumps patch version, builds, packages, and installs into your VS Code)
cd vscode
npm run deploy
```

After the first install, open any git repository. The Jolli Memory icon appears in the Activity Bar.

---

## Iterative Development

After making changes, run one command from `vscode/`:

```bash
npm run deploy
```

This automatically: bumps the patch version → builds → packages the VSIX → installs it into VS Code.

Then reload your VS Code window to pick up the changes:

```
Ctrl+Shift+P → Developer: Reload Window
```

### When you also change the jollimemory core

The extension bundles `cli/src/**` at build time. If you change files under `cli/src/`, rebuild the core first:

```bash
npm run build:cli            # from the repo root
cd vscode && npm run deploy
```

---

## How it works

Jolli Memory installs hooks into the user's project, split into two categories.

### AI Agent Hooks — Session Tracking

These hooks track which AI sessions are active. They only record session metadata (ID, transcript path, timestamp) — **they never read conversation content or make LLM calls.**

| Agent | Mechanism | How it works |
|-------|-----------|-------------|
| **Claude Code** | `StopHook` + `SessionStartHook` | `StopHook` runs after each AI response and writes session info to `sessions.json`. `SessionStartHook` records new sessions at start so the cross-machine `/jolli-recall` flow can locate transcripts. |
| **Gemini CLI** | `GeminiAfterAgentHook` | Same stdin format as Claude's StopHook; additionally outputs `{}` to stdout (Gemini hook spec). |
| **Codex CLI** | _(no hook)_ | Sessions discovered by scanning `~/.codex/sessions/` at post-commit time. |
| **OpenCode** | _(no hook)_ | Sessions discovered by reading `~/.local/share/opencode/opencode.db` (SQLite) at post-commit time. Requires Node 22.5+ for `node:sqlite`; the discoverer is lazy-imported and feature-gated, so older hosts (e.g. VS Code's bundled Electron Node) silently skip OpenCode without breaking anything else. |
| **Cursor IDE** (Composer) | _(no hook)_ | Sessions discovered by `CursorDetector` + `CursorSessionDiscoverer` scanning Cursor's workspace storage at post-commit time. |
| **GitHub Copilot CLI** | _(no hook)_ | Sessions discovered by `CopilotDetector` + `CopilotSessionDiscoverer` scanning the Copilot CLI session log. |
| **VS Code Copilot Chat** | _(no hook)_ | Sessions discovered by `CopilotChatDetector` + `CopilotChatSessionDiscoverer` reading the Copilot Chat conversation cache. |

Per-integration enable/disable lives in the global config (`claudeEnabled`, `geminiEnabled`, `codexEnabled`, `openCodeEnabled`, `cursorEnabled`, `copilotEnabled`) and is toggled from the **Settings** webview. The single `copilotEnabled` switch covers both Copilot CLI and Copilot Chat — splitting them was rejected because users almost always want them together. Discoverable-but-disabled integrations show up in the Status panel as "detected but disabled". OpenCode and the Copilot family additionally surface a separate **scan-error** row when their backing store is present but unreadable (corrupt, locked, schema-incompatible) — this avoids the past failure mode where a corrupt DB rendered as a healthy-looking integration.

### Git Hooks — Summary Generation Pipeline

| Hook | When | What it does |
|------|------|-------------|
| **prepare-commit-msg** (`PrepareMsgHook`) | Before commit | Detects squash / amend scenarios and writes pending files for the Worker. |
| **post-commit** (`PostCommitHook`) | After commit | Synchronously enqueues an entry into `.jolli/jollimemory/git-op-queue/` and spawns a detached `QueueWorker`. Returns in <5 ms — the LLM call happens entirely in the background. |
| **post-rewrite** (`PostRewriteHook`) | After rebase/amend | Migrates existing summaries to match new commit hashes (1:1 hash remapping). |
| **`QueueWorker`** _(spawned, not installed)_ | When `post-commit` enqueues | Holds a 5-minute file lock, drains queue entries in timestamp order, runs the LLM where needed, and chain-spawns a successor if more entries arrive. |

Summaries are stored on a git orphan branch (`jollimemory/summaries/v3`) using a v3 tree format. Raw AI conversations are optionally preserved as `transcripts/{commitHash}.json` alongside the distilled summaries. The orphan branch is **never checked out** — reads use `git show`, writes use plumbing (`hash-object`, `mktree`, `commit-tree`, `update-ref`).

---

## Architecture

```
src/
├── Extension.ts                  # activate/deactivate — wires providers, stores, watchers, commands, URI handler
├── JolliMemoryBridge.ts          # Bridge: wraps the jollimemory CLI surface and git ops
├── Types.ts                      # Extension-specific types (FileStatus, BranchCommit, PlanInfo, NoteInfo, …)
│
├── commands/                     # User-facing commands (registered in package.json + Extension.ts)
│   ├── CommitCommand.ts          # AI commit flow (QuickPick + 3 actions)
│   ├── PushCommand.ts            # Git push with force-push guard
│   ├── SquashCommand.ts          # Squash flow (range selection + LLM message + force-push guard)
│   └── ExportMemoriesCommand.ts  # Bulk export memories to ~/Documents/jollimemory/<project>/
│
├── core/                         # Domain services local to the extension
│   ├── PlanService.ts            # Plans registry (plans.json) — read/save/ignore, branch-aware visibility
│   └── NoteService.ts            # Notes registry — file-backed under .jolli/jollimemory/notes/
│
├── stores/                       # Host-side mutable state, BaseStore + listener pattern
│   ├── BaseStore.ts              # Tiny pub-sub: getSnapshot / onChange / emit, errors isolated per listener
│   ├── StatusStore.ts            # Status + global config + workerBusy / extensionOutdated / migrating flags
│   ├── MemoriesStore.ts          # Memories search / pagination / filter
│   ├── PlansStore.ts             # Plans + Notes panel state
│   ├── FilesStore.ts             # Working-tree changes + checkbox state
│   └── CommitsStore.ts           # Branch commits + range selection
│
├── services/                     # Stateless services
│   ├── AuthService.ts            # OAuth callback URI handling (code-exchange flow + CSRF state validation per RFC 6749), sign-in / sign-out, jollimemory.signedIn context key
│   ├── ManualDisableFlag.ts      # Durable per-repo opt-out for auto-enable (set when user clicks Disable; respected on every activation)
│   ├── JolliPushService.ts       # HTTP client for pushing summaries to a Jolli Space
│   ├── PrCommentService.ts       # GitHub PR creation/update via gh CLI; PR section markers
│   └── data/                     # Pure derivations consumed by providers (no VSCode imports, no state)
│       ├── StatusDataService.ts
│       ├── MemoriesDataService.ts
│       ├── PlansDataService.ts
│       ├── FilesDataService.ts
│       └── CommitsDataService.ts
│
├── providers/                    # TreeData adapters — translate store snapshots into TreeItems
│   ├── StatusTreeProvider.ts
│   ├── MemoriesTreeProvider.ts
│   ├── PlansTreeProvider.ts      # Plans + Notes (one panel)
│   ├── FilesTreeProvider.ts
│   ├── HistoryTreeProvider.ts    # Commits + per-commit file children + checkbox range logic
│   └── KnowledgeBaseTreeProvider.ts  # Branch-aware Memory Bank folder tree (the class name keeps the legacy "KnowledgeBase" identifier)
│
├── views/                        # Webview panels (HTML + CSS + JS, served via webview API)
│   ├── SidebarWebviewProvider.ts         # Top-level sidebar webview that renders the onboarding flow, status, Memory Bank folders, and acts as the host for the in-sidebar panels
│   ├── SidebarHtmlBuilder.ts             # HTML assembly for the sidebar (onboarding panel, sections, Memory Bank tree)
│   ├── SidebarCssBuilder.ts              # Sidebar stylesheet (CSP-compatible — no inline style)
│   ├── SidebarScriptBuilder.ts           # Embedded JS — onboarding interactions, message bus, lazy data fetches
│   ├── SidebarMessages.ts                # Typed message contracts between extension host and sidebar webview
│   │
│   ├── SummaryWebviewPanel.ts            # Per-commit summary panel (orchestrator)
│   ├── SummaryHtmlBuilder.ts             # Assembles HTML from modular blocks
│   ├── SummaryCssBuilder.ts              # Notion-like stylesheet
│   ├── SummaryScriptBuilder.ts           # Embedded JS for toggles, edit/delete, PR interactions
│   ├── SummaryMarkdownBuilder.ts         # Single-commit Markdown export for clipboard / Jolli push
│   ├── SummaryPrMarkdownBuilder.ts       # PR-section variant of the Markdown export (collapsible <details> per topic)
│   ├── SummaryPrAggregateMarkdownBuilder.ts  # Multi-commit branch-summary variant — rolls up every commit on the branch into a single PR description
│   ├── BranchSummaryLoader.ts            # Walks the branch and loads every commit's stored summary for the aggregate PR builder
│   ├── SummaryUtils.ts                   # Shared helpers (HTML escaping, date formatting, topic sorting)
│   │
│   ├── SettingsWebviewPanel.ts           # Singleton settings form (API keys, integrations, exclude patterns, push action)
│   ├── SettingsHtmlBuilder.ts
│   ├── SettingsCssBuilder.ts
│   ├── SettingsScriptBuilder.ts
│   │
│   └── NoteEditorWebviewPanel.ts         # Singleton "Add Text Snippet" editor
│       NoteEditorHtmlBuilder.ts / NoteEditorCssBuilder.ts / NoteEditorScriptBuilder.ts
│
└── util/
    ├── CommitMessageUtils.ts     # Commit message formatting and validation
    ├── ExcludeFilterManager.ts   # File-exclusion patterns for the Changes panel
    ├── FormatUtils.ts            # Relative date / size formatting shared across panels
    ├── LockUtils.ts              # File-based concurrency lock (used to detect Worker busy state)
    ├── Logger.ts                 # Output-channel logger
    ├── StatusBarManager.ts       # Bottom status-bar item
    └── WorkspaceUtils.ts         # Workspace root + bundled CLI path resolution
```

### State flow

```
file watcher / command / hook event
        │
        ▼
   stores/*.ts            ← owns mutable state, refreshes from JolliMemoryBridge
        │  emit() snapshot
        ▼
 services/data/*.ts       ← pure derivation (description strings, "can load more", filtering, …)
        │
        ▼
   providers/*.ts         ← getChildren() → TreeItem[]
```

The `services/data/` layer exists so derivation logic can be unit-tested without instantiating VSCode tree views, and so providers stay almost-trivial. Stores are the only place that calls into `JolliMemoryBridge`; commands and providers go through stores.

---

## Bundle Layout

`vscode/esbuild.config.mjs` produces these files in `dist/`, all CJS, all targeting Node 18:

| Bundle | Source | Notes |
|--------|--------|-------|
| `Extension.js` | `vscode/src/Extension.ts` | The VSCode extension host. Inlines all of `cli/src/**` (Installer, SummaryStore, JolliApiUtils, …). `vscode` is the only `external`. |
| `Cli.js` | `cli/src/Cli.ts` | The bundled CLI, invoked as a subprocess for enable/disable/status. Standalone — no global `jolli` install required. |
| `StopHook.js` | `cli/src/hooks/StopHook.ts` | Claude Code stop hook. |
| `SessionStartHook.js` | `cli/src/hooks/SessionStartHook.ts` | Claude Code session-start hook. |
| `GeminiAfterAgentHook.js` | `cli/src/hooks/GeminiAfterAgentHook.ts` | Gemini CLI `AfterAgent` hook. |
| `PrepareMsgHook.js` | `cli/src/hooks/PrepareMsgHook.ts` | Git `prepare-commit-msg`. |
| `PostCommitHook.js` | `cli/src/hooks/PostCommitHook.ts` | Git `post-commit` (enqueues + spawns Worker). |
| `PostRewriteHook.js` | `cli/src/hooks/PostRewriteHook.ts` | Git `post-rewrite` (hash remap). |
| `QueueWorker.js` | `cli/src/hooks/QueueWorker.ts` | Detached background worker spawned by `PostCommitHook.js`. |

`__PKG_VERSION__` (the extension version) and `__CLI_PKG_VERSION__` (the `@jolli.ai/cli` version) are inlined as compile-time constants by esbuild. The CLI version is embedded separately because the same `Cli.js` may ship inside this extension at a version that differs from what's on npm.

---

## Key Design Decisions

### Bundle & Distribution

**No global CLI dependency** — `Cli.js` and all hook scripts are bundled into `dist/` alongside `Extension.js`. The extension always uses `extensionPath/dist/Cli.js` — no global `jollimemory` install required.

**ESM/CJS bridging** — jollimemory core is pure ESM. The VSCode extension host requires CJS, so esbuild bundles every entry point as CJS and replaces `import.meta.url` with a real `__filename`-derived expression (via the `define` + `banner` shim in `esbuild.config.mjs`). This lets `Installer.ts` resolve hook scripts relative to the bundle at runtime.

**Automatic hook path refresh on upgrade** — On every activation, the extension reads `.git/hooks/post-commit` and checks whether it references the current `extensionPath`. If the paths belong to an older version directory (e.g. after a VSIX upgrade), the extension silently re-runs `enable` to write fresh paths. Hook installation uses dist-path indirection: hooks call `node "$($HOME/.jolli/jollimemory/resolve-dist-path)/PostCommitHook.js"`, where `resolve-dist-path` reads `~/.jolli/jollimemory/dist-path`. CLI vs extension write the same version-tagged dist-path, so whichever surface was enabled most recently wins.

---

### Hook Integration & Git Operations

**Enable/Disable via subprocess** — The toggle calls `dist/Cli.js` as a child process. At runtime, `Installer.ts` resolves hook script paths relative to `Cli.js` and writes those absolute paths into `.git/hooks/`, `.claude/settings.local.json`, and the equivalent Gemini config. This subprocess detour avoids `import.meta.url` issues that would otherwise arise when `Installer.ts` is bundled into the CJS extension bundle.

**Squash summary merging** — Two paths both produce `squash-pending.json` before the post-commit hook runs:

- **VS Code Squash button** (`squashCommits()`): computes the fork point (`git rev-parse <oldest>^`), writes `squash-pending.json` with `expectedParentHash = forkPointHash`, then runs `git reset --soft` + `git commit`. The `prepare-commit-msg` hook sees the file already exists (Step 0 guard) and skips its own detection.
- **Command-line `git reset --soft HEAD~N && git commit`**: `git reset` writes `.git/ORIG_HEAD` and a `"reset: moving to ..."` reflog entry. The `prepare-commit-msg` hook detects these signals through 5-layer validation (squash-pending absent → reflog starts with `"reset:"` → ORIG_HEAD exists → HEAD is ancestor of ORIG_HEAD → rev-list non-empty) and writes `squash-pending.json` automatically.

In both cases the post-commit Worker calls `mergeManyToOne()` to combine existing summaries — no LLM call needed, no race condition.

**git status on Windows** — `git status --porcelain=v1 -z` uses NUL terminators which the Windows CRT text-mode I/O layer may silently truncate. The bridge uses newline-separated output with `-c core.quotepath=false` instead, plus CRLF stripping.

---

### Auth & Sign-in

The extension declares `onUri` as an activation event. The OAuth flow opens the Jolli sign-in page in the user's browser, which redirects back to `vscode://jolli.jollimemory-vscode/auth-callback?token=…&jolli_api_key=sk-jol-…`. `Extension.ts` registers a `vscode.window.registerUriHandler` that delegates to `AuthService.handleAuthCallback()`:

- Credentials are saved to `~/.jolli/jollimemory/config.json` via the CLI's `saveAuthCredentials` — **not** VSCode SecretStorage. This keeps the CLI and extension in sync; signing in once works for both.
- The `jollimemory.signedIn` context key drives sidebar UI (banners, the sign-in/sign-out menu items in `package.json`).
- The URI handler logs the scheme/authority/path and a parameter count only — never `uri.toString()` or `uri.query`, because the Output channel persists for the window lifetime and frequently gets pasted into bug reports.
- `validateJolliApiKey` is called save-time (OAuth callback, `configure --set`, settings UI). Request paths trust the saved value; the allowlist (`jolli.ai`, `jolli.dev`, `jolli.cloud`, `jolli-local.me`) lives in `cli/src/core/JolliApiUtils.ts` and is shared with the CLI.

---

### Settings & Note Editor Webviews

Both panels are singletons (one instance at a time, focused if reopened) and use webview CSP with no `unsafe-inline` — all dynamic styles go through CSS classes, all events through `addEventListener`.

**SettingsWebviewPanel** renders the API keys, model, integration toggles (Claude / Gemini / Codex / OpenCode), Jolli push action, exclude patterns, and local folder. Save dispatches to `saveConfigScoped` and, when integration toggles changed, calls `installClaudeHook` / `installGeminiHook` / their counterparts across every worktree of the project. Hook-sync failures per worktree are surfaced individually instead of failing the whole save.

**NoteEditorWebviewPanel** is the "Add Text Snippet" entry point in the unified Plans/Notes panel `+` menu. On save it writes the snippet to `.jolli/jollimemory/notes/<slug>.md`, registers it in `plans.json`, opens it in an editor tab for further editing, and closes itself.

---

### Feature Design

**Transcript peek mode** — The commit message generator only sends the staged diff to the LLM (no transcript). The full transcript is reserved for the post-commit Worker, which reads it to produce the structured summary. This two-phase design keeps commit message generation fast and cheap while ensuring the post-commit summary gets the full context.

**LLM squash message generation** — When the user clicks **⊞ Squash**, `SquashCommand.ts` calls `JolliMemoryBridge.generateSquashMessageWithLLM(hashes)`. The bridge loads each commit's stored summary, extracts the `ticketId` from the first available summary (already determined by the original post-commit LLM call — no re-inference), collects each topic's `title` and `trigger` from all commits, then calls `Summarizer.generateSquashMessage()`. Full squashes (all branch commits) use the magic word "Closes"; partial squashes use "Part of". The call is wrapped in `vscode.window.withProgress({ location: ProgressLocation.Notification })` so the developer sees a progress toast while waiting. Falls back to concatenated commit titles if the API is unavailable or no summaries exist.

**Push to Jolli Space** — The summary webview posts the Markdown summary to a Jolli Space via `/api/push/jollimemory`. Authentication uses Jolli API keys (`sk-jol-…`); new-format keys embed the tenant URL as Base64-encoded JSON metadata, so no separate base URL configuration is needed. `JolliPushService` uses Node's `http` / `https` modules (not `fetch`) so it can talk to local self-signed dev servers (`jolli-local.me`).

**Create & Update PR section** — `PrCommentService.ts` encapsulates all GitHub PR logic. It uses the `gh` CLI (zero new dependencies) to check commit count, PR existence, and current PR body. The summary is embedded in the PR description using dual HTML comment markers (`<!-- jollimemory-summary-start -->` / `<!-- jollimemory-summary-end -->`); on update, only the marker region is replaced, preserving any user-written content above and below. The section transitions through states: `loading` → `multipleCommits` | `unavailable` | `noPr` | `ready`. Cancel button state is managed via `prCurrentState` to restore the correct visibility (link row vs status text) without a full re-render.

**Memories panel — lazy load + filter** — The Memories tree only fetches its first page on first visibility (`onDidChangeVisibility` in `Extension.ts`). Subsequent loads come from the in-store cache. When a filter is active, the bridge returns the matched set in one call and the "Load More" affordance is suppressed; without a filter it paginates. All this logic is split between `MemoriesStore` (cache + cursor) and `MemoriesDataService` (pure derivations like the description string and `canLoadMore`).

**Bulk export** — `ExportMemoriesCommand` exports every memory in the workspace to `~/Documents/jollimemory/<project>/` via the core `SummaryExporter`. The result toast offers an **Open folder** action when anything was written or skipped.

**Onboarding panel + auto-enable + durable opt-out** — `SidebarWebviewProvider` renders an onboarding flow on first activation (sign-in or inline Anthropic API key, then enable hooks). After the first repo is enabled, every newly opened workspace runs `installAll` automatically in the background. `ManualDisableFlag` records the user's explicit **Disable** decision into a per-repo file under `.jolli/jollimemory/`; on every activation the flag is checked first, so auto-enable never overrides a manual opt-out. Tests cover the four state combinations (never enabled, auto-enabled, manually enabled, manually disabled) so the durable flag does not get re-armed by unrelated config changes.

**Aggregate PR descriptions for multi-commit branches** — `BranchSummaryLoader` walks every commit between the branch's fork point and HEAD and loads each commit's stored summary; `SummaryPrAggregateMarkdownBuilder` then composes a single PR description with one collapsible `<details>` block per topic across all commits, preceded by Plans and the E2E Test Guide. The single-commit code path is unchanged (`SummaryPrMarkdownBuilder`); `PrCommentService` picks the right builder based on commit count.

**Memory Bank folder mode** — When the user opts in (Settings → Local Memory Bank → Migrate to Memory Bank), the extension drives the CLI's `StorageProvider` abstraction via `setActiveStorage()`. The sidebar webview shows a branch-aware folder view rendered by `KnowledgeBaseTreeProvider` (the class name still uses the legacy "KnowledgeBase" identifier; the user-facing label is "Memory Bank").

Two commands implement the lifecycle:

- `jollimemory.migrateToKnowledgeBase` — first migration. Picks a target folder, copies every existing memory into it as Markdown via `MigrationEngine`, and switches the active storage to `DualWriteStorage`.
- `jollimemory.rebuildKnowledgeBase` — re-migration. Triggered by clicking **Migrate to Memory Bank** in Settings after a previous migration. Creates a new `-N`-suffixed folder, runs the migration into it, and archives the previous folder's repo identity so the next `resolveKBPath()` picks the new one.

Both commands keep the orphan branch as the system of record; the folder is always derivable from it.

---

### Platform & UI

**Disable state in tree views** — VS Code `when` clauses on view declarations only affect initial visibility. Once `createTreeView()` is called, the view is always shown regardless of context-key changes. The workaround: `setEnabled(false)` causes `getChildren()` to return `[]`, which triggers the `viewsWelcome` placeholder defined in `package.json`.

**Webview CSP — no inline style/JS** — All webviews use a strict CSP with no `unsafe-inline`. Dynamic visibility uses a `.hidden` CSS class (not the HTML `hidden` attribute, which is silently overridden by `display: flex`). Inline `style=""` and inline event handlers are dropped silently and must be replaced by classes + `addEventListener`.

**Worktree-aware** — Hooks and summaries work across `git worktree` checkouts. `git rev-parse --git-path` is used everywhere to resolve paths under `.git/`, because in a worktree `.git` is a pointer file rather than a directory.
