# 219. IntelliJ CLI-Delegated Sync Orchestration and UI

## Topic Statement

The IntelliJ plugin owns only three things about Memory Bank sync: a poll timer, a manual-sync entry point, and two visual surfaces (a status-bar badge and a tool-window toolbar label). Each round is a single `sync` bridge call whose returned round result is mapped into a small status view model; every piece of engine work — git plumbing, vault locking, merges, conflict detection, credential minting, push retry — happens in the command-line surface. The plugin additionally synthesizes its own failure states for the four ways the call itself can go wrong, coalesces overlapping rounds, and auto-clears finished-state badges after a fixed delay so stale visual artifacts do not accumulate.

## Scope

**In scope:**

- The status-bar badge: its four display states, the text and tooltip for each, the click target, terminal-code visual variants, and the `clearFailureStatus` guard that protects healthy states from being clobbered.
- The tool-window toolbar inline label: its four state renderings, colors, own transient-success timer, and how it mirrors (but does not replace) the status-bar badge for terminal errors.
- The auto-clear mechanism: the eligible states, the delay constant, the generation guard, and the combined widget + cached-state + listener reset.
- The stale-failure clear on `stopSync`: the condition tested, the combined reset path, and why a "disabled" visual is not pushed.
- Sync-state listeners: registration, late-registration catch-up, removal, and the event-dispatch-thread (EDT) dispatch contract.
- The service-level orchestrator lifecycle: `startSync(cwd, pollIntervalSec, autoSyncEnabled)` — teardown before start, how the `onStateChange` callback is wired, and the fact that polling starts only when auto-sync is enabled.
- The reconcile-on-auth path: the startup activity sequencing (initialize, then activate sync), the auth listener, and the initial reconcile for the "already signed in at startup" case.
- The `reconcileSync` decision tree: no platform key → stop; otherwise build and (conditionally) start.
- The `sync` bridge call's request and response contract as this surface uses it — which request fields it sends, which response fields it reads, and which it deliberately ignores.
- The four-tier local failure synthesis that turns any transport, shape, parse, or unexpected error into an offline badge.
- Round coalescing, the dedicated single-thread executor, and dispose semantics.
- The transport underneath the call: connection-preferred with one-shot fallback, the two failure classes that are never retried, and the per-call budget.
- The two live manual-sync entry points and the lazy-build guard both apply.
- The poll-interval clamp: floor, ceiling, default, and behavior for `null` or non-positive input.

**Out of scope (boundaries — sent/received only):**

- Round internals, lock acquisition, credential minting, branch recovery, conflict resolution, push retry — all owned by spec 150.
- The global single-flight lock — spec 172.
- The sync backend client (credential mint, backend API calls) — spec 170.
- The vault write lock — spec 171.
- **The round contract and the reason enum are owned by the command-line sync specs**; this spec records only which subset of them this surface exercises.
- **Spec 174 documents the VS Code driver; IntelliJ does not share it.** There is no phase pipeline, locked-wait countdown, followup latch, generation-mismatch bail, or cross-device folder-collision notification on the IntelliJ side.
- The Memory Bank folder layout, vault identity marker, and conflict resolution specs (150, 165, 166).
- The KB explorer panel's memory-list, timeline, and search views — spec 193.
- The subprocess plumbing and stream-drain behavior of the plugin's git spawns — spec 126.

## Data Contracts

### Status-bar badge states

| State | Display text | Tooltip |
|---|---|---|
| `SYNCED` | `✓ Jolli Memory` | `Memory Bank in sync` |
| `SYNCING` | `⟳ Syncing…` | `Memory Bank sync in progress` |
| `CONFLICTS` — with count | `⚠ N conflicts` | `N items need your attention` |
| `CONFLICTS` — no count | `⚠ Conflicts` | `Conflicts need your attention` |
| `OFFLINE` — terminal failure | see terminal-code table | see terminal-code table |
| `OFFLINE` — non-failure | `Jolli Memory` | `Jolli Memory — click to open sidebar` |

