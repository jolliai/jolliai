# IntelliJ Project Service Lifecycle

## Topic Statement

A per-project service initializes the Jolli Memory bridge on project open, listens for the `.git` entry being removed or restored mid-session, and notifies UI panels of installation-state changes through a single subscription bus.

## Scope

- Service creation on project open and disposal on project close.
- One-time initialization that resolves the current worktree root, builds the lazy git, hook installer, and summary reader collaborators, and computes the first installation status.
- Suggesting `git init` via a one-time platform notification when the project has no `.git` entry on open.
- The status-listener API used by all panels in the side tool window.
- Detecting that `.git` has been removed (or has reappeared) since initialization, and signalling panels to switch their UI accordingly.
- Resetting the initialization flag so a re-opened repository can re-run initialization without restarting the IDE.
- The two fire-and-forget warm-ups dispatched near the end of initialization (a read-path warm-up and a browser-pool prewarm), and what a failure of either costs.
- Attaching the direct memory-mirror read source during initialization, the re-attach hook that lets a settings save re-point it mid-session, and the threading and failure contract of both.
- The bounded in-memory cache of single-memory reads this service owns, and the two triggers that empty it.

Out of scope: hook installation itself, summary reading, ref watching (covered by spec 125), the pending-push drain's own mechanics (covered by spec 271; this service only dispatches it), the embedded-browser pool's own capacity/eviction/disposal rules (covered by spec 302; this service only asks it to prewarm), the direct memory-mirror read source's own eligibility rules, read shapes, decline conditions, and lockstep obligation (covered by spec 307; this service only attaches and re-attaches it), and any individual panel's UI.

## Data Contracts

The service exposes the following observable state to panels.

