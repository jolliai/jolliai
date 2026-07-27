# 270. Push-Pending Compensation Retry

## Topic Statement

A best-effort, fire-and-forget catch-up that, whenever a Jolli Memory surface activates or the user signs in, retries **every** commit still waiting in the push-pending queue — with no hash filter — so memories left unsent by an offline push, a signed-out push, or a push that outran summary generation eventually reach the personal space without any user action.

## Scope

**In scope:**

- The compensation occasion (surface activation and sign-in) as a distinct trigger from the git-push occasion (spec 268) and the queue-drain occasion (spec 34).
- The unfiltered, fire-and-forget contract: retry all pending entries, never throw, no-op cleanly when there is nothing to do, when the user is signed out, or when the repository is manually disabled.
- The repo-wide manual-disable gate's placement inside the spawned worker rather than inside the drain engine, and what that placement implies for the other two occasions.
- The three surfaces that invoke it — the command-line `enable` / `auth login`, the editor extension (activation and post-sign-in), and the JetBrains plugin (startup and post-sign-in) — and how **every** surface reaches the same behavior by spawning the shared `PrePushWorker` (spec 268) as a detached child process, each launch tagged with a `--trigger` identifying the invoking surface and occasion.

**Boundaries (consumed here, owned elsewhere):**

- The queue file, the dedicated lock, and the claim-based drain engine this trigger calls (including the opt-out gate, the sign-in gate, eligibility, confirmation polling, claiming, and retry accounting) are owned by the **push-pending queue and drain engine** spec (269). This spec owns only *when and how* the retry is kicked off.
- The pre-push hook occasion — which enqueues commits and now syncs them inline without spawning — is owned by spec 268; the queue-worker post-drain follow-up occasion is owned by spec 34.
- The JetBrains-plugin specifics — how it decides to spawn, its cheap pre-check, and its bounded blocking variant — are owned by the JetBrains push-compensation spec (271); this spec cross-references them.

## Data Contracts

### Trigger contract

- **Input:** the host repository's working directory.
- **Behavior:** spawn the detached `PrePushWorker` process (spec 268) tagged with a `--trigger <id>` identifying the invoking surface and occasion; the worker reads the repo-wide manual-disable gate (below) and, when the repository is not disabled, invokes the shared drain engine (spec 269, `processPushPending`) tagged with the **activation** source and **no hash filter**, so every eligible pending entry is considered.
- **Fire-and-forget:** the caller never waits for the spawned process to exit. All failures — a missing worker script, an absent runtime, a non-git directory, a network error — are swallowed (logged at debug); the entries simply remain in the queue for the next occasion.
- **Idempotent and self-guarding:** the run no-ops cleanly when there is nothing pending, when `syncOnPush` is disabled, when the user is not signed in, **or when the repository carries the repo-wide manual-disable flag**, so no pre-checks are needed at the trigger boundary beyond a cheap existence check before spawning. Running it repeatedly is safe.

### Repo-wide manual-disable gate (in the worker, not the engine)

The manual-disable flag is read by the **worker**, as the first statement of its entry point, **before** it calls the drain engine. That placement matters:

- The engine's own gates (nothing pending, `syncOnPush`, sign-in) live inside the engine, so the other two occasions that reach the engine — the pre-push hook's inline call and the queue-worker post-drain follow-up — get them for free. The manual-disable gate is **not** one of those: it is the worker's, and the pre-push hook carries its own copy independently.
- Consequently the worker is entirely **inert on a disabled repository**: it logs one line and returns without reading the queue file, taking the queue lock, contacting the network, or touching any entry. Every surface's spawn of it is therefore inert too, which is why no surface needs its own manual-disable pre-check.
- Because the gate is not in the engine, the queue-worker post-drain follow-up occasion (spec 34) does not inherit it from here — that occasion is covered because the queue worker itself is gated before it ever reaches its post-drain trigger.

### Invocation surfaces

| Surface | Occasion(s) | How it reaches the engine |
| ------- | ----------- | ------------------------- |
| Command line | the `enable` command / guided setup, and a successful `auth login` | spawns the detached `PrePushWorker`, tagged `--trigger cli-enable` / `--trigger cli-auth-login`, which drains with `activation` source, no filter |
| Editor extension | activation (after storage init) and immediately after a successful sign-in | spawns the detached `PrePushWorker`, tagged `--trigger vscode-activation` / `--trigger vscode-sign-in`, which drains with `activation` source, no filter |
| JetBrains plugin | plugin startup and after a successful sign-in | spawns the same bundled detached worker (spec 268 / 271), tagged with its own `--trigger`, which drains the queue with **no** filter |

## Behavior

### The compensation occasion

Distinct from the other two occasions that reach the drain engine:

- **Git-push occasion (spec 268):** fires on `git push`, records the just-pushed commits, and (when signed in) synchronously syncs the batch-eligible ones inline, within its own small budget — no worker involved.
- **Queue-drain occasion (spec 34):** fires after summaries are generated, draining only the just-generated hashes (a filtered follow-up so a push that outran memory generation completes once the memory lands).
- **Compensation occasion (this spec):** fires on surface activation / sign-in and drains **everything** pending — the safety net for entries none of the other two occasions managed to complete (e.g. a push made while offline or signed out, whose inline sync never ran, deferred under budget, or could not reach the network).

