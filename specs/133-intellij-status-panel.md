# 133. IntelliJ Status Overlay

## Topic Statement

The status surface of the JVM IDE tool window — an overlay whose header carries three actions (sign in / sign out, disable, close) and whose body is a row list rebuilt from scratch on every status or authentication change: one row per health fact, one read-only account row, one clickable manual-sync row that appears only while signed in, and one row per detected assistant integration, with row activation on a single primary-button click.

## Scope

**In scope:**

- The two render states the body rebuilds itself between: no snapshot (a single initialising label) and snapshot present (the row list).
- The overlay's three header actions, what each one does, and the mouse-button gap they carry.
- The full row set in fixed order, including the read-only account row and the sign-in-gated manual-sync row.
- The always-present integrations row and its three states.
- The four-state per-integration row rule, and the separate scan-failure rows.
- The hooks row's compact summary and its multi-line tooltip.
- The stored-memories row's per-branch count, computed on every render rather than read from the snapshot.
- The optional site row driven by a saved product key.
- The description-colour-by-severity rule and its precedence over the clickable-link colour.
- Row activation: single click, gated on the primary mouse button and on a click count of one, and the reason for both gates.
- Refresh triggers: the project status listener **and** an authentication listener.
- The one detected source the underlying report carries for which this surface has no row at all.

**Out of scope:**

- Where the overlay sits in the tool window's card stack, what shows and hides it, and the health-coloured toggle icon in the title bar — spec 118.
- What the disable and sign-in/out header actions actually *do* once clicked: the enable/disable lifecycle, its optimistic flips and roll-backs, and the projection that can disable a repository at startup — spec 332.
- The disabled card a disabled repository routes to. **This panel is not that card**, and it renders no enable call-to-action of its own.
- The settings dialog, which owns credential entry and the per-integration toggles this panel only reads.
- The sign-in flow itself and the manual sync round this panel only requests.
- The plumbing that produces the status snapshot — every detection flag, every scan-failure record, and the fields this panel has no row for.

## Data Contracts

### Two render states

| State | Trigger | Body |
| --- | --- | --- |
| No snapshot | The service reports no status yet | A single "initialising" label |
| Snapshot | A status snapshot exists | The scrollable row list below |

The body does **not** branch on whether the repository is enabled. Whenever a snapshot exists it builds the full list; rows whose underlying state is "not installed" or zero simply render in that form.

### The overlay header — three actions

Left to right, all rendered as bare labels rather than buttons:

| Action | Icon reflects | Effect |
| --- | --- | --- |
| **Sign in / sign out** | Whether a session exists | Signs out immediately when signed in; otherwise opens the sign-in flow forcing a fresh product key, and on success retries any pending outbound pushes off the interface thread |
| **Disable** | Static | Runs the full teardown for this repository (spec 332). Its tooltip — naming that hooks are removed and a card will appear to turn it back on — is the only warning; there is no confirmation |
| **Close** | Static | Collapses the overlay |

**None of the three is gated on the mouse button.** The toolkit dispatches a click event for the secondary and middle buttons as well, so a right-click on the disable glyph runs the entire uninstall transaction and a right-click on the sign-out glyph signs the user out. The row list directly beneath them *is* gated, for exactly this reason (below).

### Row set, in fixed order

Every render with a snapshot clears and refills the model in this order:

