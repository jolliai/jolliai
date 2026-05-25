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

Per-integration enable/disable lives in the global config (`claudeEnabled`, `geminiEnabled`, `codexEnabled`, `openCodeEnabled`, `cursorEnabled`, `copilotEnabled`) and is toggled from the **Settings** webview's **AI Agents** tab. The single `copilotEnabled` switch covers both Copilot CLI and Copilot Chat — splitting them was rejected because users almost always want them together. Discoverable-but-disabled integrations show up in the sidebar **Status** tab as "detected but disabled". OpenCode and the Copilot family additionally surface a separate **scan-error** row when their backing store is present but unreadable (corrupt, locked, schema-incompatible) — this avoids the past failure mode where a corrupt DB rendered as a healthy-looking integration.

### Git Hooks — Summary Generation Pipeline

| Hook | When | What it does |
|------|------|-------------|
| **prepare-commit-msg** (`PrepareMsgHook`) | Before commit | Detects squash / amend scenarios and writes pending files for the Worker. |
| **post-commit** (`PostCommitHook`) | After commit | Synchronously enqueues an entry into `.jolli/jollimemory/git-op-queue/` and spawns a detached `QueueWorker`. Returns in <5 ms — the LLM call happens entirely in the background. |
| **post-rewrite** (`PostRewriteHook`) | After rebase/amend | Migrates existing summaries to match new commit hashes (1:1 hash remapping). |
| **`QueueWorker`** _(spawned, not installed)_ | When `post-commit` enqueues | Holds a 5-minute file lock, drains queue entries in timestamp order, runs the LLM where needed, and chain-spawns a successor if more entries arrive. |

Summaries are stored on a git orphan branch (`jollimemory/summaries/v3`) using a v3 tree format. Raw AI conversations are preserved as `transcripts/{commitHash}.json` alongside the distilled summaries. The orphan branch is **never checked out** — reads use `git show`, writes use plumbing (`hash-object`, `mktree`, `commit-tree`, `update-ref`). On 0.99+ both summaries and transcripts go through `DualWriteStorage` by default, so each write also lands in the Memory Bank folder, which has two layers (see `cli/src/core/FolderStorage.ts` for the source of truth):
- **Hidden** `<localFolder>/<repo>/.jolli/` — canonical JSON: `summaries/<commitHash>.json`, `transcripts/<commitHash>.json`, `index.json`, `shadow-status.json`. This is what `FolderStorage.readFile()` / `writeFiles()` read and write.
- **Visible** `<localFolder>/<repo>/<branch>/...` — human-browsable Markdown auto-generated from the JSON: `<slug>-<hash8>.md` for summaries (`FolderStorage.generateSummaryMarkdown()`), `plan--<slug>.md` for plans, plus visible note copies. The slug comes from the commit message via `FolderStorage.slugify()`.

