# Jolli Memory CLI — Development Guide

Technical implementation details, architecture, and code flow documentation for contributors.

## Build & Test

```bash
# Install dependencies
npm install

# Build (vite lib mode, multi-entry)
npm run build

# Run tests — always with coverage and the 97%+ thresholds; this IS the gate
npm run test

# Inner loop: the 328 light files, coverage still enforced (see next section)
npm run test:fast

# Lint (biome)
npm run lint

# All checks (lint + build + test with coverage)
npm run all
```

### Two tiers: inner loop vs gate

`npm run test` is the **gate**: all 446 unit files (~12.1k tests) with `--coverage` and the 97% thresholds, 3.5 min on a quiet box and 9+ min when the machine is busy (measured 213 s and 573 s on the same commit). It is meant to run once before a commit, not once per edit. The 5 acceptance files are a separate runner (`npm run test:acceptance`, 9 tests, ~47 s) — the *root* `npm run test` chains both plus the vscode suite.

**The cost is not spread evenly.** Profiling the full suite (`--reporter=json`, per-file wall time) shows **21 files account for the overwhelming majority of the runtime** while the median file takes **14 ms**:

| s | file | | s | file |
|--:|---|---|--:|---|
| 178 | `dashboard/CutoverEngine` | | 50 | `dashboard/Recovery` |
| 167 | `sync/GitClient` | | 47 | `core/KBPathResolver` |
| 160 | `install/Installer` | | 46 | `dashboard/CutoverRouter` |
| 153 | `sync/BootstrapMerge` | | 41 | `install/DispatchScripts` |
| 111 | `core/BranchCommitLister` | | 32 | `dashboard/ImportState` |
| 101 | `core/RepoProfile` | | 30 | `core/Locks` |
| 82 | `dashboard/AutoCutover` | | 30 | `sync/SyncBootstrap` |
| 57 | `backfill/CommitTargetIndex` | | 23 | `dashboard/Backup` |
| 55 | `install/GitExclude` | | | plus `core/FileDiscardService`, |
| 53 | `core/SpaceBindingCache` | | | `core/GitOps.stateRoot.realgit`, `daemon/DaemonServer` |

Every one of them drives real `git` subprocesses or real filesystem/lock work. The other 425 files sum to well under a minute. So the tiers split along that line:

```bash
# 425 light files WITH coverage — 11.2k tests in ~57s (load-dependent).
# The default inner loop.
npm run test:fast

# The 21 heavy files above — 867 tests, no coverage, and HALF the worker count
# (see "slow tier gets its own concurrency" below).
# Run when you touch sync/, install/, git plumbing or dashboard/ cutover.
npm run test:slow

# Only tests whose import graph reaches your changes
npm run test:changed                     # vs origin/main
npm run test:changed -- --changed HEAD    # uncommitted only

# Tests covering a specific source file / one case
npx vitest related --run src/core/FolderStorage.ts
npx vitest run src/core/SummaryStore.test.ts -t "merges children"
```

`test:fast` + `test:slow` partition the suite exactly (328 + 12 = 340 at `64f8bc6b`), and they cannot drift apart: both tiers read the **same** `SLOW_TEST_FILES` list in [`vite.config.ts`](vite.config.ts) — `--mode fast` uses it as `exclude`, `--mode slow` uses it as `include`. Adding a 13th slow file is one edit. (It used to be two: the same 12 paths were also spelled out in the `test:slow` npm script, where updating one copy and not the other left a file running in both tiers or neither, silently.) Entries are exact repo-relative paths, not `{A,B}.test.ts` brace globs, so a future same-named file elsewhere in the tree can't be captured by accident. Re-derive the list from a fresh `--reporter=json` run rather than guessing which files got slow.

Three traps in the fast tier:

- **`--changed` forces `passWithNoTests`.** Vitest sets it automatically, so a run that matches nothing exits **0**. "Green" from `test:changed` can mean "nothing ran" — check the file count.
- **`--changed` fans out to everything when you touch a shared file.** Editing `vite.config.ts`, `../test/gitEnv.ts`, or a widely-imported module makes every test related — measured at all 340 files. Correct behavior, but it means `--changed` is only fast for localized changes.
- **Skipping coverage is a minor lever.** Full suite: 308s with coverage vs 270s without (`tests` CPU 1919s → 1538s). Instrumentation is ~13%; the win comes from running *fewer files*, not from dropping `--coverage`.

**How `test:fast` keeps coverage meaningful.** Skipping test files without also narrowing the coverage denominator produces a *failing* run out of a passing suite: measured (at the time, 319 files) all green but `92.44/90.43/92.25/92.53` and `EXIT=1`, because `sync/GitClient.ts`, `install/Installer.ts` and friends are still counted while nothing exercises them. A permanently-red inner loop trains you to stop reading its exit code, so `test:fast` runs as `vitest --mode fast` and [`vite.config.ts`](vite.config.ts) drops both halves together — the 14 test files (`SLOW_TEST_FILES`) and the 17 source files they are responsible for (`SLOW_ONLY_SOURCES`). Result: `98.84/96.74/98.73/99.11` in ~25-45s, thresholds enforced.

Three things about that pair:

- **Maintain them together, and re-derive from measurement.** The mapping is not one-to-one — `Installer.test.ts` is the only meaningful cover for four separate hook-installer modules, so the source list has more entries than the test list. The config header documents the two commands that regenerate each list.
- **The coverage exclusion must stay inside the `fast` branch.** Applied to the gate it would silently stop the floor from protecting `sync/` and `install/` at all — the one thing the floor exists for, and a violation of the "don't regress CLI coverage" rule in [`AGENTS.md`](../AGENTS.md).
- **Headroom is thin on purpose:** 96.74% branches against a 96% threshold. If `test:fast` fails on coverage alone, the list needs re-deriving; do not lower the threshold.

For "is the code I just wrote covered", scoping *both* sides to one module is sharper and needs no lists:

```bash
# 100% (10/10) in 152ms — thresholds meaningful because the scope matches
npx vitest run --coverage --coverage.include="src/core/PathUtils.ts" src/core/PathUtils.test.ts
```

The per-file table renders empty under a narrow `--coverage.include`; read the `Coverage summary` block below it.

### Real-`git` tests: isolation and load