| Label | Icon | Description | Condition |
| --- | --- | --- | --- |
| Hooks | OK when the git-hook flag is set, ERROR otherwise | A `+`-joined list of the installed hook families, or "none installed" | Always |
| MCP & Skills | OK / WARN | "active" / "Node.js not found" / "setup incomplete" | Always |
| Sessions | Pulse | The active-session count | Always |
| Stored Memories | Book | `<branch count> / <total count>` | Always |
| Jolli Account | OK when signed in, WARN otherwise | "connected" / "not connected" | Always — **read-only** |
| Sync Now | Pulse | "click to push memories to your Jolli Space" | **Only while signed in**; carries the panel's only activation callback |
| Jolli Site | Globe | The host from the saved product key, scheme stripped | Only when that key is saved and parses |
| Claude Integration | four-state | four-state | Only when the snapshot's Claude flag is true |
| Codex Integration | four-state | four-state | Only when detected |
| Gemini Integration | four-state | four-state | Only when detected |
| OpenCode Integration | four-state, or WARN on a scan failure | four-state, or "unavailable — *kind*" | Only when detected |
| Cursor Integration | four-state, or WARN on a scan failure | four-state, or "unavailable — *kind*" | Only when the **editor** flag is detected |
| Devin Integration | four-state, or WARN on a scan failure | four-state, or "unavailable — *kind*" | Only when detected |
| Copilot Integration (WARN) | WARN | "unavailable — *kind*" | Only when a Copilot command-line scan failure is reported |
| Copilot Chat (WARN) | WARN | "unavailable — *kind*" | Only when a Copilot chat scan failure is reported |
| Copilot Integration | four-state | four-state, with a per-surface mark in the tooltip | When either Copilot surface is detected |
| Cline (VS Code) (WARN) | WARN | "unavailable — *kind*" | Only when that scan failure is reported |
| Cline CLI (WARN) | WARN | "unavailable — *kind*" | Only when that scan failure is reported |
| Cline Integration | four-state | four-state, with a per-surface mark in the tooltip | When either Cline surface is detected |
| Antigravity Integration | four-state, or WARN on a scan failure | four-state, or "unavailable — *kind*" | Only when detected |
| Kimi Code Integration | four-state | four-state | Only when detected — **no scan-failure channel exists for it** |

### The account row is deliberately read-only

It reports connection state and nothing else; its tooltips point the user at the header icon. The reason is stated in the code: the sign-in and sign-out affordance is meant to exist in exactly one place, so a user hunting for it has one target rather than two.

### Integrations row rule

Always present when a snapshot exists — it is not gated on any detection flag — and driven by two snapshot booleans:

| Runtime available | Integrations active | Icon | Description |
| --- | --- | --- | --- |
| true | true | OK | "active" |
| false | — | WARN | "Node.js not found" |
| true | false | WARN | "setup incomplete" |

### Four-state integration row

For each detected integration with no reported scan failure:

| Saved toggle | Hook status | Icon | Description |
| --- | --- | --- | --- |
| Explicitly off | n/a | WARN | "detected but disabled" |
| On | Hook not required | OK | "detected & enabled" |
| On | Hook required, not installed | WARN | "hook not installed" |
| On | Hook required, installed | OK | "hook installed" |

Only the two assistant hosts that carry their own agent hooks take the hook-required branches; every other integration takes the hook-not-required branch.

### Scan-failure rows

An integration whose session store could not be read gets a WARN row reading "unavailable — *kind*", with the failure detail in the tooltip. For the single-surface integrations that row **replaces** the four-state row for that render. The two dual-surface integrations behave differently: each of their surfaces emits its **own standalone** WARN row *in addition to* the combined four-state row, and those standalone rows are not gated on the integration's saved toggle — so a reported scan failure surfaces even when the integration is switched off in configuration. (Asymmetric with the single-surface gating.)

### Detection is snapshot-only

Every per-integration flag is read straight from the status snapshot, and a null flag **renders nothing** — the row is omitted entirely. There is no probe, no filesystem fallback, and no integration for which this panel does its own detection. The practical consequence is that until the first snapshot populates these fields, the list has no integration rows at all.

### Stored-memories branch count

Not taken from the snapshot. On every render the panel reads the commits on the current branch that are not in the base branch, passes them through the memory store's have-a-memory filter (which honours commit aliases across rebases and cherry-picks), and counts the survivors. That filter is a delegated round trip across a process boundary, paid on **every single render**. The total count comes verbatim from the snapshot.

### Per-row layout

