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
| [Installer.ts](src/install/Installer.ts) | Installs/removes git hooks and MCP server registrations. Git hooks: Claude Code `StopHook`/`SessionStartHook`, Gemini `AfterAgent`, `post-commit`, `prepare-commit-msg`. MCP: `registerRepoMcpHosts` / `registerGlobalMcpHosts` / `removeRepoMcpHosts` drive per-host `McpHostRegistrar` implementations across eleven hosts — repo-scoped (Claude `.mcp.json`, Cursor `.cursor/mcp.json`) and global-scoped (Gemini `~/.gemini/settings.json`, Codex `~/.codex/config.toml`, OpenCode, Copilot CLI, VS Code Copilot Chat, Cline, Devin CLI, Antigravity, Kimi Code). Non-Claude registrars are gated on the host's **presence on disk**, deliberately a weaker predicate than the readability-gated detector that governs session discovery. Uninstall removes only the two repo-scoped registries: dropping a global entry would break MCP for every other repo on the machine. |
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

Since 0.99.14 Jolli records **which AI host ran the work** and **how the command was reached**. These are several *orthogonal* dimensions that share one vocabulary but are computed by independent code paths — the easiest thing to get wrong is to conflate them. The shared vocabulary is `TRANSCRIPT_SOURCES` ([Types.ts](src/Types.ts)) — the 13 hosts `claude` / `codex` / `gemini` / `opencode` / `cursor` / `cursor-cli` / `copilot` / `copilot-chat` / `cline` / `cline-cli` / `devin` / `antigravity` / `kimi`. `TelemetryAgent = TranscriptSource` is an alias, not a copy.

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
