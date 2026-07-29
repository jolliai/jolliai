# VS Code Extension Activation Lifecycle

## Topic Statement

A fixed-order activation sequence that the IDE runs the first time a workspace meets one of the activation triggers, branching into a degraded mode when the workspace is not a git repository and otherwise wiring the full set of stores, sidebar tabs, watchers, commands, and context keys before returning control to the IDE.

## Scope

**In scope:**
- The activation triggers that cause the extension to load.
- The three top-level activation branches: no workspace open, workspace is not a git repository, workspace is a git repository.
- The exact ordering of subsystem initialization in the full branch (write-gate seed, logger, repository bridge, auth, plan and note read-only document providers, exclude filter, status bar, stores, tree-data providers, sidebar webview registration, command registrations, file-system watchers, URI handler, initial data load, hook-path freshness check).
- The context keys the activation sets and the values they take across the branches.
- The cleanup contract on deactivation.

**Out of scope:**
- The internal logic of any individual subsystem (each store, each command, each watcher, each migration is owned by its own topic).
- The sidebar webview's message protocol — covered separately.
- The auth flow (browser handshake, token storage).
- The KB-folder migration and orphan-branch migration sequences themselves; this topic only describes when activation kicks them off.

## Data Contracts

### Activation triggers

The extension activates the first time **any** of the following holds for the IDE window:

| Trigger                              | Meaning                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Workspace contains a git directory   | Standard project open.                                                                                     |
| The IDE dispatches a registered URI  | The browser-based sign-in callback has been invoked while the IDE is already running.                      |
| The user reveals the sidebar view    | A user explicitly opens the Jolli activity-bar icon in a workspace where the git trigger has not yet fired. |

Activation is one-shot per IDE window: subsequent triggers do not re-run the sequence.

### Three activation branches

| Workspace state                           | Branch        | Outcome                                                                                                                                    |
| ----------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| No folder open                            | No-workspace  | Every command registered as a no-op that shows an "Open a folder to use Jolli Memory" notification; sidebar registers in degraded mode with reason `no-workspace`. |
| Folder open but no git repository present | No-git        | Every command registered as a no-op that warns "not a git repository" and offers to initialize git; an extra `jollimemory.initGit` command is registered for the sidebar's CTA button; sidebar registers in degraded mode with reason `no-git`. |
| Folder open and git repository present    | Full          | The full sequence below runs.                                                                                                              |

In both degraded branches the activation function returns immediately after registering the placeholder commands and the degraded sidebar — none of the stores, watchers, or real data subscriptions are created.

### Sidebar registration in degraded mode

The degraded sidebar is registered with no data providers attached and an initial state that has `enabled: false`, `authenticated: false`, `activeTab: status`, an empty branch name, and the appropriate `degradedReason`. The webview renders a reason-specific call-to-action banner instead of the standard tab content. This is what prevents the IDE's generic "no view registered" placeholder from showing in either degraded case.

### Context keys

Three context keys are set by activation and re-evaluated as state changes:

| Key                                  | Set by                                                                                            | Drives                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `jollimemory.signedIn`               | Owned by the auth surface; set on activation from saved config and refreshed on sign-in/sign-out. | The Sign In vs Sign Out icon swap on the Status tab toolbar and any `when` clauses gated on auth state. |
| `jollimemory.enabled`                | Set optimistically to `true` immediately after sidebar registration, then corrected by the first status refresh and re-asserted after every enable/disable. | The conditional Enable vs Disable command icon and the welcome content that hides when JolliMemory is enabled. |
| `jollimemory.memories.hasFilter`     | Set by the Memories store change subscription whenever `hasFilter` changes.                        | The Clear-filter affordance and the visibility of the "Load More" row.                         |

(Other context keys exist for empty-state and merged/single-commit modes — they are documented under the Commits and Memories topics that own them.)

## Behavior

### Full branch — fixed initialization order

When the workspace is a git repository, activation runs these steps in this order. Any reorder breaks an invariant noted alongside the step.

