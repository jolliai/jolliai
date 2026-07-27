# VS Code Sidebar Tab and Filter State

## Topic Statement

The sidebar's persistent active-tab choice, KB sub-mode, per-tab search filter, and a small set of derived flags that survive a webview reload (e.g. user collapses and reopens the activity-bar icon) for as long as the IDE window is alive, restored to the webview client in a single payload as the response to its readiness handshake.

## Scope

**In scope:**
- The fields that make up the sidebar state record sent to the webview on first contact.
- Where the canonical copy of each field lives (extension-host memory vs. the upstream store that owns the field).
- The lifecycle of the state across a webview teardown and re-resolution (collapse → reopen) within one IDE window.
- The reset triggers that change a field's value: enable/disable, sign-in/sign-out, branch switch, activation-time degraded reason, the destructive Memory Bank rebuild that drops the webview's folder cache, and the breadcrumb selection that puts the sidebar into foreign-readonly mode.
- The single moment in time at which the state is sent to the webview.

**Out of scope:**
- The cross-window persistence layer. State is per-IDE-window only; nothing is written to the IDE's global storage area.
- The webview-side rendering of tabs, filter inputs, or the disabled banner.
- The set of available tabs and KB sub-modes — those are part of the message-protocol topic.
- The bridge calls that produce the underlying truth (current branch, enabled flag, auth state) — they are owned by their producers.

## Data Contracts

### The state record

The sidebar state record carries the following fields. "Source of truth" describes where the canonical copy lives during the window's lifetime.

