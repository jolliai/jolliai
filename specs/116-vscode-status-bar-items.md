# VS Code Status Bar Items

## Topic Statement

The single status-bar entry the extension publishes — placed at the left, fixed-priority, always visible after activation — that shows whether Jolli Memory is enabled, opens the sidebar on click, changes its text and background color to a warning theme when disabled, and layers a four-state Memory Bank sync visual ("synced" / "syncing" / "conflicts" / "offline" with a terminal-failure refinement) on top once the sync engine has taken ownership of the item.

## Scope

**In scope:**
- The single status-bar item the extension creates: its text, tooltip, click command, alignment, priority, and the disabled-state color theme.
- The visibility lifecycle: created and shown on activation; disposed only on extension deactivation.
- The two update APIs (legacy and sync), and the one-way "sync has taken over" ownership flag plus the explicit release hook that returns the item to legacy control.
- What "enabled" / "disabled" means visually in legacy mode: the icon-prefixed disabled label and the warning background, vs the plain enabled label.
- The four-state sync visual: "synced" (default), "syncing" (spinner + "Syncing…"), "conflicts" (warning chevron + count), and "offline" — with the "offline" state further refined by a terminal-failure flag that swaps the neutral fallback for a specific failure visual.
- The terminal-failure visual table that maps each terminal sync-error code to a status-bar text, headline, and theme-key (warning vs. error background): contention codes use the warning background, every other terminal code uses the error background, the recoverable-contention code carries a self-locked refinement that explains the lock dangled from this device's own prior round.
- The canary surface that the "synced" state may carry: a symlinked-canary count flips even the green state to a warning visual ("Memory Bank: symlink blocked") to surface hostile-placement defences; an unowned-paths count surfaces in the tooltip only.
- The tooltip composition rule: a headline plus optional error message, optional last-fetch timestamp, and capped path samples for the two canary buckets.
- What this entry does NOT show: branch context, staged-file count, lock-busy state.
- The reason VS Code's built-in source-control status bar is treated as authoritative for branch and staged information (and therefore not duplicated here).

**Out of scope:**
- The sidebar tab the click command opens, and every row it renders (hooks, sessions, provider, account, per-integration rows, worker-busy) — a separate surface owned by **VS Code Sidebar Status Tree** (295). Nothing in this spec describes that tree; the two surfaces share only the status snapshot's enabled flag.
- The status data source (the per-snapshot enabled flag) — driven by the status store, not this manager.
- The lock-busy indicator that lives in the sidebar's Branch tab toolbar (a chip inside the webview, not a status-bar item).
- The plugin-outdated, settings-incomplete, and other diagnostics that surface as toasts or webview banners.
- The `jollimemory.workerBusy` context key, which gates command enablement but is not visible in the status bar.

## Data Contracts

### Item set

The extension publishes exactly **one** status-bar item. There is no per-branch item, no per-lock item, and no per-error item. The single item below is the entirety of the status-bar surface.

### The Jolli Memory item (legacy mode)

| Property | Value when **enabled** | Value when **disabled** |
| --- | --- | --- |
| Text | `Jolli Memory` | `$(circle-outline) Jolli Memory (disabled)` |
| Tooltip | `Jolli Memory — click to open sidebar` | `Jolli Memory — click to open sidebar` |
| Background color | Default (none set) | warning-background theme color |
| Foreground color | Default (none set) | Default |
| Click command | open-sidebar | open-sidebar |
| Alignment | Left | Left |
| Priority | `100` (higher numbers float left within the alignment group) | `100` |
| Visible | Yes | Yes (the warning color makes it conspicuous; it is never hidden) |

The disabled state has an outline-circle icon prefix to the left of the text. There is no icon prefix in the enabled state.

### The Jolli Memory item (sync mode)

Once the sync engine takes ownership, the item paints one of the four states below. Click command, alignment, priority, and visibility match legacy mode in every case.

| State | Text | Background | Tooltip headline (plus optional detail) |
| --- | --- | --- | --- |
| `synced` (no canary alert) | `$(check) Jolli Memory` | Default | "Memory Bank in sync" |
| `synced` (symlinked-canary count > 0) | `$(warning) Memory Bank: symlink blocked` | warning | "Memory Bank in sync — N symlinked path(s) blocked (inspect)" |
| `syncing` | `$(sync~spin) Syncing…` | Default | "Memory Bank sync in progress" |
| `conflicts` (count > 0) | `$(warning) N conflict(s)` | warning | "N item(s) need your attention" |
| `conflicts` (count missing/zero) | `$(warning) Conflicts` | warning | "Memory Bank has conflicts" |
| `offline` (transient — no terminal-failure flag) | `Jolli Memory` | Default | Constant legacy tooltip; the visual deliberately stays neutral because "Offline" reads like sign-in trouble and the next poll tick is overwhelmingly likely to recover |
| `offline` + terminal-failure flag | per terminal-code visual table below | per terminal-code visual table below | per terminal-code visual table below |

