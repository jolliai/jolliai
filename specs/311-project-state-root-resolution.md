# 311. Project State-Root Resolution

## Topic Statement

Several entry points receive a working directory they did not choose — an agent hook's payload `cwd`, an `CLAUDE_PROJECT_DIR` env var, a `jolli mcp` server launched by an AI host, a bare `jolli <cmd>` typed in a terminal. That directory drives where `<projectDir>/.jolli/jollimemory/` lands, so a subdirectory `cwd` silently forks a second, independent per-project state store whose sessions, cursors, plans, briefing cache and telemetry buffer never join the repo's real one. `resolveStateRoot(cwd)` ([`cli/src/core/GitOps.ts:55-73`](../cli/src/core/GitOps.ts)) is the one rule that closes that: spawn `git rev-parse --show-toplevel` with the candidate as the child's cwd, take non-empty trimmed stdout as the state root, and fall back to the input **verbatim** on anything else — empty output, a non-zero exit, a missing `git`, a nonexistent directory. The result is memoized per exact input string and never invalidated in production. `--show-toplevel` deliberately returns the *current* worktree root, so a linked `git worktree` checkout anchors to its own root rather than the main one — the opposite axis from the repo-wide profile anchor (spec 145), which uses `--git-common-dir` precisely to be shared across worktrees. Two things are deliberately never anchored: an explicitly-passed `--cwd` (the user named the target) and the Memory Bank root `kbRoot` (rooting it would collapse multiple Memory Bank entries into an enclosing repo's `.jolli/`).

## Scope

**In scope:**
- `resolveStateRoot(cwd)`: its algorithm, its silent-failure contract, its per-input memo, and `resetStateRootCache`'s test-only role.
- The full case table — what each kind of input directory resolves to, verified against real `git`.
- Which entry points anchor their implicit cwd, and which deliberately take theirs verbatim.
- The second, independent implementation of the same rule (`resolveProjectDir`) and the third inlined one, and the fact that nothing pins them in lockstep.
- Prior state stranded under a subdirectory `.jolli/` by the pre-anchoring behavior: what materialized it, and why nothing reads, migrates, or cleans it.

**Out of scope:**
- What each anchored entry point then *does* with the resolved root — the Stop hook's session recording (spec 26), the SessionStart briefing (spec 27), the Gemini AfterAgent hook (spec 28), debug-log placement (spec 131), and the MCP server's tool surface (spec 148).
- The Memory Bank root's own resolution (`KBPathResolver` / `resolveKBPath`) — specs 151 / 173. This spec only records that it must **not** be run through the resolver.
- The repo-wide profile's `--git-common-dir` anchor and the `manuallyDisabled` flag it carries (spec 145).
- The telemetry buffer's own cwd contract and flush (spec 204) and the consent gate (spec 203); this spec owns only the anchoring of the cwd handed to them.
- The queue, its entries, and the worker's drain semantics — this spec records only that the worker takes its `--cwd` verbatim.

## Data Contracts

### The resolver

```ts
// cli/src/core/GitOps.ts
export function resolveStateRoot(cwd: string): string
export function resetStateRootCache(): void   // test-only
```

`resolveStateRoot` returns an absolute path suitable to be joined with `.jolli/jollimemory/`. It never throws and never writes. Its two documented prohibitions live in the function's own docstring ([`GitOps.ts:41-44`](../cli/src/core/GitOps.ts)):

- **Only** for project-cwd entry points whose cwd is implicit and may be a subdirectory.
- **Never** on an explicit Memory Bank root (`kbRoot`) — that path is already the exact target and must be used verbatim (`SearchIndex.resolveIndexDir`, `MultiRepoCompile`), and anchoring it would collapse multiple Memory Bank entries into an enclosing repo's `.jolli/`.

### The memo

```ts
const _stateRootCache = new Map<string, string>();   // GitOps.ts:25
```

Keyed by the **exact input string**, not a normalized or realpath'd form — two spellings of one directory are two entries resolving to the same value. Both the success and fallback answers are cached (`GitOps.ts:71` runs on every path), so a non-git directory costs exactly one failed `git` spawn per process. There is no TTL and no eviction; `resetStateRootCache()` ([`GitOps.ts:28-30`](../cli/src/core/GitOps.ts)) exists solely so test cases don't leak resolved roots into each other.

### The subprocess

`execFileSyncHidden("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })`. The `stdio` triple is load-bearing: without a piped stderr, git's `fatal: not a git repository …` reaches the user's terminal on every non-git invocation even though the throw is already handled. `execFileSyncHidden` ([`cli/src/util/Subprocess.ts:116-122`](../cli/src/util/Subprocess.ts)) spreads `{ windowsHide: true }` under the caller's options and passes **no** `env`, so the child inherits `process.env` in full — which is why the ambient `GIT_DIR` / `GIT_WORK_TREE` can override the answer (see the case table).