The orphan branch stays the read source — the visible Markdown layer is generated, never read back. `<localFolder>` is the user-picked Memory Bank root (the `localFolder` config); `<repo>` is the per-repo subfolder created by `KBPathResolver.resolveKBPath()`.

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
│   └── SquashCommand.ts          # Squash flow (range selection + LLM message + force-push guard)
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
│   ├── AuthService.ts            # OAuth callback URI handling (code-exchange flow + CSRF state validation per RFC 6749), sign-in / sign-out, jollimemory.signedIn context key. Carries `device_label` (hostname + OS) and `client_version` into the OAuth URL so the Jolli web UI can name authorized sessions, and preserves the per-flow nonce across the `openExternal=false` Copy URL path so the manual fallback still completes a sign-in.
│   ├── ActiveSessionsProvider.ts # Background poller over the seven per-source session aggregators. Powers the Branch tab's CONVERSATIONS section — emits `ActiveSession[]` snapshots that the sidebar webview renders without manual refresh.
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
│   ├── SidebarWebviewProvider.ts         # Top-level sidebar webview that hosts the 3 tabs (Branch / Memory Bank / Status) and the onboarding / api-key / disabled panels
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
│   ├── SettingsWebviewPanel.ts           # Singleton 5-tab settings form (AI Agents / AI Summary / Sync to Jolli / Memory Bank / Others). Others tab adds the `dcoSignoff` toggle.
│   ├── SettingsHtmlBuilder.ts
│   ├── SettingsCssBuilder.ts
│   ├── SettingsScriptBuilder.ts
│   │
│   ├── ConversationDetailsPanel.ts        # Per-session transcript editor opened from the CONVERSATIONS section. Browse, edit, restore, or delete individual turns; on save, writes a `ConversationOverlay` to disk that the summarization pipeline consults at commit time so the LLM sees the curated version, not the raw transcript.
│   ├── ConversationDetailsHtmlBuilder.ts  # HTML for the transcript editor (turn list, per-turn actions, restore-all)
│   ├── ConversationDetailsScriptBuilder.ts  # Embedded JS — turn selection, edit/restore/delete actions, message bus to the panel host
│   ├── TranscriptEntryRenderer.ts         # Shared per-turn renderer used by both the Summary Webview "All Conversations" section and the Conversation Details panel
│   │
│   └── NoteEditorWebviewPanel.ts         # Singleton "Add Text Snippet" editor
│       NoteEditorHtmlBuilder.ts / NoteEditorCssBuilder.ts / NoteEditorScriptBuilder.ts
│
└── util/
    ├── CommitMessageUtils.ts     # Commit message formatting and validation
    ├── ExcludeFilterManager.ts   # File-exclusion patterns for the Changes section in the Branch tab
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

The extension declares `onUri` as an activation event. The OAuth flow opens the Jolli sign-in page in the user's browser, which redirects back to `vscode://jolli.jollimemory-vscode/auth-callback?code=<32-byte-hex>` (or `?error=<reason>` on failure) — the callback carries a one-time **authorization code only**, never the credentials themselves. `Extension.ts` registers a `vscode.window.registerUriHandler` that delegates to `AuthService.handleAuthCallback()`, which then POSTs the code to `/api/auth/cli-exchange` to redeem the actual `authToken` + `jolliApiKey` over a server-side channel. This is the RFC 6749 authorization-code exchange flagged in the 0.99.0 CHANGELOG as "Hardened sign-in" — it ensures secrets never appear in URL bars, browser history, OS-level URI dispatch logs, or any place a `vscode://` URL would otherwise be visible.

- Credentials are saved to `~/.jolli/jollimemory/config.json` via the CLI's `saveAuthCredentials` — **not** VSCode SecretStorage. This keeps the CLI and extension in sync; signing in once works for both.
- The `jollimemory.signedIn` context key drives sidebar UI (banners, the sign-in/sign-out menu items in `package.json`).
- The URI handler logs the scheme/authority/path and a parameter count only — never `uri.toString()` or `uri.query`. Even though the URI itself no longer carries credentials, the Output channel persists for the window lifetime and frequently gets pasted into bug reports, so we keep the redaction defensive.
- A nonce/state value is generated before launching the browser and validated when the callback arrives, so a captured callback URL can't be replayed to inject a foreign session.
- `validateJolliApiKey` is called save-time (OAuth callback exchange result, `configure --set`, settings UI). Request paths trust the saved value; the allowlist (`jolli.ai`, `jolli.dev`, `jolli.cloud`, `jolli-local.me`) lives in `cli/src/core/JolliApiUtils.ts` and is shared with the CLI.

---

### Settings & Note Editor Webviews

Both panels are singletons (one instance at a time, focused if reopened) and use webview CSP with no `unsafe-inline` — all dynamic styles go through CSS classes, all events through `addEventListener`.