#### Terminal-failure visual table

When the `offline` state carries the terminal-failure flag, the failure-code value selects the visual:

| Failure-code class | Text | Background | Headline |
| --- | --- | --- | --- |
| Recoverable contention (lock held by another device) | `$(error) Personal Space busy` | warning | "Personal Space is being synced by another device" — OR, when the self-locked refinement is set, "Your previous sync failed and its backend lock is still releasing — no other device is involved" |
| Local-folder configuration invalid | `$(error) Memory Bank folder invalid` | error | "Update the Memory Bank folder in Settings" |
| Server refused the push | `$(error) Push rejected` | error | "Server refused the push — see Memory Bank log for details" |
| Any other terminal sync-error code | `$(error) Sync failed` | error | "Memory Bank sync failed" |

The mapping is exhaustive over the closed set of terminal sync-error codes — adding a new code without choosing a UI treatment is a compile-time failure rather than a silent fallback to the generic "Sync failed". A runtime fallback to the generic visual still exists so the bar never crashes on an unrecognised code, but the build-time enforcement is the load-bearing safety net.

The icon tokens render codicons to the left of the text: outline-circle (legacy disabled), check (synced), spinning sync (syncing), warning chevron (canary, conflicts), and error (offline terminal failures).

### Update contract

The manager exposes two writer calls and one release call:

