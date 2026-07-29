# IntelliJ Project Service Lifecycle

## Topic Statement

A per-project service initializes the Jolli Memory bridge on project open, listens for the `.git` entry being removed or restored mid-session, and notifies UI panels of installation-state changes through a single subscription bus.

## Scope

- Service creation on project open and disposal on project close.
- One-time initialization that resolves the main worktree root, builds the lazy git, hook installer, and summary reader collaborators, and computes the first installation status.
- Suggesting `git init` via a one-time platform notification when the project has no `.git` entry on open.
- The status-listener API used by all panels in the side tool window.
- Detecting that `.git` has been removed (or has reappeared) since initialization, and signalling panels to switch their UI accordingly.
- Resetting the initialization flag so a re-opened repository can re-run initialization without restarting the IDE.
- The two fire-and-forget warm-ups dispatched near the end of initialization (a read-path warm-up and a browser-pool prewarm), and what a failure of either costs.

Out of scope: hook installation itself, summary reading, ref watching (covered by spec 125), the pending-push drain's own mechanics (covered by spec 271; this service only dispatches it), the embedded-browser pool's own capacity/eviction/disposal rules (covered by spec 302; this service only asks it to prewarm), and any individual panel's UI.

## Data Contracts

The service exposes the following observable state to panels.