An icon (all non-transparent pixels replaced with white, cached per icon, when the row is selected), an inset, the label, then the description. Selection foreground wins when selected. Otherwise the description colour is chosen by severity — amber for WARN, red for ERROR, the ordinary muted colour otherwise — and a row carrying an activation callback paints its description link-blue **only when it has no severity colour**. Severity beats the clickability affordance. Tooltips are multi-line.

## Behavior

### Construction

The panel registers a mouse listener for activation, a motion listener that switches the cursor to a hand over rows carrying a callback, a project status listener, and an **authentication listener** — the last because signing in or out changes the account row and toggles both the manual-sync row and the site row, and no status change need accompany it. It then renders once, synchronously.

### Render

On the interface thread: remove every component; read the snapshot; if there is none, add the initialising label and return. Otherwise resolve the repository's main root (so linked worktrees share the main repository's configuration), load the layered configuration for the per-integration toggles and the saved product key, compute the branch count, clear and rebuild the model in the order above, add the scrollable list, revalidate and repaint.

### Row activation

A click activates a row's callback **only when it is the primary button and the click count is exactly one.**

Both gates are load-bearing and both were added at once, replacing an ungated double-click:

- **The button gate** exists because the manual-sync row is the only row in this panel with an external side effect — a real outbound push to a Space — and the toolkit dispatches a click event for the secondary and middle buttons too. Before the gate, a right-click anywhere on that row performed the push.
- **The click-count gate** stops a double-click from firing the action twice.

The panel's other rows carry no callback, so they are inert under any click.

### Manual sync

Runs off the interface thread. If the sync orchestrator has not yet been built — which is the case when a sign-in is immediately followed by a sync, before the reconciliation step has run — it is built first, and only then is the manual round requested. Without that, the sync would silently not run.

### Disposal

The status listener is removed and the authentication listener's registration is disposed.

## State Transitions

```
[panel constructed]
  register activation + cursor listeners
  register status listener; register auth listener
  render()

[render]
  removeAll()
  snapshot = service status
  if none: add "initialising" label; return
  config = layered config at the main repository root
  branchCount = walk branch commits, filter by stored memory
  clear model
  add Hooks, MCP & Skills, Sessions, Stored Memories
  add Jolli Account  (+ Sync Now only when signed in)
  add Jolli Site      only when the product key is saved and parses
  add one four-state row per DETECTED integration, in the fixed order above
  add a scan-failure WARN row wherever one is reported
  add the list; revalidate; repaint

[status listener fires]        → render()
[auth listener fires]          → render()
[primary single click on a row carrying a callback] → invoke it
[any other click]              → ignored
[panel disposed]               → remove status listener; dispose auth registration
```

## Notable Behavior