### Every surface spawns the shared `PrePushWorker`

All three surfaces reach the identical drain behavior by **spawning the same detached `PrePushWorker`** (spec 268), pointed at the project's working directory and tagged with a `--trigger <id>` naming the invoking surface and occasion. Because that worker runs the drain (`processPushPending`, spec 269) with no hash filter, the effect is always the same "retry everything pending" catch-up:

1. Command line: on `enable` / guided setup, after wiring is complete (`--trigger cli-enable`); and after a successful `auth login` (`--trigger cli-auth-login`).
2. Editor extension: on activation, after storage is initialized (`--trigger vscode-activation`) — initialization-before-spawn matters, since the engine needs an active storage backend to read summaries; and again on a successful sign-in (`--trigger vscode-sign-in`) — the occasion that catches up commits pushed *while signed out* (whose pre-push hook recorded intent but did not sync, per spec 268).
3. JetBrains plugin: at plugin startup (for entries left pending by a prior session's offline push), and after a successful sign-in — each spawn tagged with its own `--trigger`.

A cheap pre-check avoids spawning at all when the queue file is absent or empty (the file is unlinked when empty — spec 269), so the common "nothing pending" path pays no process-spawn cost. The spawn never throws: a missing worker script, absent runtime, non-git directory, or offline network just leaves the entries for the next trigger.

If the retry reports work was attempted, a one-line summary (attempted / pushed / failed) is logged by the invoking surface; otherwise it is silent. Full JetBrains-side details (the pre-check, the optional bounded-blocking variant used by its own post-commit follow-up) are owned by spec 271.

## State Transitions

### A pending entry, from the compensation trigger's view

| From | Condition | To |
| ---- | --------- | -- |
| pending, repository manually disabled | trigger fires | unchanged — the worker returns before the engine is called at all; the queue file is not even read |
| pending, signed out | trigger fires | unchanged (engine no-ops on the sign-in gate) |
| pending, `syncOnPush` disabled | trigger fires | unchanged (engine no-ops on the opt-out gate) |
| pending, signed in, confirmed, has memory | trigger fires | uploaded then deleted (by the engine) |
| pending, signed in, memory not yet generated | trigger fires | left pending (engine releases the claim) |
| pending, retry-exhausted / stale | trigger fires | untouched by this run; ages out via the 7-day prune |
| none pending | trigger fires | no-op (the surface skips the spawn entirely, per the shared pre-check) |

## Notable Behavior

- **This is the occasion that rescues signed-out and offline pushes.** A `git push` made while signed out records intent but does not sync at all (spec 268); a push made offline attempts the inline sync but it fails or is deferred within the budget. Neither the git-push nor the queue-drain occasion completes them — the activation / sign-in retry does. (Notable; this is the whole point of the trigger.)
- **Unfiltered by design.** Unlike the queue-worker follow-up, which is scoped to the hashes just summarized, the compensation retry considers every eligible entry, because on a fresh session it has no knowledge of which specific commits are outstanding. (Notable.)
- **Never blocks activation.** The trigger is fire-and-forget and fully guarded; activation, sign-in, and `enable` never wait on it and never fail because of it. (Notable.)
- **Idempotence comes from the engine, not the caller.** The trigger does no pre-checks beyond the shared cheap file-existence skip (present on every surface, not just JetBrains); the engine's own gates (nothing pending / opt-out / signed-out) make repeated invocation safe. (Notable.)
- **The manual-disable gate lives in the worker, not in the engine.** It is the worker's first statement, ahead of the engine call, so a disabled repository makes the whole spawn inert — no queue read, no lock, no network. Placing it in the worker rather than the engine means the other two occasions that reach the engine do **not** inherit it: the pre-push hook carries its own copy, and the queue-worker follow-up is covered because the queue worker itself is already gated. No surface needs a manual-disable pre-check of its own. (Surprising; the gate's location is what lets every surface stay ignorant of it.)
- **Every surface reuses the same `PrePushWorker` rather than a dedicated activation entry point.** Spawning it with no hash filter yields the same "drain everything" behavior regardless of which surface or occasion triggered it; each launch is distinguished only by its `--trigger` tag, used for logging. (Notable.) This was previously true only of the JetBrains plugin — the CLI and editor extension used to call the drain in-process; all three now spawn identically. (Surprising; architecture change. See spec 271 for JetBrains-specific detail.)

## Shared Behavior

- The queue file, the dedicated lock, and the claim-based drain engine (opt-out gate, sign-in gate, eligibility, confirmation polling, claiming, upload, and retry accounting) are owned by spec 269. The manual-disable gate is deliberately *not* part of that engine.
- The repo-wide manual-disable flag the worker reads before the engine call — its storage, repo-wide anchoring, priority, migration, and the full list of entry points that carry the same gate — is owned by the manual-disable spec.
- The git-push occasion — which enqueues commits and now synchronously syncs the batch-eligible ones inline, spawning nothing — is owned by spec 268; the queue-worker post-drain follow-up occasion is owned by spec 34.
- The JetBrains-plugin push-compensation specifics (pre-check, spawn, bounded-blocking variant) are owned by spec 271.