| Field            | Type                                       | Source of truth                                                                                                                                            |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`        | boolean                                    | A small extension-host-scoped variable; updated by the status refresh path and by enable/disable command outcomes. Pushed to the webview as `enabled:changed` after each update. |
| `authenticated`  | boolean                                    | Same shape as `enabled`. Updated on activation by the saved-config probe, by the OAuth callback handler, and by sign-out. Pushed to the webview as `auth:changed`. |
| `activeTab`      | one of `kb` / `branch` / `status`          | Owned by the webview client; the host's initial value is `branch` in the normal flow and `status` in the degraded flow. The webview is free to change it locally; it informs the host with `tab:switched`. |
| `kbMode`         | `folders` or `memories`                    | Owned by the webview client; the host always seeds it as `folders`. Webview reports changes via `kb:setMode`. |
| `branchName`     | string (empty until the first probe lands) | Extension-host-scoped variable, updated by the branch-watcher emitter on every HEAD change. Pushed to the webview as `branch:branchName`. |
| `detached`       | boolean                                    | Derived alongside `branchName` (true when the literal name is `HEAD`).                                                                                     |
| `currentRepoName`| string (optional)                          | The workspace's own repo display name; left segment of the header breadcrumb and the "home" anchor for the cross-repo dropdown. Computed at activation from the workspace identity; undefined during early-init / degraded modes (the webview falls back to "(workspace)"). |
| `selectedRepoName` | string (optional)                        | Owned by the webview client; the repo the user is currently *viewing* through the breadcrumb. Equal to `currentRepoName` (or undefined) = normal mode; different = foreign-readonly mode. The host materializes the change in reply to `selection:request` and confirms via `selection:set`. |
| `selectedBranchName` | string (optional)                      | Owned by the webview client; the branch viewed inside the selected repo. Different from `branchName` = foreign-readonly mode even if the repo matches. |
| `degradedReason` | `no-workspace` / `no-git` (optional)       | Set by the activation function in the two early-return branches. Absent in the normal flow.                                                                |

There is no `kbRepoFolder` field. The Folders tree renders repos as flat top-level nodes, so no repo-root header label is seeded or replaced.

The webview also keeps two pieces of UI-only state purely client-side:

| Field              | Notes                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Per-tab filter     | The Memories search filter is the canonical example. It is owned by the Memories store host-side (so it survives even if the user collapses the sidebar), but the webview's input field also tracks what the user has typed. |
| Section accordions | The Branch tab has multiple accordion sections; their open/closed state is reported back to the host via `section:toggle` for persistence within the webview's lifetime. |

### Persistence scope

Persistence is **in-memory only**, scoped to the IDE window:

- The webview's collapse/reopen cycle within one IDE window does not lose the state — the host's variables survive because the extension's activation has already happened and the host module remains loaded.
- Closing the IDE window discards everything. On the next window open, activation runs from scratch; the initial state is recomputed from saved config + bridge probe + activation branch.
- There is no global storage write, no per-workspace persistence file, no cross-machine sync of these fields.

## Behavior

### Restoration timing

State is restored to the webview at exactly one moment: the host's reply to the webview's first `ready` outbound message. The reply carries a single `init` inbound message whose payload is the current state record.

The handshake order is:

1. The webview's DOM mounts and posts `ready`.
2. The host computes the current state record (reading from the extension-host variables described above) and replies with `init { state }`.
3. The host then immediately pushes the per-tab snapshot messages (status, memories, plans, changes, commits, branch name).

Between the `ready` and the `init` reply, the webview shows neutral placeholders (loading skeletons). Once `init` arrives, the webview can pick the right tab and toggle the right disabled/CTA banner without waiting for the data pushes.

### Webview re-resolution within the window

If the user collapses the activity-bar item and reopens it (or the IDE re-resolves the webview for any reason while the extension is still active):

1. The webview client is reconstructed from scratch — its in-DOM state is gone.
2. The webview re-emits `ready`.
3. The host computes the **current** state record (which may have changed since the previous `init` due to enable/disable, sign-in/sign-out, branch switch, etc.) and replies with a fresh `init`.
4. The lazy-load trigger fires only on the **first** `ready` per webview lifetime; on a re-resolve it has already fired and is suppressed.
5. The per-tab snapshot pushes follow as on first load.

The user's `activeTab` choice does not survive a webview re-resolution — the webview gets the host's seeded default (`branch` or `status`). This is intentional: storing the user's last-active tab would require either persisting it host-side every time the webview reports a switch, or reading it back from the webview, neither of which is wired. The Memories filter, by contrast, **does** survive because it is owned host-side by the Memories store; the webview re-renders the filtered list on `kb:memoriesData` without needing to remember the filter string itself.

### View-switch surface and native title-bar icons

`activeTab` still ranges over the three internal ids (`branch` / `kb` / `status`), but the way the user moves between them changed:

- **Two view-switch buttons** — "Current Branch" (`branch`) and "Memory Bank" (`kb`) — render under the native view title bar. Each **always navigates** to its view; clicking never toggles or collapses. Clicking the button for the view you are already on is a no-op (the switch short-circuits when the target equals the current tab).
- **Status is no longer a view-switch button.** It is a **native title-bar Status icon** that posts the `status:toggle` inbound message. The webview owns the toggle semantics: opening Status from the Branch/Memory Bank view shows the Status overlay; clicking Status again *while Status is showing* collapses back to the Branch view. (Memory Bank clicked while on Memory Bank is a plain no-op, not a collapse — collapse-to-Branch is reserved for the Status overlay.)
- **Settings likewise moved to a native title-bar icon.** It is no longer an in-webview command surfaced inside the view.
- **The breadcrumb bar is breadcrumb-only.** It shows the repo/branch segments (plus the optional "Showing: `<repo>`" repo filter on the Memory Bank view). The former right-side in-webview icon strip is gone — those affordances now live on the native title bar.

When the Status overlay is active, none of the two view-switch buttons is highlighted (Status is not one of them).

### Re-init guard

The host re-broadcasts `init` on events that are **not** sidebar reloads — notably the Working-Memory review panel's `ready` handshake, which re-runs the host's first-load path and fans `init` out to this sidebar (the panel reuses the sidebar's broadcast machinery, spec 247). Because the host's initial state always reports `activeTab: branch`, an unguarded re-init would yank a user viewing Memory Bank or Status back to Branch. A one-shot guard fixes this: **only the first `init` sets the active tab**; later `init` messages reconcile the rest of the state (enabled, configured, branch name, selection) but leave the tab alone. The same first-init tab-application also guards against a stale persisted tab id (e.g. the removed `knowledge` view) by falling back to the default `branch` when the id has no panel.

### Reset triggers

Each field has its own change triggers, and each trigger fires a dedicated push so the webview can react without a full re-init.

| Field            | Trigger                                                                                                                       | Inbound message after the change                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `enabled`        | Successful enable/disable command outcome; status refresh after a hook-path correction.                                       | `enabled:changed { enabled }`                              |
| `authenticated`  | OAuth callback success; explicit sign-out.                                                                                    | `auth:changed { authenticated }`                          |
| `branchName` / `detached` | Any HEAD change picked up by the HEAD watcher; the very first branch probe at activation.                              | `branch:branchName { name, detached }`                     |
| `activeTab`      | Webview reports `tab:switched`.                                                                                               | None — host stores it for the next `init` if needed.        |
| `kbMode`         | Webview reports `kb:setMode`. When switching to `memories`, the host follows up with a fresh `kb:memoriesData` push so the panel does not show the previous data while the webview swaps modes. | None additional — the data push is the change. |
| `selectedRepoName` / `selectedBranchName` | Webview reports `selection:request`; the host repopulates the `branch:*` feeds.                          | `selection:set { repoName?, branchName? }` confirming the applied selection. |
| `degradedReason` | Set once at activation in the two degraded branches; never changes during the window's lifetime.                              | None — only seen at the first `init`.                      |

### What is *not* a reset

These changes do not affect the sidebar state record:

- Watchers firing on file changes, lock create/delete, or orphan-ref updates: those refresh per-tab data but do not touch the state record.
- The Memories filter being typed, cleared, or paginated: lives entirely outside the state record.
- The user clicking the toolbar refresh button: triggers per-scope refreshes; no state-record write.
- A summary panel being opened or closed: independent of the sidebar entirely.

## State Transitions

```
[Activation]
   │
   ├─► (degraded branch?) ──yes──► state.degradedReason = no-workspace | no-git, activeTab = status
   │                                state.enabled = false, state.authenticated = false
   │
   └─► (full branch) ──► state.enabled = optimistic true (corrected by first status probe)
                        state.authenticated = false (corrected by config probe)
                        state.activeTab = branch
                        state.kbMode = folders
                        state.branchName = "" (corrected by first branch probe)
                        state.currentRepoName = computed-once (undefined until extractRepoName runs)
                        state.degradedReason = absent

