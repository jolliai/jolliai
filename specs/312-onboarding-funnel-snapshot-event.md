# 312. Onboarding Funnel Snapshot Event

## Topic Statement

`onboarding_progressed` answers one product question — *after someone installs, where do they stall before memories get generated: the key or the repo?* — as a **content-free snapshot** of where one repo context sits on a four-checkpoint path (installed → in a git repo & enabled here → a capture route exists → memories exist). The payload is six keys: four booleans, one enum discriminator, and one coarse count bucket; no path, repo name, URL, or key ever enters it. Because it is a snapshot rather than a transition, it would fire on every trigger, so it is deduplicated against an on-disk ledger at `<cwd>/.jolli/jollimemory/onboarding-progress.json` holding a `|`-joined state signature and an ISO timestamp: emit iff the signature changed **or** the recorded timestamp is ≥24 h old. The emitter ([`cli/src/core/OnboardingFunnel.ts`](../cli/src/core/OnboardingFunnel.ts)) short-circuits on the consent gate *before* any git or status work, serializes the read→decide→write cycle per ledger path so VS Code's uncoordinated `refresh()` fan-out cannot double-emit, and swallows every error at two layers. IntelliJ carries a hand-maintained Kotlin mirror ([`OnboardingFunnel.kt`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/telemetry/OnboardingFunnel.kt)) that deliberately dedups against a **separate** ledger file, hardcodes `in_git_repo`, writes non-atomically, and logs on failure — four divergences with no automated drift guard between the two implementations.

## Scope

**In scope:**
- The funnel state tuple, the six-key payload, the `CaptureMethod` discriminator, and how it is derived.
- The dedup ledger: its location, record shape, tolerated corruption, and the 24-hour heartbeat.
- The state signature and the one field deliberately excluded from it.
- The ordered emit pipeline: consent short-circuit, the manual-disable gate, per-path serialization, capture-route resolution, the non-git short-circuit, status resolution, the dedup decision, emit-then-persist, and the double error swallow.
- The manual-disable gate's position, the two readers it consults and why neither alone suffices, and the observability trade-off the gate's position accepts.
- Every call site on every surface, and what each one passes.
- The CLI ↔ VS Code ↔ IntelliJ divergences, including the ones that change what the funnel can observe.

**Out of scope:**
- The telemetry envelope, the event-name registry, and the property scrubber (spec 205).
- The on-disk event buffer and the flush/upload path (spec 204).
- The consent gate itself — how `enabled` is resolved from config, env, and platform state (spec 203).
- Telemetry bootstrap and command instrumentation (spec 206).
- What `getStatus()` computes and what `jolli status` prints (spec 58).
- `resolveLlmCredentialSource`'s own precedence rules (spec 10).
- Each trigger site's product behavior: `jolli enable` (spec 57), `jolli status` (spec 58), the guided front door (spec 265), the topic-ingest pipeline (spec 152).
- Backend aggregation per `install_id` — no backend code lives in this repo.

## Data Contracts

### The funnel state tuple

`OnboardingFunnelState` ([`OnboardingFunnel.ts:60-73`](../cli/src/core/OnboardingFunnel.ts)):

```ts
interface OnboardingFunnelState {
	readonly inGitRepo: boolean;         // is the cwd inside a git working tree at all?
	readonly repoEnabled: boolean;       // hooks installed here; always false when not in a git repo
	readonly captureConfigured: boolean; // captureMethod !== "none"
	readonly captureMethod: CaptureMethod;
	readonly memoriesGenerated: boolean; // summaryCount > 0
	readonly memoriesBucket: BucketLabel;
}
```

`CaptureMethod` (`:57`) is `"local-agent" | "anthropic" | "jolli" | "none"`.

### The event payload

Six keys, snake_case, emitted at [`OnboardingFunnel.ts:242-249`](../cli/src/core/OnboardingFunnel.ts):

```jsonc
{
  "in_git_repo":        true,
  "repo_enabled":       true,
  "capture_configured": true,
  "capture_method":     "jolli",   // discriminator: local-agent | anthropic | jolli | none
  "memories_generated": true,
  "memories_bucket":    "6-20"     // 0 | 1-5 | 6-20 | 21-100 | 100+
}
```

