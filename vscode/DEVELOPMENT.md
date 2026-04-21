# Jolli Memory VS Code Extension — Development Guide

---

## First-time Setup

```bash
# 1. Build the jollimemory core (the extension bundles it at build time via esbuild)
cd cli
npm install && npm run build

# 2. Install extension dev dependencies
cd vscode
npm install

# 3. Deploy (bumps patch version, builds, packages, and installs into your VS Code)
npm run deploy
```

After the first install, open any git repository. The JolliMemory icon appears in the Activity Bar.

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

The extension bundles `cli/` at build time. If you change files under `cli/src/`, rebuild the core first:

```bash
cd cli && npm run build
cd ../vscode && npm run deploy
```

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
| **prepare-commit-msg** | Before commit | Detects squash / amend scenarios and writes pending files for the Worker |
| **post-commit** | After commit | Spawns a background Worker that reads transcripts + diff, calls the LLM, and writes the summary to the orphan branch |
| **post-rewrite** | After rebase/amend | Migrates existing summaries to match new commit hashes (1:1 hash remapping) |

Summaries are stored in a git orphan branch (`jollimemory/summaries/v3`) using a v3 tree format. Raw AI conversations are optionally preserved as `transcripts/{commitHash}.json` alongside the distilled summaries.

---

## Architecture

```
src/
├── Extension.ts                  # activate/deactivate — wires all providers & commands
├── JolliMemoryBridge.ts          # Core bridge: wraps all jollimemory API and git ops
├── Types.ts                      # Extension-specific types (FileStatus, BranchCommit)
├── commands/
│   ├── CommitCommand.ts          # AI commit flow (QuickPick + 3 actions)
│   ├── PushCommand.ts            # Git push with force-push guard
│   └── SquashCommand.ts          # Squash flow (range selection + LLM message + force-push guard)
├── providers/
│   ├── StatusTreeProvider.ts     # Status panel tree data
│   ├── FilesTreeProvider.ts      # Changes tree data + FileSystemWatcher
│   └── HistoryTreeProvider.ts    # Commits tree data + range checkbox logic
├── services/
│   ├── JolliPushService.ts       # HTTP client for pushing summaries to Jolli Space
│   └── PrCommentService.ts       # GitHub PR creation/update via gh CLI; HTML/CSS/JS snippets for the PR section
├── views/
│   ├── SummaryWebviewPanel.ts    # Thin orchestrator: panel lifecycle, message routing, topic edit/delete
│   ├── SummaryHtmlBuilder.ts     # Assembles the full HTML document from modular building blocks
│   ├── SummaryMarkdownBuilder.ts # Builds the Markdown export string for clipboard and Jolli push
│   ├── SummaryCssBuilder.ts      # Returns the full CSS stylesheet (Notion-like clean design)
│   ├── SummaryScriptBuilder.ts   # Returns the embedded JS for toggles, edit/delete, PR interactions
│   └── SummaryUtils.ts           # Shared types and utility functions (HTML escaping, date formatting, topic sorting)
└── util/
    ├── CommitMessageUtils.ts     # Commit message formatting and validation
    ├── ExcludeFilterManager.ts   # File exclusion pattern manager for Changes panel
    ├── LockUtils.ts              # File-based concurrency lock utilities
    ├── Logger.ts                 # Extension-specific logging to the Output channel
    ├── StatusBarManager.ts       # Bottom status bar item
    └── WorkspaceUtils.ts         # Workspace root + CLI path resolution
```

---

## Key Design Decisions

### Bundle & Distribution

**No global CLI dependency** — `Cli.js` and all hook scripts (`StopHook.js`, `PostCommitHook.js`, etc.) are bundled into `dist/` alongside `Extension.js` by the build step. The extension always uses `extensionPath/dist/Cli.js` — no global `jollimemory` install required.

**ESM/CJS bridging** — jollimemory is a pure ESM package. esbuild bundles it inline into a single CJS file (required by the VSCode extension host). Only `vscode` is kept external.

**Automatic hook path refresh on upgrade** — On every activation, the extension reads `.git/hooks/post-commit` and checks whether it references the current `extensionPath`. If the paths belong to an older version directory, the extension silently re-runs `enable` to write fresh paths. No manual disable → enable step is required after upgrading.

