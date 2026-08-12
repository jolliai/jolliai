# 124. IntelliJ Project Service Lifecycle

## Topic Statement

A per-project service in the JVM IDE runs a single-shot initialization when a repository is opened, keeps the installation status and a small set of derived flags fresh across the rest of the session, and publishes changes to the side panels through **several independent subscription lists** — of which the two refresh paths drive exactly one each, so which list a panel joins is a real decision rather than a formality.

## Scope

**In scope:**
- Service creation on project open, the notification shown for a project with no repository, and disposal on project close.
- The single-shot initialization sequence, in execution order, including which steps are dispatched without being awaited and which run after the service is already marked initialized.
- The one-way projection of a legacy machine-global paused preference onto this repository's own opt-out, as it occurs inside that sequence.
- The four-condition gate on the automatic hook repair, the alternative branch when the gate's last condition is false, and the fact that this repair is the sole caller that asks the delegated install to respect the opt-out.
- The status refresh: what it re-reads, the two flags it refreshes alongside the status snapshot, and how it detects that the repository directory has been removed.
- The working-context refresh, and the structural relationship between the two refreshes' fan-outs.
- The subscription lists this service owns, which of them fire immediately on subscription, and which survive disposal.
- The bounded in-memory cache of single-memory reads and the two triggers that empty it.
- Resetting the initialization flag so a re-created repository can re-initialize without an IDE restart.

**Out of scope (boundaries):**
- Hook installation and teardown themselves, and what the delegated enable writes — spec 128.
- The enable/disable gestures, the cached-verdict read modes, the install-protection window, and the canonical treatment of the legacy projection — spec 332.
- The durable opt-out's own storage, field split, anchoring and read precedence — spec 145.
- The file-system watcher this service starts, its roots, its filtering and its debounce — spec 125.
- The pushed-notification channel that reaches the same two refreshes from the command-line side — spec 289; the connection that carries it — spec 288.
- The pending-push drain (spec 271) and the embedded-browser pool (spec 302); this service only dispatches to each.
- The runtime probe that gates the whole sequence — spec 284.
- Any individual panel's rendering, and the tool window's card routing — specs 118 and 133.

## Data Contracts

### Observable state

| Field | Meaning |
| --- | --- |
| initialized | True once the single-shot initialization has completed for this project session. |
| runtime-missing | True when initialization stopped at the runtime gate; **nothing** was initialized in that case — no hooks, no mirror folder, no watchers, no sync. Cleared by a later initialization that finds a runtime. |
| repository-removed | Flips true the first time a status refresh sees the repository entry gone from the project base path; never flips back except through the explicit reset hook. |
| resolved repository root | The repository top level for the project directory. Resolution runs a revision-parse query and returns the project directory unchanged **only** when the top level canonically equals it, or when the query fails; so a project opened on a subdirectory of a repository stores the repository root here, not the project base path. The helper has no null return in practice, which makes initialization's fall-back-to-base-path branch unreachable. |
| last error | Human-readable description of the most recent failure during a status check or an installer call; null when the last operation succeeded. **A refusal caused by the opt-out is deliberately not recorded here**, because this field is painted in red to the user. |
| cached status snapshot | The last successfully read installation status, readable by panels without touching disk. |
| cached opt-out verdict | The repository-wide manual opt-out, refreshed **first and unconditionally** at the top of every status refresh — ahead of the status probe, so a probe failure cannot silently skip it (spec 332). |
| cached worker-busy flag | Whether the background summary worker holds its liveness lock. Refreshed by every status refresh so that action-enablement checks on the interface thread never touch disk. |
| initialization log | A per-run transcript of every decision the sequence made, kept in memory and also written to a per-user diagnostics file. |
| panel registry | Attached from outside after the panels are constructed, so contextual actions can locate a panel by role. |

None of these has a setter; callers read them or subscribe.

### The subscription lists

This service owns several **independent** lists. Nothing merges them, and no refresh fires more than one.

