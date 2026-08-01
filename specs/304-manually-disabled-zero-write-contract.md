# 304. Zero-Write Contract for a Manually-Disabled Repository

## Topic Statement

A repository whose user recorded the durable, repo-wide "memory capture is off here" opt-out is supposed to receive no writes at all. The mechanism that delivers that promise is a **process-wide in-memory suppression flag** that mirrors the durable opt-out, consulted by twenty-odd write sites that sit on synchronous or latency-sensitive paths where the durable reader (async, one source-control subprocess plus a file read, and itself capable of persisting a migration decision) is unaffordable. Only the **editor host process** ever sets that flag. Every gate built on it is therefore inert in command-line invocations, source-control hooks, agent hooks, the background queue worker, the compensation worker, the IDE bridge, and the notification daemon — those remain gated only by their own pre-existing reads of the durable opt-out. The zero-write contract is consequently a property of the editor host process, not of the product. On top of that scope limit sit two deliberate carve-outs: the telemetry recording primitive is not gated at all, and machine-global writes are outside the contract entirely.

## Scope

**In scope:**
- The in-memory suppression flag: why it exists, who sets it, who clears it, and its process-local lifetime.
- The synchronous read-only reader that seeds it, and how that reader deliberately differs from the durable reader.
- The complete inventory of writes suppressed while the flag is set, each one's trigger, what happens in its place, and whether reads keep working.
- The scope limitation — which surfaces the flag never reaches, and what those surfaces still write when invoked directly against a disabled repository.
- The carve-outs: telemetry recording, and machine-global configuration / instruction-block writes.
- The clearing sequence on re-enable, its ordering guarantees, and what does *not* clear the flag.
- Gates that are declared but cannot be true on their only executing path.

**Out of scope:**
- The durable opt-out's own storage, repo-wide anchoring, legacy-marker migration, priority, locking, and write-failure semantics (spec 145).
- The runtime capture gate in the source-control hooks, agent hooks, and background workers — those read the durable opt-out directly and are owned by spec 145 and by each entry point's own topic.
- The auto-enable substep and the new-worktree auto-repair path, which read the durable opt-out (specs 144, 100).
- The re-enable transcript-discovery drain's internals (spec 305).
- What each suppressed subsystem does when the repository is *enabled* — owned by that subsystem's topic.
- The sidebar's disabled panel rendering, and the diagnostics command's report wording.
- Security: the opt-out is a UX preference, not an access control.

## Data Contracts

### The in-memory suppression flag

| Property | Value |
|---|---|
| Type | A single process-wide boolean, default **false**. |
| Semantics | `true` = "this process must not write into this repository or its Memory Bank folder." |
| Lifetime | Process-local. Never persisted, never shared, gone when the process exits. |
| Writers | Exactly three call sites, all inside the editor host's activation module: the activation seed, the Enable command (clears), the Disable command (sets). |
| Readers | Every gate in the inventory below, plus two read-side display gates. |
| Cost per check | One boolean read. This is the entire reason it exists. |

The durable opt-out remains the source of truth. The in-memory flag is a cache of it, and the two are flipped in lockstep by the enable/disable commands — with a deliberate ordering difference between the two directions (see **Clearing**).

### The synchronous read-only reader

The seed cannot use the durable reader: that reader is asynchronous (unavailable at the point activation needs the answer) and, on a repository with no decision recorded, **persists** one — which would itself be a write. A separate reader exists purely for seeding, with a deliberately weaker contract:

| Step | Behavior |
|---|---|
| 1 | Resolve the repository's shared common location synchronously, to anchor on the **main** worktree — so a linked worktree of a disabled repository reads the same shared decision instead of re-enabling on reload. Costs one source-control subprocess, once per activation. |
| 2 | Read and parse the repo-wide profile. A recorded decision of either value wins outright. |
| 3 | On any failure (not a repository, missing profile, unparseable profile, absent field), fall through to the **legacy per-worktree opt-out marker in the current worktree only**. |
| 4 | Otherwise report "not disabled". |

Two properties are load-bearing and both hold:
- It **never enumerates worktrees.** The durable reader checks every worktree; this one checks only the current one, keeping the seed cheap.
- It **never persists anything.** No migration of the legacy marker, no recording of a confirmed absence, no lock taken. Persisting would be a write, which is exactly what the flag exists to prevent.