**SettingsWebviewPanel** renders the 5-tab Settings UI (AI Agents / AI Summary / Sync to Jolli / Memory Bank / Others) — covering integration toggles (Claude / Gemini / Codex / OpenCode / Cursor / Copilot), the AI Summary `aiProvider` choice and its provider-specific cards (Anthropic `apiKey` + `model` + `maxTokens`, or the Jolli sign-in state with `jolliApiKey` under an Advanced disclosure), the Sync to Jolli sign-in/out actions, the Memory Bank `localFolder` + Migrate button, and `excludePatterns` for the Branch tab's Changes section. Save dispatches to `saveConfigScoped` and, when integration toggles changed, calls `installClaudeHook` / `installGeminiHook` / their counterparts across every worktree of the project. Hook-sync failures per worktree are surfaced individually instead of failing the whole save. The legacy `pushAction` config field and its "Push to Jolli & Local" pathway were fully removed — `cli/src/core/LocalPusher.ts` and the surrounding orchestration are gone. Memory Bank now covers the local-copy use case on every commit (dual-write), so an opt-in for manual local copies is no longer needed.

**NoteEditorWebviewPanel** is the "Add Text Snippet" entry point in the unified Plans/Notes panel `+` menu. On save it writes the snippet to `.jolli/jollimemory/notes/<slug>.md`, registers it in `plans.json`, opens it in an editor tab for further editing, and closes itself.

---

### Feature Design

**Transcript peek mode** — The commit message generator only sends the staged diff to the LLM (no transcript). The full transcript is reserved for the post-commit Worker, which reads it to produce the structured summary. This two-phase design keeps commit message generation fast and cheap while ensuring the post-commit summary gets the full context.

**LLM squash message generation** — When the user clicks **⊞ Squash**, `SquashCommand.ts` calls `JolliMemoryBridge.generateSquashMessageWithLLM(hashes)`. The bridge loads each commit's stored summary, extracts the `ticketId` from the first available summary (already determined by the original post-commit LLM call — no re-inference), collects each topic's `title` and `trigger` from all commits, then calls `Summarizer.generateSquashMessage()`. Full squashes (all branch commits) use the magic word "Closes"; partial squashes use "Part of". The call is wrapped in `vscode.window.withProgress({ location: ProgressLocation.Notification })` so the developer sees a progress toast while waiting. Falls back to concatenated commit titles if the API is unavailable or no summaries exist.

**Push to Jolli Space** — The summary webview posts the Markdown summary to a Jolli Space via `/api/push/jollimemory`. Authentication uses Jolli API keys (`sk-jol-…`); new-format keys embed the tenant URL as Base64-encoded JSON metadata, so no separate base URL configuration is needed. `JolliPushService` uses Node's `http` / `https` modules (not `fetch`) so it can talk to local self-signed dev servers (`jolli-local.me`).

**Create & Update PR section** — `PrCommentService.ts` encapsulates all GitHub PR logic. It uses the `gh` CLI (zero new dependencies) to check commit count, PR existence, and current PR body. The summary is embedded in the PR description using dual HTML comment markers (`<!-- jollimemory-summary-start -->` / `<!-- jollimemory-summary-end -->`); on update, only the marker region is replaced, preserving any user-written content above and below. The section transitions through states: `loading` → `multipleCommits` | `unavailable` | `noPr` | `ready`. Cancel button state is managed via `prCurrentState` to restore the correct visibility (link row vs status text) without a full re-render.

**Memories store — lazy load + filter** — `MemoriesTreeProvider` is no longer registered as a VS Code TreeView; the sidebar is a single webview that renders the Branch tab and Memory Bank tab directly. `MemoriesStore` and `MemoriesDataService` are kept as a data layer that the webview consumes via `JolliMemoryBridge`. The lazy-load pattern still applies: the first page is fetched on first visibility of the surface that consumes it, subsequent loads come from the in-store cache; when a filter is active the bridge returns the matched set in one call (no pagination), without a filter it paginates with a `canLoadMore` derivation.

**Onboarding panel + auto-enable + durable opt-out** — `SidebarWebviewProvider` renders an onboarding flow on first activation (sign-in or inline Anthropic API key, then enable hooks). After the first repo is enabled, every newly opened workspace runs `installAll` automatically in the background. `ManualDisableFlag` records the user's explicit **Disable** decision into a per-repo file under `.jolli/jollimemory/`; on every activation the flag is checked first, so auto-enable never overrides a manual opt-out. Tests cover the four state combinations (never enabled, auto-enabled, manually enabled, manually disabled) so the durable flag does not get re-armed by unrelated config changes.

