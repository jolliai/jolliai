# 174. IDE Sync Round Orchestrator

## Topic Statement

A long-lived per-workspace driver schedules background sync rounds on a slow interval, exposes a manual "sync now" surface, mirrors engine phase progress onto a sidebar indicator with a live locked-wait countdown, coalesces overlapping triggers, and survives auth, settings, and lifecycle transitions without leaking work.

## Scope

**In scope:**

- Lazy construction of the round driver after activation, with eager-build attempt on activation and on-demand build the first time a manual trigger is invoked.
- The two independent enable dimensions: manual rounds gated only on signed-in credentials, automatic background rounds additionally gated on a separate user toggle.
- The polling interval: default, clamp floor, clamp ceiling, value source, and the rebuild path that picks up an interval change without reloading the host process.
- The conditional eager-tick decision at start, the persistence-backed freshness threshold that drives it, and the per-workspace-folder key used for that persistence.
- The manual entry point, the in-flight coalescing rule, and the followup latch that ensures a manual click during an in-flight round still results in real work after that round settles.
- Round execution order: a workspace readiness gate, a generation-mismatch check, a manual-disable refusal, a capped await on the per-round initialization barrier followed by a re-check of both of those cancellations, a per-round read of the "include transcripts" preference, the boundary call into the sync engine, the post-round side effects, and the catch-all that turns an unexpected throw into a terminal-error outcome.
- The distinction between the one-shot readiness promise and the per-round initialization barrier, and why the former cannot substitute for the latter.
- The phase-label pipeline: a neutral round-start label, per-phase conversational labels, and the final-state transitions for success, conflicts, transient transport failure, terminal failure, and a round that could not enter because of the global single-flight lock.
- The locked-wait spinner: how engine wait events drive a once-per-second countdown, how the label distinguishes "this device's previous round" from "another device", how a fresh wait event reseats the countdown, and how the countdown stops itself at zero.
- The terminal-failure notification surface: when it fires, what title copy it uses, what message body it uses, what suppression rules apply, and which surface it uses (a separate dismissable notification rather than the in-flight indicator).
- The round-finished broadcast that downstream consumers (tree views, sidebar lists) use for cache invalidation regardless of outcome, and the swallow-and-log policy for a throwing listener.
- The state machine governing the round driver's lifetime: start/stop/dispose/idempotency rules, the generation counter that prevents stale queued ticks from running rounds, and the post-stop preservation of manual capability.
- Per-rebuild leak prevention for the locked-wait timer closure.
- The reconciliation entry point invoked on settings save and on credential events that brings the polling state in line with a fresh read of disk-backed config.
- The cross-device folder-collision warning surface, including its session-scoped deduplication keyed on the canonical pair of folder and identity set.
- Auth-state transitions: sign-out invalidates the cached driver; signing in with a different identity invalidates the cached driver; signing in with the same identity reuses it.
- The activation contract that every failure (including the eager build) must be swallowed so activation never fails.

**Out of scope (boundaries — sent/received only):**

- The reconciliation round itself (separate spec). This driver invokes a single boundary "run one round" call with `cwd`, a reason discriminator, and a transcripts boolean; it consumes a result envelope `{ fetched, pulled, pushed, conflicts[], newState, lastError?, canary? }` and a stream of phase progress events. Round internals — lock acquisition, credential mint, branch recovery, conflict resolution, push retry — are not redescribed here.
- The conflict UI implementation (separate spec). The engine invokes a binary-pick boundary directly; this driver does not handle conflict prompts.
- The host-wide single-flight lock that lets at most one round run at a time across processes (separate spec). The driver sees its outcome only as an immediate `newState: "syncing"` return from the round boundary.
- The persistent backing for the freshness timestamp and for the manual-disable marker (separate IDE host state spec). The driver consumes two thin get/set seams.
- The credential store, key parsing, and origin allowlist that turn the configured API key into a backend identity (separate specs). The driver consumes `{ jolliApiKey, autoSyncEnabled, syncPollIntervalSec, syncTranscripts }` from disk-backed config.
- The status-bar visual itself (separate spec). The driver pushes typed state + detail tuples across that boundary.
- The sidebar activity registry that renders the in-flight phase indicator (separate spec). The driver pushes `{ label, severity: "info" }` or `null`.
- The persistent failure notification surface (separate spec). The driver hands the host a (title, message) pair.
- The IDE host command-registration boundary. This driver exposes a single command id; the command surface that registers it is itself a thin pass-through.
- The pre-round workspace initialization promise. The driver awaits it once per round, swallows its rejection, and continues.
- What the workspace-initialization work actually does, why it is skipped entirely on a manually-disabled startup, and why the enable path re-runs it (spec 100 step 11, spec 215). The driver only awaits the barrier and re-checks its cancellations afterwards.
- The manually-disabled state itself — its durable storage, the process-local gate the refusal reads, and the full inventory of writes it suppresses (spec 145, `specs/304-manually-disabled-zero-write-contract.md`). The driver only reads a boolean, per round.