The consequence of (3) plus (4) is a narrow, grounded gap: a repository disabled in a *sibling* worktree before the durable field existed, whose profile has no recorded decision yet, seeds as **not disabled** in this worktree. The durable reader corrects this later — and persists the correction — on the first path that consults it.

### Seed position

The seed is the **first statement after the git-presence branch** of activation, and **before the log channel is initialized**. Both halves matter:

- Before the log channel: the very first activation log line would otherwise reach the on-disk debug log of a disabled repository.
- After the git-presence branch: the two degraded activation branches (no folder open, folder with no repository) return before the seed runs, so the flag stays `false` there. Nothing is suppressed in those branches and nothing needs to be — no bridge, stores, watchers, or migrations are ever constructed.

## Behavior

### The consolidated inventory of suppressed writes

Every row below is gated on the **in-memory flag** unless the row says otherwise. "Reads" records whether the corresponding read path keeps working while the write is suppressed.

| # | Suppressed write | Trigger | What happens instead | Reads |
|---|---|---|---|---|
| 1 | The on-disk debug log: the append, the size check, the archive rename, and the archive pruning — all of which live inside a queued work item | Every log call in the host process | The gate sits ahead of the work item, so the item is never even queued. The **level filter and the standard-error mirror still run** ahead of the gate, and the editor's own output pane still receives every line unaffected — only the on-disk destination is silenced | n/a |
| 2 | The system-of-record store's multi-file write | Any memory / transcript / plan / note / reference write routed through it | Returns **before the store-creation step**, so the repository's dedicated memory history is never created | Unaffected |
| 3 | The Memory Bank folder store's multi-file write | Same | Returns **before the store-creation step**, so no folder tree, no hidden canonical layer, no visible Markdown layer | Unaffected |
| 4 | The dual-write composite's multi-file write | Same | Returns before delegating to either backend. Redundant with rows 2–3 for the writes themselves, but **not** redundant overall: the composite's success tail clears the shadow-dirty marker, which would otherwise record a never-performed folder write as clean | Unaffected |
| 5 | The summary write (payload plus index and catalog rebuild) | In-process generation and repair paths | Returns **before acquiring the cross-worktree write lock** — acquiring that lock is itself a directory-and-file creation, so the storage-level gates alone would still leave a lock artifact behind | Unaffected |
| 6 | The transcript batch write/delete | Same | Same pre-lock position | Unaffected |
| 7 | The plan-file write | Same | Same pre-lock position | Unaffected |
| 8 | The note-file write | Same | Same pre-lock position | Unaffected |
| 9 | The reference-file write | Same | Same pre-lock position | Unaffected |
| 10 | The cross-branch commit-alias persist | A commits listing that finds commits with no summary of their own | Returns **"nothing advanced"** before the lock. The return value tells the caller no alias was written, so no panel refresh is requested. The gate is what breaks a loop: the storage-level suppression alone would silently drop the persist, and every subsequent listing would re-detect the same candidates and re-create the lock file | Unaffected |
| 11 | The Memory Bank folder identity claim, and the schema defaults seeded alongside it | Resolving the per-repo Memory Bank folder when no folder already carries this repository's identity | The chosen candidate path is still **returned** to the caller, but nothing is created and no identity is stamped — so the next resolution re-derives the same candidate from scratch | Unaffected |
| 12 | The full migration from the system-of-record store into the Memory Bank folder | Startup initialization, and the re-enable catch-up | **Four** gates: at entry, per-entry inside the main loop, before the bulk passes, and at the top of the stale-child reconcile. Each returns a transient "skipped" outcome. The mid-run gates exist specifically for a disable clicked *during* a long first-install migration | Unaffected |
| 13 | The migration progress document | Every progress checkpoint and the final outcome of migration | The outcome object is still returned to the caller but is **never persisted**. This is what stops a mid-run disable from recording silently-dropped entries as migrated, or a false "completed" that would block a later re-migration | Unaffected |
| 14 | The entire startup knowledge-base initialization — legacy migrations, the schema migration, the folder identity claim, the full migration, and the stale-child reconcile | Activation | Returns immediately. Its **completion barrier still resolves** as usual, so the watchdog is cleared and the sync gate is released rather than hanging | Unaffected |
| 15 | The version-upgrade hook-path refresh | Activation | The call is replaced with a **synthesized "no version mismatch"**, so no hook reinstall and no outdated-version warning. Without this, an extension upgrade — which makes the recorded runtime path stale every time — would reinstall hooks and silently override the opt-out | n/a |
| 16 | The startup skill reconciliation | Every command-line invocation except the three that own skill lifecycle themselves | Gated on the **durable** opt-out, read through the synchronous read-only reader precisely because the async reader's legacy-marker migration is itself a write. It is the **fourth** precondition, after the development-build guard, the "is Jolli installed in this tree" probe, and the "already reconciled for this version" marker check. Returns without rewriting any skill and without stamping the marker. **This is the only gate in the inventory that also fires outside the editor host** | n/a |
| 17 | Automatic telemetry: the per-activation client event, and every buffer flush (the activation flush, the fixed background interval, and the sidebar tick) | Activation and timers | The activation event is not recorded; the flushes are skipped entirely. Anything already in the repo-local buffer therefore sits **undelivered until re-enable** | n/a |
| 18 | The Memory Bank sync round | The auto-sync poll tick **and** the manual "sync now" gesture, which is exempt from the round's other cancellation check but not from this one | Checked **per round**, not at start, and checked **twice** — once before the knowledge-base-init barrier and again after it — so a disable that lands while a round is parked on that barrier still silences it. The pre-tick state is restored and the sidebar sync indicator is cleared | Unaffected |
| 19 | Three read-side registry normalization write-backs (plans, notes, references) | Any panel refresh that finds a legacy row or field to purge, or an orphaned plan row to clean | The normalized registry is used for **display** but not persisted, and the registry lock is not taken. Purely a deferral — the next refresh while enabled performs the identical one-shot normalization | Unaffected |
| 20 | The plan-directory watcher's registration | An agent session saving a plan file while the repository is disabled (the watcher keeps firing) | The plan is not registered. It is not lost either: saving it again after re-enable, or the agent-hook path once hooks are reinstalled, registers it | Unaffected |
| 21 | The folder browser's reconcile-and-heal pre-pass (manifest reconcile plus regeneration of missing visible Markdown) | Expanding a Memory Bank folder in the sidebar | The tree still lists. The per-session **clean-repo memo lives inside the skipped block**, so a disabled repository is never memoized clean and the pre-pass **re-arms automatically** after re-enable | Unaffected |
| 22 | The "Migrate to Memory Bank" action in Settings | User click | **Refused outright with a message.** A partial run would be worse than useless: the identity write is suppressed, but the folder creation and the re-point configuration write are not — one click would de-identify the previous folder while migrating nothing | n/a |
| 23 | The settings-save integration hook sync | Saving settings | Skipped in **both directions** — neither installs nor removals run. Removals are unnecessary (disable already uninstalled), and installs would silently override the opt-out. The settings write itself still happens (see carve-outs) | n/a |
| 24 | The polling conversation-discovery tick's cursor, plan, and reference writes | The sidebar's periodic tick, which keeps firing while the disabled panel is displayed | **Step zero** — ahead of the configuration read, ahead of the per-source enable check, and ahead of the host-installed detection | Unaffected |
| 25 | The manual commit-generation command | Command-palette invocation (the sidebar button is not visible while disabled) | Refused with an information message **before** the off-path count gathering and before generation | n/a |
| 26 | The re-enable transcript-discovery drain | Declared defensively; see **Declared but unreachable** below | Returns "nothing scanned" | Unaffected |
| 27 | The captured-skill file write | The skill-capture pipeline persisting captured skill files | Joins the rows 5–9 family: returns **before acquiring the cross-worktree write lock**, for the same reason — the lock acquisition is itself a directory-and-file creation, so a storage-level gate alone would leave a lock artifact in a disabled repository. An empty file list short-circuits ahead of the gate, so the two are indistinguishable from outside | Unaffected |
| 28 | The agent-CLI skill discovery pass | The sidebar's periodic tick, which keeps firing while the disabled panel is displayed | Reports **zero discovered** ahead of the configuration read, ahead of the per-source enable check, and ahead of any registry write — the same step-zero position as row 24, and for the same reason: a pass writes into the project's local state directory | Unaffected |