---

### Hook Integration & Git Operations

**Enable/Disable via subprocess** — The enable/disable toggle calls `dist/Cli.js` as a child process. At runtime, `Installer.ts` resolves hook script paths relative to `Cli.js` and writes those absolute paths into `.git/hooks/` and `.claude/settings.local.json`. This avoids `import.meta.url` issues that arise when `Installer.ts` is bundled directly into the CJS extension bundle.

**Squash summary merging** — Two paths both produce `squash-pending.json` before the post-commit hook runs:

- **VSCode Squash button** (`squashCommits()`): computes the fork point hash first (`git rev-parse <oldest>^`), writes `squash-pending.json` with `expectedParentHash = forkPointHash`, then runs `git reset --soft` + `git commit`. The `prepare-commit-msg` hook detects the file already exists (Step 0 guard) and skips its own detection to avoid overwriting.

- **Command-line `git reset --soft HEAD~N && git commit`**: `git reset` writes `.git/ORIG_HEAD` and a `"reset: moving to ..."` reflog entry. The `prepare-commit-msg` hook detects these signals through 5-layer validation (squash-pending absent → reflog starts with `"reset:"` → ORIG_HEAD exists → HEAD is ancestor of ORIG_HEAD → rev-list non-empty) and writes `squash-pending.json` automatically.

In both cases the post-commit Worker calls `mergeManyToOne()` to combine existing summaries into a tree structure — no LLM call needed, no race condition.

**git status on Windows** — `git status --porcelain=v1 -z` uses NUL terminators which the Windows CRT text-mode I/O layer may silently truncate. The bridge uses newline-separated output with `-c core.quotepath=false` instead, plus CRLF stripping.

---

### Feature Design

**Transcript peek mode** — The commit message generator only sends the staged diff to the LLM (no transcript). The full conversation transcript is reserved for the post-commit hook, which reads it to produce the detailed structured summary. This two-phase design keeps commit message generation fast and cheap while ensuring the post-commit summary gets the full context.

**LLM squash message generation** — When the user clicks **⊞ Squash**, `SquashCommand.ts` calls `JolliMemoryBridge.generateSquashMessageWithLLM(hashes)`. The bridge loads each commit's stored summary, extracts the `ticketId` from the first available summary (already determined by the original post-commit LLM call — no re-inference needed), collects each topic's `title` and `trigger` from all commits, then calls `Summarizer.generateSquashMessage()` with a structured prompt. Full squashes (all branch commits) use the magic word "Closes"; partial squashes use "Part of". The call is wrapped in `vscode.window.withProgress({ location: ProgressLocation.Notification })` so the developer sees a progress toast while waiting. Falls back to concatenated commit titles if the API is unavailable or no summaries exist.

**Push to Jolli Space** — The summary webview posts the Markdown summary to a Jolli Space via the `/api/push/jollimemory` endpoint. Authentication uses Jolli API keys (`sk-jol-...`). New-format keys embed the tenant URL as Base64-encoded JSON metadata, so no separate base URL configuration is needed. The `JolliPushService` uses Node.js `http`/`https` modules (not `fetch`). The Jolli site URL is resolved solely from the API key metadata.

**Create & Update PR section** — `PrCommentService.ts` encapsulates all GitHub PR logic. It uses the `gh` CLI (zero new dependencies) to check commit count, PR existence, and current PR body. The summary is embedded in the PR description using dual HTML comment markers (`<!-- jollimemory-summary-start -->` / `<!-- jollimemory-summary-end -->`); on update, only the marker region is replaced, preserving any user-written content above and below. The section transitions through states: `loading` → `multipleCommits` | `unavailable` | `noPr` | `ready`. Cancel button state is managed via a `prCurrentState` variable to restore the correct visibility (link row vs status text) without a full re-render.

---

### Platform & UI

**Disable state in tree views** — VS Code `when` clauses on view declarations only affect initial visibility. Once `createTreeView()` is called, the view is always shown regardless of context key changes. The workaround: `setEnabled(false)` causes `getChildren()` to return `[]`, which triggers the `viewsWelcome` placeholder defined in `package.json`.