## Data Contracts

### Driver options (resolved at construction)

- A round-runner boundary handle (the engine instance — only `runRound(opts)` is consumed).
- A status-visual boundary handle (`setSyncState(state, detail?)` plus a sync-ownership-release call invoked by lifecycle disposal in the outer runtime).
- An optional activity-registry handle (`setSyncPhase(payload | null)`). Omission disables the in-flight phase indicator without otherwise changing behavior.
- A workspace identity object exposing an absolute filesystem path for the workspace root.
- An optional polling interval in seconds.
- An optional readiness promise that the round body awaits before invoking the engine; defaults to an already-resolved promise. One-shot: once it settles it is settled for the host's lifetime.
- An optional **per-round initialization barrier**, supplied as a thunk the round body calls to obtain the currently-outstanding workspace-initialization work. Unlike the readiness promise, it is re-consulted at the start of *every* round.

  The one-shot readiness promise cannot do this job. On a startup where the repository was manually disabled, the workspace-initialization body is skipped outright and the promise resolves immediately (see spec 100 step 11) — so by the time the user re-enables, the promise is long since settled and offers no protection at all. The re-enable path then starts a catch-up initialization run that can migrate for minutes, while sync is already unblocked. Without the per-round barrier a round would overlap that run and operate on its half-written output.
- An optional outer round-finished listener.
- An optional persistent-failure notifier `(title, message) => void`.
- An optional timer seam exposing `setInterval(handler, ms) → handle` and `clearInterval(handle)`.
- An optional last-successful-round persistence seam exposing `get() → number | undefined` and `set(ms)`. Omission disables the eager-tick path entirely.
- An optional eager-tick freshness threshold in milliseconds.

### Round invocation envelope (sent across the engine boundary)

- The workspace absolute path.
- A reason discriminator from a fixed set — used by the engine for telemetry only; the driver passes `"poll"` for both scheduled ticks and eager-on-start ticks, `"manual"` for every user-initiated round.
- A boolean indicating whether transcripts are included this round. Always read fresh from disk-backed config at round start.

### Round result envelope (received from the engine boundary)

- `newState`: one of `"syncing" | "synced" | "conflicts" | "offline"`.
- `conflicts`: a list of records (driver only reads the length).
- `lastError`: optional, carrying a stable error code, a human message, and an optional `selfLocked` flag.
- `fetched | pulled | pushed`: three booleans whose load-bearing-ness is conditional (see notable behavior below).
- `canary`: optional `{ symlinked[], unowned[] }` lists.

### Phase progress event (received from the engine boundary)

A single value from a fixed five-member set: `downloading`, `merging`, `resolving`, `uploading`, `waiting`. Multiple engine steps may collapse onto the same phase value; the driver does not track that.

### Locked-wait progress event (received from the engine boundary)

- A 1-indexed attempt number; "1" is the initial mint that just observed a backend "locked" response.
- A total attempt count.
- A wait time in milliseconds before the next retry; zero on the final attempt.
- A human message.
- A `selfLocked` boolean: `true` iff backend evidence proves this device's prior round still holds the backend write lock; `false` for peer-held or unknown.

### Status detail (sent across the status-visual boundary)

Optional fields, omitted when absent:

- A conflict count (only when nonzero).
- A "last error" message string.
- A `failed` boolean and an associated stable failure code (set together, only for terminal codes).
- A self-locked flag (only when the round result's lastError carries `selfLocked === true`).
- Symlinked-canary count and a capped sample.
- Unowned-canary count and a capped sample.

The driver renders `undefined` when every field would be absent.

### Activity-registry payload (sent across that boundary)

Either `null` (clears the in-flight indicator) or `{ label: string, severity: "info" }`. The driver never emits `severity: "error"` — the persistent-failure surface is the dedicated channel for that.

### Polling interval clamp

- Floor: 90 minutes (5400 seconds).
- Ceiling: 24 hours (86400 seconds).
- Default (when value is undefined, non-finite, or `NaN`): 90 minutes.
- A finite-but-out-of-range value is clamped to the nearest bound; fractional values are floored.

### Eager-tick freshness

- Default threshold: 30 minutes.
- Comparison is `now − lastSuccessAt ≥ threshold` (strict ≥, not >).

### Phase labels (rendered into the activity-registry payload)

| Phase event | Label |
|---|---|
| neutral round-start | `Syncing memory bank…` |
| `downloading` | `Sync: Getting latest memories…` |
| `merging` | `Sync: Bringing it together…` |
| `resolving` | `Sync: Sorting out conflicts…` |
| `uploading` | `Sync: Sharing your changes…` |
| `waiting` | `Sync: Another device is syncing — waiting…` |

### Failure-notification titles

Keyed by the most-recent phase before failure, with a separate key for "failed before any phase emitted":

| Phase key | Title |
|---|---|
| before-any-phase | `Sync: Couldn't start` |
| `downloading` | `Sync: Couldn't fetch latest memories` |
| `merging` | `Sync: Couldn't merge changes` |
| `resolving` | `Sync: Couldn't resolve conflicts` |
| `uploading` | `Sync: Couldn't share your changes` |
| `waiting` | `Sync: Personal Space is still locked` |

The notification body is the engine's `lastError.message` verbatim.

### Conflict-summary labels (rendered into the activity-registry payload)

- Zero conflicts: `Sync: Conflicts need your attention`.
- Exactly one conflict: `Sync: 1 conflict needs your attention`.
- Two or more: `Sync: N conflicts need your attention`.

### Locked-wait label

- Peer-locked: `<engine message> (attempt N/M — next retry in Ks)`.
- Self-locked: `Your previous sync left the Personal Space lock held; it is still releasing. Attempt N/M — next retry in Ks`.

`K` decrements once per second from `ceil(nextRetryInMs / 1000)` to zero.

### Persistence key for last successful round

`sync.lastSuccessAt:<absolute workspace path>` — distinct keys per workspace folder, shared across worktrees of the same path.

## Behavior

### Lifecycle: lazy construction and cache invalidation

At host activation, the outer runtime eagerly attempts to construct the driver once. Construction outcome is one of:

1. **Built and cached.** Both preconditions met — a workspace folder exists and credentials are configured — and the boundary engine builder returned a non-null engine. The driver is cached on the runtime for the workspace lifetime.
2. **Dormant.** Either no workspace folder is open, or no credentials are configured, or the engine builder returned null. The cached slot remains empty and a subsequent manual trigger will re-attempt construction.
3. **Eager build threw.** The throw is caught at the runtime layer and logged at warning level. Activation continues. A later manual trigger will re-attempt construction.

After construction, every subsequent invocation of the build entry point first re-reads disk-backed config and applies these branches in order:

1. **No credentials configured.** If a driver was cached, dispose it (releasing its locked-wait timer, the status-visual sync ownership, the last-built poll-interval cache, and the last-built credential-identifier cache); return null.
2. **Different credential identifier than the last build.** Dispose the cached driver (same teardown as above); fall through to the build path with the new identifier. This handles the account-switch case where credentials are still present but represent a different identity.
3. **Driver still cached, same identifier.** Return the existing instance.
4. **Concurrent build in flight.** Both callers share the same in-flight build promise.
5. **Build path.** Resolve the workspace folder. If absent, return null. Construct an instance of the engine via the boundary builder, supplying a forward-declared reference for the phase callback so that engine phase events can route into the driver once it exists. If the engine builder returns null, return null. Otherwise construct the driver, cache it, register it as a host-lifecycle disposable, capture the active poll-interval and credential identifier into the runtime, and conditionally start polling.

When the build path constructs a fresh locked-wait timer closure, the runtime records its disposer in a single live field and pushes a host-lifecycle disposable that reads that field through. The next build path that runs disposes the previous closure before installing the new one. The host-lifecycle disposable becomes a safe no-op after the live field is nulled.

### Manual vs automatic enable

The driver respects two independent boolean preferences resolved from disk-backed config:

- **Manual sync availability.** Gated only on the presence of `jolliApiKey`. If absent, the manual surface shows an informational message pointing the user at sign-in and performs no work.
- **Automatic polling.** Gated on `autoSyncEnabled === true` **AND** the presence of `jolliApiKey`. A driver built while polling is disabled remains alive for manual rounds; polling can be enabled later without rebuilding.

The runtime's reconciliation entry point is invoked on settings save and on credential events. It re-reads disk-backed config and:

1. If the captured poll interval differs from the new value, dispose the cached driver before deciding what to do next (rebuild required so the new interval is captured at construction).
2. If `autoSyncEnabled` is true AND credentials are present, ensure the driver is built then start its polling (idempotent — starts only if not already polling).
3. If credentials have disappeared while a driver was cached, dispose the driver and clear the cache (sign-out path; preserves the auto-sync preference on disk for next sign-in).
4. Otherwise, if the driver was previously polling, stop its polling without disposing — manual capability is preserved.

### Polling loop

`start()` is idempotent and a no-op after disposal. Each successful entry into `start()`:

1. Increments the driver's poll generation counter and captures the new value into a local.
2. Decides whether to fire an eager tick:
   - If no persistence seam was wired, do not fire (preserves a baseline "no eager tick" behavior for callers that never wired persistence).
   - Otherwise consult `lastSuccessAt.get()`. If undefined (cold start, never synced), fire eagerly. If present and strictly stale by at least the freshness threshold, fire eagerly. If fresher, skip.
3. Schedule a recurring timer at the clamped poll interval.

The eager tick uses reason `"poll"` (semantically the first poll firing immediately). Every subsequent timer firing also uses reason `"poll"`. Each scheduled handler invocation captures the generation that armed the timer.

`stop()` is idempotent. It clears the interval handle and increments the generation counter so any tick that is still awaiting the readiness gate will detect a mismatch and bail before invoking the engine.

`dispose()` marks the driver unusable, runs `stop()`, and pushes `null` onto the activity registry if one is wired. After disposal, `start()` is a no-op and `handlePhase()` is a no-op.

### One round

A single round, regardless of trigger, follows this order:

1. **Disposed guard.** If the driver is disposed, return immediately.
2. **Coalesce against in-flight.** If a round promise is already recorded, await it and return without invoking the engine. Concurrent callers therefore all resolve at the same instant as the in-flight round but observe no extra engine work.
3. **Capture pre-tick state.** Record the most-recently-reported `lastState` so it can be restored if the round bails at the generation check, at the manual-disable refusal, or at either of their post-barrier re-checks.
4. **Seed the status visuals.** Set `lastState` to `"syncing"` and push that on the status-visual boundary with no detail. Reset the local "most-recent phase" tracker to absent. Push `{ label: "Syncing memory bank…", severity: "info" }` onto the activity registry if wired.
5. **Begin the round promise.** Store its handle so concurrent callers can coalesce.
6. **Await readiness.** Await the readiness promise; any rejection is caught and discarded.
7. **Generation check.** If the queued-at-generation is defined and does not equal the current generation counter, restore the captured pre-tick state on the status-visual boundary, push `null` to the activity registry, and end the round body. Manual rounds pass an undefined queued-at-generation and skip this check.
8. **Manual-disable refusal.** If the workspace's repository has been manually disabled, refuse the round: restore the captured pre-tick state on the status-visual boundary, push `null` to the activity registry, and end the round body. The three actions are the same three the generation check performs, so a refused round settles back into exactly the end state a tick that never happened would have left — no "syncing" residue on the status visual, no stale in-flight label in the sidebar. (The transient seeded "syncing" label of steps 4–5 is still momentarily visible, exactly as on the generation-mismatch path.) The refusal exists because a round writes: it stages, commits and pushes inside the Memory Bank vault and spawns a background worker afterwards. It is evaluated **per round** rather than once at start, so a disable mid-session silences the very next tick and a later re-enable resumes rounds without rebuilding the driver.
9. **Await the per-round initialization barrier**, if one was supplied, under a **60-second cap** (matching the host's own initialization watchdog) so a hung initialization run degrades to the pre-barrier behavior instead of blocking sync forever. The await re-opens both of the cancellation windows the readiness await opens, so **both** the generation check and the manual-disable refusal are re-evaluated immediately afterwards, with identical handling: a stop that landed while parked here must still cancel a queued poll tick, and a disable clicked while parked here must still silence this round.
10. **Read transcripts preference.** Re-read disk-backed config; the round options' `transcripts` boolean is `cliConfig.syncTranscripts === true` (strict — any non-true value is `false`).
11. **Invoke the engine round.** Pass `{ cwd, reason, transcripts }`. Await the result envelope.
12. **Apply outcome to status visuals.** Push the result's `newState` plus a derived detail (see "Detail derivation") on the status-visual boundary.
13. **Apply outcome to phase indicator.** Push a derived activity-registry payload (see "Phase indicator final state" below).
14. **Broadcast round finish.** Invoke the round-finished listener with `(newState, result)`. A throwing listener is caught and the throw is dropped at debug log level.
15. **Persist last success.** If `newState === "synced"` and the persistence seam is wired, write `now()` to it; a thrown setter is caught and logged at debug.
16. **Catch-all.** Any throw during the body is caught: log the message and stack, synthesize a fallback result `{ fetched: false, pulled: false, pushed: false, conflicts: [], newState: "offline", lastError: { code: "sync_failed_after_retries", message: <caught error message> } }`, apply that as if the engine had returned it (status visuals + phase indicator + round-finished broadcast).
17. **Finally.** Clear the in-flight round promise.
18. **Followup latch.** After the round body settles, if the manual-followup latch is set and the driver is not disposed, clear the latch and recursively invoke a manual round.

### Manual entry point

The host command invokes a thin entry point that:

1. Lazily builds the driver via the runtime's build path. If the result is null (dormant), show an informational message that directs the user to sign in and return.
2. Otherwise delegate to the driver's "request manual sync" method.

The driver's "request manual sync" method behaves as follows:

1. **No round in flight.** Invoke a single round with reason `"manual"` and an undefined queued-at-generation. Await it. Return.
2. **Round in flight.** Set the manual-followup latch to true. Await the in-flight round promise (catching to coalesce timing only). After it settles, if the driver has a new in-flight round (the followup), await that too with the same swallow.

The latch is cleared by the round body **before** the followup round begins. A second manual click during the followup's execution can re-arm the latch and produce another round after the followup.

### Phase indicator final state

The activity-registry push at round end follows this priority:

- **`newState === "synced"`** → push `null` (sidebar idle).
- **`newState === "conflicts"`** → push the conflict-summary label (pluralized; zero-conflict copy is the no-count form) with `severity: "info"`.
- **`newState === "offline"` with a `lastError`**:
  - Always push `null` to clear the in-flight indicator (the round is no longer in flight, so a "syncing…" label would be a lie).
  - If the error code is terminal (anything other than `"network"`), additionally invoke the persistent-failure notifier with title = failure-label keyed by the most-recent-phase tracker (or the "before any phase" key if absent) and body = `lastError.message`.
  - If the error code is `"network"` (transient), do **not** notify; the indicator clear is the only visible side effect.
- **`newState === "syncing"`** (a round that could not enter because the global single-flight lock was held by another process) → push `null`. The seeded "Syncing memory bank…" label is replaced by idle because no real work happened.

### Phase indicator in-flight

The phase callback handler:

1. If the driver is disposed, return immediately (prevents an in-flight engine round from re-setting the indicator after the activity registry has been cleared by disposal).
2. Record the phase into the most-recent-phase tracker (used later by the failure-label keying).
3. Push `{ label: <phase-keyed label>, severity: "info" }` onto the activity registry if wired.

Phase events received outside a round still push their label (the indicator is idempotent; an event arriving outside any round simply updates the label).

### Locked-wait spinner

A separate handler in the outer runtime is wired to engine "locked wait" events. Each event:

1. Clear any previously-scheduled countdown interval.
2. Compute `remainSec = max(0, round(nextRetryInMs / 1000))`.
3. Render immediately: push a status-visual update with state `"offline"` and detail `{ failed: true, failedCode: "vault_locked", lastError: <label>, selfLocked: <verbatim> }`. The `selfLocked` field is only included on the detail when the event's flag is `true`.
4. If `remainSec > 0`, arm a once-per-second interval that decrements `remainSec`, re-renders, and self-clears at zero.
5. If `remainSec === 0` (final attempt edge case), the immediate render is the only write; no interval is armed.

The render label is the peer-locked or self-locked form per the event's `selfLocked` flag, freshly read on every tick so a `selfLocked` value can change between ticks of the same wait if the engine surfaces a new event mid-wait.

The handler exposes a disposer that clears any in-flight interval. The outer runtime keeps a live reference to this disposer and replaces it on every rebuild; the old disposer is invoked before being replaced.

### Detail derivation for the status-visual boundary

For each round result, build a detail object by:

1. If `conflicts.length > 0`, set `conflictCount = conflicts.length`.
2. If `lastError` is present:
   - Set `lastError = lastError.message`.
   - If the error code is terminal (anything other than `"network"`), set `failed = true` and `failedCode = <code>`.
   - If `lastError.selfLocked === true` (strict — `false` and `undefined` both omit), set `selfLocked = true`.
3. If `canary` is present:
   - If `symlinked.length > 0`, set `canarySymlinkedCount` and `canarySymlinkedSample` (sample carried verbatim — already capped at the engine boundary).
   - If `unowned.length > 0`, set `canaryUnownedCount` and `canaryUnownedSample`.
4. If no field is set, return absent (undefined). Callers receive `setSyncState(state, undefined)` in that case.

### Cross-device folder-collision notifications

The engine notifies the outer runtime when the round detects two distinct repo identities mapped to the same vault subfolder. The runtime, per call:

1. For each conflict, canonicalize its identity list (sort lexically) and form a dedupe key `<folder>::<identities joined with "|">`.
2. If the dedupe set already contains the key, skip silently.
3. Otherwise add the key, format a warning message naming the folder, count, and comma-separated identities, and push it onto the host's warning notification surface.

The dedupe set is per-runtime-instance (workspace lifetime). Reloading the host window resets it.

## State Transitions

### Driver lifetime

```
[constructed, not polling, not disposed]
    │
    │  start()       (idempotent)
    ▼
[polling, generation = G]
    │
    │  stop()        (generation++; manual still works)
    ▼
[constructed, not polling]
    │
    │  start()       (generation++)
    ▼
[polling, generation = G']
    │
    │  dispose()
    ▼
[disposed]         (no further work; start/handlePhase are no-ops)
```

### One round

```
[idle, lastState = S₀]
    │ tick(reason, gen)
    │
    │  if disposed → return
    │  if current round in flight → await it; return
    ▼
[in-flight, lastState = "syncing", indicator = "Syncing memory bank…"]
    │ await readiness
    │
    │  if gen ≠ current && gen defined →
    │      restore lastState = S₀; indicator = null; finish
    │  if manually disabled (no manual exemption) →
    │      restore lastState = S₀; indicator = null; finish
    │
    │ await init barrier (60s cap), then RE-CHECK both of the above
    │
    │ read transcripts; call engine.runRound
    │
    ├──→ engine returns ──→ [applying outcome]
    │                           │ setState(newState, detail)
    │                           │ phase-indicator final state
    │                           │ broadcast round-finished
    │                           │ if synced: persist now()
    │                           ▼
    │                       [idle, lastState = newState]
    │
    └──→ engine throws ──→ [synthesize offline + sync_failed_after_retries]
                              │ same three side effects as above
                              ▼
                          [idle, lastState = "offline"]
                              │
                              │ followup latch?
                              │   yes → recursively run with reason="manual"
                              │   no  → end
                              ▼
                          [idle]
```

### Runtime build cache

```
[no cache]
    │ ensureBuilt():
    │   loadConfig() — no jolliApiKey → return null (stay [no cache])
    │   loadConfig() — has jolliApiKey, build succeeds → cache
    ▼
[cached driver, key = K, interval = I]
    │
    ├ ensureBuilt() with same K          → return cached, stay
    │
    ├ ensureBuilt() with no jolliApiKey  → dispose, [no cache]
    │
    ├ ensureBuilt() with key ≠ K         → dispose, build with new key
    │
    ├ reconcileAutoSync() with interval' ≠ I
    │                                    → dispose, then per autoSyncEnabled rebuild
    │
    └ host deactivate                    → dispose
```

## Notable Behavior

### One-sentence test

This spec passes the one-sentence-without-"and" test: "Drive sync rounds in an IDE host." The "and"s in the topic statement enumerate sub-capabilities of that single drive role rather than joining unrelated topics.

### Locked-wait copy uses the raw 1-indexed attempt number

The label renders `attempt N/M` directly from the engine's 1-indexed value. The final attempt's label is `attempt M/M`, never `attempt M+1/M`. (A pre-fix implementation incorrectly displayed `N+1` and ran off the end.)

### `nextRetryInMs` is the upcoming wait, not elapsed time

The countdown decrements from `ceil(nextRetryInMs / 1000)` to zero once per second. It is not "time since wait started"; the engine event re-supplies the next-retry value every time a fresh wait begins.

### Eager tick uses the same reason discriminator as a scheduled poll

The eager-on-start path reports reason `"poll"` to the engine. This is deliberate (it is the first poll firing early, not a new semantic category) and avoids forcing every consumer of the reason discriminator to learn a new value.

### No file-watcher trigger; no post-commit hook trigger

The driver has exactly two trigger sources: scheduled poll and explicit manual call. There is no integration with filesystem watch events on the vault directory, and there is no automatic sync attempt on local commits to the source repo. (Either would risk surprising the user or self-triggering on the driver's own writes.)

### Manual round is exempt from the generation-mismatch bail — but NOT from the manual-disable refusal

Manual rounds pass an undefined queued-at-generation through, so even if the user toggled automatic polling off after the manual click but before the round body started its engine call, the manual round still proceeds. Generation checks are a self-cancellation mechanism for polling, not a global cancel.

The manual-disable refusal is the counterexample that bounds that framing: it carries no manual exemption at all. A user who clicks "sync now" on a repository they have turned off gets a round that restores the pre-tick visual and ends, exactly as a cancelled poll tick would. So the driver has one genuinely global cancel and one that is polling-scoped, and they are checked back to back. The reason for the asymmetry is what each protects: the generation counter protects a *preference* the user can change freely, while the manual disable is a zero-write guarantee about the repository, and a round writes into the vault. See spec 145 and `specs/304-manually-disabled-zero-write-contract.md`.

### The refusal and the cancellation are deliberately indistinguishable from outside

Both the generation-mismatch bail and the manual-disable refusal perform the identical three actions — restore the captured pre-tick state, clear the activity-registry indicator, end the round body — and the barrier's post-await re-checks repeat both with the same handling. The end state after a refused round is therefore the end state of a tick that never happened: no lingering "syncing" state, no stale in-flight label, and no round-finished broadcast, so downstream consumers do not invalidate caches for work that was never done. The only observable difference is the transient seeded label and a log line.

### Followup latch coalescing

Sequence: manual click A while a previous round is in flight → A's `requestManualSync` sets the followup latch and awaits the in-flight round → that round bails at the generation check (user toggled auto-sync off mid-await) → finally runs A's tail → finally sees the latch and recursively invokes a manual round → A's await resolves only after that followup completes.

This sequence is the load-bearing motivation: without the latch, the manual click could land during an in-flight round that subsequently does no work, and the user's click would be silently lost.

### Conflict labels' info severity

A conflict outcome is informational on the activity registry: the status-visual boundary already carries the warning visual via the `conflictCount` detail. The activity registry is reserved for `severity: "info"` from this driver; `severity: "error"` is never emitted by this driver onto the activity registry — terminal failures use the separate notification surface.

### Trust caveat on the round result's three booleans

When a round bails at the catch-all (unexpected throw), the synthesized result's `fetched`, `pulled`, and `pushed` are all `false` regardless of how much I/O the engine actually performed before the throw. Downstream consumers that need a "something on disk may have changed" signal should fire unconditionally on round-finished rather than gating on these booleans. The catch-all marker is `newState === "offline" && lastError.code === "sync_failed_after_retries"`.

### Transient `network` failure intentionally clears the in-flight indicator

A network failure does not surface a persistent notification (the next poll usually recovers), but it also clears the activity-registry indicator to `null`. Leaving "Syncing memory bank…" up on a transient failure would be a lie about in-flight work for up to a full poll interval.

### `newState === "syncing"` returned from the engine clears the indicator

If the engine returns `"syncing"` without actually running (the global single-flight lock was held elsewhere), the driver clears the indicator. The driver does not retry sooner; it waits for the next scheduled poll.

### `selfLocked` propagation uses strict equality

The detail's `selfLocked` field is set only when `lastError.selfLocked === true`. An explicit `false` and an undefined both omit it from the detail. This keeps the status visual's "your previous sync" tooltip relabel from firing on a peer-locked or attribution-unknown error.

### Per-rebuild closure leak prevention

The locked-wait timer is a fresh closure on every build path. The runtime keeps a single live disposer reference and a host-lifecycle disposable that reads it through. A rebuild disposes the prior closure before overwriting the reference. Pre-fix, every rebuild leaked one timer-clearing closure until the host deactivated.

### Status-visual ownership release on driver teardown

Every driver teardown (sign-out, account switch, poll-interval change, host deactivate) calls a "release sync ownership" method on the status-visual boundary so a subsequent state update from any other component can change the visual. Without this, the bar can stay stuck on the last sync state after sign-out, hiding that sync is now off.

A "disabled" visual is deliberately **not** pushed at teardown: only one of the four teardown paths corresponds to the user's view of "sync is off", and the other three are immediately followed by a rebuilt driver pushing the next state. The next routine refresh picks the correct visual without flicker.

### Concurrent build deduplication

Concurrent calls to the build path share a single in-flight promise so two near-simultaneous manual clicks do not race two driver instances into existence.

### Eager-tick freshness uses per-folder persistence keys

The persistence key includes the absolute workspace folder path. Multi-root workspaces therefore do not have one folder's successful round suppress another's eager tick. Distinct repos always have distinct keys (paths are unique). Two worktrees of the same source repo at different paths get distinct freshness signals (more eager ticks, harmless).

### Activation must never fail

The eager build is wrapped in a catch at the activation layer. Any throw from the build path — including throws from the engine boundary builder — is swallowed and logged at warning. The host therefore never sees activation reject.

### Read of `syncTranscripts` is fresh per round

The transcripts flag is re-read from disk-backed config at the start of every round, not captured at construction. A settings change is therefore honored on the next round without rebuild.

### Read of `autoSyncEnabled` and `jolliApiKey` is fresh per reconcile

The reconciliation entry point re-reads both flags from disk-backed config on every call. There is no cached in-memory mirror of either.

### Disposal clears the activity-registry indicator

`dispose()` pushes `null` to the activity registry as part of its teardown. If a phase event from an in-flight engine round arrives after disposal, the disposed-guard at the top of the phase handler prevents that event from re-setting the indicator to a non-null value.

## Shared Behavior

- **Round execution and tiered conflict resolution** are owned by the sync engine spec (boundary: a single `runRound` call with `{ cwd, reason, transcripts }`, a phase event stream, a locked-wait event stream, a result envelope; this driver does not redescribe any of it).
- **The global single-flight reconciliation lock** is owned by the host-wide lock primitive spec. This driver sees its presence only as a `newState: "syncing"` return from the engine boundary and reacts by clearing the in-flight indicator.
- **The conflict UI** is owned by the conflict resolution spec. The engine drives that boundary directly; this driver is not on the path.
- **The status-visual rendering** (visual states, tooltip composition, badge counts) is owned by the status-visual spec. This driver hands typed `(state, detail)` tuples across the boundary.
- **The sidebar activity registry** rendering is owned by the activity-registry spec. This driver pushes `{ label, severity }` or `null`.
- **The persistent-failure notification surface** is owned by the host notification spec. This driver hands a (title, message) tuple.
- **Disk-backed config** (the source of truth for `jolliApiKey`, `autoSyncEnabled`, `syncPollIntervalSec`, `syncTranscripts`) is owned by the config-store spec.
- **Persistence of the last-successful-round timestamp** is owned by the IDE host's global state spec; this driver consumes thin get/set seams.
- **The workspace-initialization step** the per-round barrier fronts — including its serialization across the activation run and the enable path's catch-up run, and the fact that its one-shot completion promise resolves even on the skipped disabled path — is owned by spec 100 (step 11) and spec 215.
- **The manual-disable state** the per-round refusal reads is owned by spec 145; the write-suppression contract it belongs to by `specs/304-manually-disabled-zero-write-contract.md`.