Two further readers of the flag are **not** write suppressions and are listed here only so the inventory is not mistaken for the full set of readers: the sidebar's initial paint and its enabled-changed push both fold the opt-out into the *displayed* enabled state, because the install-state signal can legitimately report "enabled" for a disabled repository (a hook shared across worktrees, or a hook reinstalled out of band).

### The scope limitation

Only the editor host process sets the flag. In every other process it stays `false` for the whole lifetime, and therefore **every mirror-based row above is inert there**. What still protects those surfaces is the pre-existing per-entry-point read of the *durable* opt-out (spec 145): the source-control hooks, both gated agent hooks, the queue worker, and the compensation worker each read it at the top of their own hot path and return early.

Surfaces with **no** read of the durable opt-out anywhere on their path still write when invoked directly against a disabled repository. Verified:

| Surface | Still writes? | Detail |
|---|---|---|
| Standalone Memory Bank sync command | **Yes** | Runs a full sync round: ensures the folder, runs migration, stages, commits, and pushes in the Memory Bank vault. Its only precondition is a valid credential. |
| Memory Bank migrate command | **Yes** | Runs the full migration, or the idempotent stale-child reconcile when already migrated. Deliberately requires no sign-in. |
| Notification daemon | **Partially** | Consults the opt-out nowhere. It performs no memory writes of its own — it watches and emits notifications — but its own log lines are not suppressed, so they land in the disabled repository's debug log. |
| IDE bridge command | **Yes** | Its commits listing runs the cross-branch alias persist (row 10) with the flag `false`. |
| Every other command-line invocation | **Yes**, for the debug log | The flag is never seeded, so ordinary command log lines append to the disabled repository's on-disk debug log. |