- **The panel rebuilds itself top-down on every refresh.** There is no in-place row mutation; the model is cleared and refilled and the panel removes every component before re-adding the list.
- **The header's three actions carry no mouse-button gate, while the rows beneath them do.** The fix that stopped a right-click from firing a real outbound push on the sync row was never applied one level up — so a right-click on the disable glyph still runs a full uninstall, and a right-click on the sign-out glyph still signs the user out. (Surprising; reality.)
- **Row activation is a single primary-button click, not a double-click.** The earlier contract was an ungated double-click, which meant a right-**double**-click on the manual-sync row performed a real push to a Space.
- **The account row is informational on purpose.** Sign-in and sign-out live only in the header, so the gesture has exactly one home; the row's tooltips exist to point there.
- **The manual-sync row exists only while signed in**, and it is the only row in the whole panel that does anything when clicked.
- **The panel now refreshes on authentication changes as well as status changes.** Signing in or out changes three rows and need not be accompanied by any status change.
- **The hooks row's icon hinges on the git-hook flag alone.** With git hooks installed but an assistant hook missing, the icon is still OK; the description and tooltip carry the detail, and the per-integration rows are where a missing hook surfaces as a warning.
- **The hooks row's description is a joined list of installed families**, and the numbers in it are part of the literal strings rather than computed counts.
- **The hooks health icon ignores the push-time hook.** The flag the snapshot supplies is computed from every git hook *except* that one. The row's description and tooltip both count it, but the OK-versus-ERROR decision does not — so a repository with every git hook and one missing only the push-time hook render identically. (Surprising; reality.)
- **The branch count is recomputed on every render, across a process boundary.** This is what lets it reflect the currently checked-out branch even when the snapshot is stale, and it is paid on every status fire and every authentication fire.
- **Commit aliases are honoured** in that count: a commit whose tree matches a previously-summarised one after a rebase, cherry-pick or amend still counts.
- **The site row reads the saved configuration, not the live session.** A signed-out user with a manually-saved product key still sees it; a signed-in user whose account-managed key has not yet been written to configuration does not.
- **Detection is snapshot-only and a null flag renders nothing.** The panel performs no detection of its own, so before the first snapshot arrives the list carries no integration rows at all.
- **Exactly one source the underlying report detects has no row here at any state: the command-line Cursor agent.** This surface's snapshot model carries no field for it or for its scan failures, so a machine running only that agent — with no Cursor editor present — gets no Cursor row, and a scan failure from it is invisible. The other surfaces render it, folding a per-surface mark into their Cursor row alongside a dedicated failure row. (Notable; observable gap. This is the last remnant of a wider gap: rows for the two Cline surfaces, the Devin agent, the Antigravity assistant and the Kimi agent all exist now.)
- **The Kimi row has no failure channel.** Every other embedded-store integration can report a scan failure and surface a warning row; that source's row can only ever render one of the four ordinary states. (Notable.)
- **The dual-surface integrations' failure rows ignore their own toggle.** A reported failure from either Copilot surface, or either Cline surface, produces a standalone warning row even when that integration is switched off — asymmetric with every single-surface integration, whose failure row is gated on its toggle being on. (Surprising.)
- **The integrations row is always shown, unlike every integration row.** It is not gated on a detection flag, so a missing or unconfigured runtime is a durable, hover-explained status rather than only a transient balloon.
- **The "runtime not found" tooltip still claims memory generation survives on native in-IDE hooks.** That is stale: the installed hooks execute under the external runtime, so a machine without it has no memory generation at all — not merely no tools and skills. The tooltip text is the observable contract and it overstates what still works. (Surprising; reality.)
- **This panel has no provider row and no vendor-key row.** It reports hooks, integrations, sessions, stored memories, the account, the optional site host, and the per-integration rows — and nothing about which provider will generate the next memory or whether its credential resolves. So the parity fix that made the provider report name the *selected* provider landed on every other surface and not here, because there was no row to correct. (Notable; observable gap.)
- **This panel is not the disabled card.** A disabled repository routes to a dedicated card elsewhere; this overlay is user-toggled and is additionally force-shown while the repository is configured but not installed. The panel renders no enable call-to-action and no marketing copy.
- **Description colour encodes severity, and severity beats clickability.** A non-healthy row reads by colour, and a clickable row loses its link-blue whenever it also carries a severity.
- **Selected rows white-tint their icons** through a cached transform that replaces every non-transparent pixel while preserving alpha, which is what keeps them legible against the selection background.

## Shared Behavior

- **The status snapshot** — drives the whole body; every render re-reads it. The installation-status core owns every detection flag and scan-failure record rendered here, including the field this panel has no row for.
- **The project status listener and the authentication listener** — both trigger a full re-render; both are released on disposal.
- **The layered configuration** — read on every snapshot-present render for the per-integration toggles and the saved product key.
- **The memory store's have-a-memory filter** — supplies the branch count, as a delegated round trip on every render.
- **The product key parser** — extracts the host and tenant for the site row.
- **The tool window frame (118)** — owns where this overlay sits, what shows and hides it, and the health-coloured toggle in the title bar.
- **The enable/disable surface (332)** — owns what the header's disable action does, what the sign-in/out action does beyond flipping this panel's rows, and the roll-backs behind both.
- **The settings dialog and the onboarding card** — own the credential entry and per-integration toggles this panel only reads, and the enable call-to-action it deliberately does not render.