- `isInitialized` (boolean) — true once the first initialization has completed for the current project session.
- `gitRemoved` (boolean) — flips to true the first time a status check sees that `.git` no longer exists at the project base path; never flips back to false except via the explicit reset hook.
- `mainRepoRoot` (string or null) — the **current worktree root**, which is the project base path unchanged. The field name is a legacy misnomer: the git wrapper's resolution helper no longer walks up to the main worktree (spec 126), so a project opened on a secondary worktree stores that worktree's own root here. Renaming the field is deferred as a large mechanical cleanup.
- `lastError` (string or null) — human-readable description of the most recent failure during a status check or installer call, or null when the last operation succeeded.
- A cached `StatusInfo` snapshot returned by the installation status check, accessible to panels without re-reading from disk.
- A bounded, access-ordered in-memory cache of parsed single-memory reads (capped at 128 entries, least-recently-used eviction, wrapped for concurrent access), consulted **before** the read path on every single-memory read. Entries are keyed by the requested commit identifier; when the lookup succeeded only after following a commit alias, the record is additionally stored under the resolved identifier. It is emptied **wholesale** — never per key — by exactly two triggers: any memory-state change notification, and an explicit invalidation call used by in-panel edit handlers that already refresh themselves locally and must not provoke a full listener fanout. Only the parsed-record read is cached; raw-document, plan-body, and note-body reads are not.
- A debug log string that records each step of the most recent initialization (whether `.git` exists, the resolved root, which Jolli state files exist, the installer's debug info, the result of the status check, and any exceptions).
- A panel registry attached after construction so contextual actions can locate panel instances by role.

The service exposes no setters for these fields; callers can only read them or subscribe to changes.

## Behavior

### Project open

When the project finishes opening, a startup activity reads the project base path. If the base path is null, the activity returns silently. If the base path has no `.git` entry, the activity emits a one-time platform notification advising the user to run `git init` or to enable version control through the IDE's VCS menu, and does not create the service. If `.git` exists, the activity asks the IDE for the project-scoped service instance, which lazily constructs the service and then calls `initialize()`.

### Initialization

Initialization is single-shot and gated by `isInitialized`. It performs the following in order:
1. Reads the project base path; if missing, records an error and returns.
2. Examines the `.git` entry to record whether it is a directory, a file (worktree pointer), or absent.
3. Builds the git wrapper for the project directory and asks it to resolve the worktree root, falling back to the project base path if that resolution yields nothing. The resolution now returns the project directory unchanged (spec 126), so the fallback is unreachable and the stored root is always the project base path.
4. Constructs the hook installer (with both the project directory and the resolved root) and the summary reader. The summary reader is constructed against the current worktree root (the project base path) because the status it now delegates to the command-line surface treats its working directory as the checkout being reported on — a worktree must report its own hook and data state, not its parent's. **The distinction this step used to draw has collapsed**: the resolved root and the current worktree root are now the same value, so the installer and the reader receive identical paths. The rationale still holds — it is simply no longer a divergence between two arguments.
5. Performs the first status refresh, populating the cached status snapshot or recording the failure.
6. Initializes the Memory Bank folder with the repo's identity (repo name and remote URL), then auto-migrates, then attaches the direct memory-mirror read source — all three inside one guarded step:
   - **Folder initialization** resolves the repo's identity and its per-repository mirror root and writes the identity record. (Corrected: this is not an in-process engine either — identity extraction, remote-URL lookup, configuration load, and the claiming root resolution are each a bridge call.)
   - **Auto-migration is a one-shot invocation of the command-line surface's migration command as a blocking subprocess with its own timeout**, not an in-process engine — the IDE-side migration engine no longer exists. The command-line surface itself decides whether an orphan branch has data and whether migration has already completed (full migration vs. idempotent reconcile), matching the desktop-editor activation path. Its reported status and entry counts are appended to the initialization log.
   - **Attaching the direct memory-mirror read source** re-uses the values already resolved above and either produces a read source or does not; either way one line is appended to the initialization log stating "attached" or "unavailable". **Producing none is a supported outcome, not a failure** — every memory, plan, and note read then resolves against the orphan branch for the rest of the session (until a re-attach). The attach's own eligibility rules are owned by spec 307.
   - **The attach must come after the migration**, and this ordering is load-bearing rather than incidental: the mirror's readiness probe tests a directory that folder initialization does not create, so on a fresh install an attach placed earlier would decline and the fast path would stay off for the whole session.

   All three run on the calling thread (a pool thread, not the interface thread — the step does filesystem and cross-process I/O). Failures anywhere in the step are caught and recorded in the initialization log without aborting initialization.
7. Auto-installs hooks if credentials are present and the service is not paused and hooks are not yet enabled (eliminates a separate manual "Enable" step). If auto-install runs, a second status refresh follows it to pick up the newly installed state. When credentials are present and the service is not paused but hooks are already enabled, an off-thread, version-gated integrations catch-up runs instead, so a surface upgrade refreshes the bundled integrations (agent-skill files included) without a manual re-enable; it reports an integration problem through a notification and a status refresh, and a failure is logged as non-fatal.
8. **Dispatches a fire-and-forget pending-push drain off the EDT** — retries any commits left in the pending-push queue by a push in a prior session (an offline push, or a push that raced ahead of summary generation). This is dispatched before the service is marked initialized (and before the git-change subscription and watchers below); it never blocks initialization, no-ops when nothing is pending, and is otherwise fully guarded (no Node, non-git dir, signed-out → silent no-op). Owned by spec 271; mirrors the VS Code extension's activation-time retry.
9. **Dispatches a fire-and-forget read-path warm-up off the EDT.** It performs the same three read operations that opening a memory tab performs — read the memory index, read the set of stored transcript identifiers, and read one memory body (the last only when the index has at least one entry). The point is that a memory tab open puts exactly those reads on the UI thread, and the first few reads after the read path comes up are an order of magnitude slower than warm ones. Failures are swallowed and logged as non-fatal; the only cost of a failure is that the first user action warms the path itself, which is the pre-existing behaviour.
10. **Requests a prewarm from the embedded-browser pool**, so the first memory tab does not pay the browser-construction cost the pool exists to hide. Also wrapped in a catch that logs a non-fatal warning; a failure costs exactly one thing — the first memory tab pays that construction itself. Owned by spec 302; this service only issues the request.
11. Subscribes to the IDE's git repository change events so working-tree changes fire a status refresh.
12. Starts the file watcher over the orphan-branch ref and the per-project Jolli state directory (covered by spec 125).
13. Writes the accumulated initialization log to a per-user diagnostics file for support purposes.

Steps 8–10 all run before the service is marked initialized, and none of them is waited on.

Initialization completes before returning, and the service is marked initialized regardless of whether the first status check succeeded.

### Re-attaching the memory-mirror read source

Because initialization is single-shot, the attach performed in step 6 would never re-run for the life of the project session. The service therefore exposes a re-attach hook that repeats just that resolution — repo identity, remote URL, configuration record, claiming root resolution, attach — and replaces whatever read source was in effect. Two callers exist: initialization's own step 6, and the settings surface's deferred background apply, immediately after that apply has re-run the migration (spec 135).

- It is what makes a Memory Bank path change or a storage-mode change take effect within the session. Without it, reads keep coming from the previously attached folder — the change appears to have applied but has not.
- It **no-ops** when neither a resolved repo root nor a project base path is available, and when no read path has been constructed yet (i.e. before initialization reached step 4).
- It performs filesystem **and** cross-process I/O, so it must not be called on the interface thread; both callers are off it.
- Any thrown failure is logged at warning and swallowed, and **the previous attachment is left in place** — a failed re-attach degrades to "still pointing at the old root", never to "no read source".
- Resolving to no read source is a normal outcome (the newly configured folder is unpopulated, or the mode no longer writes a mirror) and detaches the previous one; reads fall back to the orphan branch.

### After initialization returns

The startup activity then, in order and each inside a catch that logs and swallows: **starts the refresh-notification client**, and activates sync (spec 219).

Starting the refresh-notification client **spawns no process and starts no channel**. Its body only records that it was started; the call has no other observable effect. The refresh channel that actually reaches this service is owned by the long-lived bridge connection (spec 288) and comes up lazily on the **first** bridge call whose working directory matches an open project. See spec 289 for that channel and for the degenerate client registry this call belongs to.

That first matching bridge call now happens **during initialization itself**, not on the user's first action: the initial status refresh (step 5) and the read-path warm-up (step 9) are both bridge calls against this project's own working directory, so the long-lived connection and its server process come up while initialization is still running. A reader should not expect the connection to be idle until a panel or a command asks for something.

### Status refresh and `.git` removal detection

Every status refresh first re-checks whether `.git` still exists at the project base path. If it does not:
- `gitRemoved` flips to true.
- `lastError` records that the repository was removed.
- The cached status is cleared.
- All status listeners fire so panels can reload.

If `.git` is present, the status refresh asks the summary reader for a fresh status and updates the cached snapshot. That status is **not computed in the IDE process**: the reader issues a `status` bridge call against the current worktree and overlays two locally-known fields (whether a Node runtime is available, and whether integrations are active) onto the returned snapshot. The hook installer it is still handed is ignored. If the underlying call throws, the service re-checks for `.git` removal once more (the exception may itself indicate removal); on a true I/O failure with `.git` still present, the error is recorded in `lastError` and the cached status is left unchanged from the previous successful read.

After every refresh — success or failure — all status listeners are notified.

### Status-listener API

Panels register a no-argument callback through `addStatusListener`. Callbacks are stored in a thread-safe list that survives across refreshes. When a panel registers and the service has already populated its cached status, the new listener fires once immediately so a late-attaching panel observes the current state without waiting for the next refresh. Removing a listener detaches it idempotently. Listeners are not given the new status as an argument; they read it back from the service when they fire.

### Mid-session `.git` removal

When a status refresh detects that `.git` has disappeared:
- `gitRemoved` becomes true and stays true.
- The next listener fanout includes the tool window factory's listener, which switches the side panel to a "no Git" placeholder while leaving panel subscriptions alive so the same panel instances can resume when the repository returns.
- Subsequent panel-driven actions (install, refresh) short-circuit because the cached status is null and the installer/reader collaborators report failure.

### `.git` restoration

The user can run `git init` (or otherwise re-create `.git`) and call the explicit reset hook on the service. Reset clears `gitRemoved` and `isInitialized` so the next caller of `initialize()` runs the full sequence again, rebuilding the bridge collaborators, recomputing the resolved root (which may differ if the user re-initialized in a different layout), and re-subscribing to repository change events.

### Disposal

When the project closes, the service stops the orphan-ref debounce timer and clears the listener list. There is no watcher thread to interrupt and no watcher handle to close: the file-change subscription unhooks through the service's own disposable (spec 125). The service does not uninstall hooks on disposal — installation persists on disk and survives across IDE sessions.

## State Transitions

The service moves through three observable states for the duration of a project session.

- **Uninitialized** — service exists but `initialize()` has not run yet (rare; only a window between service construction and the startup activity invoking `initialize`). Reads return null/empty; listeners do not fire.
- **Initialized, git present** — `isInitialized` is true and `gitRemoved` is false. Status refreshes succeed or fail without changing state.
- **Initialized, git removed** — `gitRemoved` is true. Refreshes return null and listeners continue to fire (so panels can render their no-git fallback). Calling reset transitions back to uninitialized; the next `initialize()` call re-enters initialized-git-present.

## Notable Behavior

- A panel that subscribes after the cached status is populated receives an immediate first callback; this is how the tool window's many panels avoid a startup race where some never see the initial status.
- `gitRemoved` is sticky within a session; it is only cleared by the explicit reset hook, not by a later refresh discovering that `.git` returned. The expected flow is for the user (or the tool window factory observing the flag) to invoke reset before re-initialization.
- The startup notification on a non-git project is informational only; it does not create the service, so opening a project without a repository is free of background watchers and timers until the user opts in.
- The full initialization log is persisted to a per-user diagnostics file on every initialization, regardless of success, so support can reproduce the path-resolution decisions the service made.
- Auto-hook-install at initialization is gated on three conditions all being true: at least one credential (direct API key, environment-variable key, or Jolli API key) is present, the service config is not paused, and the status check found hooks not yet enabled. The auto-install does not run when any condition is false, so a deliberate pause or a clean state is respected.
- **Initialization writes no agent-skill files at all.** They are owned entirely by the bundled command-line surface: written by its full enable on first install (which the auto-install step invokes) and refreshed by its version-gated integrations catch-up. No writer for them remains on this surface. (Corrected: initialization used to update a bundled agent-skill file under the resolved root when a newer version was available; that step and its writer are gone.)
- **A status refresh now costs a round-trip, not a local computation.** Status is produced by the command-line surface and read back over the bridge, so every refresh is either one round-trip on the long-lived connection (spec 288) or one cold process start when that connection is unavailable. Because refreshes are driven by two independent debounced watchers (specs 125 and 289) plus the IDE's own repository-change events, an ordinary commit can cost several such round-trips.
- **Starting the refresh-notification client is a no-op at present.** The startup activity's call to it flips a flag and nothing more. The channel arrives with the first bridge call (specs 288, 289) — which initialization itself makes, twice (the initial status refresh and the read-path warm-up), so by the time initialization returns the connection is up. What is *not* true is that starting the client is what brought it up.
- **Two fire-and-forget warm-ups sit at the end of initialization, and both degrade to nothing.** The read-path warm-up and the browser-pool prewarm are dispatched, not awaited, and each swallows its own failure. The only consequence of either failing is that the first user action pays the cost it was meant to hide — exactly the behaviour that existed before they were added. Neither can fail initialization.
- **The read-path warm-up is a real round-trip, not a local cache touch.** It performs the same three reads a memory tab open performs, which is why it also has the side effect of bringing the long-lived bridge connection and its server process up during initialization.
- **Auto-migration during initialization is a subprocess, not an in-process engine.** It shells out to the command-line surface's one-shot migration command and blocks the initialization thread until it exits or its timeout expires. (Corrected: this spec previously described an in-process migration engine; that engine no longer exists on this surface.)
- **A declined memory-mirror attach is a supported state, and the only record of it is one line in the initialization log.** Nothing surfaces it to the user, and no status field reports it — a session reading everything from the orphan branch looks identical to one served from the mirror except that reads are slower (spec 307).
- **The memory-mirror attach is the only part of initialization whose position in the sequence is dictated by another component's readiness rule.** It has to follow the migration because the mirror's readiness probe tests a directory the folder initialization does not create.
- **The single-memory cache is consulted ahead of the read path, so it can outlive the read path's own freshness checks.** Between two wholesale invalidations, a cached memory is returned without touching the mirror, the orphan branch, or the mirror's per-read out-of-sync probe — which means a mirror that goes out of sync mid-session can keep being served from cache until the next invalidation (spec 307). Invalidation is total by design: call sites that change a memory frequently cannot name the affected identifiers, and a targeted removal would strand the sibling entry stored under a resolved alias identifier.
- **A settings save is the only in-session trigger that re-points the read source.** A storage-mode flip or folder change made from the command line or another editor is not observed by this service until the next initialization (spec 307).
- **The resolved root is the current worktree, not the main one, and the field name says otherwise.** (Corrected: this spec previously described `mainRepoRoot` as the main worktree root, with a worktree's project base "replaced" by its parent's. The git wrapper's resolution helper was reduced to returning the project directory unchanged, precisely because the per-project Jolli state directory is per-worktree — the old walk-up made a secondary worktree's sessions, plans and notes invisible in the CONTEXT and WORKING MEMORY surfaces. The field name survives as a legacy misnomer; see spec 126.)
- Disposing the service does not clear the cached status; readers who hold a stale reference after disposal still see the last-known status, but no new refreshes will occur.
- The panel registry is set externally by the tool window factory after panels are constructed; the service does not depend on the registry being populated for its own behavior, only contextual actions do.

## Shared Behavior

- The fire-and-forget pending-push drain dispatched during initialization (step 8) is owned by **IntelliJ Pre-Push Sync Catch-Up** (271); this service only dispatches it off the EDT and never waits on it.
- The prewarm requested during initialization (step 10) is owned by the **IntelliJ Embedded-Browser Pool** (302), which decides what a prewarm actually builds, how many instances it keeps, and what a failure costs; this service only issues the request and swallows its failure.
- The three read operations the warm-up performs (step 9) belong to the memory-read path shared with the memory tab; this service only calls them once, early, for their cache-warming side effect.
- The read source attached in step 6 and re-pointed by the re-attach hook is owned by **IntelliJ Direct Memory-Mirror Read Path** (307), which defines its four read shapes, its eligibility preconditions, its per-read degradation probe, and the cross-language lockstep obligation it creates. This service owns only when the attach happens, that a declined attach is survivable, and the cache in front of it.
- The one-shot migration command invoked during step 6 is owned by the command-line surface's migration spec (293); this service only launches it and records its reported outcome.
- The settings save that triggers the re-attach is owned by **IntelliJ Settings Surface** (135); this service owns the hook it calls.
- Worktree resolution is handled by the git wrapper and the hook installer (covered by their own specs); this service only stores the resolved root for downstream readers. Because that resolution is now the identity function (spec 126), everything downstream of `mainRepoRoot` — the hook installer's root argument, the backfill working directory, the bridge working directory used by the Memory Bank folder resolution and the push-control and local-agent-tool lookups — is scoped to the worktree the project is opened on.
- The file watcher over the orphan-branch ref and the per-project Jolli state directory, and its debounced refresh, are described in spec 125; this service owns the watcher's lifecycle (start during `initialize`, stop the debounce timer during `dispose`) but not its mechanism.
- The second, command-line-side path into the same status refresh — refresh notifications pushed over the bridge and debounced again on the client — is owned by spec 289; the connection that carries them is spec 288.
- Hook installation and uninstallation are delegated to the command-line surface (spec 128); the status snapshot's shape is the command-line surface's, read back over the bridge and overlaid with two local fields by the summary reader.
- The startup notification group integration is generic platform-notification machinery and is not specific to Jolli Memory's domain logic.