The suppression is per-process in a way that shows up even inside the editor's own flow: the compensation drain kicked off when startup initialization settles is a **detached child process**. The spawn is not gated. The child reads the durable opt-out at its entry and correctly performs no work — but its flag is `false`, so its "skipped — repository manually disabled" line is written to the disabled repository's debug log.

The plugin surfaces of the third IDE integration do not participate in this contract at all: nothing in that codebase reads or writes either the durable opt-out or the in-memory flag. Its correctness against a disabled repository rests entirely on the hooks and command-line entry points it installs and spawns, which carry their own durable-flag gates.

### The carve-outs

**Telemetry recording is not gated.** The recording primitive checks only initialization and consent. It creates the repository's state directory and appends to the repo-local event buffer. So while the flush is suppressed (row 17), any event *recorded* while the flag is set still writes:

- The **explicit disable funnel event** is recorded immediately after the flag is set and the uninstall succeeds. This is called out in the code as deliberate and contrasted with the automatic activation event, which *is* suppressed: the distinction drawn is automatic-write versus user-gesture.
- The **explicit enable funnel event** fires after the flag has already been released, so it lands in a repository that is no longer disabled.
- Every other **user-gesture** event the disabled surfaces can still produce is likewise ungated — most visibly the "tool window opened" event, which the sidebar records on every reveal, including the reveal that renders the *disabled* panel. Settings-opened, sign-in, and view-navigation events behave the same way.
- The **first-run install event** is recorded by the telemetry bootstrap on the run that mints the machine identity, which on the editor path runs after the flag is seeded.

**The onboarding-funnel ledger is a second ungated repo-local write.** The onboarding-funnel snapshot (spec 312) writes a dedup ledger at `<projectDir>/.jolli/jollimemory/onboarding-progress.json`, creating the containing directory recursively and then writing the file atomically. Nothing on that path reads the in-memory suppression flag or the durable opt-out — the emitter's only gate is telemetry consent. So this is a distinct write class from the buffer append above: a **new file**, not an append to the buffer the telemetry primitive already owns.

It is reachable against a disabled repository in the editor host, and not marginally so. The in-memory flag is seeded during activation, and the status-store refresh that drives the snapshot still runs: at activation, from the sessions and HEAD watchers, from the manual refresh command, from the fan-out refresh — and, most pointedly, immediately after the Disable command sets the flag and completes the uninstall. Stated plainly: **the disable gesture itself now produces both a buffered `onboarding_progressed` envelope and a ledger file in the repository it has just disabled.** Flush suppression (row 17) is unchanged, so both sit undelivered until re-enable, but the file on disk is real from the moment the gesture completes. (Surprising. The JVM IDE surface is unaffected, because it does not participate in this contract at all — see above.)