| List | Fired by | Fires immediately on subscribe? | Cleared on disposal? |
| --- | --- | --- | --- |
| Status | The status refresh (every outcome, success or failure) | Yes, when a status snapshot is already cached | Yes |
| Working-context | The working-context refresh only | No — subscribers load on their own initialization | No |
| Selection | An explicit call when a commit-selection checkbox or an in-memory file selection toggles | No | No |
| Memory-state | An explicit call when a committed memory's shared state changes; **also empties the memory cache** | No | No |
| Sync-state | The sync orchestrator | Yes, when a state has already been observed | Yes |
| Back-fill | The cold-start signal computation and the dismissal | Yes, when the service is already initialized | No |

### The single-memory cache

A bounded, access-ordered, concurrently-wrapped cache of parsed single-memory reads, capped at 128 entries with least-recently-used eviction, consulted **before** the read path on every single-memory read. Entries are keyed by the requested commit identifier; when a lookup succeeded only after following a commit alias, the record is additionally stored under the resolved identifier. It is emptied **wholesale** — never per key — by exactly two triggers: any memory-state notification, and an explicit invalidation used by in-panel edit handlers that already repaint themselves and must not provoke a full listener fan-out. Only the parsed-record read is cached; raw-document, plan-body, note-body and reference-body reads are not.

## Behavior

### Project open

When the project finishes opening, a startup activity reads the project base path and returns silently when there is none. If the base path has no repository entry, it emits a one-time platform notification advising the user to create a repository or enable version control from the IDE's menu, and **does not create the service**. It then runs the runtime probe; when no usable runtime is found it emits an error notification naming either "not found" or "installed but too old" (with each rejected candidate's version and location) and stops without creating the service. Only past both gates does it obtain the project-scoped service and call initialization.

The tool window and the onboarding and settings surfaces also call initialization when the service is not yet initialized. One of those callers — the tool window's content creation — runs **synchronously on the interface thread**, which is why two reads inside the sequence are deliberately made cheaper (below).

### Initialization

Single-shot and gated on the initialized flag. In order:

1. Read the project base path; if missing, record the error, publish the log, release the migration gate and return.
2. **Run the runtime probe.** If no runtime is found, set the runtime-missing flag, record the error, publish the log, release the migration gate and return. Nothing below this point runs (spec 284).
3. Inspect the repository entry, recording whether it is a directory, a file, or absent — and, when it is a file, its contents.
4. Build a repository wrapper for the project directory and resolve the repository root. A **second** wrapper is built at that root when it differs from the project directory, and it is that one the rest of the session uses — because path arguments are resolved against a process working directory while every path this surface holds is repository-root-relative. When the two are the same directory (the ordinary case, linked checkouts included) the first wrapper is reused. Point the diagnostic log at the resolved root.
5. Record whether each of a handful of well-known state files exists under the resolved root.
6. Construct the hook installer (with **both** the project directory and the resolved root) and the memory reader. The reader is constructed against the **project directory**, not the resolved root: the status it delegates treats its working directory as the checkout being reported on, so a linked checkout must report its own hook state rather than its parent's. Record the installer's own debug description.
7. Perform the first status refresh, in its **disk-only** opt-out mode, and record the resulting snapshot or the failure. Disk-only because this path can be running on the interface thread and the status probe is already one round trip; a second one would double the cost of a cold start.
8. Initialize the mirror folder with the repository's identity and dispatch the migration:
   - Resolve the repository name, its remote location, the configuration record and the claiming mirror root — each a separate round trip — then write the identity record.
   - **Dispatch the migration and do not wait for it.** It runs on a pool thread under a serialization lock shared with every other migration entry point, and its settled outcome (or the word "failed") is appended to the initialization log **after the fact**, alongside a follow-up status refresh that runs on both the success and the failure path. A first-install migration can take minutes and blocks nothing here.
   - The whole step is wrapped so any failure is recorded in the log without aborting initialization.
   - **No read source is mounted against that folder.** Every memory read goes through the delegated storage stack, so this surface inherits whatever backend the command-line side routes to.