## Behavior

### Resolution algorithm

| Step | Line | Behavior |
|---|---|---|
| 1 | `GitOps.ts:56-57` | Memo hit on the exact input string → return the cached value; no subprocess. |
| 2 | `:59-66` | Spawn `git rev-parse --show-toplevel` with `cwd` as the child's working directory, stderr piped. |
| 3 | `:67` | Non-empty trimmed stdout → that is the state root. git prints the toplevel in forward-slash form on every platform, so no `toForwardSlash` normalization is needed. |
| 4 | `:67` | Empty trimmed stdout → keep the input verbatim (`root` was initialized to `cwd` at `:58`). |
| 5 | `:68-70` | Any throw — non-zero exit, `git` missing, nonexistent `cwd` → keep the input verbatim. Swallowed silently. |
| 6 | `:71-72` | Memoize the answer under the input string and return it. |

### Case table

Verified against real `git` (`git rev-parse --show-toplevel`, exit codes observed):

| Input directory | git result | `resolveStateRoot` returns |
|---|---|---|
| Subdirectory of the main worktree | prints the main worktree root, exit 0 | the main worktree root |
| Subdirectory of a **linked** `git worktree` | prints **that linked worktree's** root, exit 0 | the linked worktree's own root — *not* the main one |
| A bare repository | `fatal: this operation must be run in a work tree`, exit 128 | the input verbatim |
| Inside a repo's `.git/` directory | `fatal: this operation must be run in a work tree`, exit 128 | the input verbatim |
| A directory with no enclosing repo | `fatal: not a git repository …`, exit 128 | the input verbatim |
| A nested checkout / submodule working tree | prints the **inner** repo's root, exit 0 | the inner repo's root |
| Any directory, with `GIT_DIR` + `GIT_WORK_TREE` set in the environment | prints the **env-designated** work tree, exit 0 | the env-designated work tree — the ambient environment wins over the filesystem |
| A nonexistent directory | `execFileSync` throws `ENOENT` before git runs | the input verbatim (a nonexistent path) |

### Anchored entry points

Every one of these has an implicit cwd it did not choose:

| Entry point | Site | What it anchors |
|---|---|---|
| Claude Stop hook | [`StopHook.ts:72`](../cli/src/hooks/StopHook.ts) | `process.env.CLAUDE_PROJECT_DIR`, resolved before stdin is read so `setLogDir` can run early. |
| Claude Stop hook | `StopHook.ts:103` | the payload `hookData.cwd ?? process.cwd()`, used only when the env var was absent. |
| Claude SessionStart hook | [`SessionStartHook.ts:253`](../cli/src/hooks/SessionStartHook.ts) | the payload `cwd ?? process.cwd()`. This hook also joins `.jolli/` onto `projectDir` directly for the briefing cache and plan reads. |
| Gemini AfterAgent hook | [`GeminiAfterAgentHook.ts:48-49`](../cli/src/hooks/GeminiAfterAgentHook.ts) | `GEMINI_PROJECT_DIR ?? CLAUDE_PROJECT_DIR`. |
| Gemini AfterAgent hook | `GeminiAfterAgentHook.ts:84` | the payload `hookData.cwd ?? process.cwd()`. |
| CLI bin shim | [`Cli.ts:31`](../cli/src/Cli.ts) | `setLogDir(resolveProjectDir())` — before anything logs or buffers telemetry. |
| CLI bin shim | `Cli.ts:45` | `bootstrapTelemetry({ cwd: resolveProjectDir() })`. |
| CLI bin shim | `Cli.ts:65` | `flushTelemetryNow(resolveProjectDir(), …)` on command exit. |
| `jolli mcp` | [`McpCommand.ts:22`](../cli/src/commands/McpCommand.ts) | `resolveProjectDir()` once, feeding `createStorage(cwd, cwd)` (`:28`), `SearchIndex.rebuild(cwd, storage)` (`:34`), and `startMcpServer(cwd)` (`:38`). |
| MCP server startup | [`McpServer.ts:245`](../cli/src/mcp/McpServer.ts) | `setLogDir(cwd)` on the already-resolved cwd, placed **after** the local-agent re-entry guard (`:236-239`) and **before** storage init (`:251`) — the guard must not create a store it then declines to use, and storage must not resolve before the logger knows where it lives. |