**Aggregate PR descriptions for multi-commit branches** — `BranchSummaryLoader` walks every commit between the branch's fork point and HEAD and loads each commit's stored summary; `SummaryPrAggregateMarkdownBuilder` then composes a single PR description with one collapsible `<details>` block per topic across all commits, preceded by Plans and the E2E Test Guide. The single-commit code path is unchanged (`SummaryPrMarkdownBuilder`); `PrCommentService` picks the right builder based on commit count.

**Regenerate Summary + stale-write guards** — Every Summary Webview has a **Regenerate** action backed by the CLI's `Regenerator` + `RegenerateContext` modules. While a regenerate call is in flight, `SummaryWebviewPanel` switches the page into a `regenerating-readonly` state (CSS class on the root element dims topics + recap, disables every write action, and shows an inline banner explaining the wait). Every write path on the panel (push, edit, regenerate, plan/note add-remove, …) re-checks the commit hash inside the race window via `JolliMemoryBridge.assertCommitStillCurrent()` before writing — if the hash has changed on disk between the user's click and the LLM call completing, the write is rejected with a clear "commit has been rewritten" error rather than silently clobbering. The same hash re-check guards the regenerate response handler itself, so an amend / squash that lands mid-regenerate cannot clobber the new history.

**Stale-rewritten-commit read-only mode** — When a commit shown in a Summary Webview is rewritten (amend / squash / rebase / branch-switch) while the panel is open, the panel is **not** disposed. Instead `SummaryWebviewPanel` flips into a persistent stale-read-only mode: the warning banner explains that the commit has been rewritten and that the panel will not accept new writes; the same body content remains readable so the user can copy out anything they were drafting. This replaces the prior "dispose mid-edit" behaviour that caused users to lose in-progress edits during squash. See `SummaryCssBuilder` (`stale-readonly` + `regenerating-readonly` classes) and the corresponding `SummaryScriptBuilder` handlers.

**Linear issues in the Summary Webview** — When the AI conversation calls the Linear MCP server, the issues are extracted at commit time on the CLI side (`LinearIssueExtractor` → `LinearIssueStore`). The extension renders them as their own panel section between Plans & Notes and E2E Test Guide (`SummaryHtmlBuilder.renderLinearIssues`), embeds them into the Markdown export (`SummaryMarkdownBuilder`), and into the PR description (`SummaryPrMarkdownBuilder` / `SummaryPrAggregateMarkdownBuilder`). Linear issues are hoisted onto the consolidated root on squash / rebase by `QueueWorker.runSquashPipeline` exactly the same way Plans and Notes are, so the link follows the commit through history rewrites.