9. Load the machine-global configuration record, then run the legacy pause projection (below).
10. Evaluate the automatic hook repair gate (below), and take one of its three outcomes.
11. **Dispatch a pending-push drain**, unwaited, off the interface thread — retries commits left pending by a push in a prior session. Fully guarded and silent when there is nothing to do (spec 271).
12. **Dispatch a read-path warm-up**, unwaited. It performs the same three reads that opening a memory tab performs — read the memory index, read the set of stored transcript identifiers, and read one memory body (the last only when the index has an entry) — because a tab open puts exactly those on the interface thread and the first calls after the read path comes up are an order of magnitude slower than warm ones. Failures are swallowed and logged as non-fatal.
13. **Request a prewarm from the embedded-browser pool**, wrapped in its own catch (spec 302).
14. Mark the service initialized and publish the initialization log.
15. Subscribe to the IDE's repository-change events, each of which fires a status refresh.
16. Start the file watcher over the repository's memory reference, the per-project state directory and the repository profile file (spec 125).
17. Write the accumulated log to a per-user diagnostics file.

Steps 11–13 are dispatched before the service is marked initialized; steps 15–17 run **after** it is already marked initialized. A migration-gate latch is released exactly once per call — by the dispatch in step 8 when it happened, and by a catch-all otherwise — so a bounded waiter outside cannot hang.

Initialization returns having marked the service initialized regardless of whether the first status check succeeded.

### The legacy pause projection

A machine-global configuration record carries a legacy paused preference with no user-facing control left. When it is set, this repository has a resolvable root, **and** this repository's own decision reads as *undecided* through the tri-state probe (which reports disabled / not disabled / nothing recorded), the projection writes this repository's opt-out as set and updates the cached verdict to match. On a write failure it logs and falls through.

Three properties are load-bearing, and all three are visible here:

- **The whole block is gated on the legacy preference being set before the tri-state probe runs.** That probe forks a subprocess and reads a file, and the preference is unset for everyone who never used the retired control — so an ungated probe would put a subprocess on the interface-thread path for every user to serve a shrinking population. When the preference is unset the derived gate below is false regardless, so skipping the probe cannot change any outcome.
- **The direction is one-way and the machine-global preference is never cleared.** The mapping is not injective — one machine-wide flag stands for every repository on the machine — so clearing it after converting whichever repository happened to open first would leave every other paused repository reading "no preference" plus its own absent decision, and falling straight into the automatic repair.
- **A derived condition covers the failed write.** "The legacy preference is set *and* this repository is still undecided" gates the repair independently, so a projection that could not write degrades to installing nothing rather than to installing against the user's pause. On the run where the projection *does* write, this derived condition is still computed from the pre-write undecided reading — harmless, because the projection also set the cached verdict, so the earlier gate wins.

Canonical treatment: spec 332.

### The automatic hook repair gate

Four conditions, evaluated as an ordered chain:

1. This repository does not carry the manual opt-out (read from the cached verdict, which step 7 has just populated).
2. The derived legacy-pause condition above does not hold.
3. At least one credential capable of driving generation is present: a saved assistant key, a saved product key, or the assistant key's environment variable.
4. An install is needed — meaning **either** the status reports hooks not enabled, **or** the agent's session hook is missing in *this* checkout while the agent is detected and the user has not turned it off.

Condition 4's second half exists because the reported "enabled" flag is the repository-level hook alone, deliberately, so that a dropped agent integration does not disable everything. Repository hooks are shared across checkouts, but the agent's session hook lives inside each checkout and must be present per checkout.

Outcomes:

- **Conditions 1 or 2 fail** → skip, with the reason recorded in the log.
- **Conditions 3 and 4 both hold** → run the full delegated install **asking it to respect the opt-out**, then run a second status refresh and record the resulting snapshot.
- **Condition 3 holds and condition 4 does not** → dispatch a version-gated integrations catch-up off the interface thread instead, so a surface upgrade refreshes the bundled integrations without a manual re-enable. If it reports a problem, run a status refresh and raise a notification; a thrown failure is logged as non-fatal.

**This is the only automatic install path on this surface, and the only caller anywhere that asks the delegated install to respect the opt-out.** Every other install call site — the enable button, all three onboarding paths and the settings re-enable — leaves that flag off, because there the intent is to lift the opt-out and a refusal would make the control a silent no-op. Handing the check to the delegated side as well makes the automatic path fail closed: both gates above read through caches that a transport hiccup can push to a stale "not disabled", and this call also carries the instruction to clear the opt-out on success — so a wrong read would not merely reinstall hooks, it would erase the record of the user's intent. The delegated side re-reads the profile under its own lock and answers with a zero-write refusal. Redundant whenever the caches are right, which is the point.