The two hooks that anchor twice do so because the env var and the payload are independent sources; the env var wins when present (`StopHook.ts:103`, `GeminiAfterAgentHook.ts:84` both read `envProjectDir ?? …`), and the fallback `?? process.cwd()` guards a payload that omits `cwd` (typed non-optional, but JSON-sourced).

Anchoring also improves a downstream read: `readManualDisableFlag(projectDir)` ([`StopHook.ts:109`](../cli/src/hooks/StopHook.ts), [`SessionStartHook.ts:257`](../cli/src/hooks/SessionStartHook.ts)) now receives the worktree root rather than a subdirectory, so the profile lookup it drives (spec 145) starts from the right place.

### Deliberately un-anchored inputs

| Input | Site | Why verbatim |
|---|---|---|
| A command's `--cwd` value | [`ExportCommand.ts:245`](../cli/src/commands/ExportCommand.ts), [`CleanCommand.ts:136`](../cli/src/commands/CleanCommand.ts), [`QueueStatusCommand.ts:34`](../cli/src/commands/QueueStatusCommand.ts) | The user named the target explicitly. Note the option's *default* is already `resolveProjectDir()`, so the implicit case is anchored and the explicit case is honored — `setLogDir(options.cwd)` uses whatever value survived. |
| The QueueWorker's `--cwd` | [`QueueWorker.ts:4113`](../cli/src/hooks/QueueWorker.ts) | Passed by the enqueuing hook, which already ran with the worktree top level as its cwd. |
| `kbRoot` | [`SearchIndex.ts:259-260`](../cli/src/core/SearchIndex.ts) (`resolveIndexDir` → `getJolliMemoryDir(storage?.kbRoot ?? cwd)`) | Anchoring it would collapse multiple Memory Bank entries into an enclosing repo's `.jolli/` (rationale at `GitOps.ts:41-44`). |

### The five git hooks, which did not change

`post-commit`, `prepare-commit-msg`, `post-rewrite`, `post-merge` and `pre-push` all take `process.cwd()` verbatim — [`PostCommitHook.ts:210`](../cli/src/hooks/PostCommitHook.ts), [`PrepareMsgHook.ts:141`](../cli/src/hooks/PrepareMsgHook.ts), [`PostRewriteHook.ts:228`](../cli/src/hooks/PostRewriteHook.ts), [`PostMergeHook.ts:144`](../cli/src/hooks/PostMergeHook.ts), [`PrePushHook.ts:369`](../cli/src/hooks/PrePushHook.ts) — as does the worker they spawn. This is safe for a reason external to this code: git invokes repo hooks with the worktree top level as the process cwd, so the same guarantee the resolver enforces is already enforced by git. The result is one invariant with two independent enforcement mechanisms, and the git-hook family is the half that carries no code for it.

## State Transitions

| From | Event | To | Notes |
|---|---|---|---|
| No memo entry for `cwd` | `resolveStateRoot(cwd)` and git prints a toplevel | Entry = that toplevel | One `git` spawn. |
| No memo entry for `cwd` | `resolveStateRoot(cwd)` and git throws / exits non-zero / prints nothing | Entry = `cwd` verbatim | One failed `git` spawn; nothing logged, nothing on stderr. |
| Memo entry present | `resolveStateRoot(cwd)` again | Unchanged | Cached value returned; no subprocess. |
| Memo entry present | The directory later becomes (or stops being) a git repo | Unchanged | Never invalidated in production. |
| Any | `resetStateRootCache()` | Empty map | Test-only; no production caller. |

## Notable Behavior