The registry entry ([`TelemetryEvents.ts:41`](../cli/src/core/TelemetryEvents.ts)) names the same six props and marks `capture_method` as the discriminator. `memories_bucket` comes from `bucket(summaryCount)` ([`Telemetry.ts:165-171`](../cli/src/core/Telemetry.ts)), which maps a non-finite or non-positive count to `"0"`.

### The dedup ledger

```jsonc
{ "sig": "true|true|jolli|true|6-20", "tsIso": "2026-08-01T12:00:00.000Z" }
```

- **Path**: `join(getJolliMemoryDir(cwd), "onboarding-progress.json")` — `LEDGER_FILE` at `:149`, joined at `:213`. `getJolliMemoryDir` ([`Logger.ts:201-204`](../cli/src/Logger.ts)) is a plain `join(base, ".jolli", "jollimemory")` against the **literal** cwd passed in, with no git-root walk of its own.
- **Read tolerance** (`readLedger`, `:173-181`): unreadable file, unparseable JSON, or a record missing either a string `sig` or a string `tsIso` all read as **absent** — which is treated as "first emit".
- **Write**: `mkdir(dir, { recursive: true })` then `atomicWriteFile` (`:250-257`). Atomic because a torn ledger reads back as absent, i.e. as "first emit" — so a crash mid-write must produce a duplicate send at worst, never a permanently-stale skip.
- **Heartbeat**: `HEARTBEAT_MS = 24 * 60 * 60 * 1000` (`:151`).
- **IntelliJ uses a different file**: `onboarding-progress.intellij.json` ([`OnboardingFunnel.kt:41`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/telemetry/OnboardingFunnel.kt), joined at `:90`), with the same 24 h heartbeat (`:42`). Its own docstring (`:31-36`) names this as the one deliberate deviation: the IntelliJ surface dedups independently and can never desync the TS-side ledger that CLI and VS Code share.

### The state signature

Five fields joined by `|` ([`OnboardingFunnel.ts:163-171`](../cli/src/core/OnboardingFunnel.ts)):

`inGitRepo | repoEnabled | captureMethod | memoriesGenerated | memoriesBucket`

`captureConfigured` is deliberately **excluded**: it is a pure function of `captureMethod`, so including it could never distinguish two states. The Kotlin mirror builds the identical five-element list (`OnboardingFunnel.kt:88-89`), substituting `summaryCount > 0` for `memoriesGenerated`.

### Config source

Every trigger reads the **machine-global** config. `loadConfig()` is `loadConfigFromDir(getGlobalConfigDir())` ([`SessionTracker.ts:517-519`](../cli/src/core/SessionTracker.ts)); the sites that already hold a config pass one loaded the same way (`StatusCommand.ts:525-526`, `StatusStore.ts:133`), and the Kotlin path calls `SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())` (`OnboardingFunnel.kt:81`). There is no per-repo capture config in this funnel.

## Behavior

### The emit pipeline, in order