The `OFFLINE` non-failure case applies when `detail` is null or `detail.failed` is not `true`. The neutral text is identical to the widget's initial resting state.

**Caveat:** the terminal-failure visual additionally requires a non-null `failedCode`. A detail with `failed == true` but no mapped code renders the neutral `Jolli Memory` text, not a failure visual — see Notable Behavior.

### Terminal-code visual variants (status-bar badge)

| Error code | Display text | Tooltip |
|---|---|---|
| `VAULT_LOCKED` — self-locked | `⚠ Personal Space busy` | `Your previous sync failed — waiting for lock to expire` |
| `VAULT_LOCKED` — peer-locked | `⚠ Personal Space busy` | `Personal Space is being synced by another device` |
| `LOCALFOLDER_INVALID` | `✗ Memory Bank folder invalid` | `Update the Memory Bank folder in Settings` |
| `PUSH_REJECTED` | `✗ Push rejected` | `Memory Bank sync failed` |
| any other terminal code | `✗ Sync failed` | `Memory Bank sync failed` |

"Self-locked" is `detail.selfLocked == true` (strict boolean equality).

### Tool-window toolbar label states

| State | Text | Color | Tooltip |
|---|---|---|---|
| `SYNCING` | `⟳ Syncing…` | foreground (theme default) | `Memory Bank sync in progress` |
| `SYNCED` | `✓ Synced` | green `#59A869` / dark-theme `#5FB865` | `Memory Bank in sync` |
| `CONFLICTS` — with count | `⚠ N conflicts` | amber `#C28A00` / dark-theme `#D6A02E` | `N items need your attention` |
| `CONFLICTS` — no count | `⚠ Conflicts` | amber | `Conflicts need your attention` |
| `OFFLINE` — terminal failure | see terminal-code table | red `#C7422E` / dark-theme `#D95A4A` | `detail.lastError` or `Memory Bank sync failed` |
| `OFFLINE` — non-failure | hidden (not visible) | — | — |

The `SYNCED` label starts a 4-second visibility timer at display time and hides itself on expiry. This timer is independent of the service-level auto-clear.

### Terminal-code labels (tool-window toolbar)

| Error code | Label text |
|---|---|
| `VAULT_LOCKED` | `⚠ Personal Space busy` |
| `LOCALFOLDER_INVALID` | `✗ Folder invalid` |
| `PUSH_REJECTED` | `✗ Push rejected` |
| any other | `✗ Sync failed` |

The toolbar label does not distinguish self-locked vs. peer-locked; that detail appears only in the status-bar badge tooltip.

### Sync round request

The plugin sends exactly one field: `reason`, always either `poll` or `manual`. The action accepts four values (`post-commit`, `poll`, `manual`, `first-bind`) and rejects anything else, but this surface never sends the other two.

Two request fields the action supports are **never sent** by this surface:

- `conflictChoices` — absent, so every conflict prompt the engine raises resolves to `skip`. **This surface has no conflict-resolution UI.**
- `transcripts` — absent, so whether transcripts are synced is decided entirely by the persisted setting on the command-line side.

The action's own preconditions, surfaced to this plugin as thrown errors: a missing platform key (or an engine that cannot be built) yields `"Sync requires a Jolli sign-in."`; an unrecognized `reason` yields a validation error.

### Sync round response — fields read

| Response field | Mapped to |
|---|---|
| `newState` (lowercase string) | uppercased and matched against the four sync states; **anything unmatched becomes `OFFLINE`** |
| `conflicts` (array) | its length as `conflictCount` when non-empty, otherwise null |
| `lastError.message` | `lastError` |
| `lastError.code` | uppercased and matched against the known error codes — but **only after excluding the literal `network`** — as `failedCode` |
| `lastError.selfLocked` | `selfLocked`, on strict `true` |