### After initialization returns

The startup activity then, in order, each inside a catch that logs and swallows:

1. **Waits, bounded at 60 seconds, on the migration gate**, so the first sync round never classifies half-written migration output. A timeout logs and proceeds anyway.
2. **Starts the refresh-notification client** — which spawns no process and opens no channel. Its body only records that it was started; the call has no other observable effect (specs 288, 289).
3. Activates sync (spec 219).
4. Dispatches the cold-start back-fill signal computation on a pool thread.
5. Bootstraps telemetry, emits an activation event, flushes buffered events, shows a one-time notice, and schedules a repeating 60-second background flush tied to the project's lifetime.

The channel that actually reaches this service comes up lazily on the **first** bridge call whose working directory matches an open project — and initialization itself makes several such calls (the first status refresh, the mirror-folder resolution, the read-path warm-up), so the connection and its server process are already up by the time initialization returns. What is *not* true is that starting the client is what brought them up.

### Status refresh

Serialized against itself. In order:

1. Re-check that the repository entry still exists at the project base path. If it does not: set repository-removed, record the error, clear the cached status, fire the **status** list, and return nothing.
2. Return early if the installer or reader collaborators do not exist yet.
3. **Refresh the cached opt-out verdict, unconditionally and outside the failure handling below**, in bridge-first mode by default or disk-only when the caller asked for it. A transport failure here keeps the previous cached value rather than reading as "not disabled".
4. Ask the reader for a fresh status. That status is **not computed in this process**: the reader issues a status round trip against the current checkout and overlays two locally-known fields onto the answer. The installer it is still handed is ignored.
5. While the install-protection window is open, an enabled-to-not-enabled transition is suppressed and the previous snapshot is returned unchanged (spec 332).
6. Otherwise store the snapshot, recompute the worker-busy flag, fire the **status** list, and emit a deduplicated onboarding-funnel event.

On a thrown failure the repository-entry check runs once more (the exception may itself be the removal); on a genuine failure with the repository still present, the error is recorded, the previous snapshot is left untouched, and the **status** list fires anyway — so subscribers still observe an accurate opt-out verdict even when the status probe failed.

### Working-context refresh

Fires the **working-context** list and nothing else. It is a no-op while the service has no cached status — before initialization the panels are still showing their initializing state, and reloading rows underneath that would replace it with a misleading empty list.

For a plan, note or reference appearing, leaving or being edited, this is the whole of the correct refresh. The status refresh would additionally take a lock, run a full status round trip, recompute the worker-busy flag and wake a much wider list — none of whose answers can change because the working-context registry was rewritten.

### The two fan-outs are disjoint, and the status refresh is NOT a superset

This is the structural fact a reader most needs.

- The status refresh fires the **status** list only.
- The working-context refresh fires the **working-context** list only.
- Both upstream debouncers — the file-system watcher (spec 125) and the pushed-notification channel (spec 289) — pick **exactly one** of the two per window, under a sticky one-way escalation in which a commit-time signal wins and a working-area signal can never demote it (spec 338).

So a batch that mixes the two signals escalates and runs the status refresh, and **every subscriber that is only on the working-context list is skipped entirely for that batch** — which is exactly the batch a committing agent produces, because the working-context registry and the memory reference are written moments apart.

A panel therefore joins one list, the other, both, or **neither**, and each choice is a decision:

- **Both** — a panel that renders working-area rows *and* has to react to enabled/disabled state. Being on both is not a double refresh: each refresh fires one list, so a given event reaches the panel once. Under the asymmetry above, membership of both is what makes a working-context subscriber survive an escalated batch, so for such a panel it is an obligation rather than a convenience.
- **Working-context only** — currently nobody. Such a panel would silently miss every escalated batch.
- **Status only** — everything whose answer is installation state, commit history, or transcript aggregation.
- **Neither** — the pinned-items panel. It renders entirely from its own snapshot store, whose titles and badges were captured at pin time, so no working-context event can change what it paints; whoever writes that store repaints it directly.