**Active Conversations sidebar + per-turn editing** — `ActiveSessionsProvider` polls every per-source aggregator on a short cadence and emits `ActiveSession[]` to the sidebar webview, which renders the CONVERSATIONS section in the Branch tab. Clicking a session opens `ConversationDetailsPanel` — a dedicated webview that shows every turn with edit / delete / restore actions. Edits are persisted as a `ConversationOverlay` (per-session JSON under the project's `.jolli/jollimemory/`) and the summarization pipeline consults the overlay at commit time, so the next memory is generated from the curated version. `TranscriptEntryRenderer` is shared between the Conversation Details panel and the Summary Webview's "All Conversations" section to keep the per-turn rendering identical.

**Per-item commit selection** — Plans, notes, conversations, and files can each be unchecked from the next commit's memory via per-row checkboxes in the Branch tab. Selections are persisted by the CLI's `CommitSelectionStore` (per-project file) so they survive commits and restarts; `SidebarScriptBuilder` and `SidebarMessages` carry the toggle events to the host. The post-commit pipeline consults the same store when assembling the LLM context — anything the user excluded is omitted from the prompt, not just the UI.

**Rich hover cards on Plans panel** — The Plans & Notes section in the Branch tab uses `vscode.MarkdownString`-backed hover cards built by `FormatUtils` + `PlansTreeProvider`, showing the title, source path, last-updated time, and a snippet of the body. The card is built lazily on first hover; the regression that lost the panel's scroll position on refresh is fixed by reusing the existing TreeItem identity instead of recreating items.

**Opt-in DCO sign-off on AI Commit** — Settings → Others adds the **DCO sign-off** toggle, backed by the new CLI `dcoSignoff` config. When on, `CommitCommand` appends `Signed-off-by: <user.name> <user.email>` to the LLM-generated commit message before the actual `git commit`. Off by default; the toggle is per-machine (global config) so it lights up for every repo on the machine.

**PR lookup uses `gh pr list` with history; fork PRs are excluded** — `PrCommentService.fetchBranchPrs` switched from `gh pr view` (which only returns the single open PR on the branch) to `gh pr list --state all --head <branch>` so historical closed / merged PRs on the same branch can be found. Fork PRs (where the head repo doesn't match the base repo) are filtered out before the panel offers an edit action — the foreign-denial assertion is pinned in `PrCommentService.test.ts` so the filter cannot regress. The `--arg-stdin` bridging that the extension uses to pass long arguments through the CLI also gained length / content guards so a stray block of `--help` output cannot be piped through as input.

**Memory Bank folder mode** — Memory Bank is on by default. `StorageFactory.createStorage` defaults to `"dual-write"`, so every commit's hooks write the memory to **both** the orphan branch and the configured Memory Bank folder; no `setActiveStorage()` toggle is involved at runtime. The orphan branch stays the system of record (reads come from there); the folder mirror is derivable from it. Cross-repo reads from the MEMORY BANK tab go through `FolderStorage` instead of git plumbing so opening a memory from a sibling repo's subfolder never invokes `git show` in the wrong working tree. The Memory Bank sidebar tab renders a branch-aware folder view via `KnowledgeBaseTreeProvider` (the class name still uses the legacy "KnowledgeBase" identifier; the user-facing label is "Memory Bank").

Two migration paths populate the folder:

1. **Automatic, on every `activate()`** — the dominant path for typical users. The extension resolves `kbRoot` from `cfg.localFolder` (or the default), calls `MetadataManager.readMigrationState()`, and runs `MigrationEngine.runMigration()` whenever the orphan branch has data but `migrationState` is missing or not `"completed"`. No UI is shown beyond the eventual sidebar refresh. Failures are logged via `log.error("activate", "KB folder init/migration failed", err)` and don't abort the rest of activate.
2. **`jollimemory.rebuildKnowledgeBase`** — internal command, NOT in the command palette. Wired only to the Settings webview's **Migrate to Memory Bank** button (`SettingsScriptBuilder.ts` posts `command: 'rebuildKnowledgeBase'`). Calls `findFreshKBPath()` to obtain a non-colliding path under the user's chosen `localFolder` (which adds a `-N` suffix only if the base path is already in use), runs the migration into the fresh folder, and — if the path actually moved — rewrites the **old** folder's `.jolli/config.json` to drop `remoteUrl` and rename `repoName` to `${repoName}-archived-${Date.now()}`, so future `resolveKBPath()` calls won't reuse it. Old content files are left untouched. Returns `{ ok, message }` for the webview to render in-place rather than firing a toast.

---

### Platform & UI

**Webview CSP — no inline style/JS** — All webviews use a strict CSP with no `unsafe-inline`. Dynamic visibility uses a `.hidden` CSS class (not the HTML `hidden` attribute, which is silently overridden by `display: flex`). Inline `style=""` and inline event handlers are dropped silently and must be replaced by classes + `addEventListener`.

**Worktree-aware** — Hooks and summaries work across `git worktree` checkouts. `git rev-parse --git-path` is used everywhere to resolve paths under `.git/`, because in a worktree `.git` is a pointer file rather than a directory.
