# Jolli Memory CLI — Development Guide

Technical implementation details, architecture, and code flow documentation for contributors.

## Build & Test

```bash
# Install dependencies
npm install

# Build (vite lib mode, multi-entry)
npm run build

# Run tests
npm run test

# Run tests with coverage (97%+ threshold)
npm run test:coverage

# Lint (biome)
npm run lint

# All checks (lint + build + test with coverage)
npm run all
```

## Local CLI Testing

The recommended way to test locally is a global symlink install — this mirrors the real end-user experience (`npm install -g @jolli.ai/cli`) with the same command name, path resolution, and shebang behavior.

```bash
# One-time setup: create a global symlink to your local build
cd cli
npm run build
npm install -g .

# Now `jolli` is available system-wide
jolli status
jolli enable
jolli view
```

After the one-time setup, the daily workflow is just:

```bash
# Edit code → rebuild → test immediately (no reinstall needed)
npm run build
jolli status
```

`npm install -g .` creates a symlink, so the global command always points to your local `dist/` directory. Rebuilding is enough — no need to re-run `npm install -g .`.

**Alternative**: `npm run cli -- <command>` runs TypeScript source directly via `tsx` (no build step), useful for quick iteration but doesn't test the actual build output.

## Architecture Overview

```
                    AI Agent Session
              (Claude / Codex / Gemini / OpenCode /
               Cursor / Copilot CLI / Copilot Chat)
                           │
                    ┌──────┴──────┐
                    │  Stop Event  │  (Claude only — Gemini uses AfterAgent;
                    └──────┬──────┘   every other source has no hook)
                           │ stdin JSON
                    ┌──────┴──────┐
                    │  StopHook   │  Saves session info to
                    │  (Node.js)  │  <projectDir>/.jolli/jollimemory/sessions.json
                    └─────────────┘
                  (Codex sessions are discovered by scanning ~/.codex/sessions/
                   at post-commit time. OpenCode reads
                   ~/.local/share/opencode/opencode.db via node:sqlite.
                   Cursor / Copilot CLI / Copilot Chat are each discovered by
                   their own per-source detector + session discoverer at
                   post-commit time, with the same lazy-import + feature-gate
                   pattern as OpenCode.)

                    ... developer codes ...

                    ┌─────────────┐
                    │ git commit  │
                    └──────┬──────┘
                           │
              ┌────────────┼─────────────────┐
              │            │                 │
       prepare-commit-msg  │  post-commit    │  post-rewrite
       (before commit)     │  (after commit) │  (after amend/rebase)
              │            │                 │
      ┌───────┴──────┐ ┌──┴──────────┐ ┌────┴───────────┐
      │PrepareMsgHook│ │PostCommitHook│ │PostRewriteHook │
      │detect squash │ │detect type,  │ │enqueue amend/  │
      │write pending │ │enqueue op,   │ │rebase entries  │
      │file          │ │spawn worker  │ │spawn if needed │
      └──────────────┘ └──────────────┘ └────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │   QueueWorker.ts   │  Background process:
                    │   (detached)       │  drain queue → process each entry
                    └─────────┬──────────┘
                              │
                 ┌────────────┼────────────┐
                 │            │            │
          ┌──────┴───┐ ┌─────┴────┐ ┌─────┴──────┐
          │Transcript│ │  GitOps  │ │ Summarizer │
          │  Reader  │ │ (diff)   │ │ (Anthropic │
          └──────────┘ └──────────┘ │   API)     │
                                    └──────┬─────┘
                                           │
                                    ┌──────┴──────┐
                                    │SummaryStore │  Writes to orphan branch
                                    │(orphan      │  jollimemory/summaries/v3
                                    │ branch)     │
                                    └─────────────┘
```

## Entry Points (Built as separate dist files)

| Module | Build Output | Purpose |
|--------|-------------|---------|
| [Cli.ts](src/Cli.ts) | `dist/Cli.js` | CLI commands — Memory: `enable` / `disable` / `status` / `doctor` / `clean` / `heal-folder` / `view` / `export` / `recall` / `search` / `compile` / `graph` / `pr-description` / `mcp` / `sync-memory-bank` / `telemetry` / `configure` / `migrate`; Auth: `auth login` / `logout` / `status`; Site (stubs unless `@jolli.ai/site-cli` is installed): `new` / `convert` / `dev` / `build` / `start`. Delegates command registration to per-command modules under `src/commands/` and to `Api.registerCli` so the same registration pipeline is reusable by plugins and the test harness. |
| [Api.ts](src/Api.ts) | `dist/Api.js` | Public API entry (`@jolli.ai/cli/api`). Exports `PluginContext`, `PluginRegister`, `parseJolliApiKey`, `parseBaseUrl`; runs `loadPlugins` after built-in command registration so plugins can append subcommands without touching `Cli.ts`. Backed by an `exports` field in `package.json` that explicitly blocks deep `@jolli.ai/cli/dist/*` imports. |
| [PluginLoader.ts](src/PluginLoader.ts) | inlined in `dist/Api.js` | Plugin discovery — scans the current git project's `node_modules` and the global npm root for entries on the `KNOWN_PLUGINS` allow-list, validates the plugin's `peerDependencies['@jolli.ai/cli']` range against the host's `VERSION`, and invokes the plugin's `register(ctx)` once. Non-throwing — a broken plugin logs and is skipped, never blocks the CLI. Disabled entirely by `JOLLI_NO_PLUGINS=1`. |
| [StopHook.ts](src/hooks/StopHook.ts) | `dist/StopHook.js` | Claude Code Stop event handler. Saves session metadata, then runs one incremental discovery pass (plans + references) sharing a single `discovery-cursors.json` line. Plan scan/upsert lives in [core/plans/](src/core/plans/), not inline here. |
| [SessionStartHook.ts](src/hooks/SessionStartHook.ts) | `dist/SessionStartHook.js` | Claude Code SessionStart hook (injects mini-briefing) |
| [PostCommitHook.ts](src/hooks/PostCommitHook.ts) | `dist/PostCommitHook.js` | Git post-commit hook (operation detection + queue enqueue + worker spawn) |
| [QueueWorker.ts](src/hooks/QueueWorker.ts) | `dist/QueueWorker.js` | Background queue processor — LLM summarization for `commit` / `amend`, LLM-driven `generateSquashConsolidation` (with mechanical merge as fallback) for `squash` / `rebase-squash`, and 1:1 hash migration for `rebase-pick` |
| [PostRewriteHook.ts](src/hooks/PostRewriteHook.ts) | `dist/PostRewriteHook.js` | Git post-rewrite hook (enqueues amend/rebase entries) |
| [PrepareMsgHook.ts](src/hooks/PrepareMsgHook.ts) | `dist/PrepareMsgHook.js` | Git prepare-commit-msg hook (squash detection) |
| [GeminiAfterAgentHook.ts](src/hooks/GeminiAfterAgentHook.ts) | `dist/GeminiAfterAgentHook.js` | Gemini CLI AfterAgent event handler |

## Core Modules

