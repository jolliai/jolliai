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

The recommended way to test locally is a global symlink install — this mirrors the real end-user experience (`npm install -g @jolli/cli`) with the same command name, path resolution, and shebang behavior.

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
                    AI Agent Session (Claude / Codex / Gemini)
                           │
                    ┌──────┴──────┐
                    │  Stop Event  │  (or AfterAgent for Gemini)
                    └──────┬──────┘
                           │ stdin JSON
                    ┌──────┴──────┐
                    │  StopHook   │  Saves session info to
                    │  (Node.js)  │  .jolli/jollimemory/sessions.json
                    └─────────────┘

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
| [Cli.ts](src/Cli.ts) | `dist/Cli.js` | CLI commands (enable, disable, status, view, recall, migrate) |
| [StopHook.ts](src/hooks/StopHook.ts) | `dist/StopHook.js` | Claude Code Stop event handler |
| [SessionStartHook.ts](src/hooks/SessionStartHook.ts) | `dist/SessionStartHook.js` | Claude Code SessionStart hook (injects mini-briefing) |
| [PostCommitHook.ts](src/hooks/PostCommitHook.ts) | `dist/PostCommitHook.js` | Git post-commit hook (operation detection + queue enqueue + worker spawn) |
| [QueueWorker.ts](src/hooks/QueueWorker.ts) | `dist/QueueWorker.js` | Background queue processor (LLM pipeline, squash merge, rebase migration) |
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
| [GeminiSessionDetector.ts](src/core/GeminiSessionDetector.ts) | Detects Gemini CLI installation |
| [Summarizer.ts](src/core/Summarizer.ts) | Anthropic API calls for structured summary generation. Also exports `generateSquashMessage()` for the VSCode extension's squash flow |
| [SummaryStore.ts](src/core/SummaryStore.ts) | Reads/writes summaries to the orphan branch (v3 tree format), merge/migrate operations |
| [SummaryTree.ts](src/core/SummaryTree.ts) | Tree traversal utilities (aggregate stats/turns, collect source nodes) |
| [SummaryMigration.ts](src/core/SummaryMigration.ts) | v1→v3 migration logic for legacy orphan branch data |
| [GitOperationDetector.ts](src/hooks/GitOperationDetector.ts) | Detects git operation type (commit, amend, squash, rebase, cherry-pick, revert) |
| [Installer.ts](src/install/Installer.ts) | Installs/removes hooks in Claude Code, Gemini, and git |

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
| API key missing | Throw with setup instructions |
| API call fails | Retry once (2s delay), then save minimal record (empty topics, `stopReason: "error"`) |
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
| `lock` | Concurrency lock file |
| `dist-path` | Global file (`~/.jolli/jollimemory/`) pointing to the active dist/ directory |
| `resolve-dist-path` | Global shell script (`~/.jolli/jollimemory/`) that reads the global dist-path |
| `debug.log` | Debug/error log |
| `git-op-queue/*.json` | Pending git operation queue entries |
| `squash-pending.json` | Temporary cross-hook file for squash detection |

## Tech Stack

- **Runtime**: Node.js with TypeScript (ESM)
- **Build**: Vite (multi-entry lib mode)
- **Test**: Vitest with v8 coverage (97%+ threshold)
- **Lint**: Biome
- **AI**: Anthropic SDK (`@anthropic-ai/sdk`) with Claude Haiku
- **CLI**: Commander.js