About a dozen test files under `src/` spawn real `git` subprocesses instead of mocking them — `sync/GitClient`, `sync/BootstrapMerge`, `install/GitExclude`, `core/BranchCommitLister`, `core/KBPathResolver`, `core/RepoProfile`, `core/Locks`, `core/PushControl` and friends. That is deliberate: they exist to catch what mocks would hide (refspec semantics, git's refusal behavior, `ls-files` output parsing, "untracked working tree files would be overwritten by checkout"). Two consequences follow, and both have burned debugging time.

**1. Isolation is global, not per-file — and monorepo-wide, not CLI-only.** [`../test/gitEnv.ts`](../test/gitEnv.ts) runs as a `setupFiles` entry for every test module and neutralizes `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`, `GIT_TERMINAL_PROMPT`, and `core.excludesFile`. It sits at the **repo root** because all three vitest configs wire it in: this suite ([`vite.config.ts`](vite.config.ts)), the acceptance suite ([`vitest.acceptance.config.ts`](vitest.acceptance.config.ts)), and the vscode suite (`vscode/vitest.config.ts`, whose `JolliMemoryBridge.integration.test.ts` runs a real `git commit`). Don't re-add an isolation prologue to an individual test file — the per-file copies had already drifted apart before this was centralized. Read that file's header before adding a git-related env var; in particular it explains why an author identity is deliberately **not** injected (`GIT_CONFIG_COUNT` outranks repo-local config, so it would override what a test set on purpose).

Env vars, not `git -c` flags, are what make this work: the acceptance fixtures also harden every git command *they* issue (`SAFE_GIT_OPTS` in `test/sync-acceptance/_helpers.ts`), but a `-c` flag only covers the command line you assemble yourself. The git subprocesses spawned by the **production code under test** — `GitClient.commit()` passes an identity and no `commit.gpgsign=false` — inherit the developer's config regardless. Environment variables reach those children; that is the gap `gitEnv.ts` closes.

The `core.excludesFile` neutralization is the non-obvious one: the XDG excludes path (`~/.config/git/ignore`) is a git built-in, so the two `GIT_CONFIG_*` variables do not cover it. A developer `.jolli/` line there — `jolli impact init` adds one — makes `git add .` silently skip seeded `.jolli/…` fixtures, and conflict tests then resolve local-wins instead of remote-wins.

**2. Timeouts are a load signal, not a regression signal.** Triage a failure by its *shape* before investigating:

| Failure shape | Read it as |
|---|---|
| `Test timed out in NNNNms` in `sync/*`, `install/*`, `core/{Locks,KBPathResolver,BranchCommitLister,PushControl}` | Almost always CPU contention starving a real `git` subprocess. Confirm by running the file alone (`npx vitest run src/sync/GitClient.test.ts`) with the **stock** timeout — green in isolation is the proof. |

**A raised ceiling is not a fix for that first row — read it as a symptom instead.** Worked example, same commit, two gate runs: `GitClient > isRebaseInProgress > returns true while a rebase is paused on conflicts` blew the **60 s** budget in a run whose wall clock was 552 s, then the whole 340-file gate re-ran green in 213 s. Alone, that case takes **7.1 s**. So the 8.6× stretch came from load, and the same case has now failed under three successive ceilings (30 s → 45 s → 60 s) — a `git rebase` starved of CPU degrades linearly, and no ceiling outruns that. The levers that would actually change the outcome are trade-offs, not fixes, so they are deliberately not taken here: lower `maxWorkers` for the gate (buys determinism with wall clock), lift the heaviest `GitClient` cases out of the shared fan-out, or accept occasional local red and require green only on CI. Don't reach for a 90 s ceiling as if it were the next step.
| `Unhandled Rejection … ENOENT … coverage/.tmp/coverage-N.json` | Infrastructure, not a test result — a coverage worker wrote its temp file after the directory was cleaned. Seen once after a previous run was killed mid-flight (orphaned worker is the leading suspect, unproven). Zero `FAIL` lines and no threshold errors accompany it. Re-run before investigating; don't kill a coverage run and immediately start another. |
| An assertion or thrown error | Worth investigating as a real regression. |

Rules that follow from this, each learned the hard way:

- **Tune timeouts in the vitest config only** — [`vite.config.ts`](vite.config.ts) for the unit tiers, [`vitest.acceptance.config.ts`](vitest.acceptance.config.ts) for acceptance, `vscode/vitest.config.ts` for the extension (all three sit at 60 s). A per-file `vi.setConfig({ testTimeout })` *replaces* the global rather than widening it, so it can silently shrink the budget for the files that need it most — and a `vitest --testTimeout=…` flag cannot override such a file-local clamp. One such clamp is still live, in exactly the file that can least afford it: `vscode/src/JolliMemoryBridge.integration.test.ts` pins itself to 45 s, so the one vscode file driving a real `git init` / `config` / `commit` runs with 25% less headroom than every pure-unit file in the same suite. The CLI's two heaviest files had this same clamp removed when the globals were raised to 60 s; this one was missed.
- **Concurrency is `maxWorkers`, not `poolOptions`.** Vitest 4 removed `poolOptions`; a config still using `poolOptions.forks.maxForks` runs at **full fan-out** and only prints a one-line `DEPRECATED` notice, which is easy to miss when you grep a long log for `FAIL`. If you tune concurrency, confirm it took effect rather than assuming — an ignored knob makes every measurement after it meaningless. Note `maxWorkers: "75%"` applies to `--mode fast` too, even though the heavy files that motivated the cap don't run there; whether lifting it for `fast` is a win is unmeasured.

- **Lowering the worker count does NOT fix the slow tier's timeouts — measured, and the obvious fix is a trap.** After the dashboard six joined the tier, `CutoverEngine.test.ts` began pushing one case past the 60 s budget under fan-out (that file is 122.8 s and *green* when run alone). Halving `maxWorkers` for `--mode slow` looked like the answer and is not: 6 workers took **448 s and still failed**, on a *different* case in the same file, against **357 s** at 9 workers; 4 workers ran past **20 minutes** without finishing. The give-away is that total test CPU barely moved (2339 s at 6 vs 2328 s at 9) — whatever these files wait on is not the CPU the worker count rations. The tier is 21 files all driving `git`, and git's cost here is `fsync`; fewer workers barely reduces concurrent fsync pressure, so the only thing bought was wall-clock. If you want to attack this, measure an **I/O** lever (tmpfs for the scratch repos, `core.fsyncObjectFiles=false` in the test git env) or make `CutoverEngine.test.ts` itself cheaper — its `beforeEach` runs four synchronous `git` subprocesses per test, 24 times. Until then this file is expected to flake under fan-out: triage by shape, re-run it alone, and read green-in-isolation as proof.
- **`fileParallelism: false` is not immunity from load.** The acceptance suite runs its files serially and still blew a 30 s budget when it started while the slow tier's forks were winding down (the same file passes in 11.8 s alone). Git-subprocess-bound work absorbs pressure from anything on the box, not just from sibling vitest workers.
- **Don't credit a flag for a green run.** If a serial or low-concurrency round passes, the reduced load did it.
- **A flaky round is a wasted round.** Vitest emits no coverage report at all when any test fails — not even a `coverage/` directory — so you cannot mine coverage numbers from a failed run. `maxWorkers` is capped below the default fan-out for exactly this reason.
- **Don't run `./gradlew` (the IntelliJ build) concurrently.** It reliably doubles the timeout count and can starve otherwise-solid files.
- **Don't pipe the gate.** `npm run all | tail -60` reports `tail`'s exit code, which is always 0. Use `npm run all > log 2>&1; echo $?`.

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
               Cursor IDE + cursor-agent CLI / Copilot CLI /
               Copilot Chat / Cline / Devin CLI / Antigravity / Kimi Code)
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
                   Cursor (IDE + cursor-agent CLI) / Copilot CLI /
                   Copilot Chat / Cline (CLI + VS Code) / Devin CLI /
                   Antigravity / Kimi Code are each discovered by their own
                   per-source detector + session discoverer at post-commit
                   time, with the same lazy-import + feature-gate pattern as
                   OpenCode.)

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
| [Cli.ts](src/Cli.ts) | `dist/Cli.js` | CLI commands — Memory: `enable` / `disable` / `status` / `doctor` / `clean` / `heal-folder` / `view` / `export` / `recall` / `search` / `compile` / `graph` / `pr-description` / `mcp` / `sync-memory-bank` / `telemetry` / `configure` / `migrate`; Auth: `auth login` / `logout` / `status`; Site (stubs unless `@jolli.ai/site-cli` is installed): `new` / `convert` / `dev` / `build` / `start`; Workflows (stubs unless `@jolli.ai/workflow-cli` is installed): `workflow local-run` / `runs` / `run-status`. Delegates command registration to per-command modules under `src/commands/` and to `Api.registerCli` so the same registration pipeline is reusable by plugins and the test harness. |
| [Api.ts](src/Api.ts) | `dist/Api.js` | Public API entry (`@jolli.ai/cli/api`). Exports `PluginContext`, `PluginRegister`, `parseJolliApiKey`, `parseBaseUrl`; runs `loadPlugins` after built-in command registration so plugins can append subcommands without touching `Cli.ts`. Backed by an `exports` field in `package.json` that explicitly blocks deep `@jolli.ai/cli/dist/*` imports. |
| [PluginLoader.ts](src/PluginLoader.ts) | inlined in `dist/Api.js` | Plugin discovery — scans the current git project's `node_modules` and the global npm root for entries on the `KNOWN_PLUGINS` allow-list, validates the plugin's `peerDependencies['@jolli.ai/cli']` range against the host's `VERSION`, and invokes the plugin's `register(ctx)` once. Non-throwing — a broken plugin logs and is skipped, never blocks the CLI. Disabled entirely by `JOLLI_NO_PLUGINS=1`. |
| [StopHook.ts](src/hooks/StopHook.ts) | `dist/StopHook.js` | Claude Code Stop event handler. Saves session metadata, then runs one incremental discovery pass (plans + references) sharing a single `discovery-cursors.json` line. Plan scan/upsert lives in [core/plans/](src/core/plans/), not inline here. |
| [SessionStartHook.ts](src/hooks/SessionStartHook.ts) | `dist/SessionStartHook.js` | Claude Code SessionStart hook (injects mini-briefing) |
| [PostCommitHook.ts](src/hooks/PostCommitHook.ts) | `dist/PostCommitHook.js` | Git post-commit hook (operation detection + queue enqueue + worker spawn) |
| [QueueWorker.ts](src/hooks/QueueWorker.ts) | `dist/QueueWorker.js` | Background queue processor — LLM summarization for `commit` / `amend`, LLM-driven `generateSquashConsolidation` (with mechanical merge as fallback) for `squash` / `rebase-squash`, and 1:1 hash migration for `rebase-pick` |
| [PostRewriteHook.ts](src/hooks/PostRewriteHook.ts) | `dist/PostRewriteHook.js` | Git post-rewrite hook (enqueues amend/rebase entries) |
| [PrepareMsgHook.ts](src/hooks/PrepareMsgHook.ts) | `dist/PrepareMsgHook.js` | Git prepare-commit-msg hook (squash detection) |
| [GeminiAfterAgentHook.ts](src/hooks/GeminiAfterAgentHook.ts) | `dist/GeminiAfterAgentHook.js` | Gemini AfterAgent event handler |
| [PostMergeHook.ts](src/hooks/PostMergeHook.ts) | `dist/PostMergeHook.js` | Git post-merge hook — detects merge commits in the pulled range and enqueues **one** repo-wide ingest op (forced past `IngestTrigger`'s per-cwd cooldown, since a merge brings in content authored elsewhere) |
| [PrePushHook.ts](src/hooks/PrePushHook.ts) / [PrePushWorker.ts](src/hooks/PrePushWorker.ts) | `dist/PrePushHook.js` / `dist/PrePushWorker.js` | Git pre-push hook + its worker — synchronous push of the branch's memories to the bound Jolli Space, plus retry of anything left in `push-pending.json`. Gated by `PushControl` (see Core Modules) |
| [PostInstall.ts](src/PostInstall.ts) | `dist/PostInstall.js` | npm `postinstall`. For a user who has already run `jolli enable`, repoints `dist-paths/cli` at **this** install's `dist/` and refreshes the three dispatch scripts (`resolve-dist-path` / `run-hook` / `run-cli`) — without the second half, `npm update -g` would leave the old version's scripts in front of the new package's expectations |

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
| [CodexSessionDiscoverer.ts](src/core/CodexSessionDiscoverer.ts) | Discovers Codex sessions by scanning the filesystem |
| [CodexDiscovery.ts](src/core/CodexDiscovery.ts) | Codex polling-path artifact discovery (`discoverCodexConversations`). Extracts Linear/Jira/GitHub/Notion/Slack/Zoom references **and markdown plans** from Codex rollout transcripts on the VS Code sidebar's 60s polling tick. References scan first; their safe cursor caps plan scanning so plans never re-process lines a later poll re-reads (no plans.json churn). Reuses the shared source-agnostic envelope parser ([references/TranscriptEnvelopeParser.ts](src/core/references/TranscriptEnvelopeParser.ts) → `CodexEnvelopeParser`), the per-agent plan scanner ([plans/PlanTranscriptScanner.ts](src/core/plans/PlanTranscriptScanner.ts) → `CodexPlanScanner`), and the same `discovery-cursors.json` cursor as the Claude Stop path; single-flight + dirty-rerun per cwd, never throws. |
| [plans/](src/core/plans/) | Source-parameterized plan discovery, mirroring `references/`. [PlanTranscriptScanner.ts](src/core/plans/PlanTranscriptScanner.ts) is the per-agent interface + `getPlanScanner(source)` registry; [ClaudePlanScanner.ts](src/core/plans/ClaudePlanScanner.ts) reads plan-mode slugs + Write/Edit `.md` paths, [CodexPlanScanner.ts](src/core/plans/CodexPlanScanner.ts) reads `apply_patch` `*** Add/Update File:` / `*** Move to:` headers. [TranscriptPlanDiscovery.ts](src/core/plans/TranscriptPlanDiscovery.ts) is the source-agnostic `scanPlansFrom(…, source, toLine)` driver: shared `isExternalPlanCandidate` filter, archive guard, note dedup, `resolveUniqueSlug`, concurrent merge under `withPlansLock`. |
| [GeminiSessionDetector.ts](src/core/GeminiSessionDetector.ts) | Detects Gemini installation |
| [OpenCodeSessionDiscoverer.ts](src/core/OpenCodeSessionDiscoverer.ts) | Discovers OpenCode sessions by reading `~/.local/share/opencode/opencode.db` (Node 22.13+ `node:sqlite`, lazy-imported and feature-gated). Surfaces a typed `OpenCodeScanError` when the DB is present but unreadable (corrupt / locked / schema mismatch) so the UI can render a dedicated "unavailable" row. |
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
| [Installer.ts](src/install/Installer.ts) | Installs/removes git hooks and MCP server registrations. Git hooks: Claude Code `StopHook`/`SessionStartHook`, Gemini `AfterAgent`, `post-commit`, `prepare-commit-msg`. MCP: `registerRepoMcpHosts` / `registerGlobalMcpHosts` / `removeRepoMcpHosts` drive per-host `McpHostRegistrar` implementations across twelve hosts — repo-scoped (Claude `.mcp.json`, Cursor `.cursor/mcp.json`) and global-scoped (Gemini `~/.gemini/settings.json`, Codex `~/.codex/config.toml`, OpenCode, Copilot CLI, VS Code Copilot Chat, Cline, Devin CLI, Antigravity, Kimi Code, Hermes Agent — the last also registers its `on_session_end` shell hook). Non-Claude registrars are gated on the host's **presence on disk**, deliberately a weaker predicate than the readability-gated detector that governs session discovery. Uninstall removes only the two repo-scoped registries: dropping a global entry would break MCP for every other repo on the machine. |
| [references/ReferenceExtractor.ts](src/core/references/ReferenceExtractor.ts) / [references/ReferenceStore.ts](src/core/references/ReferenceStore.ts) | Multi-source external-reference extraction (fifteen `BUILTIN_DEFINITIONS` today: Linear / Confluence / Jira / GitHub / Notion / Slack / Zoom meetings / Zoom docs / Asana / monday.com / context7 doc lookups / Jolli's own lookups / Vercel deployments / Figma design files / Sentry issues) + per-commit reference store. `vercel`, `figma` and `sentry` are **track-only**, joining `context7` and `jollimemory` — archived and displayed like any other reference but never passed to the summarize prompt, since a build log or stacktrace is the *input* to the work and reads as a reason for the change (and a memory lookup fed back to the summarizer would let recall feed itself). They also carry no `match.codex` (nor does `zoom-doc`), so those four never resolve from Codex transcripts — eleven of the fifteen reach the Codex path. Kimi is a separate axis: it resolves through `match.claude`, so every definition carrying a generic `mcp__<server>__` prefix reaches it, `vercel` / `figma` / `sentry` included — `zoom-doc` is the only one of the four that is genuinely Claude-only. The extractor walks transcripts via per-source envelope parsers (`references/sources/`, `references/bindings/`) for the relevant MCP tool calls and normalises them into an opaque `ReferenceField` bag, so adding a source is a binding entry rather than a schema change. The store persists references to the orphan branch with the same hoist-on-rebase / merge-on-squash semantics as Plans and Notes (see `QueueWorker.runSquashPipeline` for the integration). |
| [skills/](src/core/skills/) | Skill-usage capture, mirroring `plans/` and `references/`. [SkillTranscriptScanner.ts](src/core/skills/SkillTranscriptScanner.ts) is the per-source registry for the **line-oriented** JSONL path: Claude and Kimi Code (both a real, observed skill tool) and Codex (an `exec_command`-reads-`SKILL.md` heuristic — every row carries `detection: "heuristic"` and no token figure). **OpenCode also has a real skill tool but is deliberately not in that table** — its transcripts are SQLite rows, so it gets its own reader ([OpenCodeSkillDiscovery.ts](src/core/skills/OpenCodeSkillDiscovery.ts)) driven from the 60 s polling tick. Two different reasons for the remaining absences, and they are not interchangeable: Gemini / Antigravity / Cline / Devin have **no skill concept on disk at all**, while Cursor and Copilot CLI **have skills but no invocation record** (Cursor ships `~/.cursor/skills-cursor/` yet 139 real chat files reference none of them; Copilot's `forge_skill_proposals` is an authoring table, not an invocation log) — so no matcher may be written for those two until a real invocation is captured from a live run. [TranscriptSkillDiscovery.ts](src/core/skills/TranscriptSkillDiscovery.ts) is the source-agnostic driver; wire every new discovery site through its shared `scanSkillsWithCursor` helper, never open-coded load/scan/save (`discovery-cursors.json` is monotonic — a mark advanced over unscanned lines strands them permanently). Skills ride their **own** `skills` high-water mark, independent of the shared `lineNumber` the plan/reference pair use; only subagent files (`<sessionId>/subagents/agent-<agentId>.jsonl`) are re-scanned in full each pass, because they are short, self-contained, and never duplicated into the session file. [SkillStore.ts](src/core/skills/SkillStore.ts) writes one markdown file per skill under `<jolliMemoryDir>/skills/<source>/<stem>.md`, split per session (`<source>:<sessionId>`) so a session's contribution replaces its prior entry while another session's is added; that file is also the only dedup ledger — `foldSkillUse` keys invocations by timestamp — which is what makes the subagent re-scan harmless. [SkillArchive.ts](src/core/skills/SkillArchive.ts) copies the working file byte-for-byte onto the orphan branch (never re-renders — that would fork the display format), and [SkillDelta.ts](src/core/skills/SkillDelta.ts) derives "uncommitted" as `current - archivedTotals` so a skill re-entered after archival counts only its increment and the PR-wide aggregate stays a plain sum. |
| [PushControl.ts](src/core/PushControl.ts) / [PushControlStore.ts](src/core/PushControlStore.ts) | Per-repo outbound-push control. The store is machine-global (`~/.jolli/jollimemory/push-control.json`) and keyed per repo; an unreadable store **fails closed to OFF for every repo**, so `readPushDisabledState` returns the reason alongside the flag and every surface must show it — otherwise the user sees an inexplicable OFF they cannot act on. Note `--enable` rebuilds a corrupt store from an *empty* set, dropping every other repo's opt-out. Enforced at the push boundary ([PushExecutor.ts](src/core/PushExecutor.ts), [PrePushHook.ts](src/hooks/PrePushHook.ts), [JolliMemoryPushOrchestrator.ts](src/core/JolliMemoryPushOrchestrator.ts)) rather than at the call sites, and surfaced through `jolli push-control`, `jolli status`, and the VS Code **Settings → Sync to Jolli** list. |
| [ActiveSessionAggregator.ts](src/core/ActiveSessionAggregator.ts) | Aggregates active sessions across every source (Claude / Codex / Gemini / OpenCode / Cursor IDE + `cursor-agent` CLI / Copilot CLI / Copilot Chat / Cline / Devin CLI / Antigravity / Kimi Code) into a single `ActiveSession[]` snapshot. Powers the VS Code **Conversations** sidebar section; safe to poll because every per-source detector + reader is feature-gated and cheap. |
| [ConversationOverlayStore.ts](src/core/ConversationOverlayStore.ts) | Persists per-session **transcript edit overlays** — the curated turn list a user produced in the Conversation Details panel. Stored locally per-project; consulted by the summarization pipeline so the LLM sees the user's curated version, not the raw transcript. |
| [CommitSelectionStore.ts](src/core/CommitSelectionStore.ts) | Per-project on-disk store for the **per-item commit selection** state (plans / notes / conversations / files unchecked from the next commit's memory). Selections persist across commits and restarts; the worker consults this store when assembling the LLM context. |
| [Regenerator.ts](src/core/Regenerator.ts) / [RegenerateContext.ts](src/core/RegenerateContext.ts) | The "Regenerate Summary" backend. `RegenerateContext` rebuilds the full v4 tree context (transcripts + diff + plans/notes + references) for a given commit hash; `Regenerator` drives the LLM call with explicit stale-write guards so an amend / squash mid-regenerate cannot clobber the new history. |
| [TranscriptSourceLabel.ts](src/core/TranscriptSourceLabel.ts) | Maps a transcript's source (`anthropic-config` / `anthropic-env` / `jolli-proxy` / `local-agent` / per-agent labels) to the human-readable provider label rendered in the Summary Webview footer. |
| [core/localagent/](src/core/localagent/) | The `local-agent` AI-provider backend, selected by `aiProvider: "local-agent"`. `LocalAgentRunner` drives a locally-installed agent CLI to generate a summary instead of calling an API; `BackendRegistry` maps `localAgentTool` (`claude-code` (default) / `codex` / `cursor-agent` / `opencode` / `kimi`) to a backend; each backend builds its own invocation and resolves its binary (honoring `localAgentPath`, else `PATH` discovery). The model is pinned per tool, and only for a tool that declares one (`claude-code` and `codex` today): `resolveLocalAgentModel` returns `""` for the rest, and an empty model makes every backend's `--model` conditional, so those keep running whatever they are configured with. Each pinned tool carries its OWN `defaultModel` — the ids are each CLI's namespace, so there is no value that is a sane default for two of them. `localAgentModel` selects the pinned value (`inherit` opts back out); stored metadata still prefers the model a backend can prove it ran. A pinned tool must also classify a refused model as `LocalAgentModelRefusedError`, which is what earns it the one un-pinned retry. Two asymmetries are deliberate: only `claude-code` is capability-probed with the real run flags, and `opencode` keeps provider credentials in the child environment — so it spends the user's own provider credit and has no auth-failure classification. Surfaces as the `local-agent` value in `LlmCredentialSource`. |
| [TokenCost.ts](src/core/TokenCost.ts) | Single source of truth for token totals and the cache-aware Sonnet-pricing cost estimate. Holds the pricing constants plus both the compact formatters (space-constrained UI token bars) and the exact formatters (thousands-separated counts, precise `$`) used by the pushed-article **Task usage** line. Aggregation walks the whole consolidation tree, so squash/amend memories carry the tokens folded onto their children; a positive-but-tiny cost floors to `<$0.0001` rather than a misleading `$0.0000`. The CLI Markdown builders and the VS Code token meter / sidebar bar both draw from here (VS Code re-exports it through `SummaryUtils`) so counts can never disagree. |
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

### Global skill-preference instructions

`enable` can run [`GlobalInstructionsInstaller`](src/install/GlobalInstructionsInstaller.ts), which upserts a "prefer Jolli's memory" managed block into each detected host's **global** instruction file — `~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`. The block describes Jolli's recall/search capabilities **by intent** rather than hard-coding skill IDs, so plugin (`jolli:recall`) and CLI (`jolli-recall`) installs both resolve to whatever recall/search skill or `mcp__jollimemory__` tool is registered. The block is bracketed by `<!-- >>> jolli memory instructions >>> -->` / `<!-- <<< … <<< -->` markers (the same managed-block strategy as [`GitExclude.ts`](src/install/GitExclude.ts)): the section between markers is rewritten on each install, everything outside is preserved verbatim, and a pre-existing *unmarked* section a user pasted by hand is adopted in place rather than duplicated. The whole operation is fail-soft — a broken or read-only global file never breaks `jolli enable`. Because these files are machine-global (one per host, shared by every repo), `disable` / `uninstall` deliberately **leaves the block in place**, mirroring global-scope MCP registration. Only Codex reads a global `AGENTS.md`; Cursor / OpenCode / Copilot read `AGENTS.md` at the project root, so they are intentionally out of reach here.

The write is **purely opt-in through settings** (0.99.7). A tri-state `globalInstructions` config switch — `undefined` (undecided) / `"enabled"` / `"disabled"` — is resolved by `resolveGlobalInstructionsDecision`, now a pure function of the stored value with no prompting. `jolli enable` never asks; it only **applies** the current decision (`enabled` → write, `disabled` → remove, undecided → no-op). The opt-in surfaces are `jolli configure --set globalInstructions=enabled` (applied immediately) and the VS Code **Global Instructions** toggle in Settings → AI Agents; both funnel through the shared `syncGlobalInstructions` helper, which writes or removes with host-gating in one place (`removeGlobalInstructions` strips the block from every host, ungated). The `GLOBAL_INSTRUCTIONS_PROMPT` constant lives on as the settings toggle's helptext. (Before 0.99.7 this was gated on an interactive `jolli enable` prompt and a VS Code activation notification, both since removed.)

## Cold-start Backfill

`jolli backfill` ([`BackfillCommand`](src/commands/BackfillCommand.ts) → [`BackfillEngine`](src/backfill/BackfillEngine.ts)) generates summaries for historical commits that predate `enable`. For each candidate commit with no summary on the orphan branch, the engine attributes Claude transcripts by tier:

- **high** — the commit's changed files overlap a session's touched files.
- **medium** / **low** — the session merely falls within a nearby time window of the commit (branch-match and time-window tiers).

`--min-confidence` sets the floor for *attaching a conversation*: an attribution below the floor is dropped and the commit falls back to a diff-only summary — every own commit still gets at least a diff summary (宁缺毋滥 only blocks attaching an unsure conversation). `--dry-run` reports each commit's `method` (`file-overlap` / `branch-match` / `time-window` / `diff-only`), its `confidence` when a conversation was attributed, and the `commitSubject`, without an LLM call. Diff-only summaries are stamped with the `branch` marker `"backfilled"` (the `DIFF_ONLY_BRANCH` constant), since with no attributed conversation there is no reliable branch to record. Scope is `--last <n>` (default 20) or `--all` (everything reachable from HEAD); output is `text` or `json`. The backfill scan window and per-run limit come from shared constants, and the editor extensions call the same engine when they detect a repo with commit history but no memories (the "offer to back-fill on enable" prompt), storing a dismiss flag in the git common dir so a worktree switch doesn't re-nag.

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
| `skills/<source>/<stem>.md` | Captured skill usage, one markdown file per skill. Also the dedup ledger (invocations are keyed by timestamp) that makes the full-file subagent re-scan idempotent — never clear it at archive time or a re-scan of an archived transcript reads as fresh usage |
| `push-control.json` | Global file (`~/.jolli/jollimemory/`) recording which repos are opted out of outbound push |
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

The CLI ships a local full-text search index plus an stdio MCP server that exposes JolliMemory's history to AI agents.

### Local search index

The index lives at `.jolli/jollimemory/search-index.json` (with a sidecar `search-index.manifest.json`) under the per-project `.jolli/jollimemory/` dir. It is a **disposable cache** — never written to the orphan branch — rebuilt from source (the topic KB + commit catalog) via [SearchIndex.ts](src/core/SearchIndex.ts) on top of an Orama BM25 index. The manifest records a schema version and a **staleness signature** (`computeSourceSignature` in [SearchIndexSource.ts](src/core/SearchIndexSource.ts)); `SearchIndex.open()` restores from disk only when both match the current source, otherwise it rebuilds and re-persists. Because source data (orphan branch / folder) is always authoritative, the index can be deleted at any time and is regenerated on next open.

The index is also refreshed **incrementally at the end of `jolli compile`** (per-repo), so agents querying right after a compile see fresh results without a manual reindex.

### `jolli mcp`

`jolli mcp` ([McpCommand.ts](src/commands/McpCommand.ts)) is the stdio MCP entry AI agents connect to. `jolli mcp --reindex` forces a full rebuild of the local search index from source and exits (no server).

The command does not *host* the server: it runs a thin proxy ([McpProxy.ts](src/mcp/McpProxy.ts)) that ensures one detached daemon per worktree (`jolli mcp-serve`, hidden — [McpDaemon.ts](src/mcp/McpDaemon.ts)) and forwards raw bytes to it over a unix socket / Windows named pipe. The host still spawns a plain stdio process per session and needs no config change; what changed is that the ~100 MB of storage + manifest init behind `prepareMcpRuntime` is paid **once per worktree** rather than once per session. A proxy measures ~16 MB against an 11 MB bare-Node floor. Set `JOLLI_MCP_NO_DAEMON=1` to force the old in-process server, which is also the automatic fallback whenever a daemon cannot be reached. The design contract — worktree-scoped identity, version handshake, degraded-manifest retry, and the two import graphs that keep the proxy small — is in [AGENTS.md](../AGENTS.md#jolli-mcp-is-a-proxy-the-server-is-one-daemon-per-worktree).

Measuring this yourself: use `vmmap -summary <pid>` (macOS) and read **Physical footprint**, not `ps` RSS. RSS attributes ~22 MB of shared node-binary pages to every process, which made 43 servers look like 1.6 GB when they were really ~4 GB.

The server exposes ten built-in tools, all pure handlers in [McpTools.ts](src/mcp/McpTools.ts):

| Tool | Purpose |
|------|---------|
| `search` | Full-text BM25 search (Orama) over the repo's historical decisions and implementations; returns `{ hits }`. Calls the same `searchHits()` ([SearchHits.ts](src/core/SearchHits.ts)) as `jolli search`, so results are identical. |
| `recall` | Recall a branch's development context from **RAW commit summaries** — the same data path as the `jolli-recall` skill, NOT the topic KB. Calls the same `resolveRecall()` ([RecallResolver.ts](src/core/RecallResolver.ts)) as `jolli recall --format json`; returns the same `type`-tagged union (`recall` \| `catalog` \| `error`). Defaults to the current branch. |
| `get_decision_timeline` | Chronological evolution of a topic — its source events ordered oldest-first. |
| `list_branches` | All branches with JolliMemory records and their topic titles. |
| `get_pr_description` | Build a GitHub PR title + description from the branch's JolliMemory commit summaries — the same memory-rich body the VS Code extension writes. Use before `gh pr create`. |
| `queue_status` | Report whether summary generation is still draining the git-op queue — call before `get_pr_description` so fresh commits are included. |
| `status` | Installation & configuration health for this repo — the MCP mirror of `jolli status`, wrapping `getStatus()`. Reads the site from `config.jolliUrl` and never decodes the API key, so it stays clear of the CodeQL clear-text-logging gate. |
| `bind_space` | Bind this repo to a Jolli Space. |
| `list_spaces` | List the Jolli Spaces you can bind to. |
| `push_memory` | Push a branch's memories to the bound Jolli Space as articles. |

`McpServer.ts` is pure glue: tool schemas (`TOOL_DEFINITIONS`) plus a `dispatchTool` table over the `McpTools` handlers, adapted into SDK request handlers (`ListTools` / `CallTool`). Errors from a handler are returned as an `isError` tool response rather than crashing the server.

**Backend-defined platform tools (0.99.8).** On top of the ten built-in tools, the server can surface **platform tools** defined by the Jolli backend manifest — on by default (`mcpPlatformToolsEnabled`, with a `JOLLI_MCP_PLATFORM_TOOLS=1` env override; set the config flag to `false` to opt out). `JolliMemoryPushClient.fetchManifest()` is best-effort (returns `[]` on any failure with a short timeout, so a disabled or older backend degrades silently), and `invokePlatformTool()` relays each call with the existing bearer + tenant/org auth. Each manifest entry is validated against the MCP tool-input-schema contract, and its `method + path` binding is honored **only when the resolved origin matches the tenant origin** (compared after full URL normalization), so a poisoned manifest can't redirect the bearer token off-origin; otherwise it falls back to `POST /api/mcp/tools/<name>`.

## Local Dashboard (`jolli dashboard`)

Everything under [`cli/src/dashboard/`](src/dashboard/) serves one machine-global SQLite database, `~/.jolli/jollimemory/jollimemory.db`. `DashboardCommand` is an ordinary foreground command: it migrates the schema, binds the loopback port **in its own process**, opens the browser, runs the import sweep while the page is already up, and then serves until Ctrl+C. [DashboardServer.ts](src/dashboard/DashboardServer.ts) is the loopback-only HTTP service it binds, with a mutation token on every state-changing route. Pages: `/dashboard`, `/dashboard/standup`, `/memories`, `/knowledge` (wiki browsing), `/graph` (the same graph runtime the export uses), plus the Settings modal ([SettingsPageQuery.ts](src/dashboard/SettingsPageQuery.ts) / [SettingsMutations.ts](src/dashboard/SettingsMutations.ts)). Two paths are retired and survive only as permanent 302s: `/repositories` (replaced by the topbar repo picker — with it gone, `/` no longer builds a model just to choose a landing page) and `/decisions` → `/memories`, whose content moved into the Memories rows.

It used to be a launcher for a detached server, with a `dashboard.json` pid/port record, a `/health` reuse probe, a `dashboard-spawn.lock`, a two-hour idle self-shutdown and a `--stop` flag. All of that is gone, and so is the constraint it forced: because a launcher reused whatever server the record named, that server's build could lag behind the CLI that found it, and it therefore could not be allowed to migrate the schema. Server build now equals command build by construction.

Seven rules are easy to break and each has already cost something:

- **GET never writes.** Renders open the database read-only; producers write it directly through [StatsWriter.ts](src/dashboard/StatsWriter.ts), so whether the server is running has no effect on capture. Two reasons survive the daemon's removal and are worth keeping straight from the migration rule above: WAL's one-writer/N-readers split, and the SQLite-enforced guarantee that a browser-reachable render path cannot write at all. The single write this process makes is `projectRegistryEntry`, and it is now an ordinary `withDashboardDb` call.
- **No GET spends model money either.** The Decisions card used to render LLM-written prose, which put a paid call behind a page load: `DecisionGist.ts`, `attachDecisionGist`, `ModelRequest.allowModelSpend` and the prompt template are all retired, and the card now shows its decision's owning topic title, which the query already carries. `isCrossSiteRequest` / `trusted` stay — they also gate the Settings view's masked keys, and `DashboardServer.test.ts` pins that gate directly. Reintroducing a model call on a render path is a review blocker: the page polls itself every 30 s.
- **No GET shells out to `git` either — reachability is a materialized column.** Every view that hides rewritten-away commits used to run a `git rev-list --branches` per repo on each page load and each 30 s `/api/model` poll (~880 ms concurrent on a 44k-commit repo). `memories.reachable` / `commits.reachable` now carry that answer, maintained asynchronously by the back-fill sweep and a global-daemon reconcile task, and views filter `reachable = 1` in SQL; `readReachableCommitsByRepo`, `REACHABILITY_VIEWS` and the `ReachableCommits` plumbing are gone. The trade-off is deliberate: `DEFAULT 1` fails toward *visible*, so a commit orphaned by a ref-only rewrite (`reset`, `branch -f`, force-fetch) stays listed until the next sweep — a few minutes for those rare operations — rather than costing a subprocess on every render. Reintroducing a per-read `git` call here is the same review blocker as reintroducing a model call.
- **The import sweep must be idempotent, and "idempotent" means comparing before projecting, not gating on a cursor.** [DbBackfill.ts](src/dashboard/DbBackfill.ts)'s summary tier is gated by the memory index's content hash, which moves whenever *any* memory is written — so an actively developed repo re-enters it on essentially every pass, and narrowing that gate is impossible (consolidation folds children into new roots, so per-entry cursors cannot work). What is narrowed is the **projection**: each tier collects whole and compares against what is already stored. Before that, one real machine logged 219 byte-identical `commit.summary` events and ~40 `session.upserted` events per `jolli dashboard`. Watch for the second failure shape too — the summary projection creates a `commits` row and the commit tier's prune deletes it again for any hash git can no longer reach (a rebased-away commit whose memory survives), so the two tiers ping-ponged 74 events per run forever. Only a **complete** collection may claim a hash is gone.
- **The schema lives in [SotSchema.ts](src/dashboard/SotSchema.ts), split by nature, not by table group.** `ACTIVITY_DDL` is a projection of git and each agent's storage and can be rescanned; `MEMORY_SOT_DDL` is the only copy there is. Migrations are keyed by **name** in `DashboardDb.MIGRATIONS`, their DDL is frozen once shipped, and the database never refuses a build over its version — see the critical rule in [AGENTS.md](../AGENTS.md) before touching any of it.
- **Backfill is not part of the request surface.** [DbBackfill.ts](src/dashboard/DbBackfill.ts)'s import sweep is the command process's startup step, and generating memories stays `jolli backfill`. The one browser-reachable exception is Settings → Generate Missing Summaries, added for parity with the VS Code panel and serialised by an in-flight guard. That guard is **process-scoped**, so it cannot see a concurrent `jolli backfill` in another terminal — `runBackfill` therefore re-checks each commit immediately before its model call, which is what actually stops paying for a summary twice. Its session tier scans each agent's own on-disk store over a **7-day window** (see the `cli/src/core/sessions/` note below) and reports a one-line summary, because that tier is excluded from the progress block's reveal rule and was otherwise indistinguishable from a run that did nothing.
- **Snapshots are `VACUUM INTO`, verified before rotating.** [Backup.ts](src/dashboard/Backup.ts) writes into a temp file in the target directory and renames, runs `integrity_check` on the result, and only then collects old snapshots — a machine whose backup drive is unplugged must never empty itself one expired file at a time. Age comes from the UTC stamp in the filename, not mtime (sync drives rewrite mtime). Restore candidates surface through [Recovery.ts](src/dashboard/Recovery.ts) and `jolli doctor --recover`.

One client-side rule is worth knowing before touching `assets/js/stats.js`. Every control on the page ends in a full repaint of `#app`, and the page re-reads `/api/model` every 30 s — so anything the *reader* has changed in place has to be carried across a repaint deliberately, or it silently reverts. Two mechanisms do that, and they are separate on purpose: the `JD.carryForwardHooks` seam in `refreshNow` carries an **expanded** tool list across the poll and re-verifies it (a list re-read at the width it is displayed at, compared against what is on screen — collapse to page 1 only when it really moved, because a reader watching row 30 cannot tell a re-fetched page from the one they were reading), while **scroll position** is restored by `renderStats` itself rather than by each control, since otherwise every future caller of `renderPage` has to remember to preserve the lists it is *not* touching. Both guard-and-report on failure: every degradation here looks exactly like the feature never having been built, so a silent `.catch` would hide it for the tab's whole lifetime.

Session discovery for that tier is table-driven under [`cli/src/core/sessions/`](src/core/sessions/) — `SessionSourceDefinition` + `SessionSources` declare each agent's store shape, and `SessionSignalExtractor` / `SkillExtractor` / `ToolCallExtractor` pull the signals out of a transcript once, rather than each source re-parsing. Fan-out over that 7-day window is bounded by [`util/Concurrency.ts`](src/util/Concurrency.ts): a whole window's transcripts do not fit in memory at once.

Cutover — moving a repo's source of truth from the orphan branch to this database — is [CutoverRouter.ts](src/dashboard/CutoverRouter.ts) (four states: `uncutover` / `legacy-fenced` / `cutover` / `blocked`), [CutoverEngine.ts](src/dashboard/CutoverEngine.ts) (the CAS over every source's frozen tip) and [AutoCutover.ts](src/dashboard/AutoCutover.ts). `StorageFactory` routes on that table; the retired `storageMode` config key does not.

## Resident processes: three daemons, three different jobs

They are easy to confuse and their lifetimes are deliberately opposite. None of them is required — every one has an in-process or opportunistic fallback.

| Daemon | Keyed by | Lifetime | Job |
|--------|----------|----------|-----|
| [McpDaemon.ts](src/mcp/McpDaemon.ts) (`jolli mcp-serve`, hidden) | worktree root | reaps itself a few minutes after its last client leaves | Hosts the MCP server so `prepareMcpRuntime` is paid once per worktree instead of once per session. Reached through [McpProxy.ts](src/mcp/McpProxy.ts); see `jolli mcp` above. |
| [DaemonServer.ts](src/daemon/DaemonServer.ts) (`jolli daemon`, and `ide-bridge-serve`, which is what actually runs) | project cwd | lives as long as its client | Watches the queue dir, the orphan ref, `plans.json` and `~/.claude/plans/`, and pushes `refresh` notifications at JVM hosts, which have no in-process way to notice a write. `computeWatchTargets` is the single watch list — see the push-channel section in [AGENTS.md](../AGENTS.md). |
| [GlobalDaemon.ts](src/daemon/GlobalDaemon.ts) (`global-daemon`, hidden) | machine + user | **no idle timeout** — only a retire, a lost bind race, or shutdown | Runs work that must happen when nobody is working. Two tasks today, both machine-wide: the daily `jollimemory.db` snapshot, which every other trigger only reaches opportunistically, and the 30-second agent-conversation re-scan ([SessionRescanTask.ts](src/daemon/SessionRescanTask.ts)), which notices a conversation that kept growing after the dashboard imported it. |

Two things about the global daemon are counter-intuitive enough to be worth stating here:

- **Its trigger must never wait on its event loop.** [EnsureGlobalDaemon.ts](src/daemon/EnsureGlobalDaemon.ts) is called from five places and four are on the git or agent critical path, so `connect()` (answered by the kernel, hence bounded) decides *whether one exists*, while reading `hello` (answered by the daemon, which may be mid-`VACUUM INTO` for hundreds of ms) gets a 300 ms budget whose timeout means **do nothing**. Neither spawn may use `process.argv[1]` — see the critical rule in [AGENTS.md](../AGENTS.md), which is what [CliEntry.ts](src/util/CliEntry.ts) exists for.
- **[TaskScheduler.ts](src/daemon/TaskScheduler.ts) holds no persistent state.** `tickIntervalMs` is how often to *ask* a task whether it is due, not how often it acts — `maybeSnapshot` already gates itself on `last-snapshot-at`. Downtime catch-up and post-retire handover both work *because* of that: every task is ticked once at startup and answers for itself.

## Knowledge Wiki & Graph

`jolli compile` ([CompileCommand.ts](src/commands/CompileCommand.ts), multi-repo sweep in [MultiRepoCompile.ts](src/core/MultiRepoCompile.ts)) is a two-phase build over a repo's memories:

1. **Knowledge wiki** — ingest sources → fold work on the same theme into per-topic pages → render the browsable `_wiki/` folder. Progress is reported as `Building knowledge wiki — <repo>`.
2. **Knowledge graph** — immediately after the wiki, `buildKnowledgeGraph` distills those topics into a graph. Progress is reported as `Building knowledge graph — <repo>`.

**Rebuilds are manual by default, and the polarity check has one correct spelling.** A git operation no longer auto-triggers an ingest: `PostCommitHook`, `PostMergeHook` and the backfill gate their `enqueueIngestOperation` calls on [`WikiRebuildMode.ts`](src/core/WikiRebuildMode.ts)'s `wikiRebuildIsAuto`, which tests `config.wikiRebuild === "auto"`. Never write it as `!== "manual"` — an **absent** key is every install that predates this change, and flipping `undefined` to auto re-enables exactly the per-commit spend this removed. That module is a dependency-free leaf (one type import) so the three git-hook bundles that consult it do not drag storage and source-timeline code in.

The pending count the dashboard and the VS Code sidebar both render comes from [`WikiFreshness.ts`](src/core/WikiFreshness.ts) — a product rule, so it lives in `core` and both hosts read the same numbers ("N updates behind · rebuilt X ago", with `WIKI_BEHIND_WARN_COUNT` / `WIKI_BEHIND_WARN_MS` deciding the warn tint). It scans every source ref to count what is pending, so treat it as a **slow probe**: its own endpoint (`/api/wiki/freshness`), off the first-paint path, never a hot loop. `/api/wiki/rebuild` runs `compileAllRepos` **in** the long-lived server process and the page polls it to completion, rather than spawning the old per-repo detached worker.

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

### Host / agent attribution (`agent`, `via`, commit trigger)

Since 0.99.14 Jolli records **which AI host ran the work** and **how the command was reached**. These are several *orthogonal* dimensions that share one vocabulary but are computed by independent code paths — the easiest thing to get wrong is to conflate them. The shared vocabulary is `TRANSCRIPT_SOURCES` ([Types.ts](src/Types.ts)) — the 14 hosts `claude` / `codex` / `gemini` / `opencode` / `cursor` / `cursor-cli` / `copilot` / `copilot-chat` / `cline` / `cline-cli` / `devin` / `antigravity` / `kimi` / `hermes`. `TelemetryAgent = TranscriptSource` is an alias, not a copy.

**The one design rule across every dimension: closed-set in, absent out, never a default.** [TelemetryAgent.ts](src/core/TelemetryAgent.ts)'s `resolveTelemetryAgent` / `resolveInvokedVia` / `resolveClientInfoAgent` each return `undefined` for anything not in their closed set. Detection that isn't sure emits *nothing* rather than a guess — because the values ride into shared, long-lived processes (below) where a wrong guess is worse than a blank.

- **The `agent` dimension — who ran it.** Two detectors in [TelemetryAgent.ts](src/core/TelemetryAgent.ts): `detectAgentFromEnv(env)` reads a host's own env markers (`AGENT_ENV_MARKERS` for one-marker hosts, `AGENT_ENV_FAMILIES` for Cursor's gate-then-variant `CURSOR_AGENT` → `CURSOR_WORKSPACE_LABEL`/`CURSOR_INVOKED_AS`), and `resolveClientInfoAgent(name)` maps an MCP `clientInfo.name` (`CLIENTINFO_AGENTS`). `detectAgentFromEnv` returns `undefined` on *disagreement* (two hosts' markers both present) and short-circuits to `undefined` for a `local-agent` child we spawned (`isLocalAgentChild` — an outbound `claude`/`codex` is not the user's host). Every marker in the table carries a dated, measured provenance note in-file; `AI_AGENT` and `CURSOR_TRACE_ID` are deliberately left unmapped (`AMBIGUOUS_AGENT_ENV_KEYS`). **Kimi and Devin are commit-time-only:** a probe (documented in-file) found kimi-code sets zero `KIMI_*`/`MOONSHOT_*` in spawned shells and the Devin probe was blocked, so neither is in `AGENT_ENV_MARKERS`.
- **The `via` dimension — how it was reached** ([4707fd7df]). `JOLLI_INVOKED_VIA=skill:<bare-name>` distinguishes a command a Jolli *skill* invoked from one the user typed. The bare-name set is `SKILL_VIA_NAMES`; the skill recipes stamp it (emitted by [SkillInstaller.ts](src/install/SkillInstaller.ts) / [CodexPluginSkills.ts](src/install/CodexPluginSkills.ts) / [CursorPluginSkills.ts](src/install/CursorPluginSkills.ts) via [PluginSkillText.ts](src/install/PluginSkillText.ts)), and [TelemetryCommandHook.ts](src/core/TelemetryCommandHook.ts)'s `preAction` reads it, **deletes it from `process.env`** so children can't inherit the claim, and stamps it onto `command_invoked`.
- **Who set a commit in motion** ([78329fdbd]). `CommitTrigger = "agent" | "ui" | "terminal" | "unknown"` ([Types.ts](src/Types.ts)) is resolved by `resolveCommitOrigin` **in the hook's own process** ([PostCommitHook.ts](src/hooks/PostCommitHook.ts) / [PostRewriteHook.ts](src/hooks/PostRewriteHook.ts)) and stamped onto the queue entry (`CommitGitOperation.trigger` / `.agent`) — "the one process that knows", because the draining `QueueWorker` may be a chain-spawned survivor of an *earlier* commit carrying that commit's env and never has the committing TTY. The worker scopes each entry's stamp with `setTelemetryAgent(op.agent)` and reports the drain-level `queue_drained` trigger/agent only when every entry agrees (`uniform()`).
- **MCP tool-call attribution from the handshake** ([2e9cd833f]). [McpServer.ts](src/mcp/McpServer.ts) reads `server.getClientVersion()?.name` (the SDK's captured `initialize` `clientInfo.name`) **per call**, resolved through `resolveClientInfoAgent`, and stamps it on each `command_invoked{command:"mcp"}`. `oninitialized` logs unmapped names as the organic capture point for adding new ones.
- **Why the shared daemon must NOT infer from env** ([5b0207f9e]). The per-worktree `mcp-serve` (and `global-daemon`) is shared across hosts and its env is frozen at spawn from whichever proxy arrived first — so env inference would stamp e.g. `agent:"claude"` on a Cursor session's calls. [Cli.ts](src/Cli.ts) gates `bootstrapTelemetry({ inferAgentFromEnv: !isAgentInferenceExempt(argv) })`; the exempt list is the daemons + `ide-bridge-serve`, which instead attribute per-connection via the clientInfo handshake above. The in-process fallback (`serveMcpInProcess`, one server per session) *does* infer.

**The version watershed.** `AGENT_DIMENSION_SINCE_VERSION` ([TelemetryAgent.ts](src/core/TelemetryAgent.ts), `"0.99.14"`) is the first client version that emits `agent`, printed into the public [TELEMETRY.md](../TELEMETRY.md) so agent-sliced charts start there. It began as a *prediction* — while writing it, which release the dimension lands in is not knowable — and `TelemetryAgent.test.ts` guarded that prediction from going silently stale ([0569fb75b]). That prediction is now settled: the dimension shipped in 0.99.14, so the constant is a **historical fact** and the test pins it exactly (`toBe("0.99.14")`), plus asserts it never names a release newer than the one being built. It must never move again.

**Cross-worktree ownership is a *separate* ledger, not this dimension** ([94a90c150], [3a025c964]). `CommitGitOperation.executingSessionId` captures `CLAUDE_CODE_SESSION_ID` at enqueue ([AgentSessionEnv.ts](src/core/AgentSessionEnv.ts)); `backfillExecutingSessionOwnership` ([ClaudeOwnerScan.ts](src/core/ClaudeOwnerScan.ts), called from the worker when `claudeEnabled !== false`) synthesizes an owner edge from the session's own transcript, so a session running in worktree A that commits into worktree B still gets attributed even though B holds no cwd trace of it.

**The dashboard's per-agent breakdown is a THIRD, independent pipeline** — do not wire it to the telemetry `agent` above. The skill-usage / tool-usage splits read the local Source-of-Truth DB's `sessions.source` column ([DashboardQuery.ts](src/dashboard/DashboardQuery.ts): `GROUP BY … s.source`), populated by local transcript discovery ([DashboardCollector.ts](src/dashboard/DashboardCollector.ts) / [DbBackfill.ts](src/dashboard/DbBackfill.ts)), not from any telemetry event. The two systems happen to share the `TranscriptSource` vocabulary; they are not connected.

**Kotlin/IntelliJ:** the `agent` and `via` dimensions are deliberately **absent** from the Kotlin port (`intellij/.../core/telemetry/Telemetry.kt`). An IDE is not one of the hosts, `surface:"intellij"` already localizes the click, and all detection channels are CLI-side. `agent` rides inside `properties` (not the envelope), so the `TelemetryEvents.kt` / envelope lockstep is unaffected. If ever added, it must mirror `TELEMETRY_AGENTS` as a closed enum — never a pass-through or default.

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


## Detailed rationale (moved from AGENTS.md)

These are the full, measured versions of the terse rules in `AGENTS.md`. `AGENTS.md` keeps the enforceable one-liners; the why lives here.

### IDE hosts are adapters — full rules

- **IDE hosts are adapters: product rules live in `cli/src`, not in the host.** A rule is anything that answers *what the data means* — which registry rows are visible, what counts as an archive guard, whether removing a row also unlinks its backing file, what a commit claims. Those belong in `cli/src/core` and reach the hosts one way each: VS Code imports them in-process (it bundles `cli/src/**`), IntelliJ calls them over `jolli ide-bridge`. What stays host-side is presentation only — row layout, icons, dialogs, keyboard handling.

  **Why the asymmetry matters.** VS Code and the CLI share a language and a build, so a schema change breaks its compile. IntelliJ talks JSON over a pipe: Gson drops fields it does not know and writes null into ones it expects, so a Kotlin restatement of a CLI rule fails *silently* and stays wrong until a user reports it. Every drift found when the plan/note services were sunk had shipped this way — a "soft delete" that the CLI's normalizer turned into a hard delete, a delete predicate that unlinked a different set of files than VS Code's, a copy-on-add where VS Code referenced in place, a `PlanReference.editCount` the CLI has never written (rendered forever as "edited 0 times"), and a non-null `NoteEntry.branch` that would have thrown the first time the CLI stripped it.

  Concretely, for working-area context (plans / notes / references):
  - The rules live in [`cli/src/core/PlanService.ts`](src/core/PlanService.ts), [`cli/src/core/NoteService.ts`](src/core/NoteService.ts) and [`cli/src/core/references/ReferenceService.ts`](src/core/references/ReferenceService.ts). `vscode/src/core/{Plan,Note}Service.ts` are **re-export shims** — adding a function to a shim instead of the CLI module makes it invisible to IntelliJ and re-opens the drift.
  - IntelliJ reaches them through the `working-context` ide-bridge action ([`IdeBridgeCommand.ts`](src/commands/IdeBridgeCommand.ts)) via the [`WorkingContext`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/WorkingContext.kt) adapter. Do not reintroduce Kotlin-side registry mutation or filtering; `session-state`'s raw `plans-load` / `plans-save` pair is for callers that own a read-modify-write cycle, not a way around this.
  - Two CLI-owned visibility rules exist and are **not** interchangeable: `detectPlans` / `detectNotes` drive the browsable panel (a revived guard — a committed row whose file changed again — stays visible), while `active-for-commit` is the archive-selection set (only rows no commit has claimed). Pick the one that matches the question; never post-filter either result in the host.

  And for discarding working-tree changes — the same rule, learned the same way:
  - [`cli/src/core/FileDiscardService.ts`](src/core/FileDiscardService.ts) owns every index/worktree combination. Its six dispatch groups are `unmerged`, `renamed`, `added`, `untracked`, `staged-worktree`, `worktree-only` — a *copy* is not a group of its own (it rides inside `added`), and `classifyEntry` MUST test `unmerged` FIRST: `AA` and `AU` also carry an `A` in the index column, so any other order treats a conflict as a staged addition and deletes a file HEAD still has. VS Code imports it from `JolliMemoryBridge.discardFiles`; IntelliJ calls the top-level `discard-files` bridge action via the [`FileDiscarder`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/FileDiscarder.kt) adapter. Both used to carry their own copy, and the JVM one handled three of the six cases.
  - **Callers pass PATHS, never status codes.** The service resolves each path from one authoritative `git status`. That is not a convenience — it is what makes the drift structurally impossible. Every producer in IntelliJ collapses git's two porcelain columns to ONE character (`getChangedFiles` keeps the index column only when it is neither blank nor `?`), so untracked arrives as `"?"`, and a dispatch matching the raw `"??"` silently sent every untracked file to `git checkout HEAD -- <path>` — a command that cannot succeed for a path HEAD has never seen. Renames were worse than wrong: reverting one needs the original path, and `getChangedFiles` *discards* it while parsing, so no Kotlin dispatch could ever have been correct.
  - **Those paths are relative to the WORKTREE ROOT, and the host is what has to get that right.** The service anchors its own `cwd` with `rev-parse --show-toplevel` so its status lookup, its pathspecs and its `join`s agree — but it cannot re-anchor paths that arrived in a different space, and a path git has no entry for is answered `not-found` + `ok: true`, the silent success again. `git status --porcelain` emits root-relative paths wherever it runs, so a `git status` producer is right by construction; an IDE-native one is not. IntelliJ's `readChangesFromClm` relativizes ChangeListManager's absolute paths against [`WorktreeRoot.of`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/WorktreeRoot.kt), which is `GitOps.resolveWorktreeRoot`'s cached answer — **not `project.basePath`**, which is not the git root when the project is opened on one module of a monorepo. The same root is the cwd for the bridge call, the base of every `File(root, path)` join behind the VFS refresh, and (because a pathspec is resolved against the process cwd, unlike `git status` output) the cwd of the service's long-lived `GitOps`, which is why it is built at the resolved root rather than at basePath.
  - **A discard that fails must say so, and there are five ways to lose that.** Both hosts branch on `ok: false` per path — **never on whether `error` is non-empty**, since `error` is nullable on the wire and an empty-string test drops any failure that arrives without one. **`not-found` is the only action that is ALWAYS `ok: true`** — the one "nothing happened" answer that is a success. (`restored` / `unstaged-and-deleted` / `deleted` / `rename-reverted` pair with `ok: true` when they succeed and with `ok: false` when they were only attempted, which is why the pair is what a caller renders, never the action alone.) Every other "nothing happened" answer is a failure and must reach the user. (1) The behaviour this replaced swallowed a nonzero git exit AND `File.delete()`'s false return. (2) A failed **status read** must report `status-unavailable` on every requested path, never `not-found`: an empty status map otherwise makes every path look already-discarded, and `execGit` turns a missing `git` binary into `exitCode: 127` rather than throwing — a daemon spawned by a GUI-launched IDE gets a stripped PATH, so this is a real deployment. (3) `FileDiscarder` must synthesise one FAILED outcome per path when the bridge body is unparseable, does not have exactly one outcome per request, **or contains an outcome with a blank `action`** — the CLI always sets one, so an empty action means the body cannot be lined up against the request. Returning an empty list reads to every caller as "nothing failed". (4) A **blank path** is `invalid-path`, never `not-found`: every webview producer falls back to `''` when it cannot resolve the row element, and nothing has ever caught it — the host-side shape guard removed once the porcelain columns stopped being an input validated the two raw status COLUMNS as one-character strings, not the path, so a blank `relativePath` carrying valid columns passed it too. This is the first and only thing standing between a malformed message and a confirmed, irreversible click that does nothing. (5) The internal fallback for a path no group recorded is `unclassified`, not `not-found` — `not-found` is documented as "the state you asked for already holds", and spelling two opposite meanings with one string leaves `ok` as the only thing telling them apart.
  - **Paths reach git as `:(literal)` pathspecs, and that is NOT only a discard rule.** A bare path is matched as a GLOB — measured: with `a1.txt` modified, `git restore -- 'a[1].txt'` reverts `a1.txt`, leaves `a[1].txt` alone, and exits 0. That is an operation reporting success for a file it never touched while destroying a different file's edits. `git add` and `git rm --cached` glob identically, so the same wrapper is on `stageFiles` / `unstageFiles` / `stageUnmergedFiles` in [`JolliMemoryBridge.ts`](../vscode/src/JolliMemoryBridge.ts) and on `GitOps.stageFiles` / `unstageFiles` in IntelliJ. The helper is [`literalPathspec`](src/core/GitOps.ts) with a hand-kept Kotlin mirror in [`bridge/GitOps.kt`](../intellij/src/main/kotlin/ai/jolli/jollimemory/bridge/GitOps.kt). Apply it wherever a path came out of git (`status`, `diff --name-only`) or out of a UI row built from one — those are already exact filenames, so a glob match can only be wrong. Do NOT apply it to a caller-authored pattern: someone typing `src/*.ts` wants the glob. **The rule is not yet honoured everywhere — do not read it as an audit result.** Known unwrapped sites: the Memory Bank sync client [`cli/src/sync/GitClient.ts`](src/sync/GitClient.ts) (its `add` / `rm` / `reset` / `checkout --ours|--theirs` pathspecs), `JolliMemoryBridge.diffForSelection`, and `getWorkingTreeDiffStats` in [`GitOps.ts`](src/core/GitOps.ts) — the last two take the same file rows the staging capability wraps. Wrapping a site you touch is the fix; adding a new bare one is the regression.
  - After a discard, IntelliJ must `refreshIoFiles` the affected paths before re-reading the working tree — the CLI changed them behind the IDE's back, and `ChangeListManager` is built from the VFS, so the row otherwise survives its own successful discard. The 2 s poll does not rescue it: that poll short-circuits on an unchanged signature computed from the same stale `ChangeListManager`. Refresh every path in `DiscardOutcome.touchedPaths`, not just the clicked one — a rename revert also restores its **original** path, and the CLI reports it in `additionalPaths` precisely because the host cannot derive it. That field is **nullable in Kotlin** even though the CLI declares it optional-but-array — and the reason is worth getting right, because the obvious version of it is wrong in both directions.

    **What Gson does with an absent field depends on the CLASS, not on Gson.** Kotlin emits an extra no-arg constructor only when EVERY primary-constructor parameter has a default. Gson prefers that constructor when it exists, so all the Kotlin defaults really do run; with no such constructor it falls back to `Unsafe.allocateInstance` and NO default runs at all — every reference field lands on null, including one declared non-null, which then throws on first read with no compiler warning anywhere. Which regime a class is in is readable off its declaration: `DiscardOutcome`, `DiscardPreview`, `Manifest` and `SummaryIndex` give EVERY primary-constructor parameter a default, so they get the constructor (`FileDiscarderTest` asserts its existence rather than trusting the reading); `PlanEntry`, `NoteEntry`, `ReferenceEntry`, `CommitSummary`, `ManifestEntry` and `SummaryIndexEntry` each have at least one parameter without one, so they do not. So the `Types.kt` rule above holds for exactly the reason it states, while `DiscardOutcome` is the opposite case — an omitted `relativePath` there arrives as `""`, not null. Declaring an omitted field **nullable** is the one choice that is correct under both regimes, and it stays correct when someone adds a parameter without a default and silently flips the class from one to the other — which is the failure that test exists to catch. Do not "simplify" a nullable mirror field to a non-null one with a default.
  - **IntelliJ must flush the editor's unsaved edits for the clicked path BEFORE calling the service** ([`UnsavedEdits`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/UnsavedEdits.kt), on the EDT, right after the confirmation). The FILES list is built from `ChangeListManager`, which deliberately reports a file as changed while its edits live only in the editor's document; the CLI resolves every path against `git status`, which cannot see those. Without the flush that row's Discard comes back `not-found` + `ok: true` — "the state you asked for already holds" — so the user confirms an irreversible action and nothing happens, with nothing shown anywhere. Flush ONLY the requested paths: `saveAllDocuments()` is one line and writes every other unsaved editor in the project to disk as a side effect of discarding one file. VS Code needs no equivalent — its list comes from `git status` in the first place.
  - **One path can produce TWO status rows, and the map must not be last-write-wins.** `git status` is not one row per path: `git rm --cached foo.txt` leaves a staged deletion in the index while the file stays on disk, and the index diff and the untracked scan then report it independently — `D  foo.txt\0?? foo.txt\0` (measured). A plain `entries.set` let the `??` row win, so the path was classified untracked and the discard **deleted the worktree copy while leaving the staged deletion in the index**, answering `ok: true` with the row still on screen (only half of it had been resolved). The tracked row is the right answer — `restore --staged --worktree` restores both and leaves a clean tree — and it is also what VS Code did before the rule moved here, because it dispatched on the clicked row's own columns. `readStatus` therefore resolves this by **precedence, not arrival order**: an untracked row never displaces an entry that already exists, and nothing else can collide (a tracked path has exactly one index state and one worktree state). Do not "simplify" that back to keep-the-first — git emits index rows ahead of untracked ones today, but that ordering is not part of the porcelain contract, and this is the failure mode the whole module exists to remove. This is the cost of centralizing: the service must absorb the porcelain facts the hosts used to sidestep by carrying a per-row status.
  - **The confirmation's wording is a CLI query, not a status letter — `previewDiscard` is the answer.** `discardDeletesFile` (Kotlin `GitStatusCodes`) and its VS Code twin survive only as the **fallback** for when the query itself fails; nothing else may decide the verb. The collapsed one-letter status both hosts carry is lossy in exactly the cases that matter: a staged deletion (`D `, which discard RESTORES) and the conflicts `DU` / `DD` (whose file it REMOVES) all arrive as `"D"`, and `UU` / `UD` (restored) and `UA` (removed) all arrive as `"U"`. So the prompt promised "discard all changes to X" and the button deleted X — the same lie the `R`/`C` bug told, one shape further along. IntelliJ cannot fix this host-side under any spelling: the FILES rows come from `ChangeListManager`, whose `Change.Type` has no conflicted case, so the raw columns are not even recoverable there. `previewDiscard` shares `classifyEntry` with `discardFiles` — extracted precisely so the sentence and the behaviour cannot drift — and asks git per path whether HEAD has a version, for the same reason the discard does (`UA` shows a `U` in the index column while HEAD has nothing). It is **read-only**, which is what lets it run before the user has confirmed: VS Code calls it in-process, IntelliJ over the `discard-preview` bridge action, which is why `ChangesPanel.discardFile` now opens its dialog from a pooled-thread callback instead of straight off the EDT. **The two ways it can fail are not interchangeable.** An answer that came back unusable yields the MILDER verb, silently and without raising: `previewDiscard` reports `deletesFile: false` for a failed status read, a blank path and a clean path (nothing has been deleted, and the discard itself then reports the real reason), and `FileDiscarder.preview` returns an EMPTY set for a body it parsed but cannot line up against the request. None of those enters the caller's catch, so no letter fallback happens. The letter heuristic fires ONLY when the query itself throws — a transport or parse failure, a host process that is down, a missing runtime — which is wrong only for a conflicted row and strictly better than refusing to open the dialog over a wording detail.
  - **The `R`/`C` half of that wording rule, which is what the fallback still encodes.** It must cover untracked, index-added, **renamed and copied**: reverting a rename deletes the NEW path (the content returns under the original name) and reverting a copy deletes the copy. Both hosts had already shipped this wrong in opposite directions — VS Code omitted `C`, IntelliJ omitted both `R` and `C` — telling the user the file stays while the button removes it. **`C` is real, and a comment in `Extension.ts` used to claim otherwise** ("`git status --porcelain` never emits a `C` status"): with `status.renames=copies`, status emits `C  ORIG -> NEW` for a copy whose source was modified in the same change set. That claim had also left `C` out of `openFileChange`, so a copy was diffed against a HEAD blob that does not exist. Two shapes to keep straight when writing a test: plain porcelain prints `C  ORIG -> NEW`, while the `-z` stream the service parses **reverses the pair** — new path first, original as its own NUL-separated segment.

  **Performance is not a reason to re-implement.** The bridge has been daemon-backed since [`CliDaemonClient`](../intellij/src/main/kotlin/ai/jolli/jollimemory/bridge/CliDaemonClient.kt): a call is ~5-20 ms against a long-lived Node process, comfortably under IntelliJ's 300 ms slow-EDT floor. The ~500 ms-2 s figure that motivated earlier Kotlin ports was the cost of a *cold one-shot spawn*, which is now only the fallback when no daemon is bound.

  **A missing bridge operation is the OTHER way this rule gets broken.** The asymmetry cuts both ways: VS Code gets every helper in `cli/src` for free by importing it, so a capability that was never given a `working-context` operation is silently "VS Code only" — no compile error, no failing test, just a JVM host that cannot do the thing. Mid-session plan discovery shipped that way for a year. `registerNewPlan` / `isPlanFromCurrentProject` existed in the CLI and were reachable only from [`PlansStore.ts`](../vscode/src/stores/PlansStore.ts)'s plans-dir watcher, so VS Code registered a new plan the instant Claude Code wrote the file while IntelliJ had to wait for the StopHook at the END of the agent's turn. The fix was one bridge operation (`plans-register-new`) and two watch targets — not a line of Kotlin logic. **When adding a capability VS Code reaches by import, ask what the JVM host calls to get it**; if the answer is "nothing", that is the bug, and the fix belongs in [`IdeBridgeCommand.ts`](src/commands/IdeBridgeCommand.ts), never in Kotlin.

### The `local-agent` provider — full rules

- **The `local-agent` provider drives one of six CLIs**, selected by `localAgentTool` (`claude-code` | `codex` | `cursor-agent` | `opencode` | `kimi` | `hermes`, defaulting to the first). Two asymmetries bite: only `claude-code` is capability-probed with the real run flags; and `opencode` deliberately keeps provider credentials in the child environment, so it spends the user's own provider credit and has no auth-failure classification at all. **The model is pinned PER TOOL, and only for a tool that declares one — `claude-code` and `codex` today.** `LOCAL_AGENT_TOOLS[…].models` in [`ToolMeta.ts`](src/core/localagent/ToolMeta.ts) is the whole switch: `resolveLocalAgentModel` returns `""` for every tool without a list, `""` means "emit no model flag", so the other four keep deferring to their own configuration exactly as before. Do NOT hard-code a tool id in a surface: the dashboard card gates on `localAgentToolModels(id).length`, the VS Code panel tags each option with its tool and counts them client-side, and `configure --set` validates against the flat `ALL_LOCAL_AGENT_MODEL_IDS` union and derives its per-tool help text from the registry. Pinning a third tool is a change to that one table **plus** a refusal classification in its backend — see the degradation rule below, which is what the table alone cannot give it.

  **The default is a property of the TOOL (`defaultModel`, read via `localAgentToolDefaultModel`), never one global constant, and re-collapsing it is a review blocker.** `DEFAULT_LOCAL_AGENT_MODEL` is claude-code's default specifically. It used to be what an unrecognised value fell back to for every tool, which is correct only while one tool is pinned: model ids are each CLI's own namespace and two pinned tools share none, so a `sonnet` stored under claude-code and carried into codex — one field, shared — emitted `-m sonnet` at a CLI that answers it with a 400. `pickLocalAgentModel` is the single core the display helper and the runner both use, so they cannot drift on that fallback. Both panels mark the default from that field (`isDefault` / `data-default`) and both client scripts already read the marker rather than position, so a list may order itself however it likes — and every pinned list deliberately puts its default in the MIDDLE so nothing can infer it from position. One consequence is easy to miss: every pinned tool offers `inherit`, so the VS Code document really does carry several `<option value="inherit">` differing only in `data-tool`, and assigning `select.value` picks the FIRST by spec — a codex user with `inherit` stored had the row load reading "Use Claude Code's own setting". `syncLocalAgentModelRow` therefore selects by INDEX among the current tool's options; the submitted value is right either way, which is exactly why nothing downstream can catch it.

  **Both Settings payloads carry the RAW stored model, and resolution for display is the CLIENT's job.** The panels submit what they were handed unless the user picks something, so a server-resolved value made the round trip destructive in three ways, all measured: opening Settings under codex rewrote a claude-code `opus` to codex's default; merely VISITING codex in the tool dropdown and switching back did the same, because the dashboard wrote its resolved display value into form state and the VS Code row submitted the select's own selection; and under cursor-agent / opencode / kimi it happened with no row on screen at all. So `SettingsPageQuery` / `SettingsWebviewPanel` send `config.localAgentModel` untouched, `settings.js` resolves for display WITHOUT writing back, and the webview keeps `storedLocalAgentModel` separate from the select's selection — the selection is presentation, re-pointed on every tool switch. `effectiveLocalAgentModel` was removed with them; the only resolver left is `resolveLocalAgentModel`, for the runner.

  **codex's ids are dated slugs, not aliases, and that difference drives the maintenance story.** claude's `sonnet` / `haiku` / `opus` track the latest of their family forever; codex has no equivalent (`gpt-5.6` merely aliases `gpt-5.6-sol`), so every codex id retires and the list needs a release when codex ships a generation. Fetching it instead was measured and rejected: `codex app-server`'s `model/list` is an undocumented private interface, costs ~2.2 s, and answers with a built-in fallback list — wrong in BOTH directions, with no marker distinguishing it — whenever the CLI cannot parse the server's response (a codex a few versions behind listed two models it could not run and none of the three it could). Entitlement also drifts under a fixed client, measured: the same binary answered `400 requires a newer version of Codex` for `gpt-5.6-terra` and ran it 20 minutes later. So a fetched list is no more authoritative at call time than a written one — what makes either safe is the refusal classification below, not where the list came from. The list deliberately omits `gpt-5.4` / `gpt-5.4-mini`, which retire 2026-08-31.

  Leaving it unpinned was tried and reverted, and the reason is not cost alone: it does not mean "the user chose", it means a background, mechanical workload silently rides whatever model the developer picked for INTERACTIVE work. Measured on one machine, every generation ran `claude-opus-5[1m]` — the most expensive model at its most expensive context tier — so a 418-token routing decision cost $0.08 and one session consumed ~73% of a five-hour window, while the same work cost a different amount on the next machine for a reason unrelated to this tool. The default is each tool's own mid-tier option (`sonnet` for claude-code, `gpt-5.6-terra` for codex), overridable per machine by `localAgentModel`, with `"inherit"` keeping the old behaviour as an EXPLICIT choice. Note `localAgentModel` is a different field from `model` and must stay that way: `model` names an Anthropic API model id for the direct/proxy providers, this one names an alias in a local CLI's namespace, so `jolli configure --set model=…` and `PlanProgressEvaluator`'s deliberate `haiku` still do not reach this provider.

  Three details are each load-bearing and each measured on claude 2.1.212. **Ids are the CLI's own aliases, never `resolveModelId`'s output** — both are accepted, but an alias tracks the latest of its family (so it does not 404 when a dated model retires) and cannot select the `[1m]` SKU. **A refused model is handled by ONE un-pinned retry in `callLocalAgent`, and deliberately NOT by the optional-flag machinery** — that was tried and is a trap. The degradation loop only sees failures `run()` REJECTS with, while a refused model exits 1 having written `{"is_error":true,"api_error_status":404,…}` to **stdout**, which `LocalAgentRunner` resolves on purpose so the backend can classify it; the `LocalAgentSetupError` therefore surfaces in `parseResult`, downstream of the loop. So a `{id:"--model"}` entry is inert for the case it exists for and live for every case it does not — any unattributed setup error would silently drop the pin and then warn that "the tool did not run the requested model" about a request we withdrew. The retry is not persisted (an entitlement can be granted later) and fires only on `LocalAgentSetupError` with a model actually pinned. The realistic trigger is entitlement, not corruption: the picker offers Opus and a subscription without it answers 404 for every call, so the retry is what keeps that machine generating at all.

  **Every pinned tool must classify its own refusal, or that retry never fires for it.** The un-pin retry keys on `LocalAgentModelRefusedError` alone (narrowed on purpose — see above), so a backend that reports a refusal as anything else takes the machine down non-retryably while re-running the same doomed model. codex's classifier is worth copying because it is STRUCTURAL rather than phrase-based: codex reports its own conditions as prose (`Your workspace is out of credits.`) and anything the API refused as a **JSON envelope serialised into the same `message` field**, carrying an HTTP status — so parsing, not wording, tells the two apart. A refusal is then a 4xx whose message QUOTES the model we pinned; the quoted id is the discriminator, which is why 401/403 and 429/5xx are classified off that same envelope and return AHEAD of the range check (a server fault naming a model must not read as a refusal and hide behind a retry). Requiring `requestedModel` means an un-pinned run can never be classified this way — there is nothing to withdraw. Measured phrasings, neither of which is a contract: `The '<id>' model is not supported when using Codex with a ChatGPT account` and `The '<id>' model requires a newer version of Codex`. Throwing `LocalAgentModelRefusedError` out of `parseResult` is safe despite it extending `LocalAgentSetupError` **only** because `LlmClient` calls `parseResult` after `runWithFlagDegradation` has returned; thrown from anywhere inside the ladder it would strip an isolation flag instead. **And `modelUsage` is NOT single-entry**: claude runs a small helper turn of its own that cannot be switched off, so `pickModel` takes the requested alias and prefers the entry naming it, falling back to highest TOTAL INPUT (not output) when nothing was requested — the helper out-produced the answer on a short run and made a sonnet call report as haiku. That value feeds `LlmClient`'s requested-vs-actual warning, so a heuristic that picks the helper turn would false-alarm on every short-output action.

  Stored metadata is still not allowed to guess: `LocalAgentOutcome.model` carries the model a backend can prove it ran (only `claude-code` can, via `modelUsage`) and `LlmClient` prefers it over the pinned value. codex is pinned but reports nothing, so its recorded model is the id we REQUESTED, not one observed — the requested-vs-actual warning is simply skipped there, and a codex that learns to report its model should populate the field rather than leaving the pin to stand in. A backend that learns to report its model must populate that field rather than leaving an alias to stand in.

  **Isolation flags are optional by construction — never add one unconditionally.** An agent CLI that does not recognise a flag does not ignore it: it exits non-zero *before running*, so one flag missing from an older install turns into "every summary on this machine fails", non-retryably. No probe can prevent this, and **an isolation flag must never be added to a resolver's `probeArgs`**: `claude` pre-scans argv for `--version` before validating options, so `claude --permission-mode dontAsk --bogus-flag --version` exits 0 (measured) and the probe cannot validate the flag anyway — while an older CLI that *does* validate first would fail the probe, and a failed probe has no recovery path at all (the candidate is discarded, discovery reports "no compatible CLI found", and the degradation below never runs because it lives downstream of discovery). `probeArgs` therefore carries only flags that are load-bearing for a run. So each such flag is declared in the backend's `optionalFlags` ([`OptionalFlags.ts`](src/core/localagent/OptionalFlags.ts)), `LlmClient` drops it on a `LocalAgentSetupError` and retries, and the result is recorded in `~/.jolli/jollimemory/agent-unsupported-flags.json` keyed by `<tool>@<version>` — version-scoped, so upgrading the CLI re-enables every flag and ages out a wrong entry. That guarantee depends on `extractProbeVersion` finding a real version: codex prints `codex-cli 0.146.0-alpha.3`, and taking the first token blindly (as the resolver used to) collapsed every codex build to the literal `codex-cli`, which both made `isNewer` compare them equal and made this store unable to expire an entry on upgrade. Check a new tool's real `--version` output when adding one. Three rules make this safe and must not be relaxed: **nothing is persisted until a degraded run actually succeeds** — stderr attribution only picks what to drop first, so a wrong guess costs one attempt and is never written down; **a success is only recorded for flags the CLI actually named**, because success on its own is a weaker signal than it looks (an argv-unrelated `LocalAgentSetupError` — a crash, a bad TMPDIR — also degrades wholesale, and if the flake has passed by the retry, that retry succeeds and would otherwise write off every isolation flag for that tool version permanently and invisibly, at ~48x the prompt cost); and **only `LocalAgentSetupError` degrades**, since auth/transient failures are not about argv. The middle rule needs one opt-out, `LocalAgentBackend.unnamedFlagFailures`, held today by `opencode` alone: it can never name a flag, so blind evidence is the only evidence it will ever produce, and without the opt-out it would burn one failed spawn on every call forever. Do not set it on a CLI that does name its flags — there an unattributed failure is evidence the problem was never argv. That design is forced by the CLIs disagreeing completely on how they report an unknown flag, all measured: claude/commander `error: unknown option '--x'` (exit 1); codex/clap `error: unexpected argument '--x' found` (exit 2), plus a *second* codex shape when the flag exists but the feature does not, `Error: Unknown feature flag: plugins` (exit 1), which never writes the flag name at all and needs an explicit `matches` phrase; and opencode/yargs, which prints its entire help and names nothing — its help is longer than the runner's 2 KB stderr tail, so even `Positionals:` is truncated before attribution sees it, and it can only be handled by the wholesale drop. Adding a flag to a backend means adding it to `optionalFlags` too, unless it is genuinely load-bearing (an env var is exempt — an unrecognised one is ignored, so it cannot fail a run).

  **A local-agent run that produces no answer MUST throw — returning `""` is a data-loss bug, not a quiet no-op.** The exit code cannot be the signal: `LocalAgentRunner` deliberately resolves a nonzero exit that still wrote stdout, because that is where an auth failure's detail lives, so recognising a failed run is entirely `parseResult`'s job. Codex's exhausted-workspace failure got past every check and shipped silently. The stream stays well-formed JSONL — `error` then `turn.failed` after `turn.started`, exit 1, stderr only `Reading additional input from stdin...` (real capture: [`__fixtures__/codex/out-of-credits.json`](src/core/localagent/__fixtures__/codex/out-of-credits.json)) — so the "no JSONL events" setup guard never fired, and `Your workspace is out of credits.` names no login word, so the auth regex did not either. `parseResult` returned `text:""`, the summarizer read 0 topics from 0 chars, and **Regenerate overwrote a good stored summary with an empty one** while the post-commit line printed `✓ Jolli Memory updated`. Two defences now, both load-bearing: a backend throws on its own failure envelope, and `LlmClient` rejects an empty completion from ANY tool after `parseResult`, so the next CLI's undiscovered failure shape cannot reach storage without a backend change. Neither may throw `LocalAgentSetupError`: that is the one class that triggers flag degradation, and a run-time failure is not about argv. Codex classifies on the EVENT's reason — never on the assistant text, which routinely contains the word "error" — and splits the two event shapes by how *definitive* they are: `turn.failed` (reason under `error.message`) is codex declaring the turn over, so it throws on sight, while an `error`-typed event (reason in `message`) is only a **candidate** reason, held and thrown at end of stream only if no assistant text arrived. Do not re-collapse those into one throw-on-sight branch: codex emits `error` events for conditions it can recover from, the real failing stream carries a `turn.failed` anyway, and a recovered run would otherwise become a hard failure while protecting nothing extra. The reason is then carried to the user on `CaptureEventData.llmFailure`, because the stored summary keeps only a `SummaryErrorKind` and no message — without it the commit output has nothing to print but the generic success line. That string is a CLI's own stderr tail, so `CaptureProgress` strips ANSI/control sequences out of it before printing; colour codes in it are the normal case, not an exotic one.

  **`hermes` is the sixth backend and the only one whose accounting arrives BESIDE stdout.** `-z/--oneshot` prints only the final response (its own help states it), so `parseResult` has no envelope to unwrap; `--usage-file` writes real tokens, cost and the model it RAN to a path only `buildInvocation` knows, which is why `parseResult` gained an optional `cwd` third parameter — an absent report is "no accounting", never a failed run. Isolation is `--ignore-rules` and NEVER `--safe-mode`: the latter *implies* `--ignore-user-config`, and a Hermes user's provider — including the API key of a `custom_providers` entry — lives in that config, so it would take their credentials with it (the same trap `--ignore-user-config` set for codex). **argv is the ONLY prompt channel, measured rather than assumed**: there is no `--prompt-file` and no stdin path, and BOTH file-shaped alternatives are far too small for the ~400 KB worst-case `summarize` prompt — `read_file` truncates at `_DEFAULT_MAX_READ_CHARS = 100_000` and an auto-injected `AGENTS.md` at `CONTEXT_FILE_MAX_CHARS = 20_000`. Either would deliver a fraction of the prompt and produce a confident, incomplete summary, which is worse than the argv limit because the argv limit fails loudly. The lossless ceiling is platform-specific: win32 keeps 24 KB below `CreateProcess`'s whole-command-line limit, Linux keeps 8 KiB below its usual 128-KiB per-string `MAX_ARG_STRLEN`, and Darwin allows 512 KiB — enough for the worst-case prompt while retaining roughly half of its measured 1-MiB `ARG_MAX` for environment and argv overhead. It is deliberately UNPINNED (no `models` list): Hermes model ids are `provider/model` pairs over a provider set the user defines, so any list shipped here would be a 400 on somebody's machine. One shared fix fell out of it — `versionRank` did not strip the leading `v` that `extractProbeVersion` deliberately accepts, so `v1.0.0` ranked BELOW `v0.20.5` and the older binary won the newest-capable race; Hermes is the first shipped tool to print that prefix.

  Isolating a child run from the user's own setup is per-tool and each lever was measured, because the plausible-looking ones are traps: `claude-code` takes `--strict-mcp-config --disable-slash-commands --setting-sources ""` (~48x fewer prompt tokens; **not** `--bare`, which also disables the keychain OAuth this backend depends on); `codex` takes `--disable plugins` (**not** `-c plugins={}` / `-c mcp_servers={}`, which are accepted and do nothing — `-c` is a merging dotted-path set, so an empty inline table is a no-op — and **not** `--ignore-user-config`, which works but takes the user's `model` with it); `opencode` takes `OPENCODE_DISABLE_CLAUDE_CODE=1` plus `--pure`. Neither `codex` nor `opencode` can drop MCP servers without also dropping the user's model choice, so on those two the servers stay booted deliberately. Verify such a flag against the tool's own authoritative state output (`RUST_LOG=info` stderr for codex prints `mcp_servers="…"` and `plugins_enabled=`), never against an incidental side effect like an error line that happened to disappear. `kimi` (Moonshot's Kimi Code CLI, `@kimi-code/cli`) is a first-party subscription tool like Claude/Codex/Cursor — it scrubs `MOONSHOT_API_KEY` to force the `kimi login` subscription path, and runs `kimi --output-format stream-json --prompt <text>` (the `-p` one-shot non-interactive mode — **not** `--quiet`/`--print`/`run`, which belong to the unrelated `moonshotai/kimi-cli` product). It uses `stream-json` deliberately: the default `text` output bullets the model's reasoning and appends a `To resume this session:` trailer, so `parseResult` instead reads the `{"role":"assistant","content":…}` JSONL line (ignoring the `{"role":"meta",…}` resume hint), Codex-style. Like `opencode` it reports no token/cost accounting and surfaces "not signed in / no model configured" as a generic setup error. **Prompt delivery is size-adaptive — kimi is no longer bound by the argv limit the other three carry.** kimi-code exposes no stdin (`-p -` is a literal prompt) and no `--prompt-file`, so a small prompt is the `--prompt` argv value like the others; but the ~400 KB `summarize` prompt would blow the Windows ~32 KB `CreateProcess` limit (`spawn ENAMETOOLONG`) — which silently failed the summary while the short `commit-message` succeeded — so above a 24 KB budget (`KIMI_ARGV_PROMPT_BUDGET`) `buildInvocation` writes the body to `<cwd>/jolli-context.md` and passes it via `--agent-file`, keeping only a short directive in `--prompt`. `--agent-file` is a Markdown **agent definition** (REQUIRES YAML frontmatter — a bodyless file is rejected "Missing frontmatter") and, verified against kimi 0.34.0, injects the whole file into context with no 50 KB tool-output cap, carrying 600 KB+ comfortably; the body is truncated to a 1 MB backstop. `codex`/`cursor`/`opencode` still carry the latent argv limit (deferred — see [`ContextRelevance.ts`](src/core/ContextRelevance.ts)); only `claude-code` streams the prompt over stdin. It intentionally ships without a Windows `expandShim`: the recommended standalone installer drops a native `kimi` on PATH, so only npm-on-Windows installs (cmd-shims) go undiscovered until a real `where kimi` capture pins the `@kimi-code/cli` bin layout. **The IntelliJ Settings picker now carries a hand-maintained Kotlin mirror of this list** — [`LocalAgentTools.DEFAULT_TOOLS`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/LocalAgentTools.kt) — used as the always-shown baseline (the `ide-bridge local-agent-tools` fetch is only an override, and any bridge failure previously collapsed the picker to Claude-only, unlike VS Code which bundles the list statically). Adding, removing, or relabelling a tool in `LOCAL_AGENT_TOOLS` MUST update `DEFAULT_TOOLS` in the same change — `LocalAgentToolsTest` pins it. When the bridge is reachable it stays authoritative, so drift only affects fully-offline IntelliJ runs.


### A dashboard migration — full rules

- **A dashboard migration is NEVER edited once committed, every entry must survive being run twice, and the database has no schema version number at all.** `MIGRATIONS` in [`cli/src/dashboard/DashboardDb.ts`](src/dashboard/DashboardDb.ts) is keyed by `name`, applied in array order, and the database records what it applied in `schema_migrations` (one row per touch: `applied` / `failed` / `skipped` / `baseline`). Four rules, and the first is the one the others exist to support.

  **① An entry freezes the moment it leaves your machine — when the PR goes up — and is never edited after that.** Ship a new entry for any delta. **Release is NOT the line, and neither is "unreleased" a licence**: once the branch is pushed, other developers pull it and their databases apply it, so the entry has already reached machines you cannot repair. `SESSION_STATS_SYNC_DDL` is the case in point — it was on `main` when it was edited in place, four days before any release contained it, which is exactly why "it hasn't shipped yet" reasoned its way into the bug.

  **Before that line the migration is yours and the product must not carry the repair.** A schema you are still iterating on means your own dashboard database is out of step; fix it by hand (`sqlite3` the log row out and reopen, or delete the file — it is one machine's derived state), and amend the entry. Do NOT give one name two versions and do NOT append a heal entry to fix your own laptop: a heal entry is permanent and ships to every user. A `2026-08-19-0000-session-stats-heal` entry existed for exactly one week and was removed — measured, it did nothing on a fresh install AND nothing on a 0.99.13 upgrade, because the entry it "healed" (`SESSION_STATS_SYNC_DDL`) has never been in a release, so no user database has ever carried that name. Its only possible beneficiary was a developer who had pulled `main`. **Two entries must never share a body** — `MigrationFingerprints.test.ts` compares `run` by identity and fails on it — because one delta is one script, and a second name pointing at the same function just runs it twice on every database that has neither.

  This is not style: `SESSION_STATS_SYNC_DDL` was edited in place across branches after merging, and databases that had logged the name under the older SQL skipped the newer SQL for ever — ending up with no `stats_daily` and no `commits.written_at_ms` while their log said the migration had run (`no such table: stats_daily` in `DbBackfill` and `DashboardServer`, `table commits has no column named written_at_ms` in `StatsWriter`). The log is keyed by name; it cannot notice that the bytes moved. Renaming is the same defect from the other side: every database reads the new name as never applied and re-runs it. So names may be added, never changed or removed. `MigrationFingerprints.test.ts` pins the names in order and SHA-pins the body of every entry carrying `sql`. **That CI check is the only content check there is: the RUNTIME byte-compare is gone, and re-adding one is a review blocker.** It warned when a logged `ddl` differed from this build's, which cannot distinguish this project's own equivalent rewrite from a foreign build — and making every entry re-runnable rewrote six shipped entries and turned two more into code entries, so measured against 0.99.13 it would have fired for **six of its seven entries on every existing install**, for a change that altered nothing. A warning that fires for everyone is not a signal. The alternative considered was a per-entry list of accepted historical hashes; it was rejected because those hashes cannot exist for a body that has not shipped yet, making it a hand-kept ledger that only ever grows. What survives is `verifyMigrationLog`'s unknown-NAME warning (`jolli doctor --schema-log` lists it), which answers the same question — "has a build I do not know written here?" — from names, and so cannot be wrong about our own edits. The one case names miss is the same name carrying different bytes: inside this repo CI already makes that impossible, and across branches it is a developer's own machine. `ddl` is still STORED, so the bytes can be read out with `sqlite3` when a real question arises; nothing compares them automatically.

  **② Every entry must be re-runnable, and that is what makes the rest safe.** `CREATE TABLE/INDEX/TRIGGER` always `IF NOT EXISTS`; `INSERT` always `OR IGNORE`; `UPDATE` always with a self-excluding `WHERE` (`… IS NULL`, `… = 0`); nothing that depends on how many times it ran. **Add-column steps cannot be expressed re-runnably in SQL** — SQLite has no `ADD COLUMN IF NOT EXISTS` and no conditional in DDL — so they go through `addColumnIfMissing`, which makes their entry a **code entry** (`{name, run}` with no `sql`). `sqlMigration(name, sql)` is the wrapper for everything else. Enforced by a test that runs every entry twice and asserts the schema and row counts are unchanged, which is the only guard that also covers entries nobody has written yet. Note `addColumnIfMissing` cannot restore a lost `NOT NULL` (no `ALTER COLUMN`) and does not need to — pair it with the null backfill, as `applySessionStatsSchema` does.

  **③ A code entry has no fingerprint, so it must have a companion test.** The log stores `sql ?? ""`, so a code entry compares equal to itself for ever and is invisible to the drift check. `MigrationFingerprints.test.ts` therefore requires every `sql`-less entry to be named in some `migrations/*.test.ts` file, and those companions must assert **each object the entry creates** rather than "it did not throw" — a missing object is precisely the failure they exist to catch. `jolli doctor --schema-log` marks them `[code]`, and `--mark-migration` warns that marking one skips it permanently, including gaps it would have filled.

  **④ There is no schema version number, and re-adding one is a review blocker.** `DASHBOARD_SCHEMA_VERSION`, the `schema_version` write, the format-ahead warning and `isSchemaCurrent`'s version fallback were all removed. A hand-maintained integer that had to equal `MIGRATIONS.length` made two branches appending one migration each collide on a number neither cared about, and it invited comparisons that look like compatibility checks but are not: the number moves only with DDL, so it misses a change that corrupts data (a new required field inside `summary_json`) while blocking additive upgrades that are harmless. What replaced it: "has a newer build written here?" → `verifyMigrationLog`'s unknown-name warning, which names the migration and the surface; "should the derived rollup cache be maintained?" → `dbHasUnknownMigrations`; "is the schema current?" → `isSchemaCurrent`, from the log alone. **`readSchemaVersion` is now gone too, and nothing reads the `schema_version` key at all.** It survived for one job — a database predating the log table has nothing else to say what ran, so its leftover stamp seeded `baseline` rows for entries `0..stamp-1`, which were then SKIPPED. That job was retired because its premise was false: the named entries and the log table shipped in the SAME release (0.99.12), so any database carrying a stamp was built by the earlier NUMBERED list, whose position N is not this list's entry N. The mapping could only be a guess, and a wrong guess skips an entry — arriving as `no such table` on a machine nobody can inspect. `migrateDashboardDb` now REPLAYS every entry on such a database, which rule ② makes safe and which `DashboardDb.test.ts` pins three ways (every entry recorded `applied` with no `baseline` row; a stamp ignored whether plausible or garbage; and a gap a stamp claimed was applied getting filled). The `baseline` outcome stays in `MigrationOutcome` and is still READ as done — 0.99.12/0.99.13 wrote those rows and demoting them would replay their entries on every open for ever — but nothing writes it. Two floor keys (`min_compatible_version`, `min_compatible_release`) and a `Migration.breaking` flag were also implemented and removed. **Nothing refuses a database** — not `withDashboardDb`, `withRepairDashboardDb`, `CutoverRouter` or `ImportState`. A `readSchemaVersion(db) > slot` fence inside the write lock had already been removed for the same reason: it read like version machinery but guarded a concurrency case (a racing writer replaying an entry on a pre-log database), and rule ② makes that replay a no-op.

  `jolli doctor --mark-migration <name>` remains for the state a name key cannot fix alone — the log lost a row while the objects that entry created are still there — which is also why `withRepairDashboardDb` must never migrate. Deleting the database is never the answer (memories rebuild from git; session usage and recall receipts have no second copy). **The one-time exception already spent:** making every statement re-runnable edited the bytes of already-released entries. It was allowed because it is semantically identical on an empty database, and it is why `BASELINE_DDL`, `RECALL_RECEIPTS_DDL`, `SKILL_CONTEXT_KIND_DDL`, `SCHEMA_MIGRATIONS_DDL`, `SESSION_ACTIVITY_DDL` and `SKILL_INVOCATIONS_DDL` would report as drifted on existing installs had the runtime byte-compare survived — correctly, their stored bytes really are the older ones, which is now visible only by reading `schema_migrations.ddl` with `sqlite3`, since nothing compares it automatically any more. **The pass covers every entry that existed before it landed, which is ONE pass and not a precedent** — the last two arrived on `main` while it was in flight on a branch, so they are the same pre-idempotency population reached through a merge rather than a second exception. Rule ① applies to anything committed after it, with no further exceptions. **Do not reach for a code entry to dodge this report:** the log stores `sql ?? ""`, so an entry that had SQL when a database applied it keeps that old text on record in its own `schema_migrations.ddl` regardless of what the current entry looks like — nothing compares it automatically any more, but a code entry cannot undo that history either, and it gives up the byte-exact CI fingerprint and buys nothing, which is why only the add-column entries (`EVENT_FAILED_KIND_DDL`, `TOOL_CALL_TIME_DDL`, `SESSION_STATS_SYNC_DDL`, `SKILL_TOKEN_USAGE_DDL`, `SKILL_PLUGIN_DDL`, `SKILL_ORIGIN_ROOT_DDL`) are ones. See "How to add a dashboard migration" below.


### The Node floor & plugin skill generators — full rules

- **The Node ≥ 22.13 floor is a five-place lockstep.** `node:sqlite` exists from 22.5 but throws on import until **22.13** unless given `--experimental-sqlite` — and two surfaces can never supply that flag: the VS Code extension host (Electron launches it) and the git-hook dispatchers (`exec node <Hook>.js`, deliberately flag-free so an old Node cannot die on an unknown option *before running any code*). Since `QueueWorker`/`StopHook` now write the dashboard DB, every surface that can *provide or resolve* a runtime must agree on the same floor, or a hook write throws on whichever surface lags: `cli/package.json` `engines.node`, [`SqliteHelpers.ts`](src/core/SqliteHelpers.ts) `NODE_SQLITE_MIN_VERSION`, `vscode/package.json` `engines.vscode` (^1.101.0 — the first release whose bundled Node crossed 22.13; 1.100.0 was still on Node 20.19) plus its esbuild `target`, [`NodeRuntime.kt`](../intellij/src/main/kotlin/ai/jolli/jollimemory/bridge/NodeRuntime.kt) `MIN_SUPPORTED_MAJOR`/`MIN_SUPPORTED_MINOR` (major.minor, not major alone), and the Claude plugin's [`build.mjs`](../claude-plugin/plugins/jolli/scripts/build.mjs) `target`. The hook write path still degrades gracefully below the floor (skip the write, never block git) — the floor is what makes the *normal* path work, not the only line of defense.

  **The Codex plugin inverts this trap.** Its skills are static files committed under `codex-plugin/plugins/jolli/skills/`, rendered from the same builders by `CODEX_PLUGIN_SKILLS` with the `metadata:` block stripped (a bundled copy is never upserted, and `version` is a build-time define that would either bake in a stale string or churn every release). So there is no revision to bump — instead, editing a body means **re-running the generator**, or the committed copy silently keeps the old text:

```bash
npx tsx codex-plugin/plugins/jolli/scripts/generate-skills.ts
```

  **The Cursor plugin inverts it the same way, with its own generator:**

```bash
npx tsx cursor-plugin/plugins/jolli/scripts/generate-skills.ts
```

  Four builders serve all three surfaces (`recall`, `search`, `local-run`, `remote-run`), so an edit there is an edit to **three** artifacts: bump the revision + fingerprint for the installed copy AND regenerate both bundled copies. `CodexPluginSkills.test.ts` / `CursorPluginSkills.test.ts` fail on drift, which is what forces the last two steps. Note the *Codex* copy is re-headed with a bare name and its sibling references rewritten to `jolli:<name>` — so never introduce a path-shaped `jolli-<name>` string (e.g. `.agents/skills/jolli-recall/SKILL.md`) into a shared builder: that rewrite is a plain substring replace and would corrupt it into `jolli:recall`. The Cursor copy needs neither step (its directories keep the canonical prefix), which is why its renderer is two transforms and Codex's is three; the two shared transforms live in [`PluginSkillText.ts`](src/install/PluginSkillText.ts).

  **A fifth shared body lives in that same module and is deliberately NOT one of the four: `buildDashboardSkillTemplate`.** Both plugin bundles commit a generated copy of it (`dashboard` on Codex, `jolli-dashboard` on Cursor — the two differ only in the frontmatter `name`, which each renderer rewrites), and no `jolli enable` writes it anywhere. That last part used to be what made it the ONE shared body the Cursor bundle could ship; now that bundle ships all five and accepts the duplicate, so what remains of the distinction is the maintenance arithmetic. Two consequences. It carries **no `metadata.revision`** and no pinned fingerprint — nothing upserts it, so there is nothing for the revision guard to arbitrate — which means an edit there is **two** artifacts (regenerate both bundles), not three. And the Claude plugin's `/jolli:dashboard` is a FOURTH, independent hand-written document (`claude-plugin/plugins/jolli/skills/dashboard/SKILL.md`), like every skill in that bundle: no generator, no drift test, so it has to be updated by hand in the same change.

  **`SHELL_PREREQUISITE_BLOCK` lives in that same module, and its trigger is shelling `run-cli` — not the here-doc.** It reads as here-doc guidance (it names the security recipe) and was originally attached only to the arg-carrying skills, but the rule it encodes is about the PATH: `run-cli` is an extensionless bash script written to `%USERPROFILE%\.jolli\jollimemory\run-cli`, and only Git Bash's `$HOME` points there. PowerShell defines `$HOME` too, so the path expands to something real and the failure is a plain "not recognized" rather than an obviously-unset variable — which is why `local-run` (fixed subcommands, no here-doc) carries it, and why the Cursor plugin's `jolli` / `jolli-init` / `jolli-login` / `jolli-logout` / `jolli-status` do. In an umbrella it is load-bearing beyond a failed command, because Step 0 reads a failed `test -f` as a verdict about the install: Cursor's says "Jolli is not installed on this machine" and offers to delete the menu, Codex's sends the user off to re-trust a SessionStart hook that was working. **Both bundles carry it** on the same six (`jolli`, `init`/`jolli-init`, `login`, `logout`, `status`, and the shared `dashboard`/`jolli-dashboard`); `timeline` and `push` are MCP-only and deliberately stay lean. Each bundle's drift test derives the requirement from the body rather than listing skill names, so one that grows a `run-cli` call later cannot slip past. It sits in `PluginSkillText.ts` for a structural reason — it is imported by `SkillInstaller` and by both plugin-skill modules, and it imports nothing itself, so no arrangement of those three can close a cycle. (The Cursor dependency now runs `CursorPluginSkills` → `SkillInstaller`, matching Codex; it was reversed when the Cursor umbrella's writer moved out of `SkillInstaller`, which is what let the bundle list pull in the shared builders — that writer is now `removeCursorGlobalMenu`, a one-way sweep of the retired machine-global copy.) Note the block must stay free of path-shaped `jolli-<name>` strings for the reason above: `renderCodexPluginSkill` runs its substring rewrite over it too, and `CodexPluginSkills.test.ts` pins that it comes through unchanged.


### The global daemon's trigger — full rules

- **The global daemon's trigger must never wait on the daemon's event loop, and a retiring trigger must never spawn its replacement.** [`EnsureGlobalDaemon.ts`](src/daemon/EnsureGlobalDaemon.ts) is called from the CLI tail, `post-commit`, `SessionStart` and both plugin bootstraps — five call sites in all — so four of them (all but the CLI tail) are on a critical path. `connect()` answers "does one exist" and is answered by the kernel, so it is bounded; reading `hello` answers "which build" and is answered by the daemon, which runs `VACUUM INTO` through `node:sqlite`'s **synchronous** API and therefore answers nothing for the duration (measured: 547 ms on a 143 MB database, plus 196 ms for the verifying `integrity_check`, both scaling with size). Hence the 300 ms hello budget whose timeout means **do nothing** — a successful connect already proved a listener exists. And hence the retire path stopping at `retire`: the retired daemon still holds the socket, the trigger never waits for a spawn, so a replacement started immediately dies `EADDRINUSE` **silently** and the upgrade removes the daemon with nothing reporting it. The next trigger respawns. `uninstall`/`disable` are on the exclusion list so a teardown cannot start one; the exclusion list keys off the commander-parsed command (`getInvokedRootCommand`), never an argv position, because a global option before the subcommand silently breaks the positional form. `uninstall` additionally sends `retire`, but **only when it removed a machine-global surface** — every task the daemon runs is machine-wide (the daily `jollimemory.db` snapshot, and the 30-second agent-conversation re-scan that serves every registered repo), so a repo-scoped uninstall (or one where every removal failed) retiring it would stop all of them for every OTHER repo, with nothing restarting them until an unrelated trigger fired elsewhere. Do not re-derive that conclusion from a task COUNT: it held when the snapshot was the only task and it holds now for the same reason, which is the tasks' scope rather than their number. Those five call sites plus the retire are pinned by a source-shape test — a unit test cannot see a call site that was never added, and a forgotten one just means the daemon never comes up from that surface.

  **Neither daemon's trigger may spawn `process.argv[1]`.** argv[1] is the CLI entry only when the caller IS the CLI, and four of these five triggers run from a hook entry: `run-hook` execs `node <dist>/PostCommitHook.js`, and both plugin manifests exec `node <dist>/PluginBootstrapHook.js`. Spawning argv[1] there re-runs that hook — its basename entry guard matches — against `homedir()`, which reaches the trigger again and spawns again, unbounded, while the daemon never starts; if `$HOME` is a git repo, `runPluginBootstrap` also installs Jolli into the home directory. Both spawns therefore go through [`resolveCliEntry`](src/util/CliEntry.ts), which takes the caller's own `import.meta.url` and looks for `Cli.js` **beside** it. That works under both bundlers — vite emits entries and shared chunks flat into `dist/` (`chunkFileNames: "[name].js"`), and the three esbuild bundles define `import.meta.url` as the bundle's own `__filename` — and `Cli.js` is in `DistPathWriter`'s `REQUIRED_RUNTIME_FILES`, so a registered dist always has one. It keeps the property argv[1] was chosen for (trigger and daemon are the same dist, so the handshake version means what it says) and carries `launchWorker`'s `existsSync` guard for the same reason: a `tsx` run against the source tree has no `Cli.js` to exec and must log that rather than spawn a path that does not exist. `McpProxy` is reached only from `Cli.ts` today and so was correct by accident; it uses the same helper, because nothing enforces that.


### The orphan-write lock — full rules

- **Every orphan-branch write holds `orphan-write.lock`; a new unlocked write path is a review blocker.** The cutover CAS verifies the frozen tips while holding every source's lock, so an unlocked `writeFiles` can land on the branch between the compare and the tip check and never reach the database. **Always through a wrapper — a bare `acquireOrphanWriteLock` call is itself a review blocker.** Only the wrappers consult and register [`OrphanWriteReentrancy.ts`](src/core/OrphanWriteReentrancy.ts)'s async-context store, and the lock is a plain file lock that refuses even its own PID, so a hand-rolled acquire breaks re-entrancy in both directions: nested inside a section its own call chain already holds, it polls out the full budget and then reports **contention** — a self-block whose log line is identical to real contention, so it reads as normal while the write silently never lands (measured: `jolli compile`'s search-index rebuild runs inside `MultiRepoCompile`'s `writeGuard`, reaches `getCatalogWithLazyBuild`, and skipped the catalog reconciliation every time) — and, holding the lock without registering, any wrapper below it self-blocks in turn (the two schema migrations turned that into a hard abort naming a writer that does not exist). Pick the wrapper by failure policy: `withRequiredOrphanWriteLock` (must land, throws), `withDeferrableOrphanWriteLock` (background reconciliation, answers `onBusy()`), or `Locks.withOrphanWriteLock` (the general form). The single exemption is the cutover CAS in `CutoverEngine`, which holds N *different* sources' locks at once and is documented in place. The topic stores, processed-source store, the two compile `writeGuard`s and the ide-bridge write actions go through `withRequiredOrphanWriteLock` ([`cli/src/core/SummaryStore.ts`](src/core/SummaryStore.ts)) — the **must-land** 30 s budget, not `withOrphanWriteLock`'s 1 s background one. That distinction is the caller's failure policy, not a tuning knob: the background budget means "defer, we will be re-invoked", and none of those paths has a re-invocation (`ide-bridge-serve` dispatches requests concurrently and the JVM host does not retry a failed write). A busy miss now throws the typed `OrphanWriteBusyError`, which `IngestPipeline` classifies as a benign `PAGE_WRITE_CONFLICT` and the compile commands report as "try again shortly" — not as an I/O fault or a stack trace. As the last line, `OrphanBranchStorage.writeFiles` re-reads the cutover fence from disk immediately before the plumbing write and throws if the branch is frozen — routing can't reach a long-lived process's cached storage object, only that check can.


### The cutover step-3 compare — full rules

- **The cutover's step-3 compare is a REPORT, not a gate — restoring the veto is a review blocker.** `compareSourceContainment` ([`CutoverEngine.ts`](src/dashboard/CutoverEngine.ts)) collects every path the frozen tip lists that the database does not reproduce; `runCutover` logs them, records `CutoverRecord.unreconciled` (exact count of DISTINCT paths, capped `sample`) and **proceeds to the fence and the CAS**. The gate is step 2: `importRepoMemory` throws on a real fault and nothing downstream runs. This is the reversal of the original design and it was forced by measurement, not preference — a real orphan branch carries a few paths the import can NEVER store (a summary whose embedded `children[]` names a commit with no `summaries/<hash>.json` of its own; a body rewritten in place after its row was written), those states are stable and self-sustaining, so every attempt failed on the same path and the repo could never leave the legacy branch. Refusing therefore bought nothing and cost everything. What makes it safe is that the fence FREEZES the branch rather than deleting it: every unreconciled path stays readable at the tip the same record pins, and `jolli cutover` prints the list on commit AND on `--status`. Two details of that report are load-bearing rather than cosmetic, because sibling clones share a repo id and compare against one database: the paths are **de-duplicated across sources** (the two synthesized union views exist on every clone's branch, so a repeat is the normal case, and without this the "exact" count is a finding tally and the sample spends its 50 slots on repeats), and the note prints **the real tips**, one `git -C <root> show <tip>:<path>` per source, because nothing else in the product ever prints them — `--status` shows the version and commit time, `--probe` names a tip only when one has MOVED, and the paths deliberately carry no source attribution. A literal `<frozen tip>` placeholder there makes the only recovery instruction there is unexecutable. The list the COMMIT run prints is uncapped (`CutoverOutcome.unreconciled`, alongside the record, since that run is the only moment the whole set exists); only the stored `sample` and the log line stop at 50, and neither the command nor `--status` may claim the remainder is "in debug.log" — that line renders through the same cap, so the tail was in no output, no log and no row, exactly when the user needed a path to feed the `git show` recipe. **The refusals that survive and must stay are asked of the IMPORT**, never of the compare: a source the import stored nothing from did not land, and freezing there strands the whole repo. There are **two**, and they are one rule seen from two sides rather than a rule plus an escalation — removing either, or merging them, is a review blocker. (1) `summaries/` listed (`importTakesPath`-filtered) and **zero summary rows** → refuse. Unchanged, and it must NOT be relaxed into "did anything land": summaries ARE the memories, so a repo whose summaries all fail while one plan imports has landed none of them, and freezing on the strength of that plan reports every memory it has as unreconciled. (2) **Any** of the eight families listed and **zero rows of every kind** (`storedNothing`) → refuse. This one exists solely for the branch rule 1 cannot SEE — one carrying no summary at all, which `listsSummaries` answers "lists nothing" to, so the gate could never fire however little the import took. That shape is reachable, not hypothetical: `ide-bridge write-plan` calls `storePlans` with no commit and no summary behind it. Rule 2 is strictly narrower than rule 1 (every counter zero, not just `nodes`), which is what stops it blocking a repo whose import partially works. Neither may become a per-family veto — "the tip lists notes and the import stored no notes" would strand a repo forever on one un-importable note. Spelling it as a compare ratio instead — "every visited path mismatched" — was implemented and measured wrong on a real fixture: a repo whose single summary is dirty mismatches 1-of-1 and was refused by exactly the block this change removes. Do not add a second refusal, and do not "tighten" this back into a per-path veto. The same rule retired the OTHER un-retryable refusal: a repo with no orphan branch at all now pins `NO_ORPHAN_TIP` (`""`) and cuts over, since nothing could ever make "nothing to migrate" become ready — it is imported from `EMPTY_ORPHAN_STORAGE` rather than skipped, because the import is what registers the `repos` row the CAS then looks up, and every later tip comparison (the CAS re-verify and `probeCutoverDrift`) must fold `resolveCommittish`'s null onto that sentinel or a branch-less repo reports drift forever.


### Session-sync table partition — full rules

- **Every table in the dashboard database must appear in exactly one of the two session-sync lists, and the partition is what enforces the privacy boundary.** `SYNCED_TABLES` and `NEVER_SYNCED_TABLES` in [`cli/src/dashboard/SessionPushManifest.ts`](src/dashboard/SessionPushManifest.ts) are asserted to cover `sqlite_master` **in both directions** (`sqlite_sequence` exempted), with per-table column coverage checked both ways and a TWO-TIER regex net over every column name. Tier 1 (`/transcript|content|body|text/i`) is the promise the product makes and **nothing exempts a match**; tier 2 (`/query|prompt|message|title|term|snippet|excerpt|description|instruction/i`) catches names that plausibly hold prose, and a match there is not a failure but a requirement to record a ≥40-character reason in that test's `FREE_TEXT_EXEMPTIONS` — checked in BOTH directions, so a stale entry, one for an unsent column, or one the net never matched fails too. The second tier exists because the first could not catch what it was asked to: `memory_lookups.query` is user-authored free text and the word `query` walks straight through tier 1, so the net had to gain a way to stop the NEXT such column rather than be widened for this one. Keep tier 2 SHORT — every speculative token costs a meaningless exemption on the next column that trips it, and a list of meaningless entries is the rubber stamp the reason requirement exists to prevent. [`JolliMemorySessionColumns.test.ts`](https://github.com/jolliai/jolli/blob/main/backend/src/model/JolliMemorySessionColumns.test.ts) in the server repository carries the mirror image, so a column added on either side is justified twice. **A synced table's primary KEY travels too, so a key derived from a row's own columns must not interpolate an unbounded one.** `memory_lookups.receipt_id` is `statsEventId`'s output, and interpolating the query's bucket key verbatim built a second, much lower ceiling out of the one column nothing clamps: the server caps `receipt_id` at 500 characters while capping `query` at 20 000, so a search past ~430 characters became a permanent 400 on a channel that is all-or-nothing and neither silences a 400 nor steps past one — one lookup wedging every table on that machine. It carries a fixed-length fingerprint instead ([`lookupQueryFingerprint`](src/dashboard/DashboardModel.ts)), a hash and not a truncation because a shared prefix would collapse two searches onto one row; that also keeps the key out of the free-text review above, since an opaque column NAME matches neither tier of the net. So adding a table to [`SotSchema.ts`](src/dashboard/SotSchema.ts) without classifying it fails `SessionPushManifest.test.ts` — deliberately, because the alternative is a table silently defaulting into an outbound upload. A synced table additionally needs a `SYNC_STAMP_COLUMNS` entry, a `KEYSET_COLUMNS` entry and a `WINDOW_SOURCES` entry in [`SyncColumns.ts`](src/dashboard/SyncColumns.ts) — the last is a union so "no window" cannot be expressed, and omitting it is what made a first run walk an entire table. Note the stamp column names are **not** uniform (`sessions`/`commits` use `written_at_ms`, the child tables `updated_at_ms`), and a row whose stamp is left NULL or stale is invisible to every cursor for ever.


### A reference source is five declarations — full rules

- **A reference source is FIVE declarations, and the JVM host may lag only through `KNOWN_JVM_SOURCE_GAPS`.** Registering a `SourceDefinition` in [`sources/definitions/index.ts`](src/core/references/sources/definitions/index.ts) wires the CLI and VS Code (which bundles it) and nothing else. IntelliJ needs four more: the `SourceId` constant, a `SourceDisplay.Style` whose letter / label / hex equal the [`SOURCE_META`](src/core/references/SourceLabels.ts) row, membership in `PATH_UNSAFE_SOURCES` iff the definition says `nativeIdPathSafe: false`, and — for a hyphenated id — the same wire string in all three of `@SerializedName`, `SourceIds.wireName` and `SourceIds.parse`. Every one of those fails silently: Gson decodes an unknown constant to **null**, so `CommitsPanel` drops the reference row outright (`ref.source ?: return@forEach`) and the CONTEXT panel degrades it to a neutral `R`; a wrong `PATH_UNSAFE_SOURCES` reads the identity file stem where the CLI wrote the sanitized+sha8 one, so every archived body of that source comes back null. `SourceLabelsLockstep.test.ts` parses the Kotlin and holds all five together. **Deferring the Kotlin to a follow-up PR is still allowed** — `intellij/` is an independent Gradle build the root `npm run all` does not cover, so a one-language PR is a real simplification — but only by adding the id to that test's `KNOWN_JVM_SOURCE_GAPS`, which is checked in both directions and so must be emptied again in the PR that closes the gap. A prose note is not a substitute: `vercel` / `figma` / `sentry` each sat as one for weeks and each was re-reported as a bug, because a comment cannot fail. Two IntelliJ render paths must additionally stay DERIVED rather than restating a subset — `SummaryHtmlBuilder`'s `SOURCE_ORDER` is `SourceId.entries` (it renders by walking that list, so a missing id is not sorted last, it is dropped from the section — a hand-written five hid ten sources) and its row label is `SourceDisplay.of(...).label` (a second title map printed the bare enum name, `monday` / `zoom_doc`).


### Two-layer hook model: per-source discoverers — full catalogue

1. **AI agent hooks.** `SessionStartHook` and Gemini's `AfterAgent` only record session metadata to `<projectDir>/.jolli/jollimemory/sessions.json`. Claude's `StopHook` records that too, but additionally **reads the transcript**: it incrementally scans for plans, references and skills and persists them (`plans.json`, per-reference files), so "metadata only" is false for it. None of the three call the LLM. Only the Stop hook is registered `async: true`. The other eleven sources have **no hook** — Codex, OpenCode, Cursor (Composer IDE), Cursor CLI (`cursor-agent`), GitHub Copilot CLI, VS Code Copilot Chat, Cline (VS Code extension), Cline CLI, Devin CLI, Antigravity, and Kimi Code CLI (`@kimi-code/cli`). Hermes has one — see below. Each has a per-source session discoverer plus transcript reader under `cli/src/core/`, running at post-commit time. Detection is a separate `*Detector.ts` for Cursor (Composer), Copilot CLI, Copilot Chat, Cline, Cline CLI and Antigravity, and is colocated in the discoverer for Codex, OpenCode, Cursor CLI, Devin, Kimi and Hermes. Codex and Kimi have no per-source reader and reuse the shared `TranscriptReader.ts` (via `getParserForSource`). Kimi ([`KimiSessionDiscoverer.ts`](src/core/KimiSessionDiscoverer.ts)) recovers each session's working directory from `state.json` (`~/.kimi-code/sessions/<workDirKey>/<sessionId>/state.json` → `workDir`; the `wire.jsonl` event stream carries no cwd), and its conversation is the sibling `agents/main/wire.jsonl` — Kimi's own JSONL wire protocol, NOT ACP, whose `turn.prompt` (user) and `content.part` of `part.type:"text"` (assistant, delivered inside `context.append_loop_event`; `think` parts are reasoning and skipped) events are the only conversation turns; every event carries a millisecond-epoch `time`. This is the same `@kimi-code/cli` that the `local-agent` provider drives — it is now both a summary-generation backend and a discovered source. The OpenCode reader uses Node 22.13+ `node:sqlite` and is lazy-imported + feature-gated so older runtimes (e.g. a VS Code host's bundled Node) tolerate the missing module; the Cursor, Copilot, Devin, and Antigravity triplets follow the same lazy-import pattern. Devin CLI reads its global WAL SQLite (`~/.local/share/devin/cli/sessions.db`), scoping sessions by the `working_directory` column; its `message_nodes` table is a **forest** (alternate regenerations are sibling nodes), so the canonical conversation is the main chain walked from `sessions.main_chain_id` up the `parent_node_id` pointers — its detection is colocated in `DevinSessionDiscoverer.ts` (OpenCode-style) rather than a separate detector file. Antigravity is the odd one out: its per-conversation SQLite (`~/.gemini/<variant>/conversations/<id>.db`) is read only to recover the workspace path (its own agent data is encrypted), while the conversation *content* is read from a sibling plaintext `brain/<id>/.system_generated/logs/transcript_full.jsonl`. Copilot CLI and Copilot Chat share a single `copilotEnabled` config flag — splitting them was rejected because users want them together. Codex additionally extracts **references** on the VS Code sidebar's 60s Active Conversations tick. `BUILTIN_DEFINITIONS` ([`cli/src/core/references/sources/definitions/index.ts`](src/core/references/sources/definitions/index.ts)) holds fifteen source definitions today (Linear, Confluence, Jira, GitHub, Notion, Slack, Zoom meetings, Zoom docs, Asana, monday.com, context7 doc lookups, Jolli Memory's own lookups, Vercel deployments, Figma design-file lookups, and Sentry issues); Codex resolves only those carrying a `match.codex`, which is eleven of the fifteen, since `zoom-doc`, `vercel`, `figma` and `sentry` are Claude-only (not just summaries at post-commit): [`CodexDiscovery.discoverCodexConversations`](src/core/CodexDiscovery.ts) reuses the shared per-source envelope parser ([`TranscriptEnvelopeParser`](src/core/references/TranscriptEnvelopeParser.ts) → `CodexEnvelopeParser`) and the same `discovery-cursors.json` cursor as the Claude Stop path. References were Claude-StopHook-only before; the envelope layer is now source-agnostic. **Kimi extracts references AND skills too**, via [`KimiDiscovery.discoverKimiConversations`](src/core/KimiDiscovery.ts) on the same post-commit + 60s-tick paths ([`KimiEnvelopeParser`](src/core/references/KimiEnvelopeParser.ts) correlates `tool.call`/`tool.result` by `toolCallId`; the string `result.output` is `JSON.parse`d and normalised through the shared [`McpBusinessNormalize`](src/core/references/McpBusinessNormalize.ts) extracted out of `ClaudeEnvelopeParser`). Because Kimi names MCP tools `mcp__<server>__<tool>` exactly like Claude, resolution reuses `registry.match("claude", …)` with no `match.kimi` and no new `SourceAgent` — but that only covers definitions carrying a **generic** `mcp__<server>__` prefix (today `linear`, `github`, `context7`, `jollimemory`, `vercel`, `figma`, `sentry` — 7 of the 15). The other eight only match `mcp__claude_ai_*__` (Asana, Confluence, Jira, monday, Notion, Slack, both Zoom) — the claude.ai first-party-connector namespace a Kimi install cannot structurally produce, so they are a **known gap**: covering one means adding a generic prefix to its definition, pinned to a real Kimi capture of that server's tool naming (the Linear path was verified that way). Kimi skills are **observed** ([`KimiSkillScanner`](src/core/skills/KimiSkillScanner.ts): a real `Skill` tool call, `name:"Skill"` + `args.skill`), not heuristic like Codex's file-read inference; `"kimi"` is in `SkillSource`. **Hermes Agent** ([`HermesSessionDiscoverer.ts`](src/core/HermesSessionDiscoverer.ts)) keeps every conversation — CLI, TUI and each messaging-gateway platform — in ONE global WAL SQLite (`<HERMES_HOME|~/.hermes>/state.db`, and one per named profile under `<home>/profiles/<name>/`, which are enumerated because a profile-only user's default database is empty and reading just it would report "this agent found nothing"). Its `sessions` table carries BOTH a `cwd` and a `git_repo_root`, so scoping reproduces Hermes' own rule — root when filled in (it is populated lazily and absent on many rows), `cwd` otherwise — by carrying both directories and letting `sessionsForRepo` do the disjunction. Its `messages` table is LINEAR (one append-only row per turn, ordered by an AUTOINCREMENT `id`) and each row is an OpenAI chat-completions message, so [`HermesTranscriptReader.ts`](src/core/HermesTranscriptReader.ts) needs no forest walk and no envelope unwrap; it reads `active = 1 OR compacted = 1`, which keeps the turns a COMPACTION archived (real history Hermes preserves rather than deletes) and drops the ones a REWIND archived (turns the user explicitly undid — the same claim Devin's alternate regeneration branches make), and resumes by message id so a rewind cannot make a positional cursor skip later turns. Hermes names MCP tools `mcp__<server>__<tool>` exactly like Claude and Kimi (`tools/mcp_tool.py: mcp_prefixed_tool_name`), so tool classification is `classifyToolName` verbatim; every row carries a `timestamp REAL NOT NULL`, which is why it is in `TOOL_CALL_TIME_SOURCES`. **Hermes skills are observed** ([`HermesSkillScanner`](src/core/skills/HermesSkillScanner.ts): a real `skill_view` call paired with its result by `tool_call_id`, whose `success` field decides the outcome), so no heuristic marker; `"hermes"` is in `SkillSource`. Like OpenCode it is a scan-and-write pipeline over SQLite rows rather than a line scanner, so it is deliberately absent from `SkillTranscriptScanner`'s table and driven from the post-commit pass plus the 60-second tick by [`HermesSkillDiscovery`](src/core/skills/HermesSkillDiscovery.ts). It is also the SECOND source to declare `daemonRescan` (see that flag's bar). **Hermes extracts references too** ([`HermesDiscovery.discoverHermesConversations`](src/core/HermesDiscovery.ts) on the same post-commit + 60s-tick paths, plus the on_session_end hook path below), via [`HermesReferenceExtractor`](src/core/references/HermesReferenceExtractor.ts) — the SQLite-shaped envelope walker for `messages.tool_calls` rows: it strips the `<untrusted_tool_result>` wrapper (Hermes applies it at ≥32 chars — `_UNTRUSTED_WRAP_MIN_CHARS`), unwraps the `{"result": "<str>"}` shell, JSON-parses the inner, then normalises through the shared [`McpBusinessNormalize`](src/core/references/McpBusinessNormalize.ts) and the shared [`referencesFromNormalizedResults`](src/core/references/ReferenceExtractor.ts) walk+dedupe (a new seam so SQLite sources share the reduction). Two shapes must both be handled: a direct `function.name: "mcp__<server>__<tool>"` and a bridged one where `function.name: "tool_call"` carries the real name inside `arguments.name` (progressive tool disclosure — `_HERMES_CORE_TOOLS` never defer). `classifyHermesToolName` returns the correct `mcp__<server>__<tool>` for both, so the same `registry.match("claude", …)` resolution Kimi uses covers the seven generic-prefix definitions (the same eight `mcp__claude_ai_*__` gaps Kimi has apply verbatim — Hermes cannot structurally produce that namespace either). One extra survivor rule the writer forced: `_maybe_append_elision_notice` sits INSIDE the wrapper AFTER the business JSON, so the payload scan is a balanced-brace lift rather than JSON.parse-of-whole-body — a naïve parse would drop every truncated result. Cursor rewind is scoped to unpaired calls AFTER the last paired result (same rule Kimi and Claude ship), so a cancelled/killed early call cannot pin the cursor forever.


### Hermes on_session_end hook registration — full rules

Hermes' `on_session_end` shell hook rides the same `run-hook` dispatch every other host does. [`HermesStopHook`](src/hooks/HermesStopHook.ts) mirrors [`CursorStopHook`](src/hooks/CursorStopHook.ts) — it does what Claude's Stop hook does (`saveSession`, `recordSessionFromHook`, plus a detached `HermesDiscoveryWorker` for skills + references), contributes no extraction logic of its own, and is bound by four rules the shell-hook contract forces (nothing on stdout — Hermes parses it as JSON and any recognised shape changes control flow; fail open silently; opt-in gate on `isGitHookInstalled` because Hermes hooks are global and a browsed-but-not-enabled repo must not get `.jolli/jollimemory/`; and the basename entry-point guard). Registration is one operation, not two: Hermes has no per-manifest hook path, so declaring `on_session_end` means writing a `hooks:` block to the same `config.yaml` that carries `mcp_servers` — hence `hermesRegistrar` in [`HostRegistrars`](src/install/mcp/HostRegistrars.ts) upserts BOTH blocks through [`HermesConfigWriter`](src/install/mcp/HermesConfigWriter.ts) (the line-based YAML analogue of `CodexTomlWriter`: no-op short-circuit on identical bytes, atomic write, mode preserved through the rename so a 0600 file — Hermes' plaintext `custom_providers[].api_key` — never widens to 0644) and THEN pre-records the `(event, command)` pair in `<HERMES_HOME>/shell-hooks-allowlist.json`, because Hermes' first-use consent silently REFUSES a hook on a non-TTY start otherwise. The allowlist entry is scoped to Jolli's pair specifically — `hooks_auto_accept: true` was rejected because it would blanket-approve every future hook Jolli or anyone else adds, which is a policy decision only the user may make. POSIX-only for the hook (`run-hook` is bash — a win32 native dispatcher would fill this gap); MCP itself is written on both platforms.


### Disable switch, per-source toggles, auto-cutover & cutover-block — full rules

- `<projectDir>/.jolli/jollimemory/` — **per-project, gitignored**: `sessions.json`, `cursors.json`, `git-op-queue/`, `notes/`, `plans.json`, `briefing-cache.json`, `space-binding.json` (cached repo→Space binding, 7 d TTL — see `SpaceBindingCache.ts`), and `debug.log`. Resolved by `getJolliMemoryDir(cwd)` in [`cli/src/Logger.ts`](src/Logger.ts). One sibling here, `profile.json`, is deliberately **repo-wide, not per-worktree**: [`RepoProfile`](src/core/RepoProfile.ts) anchors it to the **main** worktree root (via `git rev-parse --git-common-dir`) so it is shared across every worktree. It holds `backfillDismissed`, the cutover throttles, `cutoverFence`, and **ONE disable switch**. `cutoverFence` (`{reason, at}`) marks the repo's orphan branch as frozen — new runtimes keep working (write SQLite, read the database) while `jolli enable` must NOT clear it (only doctor's explicit manual path may). `manuallyDisabled` is the switch: `jolli disable` (and the VS Code / ide-bridge equivalents) set it, `jolli enable` clears it, upgrades and window reloads never override it, and when set EVERYTHING stops — orphan and SQLite writes alike, hooks, plugin bootstraps, skill refresh, and the dashboard's machine-wide sweep. **Folding the fence into it is a review blocker.** It was folded in for one week (the phase-D three-field split), and that field is the only one a pre-0.99.11 build reads: at least one shipped plugin (Claude plugin 1.0.1, core 0.99.9) treats it as a user decision and runs `uninstall()` from its SessionStart bootstrap — measured deleting the shared git hooks, the Gemini hook and `.mcp.json` / `.cursor/mcp.json` across all seven worktrees of this repo, which VS Code then reinstalled, once per session, showing up as "Enable Jolli Memory" after every commit. Those builds cannot be fixed from here, so the brake was removed rather than the wrecking ball; `probeCutoverDrift` is the compensating control (an old runtime's writes move the tip, get reported and catch-up imported — stranded, never lost), and the accepted residual is that such a runtime still READS the frozen branch and shows a view missing everything written to SQLite after the cutover.

  **`userDisabled` is retired, and DELETING ITS READ BRANCH IS A REVIEW BLOCKER.** It was the split's truth field (0.99.11 – 0.99.13). Nothing writes it now: `readManualDisableFlag` folds it onto `manuallyDisabled` and deletes the key, and every explicit write drops it (`withDisableSwitch`) — necessarily, because those builds read `userDisabled` FIRST, so a stale copy left beside a fresh switch is the value they would act on. While present it still WINS, in both the async reader and `readManualDisableFlagSync`, and that one-line precedence is a COMPLETE defence rather than a mitigation: `cutoverFence` and `userDisabled` were introduced by the **same commit** (`73e1609c1`), so a build old enough to compute `userDisabled || fence` is also a build that writes `userDisabled` beside it — a fence-poisoned `manuallyDisabled: true` therefore never appears without a trustworthy `userDisabled: false` next to it. Take the composite there instead and every repo that had cut over becomes permanently disabled. The branch is also not a one-shot upgrade step: a plugin bundle execs its own `dist/` and never passes through `run-hook`'s version race, so such a writer can re-create the split at any time and the next read has to fold it again.

  **The dashboard registry stores no disable state, and adding a second record of it is a review blocker.** `dashboard-repos.json` answers only "which projects exist on this machine, at which checkouts". It used to carry a `disabledAt` stamped by ONE writer (`jolli disable`) and cleared by EVERY `registerRepo`, which drifted one way: a repo disabled from the VS Code sidebar or the ide-bridge never got the stamp, and a background `enable --automatic` or a dashboard page open wiped one that had been set — so `jolli dashboard` kept re-importing repos the user had switched off. `listActiveRepos` and `DbBackfill` now derive from the profile through the shared `isRepoDisabled` (`existingWorktrees(repo).every(readManualDisableFlagSync)`), and `deregisterRepo` is gone. Removal did not go with it and is a different question entirely — `forgetRepo` / `removeReposFromRegistry` / the disposable prune ([`RepoForget.ts`](src/dashboard/RepoForget.ts)) address an entry by IDENTITY and delete it outright, which is the only addressing that can reach a checkout whose directory is gone. What no removal path may do is record a *disable*: a switched-off repo is still a repo the machine has, so it stays listed and the profile is the only place that says otherwise. Three details are load-bearing: **`every`, not `some`** (a row is one repo IDENTITY while the profile is per CLONE, so the row stays active while any clone is on); the **sync** reader (asking "should I sweep you?" must not migrate and persist a profile in someone else's repo); and **`dbBackfillRepos` receives the WHOLE roster**, skipping the switched-off repos' import while still projecting their paused state — it is the only caller that writes `repos.disabled_at`, so filtering them out upstream would leave that column NULL forever and keep a disabled repo counting in every KPI. Its `mode: "disabled"` rows must stay out of the caller's `worked` population (they gate the report, size "across N repo(s)", and feed `printSessionSummary`) and stay unprinted — an unmounted checkout is something the user is still waiting on, a disable is their own decision.

  `ManualDisableFlag.ts` in the VS Code extension is a thin re-export of the `RepoProfile` helpers, and reads migrate the legacy per-worktree `disabled-by-user` markers.

  **The PER-SOURCE toggles are a second, independent axis, and every tier that reads an agent's store must honour them.** `claudeEnabled` / `cursorEnabled` / … answer "may this agent be collected at all" and route through the one mapping in `isSourceEnabled` ([`SessionTracker.ts`](src/core/SessionTracker.ts)) — grouped, so `cursor`+`cursor-cli`, `copilot`+`copilot-chat` and `cline`+`cline-cli` share a switch, and anything but an explicit `false` is on. The sidebar, `jolli status`, the post-commit worker and each hook-driven discovery pass have always consulted it; the dashboard tiers did not, so a user who switched Cursor off watched it vanish from four surfaces while `jolli dashboard` kept scanning its store and the 30-second daemon tick kept re-reading its conversations, both writing rows on every pass. `readSourceGate` in [`DbBackfill.ts`](src/dashboard/DbBackfill.ts) resolves the config ONCE per pass (it is machine-global — reading it per repo re-reads one answer inside the loop that exists to hoist shared work) and both `dbBackfillRepos` and `dbRescanSessions` narrow their source list with it.

  Three parts of that are load-bearing. **Narrowing only the machine-wide scan is worse than not narrowing at all** — absence from `preScanned` is exactly what makes the collector fall back to a source's PER-REPO scan, so a store skipped once would be opened once per repo instead; the predicate therefore also reaches `collectSessionEvents`, which narrows `SESSION_SOURCES` before splitting it into `spanning`/`perRootDefs`. **The session-level filter is NOT the same test as registry membership**: `gemini` has no `SESSION_SOURCES` entry at all (no disk discoverer — `sessions.json` is its only route), so filtering collected sessions by the definition list would delete every Gemini session on the machine; it filters on the predicate, which is also what drops a switched-off source's hook-written rows out of a `sessions.json` that is read regardless. And **nothing is retroactive** — rows written before a source was switched off stay in the database and on the page, because a toggle is not a delete and the transcripts behind those rows are routinely gone. An unreadable config answers ENABLED for everything, the opposite of the repo-level switch's rule: a missing toggle has never meant "off", so reading it that way would silently stop importing on a machine whose config merely failed to load.

  **"EVERYTHING stops" is scoped to writes about THAT repo, and `jolli dashboard` is where the distinction is load-bearing.** The dashboard is a machine-level view of every registered repo, so being launched from a disabled one is no reason to withhold the other repos' data — the page still opens. What `executeDashboard` skips is the ONE write aimed at `cwd`: `registerRepo`, because a page open is not a reason to add a repo the user switched off to the machine's roster. Everything else there is machine-scoped and must NOT be gated on `cwd`: `ensureDashboardDbExists` and `opportunisticSnapshot` belong to the database (gating them means one disabled repo silently stops the machine's backups), while `runHistoryImport` and the cutover sweep walk the roster and ask each repo's own profile for itself. The gate reads `readManualDisableFlagSync` — the read-only variant, since a question asked on the way to opening a page must not migrate and persist a profile decision (same call, same reason, as `SkillAutoRefresh`).

  **Auto-cutover's foreground trigger sweeps the WHOLE roster; only the post-commit drain is per-repo.** `autoCutoverAllRepos` ([`AutoCutover.ts`](src/dashboard/AutoCutover.ts)) is what `jolli enable`, a bare `jolli` and `jolli dashboard` all call, so `jolli enable` in one repo cuts over the others too — deliberate, because a cutover is scoped to one device and one repo, pushes nothing and syncs nothing, so there is no more to coordinate for N repos than for one. The asymmetry it removed had `runHistoryImport` sweeping the roster while the cutover beside it took only `cwd`, which meant a user had to open the dashboard once per repository. `QueueWorker` keeps calling `maybeAutoCutover(cwd, { throttle: true })` and must stay that way: it runs on every commit, sweeping the machine from a git hook multiplies the per-commit cost by N, and the repo being committed is the one it already covers. Four properties of the sweep are load-bearing. It reads the **whole registry** rather than `listActiveRepos`, because a repo filtered out upstream cannot be logged as skipped. It asks **`hasLiveWorktree` first**, since `existingWorktrees` deliberately never returns empty (it falls back to `worktreeRoot`), so a repo whose checkout is gone is otherwise indistinguishable from a healthy one and the attempt stamps a profile into a path that does not exist. It decides disabled-ness with **`isRepoDisabled`, never a hand-rolled `readManualDisableFlagSync(root)`** — a registry row is one repo IDENTITY while `profile.json` is per CLONE, so the question is `every` checkout, and it is deliberately the same predicate `DbBackfill` asks so "which repos do I import" and "which repos do I cut over" cannot disagree. And it takes **no `configDir`**: `runCutover` reads the registry through a bare `readRepoRegistry()` and looks repos up by identity, so a sweep selecting from a different registry would collect `not-ready: repo is not registered` for every entry — silently, since that is also a genuine unregistered repo's answer. Tests redirect the default registry with an isolated HOME instead; do not thread `configDir` into the engine without auditing its other callers. `AutoCutoverSweepOptions` also has no `throttle` field at all, which is what makes "no foreground caller throttles" a type guarantee rather than a convention.

  **What bounds the repo that can never cut over is a MEMO, not a window, and turning it back into one is a review blocker.** Unthrottled foreground callers plus a whole-roster sweep would mean a repo whose import can never land re-paying the FULL import on every bare `jolli` and every `jolli dashboard`, linear in how many such repos the machine has. A time window and a consecutive-failure count are both approximations of "would another attempt answer differently?", and both fail in the direction the window was removed for: they suppress a retry that WOULD now succeed. So the engine records the answer instead — [`CutoverBlock.ts`](src/dashboard/CutoverBlock.ts), `repo_state` key `cutover-blocked`, holding the refusal code, the engine's own sentence, and a **witness** of the inputs the refusal was a function of (every source's pinned tip, plus `__CLI_PKG_VERSION__`). `readCutoverBlock` re-derives that witness and answers "blocked" ONLY while it is unchanged; anything moves and the record is discarded and the attempt runs with no window at all. Five things about it are load-bearing. **Only the two IMPORT refusals get a code** (`no-summary-rows`, `stored-nothing`) — every other `not-ready` converges on its own, and the step-3 compare refuses nothing at all, so widening the codes re-creates the permanent block this design removed. **The witness is complete only because `storedNothing` counts rows WRITTEN** (`updated`/`skipped`/`pruned` are deliberately excluded), so the refusal does not depend on database state that grows under it; making it a change-counter invalidates the whole module. **`runCutover` clears the record before step 1 and writes it only at those two refusals** — one clear site, one write site, so success, a transient answer and a throw all leave no record. **`runCutover` never consults it** (typing `jolli cutover` is the documented bypass for every gate in this engine); only `maybeAutoCutover` does. And **anything unreadable — absent database, corrupt JSON, an unknown code — reads as NO block**, because a repo we cannot explain is one we retry. Performance is the smaller half of why it exists: a blocked repo is BROKEN, and the record is what lets `jolli cutover --status` and the sweep's own output name the refusal instead of printing the same "not switched this time" a healthy repo gets. Do not add a foreground throttle, and do not make this a silent skip.


### MCP server registration (multi-host) — full rules

Each non-Claude registrar is gated on its host's **presence on disk**, which is deliberately *not* the same predicate that decides whether this runtime can read that host's conversations. Registration only writes a config file, so the five hosts backed by an embedded store (Cursor, OpenCode, Copilot CLI, Devin, Antigravity) get a plain filesystem check rather than the readability-gated detector that governs session discovery, the status tree and the discovery toggles — on a runtime without `node:sqlite` those hosts report absent for discovery while MCP is still written. Cline is the one host whose MCP gate is *narrower* than its discovery gate: only the editor extension registers, because the standalone CLI ships no MCP config. Do not collapse the two predicates back together. Each host's per-entry envelope differs (OpenCode `type:"local"`+array, Copilot Chat `type:"stdio"`, Devin `transport:"stdio"`, Antigravity none) — a shape correct for one host silently no-ops if written to another, so each was verified against the host's real on-disk config or app source. **Claude is the exception**: its `detected` flag mirrors `config.claudeEnabled !== false` (not a filesystem detector) — but MCP registration still runs **regardless of `claudeEnabled`** (it happens before the `claudeEnabled` hook gate in the install loop), because the Claude hook and MCP registration are independent decisions. **IntelliJ MCP registration is live** — the plugin drives the bundled CLI's enable as a subprocess and has no registry writer (or hook writer) of its own, so it consumes exactly the registrars above. Uninstall removes only the two repo-scoped registries; all nine global hosts' entries are deliberately left behind, and although each global registrar carries a remover, no reachable path invokes one.

**`--repo-hooks-only` skips MCP registration for every host except one: Codex, and only when the acting host is Codex** (`pluginBootstrapHost(sourceTag) === "codex"`, i.e. a Codex plugin bootstrap or its `/jolli:init`). That global `~/.codex/config.toml` entry is the *only* way the Codex plugin gets a working MCP server, because a plugin `.mcp.json` cannot have one — Codex does not expand `${PLUGIN_ROOT}` in an MCP entry, so the command must be relative with `cwd: "."`, and Codex resolves that relative cwd against the **plugin root**. Every memory tool derives the repository it serves from its cwd, so a plugin-launched server answers `recall` / `search` / `status` for the plugin's cache directory: empty-but-successful results, plus a placeholder Memory Bank repo named after the bundle's version directory. Measured on codex-cli 0.146.0, nothing recovers the workspace from inside such a launch — no `roots` capability (a server-initiated `roots/list` returns `[]`) and a 7-variable env allowlist with nothing session-scoped — while the same probe registered in `config.toml` (no `cwd` key) got the session cwd. So: the Codex plugin ships **no** `.mcp.json`, `startMcpServer` refuses any cwd under `**/.codex/plugins/` or `**/.claude/plugins/` rather than serving the wrong repo, and this bootstrap registers Codex **only** — never the other eight global hosts, which a Codex install has no business configuring. The first session after install therefore has skills but no MCP tools (Codex reads registrations at session start); the skills' `run-cli` fallback covers it. Do not "restore" a plugin MCP manifest, and do not widen the exception to other hosts.

**`startMcpServer` guards three kinds of cwd — two by refusing to start, the third by withholding tools, and that asymmetry is the decision.** Every repo-scoped tool derives its repository from cwd, and outside a repository nothing *fails* — `StorageFactory` logs "Not a claimable project (no git worktree …) — using orphan-only storage" and every read answers **empty but successful**, which the cutover rule above names as worse than no data. A local-agent-child cwd and a plugin-bundle cwd (`**/.codex/plugins/`, `**/.claude/plugins/`, `**/.cursor/plugins/` — shared with the Cursor bootstrap via [`PluginBundlePaths.ts`](src/core/PluginBundlePaths.ts)) are refused outright: a throwaway temp dir and a bundle cache are wrong about *everything* the server could answer. **"Not inside a git worktree" is narrower and is handled per tool.** Each entry in `TOOL_DEFINITIONS` declares a **required** `requiresRepo: boolean`; outside a worktree the `requiresRepo` ones are dropped from `tools/list` (a tool the model cannot see is a tool it cannot misread an empty answer from — strictly stronger than refusing), a call-time check backstops a client working from a cached list, and `setLogDir` / `createStorage` are skipped so a non-repo cwd cannot leave a stray `.jolli/` in the user's HOME. `list_spaces` and **every** platform tool survive, because `invokePlatformTool` is a pure HTTP passthrough (endpoint from the manifest, auth from the API key, args from the model) that takes nothing from cwd. Refusing wholesale — the original shape — took ~23 of 32 tools offline to protect 9, on nine hosts whose MCP registration is machine-global and therefore reached from *any* directory a session opens in. `requiresRepo` being required (no default) is what makes this safe: a new tool cannot omit it, and the exact partition is pinned by a test so declaring one `false` by mistake is a visible edit rather than a one-character silent regression. That last guard exists because of a measured production failure: Cursor imports Claude plugins wholesale under `enable_cc_plugin_import`, `.mcp.json` included, and it spawns MCP servers from a shared process *before any workspace folder is known* ("WARN No workspace folders found" in `mcpprocess.log`), so the child inherits the host's own cwd — on a real install the user's HOME. The Claude plugin's server came up rooted at `/Users/<me>`, logged "Successfully connected", and served an empty repository. It is not a spare wheel alongside a good server either: the repo-scoped entry `jolli enable` writes is discovered live but registered `none → disconnected` and never spawned until the user enables it in Customize, so the imported one **occupies the entire tool surface** — a fresh repo's `~/.cursor/projects/<slug>/mcps/` held exactly one materialised server, the plugin's, with all 32 tools. The bundle guard cannot see it (HOME is not a bundle path) and nothing in that launch can recover the workspace — the working entry is the repo-scoped `.cursor/mcp.json` that `jolli enable` writes. The guard order is load-bearing: the bundle check is a pure string test and runs FIRST, because a marketplace cache served over git is a real checkout and would otherwise pass the worktree test. One residual is accepted rather than guessed at — if a user's HOME *is* a git repo (dotfiles), it passes and is served, which is right when they opened it and indistinguishable from a stray launch when they did not; do not special-case HOME.

  **Fixing this at the source was considered and declined.** The obvious alternative is to stop shipping `.mcp.json` in the Claude plugin and have its bootstrap write a repo-scoped entry the way the Cursor branch does — then Cursor would have nothing to import. It is not being done: that trades a contained, honest failure (one imported server comes up with its repository tools withheld, with a reason on stderr) for a change to how MCP reaches an already-published plugin, moving it from "bundled with the plugin" to "written by the bootstrap", which shifts the first-session timing for every existing Claude install. The guard above is the whole fix; `claude-plugin/` stays as it is. Do not "complete" this by removing that manifest without a fresh decision.

**The Cursor plugin hits the same trap and escapes it without an exception, because Cursor's own MCP config is repo-scoped.** A plugin-declared `mcp.json` would resolve its relative cwd against the plugin root exactly as on Codex, so `cursor-plugin` likewise ships **none** — but `.cursor/mcp.json` lives in the worktree, so the ordinary `cursorRegistrar` is already the right writer. `Installer`'s `pluginHost === "cursor"` branch calls `registerRepoMcpHosts` with a cursor-only `DetectedHosts` plus the matching git-exclude entry, inside the same `repoHooksOnly` block that gates Claude's `.claude/**` writes. **That branch is what turned `upsertJsonMcpServer` into a per-session hot path**, so it now carries the same contract `upsertCodexMcpServer` already had: return before touching anything when the write would change nothing, and write atomically when it would. Both are needed for the same reason — the file is mostly OTHER tools' configuration, so an unconditional rewrite makes concurrent sessions last-writer-wins over the whole file, normalises the user's formatting away, churns the host's file watcher, and risks truncating their other servers on a torn write. Measured before the fix: `.cursor/mcp.json`'s mtime tracked each session start exactly. The no-op check compares **content, not bytes** — it re-renders the parsed file through the same serialiser *before* inserting the entry and skips when inserting changed nothing. A byte compare against disk was the obvious form and is wrong here: it misses whenever the user's copy differs only in formatting (CRLF from a Windows checkout, a four-space indent), so the guard would never fire on exactly those installs and the per-session rewrite would continue. Comparing content also leaves the user's own formatting alone rather than normalising it on first contact. **And "write atomically" carries a third obligation that the atomic write itself takes away: read the file's mode back and pass it in.** `atomicWriteFile` replaces the target's INODE, so the tmpfile's umask-derived mode rides the rename onto the target — measured, 0600 in and 0644 out — whereas the `writeFile` it replaced overwrote in place and left the mode alone. Every file these two writers touch is another tool's MCP config, holding the commands this machine will spawn and the `env` blocks (tokens included) they carry, so widening one is a silent regression: the content is byte-identical and everything keeps working. `CodexTomlWriter` already read the mode back for this reason and `JsonMcpWriter` now does too; a new atomic writer aimed at a file Jolli does not own is a review blocker without it. The two differ deliberately on CREATION — Codex's `config.toml` gets 0600 because that writer may be what puts it on a fresh machine, while the JSON writers keep node's umask default, which is what they have always produced; tightening someone else's file on first contact is a separate decision from preserving what they already chose. No detector is consulted (the code is running inside a Cursor session, so Cursor is present by construction) and no *global* host is touched — a Cursor plugin install has no business configuring Gemini or Copilot. `startMcpServer`'s cwd refusal covers `**/.cursor/plugins/` as the backstop.


### The jolli mcp proxy / per-worktree daemon — full rules

- **The singleton key is the WORKTREE root, not the repo.** Sibling worktrees share an orphan branch and a Memory Bank folder, so a per-repo daemon was ~7x better still and is *not* blocked by the storage globals — but `dispatchTool(cwd, …)` takes its cwd from the closure and five of the ten tools are branch- or worktree-scoped, so collapsing siblings would answer for the wrong branch, silently. Rejected on that, not on feasibility.
- **The socket path is a HASH of the normalised worktree root** ([`McpDaemonProtocol.ts`](src/mcp/McpDaemonProtocol.ts)). A real worktree path blows the 104-byte `sun_path` cap, and normalising first stops a case-insensitive filesystem handing one worktree two daemons.
- **On Windows that address carries a GENERATION suffix, because a retiring daemon there cannot hand its address over.** A unix domain socket's address is a directory entry owned by the listener alone: `close()` unlinks it synchronously while already-accepted connections keep working, so a successor binds the SAME path while the old daemon serves out its last calls (both measured, simultaneously). A named pipe has no path — the NAME is the set of its instances and every accepted connection is one of them, so the successor's `CreateNamedPipeW` + `FILE_FLAG_FIRST_PIPE_INSTANCE` fails `EADDRINUSE` for as long as one client remains. Measured consequence before the fix: after an upgrade, every new session spawned a daemon that died on bind, polled it for the full 15 s `DAEMON_READY_TIMEOUT_MS`, then served a full in-process server — a stall that can outlive a host's `initialize` timeout. **`waitUntilUnreachable` is NOT evidence that an address can be bound**: connect and bind are equivalent predicates on unix and not on Windows, which is exactly how this shipped. So the daemon answers `retire-deferred` ([`canReleaseAddress`](src/mcp/McpDaemonProtocol.ts): win32 and more than the requester attached) and keeps listening, while the proxy relocates the successor to the next generation — reproducing the unix outcome rather than evicting anyone. Two rules in [`nextScanAction`](src/mcp/McpDaemonProtocol.ts) carry the "one daemon per worktree" invariant that the OS can no longer enforce (a second live generation is now legal, so nothing else stops a third): EVERY generation is probed before any spawn — a freed generation 0 does not mean nobody is serving, its successor may be one address up — and the spawn takes the LOWEST free generation, or the chain creeps and abandons generation 0 for good. **Generation 0 is spelled exactly as it was before generations existed**, or an upgraded proxy and a live older daemon would sit on two addresses. Exhausting the scan falls back in-process; it never attaches to a daemon known to be superseded. One bounded gap remains by construction: an incumbent from a pre-deferral bundle cannot answer, so the FIRST upgrade past one still costs that stall once per worktree.
- **The dist version travels in the handshake, never in the path.** Baking it into the socket name would permanently split the double-registration case this ticket exists to collapse (a session registering both the plugin bundle and the repo dist carries two different versions). Instead the daemon greets first with its **`__CLI_PKG_VERSION__`** — the CORE version `DistPathWriter` compares, never `__PKG_VERSION__`, which is a surface's own release number and would rank the Claude plugin's 1.0.x above a strictly newer 0.99.x core. A strictly-newer proxy answers `retire`; **a tie attaches**, which is what makes same-version sessions share instead of evicting each other in a loop. The Windows generation suffix above is not a hole in this rule: a generation is a dynamically allocated slot, not a version, so same-version sessions still converge on one daemon — and two DIFFERENT versions coexisting for a while is what unix has always done here.
- **Every path that cannot reach a daemon ends in `startMcpServer`** — the exact pre-existing single-process behaviour, and there is no other terminal, so treat the rule as relational rather than memorising a list. It covers the three proxy-side refusals (local-agent child, plugin-bundle cwd, not-a-worktree cwd), an unsafe socket dir, a peer whose first line is unparseable or speaks a foreign protocol, a `hello.cwd` that does not fold to ours (hash collision), an address answering `retire-deferred`, every generation probed and deferred, a spawn that never came up, and the step budget exhausted. `JOLLI_MCP_NO_DAEMON=1` skips the proxy entirely rather than falling through it (an env var, not a flag, because the host registrations write a fixed `mcp` argv). **The proxy makes the server cheaper, never absent — except for exactly two of those terminals.** `startMcpServer` refuses the local-agent-child and plugin-bundle cwds itself, so those sessions get NO server at all; that is the intended signal, and it is why the proxy does not restate their stderr text.
- **Nothing binds until every cwd guard has run — and the daemon's `prepareMcpRuntime` builds the WHOLE runtime first** (storage, search index, push client, plus the best-effort network manifest fetch), because that is where the two shared guards live. A refused directory must leave no socket behind: a bound-then-refusing daemon looks reachable to every future proxy, which is strictly worse than the documented fallback. **There are three checks, not two, and only two are shared.** `isLocalAgentChild` and `isPluginBundleCwd` are `prepareMcpRuntime`'s, so both the proxy and the daemon get them; the third, `isWorktreeRoot === false`, exists in the proxy ALONE — it is about keying a shared daemon, not about serving at all (a cwd from `resolveProjectDir`'s non-git fallback hashes every such session onto one daemon rooted at `/`). It is also the only one the proxy speaks for: its stderr line is written BEFORE the other two are consulted, and their refusal text stays owned by `startMcpServer` so nothing double-prints. stderr, never stdout — a stray byte on stdout desynchronises the session's JSON-RPC framing.
- **A degraded platform manifest is not cached.** The manifest fetch is best-effort, so a network blip yields an empty list; in a one-shot server that cost one session its 22 platform tools, but cached in a daemon it would cost *every* session on the worktree until reap, with nothing in `tools/list` to say so. `McpRuntime.platformDegraded` marks it and the daemon retries **only** the platform half (never the storage half) on the next connection.
- **Two import graphs are load-bearing and pinned by source-shape tests** (the pattern `DaemonServer.test.ts` established). `Cli.ts` must reach `Api.js` and the telemetry stack by `await import`, and `McpProxy.ts` must stay leaf-only and reach `startMcpServer` dynamically. A static import in either type-checks, lints clean and leaves every test green — it just silently puts the proxy back to a 62 MB steady state (or a ~198 MB launch peak, if it ends up running `main()`, whose `loadPlugins()` alone dynamically imports three plugin packages). `resolveProjectDir` and `isPluginBundleCwd` were extracted to [`core/ProjectDir.ts`](src/core/ProjectDir.ts) and [`mcp/McpCwdGuard.ts`](src/mcp/McpCwdGuard.ts) for this reason; their old homes re-export them.
- **`unref()` is correct in the daemon and fatal in the proxy.** While the proxy polls for a spawned daemon, the retry timer is the only handle on its event loop — an unref'd one lets Node exit silently with code 0 and the host just sees its MCP server vanish. The daemon has a listening socket holding the loop, so unref'ing its reap timer is what stops it outliving its purpose.
- **Both ends forward with `pipe()`, for backpressure, not brevity.** A `search` / `recall` result is routinely hundreds of KB; the hand-rolled `on("data") → write()` this replaced discarded `write`'s return value, so a host reading its stdio slowly made the proxy buffer without bound — in the one process whose entire purpose is to stay at the bare-Node floor. The end-of-stream asymmetry lives in the options: stdin→socket keeps `pipe`'s default `end` propagation (the half-close is wanted, and is safe only because each session owns its socket), while socket→stdout passes `{ end: false }` — this process's stdout must outlive one daemon connection.
- **The `hello.cwd` assertion must fold exactly what the socket hash folds.** Both go through `sameWorktreeRoot` / `normalizePathForCompareOn` on the SAME platform. A raw `!==` there is not a stricter check, it is an inconsistent one: two spellings of one worktree hash to a single socket, so the session reaches the right daemon and is then rejected as a hash collision — stranded in-process for its whole life, with a log line naming a collision that never happened.
- **Windows has NO socket-ownership protection, and that is a known limitation rather than a decision.** `isManagedSocketDirSafe` returns `true` and `isInManagedSocketDir` returns `false` on `win32`, so the shared-`/tmp` gate compiles to a no-op there. `\\.\pipe\` is a machine-global namespace, libuv binds with the default DACL, and the first binder wins (`FILE_FLAG_FIRST_PIPE_INSTANCE`), so on a multi-user Windows box (RDP / terminal server) another local user can squat this worktree's pipe name and become its MCP server. The exposure is not only reading `recall` / `search` queries — it is injecting arbitrary tool results into an agent's context. `hello.cwd` cannot detect it: computing the pipe name already requires knowing the cwd. Node/libuv exposes no `SECURITY_ATTRIBUTES`, so the fix would be putting a per-user secret (mode-0600 under `~/.jolli/`) into the pipe NAME, so the name cannot be derived at all — not into the handshake, which can only notice the squat after the squatter has already won. Not implemented; do not describe the current state as "no directory to police, so nothing to check".
- **The socket suites in `McpDaemon.test.ts` / `McpProxy.test.ts` are `describe.skipIf(win32)`.** They bind a real listener at a filesystem path, which Windows cannot do — and since they await `onListening`, which the `listen` error path never fires, it presents as a HANG, not a red test. CI is ubuntu-only, so nothing catches it. This is a stopgap: real coverage needs the harness to bind `\\.\pipe\<unique>`, plus separate handling for the two suites whose subject is unix-only anyway (the ownership gate above, and the on-exit unlink, which has no file to remove). Any `McpDaemonProtocol` case that does not pass an explicit `platform` must assert per-platform — three of them silently asserted the REVERSE of their own name on Windows before this was found.


### Push channel (refresh notifications) — full rules

#### Push channel: one watch list, two hosts, a growing set of kinds

JVM hosts have no in-process way to notice a write, so the CLI pushes `refresh`
notifications at them. [`computeWatchTargets`](src/daemon/DaemonServer.ts) is
the single list of what is watched, and it is armed by **two** processes:
`jolli daemon` (standalone) and `jolli ide-bridge-serve` (the long-lived bridge
`CliDaemonClient` owns, which is what actually runs today —
`DaemonNotificationClient.start()` no longer spawns anything and survives purely
as the plugin-wide listener registry, fed by `injectRefresh`). Both build their
payload with `buildRefreshParams`, so a host receives the identical line
whichever is running. Add a target in one place; never inline a second list.

Read the kinds off `RefreshKind` rather than off a count here — the set has grown
(`memory-db` is the most recent), and one declared kind (`memory-bank`) still has
no watch target and is never emitted, so "declared" and "produced" are different
lists. Three things about them are easy to get wrong:

- **`queue` / `orphan-ref` / `memory-db` / `memory-bank` are commit-time; `working-context` /
  `claude-plans` are mid-session.** Only the first group can change installation
  state, and only that group should reach IntelliJ's `refreshStatus()` — a
  `@Synchronized` method wrapping a whole `ide-bridge status` round-trip that
  then fans out to every status listener. The context kinds take
  `JolliMemoryService.refreshWorkingContext()`. An **unknown** kind must keep
  falling through to the status path: the protocol treats a new kind as a
  compatible extension, and heavier-than-necessary is the safe way to be wrong.

  **IntelliJ therefore has two listener lists, and which one a panel joins is a
  real decision.** `addStatusListener` is fifteen subscribers wide and most of
  them answer a question `plans.json` cannot change — `CommitsPanel` re-runs
  `rev-parse` + `merge-base` + `log` + per-commit orphan reads, and
  `ActiveConversationsPanel` re-aggregates every transcript source's SQLite. The
  narrow `addWorkingContextListener` has exactly two: the CONTEXT list and the
  Working Memory review. A panel may be on **both** — `PlansPanel` is, because it
  also gates on `status.enabled` — and that is not a double-refresh:
  `refreshStatus` fires only the status list and `refreshWorkingContext` only the
  narrow one, so an event reaches each panel once. Putting a commit/memory panel
  on the narrow list, or a context panel on only the status list, silently un-does
  this. `PinnedPanel` is on **neither**, and that is deliberate rather than an
  oversight: it renders entirely from `pins.json`, whose title and badge were
  snapshotted at pin time, and touches `plans.json` only to resolve a click
  target — so no working-context event can change what it paints. Whoever writes
  `pins.json` refreshes it directly.

  **Both debounces escalate, never overwrite.** `DaemonNotificationClient` (for
  the push channel) and `JolliMemoryService.scheduleDebouncedRefresh` (for the
  VFS fallback) each collapse a burst onto ONE timer. Rather than carrying
  separate sticky flags, both share the rule in [`RefreshEscalator`]
  (intellij/src/main/kotlin/ai/jolli/jollimemory/core/RefreshEscalator.kt), an
  `AtomicBoolean` that records the pending refresh type. Last-writer-wins is the
  bug it looks like: an agent that commits at the end of its turn emits
  `orphan-ref` when the summary lands and `working-context` when the StopHook
  rewrites `plans.json` moments later, and demoting there drops the status
  refresh with nothing polling to recover it — the just-created memory simply
  never appears in the sidebar. Escalation is one-way on purpose.
- **`claude-plans` is the one kind that carries a payload** (`params.names`), and
  the one place this channel is not purely "reload from source of truth".
  `~/.claude/plans/` is machine-global and holds every project's plans ever, so
  re-listing it cannot answer "what is new?" — only the OS create event can, and
  it dies with the event. Names are raw directory entries, never slugs: the
  slug / markdown / existence / project-affinity decisions are rules and stay in
  `plans-register-new`. Every open project's daemon sees every project's plans;
  attribution is `isPlanFromCurrentProject`'s job, not the watcher's.
- **Both context targets are filename-gated, and a gated watcher drops a nameless
  event.** `.jolli/jollimemory/` also holds `debug.log`, which is written many
  times a second — an ungated watcher there would refresh the client continuously.
  `fs.watch` may omit the filename on some platforms; when it does, the gate
  cannot be honored, so `DaemonWatcher` stays silent rather than firing blind.
  IntelliJ's own VFS watcher on `plans.json` is deliberately kept as the
  independent fallback for that case (and for a host with no Node at all).
- **One working-context signal does NOT come from this channel at all.** A
  markdown note references the user's own file *in place*, and `NoteService`
  derives the row's `lastModified` from that file's mtime — so editing it
  reorders the CONTEXT list with no write to `plans.json` and no event in
  `~/.claude/plans/`. VS Code catches it with `onDidSaveTextDocument`
  ([`Extension.ts`](../vscode/src/Extension.ts)); IntelliJ catches it by matching
  `.md` VFS writes against `detectNotes`' `filePath` set. Both ask the CLI which
  files back a note rather than guessing from the path.

The kind strings are a cross-language contract: `RefreshKind` in
[`DaemonProtocol.ts`](src/daemon/DaemonProtocol.ts) and `RefreshKinds` in
[`DaemonNotificationClient.kt`](../intellij/src/main/kotlin/ai/jolli/jollimemory/bridge/DaemonNotificationClient.kt).
A rename on the TS side that is not mirrored fails **silently** — the kind stops
matching, the light-refresh branch never runs, and the panel just goes back to
being slow. `DaemonNotificationClientTest` pins the Kotlin literals; keep the two
in lockstep. `DAEMON_PROTOCOL` does **not** need a bump for a new kind or a new
optional param field — a bump makes old clients disconnect outright, which is a
worse outcome than an old client falling through to the status path.


### VS Code bundles the CLI / dist-path indirection — full rules

#### VS Code extension bundles the CLI

`vscode/esbuild.config.mjs` produces two CJS bundles in `dist/`: `Extension.js` (with `vscode` external) and `Cli.js` plus each hook script (`PostCommitHook.js`, `StopHook.js`, …). Both bundles inline modules from `cli/src/**` directly. Consequences:

- VS Code source frequently imports across packages with paths like `../../../cli/src/core/JolliApiUtils.js` — these resolve at bundle time. Don't try to "clean these up" into a published-package import.
- `import.meta.url` in `cli/src/install/Installer.ts` is replaced with a real `__filename` expression by esbuild so the Installer can locate hook scripts relative to the bundle at runtime.
- **A module's "am I the entry point?" guard must check the entry file's BASENAME**, not just compare paths. That rewrite points every inlined module's `import.meta.url` at the *bundle*, which is also `argv[1]` — so a path comparison is true for every module in the bundle, and any module that self-runs on that condition executes as a side effect of being imported. This has shipped twice: `QueueWorker` (imported by three git hooks) carries the basename gate for this reason, and `SessionStartHook` lacked it — every plugin bootstrap imports it, so its `main()` ran inside them and wrote its plain-text briefing to stdout ahead of the bootstrap's JSON, which Codex rejects outright (`hook: SessionStart Failed`, no briefing reaches the model) while Claude Code just showed it twice. Unit tests cannot see this (no bundle, and `VITEST` short-circuits the guard), so every guard is pinned by a source-shape test instead. Five modules carry one today: those two plus `CodexPluginBootstrapHook`, `CursorPluginBootstrapHook` and `McpLauncher`, which nothing imports yet — the guard is what keeps importing them a safe thing to do, and for the bootstrap a stray stdout write is exactly what Codex rejects.
- jollimemory core is pure ESM, but the VS Code extension host requires CJS — esbuild handles the bridging.

Hook installation uses dist-path indirection. Repo hooks are source-neutral: they call `"$HOME/.jolli/jollimemory/run-hook" <hookType>` (`RUN_HOOK_SHELL` / `buildHookCommand` in [`HookSettingsHelper.ts`](src/install/HookSettingsHelper.ts)), `run-hook` maps the hook type to a script name and then delegates to `resolve-dist-path`, which enumerates `~/.jolli/jollimemory/dist-paths/<source>`, picks the highest available version, and returns the winning dist for `run-hook` to exec. Each per-source file is two lines, `<version>\n<absolute-path>`, with the source tag coming from the filename. The older single `dist-path` file (`source=<tag>@<version>\n<absolute-path>`) is still parsed for backward compatibility but is no longer what surfaces write. Because every surface writes its own `dist-paths/<source>` entry, version comparison across surfaces is what picks the winner, not install order.

**Source selection (plugin bundles).** Every install source competes on version — there is no hard pin. At a version **tie** the winner is the global `SOURCE_PREFERENCE_ORDER` (`["cli","vscode","cursor"]`), so an equal-versioned `cli` beats the plugin's own bundle; `claude-plugin` is deliberately not in that order, so it only wins by a strictly-higher version or when nothing in the order is installed. `JOLLI_DIST_PREFER_SOURCE=<source>` still exists in the CLI as a general soft-prefer override (it wins a tie ahead of the preference order when set), but **no shipped surface sets it** — the plugin's interactive `run-cli` recipes were deliberately changed to invoke `run-cli` *without* it so cli wins same-version ties (team decision). Repo-installed Git and Claude Agent hooks are deliberately source-neutral and byte-identical across CLI, VS Code, and Claude Plugin; they call `run-hook`, which chooses the highest complete registered runtime. The Plugin manifest registers only `PluginBootstrapHook`; that bootstrap installs the canonical Stop/SessionStart hooks into `.claude/settings.local.json` through `run-hook`. `SOURCE_PREFERENCE_ORDER` stays `["cli","vscode","cursor"]`; neither plugin tag is a global preference. Do not bake `JOLLI_DIST_PREFER_SOURCE` into Git or Agent hooks, and do not restore direct manifest business hooks.

All of the above holds for `codex-plugin` identically — same competition, same absence from the preference order, same source-neutral repo hooks (its manifest registers only `CodexPluginBootstrapHook`). Two hosts do change one thing: a version tie between two sources that are BOTH outside `SOURCE_PREFERENCE_ORDER` used to be near-hypothetical and is now routine. `pickBestDistPath` resolves it by list order, so `traverseDistPaths` **sorts** `readdir` output — without that, the TypeScript resolver and the shell `resolve-dist-path` (which globs, and POSIX glob expansion is collation-sorted) could pick different winners from the same directory. That sort is a determinism guarantee, not host isolation: never make behavior depend on *which* bundle wins, only on the choice being stable.

**Node resolution in `run-hook` / `run-cli` is PATH-first with a recorded-runtime fallback.** When the git process PATH has no `node` (GUI git clients — SourceTree, IntelliJ's own commit UI, etc. — launch git with a minimal PATH that lacks nvm/homebrew/volta), the dispatchers fall back to `~/.jolli/jollimemory/node-path`: a one-line plain-text file holding the absolute path of the runtime the IntelliJ plugin's `NodeRuntime` verified (written/deleted in lockstep with `node-info.json`). Plain text because POSIX sh cannot robustly parse the JSON record (Windows path escaping). The fallback only `-x`-checks the recorded path — it must never spawn `node --version`, because `prepare-commit-msg` runs on the blocking commit path. When adding writers of `node-info.json`, always write/delete the `node-path` sibling too; when changing the dispatcher templates in [`DispatchScripts.ts`](src/install/DispatchScripts.ts), keep the PATH-first order (interactive shells keep their own version-manager choice) and the silent-exit policy (hooks never block git).


### Pushable context kinds — full rules

#### Pushable context kinds are table-driven

Everything a commit summary can push alongside itself (plans, notes, external references, …) is declared as a **`ContextKindDefinition`** under [`cli/src/core/push/`](src/core/push/) and registered in the one list in [`kinds/index.ts`](src/core/push/kinds/index.ts). `ContextPush.ts` holds the generic engine (cross-commit ownership, the push loop, URL write-back, batch assembly) and `ContextKindRegistry.ts` validates definitions and owns all read/write-a-field-by-name narrowing. Modelled on `SourceDefinition` + `BUILTIN_DEFINITIONS` + `SourceDefinitionRegistry`, which solves the same "one more variant" problem for reference sources.

- **Adding a kind = one definition + one entry in `CONTEXT_KIND_DEFINITIONS`.** Nothing in `JolliMemoryPushOrchestrator`, `PushExecutor`, the VS Code `JolliPushOrchestrator`/`LiveShareController`, or the batch path should need touching; if it does, the generic layer is missing an affordance — add it there rather than special-casing a kind. Registry **order is user-visible** (it is the per-summary push order).
- **Identity is data; only `title`/`body` are functions.** `field` / `entryKey` / `baseKey` / `recency` / the doc-state field names are declared as names, not accessors, so the registry can validate them. Every *item-level* one is typed `ItemField<T>` (= `Extract<keyof T, string>`), so a typo — or a `Types.ts` rename that misses `kinds/index.ts` — is a compile error rather than a silent degradation (`readString` returns `""` for an absent field by design, so runtime validation can only reject `""`). `field` alone stays a plain `string`: it names a `CommitSummary` array, and the synthetic kinds the coverage tests depend on declare fields no `CommitSummary` has. `AnyContextKind` keeps plain strings, so the erased form and every registry accessor are unaffected. Omitting `docIdField`/`docUrlField` gets the uniform `jolliDocId`/`jolliDocUrl`; the three legacy kinds override them with their historical names so stored summaries need no migration — a NEW kind should use the uniform names.
- **`docType` is a `string` on the wire, not a union** (both `PushPayload` and the VS Code `JolliPushPayload`). The server's supported-docType config is the authority and rejects an unknown tag with `412 doctype_not_allowed` → `DocTypeNotAllowedError`. That error is deliberately **not** in `REPO_WIDE_REFUSAL_NAMES` and must never be mapped onto `PermissionDeniedError`: it short-circuits one KIND for the rest of **that summary's** push (the loop `break`s per call, so a branch push re-attempts the kind on the next summary and logs once per summary), because making it repo-wide would let one missing config row stop the repo pushing anything. On the batch endpoint the same refusal arrives as a per-attachment `ok:false` + `errorCode` inside a 2xx body, so it is logged there rather than thrown.
- `assignOwnedAttachments` and `applyPlanUrls`/`applyNoteUrls`/`applyReferenceUrls` survive only as **legacy adapters** over the generic functions, kept because the existing test assertions are the evidence the generic engine reproduces the old per-kind behaviour. Don't extend them for a new kind. Same for the named-field `AttachmentSelection` / `OwnedAttachmentMaps` shapes — the canonical forms are the docType-keyed maps. **No surface may spell its own `["plan","note","reference"]` list.** That literal lives once, as `LEGACY_NAMED_DOC_TYPES` in `ContextPush.ts`, and both named shapes are expanded by `legacyNamedSelection` / `legacyNamedOwnership`, which walk the registry so a kind the named shape cannot express becomes an *explicit* "push none" instead of an absent key. A per-surface copy is precisely what made the branch-share and live-share paths skip `skill`: a named selection is a COMPLETE answer, so an outdated list is silent. The expansion also asserts every legacy docType is still registered — a kind renaming its `docType` would otherwise leave the adapters emitting a key no kind matches, and the keys are strings, so nothing type-checks it. The reverse direction is deliberately *not* an error: `skill` is absent from the list because the frozen `{plans, notes, references}` shape has no field for it, and "push none" is the only safe default (falling back to the summary's own items would double-publish a kind that dedupes across commits). Production passes the map form only; the named shapes are test-compat.