| # | Step | Site | Behavior |
|---|---|---|---|
| 1 | Consent short-circuit | `OnboardingFunnel.ts:212` | `if (!getTelemetryContext()?.enabled) return;` — **before** git, `getStatus()`, the lock map, and the ledger. An uninitialized or opted-out install pays nothing and writes no ledger. Kotlin: `Telemetry.isEnabled()` at `OnboardingFunnel.kt:74`, before even the config round-trip. |
| 1b | **Manual-disable gate** | `OnboardingFunnel.ts:253` | Returns when the repo carries the durable "leave this project alone" opt-out (spec 145) — after the consent short-circuit, **before** the ledger path is even computed, so a disabled repo emits nothing and creates no ledger file. **Both readers are consulted** (`isManuallyDisabled() \|\| readManualDisableFlagSync(cwd)`) because neither alone covers every trigger: the in-memory mirror is free but process-local and set only by the editor host, so on its own it left every CLI trigger recreating the ledger in a disabled repo; the synchronous disk reader is the durable truth those CLI processes need. It must be the **sync** reader — the async one persists a legacy-marker migration decision, i.e. a write, which is exactly what this gate exists to prevent. Its main-worktree resolution is memoized per cwd, so steady-state cost is one file read. **No Kotlin equivalent** — see Cross-surface divergence. |
| 2 | Per-ledger serialization | `:192`, `:215-217`, `:220-223` | A module-level `Map<ledgerPath, Promise>` chains each call onto the previous for the **same** ledger path; distinct repos run concurrently. The entry is deleted in a `finally` only when this run is still the tail, so the map cannot grow unbounded. |
| 3 | Resolve the capture route | `:84-96`, `:118-119` | `captureMethodOf` collapses `resolveLlmCredentialSource` ([`LlmClient.ts:222-242`](../cli/src/core/LlmClient.ts)): `local-agent`→`local-agent`, `jolli-proxy`→`jolli`, `anthropic-config`/`anthropic-env`→`anthropic`, `null`→`none`. `captureConfigured = captureMethod !== "none"`. Using the *same* function that drives generation is what keeps the funnel from drifting from reality. |
| 4 | Non-git short-circuit | `:120-130` | `isInsideGitRepo(cwd)` ([`GitOps.ts:980-983`](../cli/src/core/GitOps.ts)) false → return with `inGitRepo`, `repoEnabled`, `memoriesGenerated` all false and `memoriesBucket: "0"`, while **preserving** the already-resolved `captureConfigured` / `captureMethod`. `getStatus()` is never called. |
| 5 | Status | `:131-136`, `:137` | Uses `opts.status` when the caller precomputed one; otherwise `await import("../install/Installer.js")` — a lazy import that breaks the static `Installer ⇆ OnboardingFunnel` cycle — and calls `getStatus(cwd)`. A missing `summaryCount` reads as `0`. |
| 6 | Derive the last two fields | `:143-144` | `memoriesGenerated = summaryCount > 0`; `memoriesBucket = bucket(summaryCount)`. |
| 7 | Dedup decision | `:236-241` | `changed = !prev || prev.sig !== sig`. `elapsed = prev ? now - Date.parse(prev.tsIso) : +Infinity`; `stale = !Number.isFinite(elapsed) || elapsed >= HEARTBEAT_MS`. Return early iff `!changed && !stale`. An absent ledger yields `+Infinity`, and an unparseable `tsIso` yields `NaN` — the `!Number.isFinite` arm treats **both** as stale, so a garbled timestamp re-emits rather than pinning the ledger forever. |
| 8 | Emit, then persist | `:242-257` | `track("onboarding_progressed", …)` first, `mkdir` + `atomicWriteFile` second. |
| 9 | Never throws | `:258-260`, `:209`, `:218-219` | `emitOnce` swallows everything. `maybeEmitOnboardingProgress` wraps its **whole** body — including the `getTelemetryContext()` call — in its own `try`, so even a Telemetry module mocked down to just `track` cannot throw into the caller. `resolveOnboardingFunnel` itself **rejects** on a git or status failure (`:110-116`); the swallow lives only in the caller. |

### Trigger sites

Seven call sites across three surfaces:

| Surface | Site | What it passes | Notes |
|---|---|---|---|
| CLI — `jolli enable` | [`EnableCommand.ts:569`](../cli/src/commands/EnableCommand.ts) | `{ cwd: options.cwd, config: await loadConfig() }` | Tail of `reportEnableResult`, reached on **both** the success and the failure branch, so the non-git failure path reports `in_git_repo: false`. Config is re-loaded because the interactive provider flow may have just added a capture route. **Not** reached under `--repo-hooks-only`, which returns earlier (`:431-439`). No precomputed status. |
| CLI — guided front door | [`GuidedFrontDoor.ts:94`](../cli/src/commands/GuidedFrontDoor.ts) | `{ cwd, config: await loadConfig() }` | The non-git dead end, fired just before `process.exitCode = 1`. The only trigger that deliberately runs in a non-git directory. |
| CLI — guided front door | `GuidedFrontDoor.ts:118` | `{ cwd, config, status: { enabled, summaryCount } }` | Past the git gate, reusing the front door's lightweight status so the heavy `getStatus()` probe is skipped. Fires for every path past the gate, including the user who declines to enable. |
| CLI — `jolli status` | [`StatusCommand.ts:529`](../cli/src/commands/StatusCommand.ts) | `{ cwd: options.cwd, config, status }` | The already-computed `status`, so no extra git work. **Not** reached in `--json` mode, which prints and returns at `:504-507` — so the VS Code/IDE status probes that use `--json` never emit through this path. |
| CLI — ingest drain | [`IngestRunStore.ts:59-61`](../cli/src/core/IngestRunStore.ts) | `{ cwd, config: await loadConfig() }` | Guarded by `if (record.ingested > 0)`; idle drains skip it. Ingest only runs with a working provider, so this trigger structurally never reports `capture_method: "none"`. |
| VS Code | [`StatusStore.ts:138`](../vscode/src/stores/StatusStore.ts) | `{ cwd: this.bridge.cwd, config: this.config, status: this.status }` | Fire-and-forget (`void`) at the tail of `refresh()`, reusing the status and config just computed. |
| IntelliJ | [`JolliMemoryService.kt:822`](../intellij/src/main/kotlin/ai/jolli/jollimemory/services/JolliMemoryService.kt) | `OnboardingFunnel.maybeEmit(basePath, newStatus)` | Inside `refreshStatus()`, after `cachedStatus` is updated and listeners notified. |

