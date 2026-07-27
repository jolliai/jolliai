# IntelliJ Orphan-Branch Ref Monitoring

## Topic Statement

The IntelliJ project service watches four specific files — the orphan branch's loose ref, the queue worker's two lock files, and the plan registry — for external changes, using the IDE platform's own virtual-file-system change bus rather than an operating-system watcher API, and debounces rapid event bursts before instructing UI panels to reload.

## Scope

- Registering two directories as non-recursive watch roots with the IDE platform's virtual file system: the parent directory of the orphan branch's loose ref file (under the main repo root's git directory) and the main repo root's per-project Jolli state directory.
- Seeding the platform's virtual file system with each root before registering it, so events for paths the platform has never visited are still delivered.
- Filtering every delivered change event by **exact canonical full-path equality** against four target files, and the path canonicalisation (including symlink resolution) required for that comparison to succeed.
- Debouncing the noisy event stream produced when the queue worker writes a chain of git objects (blob, tree, commit, ref update) in quick succession.
- Triggering a status refresh on the project service when a relevant event is observed.
- Worktree-aware path resolution: both roots are resolved under the main repo root, not the worktree's own git pointer.
- Lifecycle: start during service initialization, tear down with the service.

Out of scope: the packed-refs file (only the loose ref form is observed, since the queue worker writes loose refs); UI rendering of the refreshed memory list; the queue worker itself; the command-line surface's *own* watchers, which push refresh notifications over the bridge and are owned by spec 289.

## Data Contracts

The watcher exposes no data shape of its own; its only output is a side effect on the project service: the cached status and the orphan-branch summary index are reloaded, and subscribed panels are notified.

### Watch roots (two)

| Root | Location | Registered recursively? |
| --- | --- | --- |
| Orphan ref parent | The main repo root's git directory, under `refs/heads/` along the orphan branch's path | No |
| Jolli state directory | `<main-repo-root>/.jolli/jollimemory` | No |

The user-global agent plans directory is **no longer watched**. Nothing outside the repository is observed.

### Target files (four, matched by exact path)

Change events are not scoped per root or per event kind. The platform delivers every virtual-file-system change in a batch, and the listener keeps only events whose full path exactly equals one of:

- the orphan ref's leaf file under the orphan ref parent (the final segment of the hierarchical orphan branch name);
- `worker.lock` in the Jolli state directory — the queue worker's liveness lock, whose observation is also what keeps the service's cached "worker busy" state fresh for action-enablement checks that must not touch disk;
- `lock` in the Jolli state directory — the queue drain's exclusion lock;
- `plans.json` in the Jolli state directory — the plan registry.

There are no per-directory event-kind registrations (create / modify / delete), no filename-suffix matching, and no `.md` extension rule. Any event kind on a matching path counts as relevant; every event on any other path is ignored.

### Path canonicalisation

Each of the four target paths is canonicalised once at startup — resolving symbolic links along the whole path and normalising backslashes to forward slashes — so it matches the form the platform reports in its events. Without symlink resolution, a platform whose temporary or system directories are symlinked (a `/var` → `/private/var` link, for example) would report a path that never string-equals the naively joined one, and no event would ever match.

## Behavior

### Watcher startup

During service initialization, after the bridge collaborators are built, watcher startup runs against the resolved main repo root. For each of the two roots it resolves the directory, asks the platform's local file system to refresh-and-find that path (seeding the virtual file system so subsequent events for it are delivered), and registers the root as a non-recursive watch root. It then subscribes to the platform's bulk file-change bus with a listener that runs after each change batch.

A root that does not exist at startup is skipped, and **is not retried later** — the watcher performs no rescan, so a directory created after startup is never observed for the remainder of the session.

There is no watcher thread. The platform owns event delivery; the subscription is tied to the service's disposable, so the platform tears it down when the service is disposed. If the whole startup call throws, the failure is logged and no watching occurs for the rest of the session — the service then relies solely on the IDE's own repository-change events (which fire on working-tree changes but never on orphan-branch ref updates) and on refresh notifications pushed from the command-line side (spec 289). There is no periodic-poll fallback timer.

### Event filtering

On each delivered change batch, the listener walks the batch's events and compares each event's reported path against the four canonicalised targets. It returns on the **first** matching path in the batch — the remaining events in that batch are not examined, because one match is all that is needed to schedule a refresh. There is no watch-key reset step and no per-root disambiguation, since matching is on the full path.

### Debounced refresh

Refresh scheduling uses a 500-millisecond, non-repeating timer. Each new relevant event stops the prior timer (if running) and starts a fresh one. The scheduling call early-returns when the service is already disposed. When the timer elapses it submits a status refresh to the project service on a background pool and completes. Because the queue worker performs its writes in a tight sequence, the burst of platform events collapses into a single refresh.

### Notification path

When the timer's task runs, it calls the project service's status refresh on a pooled background thread. That refresh recomputes the cached status and then fans out to all registered panel listeners (spec 124). Memory and commit panels reload their displayed entries.

### Worktree-aware path resolution

Both roots are resolved against the main repo root, not the worktree directory. The orphan branch ref lives in the main repo's git directory, and the queue locks and plan registry live in the main repo's Jolli state directory; a worktree shares all of them with its parent. The service has already resolved the main worktree root before starting the watcher and passes that resolved value in.

### Shutdown

On service disposal the debounce timer is stopped, cancelling any pending refresh that has not yet fired. There is no watcher handle to close and no thread to interrupt: the change-bus subscription unhooks itself through the service's disposable.

## State Transitions

The watcher has three operational states within a project session:

- **Active** — both roots registered, the change-bus subscription live, debounce timer idle.
- **Partially active** — the subscription is live but one of the two roots did not exist at startup; that root will not become observed if it is created later (no rescan).
- **Inactive** — the whole watcher-startup call threw and was logged; no events are observed for the rest of the session.

There is no transition back from inactive to active without a service restart.

## Notable Behavior

- **This watcher now runs *in addition to* the command-line surface's own watchers.** The long-lived bridge server watches the queue directory and the orphan ref directory itself and pushes `refresh` notifications to the plugin, which debounces them a second time before calling the same status refresh (spec 289). The two paths are independent and unsynchronised, and each has its own debounce window. **A single queue-worker run can therefore drive two status refreshes** — one from this watcher's 500-millisecond timer and one from the notification path's own — with no coalescing between them.
- **The migration away from an operating-system watcher was made because that mechanism was unreliable, not merely to prefer a platform API.** The previous implementation silently degraded to ~10-second polling on one platform and regularly missed git's atomic-rename events entirely, so an orphan-ref update could go unobserved until some unrelated change forced a refresh.
- **Matching is by exact full path, so a target file is observed wherever its directory is registered — and nothing else is.** A sibling file in either watched directory (a queue entry, a progress stream, a cursor file) produces no refresh at all, even though it lives inside a registered root.
- **Symlink resolution is load-bearing, not cosmetic.** Comparing an unresolved path against the platform's reported path silently matches nothing, which presents as a watcher that arms cleanly and then never fires.
- Only loose-form orphan refs are observed. If the user packs refs, subsequent updates to the loose ref still occur on the next worker write, so observation recovers automatically.
- **Skipping a missing root is permanent for the session.** The very first time hooks are installed and the worker runs, the orphan ref directory may not have existed at startup, so this watcher misses the initial creation; the IDE's own repository-change event on the underlying commit, and the command-line side's notification channel, still force a refresh that picks up the new index.
- Events are delivered off the IDE's UI thread; the refresh is dispatched onto a background pool, and panels marshal their UI updates back onto the UI thread when their listener callback fires.
- There is no fallback poll timer that re-reads the ref hash on a fixed interval; invalidation relies on this watcher, the IDE's own repository-change events, or the command-line side's notifications.

## Shared Behavior

- The notification of panels uses the project-service status-listener bus described in spec 124; the watcher maintains no subscriber list of its own.
- The resolved main worktree root is computed by the git wrapper (spec 126) and consumed here.
- Reading the actual orphan-branch contents after a refresh goes through the summary store / summary reader (separate specs), not through this watcher.
- **IDE-Bridge Refresh Notification Channel (289)** owns the second, command-line-side path into the same status refresh — including its watch targets, its own debounce, and the client-side debounce that follows it. That spec and this one describe two independent mechanisms with the same effect.