[Webview ready]            ─► host sends init { current state record }

[enable/disable command]    ─► state.enabled flips, host pushes enabled:changed

[sign-in callback]          ─► state.authenticated = true,  host pushes auth:changed
[sign-out command]          ─► state.authenticated = false, host pushes auth:changed

[HEAD change]               ─► state.branchName/detached update, host pushes branch:branchName

[Memory Bank rebuild]       ─► host pushes kb:foldersReset (no payload) + a fresh root listing

[breadcrumb selection]      ─► state.selectedRepoName/selectedBranchName update,
                              host repopulates branch:* feeds + pushes selection:set

[Webview collapse/reopen]   ─► webview rebuilds, posts ready
                              ─► host sends fresh init with current state record
                              (lazy-load trigger does NOT re-fire)

[IDE window close]          ─► all state discarded
```

## Notable Behavior

- **The state is not written to disk.** Every field is derived from saved config (auth) or computed at activation (branch, KB anchor, degraded reason) or maintained in memory (enabled, KB mode, active tab). The next time the IDE window opens, activation runs again and recomputes everything.
- **Active-tab choice does not persist across a webview re-resolution.** The user is dropped on the host's seeded default. The Memories filter does persist because it lives in the Memories store (separate topic), not in the sidebar state.
- **The lazy-load trigger is one-shot per webview lifetime, not per state record.** Its guard is a separate boolean inside the sidebar provider; collapsing and reopening the sidebar fires `ready` again but does not re-fire the trigger.
- **`enabled` is set optimistically to `true` at activation before the bridge has confirmed.** This is corrected within the first status refresh. The optimistic value prevents the disabled banner from flashing on first paint.
- **`degradedReason` is the only field that is set once and never updated.** Activation cannot transition between branches; if the user opens a folder or initializes git, that requires an IDE reload and a fresh activation.
- **`currentRepoName` is computed once at activation and does not change during the window's life.** The destructive Memory Bank rebuild does not re-anchor it — the host pushes `kb:foldersReset` (no payload) and a fresh root listing, and the renamed `-N`-suffixed folder appears as one of the flat top-level repo nodes.
- **`selectedRepoName` / `selectedBranchName` are webview-owned and can change any number of times during the window's life** as the user picks repos and branches from the breadcrumb dropdown. When they diverge from the workspace's own repo+HEAD the sidebar enters foreign-readonly mode. They are not seeded at `init` (the webview starts on the workspace selection) and are not persisted across a webview re-resolution.
- **Section accordion state is the webview's responsibility.** It reports `section:toggle` to the host so a section's open/closed state can be respected if the host ever needs it, but it is not part of the state record sent at `init`. A re-resolved webview re-opens whatever sections it considers default.
- **The view-switch surface is two always-navigate buttons; toggle-to-collapse is Status-only.** Current Branch and Memory Bank never collapse; only the native Status icon toggles (Status-while-on-Status returns to Branch). Settings and Status are native title-bar icons, not in-webview controls.
- **There is no third "Knowledge" view.** A third view-tab existed transiently mid-range and was removed before HEAD; HEAD ships only Current Branch and Memory Bank (plus the Status overlay). The first-init tab guard falls back to `branch` for any stale/unknown tab id, so a persisted `knowledge` id resolves harmlessly.
- **A re-broadcast `init` never changes the active tab.** The one-shot guard means the review panel's `ready` handshake (which re-runs the host first-load) cannot pull the user off Memory Bank or Status.

## Shared Behavior

- **Sidebar message protocol** — the inbound and outbound message types referenced here.
- **Activation lifecycle** — the source of the initial state record and the place where `degradedReason`, `currentRepoName`, and the optimistic `enabled` are seeded.
- **Memories store** — the host-side owner of the search filter that the webview shows in the Memories tab.
- **HEAD watcher** — the source of `branchName` / `detached` updates.
- **Auth surface** — the source of `authenticated` updates and the `signedIn` context key.
- **Memory Bank rebuild command** — the host-side operation whose completion triggers the `kb:foldersReset` cache drop and a fresh root listing.
- **Breadcrumb selection / foreign-readonly mode** — the source of `selectedRepoName` / `selectedBranchName` changes and the `selection:*` message family (see spec 101).
- **Working-Memory review panel (spec 247)** — its `ready` handshake reuses the sidebar broadcast machinery and triggers the re-broadcast `init` the re-init guard exists to absorb.