The plugin additionally spawns the bundled CLI's `jolli enable` — `enableIntegrations` and `enableFull` in [`CliIntegrations.kt:323`](../intellij/src/main/kotlin/ai/jolli/jollimemory/bridge/CliIntegrations.kt) and `:335` — which reaches `EnableCommand.ts:569` and therefore emits a second snapshot attributed to `surface="cli"`. This is the only plugin-spawned CLI path that emits: the `ide-bridge status` operation calls `getStatus` directly with no funnel emit ([`IdeBridgeCommand.ts:1137-1141`](../cli/src/commands/IdeBridgeCommand.ts)).

### Cross-surface divergence

| Behavior | CLI | VS Code | IntelliJ |
|---|---|---|---|
| Trigger sites | 5 (enable, front door ×2, status, ingest) | 1 (`StatusStore.refresh()`), fired from ≥5 uncoordinated callers — e.g. `Extension.ts:1888, 1951, 2335, 2444, 2499, 4324` | 1 (`JolliMemoryService.refreshStatus()`) |
| Ledger file | `onboarding-progress.json` (shared TS emitter) | same file, same TS emitter (bundled via `../../../cli/src/core/OnboardingFunnel.js`) | separate `onboarding-progress.intellij.json` |
| `in_git_repo` | resolved by `isInsideGitRepo` (an upward-walking `git rev-parse --git-dir`); **can be false** | same code, but in practice always true — the extension activates on `workspaceContains:.git` and returns early at `Extension.ts:459` when the workspace root has no `.git`, so `StatusStore` never constructs outside a repo | **hardcoded `true`** (`OnboardingFunnel.kt:80`), documented as safe because the sole caller already returned early at `JolliMemoryService.kt:788-796` when `.git` is absent |
| Can report the "installed, never in a repo" drop-off | yes (front-door dead end, and the non-git `enable` failure path) | no | no |
| Concurrency control | per-ledger promise chain (`OnboardingFunnel.ts:192`) | same chain; relies on it, since `refresh()` is fire-and-forget with no in-flight guard | none in the funnel — the sole caller is `@Synchronized` (`JolliMemoryService.kt:782-783`) |
| Ledger write | `atomicWriteFile` (temp + rename) | same | non-atomic `File.writeText` after `parentFile?.mkdirs()` (`OnboardingFunnel.kt:126-129`) |
| Failure handling | silent double swallow (outer `maybeEmit…` + inner `emitOnce`) | same | a single `catch (e: Exception)` that **logs a warning** (`OnboardingFunnel.kt:109-111`) |
| `ANTHROPIC_API_KEY` read | `process.env` (inside `resolveLlmCredentialSource`) | same | injected `HookEnv` (`OnboardingFunnel.kt:56`, `:60`), per the JVM global-state contract |
| Manual-disable gate | yes (step 1b) | same code, same gate | **none** — the Kotlin mirror's only precondition is telemetry consent. A repo the user disabled from any surface therefore keeps emitting snapshots from the IDE and keeps rewriting its own separate ledger file, while the CLI and VS Code triggers have gone silent for the same repo |

## State Transitions