- `isInitialized` (boolean) — true once the first initialization has completed for the current project session.
- `gitRemoved` (boolean) — flips to true the first time a status check sees that `.git` no longer exists at the project base path; never flips back to false except via the explicit reset hook.
- `mainRepoRoot` (string or null) — the resolved repository root, accounting for worktrees (a worktree's project base is replaced with the main worktree root).
- `lastError` (string or null) — human-readable description of the most recent failure during a status check or installer call, or null when the last operation succeeded.
- A cached `StatusInfo` snapshot returned by the installation status check, accessible to panels without re-reading from disk.
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
3. Builds the git wrapper for the project directory and asks it to resolve the main worktree root, falling back to the project base path when the project is not in a worktree.
4. Constructs the hook installer (with both the project directory and the resolved main repo root) and the summary reader. The summary reader is constructed against the **current worktree root** (the project base path), not the resolved main repo root, because the status it now delegates to the command-line surface treats its working directory as the checkout being reported on — a worktree must report its own hook and data state, not its parent's.
5. Performs the first status refresh, populating the cached status snapshot or recording the failure.
6. Updates the bundled Claude Code skill file under the resolved root if a newer version is available, ignoring failures.
7. Initializes the Memory Bank folder with the repo's identity (repo name and remote URL), then auto-migrates: if the orphan branch has data and migration has not been completed, runs the migration engine synchronously. Both the folder initialization and the migration run on the calling thread; failures are caught and recorded in the initialization log without aborting initialization.
8. Auto-installs hooks if credentials are present and the service is not paused and hooks are not yet enabled (eliminates a separate manual "Enable" step). If auto-install runs, a second status refresh follows it to pick up the newly installed state.
9. **Dispatches a fire-and-forget pending-push drain off the EDT** — retries any commits left in the pending-push queue by a push in a prior session (an offline push, or a push that raced ahead of summary generation). This is dispatched before the service is marked initialized (and before the git-change subscription and watchers below); it never blocks initialization, no-ops when nothing is pending, and is otherwise fully guarded (no Node, non-git dir, signed-out → silent no-op). Owned by spec 271; mirrors the VS Code extension's activation-time retry.
10. **Dispatches a fire-and-forget read-path warm-up off the EDT.** It performs the same three read operations that opening a memory tab performs — read the memory index, read the set of stored transcript identifiers, and read one memory body (the last only when the index has at least one entry). The point is that a memory tab open puts exactly those reads on the UI thread, and the first few reads after the read path comes up are an order of magnitude slower than warm ones. Failures are swallowed and logged as non-fatal; the only cost of a failure is that the first user action warms the path itself, which is the pre-existing behaviour.
11. **Requests a prewarm from the embedded-browser pool**, so the first memory tab does not pay the browser-construction cost the pool exists to hide. Also wrapped in a catch that logs a non-fatal warning; a failure costs exactly one thing — the first memory tab pays that construction itself. Owned by spec 302; this service only issues the request.
12. Subscribes to the IDE's git repository change events so working-tree changes fire a status refresh.
13. Starts the file watcher over the orphan-branch ref and the per-project Jolli state directory (covered by spec 125).
14. Writes the accumulated initialization log to a per-user diagnostics file for support purposes.

Steps 9–11 all run before the service is marked initialized, and none of them is waited on.

Initialization completes before returning, and the service is marked initialized regardless of whether the first status check succeeded.

### After initialization returns

The startup activity then, in order and each inside a catch that logs and swallows: **starts the refresh-notification client**, and activates sync (spec 219).

Starting the refresh-notification client **spawns no process and starts no channel**. Its body only records that it was started; the call has no other observable effect. The refresh channel that actually reaches this service is owned by the long-lived bridge connection (spec 288) and comes up lazily on the **first** bridge call whose working directory matches an open project. See spec 289 for that channel and for the degenerate client registry this call belongs to.

That first matching bridge call now happens **during initialization itself**, not on the user's first action: the initial status refresh (step 5) and the read-path warm-up (step 10) are both bridge calls against this project's own working directory, so the long-lived connection and its server process come up while initialization is still running. A reader should not expect the connection to be idle until a panel or a command asks for something.

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
- **A status refresh now costs a round-trip, not a local computation.** Status is produced by the command-line surface and read back over the bridge, so every refresh is either one round-trip on the long-lived connection (spec 288) or one cold process start when that connection is unavailable. Because refreshes are driven by two independent debounced watchers (specs 125 and 289) plus the IDE's own repository-change events, an ordinary commit can cost several such round-trips.
- **Starting the refresh-notification client is a no-op at present.** The startup activity's call to it flips a flag and nothing more. The channel arrives with the first bridge call (specs 288, 289) — which initialization itself makes, twice (the initial status refresh and the read-path warm-up), so by the time initialization returns the connection is up. What is *not* true is that starting the client is what brought it up.
- **Two fire-and-forget warm-ups sit at the end of initialization, and both degrade to nothing.** The read-path warm-up and the browser-pool prewarm are dispatched, not awaited, and each swallows its own failure. The only consequence of either failing is that the first user action pays the cost it was meant to hide — exactly the behaviour that existed before they were added. Neither can fail initialization.
- **The read-path warm-up is a real round-trip, not a local cache touch.** It performs the same three reads a memory tab open performs, which is why it also has the side effect of bringing the long-lived bridge connection and its server process up during initialization.
- Disposing the service does not clear the cached status; readers who hold a stale reference after disposal still see the last-known status, but no new refreshes will occur.
- The panel registry is set externally by the tool window factory after panels are constructed; the service does not depend on the registry being populated for its own behavior, only contextual actions do.

## Shared Behavior

- The fire-and-forget pending-push drain dispatched during initialization (step 9) is owned by **IntelliJ Pre-Push Sync Catch-Up** (271); this service only dispatches it off the EDT and never waits on it.
- The prewarm requested during initialization (step 11) is owned by the **IntelliJ Embedded-Browser Pool** (302), which decides what a prewarm actually builds, how many instances it keeps, and what a failure costs; this service only issues the request and swallows its failure.
- The three read operations the warm-up performs (step 10) belong to the memory-read path shared with the memory tab; this service only calls them once, early, for their cache-warming side effect.
- Worktree resolution is handled by the git wrapper and the hook installer (covered by their own specs); this service only stores the resolved root for downstream readers.
- The file watcher over the orphan-branch ref and the per-project Jolli state directory, and its debounced refresh, are described in spec 125; this service owns the watcher's lifecycle (start during `initialize`, stop the debounce timer during `dispose`) but not its mechanism.
- The second, command-line-side path into the same status refresh — refresh notifications pushed over the bridge and debounced again on the client — is owned by spec 289; the connection that carries them is spec 288.
- Hook installation and uninstallation are delegated to the command-line surface (spec 128); the status snapshot's shape is the command-line surface's, read back over the bridge and overlaid with two local fields by the summary reader.
- The startup notification group integration is generic platform-notification machinery and is not specific to Jolli Memory's domain logic.