0. **Seed the in-process write gate.** A *synchronous* read of the repository's durable manual-disable opt-out seeds the session's in-memory write gate. The read is synchronous because activation cannot be made to await anything this early; it is deliberately the read-only variant, which never migrates and never persists (spec 145). Its position **before** the logger step is load-bearing: a repository the user has turned off must produce no on-disk log artifact at all, including from the very first activation log line. Reordering this after the logger step would leave that line — and everything else in the session — writing to disk in an opted-out repository.
1. **Logger.** A workspace-rooted log channel is initialized so every subsequent step can log under a stable category. (All later steps assume the logger is live.)
2. **Repository bridge.** A single per-workspace bridge object is constructed. It owns the repository path, the LLM client, the storage backend, and is the sole route from the host to git, the orphan summary branch, the local KB folder, and the hook installer.
3. **Auth service.** Constructed early so any later step (URI handler, sign-in/sign-out commands, status refresh) has an auth instance ready.
4. **Plan and note read-only document providers.** Two virtual document content providers are registered — one per scheme — so the read-only previews launched from the Plans/Notes rows can resolve content from the orphan branch on demand. Registering them before any plan/note row can be clicked guarantees the click never races a missing scheme handler.
5. **Helper services.** The exclude-pattern filter manager and the status-bar manager are constructed and added to the disposable subscription list.
6. **Stores.** The five host-side state controllers are constructed in this order: status, memories, plans, files, commits. Each one is added to the disposable subscription list immediately upon construction so a partial failure later still triggers their dispose paths.
7. **Tree-data providers.** Five tree-data providers are constructed as thin subscribers over the stores. They register no tree views directly — the sidebar webview reads them via their snapshot/event API. A file-decoration provider for the per-commit file scheme is registered alongside.
8. **Sidebar webview.** The sidebar webview provider is constructed with a dependency bag that wires every tree provider's serialize and change event, the KB-folders service, the per-tab data callbacks, the branch-watcher emitter, the file/commit checkbox callbacks, and the lazy-load trigger for the Memories tab. The provider is then registered with the IDE under the sidebar view id.
9. **Initial branch read and status-store subscription.** A single asynchronous probe reads the current branch name (which fires the branch-change emitter when it resolves). The host subscribes to the status store's change event; the subscription mirrors the store's `enabled` and `configured` derived booleans into local state and posts the corresponding `enabled:changed` and `configured:changed` messages to the sidebar webview only on actual change. The previous fire-and-forget standalone status probe is replaced by this subscription path. A deferred `initial-state-readiness` barrier is created at this step; it resolves when the parallel-refresh step (15) completes, and the sidebar webview's `init` handler awaits it before posting `init` so the loading placeholder is visible until real state is available.
10. **Optimistic `enabled` context key.** Immediately set to `true` so the disabled-state welcome placeholder does not flash while the real status query is in flight. Corrected after the first status refresh.
11. **KB initialization (fire-and-forget async).** Runs three legacy migrations in sequence (orphan-branch v1→v3, flat-index v1→v3, expired v1 cleanup) and then the KB-folder auto-migration. Each migration toggles a "migrating" flag on the affected stores so all panels render a placeholder during the run. Failures are logged but do not abort activation. **When KB initialization settles (success or failure), a fire-and-forget push-pending compensation retry is kicked off** — now that storage is initialized, it retries any commits left in the per-project push-pending queue from a previous session. It is fully guarded: never throws, and no-ops when nothing is pending or the user isn't signed in. Cross-reference: spec 270 (push-pending compensation retry).

    Two properties of this step were added with the zero-write contract:

    - **The whole body is skipped when the write gate from step 0 is set.** Every step inside it writes — the legacy migrations, the schema migration, the folder identity claim, the full copy, and the visible-layer reconciliation — so a disabled repository runs none of them. The enable command re-runs the same function later to catch up. Cross-reference: `specs/304-manually-disabled-zero-write-contract.md`.
    - **Every invocation is serialized through a single chain**, not just this one. The step's own internals perform *unlocked* read-modify-write against the folder manifest, the migration progress document, and the projected index, so two concurrent runs would race those three documents. This was previously unreachable because activation was the only caller; the enable path's catch-up run (and a double-clicked enable) makes it reachable, hence the chain. Errors are isolated per run so one failed run does not wedge the chain for later callers.

    The step's completion barrier — the deferred promise that unblocks the first sync round — **still resolves** on the skipped path, and still resolves on the error path. A disabled startup therefore does not leave sync waiting forever; it leaves sync unblocked against a repository that was never initialized. (That is precisely why the sync orchestrator additionally takes a per-round barrier; see spec 174.)