The asymmetry is known and left standing. Making the status refresh a true superset would regress every panel on both lists into a double reload per event, and the structural alternative is a rewire of every status subscriber. Both current working-context subscribers happen to be on both lists, so there is no symptom today.

### Repository removal and restoration

Once repository-removed is set it stays set for the session. The next status fan-out reaches the tool window's own subscriber, which switches the side panel to a no-repository placeholder while leaving panel subscriptions alive so the same instances can resume. A second, independent detection path exists: the IDE's version-control configuration-change event, which performs the same switch when it observes the entry gone. Subsequent panel-driven actions short-circuit because the cached status is null and the collaborators report failure.

The user can re-create the repository and call the explicit reset hook, which clears repository-removed and the initialized flag so the next initialization runs the whole sequence again — rebuilding the collaborators, re-resolving the root (which may differ if the layout changed) and re-subscribing to repository-change events. The tool window calls reset itself before re-initializing whenever it finds the flag set.

### Disposal

On project close, in order: set the disposed marker **first**, so a change batch already in flight refuses to schedule a fresh timer against a released service; dispose the sync orchestrator; stop the debounce timer and clear its escalation flag; clear and stop the note-source check's pending set and timer; hand the watch roots back to the platform; clear the **status** and **sync-state** lists.

The **working-context, selection, memory-state and back-fill lists are not cleared**, and neither is the cached status — a reader holding a stale reference after disposal still sees the last-known status, though no new refresh will occur. The change subscription unhooks itself through the service's own disposal handle; there is no watcher thread to interrupt.

Hooks are **not** uninstalled on disposal; installation persists on disk across IDE sessions.

## State Transitions

```
[no service]  ── project opens with no repository entry ──> notification only; no service
[no service]  ── project opens, no usable runtime ────────> notification only; no service
[no service]  ── both gates passed ───────────────────────> [uninitialized]

[uninitialized] ── initialize, runtime probe fails ───────> [runtime-missing]
                                                            (nothing started at all)
[uninitialized] ── initialize completes ──────────────────> [initialized, repository present]

[initialized] ── status refresh finds the entry gone ─────> [initialized, repository removed]
                                                            (sticky; status list still fires)
[initialized, repository removed] ── explicit reset ──────> [uninitialized]

[any] ── project closes ──> disposed marker set first; timers stopped; watch roots
                            handed back; status + sync lists cleared; others left
```

## Notable Behavior