| Module | Purpose |
|--------|---------|
| [Types.ts](src/Types.ts) | All shared TypeScript interfaces |
| [Logger.ts](src/Logger.ts) | Unified logging with timestamps, module tags, and file output. Uses `stat()` to check whether `.jolli/jollimemory/` exists before writing — never creates the directory just for logging |
| [GitOps.ts](src/core/GitOps.ts) | Git command wrapper + orphan branch plumbing operations |
| [SessionTracker.ts](src/core/SessionTracker.ts) | Manages `.jolli/jollimemory/` state files, config, lock, and git operation queue CRUD |
| [TranscriptReader.ts](src/core/TranscriptReader.ts) | Parses Claude Code JSONL transcript files with cursor-based incremental reading |
| [TranscriptParser.ts](src/core/TranscriptParser.ts) | Source-specific parsers (Claude, Codex, Gemini) |
| [GeminiTranscriptReader.ts](src/core/GeminiTranscriptReader.ts) | Dedicated JSON reader for Gemini transcript format |
| [CodexSessionDiscoverer.ts](src/core/CodexSessionDiscoverer.ts) | Discovers Codex CLI sessions by scanning the filesystem |
| [CodexDiscovery.ts](src/core/CodexDiscovery.ts) | Codex polling-path artifact discovery (`discoverCodexConversations`). Extracts Linear/Jira/GitHub/Notion references **and markdown plans** from Codex rollout transcripts on the VS Code sidebar's 60s polling tick. References scan first; their safe cursor caps plan scanning so plans never re-process lines a later poll re-reads (no plans.json churn). Reuses the shared source-agnostic envelope parser ([references/TranscriptEnvelopeParser.ts](src/core/references/TranscriptEnvelopeParser.ts) → `CodexEnvelopeParser`), the per-agent plan scanner ([plans/PlanTranscriptScanner.ts](src/core/plans/PlanTranscriptScanner.ts) → `CodexPlanScanner`), and the same `discovery-cursors.json` cursor as the Claude Stop path; single-flight + dirty-rerun per cwd, never throws. |
| [plans/](src/core/plans/) | Source-parameterized plan discovery, mirroring `references/`. [PlanTranscriptScanner.ts](src/core/plans/PlanTranscriptScanner.ts) is the per-agent interface + `getPlanScanner(source)` registry; [ClaudePlanScanner.ts](src/core/plans/ClaudePlanScanner.ts) reads plan-mode slugs + Write/Edit `.md` paths, [CodexPlanScanner.ts](src/core/plans/CodexPlanScanner.ts) reads `apply_patch` `*** Add/Update File:` / `*** Move to:` headers. [TranscriptPlanDiscovery.ts](src/core/plans/TranscriptPlanDiscovery.ts) is the source-agnostic `scanPlansFrom(…, source, toLine)` driver: shared `isExternalPlanCandidate` filter, archive guard, note dedup, `resolveUniqueSlug`, concurrent merge under `withPlansLock`. |
| [GeminiSessionDetector.ts](src/core/GeminiSessionDetector.ts) | Detects Gemini CLI installation |
| [OpenCodeSessionDiscoverer.ts](src/core/OpenCodeSessionDiscoverer.ts) | Discovers OpenCode sessions by reading `~/.local/share/opencode/opencode.db` (Node 22.5+ `node:sqlite`, lazy-imported and feature-gated). Surfaces a typed `OpenCodeScanError` when the DB is present but unreadable (corrupt / locked / schema mismatch) so the UI can render a dedicated "unavailable" row. |
| [OpenCodeTranscriptReader.ts](src/core/OpenCodeTranscriptReader.ts) | Reads OpenCode message rows out of `opencode.db` and converts them into the shared `TranscriptEntry` shape used by the rest of the pipeline |
| [CursorDetector.ts](src/core/CursorDetector.ts) / [CursorSessionDiscoverer.ts](src/core/CursorSessionDiscoverer.ts) / [CursorTranscriptReader.ts](src/core/CursorTranscriptReader.ts) | Cursor IDE (Composer) integration. Detector → "is Cursor installed", discoverer scans the workspace storage, reader normalises to `TranscriptEntry`. Same lazy-import + feature-gate pattern as OpenCode. |
| [CopilotDetector.ts](src/core/CopilotDetector.ts) / [CopilotSessionDiscoverer.ts](src/core/CopilotSessionDiscoverer.ts) / [CopilotTranscriptReader.ts](src/core/CopilotTranscriptReader.ts) | GitHub Copilot CLI integration (same triplet pattern). |
| [CopilotChatDetector.ts](src/core/CopilotChatDetector.ts) / [CopilotChatSessionDiscoverer.ts](src/core/CopilotChatSessionDiscoverer.ts) / [CopilotChatTranscriptReader.ts](src/core/CopilotChatTranscriptReader.ts) | VS Code Copilot Chat integration. Sessions live in the Copilot Chat conversation cache. Both Copilot CLI and Copilot Chat respect the single shared `copilotEnabled` config flag. |
| [Summarizer.ts](src/core/Summarizer.ts) | Anthropic API calls for structured summary generation. Also exports `generateSquashMessage()` for the VSCode extension's squash flow |
| [SummaryStore.ts](src/core/SummaryStore.ts) | Reads/writes summaries via the active `StorageProvider`. Default backend is the orphan branch; folder-mode and dual-write backends are pluggable (see Storage Layer below). Handles v3 tree merge / migrate operations. |
| [StorageProvider.ts](src/core/StorageProvider.ts) / [StorageFactory.ts](src/core/StorageFactory.ts) | Storage abstraction: any backend implementing `StorageProvider` can be plugged in via `setActiveStorage()`. Factory selects the active backend (`OrphanBranchStorage`, `FolderStorage`, or `DualWriteStorage`) based on user config. |
| [OrphanBranchStorage.ts](src/core/OrphanBranchStorage.ts) | Existing orphan-branch backend (default). Reads via `git show`, writes via `hash-object` + `mktree` + `commit-tree` + `update-ref`. |
| [FolderStorage.ts](src/core/FolderStorage.ts) | Folder-mode backend: visible Markdown files under a chosen Memory Bank directory. |
| [DualWriteStorage.ts](src/core/DualWriteStorage.ts) | Writes through to both orphan branch and folder storage so the orphan branch remains the system of record. |
| [KBPathResolver.ts](src/core/KBPathResolver.ts) / [KBTypes.ts](src/core/KBTypes.ts) | Memory Bank path resolution (per-branch directories, kb root, dual-write metadata files). The `KB` prefix is the legacy identifier — the user-facing name is "Memory Bank". |
| [MetadataManager.ts](src/core/MetadataManager.ts) | Reads / writes the kb metadata file (storage mode, paths, last-sync info). |
| [MigrationEngine.ts](src/core/MigrationEngine.ts) | Drives migrations between storage modes (orphan → folder, folder → orphan, partial recovery). |
| [SummaryTree.ts](src/core/SummaryTree.ts) | Tree traversal utilities (aggregate stats/turns, collect source nodes, `resolveDiffStats` display helper) |
| [SummaryMigration.ts](src/core/SummaryMigration.ts) | v1→v3 migration logic for legacy orphan branch data |
| [GitOperationDetector.ts](src/hooks/GitOperationDetector.ts) | Detects git operation type (commit, amend, squash, rebase, cherry-pick, revert) |
| [Installer.ts](src/install/Installer.ts) | Installs/removes git hooks and MCP server registrations. Git hooks: Claude Code `StopHook`/`SessionStartHook`, Gemini `AfterAgent`, `post-commit`, `prepare-commit-msg`. MCP: `registerAllMcpHosts`/`removeAllMcpHosts` drive per-host `McpHostRegistrar` implementations (Claude `.mcp.json`, Cursor `.cursor/mcp.json`, Gemini `~/.gemini/settings.json`, Codex `~/.codex/config.toml`) gated by per-host detectors. |
| [references/ReferenceExtractor.ts](src/core/references/ReferenceExtractor.ts) / [references/ReferenceStore.ts](src/core/references/ReferenceStore.ts) | Multi-source external-reference extraction (Linear / Jira / GitHub / Notion) + per-commit reference store. The extractor walks transcripts via per-source envelope parsers (`references/sources/`, `references/bindings/`) for the relevant MCP tool calls and normalises them into an opaque `ReferenceField` bag, so adding a source is a binding entry rather than a schema change. The store persists references to the orphan branch with the same hoist-on-rebase / merge-on-squash semantics as Plans and Notes (see `QueueWorker.runSquashPipeline` for the integration). |
| [ActiveSessionAggregator.ts](src/core/ActiveSessionAggregator.ts) | Aggregates active sessions across every source (Claude / Codex / Gemini / OpenCode / Cursor / Copilot CLI / Copilot Chat) into a single `ActiveSession[]` snapshot. Powers the VS Code **Conversations** sidebar section; safe to poll because every per-source detector + reader is feature-gated and cheap. |
| [ConversationOverlayStore.ts](src/core/ConversationOverlayStore.ts) | Persists per-session **transcript edit overlays** — the curated turn list a user produced in the Conversation Details panel. Stored locally per-project; consulted by the summarization pipeline so the LLM sees the user's curated version, not the raw transcript. |
| [CommitSelectionStore.ts](src/core/CommitSelectionStore.ts) | Per-project on-disk store for the **per-item commit selection** state (plans / notes / conversations / files unchecked from the next commit's memory). Selections persist across commits and restarts; the worker consults this store when assembling the LLM context. |
| [Regenerator.ts](src/core/Regenerator.ts) / [RegenerateContext.ts](src/core/RegenerateContext.ts) | The "Regenerate Summary" backend. `RegenerateContext` rebuilds the full v4 tree context (transcripts + diff + plans/notes + references) for a given commit hash; `Regenerator` drives the LLM call with explicit stale-write guards so an amend / squash mid-regenerate cannot clobber the new history. |
| [TranscriptSourceLabel.ts](src/core/TranscriptSourceLabel.ts) | Maps a transcript's source (`anthropic-config` / `anthropic-env` / `jolli-proxy` / per-agent labels) to the human-readable provider label rendered in the Summary Webview footer. |
| [HealFolderCommand.ts](src/commands/HealFolderCommand.ts) | `jolli heal-folder` — re-renders missing visible Markdown files under the Memory Bank folder from the canonical hidden JSON. Driven by `FolderStorage.healMissingVisibleMarkdown`; safe to re-run, never touches the orphan branch or the canonical JSON. |
| [DeviceLabel.ts](src/auth/DeviceLabel.ts) | Computes a server-accepted `device_label` (hostname + OS, length-clamped) for the OAuth login URL so the Jolli web UI can name authorized sessions. Mirrored in IntelliJ's `JolliAuthService`. |
| [Subprocess.ts](src/util/Subprocess.ts) | The single allowed wrapper around `node:child_process`. Sets `windowsHide` consistently to suppress the brief console-window flicker that bare `spawn`/`execFile` calls produced on Windows. Biome bans direct `child_process` imports across both `cli/` and `vscode/` to keep this from regressing. |

## Display-Layer Conventions

### Reading diff stats — always use `resolveDiffStats`

Any code that shows file/line diff numbers to a human (UI, Markdown, console, PR body, webview, AI briefing text) **MUST** read through `resolveDiffStats(node)` from [SummaryTree.ts](src/core/SummaryTree.ts).

Do **NOT**:
- Call `aggregateStats(node)` directly in display code — it recursively sums children, which over-counts files edited by multiple source commits in a squash.
- Read `node.stats?.insertions` / `.deletions` / `.filesChanged` directly as display data — `stats` has different semantics per node type (delta for amend, absent for squash containers). It is kept as a legacy / old-plugin compat field, not for display.

Do:
- Call `resolveDiffStats(node)` — priority: persisted `node.diffStats` (new data) → `node.stats` on a leaf (legacy leaf) → recursive `aggregateStats` (legacy container fallback). The leaf/container branching prevents double-counting grandchildren on amend-over-squash trees.

### Writing diff stats — `diffStats` is the persisted truth

Every code path that constructs a `CommitSummary` writes `diffStats` from a fresh `git diff {hash}^..{hash}`:
- [QueueWorker.executePipeline](src/hooks/QueueWorker.ts) — leaf commits
- [QueueWorker.handleAmendPipeline](src/hooks/QueueWorker.ts) — amend (both the LLM branch and the message-only branch)
- [SummaryStore.mergeManyToOne](src/core/SummaryStore.ts) — squash / merge-squash
- [SummaryStore.migrateOneToOne](src/core/SummaryStore.ts) — rebase-pick

`flattenSummaryTree()` prefers `node.diffStats` when writing the index entry, so `summaries/{hash}.json` and `index.json` are guaranteed consistent by construction and there is no redundant git call.

`stats` stays untouched on new writes (keeps old plugin versions functional when they read new data).

## Unified Git Operation Queue

All git operations (commit, amend, squash, rebase, cherry-pick, revert) go through a single queue in `.jolli/jollimemory/git-op-queue/`. Each operation is written as a separate JSON file with a timestamp prefix (e.g. `1712345678901-abc123de.json`) ensuring chronological processing order.

### Operation Flow

```
post-commit hook (synchronous, <5ms):
  1. Detect operation type via GitOperationDetector
  2. If amend/rebase → skip (post-rewrite handles these)
  3. If commit/squash → enqueue {type, commitHash, sourceHashes, createdAt}
  4. Spawn detached QueueWorker process

post-rewrite hook (synchronous):
  1. Read old→new hash mappings from git stdin
  2. Enqueue amend or rebase-pick/rebase-squash entries
  3. If lock is free → spawn QueueWorker; if held → current worker will drain queue

QueueWorker (background, detached):
  1. Acquire file lock
  2. Drain queue in timestamp order:
     - commit/cherry-pick/revert/amend → full LLM pipeline
     - squash → merge existing summaries (no LLM)
     - rebase-pick → migrate summary 1:1 (no LLM)
     - rebase-squash → merge summaries N:1 (no LLM)
  3. Delete each queue file after processing
  4. Release lock
  5. If new entries appeared → chain spawn another worker
```

### Why a Queue?

Before the queue, each operation type had its own pending file (e.g. `amend-pending.json`). These were single-slot — a second amend would overwrite the first. During rapid amend/rebase sequences (especially while the LLM is running), summaries were silently lost.

The queue solves this: each operation gets its own file, no overwriting, and the worker drains them all in order. Timestamp-based ordering naturally preserves dependency chains (e.g. source commits are always processed before the rebase that references them).

### Transcript Attribution

Each queue entry carries a `createdAt` timestamp. When the worker processes entries, it reads transcripts up to that timestamp only, ensuring each commit gets the conversation entries from its own time window — not the next commit's.

## Data Flow: Session Capture (StopHook)

```
Claude Code fires "Stop" event
    │
    ▼
StopHook.ts: handleStopHook()
    │
    ├── readStdin() → JSON payload:
    │   { session_id, transcript_path, cwd }
    │
    ├── Parse and validate fields
    │
    └── SessionTracker.saveSession()
        → Atomic write to .jolli/jollimemory/sessions.json
          Supports multiple concurrent sessions. Stale sessions (>48h) pruned.
```

The Stop hook runs with `"async": true` in Claude's settings, so it doesn't block the agent.

## Git Orphan Branch Operations

Summaries are stored in `jollimemory/summaries/v3` without ever checking it out. All operations use git plumbing commands.

### Writing a File

```
writeFileToBranch(branch, "summaries/abc123.json", content, message)
    │
    ├── Get current branch tip: git rev-parse refs/heads/<branch>
    ├── Get current tree: git rev-parse <commit>^{tree}
    ├── Write new content as blob: git hash-object -w --stdin
    ├── Update tree (handles nested paths recursively via mktree)
    ├── Create new commit: git commit-tree <new-tree> -p <parent>
    └── Update branch ref: git update-ref refs/heads/<branch> <new-commit>
```

### Reading from the Branch

```
readFileFromBranch(branch, path)
    → git show <branch>:<path>
    → Returns content or null
```

## Transcript Parsing

Claude Code transcripts are JSONL files at `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl`.

### Line Formats

```jsonl
{"message":{"role":"user","content":"Fix the login bug"},"timestamp":"..."}
{"message":{"role":"assistant","content":[{"type":"text","text":"I'll fix..."}]},"timestamp":"..."}
{"message":{"role":"assistant","content":[{"type":"tool_use","name":"EditFile","input":{...}}]},"timestamp":"..."}
{"toolUseResult":{"tool_use_id":"...","output":"File updated"},"timestamp":"..."}
```

### Parsing Strategy

- Read JSONL from cursor position (incremental, never re-reads processed lines)
- Parse each line into `TranscriptEntry` (human, assistant, tool_use, tool_result)
- Filter noise (interruptions, skill injections, empty chunks)
- Merge consecutive same-role entries (streaming chunk consolidation)
- Multi-session support: reads from Claude, Codex, and Gemini transcripts
- Time-based attribution: `beforeTimestamp` parameter limits entries to a specific time window

## Hook Installation

### dist-path Indirection

All hooks use runtime path resolution via the `resolve-dist-path` script:

```bash
node "$("$HOME/.jolli/jollimemory/resolve-dist-path")/PostCommitHook.js"
```

The `resolve-dist-path` script reads the global `dist-path` file (`~/.jolli/jollimemory/dist-path`). It is centralised into a script (rather than inlined in every hook) for future extensibility. Only global installation (`npm install -g`) is supported.

The `dist-path` file contains:
```
source=cli@1.0.0
/absolute/path/to/dist
```

The version in the source tag is the Jolli Memory core version (not the VSCode extension version). Both CLI and extension embed the same core, so version comparisons are always on the same version line.

### Hook Markers

Each hook type uses marker comments for safe append/remove:

```bash
# >>> JolliMemory post-commit hook >>>
node "$("$HOME/.jolli/jollimemory/resolve-dist-path")/PostCommitHook.js"
# <<< JolliMemory post-commit hook <<<
```

If an existing hook file exists, Jolli Memory's section is appended. On uninstall, only the marked sections are removed.

## Concurrency and Safety

- **File lock**: `.jolli/jollimemory/lock` prevents concurrent worker runs. Uses `writeFile` with `wx` flag (exclusive create). Stale locks (>5 min) are auto-removed.
- **Per-vault write lock**: `~/.jolli/jollimemory/locks/vault-<sha256>.lock` (separate from the per-worktree worker lock) serialises Memory Bank writes between a `QueueWorker` drain and a sync round that share one vault. See [Memory Bank Cloud Sync → Vault-write lock](#vault-write-lock-sync--worker).
- **Operation queue**: Each git operation gets its own queue file — no single-slot overwriting.
- **Detached worker**: The post-commit hook spawns a detached child process so `git commit` returns instantly.
- **Chain spawn**: After draining the queue, the worker checks for new entries and spawns a successor if needed.
- **Idempotent operations**: Orphan branch creation, index updates, and hook installation are all idempotent.
- **Stale session pruning**: Sessions older than 48 hours are automatically pruned.

## Error Handling

| Scenario | Handling |
|----------|----------|
| No active session | Skip summary, infer topics from diff alone if possible |
| Transcript file missing | Log error, skip that session |
| No new transcript entries + no file changes | Skip summary generation |
| LLM call fails (any cause: network, 5xx, credential, quota) | Retry once (2s), then persist a placeholder summary with `summaryError: "llm-failed"`. Amend and squash paths preserve their existing fallback content (Copy-Hoist or mechanical merge); normal commit lands empty `topics`. Webview surfaces a Regenerate banner; Share in Jolli refuses summaries with this marker. |
| LLM consolidate has nothing to merge (no sources / all empty / LLM self-reported empty) | Mechanical fallback **without** `summaryError` — healthy "nothing to consolidate" case. |
| API returns non-JSON | Attempt JSON extraction from markdown fences, fallback to raw text |
| Orphan branch doesn't exist | Auto-create (idempotent) |
| Existing git hook | Append Jolli Memory section with markers |
| Concurrent worker | Lock prevents; queue entries persist for next worker |
| Lock file stale (>5 min) | Auto-remove stale lock |
| v1 orphan branch exists | Auto-migrate to v3 tree format |

All errors are logged to `.jolli/jollimemory/debug.log`. The tool is designed to never block or crash the developer's workflow.

## Local State Files

| File | Purpose |
|------|---------|
| `sessions.json` | Registry of active AI sessions (Claude, Codex, Gemini) |
| `cursors.json` | Per-transcript cursor positions for incremental reading |
| `config.json` | Configuration (API keys, model, integrations) |
| `plans.json` | Plans and notes registry (association with commits) |
| `scope.json` | Installation scope (project or global) |
| `lock` | Per-worktree worker concurrency lock file |
| `locks/vault-<sha256>.lock` | Global (`~/.jolli/jollimemory/`) per-vault write lock; `locks/vault-<sha256>-pending/` holds the cross-repo `PendingWorkers` wakeup registry |
| `dist-path` | Global file (`~/.jolli/jollimemory/`) pointing to the active dist/ directory |
| `resolve-dist-path` | Global shell script (`~/.jolli/jollimemory/`) that reads the global dist-path |
| `debug.log` | Debug/error log |
| `git-op-queue/*.json` | Pending git operation queue entries |
| `squash-pending.json` | Temporary cross-hook file for squash detection |

## Plugin Loader

Starting in 0.99.2, `@jolli.ai/cli` discovers and loads allow-listed plugin packages that register additional subcommands. Discovery and registration live in [PluginLoader.ts](src/PluginLoader.ts); the public API surface they consume lives in [Api.ts](src/Api.ts).

### Discovery shape

```
Api.registerCli(program, version)
    │
    ├── built-in commands registered (Cli.ts route)
    │
    └── loadPlugins(program, version)
            │
            ├── if process.env.JOLLI_NO_PLUGINS === "1" → return early
            │
            ├── boundary = nearest .git ancestor of cwd, else $HOME
            │   roots     = walk(cwd → boundary).map(d => d/node_modules)
            │            ++ [npm root -g]
            │   (Each node_modules between cwd and boundary is included,
            │    so hoisted packages in pnpm / Yarn-workspaces monorepos
            │    are discovered. If cwd sits outside any .git project and
            │    outside $HOME, the local walk is skipped and only the
            │    global root is scanned.)
            │
            ├── for name in KNOWN_PLUGINS:
            │     for each root that contains node_modules/<name>:
            │       1. read plugin package.json
            │       2. verify peerDependencies["@jolli.ai/cli"] semver
            │          range matches host VERSION
            │       3. dynamic import + plugin.register(ctx)
            │
            └── any plugin error → log + skip (never throws upward)
```

### Why an allow-list

`KNOWN_PLUGINS` is a fixed array baked into the CLI build, not a config flag. A malicious package on disk cannot register itself by being installed — its name has to also appear on the allow-list, which requires a CLI release. This pairs with the bounded discovery roots: even with a hostile `node_modules`, the worst case is that an allow-listed package is loaded from a path it shouldn't have been installed to, not arbitrary code execution.

### Plugin contract (`Api.ts`)

| Export | Purpose |
| --- | --- |
| `PluginContext` | Carried into the plugin's `register(ctx)` — exposes the host's `commander` program, the resolved CLI version, the user config, and a small set of factory helpers. |
| `PluginRegister` | The `(ctx: PluginContext) => void \| Promise<void>` shape every plugin's default export must satisfy. |
| `parseJolliApiKey`, `parseBaseUrl` | Canonical key/URL parsers re-exported so plugins don't have to bundle their own copy (they would drift from the CLI's allow-list). |

The `exports` field in `cli/package.json` is what enforces this: `@jolli.ai/cli` and `@jolli.ai/cli/api` are the only resolvable specifiers. Deep imports like `@jolli.ai/cli/dist/core/Foo.js` no longer resolve — plugins that relied on them must move to the public API.

## Search Index & MCP Server

Starting in JOLLI-1226, the CLI ships a local full-text search index plus an stdio MCP server that exposes JolliMemory's history to AI agents.

### Local search index

The index lives at `.jolli/jollimemory/search-index.json` (with a sidecar `search-index.manifest.json`) under the per-project `.jolli/jollimemory/` dir. It is a **disposable cache** — never written to the orphan branch — rebuilt from source (the topic KB + commit catalog) via [SearchIndex.ts](src/core/SearchIndex.ts) on top of an Orama BM25 index. The manifest records a schema version and a **staleness signature** (`computeSourceSignature` in [SearchIndexSource.ts](src/core/SearchIndexSource.ts)); `SearchIndex.open()` restores from disk only when both match the current source, otherwise it rebuilds and re-persists. Because source data (orphan branch / folder) is always authoritative, the index can be deleted at any time and is regenerated on next open.

The index is also refreshed **incrementally at the end of `jolli compile`** (per-repo), so agents querying right after a compile see fresh results without a manual reindex.

### `jolli mcp`

`jolli mcp` ([McpCommand.ts](src/commands/McpCommand.ts)) starts an stdio MCP server ([McpServer.ts](src/mcp/McpServer.ts)) that AI agents connect to. `jolli mcp --reindex` forces a full rebuild of the local search index from source and exits (no server).

The server exposes five tools, all pure handlers in [McpTools.ts](src/mcp/McpTools.ts):

| Tool | Purpose |
|------|---------|
| `search` | Full-text BM25 search (Orama) over the repo's historical decisions and implementations; returns `{ hits }`. Calls the same `searchHits()` ([SearchHits.ts](src/core/SearchHits.ts)) as `jolli search`, so results are identical. |
| `recall` | Recall a branch's development context from **RAW commit summaries** — the same data path as the `jolli-recall` skill, NOT the topic KB. Calls the same `resolveRecall()` ([RecallResolver.ts](src/core/RecallResolver.ts)) as `jolli recall --format json`; returns the same `type`-tagged union (`recall` \| `catalog` \| `error`). Defaults to the current branch. |
| `get_decision_timeline` | Chronological evolution of a topic — its source events ordered oldest-first. |
| `list_branches` | All branches with JolliMemory records and their topic titles. |
| `get_pr_description` | Build a GitHub PR title + description from the branch's JolliMemory commit summaries — the same memory-rich body the VS Code extension writes. Use before `gh pr create`. |

`McpServer.ts` is pure glue: tool schemas (`TOOL_DEFINITIONS`) plus a `dispatchTool` table over the `McpTools` handlers, adapted into SDK request handlers (`ListTools` / `CallTool`). Errors from a handler are returned as an `isError` tool response rather than crashing the server.

## Knowledge Wiki & Graph

`jolli compile` ([CompileCommand.ts](src/commands/CompileCommand.ts), multi-repo sweep in [MultiRepoCompile.ts](src/core/MultiRepoCompile.ts)) is a two-phase build over a repo's memories:

1. **Knowledge wiki** — ingest sources → fold work on the same theme into per-topic pages → render the browsable `_wiki/` folder. Progress is reported as `Building knowledge wiki — <repo>`.
2. **Knowledge graph** — immediately after the wiki, `buildKnowledgeGraph` distills those topics into a graph. Progress is reported as `Building knowledge graph — <repo>`.

Everything graph-related lives under [`cli/src/graph/`](src/graph/):

| Module | Purpose |
|--------|---------|
| [GraphBuilder.ts](src/graph/GraphBuilder.ts) | Orchestrates an **incremental** build. Computes two SHA256 fingerprints per topic — a *content* fingerprint over the exact LLM inputs (`topicFingerprint`) and a *metadata* fingerprint over `sourceBranches` + `sourceCommits` (`topicMetaFingerprint`) — and diffs them against the fingerprints persisted in the prior `graph.json` to partition topics into `clean` / `dirty` / `added` / `deleted`. Three outcomes: no change → skip; content unchanged but metadata drifted → NO-LLM reassemble reusing the distilled layer verbatim; content changed → incremental distillation of only the dirty/new topics. |
| [GraphDistiller.ts](src/graph/GraphDistiller.ts) | The LLM work: categorize topics, extract knowledge units per topic, compute typed edges. `distillGraphIncremental` reuses clean topics' units from the baseline, re-distills only dirty/new topics (4-concurrency fan-out), recomputes categories via a delta call, and recomputes edges in full over the final unit set. Live progress via `GraphProgressReporter`. |
| [GraphSchema.ts](src/graph/GraphSchema.ts) | The `KnowledgeGraph` type plus `assembleGraph()`, which runs `normalizeSymmetricEdges()` (collapse the symmetric `related-to` / `contradicts` types to one edge per unordered pair, keeping the higher-confidence endpoint) and `dropSubsumedRelatedTo()` (drop a generic `related-to` when a more specific typed edge already links the pair) so every emitted `graph.json` is already clean. |
| [GraphArtifactStore.ts](src/graph/GraphArtifactStore.ts) | Atomic (tmp + rename) read/write of `<kbRoot>/.jolli/graph/graph.json`. **Folder-local and regenerable — never written to the orphan branch**, like the search index. The persisted fingerprints are the baseline for the next incremental build. |
| [GraphExport.ts](src/graph/GraphExport.ts) | `buildStandaloneHtml()` inlines the viz assets + `graph.json` into one self-contained HTML file. Backs `jolli graph --export`. |
| [assets/](src/graph/assets/) | The viz runtime (vendored `panzoom` / `elk` / `marked` + app scripts `data` / `state` / `edges` / `camera` / `drag` / `views` / `panel` / `main`). `edges.js` paints **dual edge layers** — a front layer for intra-topic edges and a back layer (behind the board) for cross-topic/category edges so opaque boxes occlude them. `camera.js`'s `focusUnit()` is the **unit-focus camera**: zoom-in-only toward the clicked unit's own center, pan minimally, and reveal as many related neighbors as fit without lowering zoom. |

`GraphCommand.ts` ([src/commands/GraphCommand.ts](src/commands/GraphCommand.ts)) is export-only — it reads the existing `graph.json` and writes HTML; it does **not** trigger a build (run `jolli compile` for that). The VS Code extension renders the same assets in a webview ([KnowledgeGraphPanel.ts](../vscode/src/views/KnowledgeGraphPanel.ts)).

## Usage Telemetry & Trace Correlation

`jolli telemetry` ([TelemetryCommand.ts](src/commands/TelemetryCommand.ts): `status` (default) / `on` / `off` / `inspect`) is the user-facing surface for **anonymous, content-free, opt-out** usage telemetry. The shared engine lives in `cli/src/core/Telemetry*.ts` and is bundled into both the VS Code extension ([TelemetryActivation.ts](../vscode/src/TelemetryActivation.ts)) and ported to Kotlin for IntelliJ:

| Module | Purpose |
|--------|---------|
| [TelemetryEvents.ts](src/core/TelemetryEvents.ts) | The append-only event-name registry (source of truth for the generated [TELEMETRY.md](../TELEMETRY.md) — regenerate with `npm run gen:telemetry-doc`). |
| [TelemetryBuffer.ts](src/core/TelemetryBuffer.ts) | The `TelemetryEnvelope` shape (schemaVersion, eventName, surface, surfaceVersion, anonymous `installId`, os/arch/runtime, env, `accountId: null`, scrubbed `properties`) and the capped NDJSON ring buffer at `<projectDir>/.jolli/jollimemory/telemetry-queue.ndjson` (500 events / 1 MB). |
| [TelemetryConsent.ts](src/core/TelemetryConsent.ts) | Priority-ordered consent resolution: `DO_NOT_TRACK` → platform setting (VS Code `telemetry.telemetryLevel`, IntelliJ data-sharing) → config `telemetry: "on" \| "off"` → default on. |
| [Telemetry.ts](src/core/Telemetry.ts) | `scrubProperties()` — buckets counts (`"1-5"` / `"6-20"` / …), redacts paths/URLs/emails/secrets, drops `ALWAYS_DROP_KEYS`, bounds depth/length. `accountId` is **always null from the client**; the backend attributes events server-side from the `Bearer` key when present. |
| [TelemetryFlusher.ts](src/core/TelemetryFlusher.ts) | Fire-and-forget `POST <origin>/api/telemetry/events` in batches of ≤100; non-2xx / network errors leave events buffered for the next flush. |

**Anonymity**: `installId` is a `crypto.randomUUID()` minted once into `~/.jolli/jollimemory/config.json` (race-free via an atomic sentinel file), never derived from hostname / account / email. All three surfaces share that one id; the `surface` field distinguishes which client sent each event.

**Trace correlation** ([TraceContext.ts](src/core/TraceContext.ts)) is a separate, **purely internal** concern: an ambient `<traceId>-<spanId>` carried on the private `x-jolli-trace` header of every outbound Jolli request and stamped into log lines. It propagates in-process via `AsyncLocalStorage` (`runWithTrace`), across the hook→worker handoff via the queue entry's `op.traceId`, and across spawns via the `JOLLI_TRACE_ID` env var. Kept in lockstep with the backend and the IntelliJ Kotlin port.

## Memory Bank Cloud Sync

`cli/src/sync/` holds the engine that keeps the user's Memory Bank folder mirrored to a private Jolli vault. The engine is shipped in `dist/Cli.js` and inlined into the VS Code extension. Sync is **manual / on-demand**: the CLI exposes `jolli sync-memory-bank` (`SyncCommand.ts`) to drive one round, and the VS Code plugin's **Sync to Personal Space Now** button does the same. The only sync config the CLI exposes is `syncTranscripts` (opt raw transcripts into a round, off by default).

### Engine shape

```
SyncBootstrap.runRound()
    │
    ├── SyncLock.acquire()                  ← machine-wide `sync.lock`, serialises
    │                                          sync-vs-sync only (10 s timeout)
    │
    ├── BackendClient.mintCredential()      ← short-lived per-round token
    │
    ├── GitClient.cloneOrFetch(vaultRepo)   ← first time: clone (binds vault
    │                                          to space via VaultMarker);
    │                                          subsequent: fetch
    │
    ├── self-heal (idempotent, before pull):
    │     2b. abort a stale `.git/rebase-merge|apply` left by a killed round
    │     2c. sweep stale `.git/*.lock` corpses (TTL 5 min)
    │
    ├── withPullLock(memoryBankRoot):       ← VaultWriteLock — per-vault writer
    │     │                                    lock; the ONLY window sync holds it
    │     ├── GitClient.pullRebase()
    │     └── ConflictResolver.resolveAll()  ← three-tier:
    │           1. AggregateMerge: deterministic merge of the four
    │              .jolli/<aggregate>.json files (manifest / index /
    │              branches / catalog) — never prompts
    │           2. LocalAiMergeProvider: AI merge (uses apiKey when set)
    │              for other-file conflicts
    │           3. Manual binary pick (last resort, surfaced to UI)
    │
    ├── auto-reconcile user edits → stageVault → `[jolli-mb] reconcile: …` commit
    │
    ├── MemoryBankBootstrap.mirror()        ← rsync-shaped diff:
    │                                          fs ←→ vault working tree
    │
    ├── stageVault()                        ← ALLOWLIST staging (not `git add --all`):
    │                                          classifyVaultPath gates every entry;
    │                                          symlinked / unowned paths refused
    │
    ├── GitClient.commit + push → `[jolli-mb] sync: …`
    │
    ├── SyncStateStore.recordRound()        ← updates four-state status
    │                                          (synced / syncing / conflicts /
    │                                          offline)
    │
    └── PendingWorkers.drain()              ← wake cross-repo QueueWorkers that
                                              timed out on the vault-write lock
```

### Space binding (the 412 path)

`VaultMarker` writes a small file inside the vault that binds the clone to a specific Jolli space. If the backend returns **412** on a round (the vault was rebound to a different space, or the user signed into a different account), the engine does NOT silently clobber — `SyncEngine` raises a binding-required failure and surfaces a UI dialog that lets the user re-bind explicitly. This is what stopped the prior "two users on one machine quietly overwrite each other" failure mode.

### `GitAskpass` and credentials

`GitAskpass.ts` writes a one-shot helper script that `GitClient` points `GIT_ASKPASS` at, so each `git push` reads the freshly minted credential from a per-round env var instead of either persisting it to `~/.git-credentials` or echoing it onto the command line. Combined with `AllowList.ts` (which restricts the vault to a fixed set of hostnames), this keeps long-lived secrets off disk.

### Allowlist staging (`stageVault`)

Every staging site in the engine goes through `stageVault` instead of `git add --all`. The vault at `<localFolder>/` hosts many source repos as sibling `<repoFolder>/` subtrees, so a blanket `git add` would happily commit anything a foreign tool — or a hostile placement — dropped into the folder. `stageVault` snapshots `git status --porcelain -z` (parsed by the shared `PorcelainParser`, which also decomposes renames into discrete add/delete ops so each classifies independently), runs every path through `classifyVaultPath`, and stages with `git add -f` **only** paths that classify to a non-null `OwnedPathKind`. The `-f` is deliberate: the classifier — not `.gitignore` — is the staging authority.

`OwnedPathKind` is a **closed** tagged union of the FolderStorage / RepoMapping write families (`repo-config`, `summary`, `transcript`, `plan`, `visible-summary`, …). Adding a new FolderStorage write type requires adding a kind here, and a round-trip integration test enforces "every FolderStorage write path classifies to non-null" so a write that bypasses the catalogue is caught immediately. Two kinds are pointedly excluded: `shadow-status.json` (per-device recovery state, meaningless to peers) and the quarantine subtrees (locally gitignored).

`stageVault` returns a `StageReport` whose `unowned` and `symlinked` arrays are the **canary signals**: non-empty means either FolderStorage grew a write site the classifier doesn't recognise (drift) or a foreign writer touched the vault. SyncEngine folds these into a per-round `canary` accumulator and warn-logs them — they are what dogfood watchers grep for. `transcript` entries are dropped (counted as `skipped`) when `syncTranscripts: false`.

### Vault-write lock (sync ↔ worker)

`VaultWriteLock` is a **per-vault** writer lock distinct from the two existing locks: `sync.lock` is machine-wide and serialises sync-vs-sync; `worker.lock` is per-worktree. Neither closes the sync-vs-worker race, where a `QueueWorker` for repo B writes into `<localFolder>/<repoB>/.jolli/…` while a sync round reads `git status` against the same vault — tearing the worker's multi-file write across the status snapshot. The lock file lives **outside** the vault at `~/.jolli/jollimemory/locks/vault-<sha256(canonical)>.lock` (derived by `VaultLockPath`, because the vault's `.git/` may not exist yet when a worker needs the lock before any storage construction).

The two acquirers hold it for **asymmetric** windows by design:

- **QueueWorker** holds it for the entire drain (a summary is N files: canonical JSON + visible Markdown + aggregate index updates) — it can't release between files without re-opening the tear window.
- **SyncEngine** holds it only across `withPullLock` (pullRebase + conflict resolution). Pre/post-pull phases run unlocked because holding it for the whole 30–90 s round would make a user's `git commit` in the source repo wait the full round before its summary appears. This accepts a benign, eventually-consistent tradeoff (a concurrent worker write may land partially in one git commit and finish in the next round) in exchange for the UX; the race it *definitively* closes is "worker writes land in the paused-rebase window," which is fully inside `withPullLock`.

When repo B's worker times out (60 s) waiting on the lock, it records its cwd in `PendingWorkers` — a per-vault registry sibling to the lock file. Whoever releases the lock (sync round complete, or another worker's drain finishing) drains the registry and re-spawns those workers, so a cross-repo worker that gave up isn't stranded until repo B's next commit.

### Symlink safety

`VaultSymlinkGuard.assertNoSymlinksInPath` checks the **whole directory chain** from `vaultRoot` to a target before any `mkdir`/`write`/`rename`, refusing the write if any segment is a symlink — closing the intermediate-segment escape (`<repoFolder>/.jolli → /etc`) that a leaf-level `O_NOFOLLOW` can't catch. It replaces the deleted `SymlinkSweep` quarantine pass, which tree-walked and *moved* user files every round (the UX complaint that retired it); the guard instead refuses unsafe writes at write time and names the rogue path in a warn log. Paired with `core.symlinks=false` (forced on every `GitClient` invocation), the two layers cover both inbound (hostile mode-120000 tree entries materialise as plain files) and outbound (no traversal through a planted link) directions. `stageVault` also refuses to stage any path with a symlink in its chain, routing it to the `symlinked` canary.

### Self-healing a killed round

A round killed mid-flight (VSIX reinstall SIGTERM, laptop sleep, crash) can leave the vault's git state wedged in a way that makes every subsequent round fail with a sticky, unactionable error. Before pulling, the engine self-heals two such states (both idempotent, both no-ops on the cold-clone path):

- **Stale rebase** (`.git/rebase-merge|apply`) → `rebase --abort`. Safe to abort unconditionally because the vault working tree is exclusively SyncEngine-driven; the user's real edits live in a separate `[jolli-mb] reconcile: …` commit already on the default branch, which survives the abort.
- **Stale `.git/*.lock` corpses** (`index.lock`, `HEAD.lock`, `refs/**.lock`, …) → swept if older than a 5-minute TTL (engine ops finish in milliseconds, so a 5-min lock is definitively a corpse, while an out-of-band manual `git` op the user ran in the folder isn't ripped out from under them).

### What lives where

| Module | Purpose |
| --- | --- |
| [SyncEngine.ts](src/sync/SyncEngine.ts) | High-level round driver — wires every other module together. Test surface is via injectable factories rather than monkey-patching globals. |
| [SyncBootstrap.ts](src/sync/SyncBootstrap.ts) | Per-round bootstrap (lock acquire → mint credential → clone-or-fetch → mirror → resolve → commit-push → record state). |
| [SyncLock.ts](src/sync/SyncLock.ts) | Per-machine file lock (`pending` + ttl), `DEFAULT_SYNC_LOCK_TIMEOUT_MS = 10_000`, poll = 100 ms. |
| [BackendClient.ts](src/sync/BackendClient.ts) | Jolli backend HTTP client — mints credentials, reports state, handles the 412 binding case. |
| [GitClient.ts](src/sync/GitClient.ts) + [GitAskpass.ts](src/sync/GitAskpass.ts) | Git invocations against the vault; askpass shim so credentials never persist. |
| [MemoryBankBootstrap.ts](src/sync/MemoryBankBootstrap.ts) | Diffs the local Memory Bank folder against the vault working tree and stages changes. |
| [StageVault.ts](src/sync/StageVault.ts) | Allowlist staging — replaces `git add --all` at every staging site; classifies each `git status` entry and stages only owned paths, returning the canary `StageReport`. |
| [VaultPathClassifier.ts](src/sync/VaultPathClassifier.ts) + [OwnedPathKind.ts](src/sync/OwnedPathKind.ts) | Pure `classifyVaultPath(relPath)` → `OwnedPathKind \| null`; the closed catalogue of vault-owned write families. Instance-free on purpose (constructing `FolderStorage` claims a KB path too early). |
| [PorcelainParser.ts](src/sync/PorcelainParser.ts) | NUL-record-aware `git status --porcelain -z` parser shared by `listDirtyPaths` and `stageVault` (handles rename source-path trailers). |
| [VaultSymlinkGuard.ts](src/sync/VaultSymlinkGuard.ts) | Refuses any write whose vault→target path chain contains a symlink; replaces the deleted `SymlinkSweep` quarantine pass. |
| [VaultWriteLock.ts](src/sync/VaultWriteLock.ts) + [VaultLockPath.ts](src/sync/VaultLockPath.ts) | Per-vault writer lock serialising sync-vs-worker (and worker-vs-worker across repos sharing a vault); lock file lives outside the vault, path derived from a canonicalised `localFolder`. |
| [PendingWorkers.ts](src/sync/PendingWorkers.ts) | Cross-repo wakeup registry — workers that time out on the vault-write lock record their cwd; lock releasers re-spawn them. |
| [ConflictResolver.ts](src/sync/ConflictResolver.ts) | Three-tier resolution (`AggregateMerge` → `LocalAiMergeProvider` → manual). |
| [AggregateMerge.ts](src/sync/AggregateMerge.ts) | Deterministic merge for the four `.jolli/<aggregate>.json` files. |
| [LocalAiMergeProvider.ts](src/sync/LocalAiMergeProvider.ts) | AI-driven merge for content files (gated on `apiKey`). |
| [LegacyMigration.ts](src/sync/LegacyMigration.ts) | One-shot import of Web-UI-only personal-space content into a `legacy/` subtree on the first sync of an unbacked space. |
| [VaultMarker.ts](src/sync/VaultMarker.ts) + [AllowList.ts](src/sync/AllowList.ts) | Space binding marker file + hostname allow-list. |
| [RepoIdentity.ts](src/sync/RepoIdentity.ts) + [RepoMapping.ts](src/sync/RepoMapping.ts) | Stable repo identity (origin URL + bootstrap hash) → vault-subfolder mapping. |
| [SyncStateStore.ts](src/sync/SyncStateStore.ts) | Persists the four-state status used by the status-bar indicator. |
| [CorruptJsonQuarantine.ts](src/sync/CorruptJsonQuarantine.ts) | Quarantines unreadable `.jolli/<aggregate>.json` files into a side directory so a single corrupt file never blocks the whole round. |
| [CliConflictUi.ts](src/sync/CliConflictUi.ts) | CLI-side conflict prompt (kept thin — most conflict UI lives in the editor plugins). |

Architecture rules:

- **No backend coupling outside `BackendClient`.** Other modules only see typed result objects.
- **Every git invocation goes through `GitClient`.** Never call `git` directly from a sync module — `GitAskpass` + `windowsHide` go missing otherwise.
- **`AggregateMerge` is the only deterministic merge.** Anything else routes through `LocalAiMergeProvider` first; only after that fails does the UI get a manual prompt.
- **`classifyVaultPath` is the staging authority, not `.gitignore`.** Never reintroduce `git add --all` in the engine — a new FolderStorage write type means a new `OwnedPathKind`, not a wildcard add. The `unowned` / `symlinked` canary buckets are a feature; don't suppress them.

## Site Generation: OpenAPI Reference Pipeline

`jolli new` / `build` / `start` / `dev` generate a Nextra v4 docs site
from a `Content_Folder` of markdown + OpenAPI specs. The OpenAPI
surface is split into a **framework-agnostic IR layer** and a
**renderer-specific emitter**, so a future Fumadocs / Docusaurus
emitter is a self-contained sibling rather than a fork of the whole
pipeline.

### Two-layer architecture

```
Content_Folder/                              ContentMirror
  api/petstore.yaml         ─►  parses once via tryParseOpenApi
                                stashes parsed AST in
                                MirrorResult.openapiDocs[relPath]
                                                   │
                                                   ▼
                            StartCommand.buildOpenApiSpecInputs:
                              • derive specName from basename
                                (collision → throws)
                              • buildPipeline(doc) per spec
                                                   │
                                                   ▼
                          OpenApiPipelineResult per spec
                          { spec: ParsedSpec,
                            dossiers: [{ operation, codeSamples }] }
                                                   │
                          ┌────────────────────────┴────────────┐
                          │ Framework-agnostic IR (openapi/)    │
                          │   SpecLoader, SpecParser, RefResolver,│
                          │   CodeSampleGenerator, SchemaExample,│
                          │   OpenApiPipeline, Slug, ReservedWords,│
                          │   Escape, SpecName, Types            │
                          └────────────────────────┬────────────┘
                                                   │
                                                   ▼
                          renderer.renderOpenApiSpecs(...)
                                                   │
                          ┌────────────────────────┴────────────┐
                          │ Renderer emitter (renderer/nextra/) │
                          │   Components, EndpointPageEmitter,  │
                          │   EndpointDataEmitter,              │
                          │   OverviewPageEmitter,              │
                          │   SidebarMetaEmitter, ApiCss, Paths │
                          └────────────────────────┬────────────┘
                                                   │
                                                   ▼
                          <buildDir>/
                            content/api-{spec}/
                              index.mdx                  ← overview page
                              _refs.ts                   ← shared schema map
                              _meta.ts                   ← top-level sidebar
                              _data/{opId}.json          ← per-op JSON sidecar
                              {tag}/_meta.ts             ← per-tag sidebar
                              {tag}/{opId}.mdx           ← per-endpoint shim
                            components/api/*.tsx         ← 9 React components
                                                           (written by initProject)
                            styles/api.css               ← method/status/grid CSS
                                                           (written by initProject)
```

### Where each module lives, and what NOT to put there

`cli/src/site/openapi/` — agnostic IR. **Must not** import from any
renderer-specific path. Output is data structures, never strings of
MDX or framework-specific filenames.

| Module | Purpose |
|---|---|
| [SpecLoader.ts](src/site/openapi/SpecLoader.ts) | `tryParseOpenApi(content, ext)` — real `yaml`/`JSON.parse` returning the validated AST or `null`. Powers content-based discovery in `ContentMirror` |
| [SpecParser.ts](src/site/openapi/SpecParser.ts) | `parseFullSpec(doc)` — walks `paths × HTTP_METHODS` in declaration order, follows `$ref` (RFC 6901 ~1/~0 escapes), throws on `(tag, operationId)` collisions, merges path-level + operation-level params |
| [SchemaExample.ts](src/site/openapi/SchemaExample.ts) | `exampleFromSchema(schema)` — depth-limited synthesis. Documented gaps: `$ref` / `oneOf` / `anyOf` / `allOf` / `enum` / `default` / `nullable` not honoured |
| [CodeSampleGenerator.ts](src/site/openapi/CodeSampleGenerator.ts) | `generateCodeSamples(op, server, schemes)` — five hand-rolled samples (cURL, JS, TS, Python, Go). `toPythonLiteral` and `goStringLiteral` avoid the regex-based replacement regression that corrupted strings containing literal `true`/`false`/`null` or backticks |
| [Slug.ts](src/site/openapi/Slug.ts) + [ReservedWords.ts](src/site/openapi/ReservedWords.ts) | `slugify(text)` with reserved-word fallback (`export` → `export-doc`) so MDX → JS module compilation never breaks |
| [Escape.ts](src/site/openapi/Escape.ts) | `escapeMdxText`, `escapeInlineCode`, `escapeYaml`, `escapeJsString`, `escapeHtml` — used by every emitter |
| [SpecName.ts](src/site/openapi/SpecName.ts) | `deriveSpecName(relPath)` — basename + slugify, used as the URL slug in `/api-{specName}/...` |
| [OpenApiPipeline.ts](src/site/openapi/OpenApiPipeline.ts) | `buildPipeline(doc)` — single entry point that runs `parseFullSpec` and attaches per-operation code samples. Emitters consume this verbatim |
| [Types.ts](src/site/openapi/Types.ts) | `OpenApiDocument`, `ParsedSpec`, `OpenApiOperation`, `OpenApiPipelineResult`, `EndpointDossier`, `OpenApiCodeSamples` |

`cli/src/site/renderer/nextra/` — Nextra emitter. Consumes
`OpenApiPipelineResult`, returns `TemplateFile[]` with project-root-
relative paths. **Must not** assume any particular spec count or
inline its own spec parsing.

| Module | Purpose |
|---|---|
| [Components.ts](src/site/renderer/nextra/Components.ts) | The 9 React components (`Endpoint`, `TryIt`, `SchemaBlock`, `ResponseBlock`, `ParamTable`, `AuthRequirements`, `EndpointMeta`, `CodeSwitcher`, `describeType`) as string templates. Written once by `initProject` |
| [ApiCss.ts](src/site/renderer/nextra/ApiCss.ts) | `generateApiCss({ accentHue })` — single stylesheet at `styles/api.css`, hooks into Nextra's `--nextra-*` tokens for surfaces / dark mode |
| [Paths.ts](src/site/renderer/nextra/Paths.ts) | `apiSpecFolderSlug`, `tagSlug`, `endpointPagePath`, `endpointRoutePath`, `endpointDataPath`, `endpointDataImportSpecifier` — Nextra path conventions |
| [OverviewPageEmitter.ts](src/site/renderer/nextra/OverviewPageEmitter.ts) | `emitOverviewPage(specName, parsed)` — `content/api-{spec}/index.mdx` with per-tag tables |
| [SidebarMetaEmitter.ts](src/site/renderer/nextra/SidebarMetaEmitter.ts) | `emitSidebarMetas(specName, parsed)` — top-level + per-tag `_meta.ts` |
| [EndpointDataEmitter.ts](src/site/renderer/nextra/EndpointDataEmitter.ts) | `emitEndpointData(specName, op, parsed)` — JSON sidecar at `_data/{opId}.json`. Pre-resolves auth schemes / parameters / responses so `<Endpoint>` doesn't look anything up at render time |
| [EndpointPageEmitter.ts](src/site/renderer/nextra/EndpointPageEmitter.ts) | `emitEndpointPage(specName, op, samples)` — per-endpoint MDX shim plus the spec-wide `_refs.ts`. The shim delegates rendering to `<Endpoint>` and ships request/response samples as MDX-fenced code blocks so Nextra's Shiki pipeline highlights them |
| [index.ts](src/site/renderer/nextra/index.ts) | `emitNextraOpenApiFiles(specs)` orchestrator. Components are NOT included here — they're scaffold |

### Why the IR / emitter split (and what it costs)

The agnostic IR is ~70% of the OpenAPI code (parsing, refs, samples,
schema-example synthesis). Without the split, a future Fumadocs port
would copy the whole thing. With the split, only a new emitter
(~600 LoC) is needed and the parser stays one source of truth.

The cost: `OpenApiSpecInput` (`renderer/SiteRenderer.ts`) is the
contract that bridges them. Both layers have to keep it in sync —
type changes in the IR ripple through every emitter signature.

### Adding a new docs framework

1. Create `cli/src/site/renderer/<framework>/` mirroring `nextra/`.
2. Implement `SiteRenderer` (`name`, `initProject`, `getCacheDirs`,
   `generateNavigation`, `renderOpenApiSpecs`, `getContentRules`,
   `runBuild`, `runDev`, `createOutputFilter`, `extractPageCount`).
3. Wire the new renderer into `resolveRenderer` in
   `cli/src/site/renderer/index.ts` and document the `renderer:` key
   value in `site.json`.
4. The agnostic IR layer stays untouched.

### `swagger-ui-react` is gone

The pre-Phase-3 implementation embedded `swagger-ui-react` in a 4-line
MDX shim. That dependency is no longer in `NEXTRA_DEPENDENCIES` — the
new pipeline pre-renders everything as MDX. If you see references to
it in old commits or stale notes, they're outdated.

## Tech Stack

- **Runtime**: Node.js with TypeScript (ESM)
- **Build**: Vite (multi-entry lib mode)
- **Test**: Vitest with v8 coverage (97%+ threshold)
- **Lint**: Biome
- **AI**: Anthropic SDK (`@anthropic-ai/sdk`) with Claude Haiku
- **CLI**: Commander.js