Individual conflict records are never inspected, only counted.

**Deliberately ignored:** `fetched`, `pulled`, `pushed`, the canary fields (symlinked / unowned), and `conflictDetails` — the last of these is returned by the action on every round and never read, because there is no conflict UI to feed.

### Status view model

The detail object carried alongside a state has five fields: `conflictCount`, `lastError`, `failedCode`, `failed`, `selfLocked`. It is left **entirely null** when none of `conflictCount`, `lastError`, `failed`, or `selfLocked` would be set.

`failed` is computed as **"a non-network error object exists"** — not as "the error code resolved to a known enum member". An unknown, renamed, or missing code therefore still produces `failed == true` with `failedCode == null`.

### Local failure synthesis (four tiers)

Every tier resolves to `OFFLINE` with `failed = true`:

| Tier | Trigger | `lastError` |
|---|---|---|
| Transport | any exception from the bridge call | the exception's message |
| Shape | the response is not a JSON object | `malformed sync response` |
| Parse | mapping the response threw | `malformed sync response` |
| Unexpected | any throwable escaping the round body | the throwable's message |

All four leave `failedCode` null, so none of them renders a failure visual (see Notable Behavior).

### Auto-clear constants

- Delay: 3 000 ms after the state is set.
- Eligible states: `SYNCED`, `CONFLICTS`, `OFFLINE` (any `OFFLINE` — including terminal failures). `SYNCING` is never auto-cleared.
- Reset target: `OFFLINE` with `null` detail (neutral resting state).

### Poll-interval clamp

- Floor: 90 minutes (5 400 seconds).
- Ceiling: 24 hours (86 400 seconds).
- Default (when value is `null` or ≤ 0): 90 minutes.
- A positive finite value is clamped to `[floor, ceiling]`.

### Sync-state generation counter

A single atomic long held by the **service**, incremented on every `onStateChange` callback and on the `stopSync` failure-clear path. Auto-clear timers capture the generation at schedule time and skip the reset if the counter has advanced. The orchestrator itself has no generation counter — it holds three independent flags only: running, round-in-flight, and disposed.

### Per-call budget

300 seconds, the bridge default. The orchestrator passes no override, so a single round may block its executor thread for five minutes.

## Behavior

### Startup sequence

When a project opens with a `.git` entry present:

1. The startup activity initializes the service (hook detection, orphan-branch migration, Memory Bank folder init).
2. The startup activity calls the sync-activation entry point, which:
   a. Registers an auth-state listener that calls `reconcileSync` on every future auth change.
   b. Immediately calls `reconcileSync` once to handle the "already signed in at startup" case.

If `.git` is absent the startup activity shows a one-time balloon notification and returns without calling `reconcileSync` or the sync-activation entry point at all.

### `reconcileSync` decision tree

Executed on every auth-state change and at startup. Reads config fresh each call. Four steps:

1. Resolve `cwd` from the service's main-repo root, falling back to the project base path. If neither is available, return without action.
2. Read config. If the platform key is blank or absent, call `stopSync` and return.
3. Read `autoSyncEnabled` (defaults to `true` when absent) and the configured poll interval.
4. Call `startSync(cwd, pollIntervalSec, autoSyncEnabled)`.

There is **no engine-build step** — the engine lives on the command-line side and is built there, per round — and there is **no post-start stop**: whether polling runs is decided inside `startSync` rather than by starting and immediately stopping.

### `startSync` entry point

In order:

1. Call `stopSync` unconditionally (tears down any existing orchestrator and clears stale failure badges before starting fresh).
2. Dispose the previous orchestrator, if any.
3. Locate the status-bar badge widget for the project.
4. Construct a new orchestrator, wiring `onStateChange` to:
   a. Increment the generation counter and update the cached state + detail.
   b. Record the timestamp when the state is `SYNCED`.
   c. Dispatch to the EDT: push state to the badge widget, notify all sync-state listeners.
   d. Schedule an auto-clear timer for the new state (see "Auto-clear" below).