- **The same rule has three independent implementations, and nothing pins them in lockstep.** `resolveStateRoot` (keyed memo, explicit `cwd` argument) is one. `resolveProjectDir` ([`CliUtils.ts:149-164`](../cli/src/commands/CliUtils.ts)) is a second: same `git rev-parse --show-toplevel`, same piped-stderr trick, same fall-back-to-input contract — but it takes **no** cwd argument (git inherits the process cwd) and caches into a **single unkeyed slot** (`_cachedProjectDir`, `:147`), which is exactly why it is the right one for a CLI process that resolves one root for its lifetime and the wrong one for a hook that must resolve a payload-supplied path. A third, async instance is inlined in [`PluginBootstrapHook.ts:62-66`](../cli/src/hooks/PluginBootstrapHook.ts) — `isInsideGitRepo` then `execGit(["rev-parse","--show-toplevel"])`, bailing to `null` rather than falling back. No test, lint rule, or grep gate holds the three together. (Surprising; two of them are byte-comparable in intent and differ only in memo shape.)
- **The memo is never invalidated in production.** A long-lived process — the `jolli mcp` server most of all — that resolved a path *before* it became a git repository keeps the pre-repo answer for its entire lifetime, and vice versa. `git init` in a directory an MCP server already touched does not re-home its state. `resetStateRootCache` exists but has no production caller.
- **The environment can override the filesystem.** With `GIT_DIR` + `GIT_WORK_TREE` set, `git rev-parse --show-toplevel` reports the env-designated work tree regardless of where the process actually stands, and `execFileSyncHidden` passes no `env` so the child inherits them ([`Subprocess.ts:116-122`](../cli/src/util/Subprocess.ts)). Under a git hook that sets these (or a wrapper that does), the state root follows the environment. (Surprising; the resolver looks purely path-driven.)
- **Resolution is silent by contract.** `GitOps.ts:49-53` states the reason: successfully anchoring a subdirectory to its root is the *correct* path, this runs once per hook process, and `warn` is never suppressed — so a user-visible notice would repeat on every process and pollute stderr for a non-event. The failure path is equally silent because the fallback is a legitimate answer for a non-git directory.
- **A bare repository and the `.git/` directory itself both fall back, for the same git-side reason.** Both exit 128 with `fatal: this operation must be run in a work tree`. This is a different failure mode from "not a repository" but produces an identical result: the input verbatim. Contrast `isInsideGitRepo` ([`GitOps.ts:980-983`](../cli/src/core/GitOps.ts)), which uses `--git-dir` and therefore returns **true** for both.
- **Linked worktrees anchor to themselves; the repo-wide profile does not.** `--show-toplevel` returning the *current* worktree is the property this resolver wants (a `.claude/worktrees/*` checkout keeps its own `.jolli/`), and it is exactly the property `RepoProfile.resolvePaths` ([`RepoProfile.ts:73-82`](../cli/src/core/RepoProfile.ts)) rejects — it uses `--git-common-dir` and its comment names `--show-toplevel` as the thing that "returns the CURRENT worktree, breaking sharing". Two anchors on two different axes on purpose: per-worktree state here, repo-wide decisions there.
- **Orphaned prior state is left in place, undetected.** There is no migration, no fallback read, and no detection of a `.jolli/jollimemory/` that the pre-anchoring behavior created under a subdirectory. Such stores were genuinely materialized: `saveSession` calls `ensureJolliMemoryDir(cwd)`, which is a recursive `mkdir` ([`SessionTracker.ts:63-66`](../cli/src/core/SessionTracker.ts), invoked at `:78`), and `saveBriefingCache` creates its own directory ([`SessionStartHook.ts:610-613`](../cli/src/hooks/SessionStartHook.ts)). `debug.log` was self-limiting — `enqueueLogWrite` stats the directory and skips the write when it is absent, explicitly so logging never creates `.jolli/` on its own ([`Logger.ts:315-319`](../cli/src/Logger.ts)). Nothing reads the old location back: `getJolliMemoryDir` is a plain `join` with no search ([`Logger.ts:201-204`](../cli/src/Logger.ts)). Nor is there a cleanup surface — `jolli clean`'s three targets are stale sessions, stale queue entries, and a stale `squash-pending.json` ([`CleanCommand.ts:7-10`](../cli/src/commands/CleanCommand.ts)), and `DoctorCommand.ts` contains no `.jolli` scan at all. `GitOps.ts:52-53` calls surfacing stray stores "a separate, marker-gated concern"; no such marker exists in the codebase today. Net effect: an inert `<subdir>/.jolli/jollimemory/` remains on disk, and any telemetry events buffered into it are permanently stranded. (Surprising; the fix is forward-only by design and the cleanup it defers to was never built.)
- **`--cwd` defaults are anchored even though `--cwd` values are not.** The commands above declare `.option("--cwd <dir>", …, resolveProjectDir())`, so the default is a resolved root while an explicitly-passed value is honored verbatim. The distinction is "did the user name it", not "is it a `--cwd`".

## Shared Behavior

- The repo-wide profile file, its `--git-common-dir` anchor, and `manuallyDisabled` are owned by spec 145.
- The in-memory suppression flag that mirrors `manuallyDisabled` in the editor host is owned by spec 304.
- Debug-log placement, rotation, and leveling are owned by spec 131.
- The telemetry buffer's cwd contract and flush are owned by spec 204; telemetry bootstrap and command instrumentation by spec 206.
- The Memory Bank folder layout and repo-identity folder naming are owned by specs 151 and 173.
- What the Stop, SessionStart, and Gemini AfterAgent hooks do with the anchored root is owned by specs 26, 27, and 28.
- The MCP server's tool surface and startup is owned by spec 148.
- The onboarding-funnel snapshot emitted from several of these anchored cwds is owned by spec 312.