- A `legacy-update(enabled)` call. The contract is total — calling it with `true` paints the enabled state; calling it with `false` paints the disabled state. There is no "no-op when unchanged" guard; the manager always re-applies the visual properties (which is cheap because VS Code itself diffs). **Once sync has taken ownership of the item, this call is a no-op.**
- A `sync-update(state, detail?)` call that paints one of the four sync states (`synced` / `syncing` / `conflicts` / `offline`). Calling it once for the lifetime of the session sets a one-way "sync owned" flag so subsequent `legacy-update` calls cannot clobber the sync visual. The `detail` payload may carry the conflict count (used by the `conflicts` state's badge text), the last error message and the last-fetch timestamp (used in the tooltip), a terminal-failure flag with a failure-code refinement (consumed by the `offline` state), a self-locked refinement (used by the contention failure case), and the two canary buckets with their counts and capped path samples (consumed by the `synced` and tooltip paths).
- A `release-sync-ownership` call that flips the one-way flag back off so the next `legacy-update` call can repaint the item. The release is intentionally one-shot: the caller is expected to follow up with a `legacy-update` (or wait for a rebuilt sync engine to call `sync-update`) to set the next visual; this manager does not read configuration to choose for itself.

### Lifecycle contract

| Lifecycle event | Side effect |
| --- | --- |
| Construction | Creates the item with the enabled-state defaults (no icon, no warning color), sets the click command and tooltip, calls `show()` so the item is visible from frame 1. |
| Update | Mutates `text` and `backgroundColor` per the boolean; never hides. |
| Dispose | Releases the item. Called on extension deactivation. |

## Behavior

### Activation

1. The manager is constructed during extension activation.
2. The item appears in the left-aligned status-bar group with priority 100.
3. Initial paint is the enabled state (`Jolli Memory`, no icon, default background) — this is the constructor's default before any update call.
4. As soon as the status store has a fresh enabled value, the host calls the legacy update with the boolean to reconcile.
5. If the user's persisted configuration has the Memory Bank auto-sync flag on, a sync engine starts and immediately calls the sync update — from that point on the legacy update path is a no-op until the sync engine is torn down.

### Status changes (legacy)

1. The status store emits a snapshot whose enabled flag has changed.
2. The host invokes the legacy update on the manager.
3. If sync has taken ownership, the call is dropped and the visual stays as the sync engine last set it.
4. Otherwise the item's text changes between the enabled and disabled labels, and the background flips between default and the warning theme color.

### Status changes (sync)

1. The sync engine drives a round: at start it calls the sync update with `syncing`; on completion it calls the sync update with `synced` (carrying any canary counts), `conflicts` (with the conflict count), or `offline` (with or without the terminal-failure flag and code).
2. The first sync update of the session flips the one-way ownership flag.
3. Each subsequent sync update paints the corresponding visual and rebuilds the tooltip from the headline plus any detail fields present (last error, last fetch, symlinked-canary samples, unowned-paths samples).
4. Canary detection on a successful round: a non-zero symlinked-canary count paints the warning-yellow "symlink blocked" visual even though the round itself succeeded — the symlink was excluded from the commit but the user has to see that hostile placement was attempted. A non-zero unowned-paths count never paints a visual; it only adds a tooltip line.
5. The neutral-offline path (offline state, no terminal-failure flag): the visual reverts to the plain enabled-legacy text and tooltip. The choice is deliberate — "Offline" reads like sign-in / auth trouble, "Unsynced" reads like a user-initiated disable, and the next poll tick almost always recovers.

### Sync teardown (release)

1. The sync engine is torn down (sign-out, auto-sync turned off, poll-interval rebuild, deactivation).
2. The bootstrap caller invokes `release-sync-ownership` on the manager.
3. The one-way ownership flag clears. The next legacy update will repaint the item.
4. The bootstrap caller is expected to follow up with a legacy update (or wait for a freshly-built sync engine to call the sync update) — this manager does not read configuration to choose for itself.

### User clicks the item

1. VS Code dispatches the configured open-sidebar command.
2. The command opens / reveals the Jolli Memory sidebar view container — the same target the activity-bar icon opens.

### Deactivation

1. The host calls `dispose()` on the manager.
2. The item disappears from the status bar.

## State Transitions

The item carries two state dimensions: an ownership dimension (legacy vs. sync-owned) and the visual dimension that depends on which mode owns the item. Sync ownership is a one-way latch that can be released explicitly.

| From | Trigger | To |
| --- | --- | --- |
| Not yet created | Extension activation | Legacy / Enabled (default constructor state) |
| Legacy / Enabled | legacy update with `false` | Legacy / Disabled (icon + warning bg) |
| Legacy / Disabled | legacy update with `true` | Legacy / Enabled (text-only, default bg) |
| Legacy / any | first sync update | Sync-owned / state-per-call (subsequent legacy updates are dropped) |
| Sync-owned / any | sync update with `synced` | Sync-owned / Synced (with canary refinement when symlinked count > 0) |
| Sync-owned / any | sync update with `syncing` | Sync-owned / Syncing |
| Sync-owned / any | sync update with `conflicts` | Sync-owned / Conflicts |
| Sync-owned / any | sync update with `offline`, no terminal failure | Sync-owned / Offline-neutral (visual mirrors legacy enabled) |
| Sync-owned / any | sync update with `offline` + terminal-failure flag | Sync-owned / Offline-failed (visual per terminal-code table) |
| Sync-owned / any | `release-sync-ownership` | Legacy (visual unchanged until the next legacy update repaints it) |
| Any | Extension deactivation | Disposed (not visible) |

The transitions ignore the previous state; each writer always re-applies the target state's full visual definition.

## Notable Behavior

- **One status-bar item, by design.** The brief lists "set of items"; in reality there is exactly one. Branch context comes from VS Code's built-in source-control status bar (which already shows the current branch and ahead/behind counts); staged-file count likewise. Duplicating either would be noise next to the editor's first-class git surface. (Surprising; intentional.)
- **No worker-busy indicator on the status bar.** The lock-held / "AI summary is generating" state is shown as a chip inside the sidebar Branch tab's toolbar, not on the status bar. The status bar stays simple — just enabled / disabled. The worker-busy state is also exposed via the `jollimemory.workerBusy` VS Code context key for command enablement, but no status-bar text changes for it. (Surprising; intentional.)
- **The item is always visible.** It is shown at construction and never hidden. Disabling Jolli Memory changes its color but does not remove it; the warning background is the user's signal that the product is intentionally off, not absent. (Notable.)
- **The disabled state uses the standard warning background.** The color is the theme variable `statusBarItem.warningBackground`, so it matches whatever color VS Code's chosen theme uses for warning-styled status entries (e.g. orange in the default dark theme). The foreground is left default — the warning color provides enough contrast. (Notable.)
- **The tooltip is constant.** It does not change when the item flips between enabled and disabled — both states have the same `Jolli Memory — click to open sidebar` text. The user does not learn the toggle state from the tooltip; the visible text and color carry that information. (Notable.)
- **Priority 100, left side.** The alignment is Left and the priority is 100. Higher priorities float further left within the left-aligned group, so this item sits in the high-priority area near the source-control widget. (Notable.)
- **Click goes to `jollimemory.focusSidebar`.** This is the same command bound to the activity-bar icon and to internal callers that need to "show me the Jolli sidebar". The status bar does not have its own dedicated handler. (Notable.)
- **The legacy update is total — it always re-applies.** There is no early return when the new value equals the previous value. The manager keeps no cached "last enabled" state; every legacy update runs through the same branch. The host is free to call it on every status snapshot without performance concern. (Notable.)
- **`dispose` does not unset the click command first.** The single-shot `dispose()` releases the underlying status-bar item; nothing else cleans up. The command itself is registered elsewhere and is not de-registered by this manager. (Notable.)
- **Once sync has taken ownership, every legacy update is silently dropped.** Pre-fix, a commit / push / squash command's call into the legacy path would silently wipe "Syncing…" / "Sync failed" / "Conflicts" with a plain "Jolli Memory" until the next poll tick rewrote it. The one-way ownership flag is the fix; the symptom (status visible for a fraction of a second, then gone) was the kind of intermittent flicker that's nearly impossible to bisect without the explicit guard. (Surprising; intentional.)
- **Sync ownership is releasable; pre-fix it was permanent.** The `release-sync-ownership` call exists because after sign-out (or any other teardown of the sync engine) the bar otherwise stayed on the last sync visual ("Sync failed" / "Conflicts" / green check) until the extension was reloaded, even though sync was definitively off. The release is intentionally one-shot: the caller is the right authority to choose the next visual based on the post-release config; this file does not read configuration on its own. (Notable.)
- **The neutral-offline visual deliberately looks like nothing happened.** A transient offline (network blip, backend hiccup) repaints the bar as plain "Jolli Memory" rather than "Offline" or "Unsynced" because "Offline" reads like sign-in / auth trouble at a glance and "Unsynced" reads like the user disabled sync. The next poll tick is overwhelmingly likely to recover; if the failure persists past retry budgets, the terminal-failure flag fires and the bar then shows the specific failure. (Surprising; intentional.)
- **Recoverable contention uses warning, not error.** When the sync round is blocked because another device is mid-sync (or this device's previous round left the lock dangling), the bar paints the warning theme background and the headline says "wait a moment" rather than "fix something". Every other terminal failure code uses the error background. (Notable.)
- **The self-locked refinement avoids a misleading "another device" headline.** When this device's previous round ended offline with a non-network terminal code, the backend lock it acquired at mint time is now dangling on its TTL. The next round hits "vault_locked" — without the self-locked refinement the user would see "Personal Space is being synced by another device" and be unable to act; with the refinement they're told the truth ("your previous sync failed and its backend lock is still releasing"), which is actionable (wait the TTL). (Notable.)
- **Canary detection flips even the green state to a warning.** A successful sync round with one or more symlinked entries blocked at the classifier paints "Memory Bank: symlink blocked" instead of the green check. The symlink was excluded from the commit, so the round is genuinely green from a data-integrity perspective, but a hostile-placement attempt was made and the user has to see that. Unowned-paths blocks are noisier (classifier drift, OS metadata) so they stay tooltip-only. (Surprising; intentional.)
- **The terminal-failure code mapping is closed.** Adding a new terminal sync-error code to the closed enumeration without choosing a UI treatment is a compile-time failure. A runtime fallback to "Sync failed" exists for forward-compatibility safety, but the build-time enforcement prevents an accidental silent omission. (Notable.)

## Shared Behavior

- **VS Code source-control status entries.** The branch name, ahead/behind counts, and staged-file count come from VS Code's first-class source-control status bar entries — Jolli Memory deliberately does not duplicate them. Users who hide the source-control status entries (via VS Code's status-bar visibility menu) are choosing not to see that information; Jolli Memory honours that choice rather than working around it.
- **`jollimemory.focusSidebar` command.** The same command is bound to the activity-bar icon and is callable from any other surface that wants to bring the sidebar to focus.
- **Status snapshot.** The enabled value the manager renders comes from the same status snapshot that drives the sidebar's enabled badge, the empty-state copy, the sidebar status tree's row set (295), and the integration-toggle UI in Settings. That is the only thing this entry and the sidebar tree have in common — the tree carries none of the sync-state, canary, or terminal-failure visuals described here, and this entry carries none of the tree's hook / integration / credential rows.
- **Theme color tokens.** The disabled state uses the same warning-background token VS Code's own diagnostics use for status-bar warnings, so the disabled state matches the editor's overall warning palette automatically. The sync mode also uses the editor's warning-background and error-background tokens, so its failure visuals match the same palette.
- **Memory Bank sync engine.** The sync state, the canary surface, the conflict count, and the terminal-failure code set come from the sync engine (cross-ref spec 174). This manager renders what it is told; it does not poll, retry, or interpret the underlying state.
- **Sign-in / sign-out / configuration changes.** The bootstrap that owns the sync engine is also the caller that invokes `release-sync-ownership` and then re-applies a legacy update. This manager has no opinion on what the post-release visual should be.