| From | Event | To | Notes |
|---|---|---|---|
| Telemetry uninitialized / opted out | Any trigger | Unchanged | Returns at `:212` before git, status, the lock map and the ledger. No ledger file is created. |
| Repo carries the durable manual-disable opt-out | Any TS trigger | Unchanged | Returns at `:253`, before the ledger path is computed. No event, no ledger file, no ledger update. The IntelliJ mirror has no such gate and proceeds normally. |
| No ledger for this path | Any trigger, consent on | Ledger written with the current signature | `prev` absent ⇒ `changed` true ⇒ emit. |
| Ledger present, same signature, `<24 h` old | Any trigger | Unchanged | The only path that returns without emitting (`:241`). The state was still resolved first. |
| Ledger present, same signature, `≥24 h` old (or unparseable `tsIso`) | Any trigger | Ledger timestamp refreshed | Heartbeat re-emit; the payload is identical to the previous one. |
| Ledger present, different signature | Any trigger | Ledger replaced | Fires on regression exactly as on progress. |
| Ledger present | `track()` succeeds but the ledger write throws | Unchanged | The inner `catch` swallows it; the next trigger re-emits (a duplicate, not a loss). |

## Notable Behavior

- **The event is a snapshot, not a transition, and there is no monotonicity anywhere on the client.** No "highest checkpoint reached" is recorded — the ledger holds only the *latest* signature. A regression re-emits exactly like progress: disabling the repo, removing the API key, or switching `aiProvider` to one with no credential all change the signature and send a fresh snapshot with the checkpoint bits going *down*. Any "did this install ever reach checkpoint N" question is a backend aggregation over the stream, not a client-side fact. (Surprising; the name `onboarding_progressed` reads like a forward-only transition.)
- **A deduped trigger still costs a git subprocess.** The state is resolved *before* the ledger is read (`:234-236`), so `isInsideGitRepo` — and, where no status was precomputed, a full `getStatus()` — runs on every trigger past the consent gate, including the overwhelming majority that then return at `:241` having sent nothing. The consent short-circuit at `:212` is the only free path.
- **Ledger fragmentation duplicates sends — the opposite consequence from the telemetry buffer's.** Both key off the *literal* cwd rather than the git root ([`Logger.ts:201-204`](../cli/src/Logger.ts)). For the buffer, a subdirectory cwd **strands** events in a fragment nothing flushes; for this ledger, it **duplicates** them — two subdirectory cwds under one repo yield two ledgers, one extra first emit, and two independent daily heartbeats. Documented and accepted at `OnboardingFunnel.ts:33-44` on the grounds that every shipped trigger passes a repo-root or workspace-root cwd; the file names the fix if that ever stops being true (anchor the ledger to the git common dir). Spec 311 is the mechanism that keeps those cwds at a root. (Surprising; the same cwd contract has opposite failure modes on the two files that share the directory.)
- **A failed ledger write produces a duplicate, never a loss.** `track()` runs before the persist (`:242` then `:250-257`) and the inner `catch` swallows a write failure (`:258-260`), so the event is already buffered when the ledger fails; the next trigger sees no (or a stale) ledger and emits again. The atomic write exists for the same reason at a finer grain — a torn file reads back as absent (`:173-181`), i.e. as "first emit".
- **`captureConfigured` is on the wire but not in the signature.** It ships in the payload (`:244`) because the backend funnel is defined in terms of it, and is excluded from the dedup key (`:163-171`) because it is `captureMethod !== "none"` and therefore carries no information the key doesn't already have. Both implementations agree on this.
- **This is one of only two emitters that read the consent context directly.** Everywhere else, `track()` being an inert no-op when uninitialized or opted out ([`Telemetry.ts:107-108`](../cli/src/core/Telemetry.ts)) is enough. Here it is not: the *work* leading up to the emit — a git spawn, a `getStatus()`, a ledger read, a ledger write — must not happen for an opted-out user, so `getTelemetryContext()?.enabled` is checked first. The only other direct consumer is the QueueWorker's AI-source-seen gate ([`QueueWorker.ts:3794`](../cli/src/hooks/QueueWorker.ts)), which guards a disk write for the same reason.
- **The funnel is gated on the manual-disable opt-out, and the gate's POSITION costs the funnel the one drop-off it most wants to see.** The gate sits after the consent short-circuit and before emission, so a disabled repository sends nothing and writes no ledger — closing the ledger's status as a repo-local file write into a repo the user asked to be left alone (spec 304's zero-write contract). The stated cost: because the gate precedes `track()`, disabling also silences the `repo_enabled: false` snapshot that would have *recorded* the disable. **The last snapshot on record for a disabled repository permanently says "enabled", and nothing ever supersedes it.** Gating only the ledger persist was rejected as a fix — the dedup ledger would then go unread, turning every status refresh into a fresh emit — and the zero-write promise was taken as the stronger of the two. Recovering the signal would need a one-shot emit at the disable *gesture*, which does not exist. (Surprising; the funnel's own blind spot is the event it was built for.)
- **The gate consults two readers, and dropping either one reopens a real hole.** The in-memory mirror is free but process-local and set only by the editor host, so on its own the interactive CLI triggers and the queue worker's ingest trigger all kept recreating the ledger in a disabled repository. The synchronous disk reader covers those — and must stay the *synchronous* one, because the asynchronous reader persists a legacy-marker migration decision, i.e. exactly the write the gate exists to prevent. Its repository-root resolution is memoized per cwd precisely because this is not a once-per-process seed: the editor reaches it from every status refresh, including two file watchers that fire repeatedly while an AI session is live.
- **The Kotlin mirror has no manual-disable gate at all.** A repository disabled from any surface goes quiet on the CLI and editor triggers while the IDE surface keeps emitting snapshots and keeps rewriting its own separate ledger — so the same disabled repository is simultaneously silent and chatty depending on which surface refreshes status. (Surprising; the two implementations now differ in *whether the event fires*, not merely in how it is recorded.)
- **`jolli status --json` never emits.** The JSON branch returns at [`StatusCommand.ts:504-507`](../cli/src/commands/StatusCommand.ts), before the funnel call at `:529`. Since `--json` is the machine-readable form the editor surfaces consume, the CLI's `status` trigger observes only interactive human use. (Surprising; the two output modes of one command differ in whether they emit telemetry.)
- **The IntelliJ mirror can never observe the first checkpoint.** `in_git_repo` is hardcoded `true` (`OnboardingFunnel.kt:80`), justified by the caller's earlier `.git` check. The comment records why it is not a shallow `File(cwd, ".git").exists()` instead: that probe would wrongly report false from a subdirectory, disagreeing with the CLI's upward-walking `isInsideGitRepo`. The consequence is that the "opened the IDE, never in a repo" drop-off is invisible on IntelliJ — and, for a different reason (early activation return), on VS Code too. Only the CLI's front-door dead end and non-git `enable` failure can report it.
- **There is no automated TS ↔ Kotlin drift guard.** [`OnboardingFunnelTest.kt`](../intellij/src/test/kotlin/ai/jolli/jollimemory/core/telemetry/OnboardingFunnelTest.kt) covers `captureMethodOf` and nothing else — four cases pinning the provider precedence against `resolveLlmCredentialSource`. Payload key names, the signature's field list and order, the heartbeat constant, and the ledger record shape are unpinned on the Kotlin side. Renaming a payload key or reordering the signature in the TS source would compile and ship on both surfaces while silently splitting the event stream in two. (Surprising given how many other cross-language contracts in this repo are test-pinned.)

## Shared Behavior

- The telemetry envelope, event-name registry, and property scrubber are owned by spec 205.
- The on-disk event buffer, its cwd fragmentation, and the flush/upload path are owned by spec 204.
- The consent gate (`getTelemetryContext()?.enabled` and how it is resolved) is owned by spec 203.
- Telemetry bootstrap and the command-level auto-emit are owned by spec 206.
- `getStatus()` and the `jolli status` surface are owned by spec 58.
- `resolveLlmCredentialSource`'s precedence rules are owned by spec 10.
- `jolli enable` is owned by spec 57; the guided front door by spec 265; the topic-ingest pipeline by spec 152.
- The durable manual-disable opt-out — its three fields, its read precedence, its two readers, and the memo on the synchronous one — is owned by spec 145; the zero-write contract this gate serves, and the telemetry carve-outs that survive it, by spec 304. This spec owns only the gate's position in the pipeline and the trade-off that position accepts.
- Anchoring the cwd each trigger passes to a git worktree root is owned by spec 311.