Repo-local telemetry buffer appends and the onboarding-funnel ledger are therefore the write classes a disabled repository genuinely still receives, and because flushes are suppressed the buffered events accumulate undelivered until re-enable.

**Machine-global writes are outside the contract.** Verified on the settings-save path, which runs while disabled: the machine-global configuration write happens, and a global-instructions transition still installs or removes the managed instruction block in each detected host's machine-global instruction file. The contract covers repo-local and Memory Bank writes only. This is consistent with those files being shared by every repository on the machine — a single repository's opt-out cannot speak for them.

### Clearing

The re-enable sequence in the editor host, in order:

1. **Install** — the bridge-level enable runs first. Throughout it the flag is still set, so the installer's own log lines are suppressed. (Nothing else the installer does routes through a gated write path: hooks, skills, integration registration, and the exclude entry are all ungated, and the schema migration step is deliberately skipped on this source because the host owns it with UI.)
2. On failure: **stop.** Neither flag is touched, an error notification is shown, the repository stays disabled and coherent.
3. **Release the in-memory flag** — before anything else. Two reasons, both grounded: the session stays fully functional even if the durable clear below fails, and the gates inside the catch-up initialization in step 5 would otherwise short-circuit again.
4. **Clear the durable opt-out.** A failure here is **non-fatal**: it logs a warning naming the stuck opt-out and telling the user to run enable again. Hooks are already installed, so failing the whole command would be worse.
5. **Re-run the serialized startup initialization** — catching up everything row 14 skipped. Safe to re-run: every step inside is idempotent against its own state file, and the runner serializes against any still-running activation-time run.
6. **Await the transcript-discovery drain** — awaited (not fire-and-forget) so the panels refreshed below pick up freshly written plans and references. Best-effort; a failure is handled and does not abort the enable. Owned by spec 305.
7. **Record the enable funnel event**, then refresh the status bar, then refresh every panel, then recompute and push the cold-start signals.

The disable sequence is the mirror image and its ordering is deliberately **reversed**:

1. **Write the durable opt-out first.** If that write fails the command aborts: an error notification, nothing changed, no uninstall — because a hooks-removed-but-flag-unset half-state would be silently re-enabled by a later upgrade or activation.
2. **Set the in-memory flag**, so any log line or write triggered by the uninstall and the refresh chain that follows does not reach disk.
3. **Uninstall.**
4. On success, record the disable funnel event (which, per the carve-out, does write), then refresh status and repaint.

**What does not clear either flag** — verified: an extension upgrade (row 15 turns the refresh into a synthesized no-mismatch, and the bridge-level entry point independently returns early on the durable read); a window reload (activation re-seeds the flag from the durable opt-out, so the opt-out survives); the diagnostics command (reports the disable as healthy and attaches no re-install fixer); the agent-plugin's per-session bootstrap (reads only); the new-worktree auto-repair (gated on the durable read). Only an explicit enable clears it.

### Declared but unreachable

The re-enable transcript-discovery drain carries its own in-memory-flag gate (row 26), documented in the code as defensive. Its **only** caller is the enable command, which releases the flag two steps earlier. On that path the gate can therefore never be true, and there is no other executing path to the drain. It is a declared guard, not observable behavior.

Row 15's gate is redundant in outcome but not dead: the bridge-level refresh entry point independently returns early on the durable opt-out, so both paths produce "no mismatch". The in-memory gate's only effect is to reach that outcome without the asynchronous read.

## State Transitions

The in-memory flag's lifecycle, per process:

| From | Event | To | Notes |
|---|---|---|---|
| (unset) | Process is anything other than the editor host | **false**, forever | Never seeded, never set. Every mirror-based gate is inert; the durable per-entry-point gates are what apply. |
| (unset) | Editor activation, no folder open, or folder with no repository | **false**, forever | Both degraded branches return before the seed. Nothing is constructed, so nothing needs suppressing. |
| (unset) | Editor activation in a repository, durable opt-out recorded `true` | **true** | Set as the first statement after the git-presence branch, before the log channel exists. |
| (unset) | Editor activation in a repository, durable opt-out recorded `false`, or absent with no legacy marker in this worktree | **false** | The recorded value wins outright when present. |
| (unset) | Editor activation, no recorded decision, legacy marker present **in this worktree** | **true** | Nothing is persisted — the durable reader migrates it later, on whichever path consults it first. |
| (unset) | Editor activation, seeding read fails at any step | **false** | Any failure degrades to "not disabled" — the direction that keeps capture working rather than silently killing it. |
| true | Enable command, install fails | **true** | Neither flag touched. |
| true | Enable command, install succeeds | **false** | Released *before* the durable clear, and before the catch-up initialization. |
| true | Enable command, install succeeds, durable clear fails | **false** | The session is functional; the durable opt-out is still `true`, so the *next* window reload re-seeds `true`. A warning names the stuck opt-out. |
| false | Disable command, durable write fails | **false** | Command aborts; no uninstall. |
| false | Disable command, durable write succeeds | **true** | Set *after* the durable write, *before* the uninstall. |
| true | Extension upgrade, window reload, diagnostics auto-fix, plugin session bootstrap, new-worktree auto-repair | **true** (a reload re-seeds it from the surviving durable opt-out) | None of these clear either flag. |
| true | Any gated write site fires | **true** | Every gate is read-only. A disabled repository's timers, watchers, and sidebar ticks keep firing and keep returning early forever; nothing self-heals and nothing accumulates. |

## Notable Behavior

- **The zero-write contract is a property of the editor host process, not of the product.** Nineteen of the twenty-six inventory rows exist only inside one long-lived process. Invoke the standalone sync command, the Memory Bank migrate command, or the IDE bridge directly against a disabled repository and they write normally, because nothing on their path consults either flag. (Surprising; the single most important qualification in this spec.)
- **Exactly one gate escapes that limitation**, and it does so by reading the *durable* opt-out rather than the mirror: the startup skill reconciliation, on every command-line invocation. It uses the synchronous read-only reader specifically because the ordinary durable reader would migrate a legacy marker — a write — on the very path that must not write.
- **Acquiring a lock is a write, and five gates are positioned to prove it.** The five shared write entry points check the flag *before* taking the cross-worktree write lock, not after, because the storage-level suppression alone would still leave a lock directory and file behind on a disabled repository.
- **One gate exists to prevent a loop, not a write.** The cross-branch alias persist would be dropped by the storage layer anyway; without its own gate, the never-persisted result would make every commits listing re-detect the same candidates and re-create the lock file indefinitely.
- **The dual-write composite is gated redundantly on purpose.** Both its backends already suppress. The composite's gate is about its *tail*: clearing the shadow-dirty marker would record a folder write that never happened as clean.
- **Migration is gated four times plus once more for its progress record.** Three of the four gates exist for a disable clicked mid-run, and the fifth — on the progress document — is what stops a mid-run disable from persisting silently-dropped entries as migrated, or a false "completed" that would permanently block re-migration.
- **The startup initialization is skipped whole, but its completion barrier still resolves.** Skipping without resolving would leave sync rounds waiting forever; the watchdog exists for the same reason and is cleared on the same path.
- **A refusal can be safer than a suppression.** The "Migrate to Memory Bank" action is refused with a message rather than partially suppressed, because its identity write is gated while its folder creation and re-point configuration write are not — a suppressed-but-not-refused click would de-identify the previous folder while migrating nothing.
- **The manual sync gesture is refused too.** The sync round's other cancellation check exempts a user-initiated round; this one does not. It is also checked twice per round, so a disable that lands while a round is parked on the initialization barrier still silences it.
- **The folder browser's clean-repo memo is deliberately inside the skipped block.** A disabled repository is never memoized clean, so the reconcile-and-heal pre-pass re-arms by itself on the first listing after re-enable rather than staying suppressed for the rest of the session.
- **Telemetry is the write class a disabled repository genuinely still receives, and it is now two writes, not one.** The recording primitive is entirely ungated, so the deliberate disable funnel event *and* every user-gesture event the disabled surfaces can still produce — including the "tool window opened" event fired by the very reveal that paints the disabled panel — create the state directory and append to the repo-local buffer. Because flushes are suppressed, those events sit undeliverable until re-enable. (Surprising; only the funnel pair is documented in code as intentional.)
- **The onboarding-funnel ledger makes the disable gesture itself write a new file into the repository it just disabled.** The snapshot emitter (312) is gated on telemetry consent only — it reads neither the in-memory mirror nor the durable opt-out anywhere on its path — and the status refresh that drives it runs immediately after the Disable command sets the flag and uninstalls, as well as at activation and from four other uncoordinated triggers. So a disabled repository receives both a buffered `onboarding_progressed` envelope and an `onboarding-progress.json` ledger, the latter created with a recursive directory creation and an atomic file write. This is a *different* write class from the buffer append above: a new file rather than an append to a buffer the telemetry primitive already owns. (Surprising; not documented in code as intentional, unlike the funnel pair.)
- **Suppression is per-process even inside the editor's own flow.** The detached compensation drain spawned when startup initialization settles is not gated at the spawn; the child correctly does no work (it reads the durable opt-out) but writes its "skipped" line into the disabled repository's debug log, because the child's mirror is `false`.
- **The debug-log gate silences only the on-disk destination.** The level filter and the standard-error mirror run ahead of it, and the editor's own output pane is a separate destination that is never suppressed — so a disabled repository is still fully diagnosable in the IDE.
- **Enable releases the mirror first; disable writes the durable flag first.** The asymmetry is deliberate in both directions: on enable, releasing first keeps the session usable if the durable clear fails *and* keeps the catch-up initialization from short-circuiting on its own gates; on disable, persisting first avoids a hooks-removed-but-flag-unset half-state a later upgrade would silently re-enable.
- **The seeding read is deliberately weaker than the durable reader** — no worktree enumeration, no persistence. The cost is one narrow gap: a repository disabled in a sibling worktree before the durable field existed, and with no decision recorded yet, seeds as not-disabled in this worktree until some path consults the durable reader.
- **Reads are never suppressed.** Every row that touches storage leaves its read path fully working, which is what lets the disabled sidebar keep listing memories, folders, plans, and references while writing nothing.
- **The degraded activation branches never seed the flag.** A non-repository workspace leaves it `false` — harmless, because those branches construct no bridge, stores, watchers, or migrations.
- **One declared guard is unreachable.** The re-enable discovery drain's own gate cannot be true on its only executing path, because its only caller releases the flag first. It is documented in code as defensive and is not observable behavior.