12. **Watcher subscriptions.** In order: sessions-file watcher, external-markdown-note save subscription, HEAD watcher (for branch switches; uses git's resolved path so it works in worktrees), orphan-summary-ref watcher (which gates Memories refresh on the lazy-load flag), worker-lock watcher (which sets a `workerBusy` context key and falls back to a manual refresh on lock release). Watchers are subscribed in this order because each one's callback assumes the stores from step 6 already exist.
13. **Command registrations.** Every command listed in the manifest is registered with its real handler. The full set covers refresh, enable/disable, AI commit, squash, push, file/commit selection toggles, plan and note add/edit/remove/preview, memory search/clear/load-more/view/copy-recall, summary panel openers, settings, and sign-in/sign-out.
14. **URI handler.** A single IDE-level URI handler is registered. It dispatches by `uri.path`:
    - The auth-callback path (an exact-string match) routes through the auth service to consume an authorization code and update the `signedIn` context key on success. On success it also refreshes status/settings, restarts the auto-sync polling loop (idempotent reconcile) if auto-sync was already enabled from a prior session, and then kicks off a **fire-and-forget push-pending compensation retry** so that commits queued into the push-pending queue while the user was signed out are drained now that a credential is present. Cross-reference: spec 270 (push-pending compensation retry).
    - A summary-deep-link route of the form `/summary/<40-char-hex>` (regex match — abbreviations are deliberately rejected at this layer) looks up the summary by the full identifier and opens the summary webview panel for it. The full-identifier requirement avoids the abbreviated-identifier resolution path's tree-hash-fallback branch silently picking the wrong commit when two commits share a tree. On a regex match where the lookup returns no summary, an information notification is shown naming the short prefix of the requested identifier.
    - Any other path is logged at info level and ignored — no user notification.
    The IDE's URI registration scopes dispatch to this extension's authority, so the handler does not re-validate scheme or authority. The auth-callback comparison is exact-equality and runs first; the summary regex runs second; unknown paths reach the final ignored-log line.

  *Notable:* the `/summary/<hash>` route exists in code with no active emitter today — earlier design considered surfacing such links inside the chat webview but the chat webview filters non-http(s) link clicks. The route is preserved for future use without downstream impact.
15. **Initial data load.** A bootstrap routine first loads the exclude filter (so the very first file list is already filtered), then runs the four panel refreshes in parallel, then updates the status bar and the `enabled` context key.
16. **Hook-path staleness check.** A final asynchronous step asks the bridge whether the installed hook scripts still point at this exact extension version's bundle. On mismatch, an outdated-version warning is shown; if the project is enabled but the current worktree's hooks are missing, hooks are silently re-installed and all panels refresh again.

    **When the write gate from step 0 is set, the staleness call is not made at all.** Instead a "no mismatch" answer is synthesized in its place, so the entire downstream chain of this step still runs — status refresh, status-bar repaint, and the two conditional re-install branches below — but it runs against hooks nothing has touched. The reason the call is skipped rather than merely ignored is that the staleness check re-installs hooks whenever the recorded bundle path is stale, which is true after *every* extension upgrade; invoking it in a disabled repository would both write to disk and silently override the user's opt-out. (The staleness operation independently refuses on its own durable read; the call-site skip is what keeps a disabled session from paying its reads and log lines at all. See spec 145.)

    Within the same staleness async, **auto-enable** runs before the hook-version-mismatch handling. Preconditions: the status snapshot reports the project as not currently enabled, AND the repository-wide durable opt-out reads as unset. When both hold, the activation calls the bridge-level enable (the same path the explicit Enable command uses); on success, the status is refreshed, the status bar repaints, local "currently enabled" state is updated, and the sidebar is notified. Failures are logged at warning level and swallowed — no toast or banner. Sign-in state is *not* a precondition; an unconfigured user gets git hooks installed silently in the background while the onboarding panel still shows in the sidebar. Cross-reference: spec 144 (auto-enable on activation), spec 145 (manual-disable durable flag).

    Note the two opt-out reads in this step are of different kinds and both are load-bearing: the staleness skip consults the session's in-memory gate (synchronous, available immediately), while auto-enable and the new-worktree repair share a single asynchronous read of the durable field on disk.

### Degraded branches — fixed sequence

For both degraded branches the activation function only does:

1. Initialize a workspace-relative-or-fallback logger sufficient to log the degraded reason.
2. Register every manifest command as a no-op that shows the reason-specific notification.
3. Register the sidebar provider in degraded mode with the appropriate `degradedReason`.
4. Return.

No bridge, no stores, no watchers, no migrations, no hook-path check.

### Deactivation

The IDE calls deactivate when the window unloads. Cleanup is intentionally minimal: log a single deactivation message, dispose the log channel, and return. Every other resource — stores, watchers, sidebar subscription, file-decoration provider, URI handler, document-content providers, status bar — was added to the disposable subscription list during activation, and the IDE disposes those automatically on window unload. There is no manual teardown loop in deactivate.

## State Transitions

Activation is a one-shot. The transitions during the run are:

```
                ┌────── No folder open ─────► register placeholder commands + degraded sidebar ─► RETURN
[Trigger fires] ┼────── Folder, no git ─────► register placeholder commands (incl. initGit) + degraded sidebar ─► RETURN
                └────── Folder + git    ────► full sequence (steps 0-16 above) ─► RETURN
```

Once the full sequence has returned, no further "activation" happens. Subsequent state changes (enable/disable, sign-in/sign-out, branch switch, hook-version mismatch) are handled by their own dedicated subscriptions and commands; they do not re-run activation.

## Notable Behavior

- **The optimistic `enabled = true` context key is intentional.** Without it, the disabled-state welcome placeholder briefly flashes while the first status query is in flight. The real value lands within the first status refresh and is corrected before the user can interact with the sidebar.
- **Migrations are fire-and-forget.** Activation does not await KB initialization. The sidebar webview can resolve and ask for an initial folder listing before migration has written anything; once migration completes, the sidebar is force-reset so its first listing reflects the freshly migrated content. Without that explicit reset, the user would see an empty Folders tab until the next refresh click.
- **The HEAD watcher resolves its path through git itself.** Watching a hard-coded `.git/HEAD` path silently fails inside worktrees because `.git` there is a pointer file, not a directory. Asking git for the absolute path makes the watcher correct in regular repos and worktrees alike. The watcher subscribes to both create and change events because branch switches on Windows fire as create events (atomic rename of `HEAD.lock` → `HEAD`).
- **The Memories store is gated behind `hasFirstLoaded` in passive triggers.** The orphan-summary-ref watcher and the worker-lock watcher only call Memories refresh when the user has already opened the Memories tab once. This means a user who never opens Memories pays no listing cost on every commit. Active gestures (the Enable command, the explicit refresh button) bypass the gate.
- **The lock-file watcher's release callback also re-fires a Commits refresh.** The orphan-ref file watcher should normally fire on summary writes, but on Windows the file-system notification for `.git/refs/` can be delayed or missed. The lock-release fallback guarantees the "View Memory" affordance appears as soon as the worker finishes regardless of the FS notification path.
- **The hook-path staleness check runs last.** Putting it after the initial data load means a user staring at a stale extension still sees their data immediately while the upgrade prompt shows in the background.
- **Every disposable goes onto a single subscription list.** The IDE disposes the entire list automatically on window unload. The deactivate function exists only to log and to release the log channel.
- **Plan and note virtual document providers are registered per-extension-window, not per-preview.** The schemes are stable for the window lifetime; a single content map per scheme tracks the currently-cached content keyed by the URL query, and an explicit change event invalidates the cache when the user re-previews the same id with new content.
- **The status-store loads the global config unconditionally**, not only when the project is enabled. This keeps the configured-state derivation (`signedIn || hasApiKey`) accurate across enable/disable cycles. Without this, disabling would flip configured back to false and replace the disabled panel with the onboarding panel, trapping the user.
- **Auto-enable does not gate on sign-in / API-key state.** The hooks install silently regardless; the onboarding panel handles the "configure a credential" message in parallel. Splitting the two flows lets a user who already trusts the project finish setup without an extra click while a fresh user still sees the onboarding cards.
- **Telemetry bootstrap still runs on a manually disabled repository, but records nothing automatically and sends nothing.** Consent resolution and the one-time first-run disclosure both happen normally — a disabled repository is not exempt from being told what is collected. What is suppressed is the automatic per-activation client event and every flush trigger (the activation flush, the extension-level interval, and the sidebar panel tick). The net effect is a disabled session that has a live telemetry context nothing automatic feeds and nothing drains. Cross-reference: spec 203, spec 204.
- **The write-gate seed (step 0) is the only initialization step that precedes the logger.** Everything else in the sequence assumes a live logger; this one deliberately precedes it, because its whole purpose is to decide whether the logger's file destination may be used at all. (Only the workspace resolution and the git-presence branch check run earlier, and neither logs.)

## Shared Behavior

- **Stores** — the five host-side state controllers constructed in step 6. Their internal contracts (lazy load, change events, snapshot shape) are described under their own topics.
- **Sidebar webview message protocol** — the bidirectional message contract between the sidebar and the host; activation only registers the provider with the right dependency bag.
- **Watcher pipeline** — the file-system watchers wired in step 12; each routes to the appropriate store's refresh path.
- **Command surface** — the manifest command list registered in step 13; each command's individual semantics are defined by its own topic.
- **Status bar** — the per-workspace text/icon area at the bottom of the IDE; activation constructs the manager and refreshes it twice (initial load, post-hook-staleness).
- **KB-folder auto-migration** — the orphan-to-folder migration kicked off in step 11.
- **Hook installer** — the helper that step 16 calls when a worktree's hooks are missing.
- **Onboarding panel** — full-viewport sidebar viewport states (loading / onboarding / disabled / tab UI) are owned by spec 142.
- **Auto-enable on activation** — the substep added to step 16 is owned by spec 144; the durable opt-out that suppresses it by spec 145.
- **The zero-write contract for a manually disabled repository** — the gate seeded in step 0, and the complete inventory of writes it suppresses across the session, is owned by `specs/304-manually-disabled-zero-write-contract.md`. Activation owns only the seeding and its position.
- **Inline Anthropic API key entry** — the sub-panel of the onboarding flow is owned by spec 143.
- **Summary deep-link route** — the `/summary/<hash>` URI handler dispatch is documented inline in step 14; the underlying abbreviated-identifier-rejected look-up policy is shared with the lookup contract in spec 5.