5. Cache the orchestrator on the service.
6. Call `start()` **only when auto-sync is enabled**.

The orchestrator's constructor takes the project, the working directory, the poll interval, and the state callback — nothing else. No timestamp, no engine, and no generation are passed into it.

### Polling loop start (orchestrator)

`start()` is a no-op after disposal and idempotent while running (guarded by a compare-and-set on the running flag). A successful start schedules the round body on a **dedicated bounded single-thread executor** with a **fixed 1-second initial delay** and the clamped interval as the period. The initial delay is unconditional: there is no freshness check, no cold-start rule, and no eager first tick.

### Round execution

Every round — polled or manual — runs the same body:

1. Return immediately if disposed.
2. **Coalesce:** compare-and-set the round-in-flight flag; if a round is already running, log at debug and return without touching state.
3. Deliver a locally synthesized `SYNCING` state (this is the *only* in-progress signal on this surface — the engine's phase callbacks are not wired to anything here).
4. Issue the `sync` bridge call with the round's reason.
5. Map the response into a state + detail, or synthesize a failure per the four tiers.
6. Deliver the final state.
7. In a `finally`, clear the round-in-flight flag.

The whole body sits inside a catch-all throwable guard because the fixed-delay scheduler cancels the recurring task permanently if the task throws — without the guard, one unexpected exception would silently end polling for the session.

State delivery returns early when the orchestrator is disposed, and logs and swallows any exception thrown by the state callback.

### Transport

The bridge call prefers a long-lived per-project connection when one is bound to a project whose base path or resolved main repo root matches the working directory; otherwise, or on most local failures, it falls back to a one-shot process-per-call spawn. Two failure classes are **rethrown rather than retried**:

- a business error from the action (which is the server's real answer — for example the sign-in precondition);
- a timeout, because the server is **still executing the round** and a second spawn would double-execute the push.

Both surface into the transport tier of the failure synthesis. Full transport behavior is owned by spec 288.

### Other orchestrator operations

- **stop** — a no-op unless running. Cancels the poll future without interrupting it and nulls the handle. It does **not** increment any generation. The executor stays alive so manual sync keeps working and `start()` can be called again.
- **requestManualSync** — a no-op if disposed; otherwise submits one round with reason `manual` to the same executor, swallowing the rejection that a dispose-versus-click race produces.
- **dispose** — once-only. Sets the disposed flag **first** so a round already in flight cannot deliver a state afterwards, then stops, then shuts the executor down with interruption so a blocking read in an in-flight round is unwedged.

### `stopSync` entry point

1. Call the orchestrator's `stop()` (cancels the poll future; the orchestrator remains usable for manual sync).
2. Check whether a stale failure badge needs clearing: if `syncState == OFFLINE && syncDetail?.failed == true`, perform a combined reset:
   a. Increment the generation counter.
   b. Set cached `syncState = OFFLINE`, `syncDetail = null`.
   c. Dispatch to the EDT: call `widget.clearFailureStatus()`, notify all sync-state listeners with `(OFFLINE, null)`.

`clearFailureStatus()` on the badge widget inspects its own current state. If `currentState == OFFLINE && currentDetail?.failed == true`, it calls `setSyncState(OFFLINE, null)` (which renders the neutral `Jolli Memory` text) and returns `true`. Otherwise it is a no-op returning `false`. Healthy states (`SYNCED`, `SYNCING`, `CONFLICTS`, or a non-failure `OFFLINE`) are never clobbered by this call.

### Auto-clear mechanism

Called from `onStateChange` after every state update, with the current generation captured at that moment.

1. If the state is `SYNCING`, return immediately (not eligible).
2. Schedule a one-shot task at 3 000 ms:
   a. If the service-level generation counter no longer matches the captured value, return (a newer state arrived — skip).
   b. Set cached `syncState = OFFLINE`, `syncDetail = null`.
   c. Dispatch to the EDT: if the counter still matches, call `widget.setSyncState(OFFLINE, null)`, notify all listeners with `(OFFLINE, null)`.

The EDT inner check is a second guard against a race between the background scheduler firing and a new state arriving on the EDT after the background check passed.

### Sync-state listener contract

- Registration adds the listener to a copy-on-write list.
- If a sync state has already been observed (non-null cached state), the listener is invoked immediately at registration time with the current state and detail.
- Listeners are always dispatched on the EDT (the state callback dispatches via a later-invoke).
- Removal drops the listener from the list, and is called on tool-window panel disposal.
- **The KB explorer panel is the sole registered consumer**; its inline toolbar label is the only thing this bus feeds.

### Manual sync entry points

Two live surfaces provide a manual-sync button:

**Tool-window toolbar cloud button:**

1. Runs on a pooled thread.
2. If the user is not signed in, shows a notification and aborts.
3. If the orchestrator is not built, calls `reconcileSync` to lazy-build it.
4. Calls the service's manual-sync method, which delegates to the orchestrator.

**Cloud-sync popup "Sync Now" button:**

1. Closes the popup immediately.
2. Runs on a pooled thread.
3. Same lazy-build check as the toolbar.
4. Calls the service's manual-sync method.

This button exists only in the signed-in variant of that popup.

Both entry points check whether the orchestrator is built (a null check) before deciding to lazy-build.

A third entry point exists in the tool window's overflow menu but is gated behind a compile-time feature flag that is permanently false. It is **unreachable dead code** and is not part of this surface's behavior.

### What this surface does not do

- **No conflict resolution.** It never sends conflict choices, so every prompt the engine raises resolves to `skip`; it counts conflicts and never inspects them; it discards the returned conflict details entirely.
- **No mid-round progress.** One request, one response — the engine's phase, locked-wait, and repo-mapping-conflict callbacks are unwired here. The only in-progress signal is the locally synthesized `SYNCING` emitted *before* the call.
- **No transcript decision.** Whether transcripts are included is read from the persisted setting on the command-line side; this surface never sends the flag.
- **No post-commit or first-bind rounds.** Only `poll` and `manual` reasons are ever sent.
- **No folder-collision notification, no locked-wait countdown, no followup latch** — those belong to the VS Code driver (spec 174).

## State Transitions

### Sync orchestrator lifetime within the service

```
[no orchestrator]
    │  startSync(cwd, interval, autoSyncEnabled)
    │    stopSync() first (no-op when null)
    │    dispose previous, construct + cache
    │
    ├── autoSyncEnabled == true  → start()
    │                              ▼
    │                        [orchestrator polling]
    │
    └── autoSyncEnabled == false → start() NOT called
                                   ▼
                             [orchestrator built, not polling]

[either built state]
    │
    ├─ stop()                    → cancel the poll future (no generation bump);
    │                              stale failure cleared if present;
    │                              orchestrator cached, manual sync still works
    │
    ├─ startSync() again         → stopSync(), dispose, rebuild
    │
    ├─ requestManualSync()       → one round on the same executor, regardless of polling
    │
    ├─ onStateChange(state, d)   → gen++; update cache; EDT: badge + listeners; schedule auto-clear
    │
    └─ dispose()                 → disposed latch set FIRST, then stop(), then
                                   executor shutdown-with-interrupt; late rounds
                                   cannot deliver a state
```

### One round

```
[idle] ── disposed? ──yes──> return
    │ no
    ├── round already in flight? ──yes──> skip (debug log), no state change
    │ no
    ▼
[SYNCING delivered] → bridge call
    ├─ response mapped            → [final state delivered]
    ├─ transport / shape / parse / unexpected failure → [OFFLINE, failed = true]
    ▼
round-in-flight cleared (always)
```

### Auto-clear state machine (per state update)

```
[state set, gen = G]
    │
    │  if state == SYNCING → no timer
    │
    │  after 3 000 ms:
    │      if serviceGen ≠ G → skip
    │      set cache: OFFLINE / null
    │      EDT: if serviceGen still = G → badge + listeners → OFFLINE / null
    ▼
[badge and listeners at neutral OFFLINE]
```

### Badge visual states

```
SYNCED ────────────────────── ✓ Jolli Memory
SYNCING ───────────────────── ⟳ Syncing…
CONFLICTS (count present) ──── ⚠ N conflicts
CONFLICTS (no count) ─────── ⚠ Conflicts
OFFLINE (terminal failure) ─── per terminal-code table
OFFLINE (no failure) ────────── Jolli Memory   (neutral resting state)
```

## Notable Behavior

### Stale failure badge would otherwise persist indefinitely

Without the auto-clear and `stopSync` clear paths, a terminal failure badge (`✗ Sync failed`) would remain visible on the status bar until the next successful round — which can be up to 90 minutes away, or never if polling stops. The 3-second auto-clear addresses the common case where polling is running; the `stopSync` failure-clear addresses the sign-out and auto-sync-disabled cases.

### `SYNCED` in the toolbar has its own independent timer

The tool-window toolbar label starts a 4-second timer when it renders `SYNCED`, which hides the label entirely. This is separate from the service-level 3-second auto-clear, which resets the badge to neutral `OFFLINE`. Both can fire for the same round; they are not coordinated and do not share state.

### A failure can be invisible

`failed` is bound to "a non-network error object exists", **not** to the error code resolving to a known enum member — while the failure *visual* additionally requires a non-null `failedCode`. An unknown, renamed, or absent code therefore yields `failed == true` rendered as the neutral `Jolli Memory` text. Consequence: all four locally synthesized failure tiers, and every command-line precondition error including `"Sync requires a Jolli sign-in."`, land as `OFFLINE` with **no visible failure indication at all** — the user sees the resting state while the cached detail says the round failed.

### The last-success timestamp is write-only

The service records a timestamp on every `SYNCED` round. **Nothing reads it.** The eager-first-tick and freshness-threshold logic that was its only consumer is gone, so the field has no observable effect: the first round after a start always fires exactly 1 second later regardless of how recently a round succeeded.

### `autoSyncEnabled == false` builds the orchestrator but never starts it

`startSync` constructs, wires, and caches the orchestrator and then simply does not call `start()`. The orchestrator therefore never polls, while manual sync still works because the executor is alive and the disposed latch is unset. This replaces an earlier "start it, then immediately stop it" shape — nothing is started and nothing needs stopping.

### `clearFailureStatus` is a no-op on healthy states — and on a never-updated widget

`clearFailureStatus` only resets the badge when its own current state is `OFFLINE` with a failed detail. A `✓ Jolli Memory` badge after a recent successful round is left untouched, avoiding a flicker during the stop/start cycle `reconcileSync` performs on every auth event. Note also that a freshly created widget begins with a cached state of `SYNCED` while displaying the neutral text, so calling this on a widget that has never received an update returns false and changes nothing.

### Dispose interrupts a blocking round

Disposal shuts the executor down **with interruption** specifically to unwedge a round blocked reading the bridge response, which may otherwise hold its thread for the full 300-second budget. The disposed check inside state delivery is what prevents that interruption from leaking a stale state change onto a widget the service has already released.

### A timeout must never be retried

The transport deliberately does not fall back to a fresh spawn when a round times out on the long-lived connection: the server is still executing that round, and a second invocation would run the push a second time. This is the one case where "retry on failure" would be actively harmful, and it is why the timeout exception is a distinct type rather than a generic error.

### Status-bar badge click navigates to the Jolli tool window

A click on the badge widget shows the Jolli tool window. No sync action is triggered; the click is navigation only.