## Shared Behavior

- **The durable repo-wide opt-out** — its storage, main-worktree anchoring, legacy-marker migration, priority, locking, write-failure semantics, and the runtime capture gate in the hooks and workers are all owned by spec 145. This spec owns only the in-memory mirror, its seeding, and the write sites built on it.
- **The re-enable transcript-discovery drain** — spec 305 owns the drain itself; this spec owns only its position in the clearing sequence and its own (unreachable) gate.
- **Activation ordering** — spec 100 owns the activation sequence; the seed described here is inserted at its head, and the version-upgrade refresh and auto-enable substeps that follow are owned there and by spec 144.
- **The storage backends** — the system-of-record store, the Memory Bank folder store, and the dual-write composite each own their own write semantics, layer layout, and shadow-dirty accounting; this spec owns only where each one's gate sits relative to its store-creation step.
- **Memory Bank folder resolution and identity** — the suffix scan and identity-claim policy are owned by the folder-layout and repo-identity topics.
- **The migration engine** — the migration's own passes, idempotence, and stale-child reconcile lifecycle are owned by the migration topic.
- **Telemetry** — the recording choke-point, consent resolution, scrubbing, buffer format, and flush protocol are owned by the telemetry topics (204/205/206); the onboarding-funnel snapshot, its dedup ledger, and its heartbeat are owned by spec 312. This spec owns only which telemetry writes are and are not gated.
- **Skill capture** — the capture pipeline that produces skill files and the agent-CLI discovery pass that feeds it are owned by specs 319–322 (core) and 323–326 (surfaces); this spec owns only where each one's gate sits.
- **Memory Bank sync** — the round engine, vault locking, and conflict policy are owned by the sync topics; this spec owns only the per-round refusal.
- **The lock primitives** — the cross-worktree write lock and the registry lock are owned by the lock-primitive topic; this spec relies only on the fact that acquiring one is a write.
- **The settings surface, the folder browser, the sidebar, and the command palette** each own their remaining behavior; this spec owns only what each one refuses or skips while the flag is set.