- **The status refresh is not a superset of the working-context refresh, and the two debouncers pick exactly one.** A subscriber on the working-context list alone is skipped by any escalated batch, and an escalated batch is precisely what a committing agent produces. The current subscribers are all on both lists, so nothing shows the defect; adding a working-context-only panel would reintroduce it silently. (Notable.)
- **A panel that renders only from its own snapshot store joins neither list**, which is a decision rather than an oversight — nothing a refresh recomputes can change what it paints.
- **The automatic startup repair is the sole sender of the respect-the-opt-out instruction.** Every other install caller leaves it off, deliberately, because there the click is what lifts the opt-out. The two are mutually exclusive with the clear-on-success instruction, and sending both would ask the delegated side to honour the opt-out and then erase it.
- **The legacy paused preference is projected but never cleared, and the mapping is deliberately not injective.** One machine-wide flag standing for every repository is exactly why clearing it on behalf of the first repository opened would silently un-pause all the others. The tri-state gate is what stops the projection re-firing on every start and permanently undoing an explicit re-enable.
- **The tri-state probe is deliberately not run for users who never used the retired control**, because it forks a subprocess on a path that can be the interface thread. Gating it on the legacy preference cannot change any outcome, because the derived condition is false either way when the preference is unset.
- **Two reads inside initialization deliberately bypass the round trip and read disk.** The opt-out read in the first status refresh, and the tri-state probe, both exist on a path that can be the interface thread where the status probe is already one cold round trip. Reading the profile directly is sound rather than degraded here: it is written temp-file-then-rename, so a torn read is impossible, and the on-disk truth is exactly what the repair gate wants.
- **The migration is dispatched, not awaited**, and its outcome reaches the initialization log after that log has already been published — so the settled line is appended out of band, and can be lost outright if it lands before the log is first assigned. A follow-up status refresh runs on both its success and its failure paths, because even a failed migration can leave the folder partly populated.
- **No read source is mounted against the mirror folder any more.** Every memory read goes through the delegated storage stack; a surviving direct read of that folder would keep serving plausible stale data. (Corrected: this spec previously described an attach step, a re-attach hook and a declined-attach state. None of them exists — that read path was deleted.)
- **A status refresh costs a round trip, not a local computation.** Because refreshes are driven by two independent debounced watchers plus the IDE's own repository-change events, an ordinary commit can cost several of them.
- **Starting the refresh-notification client is a no-op.** It flips a flag and nothing more; the channel arrives with the first bridge call, which initialization itself makes several times over.
- **The read-path warm-up is a real round trip, not a local cache touch**, which is why it also has the side effect of bringing the long-lived connection and its server process up during initialization.
- **Both fire-and-forget warm-ups degrade to nothing.** The only consequence of either failing is that the first user action pays the cost it was meant to hide — exactly the behaviour that existed before they were added.
- **The resolved root is the repository top level, not the project base path, and not the main checkout either.** A project opened on a subdirectory of a repository stores the repository root; a project opened on a linked checkout stores that checkout's own root. The field's name says "main repository root" and is a legacy misnomer. (Corrected: this spec previously stated the resolution returns the project directory unchanged and that the installer and reader therefore receive identical paths. It runs a revision-parse query and returns the project directory only when the top level canonically equals it or the query fails — so the two arguments genuinely diverge for a project opened on a subdirectory. The nullable-return fallback is still unreachable.)
- **A subscriber that joins the status list after a snapshot is cached receives an immediate first callback**, which is how the tool window's many panels avoid a startup race where some never see the initial status. The working-context, selection and memory-state lists have no such immediate fire.
- **The removal flag is sticky within a session** and is cleared only by the explicit reset hook, never by a later refresh discovering that the repository returned.
- **A refusal caused by the opt-out is deliberately recorded as no error at all**, because the error field is rendered to the user in red; reporting a fault to someone who turned the product off is the wrong message. The install still reports failure, because nothing was written.
- **The full initialization log is written to a per-user diagnostics file on every run, successful or not**, so support can reproduce the path-resolution decisions the sequence made.
- **Disposal clears two of the subscription lists and leaves the rest populated**, and does not clear the cached status.
- **Initialization writes no agent-skill files.** They are owned entirely by the delegated command-line surface — written by its full enable and refreshed by its version-gated integrations catch-up.

## Shared Behavior

- **Refresh Escalation Rule (338)** — the sticky one-way flag that decides which of this service's two refreshes a mixed debounce window runs. Both callers of that rule land here.
- **IntelliJ Orphan-Branch Ref Monitoring (125)** — the in-process file-system watcher this service starts and stops, which reaches both refreshes.
- **IDE-Bridge Refresh Notification Channel (289)** — the pushed path into the same two refreshes; **IntelliJ CLI Daemon Connection (288)** — the connection that carries it and that serves every bridge call this service makes.
- **IntelliJ Enable / Disable Surface (332)** — owns the two gestures, the cached verdict's read modes, the install-protection window, the mutually exclusive install flags, and the canonical treatment of the legacy projection. This service owns where the projection sits in the sequence and the repair gate that consumes its result.
- **The durable opt-out (145)** — owns the profile file, its field split, its main-checkout anchoring and its read precedence.
- **IntelliJ Node.js Runtime Detection and Hard Gate (284)** — the probe that stops both the startup activity and initialization before anything else runs.
- **IntelliJ Delegated Hook Installation (128)** — owns the install and teardown this service triggers, and the status snapshot's shape.
- **IntelliJ Pre-Push Sync Catch-Up (271)** and **IntelliJ Embedded-Browser Pool (302)** — dispatched to during initialization and never waited on.
- **The delegated Memory Bank migration (293)** — decides whether there is anything to migrate and whether a full run or an idempotent reconcile is called for; this service only dispatches it, serializes it against every other migration entry point, and records its settled outcome.
- **IntelliJ Native Repository Wrapper (126)** — owns the root-resolution helper whose answer this service stores and hands downstream.
- **IntelliJ Tool Window Layout (118)** and **IntelliJ Status Overlay (133)** — the card routing and overlay this service's flags drive.
