# IntelliJ Active Conversations Panel

## Topic Statement

A tool-window section that lists the currently-active AI coding conversations from every supported producer as one row each, refreshes itself on a timer plus on every project-status change, opens an editor tab when a row is clicked, and provides per-row actions for pinning, resuming a Claude or Codex session in the terminal, and toggling the row's selection for the next commit memory.

## Scope

**In scope:**

- The panel's anatomy: an optional partial-failure warning banner at the top, a vertical list of conversation rows below with a row-count cap and an expand affordance, and a centered empty-state label when the list is empty. The panel has no internal scroll bar; the parent section provides a single shared scroll bar across all sub-panels.
- The row's anatomy: a producer badge on the left (a real logo when available, otherwise a colored text badge), the resolved display title in the middle, and on the right side: an unread message-count badge in the default (non-hovered) state; and four hover-revealed icon actions (pin, open/eye, resume-in-terminal, selection toggle) in the hovered state.
- The data source: a single delegated round-trip to the shared active-session aggregator (covered by its own spec) carrying an explicit recency window, returning items plus failed-producer diagnostics.
- The refresh triggers: an initial load on construction, a 60-second poll that only fires when the panel is currently shown on screen, a callback from a project-status listener, an explicit "refresh" action wired into the host tool-window's action group, and an editor-side save callback that triggers refresh after a row's transcript has been edited.
- The click semantics on the row body (opens the conversation as an editor tab), the pin-button click (records a pin to the pinned panel), the resume-button click (opens a terminal tab and resumes a session in the terminal — only functional for Claude and Codex rows, gated by the shared "can resume this source" predicate owned by the terminal utilities module), and the selection-toggle click (flips the row's inclusion in the next commit memory with strikethrough feedback).
- The row-cap behavior: rows are capped at a fixed visible count; a "Show N more" affordance at the bottom of the capped list expands the panel to show all rows. Expansion is per-refresh-cycle and does not persist across panel refreshes.
- The hover semantics: the row background lightens and the four hover-action icons replace the message-count badge when the cursor is anywhere over the row (including over any child component); both revert when the cursor leaves the row's outer bounds.
- The failure-isolation rule: a wholesale aggregator failure is caught at the panel boundary and rendered as "no items and **every** producer failed", so the warning banner and the empty-state label appear together. Never propagated.
- The threading model: all data reads happen on a background pool; all UI mutations happen on the UI thread.
- The disposal contract: the timer and the status-listener registration are torn down when the panel is disposed.
- The interaction with the editor-tab return value: when a click opens the editor tab, the panel installs a save-side callback on the tab so that an edit made there refreshes the list on save.
- The telemetry flush: the 60-second timer tick also triggers a best-effort flush of buffered telemetry events; failures are swallowed silently.
- The producer badge (logo or colored text badge) and the recovery rule for an unknown producer.

**Out of scope (boundaries):**

- The fan-out across producers, per-producer failure isolation, the recency-window filter, the title cascade, the unread-message-count filter, the dedup-by-composite-key rule, the per-row "is edited" and "is selected" flags, and the sort order are owned by the **active session aggregator** spec. This panel only consumes the result envelope.
- The editor tab's internal layout — header, message rows, per-message edit/delete affordances, "Save All" / "Cancel" / "Mark All as Deleted" footer, auto-hide on empty save, identity-based overlay rules — is owned by the conversation-editor spec.
- The virtual-file class used to open the editor tab is owned by its own spec; this panel only constructs it and passes it to the IDE's open-file mechanism.
- The accordion section that hosts this panel (its header, collapse state, resize bar, gear-menu visibility toggle, action group anchor) is owned by the tool-window accordion spec. The parent section also owns the single scroll bar shared by this panel and sibling panels.
- The shape and meaning of the result envelope's `items` and `failedSources` fields are owned by the aggregator spec; this panel only renders them.
- The action-system registration of the "refresh" action is part of the tool-window action surface; this panel only exposes a public refresh method.
- The project's "main repo root" resolution and the project's status-listener channel are owned by the project-service spec; this panel only subscribes.
- The terminal integration used to resume Claude or Codex sessions (including the shared eligibility predicate, the two command forms, and the per-source default tab title) is owned by the terminal utilities module (see spec 212); this panel only calls it with the session identifier and source.
- The pinned-panel data store is owned by the pinned panel; this panel only calls the pin entry point.
- The commit-selection store (which records which conversations are excluded from the next commit memory) is owned by its own spec; this panel only reads and writes the per-conversation exclusion flag.

## Data Contracts

### Inputs the panel consumes

| Field | Provider | Meaning |
| --- | --- | --- |
| project handle | host | The IDE-level handle for the current project; used to obtain the file-editor manager and the project base path fallback. |
| status-aware project service | host | Exposes (a) a registration channel for status-change listeners with the contract "the listener fires once immediately if status is already available, then on every subsequent change", (b) the resolved main repo root (or `null` until resolution), and (c) the project base path fallback for the rare case where the main repo root has not been resolved yet. |
| result envelope from the aggregator | delegated aggregator round-trip | A list of conversation items plus a list of failed-producer names. |

### The aggregator call

The panel does not run the fan-out in-process. It issues a **single delegated round-trip** to the command-line surface's own active-session aggregator, passing the resolved working directory and an explicit recency window. The window the panel supplies is 48 hours; the delegated action also defaults to 48 hours when no window is given, so the two agree.

Because the call crosses a process boundary, it can fail for reasons that have nothing to do with any producer — a missing runtime, a spawn failure, a timeout, an unparseable response. All of those land in the same catch as a genuine aggregator crash and are reported identically (see "Data load").

### Per-row source data

The panel receives each row from the aggregator with these fields and consumes them as follows:

| Field | How the row uses it |
| --- | --- |
| producer | Selects the badge logo or color; passed as part of the row identity to the pin store and the commit-selection store. |
| session identifier | Forms the row identity (combined with producer); passed to the pin store, the commit-selection store, the resume call, and the editor tab. |
| display title | Rendered verbatim in the row's title slot and in the editor tab's name. Title resolution, including truncation and placeholder fallback, happens upstream in the aggregator. |
| unread message count | When greater than zero, rendered as a small gray count on the right in the non-hovered state; when zero or in the hovered state, the count is not shown. |
| last-activity timestamp | Forwarded to the editor tab as session info; the panel itself does not render the timestamp. Ordering by this field has already happened upstream. |
| transcript locator | Forwarded to the editor tab as session info; the panel does not parse or validate it. |
| per-session "is edited" flag | Not rendered by the panel. |
| per-session "is selected" flag | Initializes the row's selection state, which controls the strikethrough rendering and the ✕/＋ toggle icon. The panel reads this flag from the commit-selection store (layered on top of the aggregator result) at load time and updates it via the selection-toggle action. |

### Producer badge map

Each row's lead component is determined by a logo-first rule: if the product's icon registry has a logo image for the producer name, a plain icon label is shown with the producer name as a tooltip; otherwise a colored text badge (rounded rectangle, white producer name in bold, color from the map below) is shown.

| Producer | Badge label | Text-badge color (light/dark use the same value) |
| --- | --- | --- |
| Claude Code | `Claude` | Amber. |
| Gemini | `Gemini` | Emerald green. |
| Codex | `Codex` | Violet. |
| OpenCode | `OpenCode` | Cobalt blue. |
| Cursor | `Cursor` | Crimson red. |
| GitHub Copilot (CLI) | `Copilot` | Medium green. |
| GitHub Copilot Chat | `Copilot Chat` | Medium green. |
| Cursor CLI | `Cursor-cli` | Neutral gray (no colour entry). |
| Cline | `Cline` | Neutral gray (no colour entry). |
| Cline CLI | `Cline-cli` | Neutral gray (no colour entry). |
| Devin | `Devin` | Neutral gray (no colour entry). |
| Antigravity | `Antigravity` | Neutral gray (no colour entry). |
| Any other producer (forward-compat) | capitalized raw name | Neutral gray. |

The logo-first rule means that for producers that have a registered logo, users see the actual product logo rather than a text badge. The badge is the fallback for producers with no logo entry.

**Five producers were newly made reachable and none of them got styling.** The producer enumeration grew from seven members to twelve — Cursor CLI, Cline, Cline CLI, Devin and Antigravity were added — and the upstream aggregator now really collects sessions for all of them. Neither the colour table nor the logo registry was extended, so all five fall through to the neutral-gray text badge. Their labels come from the generic fallback rule, which uppercases only the **first** character of the raw producer name: the hyphenated names therefore render as `Cursor-cli` and `Cline-cli` rather than `Cursor CLI` / `Cline CLI`. Only three producers have hand-written labels (`Copilot`, `Copilot Chat`, `OpenCode`); everything else is the capitalized raw name.

Both Copilot producers were already part of this contract before an earlier revision; rows for them do really appear. (An earlier version of this spec said the Copilot map entries were reachable only in theory — that is no longer true and the note has been removed.)

### Empty-state contract

When the result envelope's `items` list is empty:

- A single horizontally-centered gray label reading **`No active conversations`** is shown in the list area.
- The label has a uniform padding so it does not stick to the panel edges.
- The warning banner above the list still appears if `failedSources` is non-empty (so the user can distinguish "nothing active" from "everything failed to load").

### Warning-banner contract

When `failedSources` is non-empty, a single-line banner is shown at the top of the panel reading **`Some sources failed to load`**, with:

- A pale-yellow background in the light theme and a dim-amber background in the dark theme.
- A dark-amber text color in the light theme and a bright-amber text color in the dark theme.
- Compact horizontal and vertical padding.
- No indication of which producers failed — the banner is global, not per-producer.

When `failedSources` is empty, the banner is hidden (`visible = false`) and does not consume vertical space.

### Refresh trigger contract

The panel refreshes its data under any of these conditions:

| Trigger | Always reloads, or conditional? |
| --- | --- |
| Construction (initial load) | Always. |
| The 60-second poll timer ticks | Conditional: only if the panel is currently visible on screen. |
| The project-status listener fires | Always (the listener is invoked once on registration if status is already available, then on every change). |
| The host's "refresh" action is invoked | Always. |
| The editor tab's save callback fires | Always (a save on the editor side calls back into the panel). |
| The "select all / deselect all" toggle is applied | Always, after the exclusion records have been written on a background thread. |

A "refresh" is a fresh, full call to the aggregator. There is no diff, no in-place mutation, and no caching at the panel layer. Each refresh rebuilds the entire row list.

## Behavior

### Construction

When the panel is constructed:

1. The row container is created with a vertical box layout.
2. The empty-state label is created (but not yet attached).
3. The warning banner is created with its colors and text, set to invisible, and added to a content panel alongside the row container. The content panel is added to the panel's north edge (so the panel reports its natural height to the parent's single shared scroll bar rather than sizing to fill available space).
4. The panel registers itself as a project-status listener. Because the listener channel's contract fires the listener once immediately if status is already cached, this acts as an additional initial-load trigger if status happens to be available before construction returns.
5. A 60-second poll timer is started. The timer is set to repeat indefinitely and its action checks the panel's `isShowing` property before firing a refresh. Each tick also triggers a best-effort flush of buffered telemetry events, swallowing any errors.
6. An initial data load is scheduled on a background pool. The panel does not wait for the load to complete before returning from construction; the row container is initially empty until the first load resolves.

### Data load (a single cycle)

A load cycle, executed on a background thread:

1. Resolve the project's working directory: prefer the service's main repo root; fall back to the project's base path. If both are null, abort the load silently (no error, no UI mutation).
2. Issue the delegated aggregator round-trip with the resolved working directory and the 48-hour window.
3. If that call throws, catch the exception and substitute an envelope with **no items and every producer marked failed** (`items = []`, `failedSources = <every member of the producer enumeration>`). The exception itself is still swallowed — no error toast, no modal — but the substituted envelope is diagnostic: the warning banner shows, and because the item list is empty the empty-state label shows too. This **matches** the consumer wrapper's contract on the VS Code side; the previous IntelliJ-only behavior of substituting an all-empty envelope (which made a crashed aggregator indistinguishable from "no active conversations") is gone.
4. Marshal back to the UI thread to apply the envelope.

### UI update (under the UI thread)

When a fresh envelope arrives:

1. Replace the panel's cached `items` and `failedSources` fields with the new envelope's values.
2. Toggle the warning banner's visibility based on `failedSources.isNotEmpty()`.
3. Clear the row container of all child components.
4. If `items` is empty, attach the empty-state label.
5. Otherwise, construct a row component for each item and pass the full list to the row-cap renderer. The renderer attaches the first N rows directly; if the list exceeds the cap, it appends a "Show N more" affordance instead of the remaining rows. If the panel's expanded flag is set (the user clicked "Show N more" in a prior render cycle), all rows are attached.
6. Trigger the container's revalidate-and-repaint cycle.

The previous-frame's row components are not reused; every refresh allocates fresh row components. The panel does not preserve per-row state across refreshes (hover state, selection state is re-read from the store). The expanded flag resets when the panel resets (construction or disposal), but persists across aggregator-driven refreshes within the same panel instance until explicitly reset.

### Row composition (per row)

A row is constructed with the following layout, in a single horizontal strip:

1. **West**: the producer badge — a real logo icon label (with the producer name as a tooltip) when a logo is registered for the producer, otherwise a rounded-rectangle colored text badge with the producer name in bold white text.
2. **Center**: the title label, with left padding to separate it from the badge. The label truncates with the IDE's default text-truncation behavior when there isn't enough width. When the row is deselected (excluded from the next commit memory), the title font gains a strikethrough decoration and the text color is dimmed to gray.
3. **East**: a right-aligned cluster that alternates between two states:
   - **Default state**: the message-count label (gray text, slightly smaller than the row font). Omitted if count is zero.
   - **Hovered state**: four icon labels, each initially invisible and shown only on hover — pin, open/eye, resume-in-terminal, and selection toggle. The resume-in-terminal icon is always present in the row component but is only useful for Claude and Codex sessions; clicking it on any other producer's row is a no-op (the click handler returns immediately if the row's source fails the shared "can resume this source" check, which currently passes only `claude` and `codex`). The selection-toggle icon shows ✕ ("Exclude from next memory") when the row is currently selected, and ＋ ("Include in next memory") when deselected.

The row has uniform padding, an opaque background, and a hand cursor everywhere.

The row's maximum height is bound to its preferred height, so the row never grows vertically inside the box layout regardless of available space.

### Hover model

A single shared hover mouse-adapter is installed on the row itself, the badge (or logo label), the title label, the right-cluster panel, and each of the four hover-action icon labels. The adapter:

- On `mouseEntered` (from any of those source components): paints a faint overlay (a translucent black in the light theme, a translucent white in the dark theme) as the row's background, hides the message-count label, and shows the four hover-action icons.
- On `mouseExited` (from any source component): checks whether the mouse's screen-space coordinates are still inside the row's outer screen-space bounds. If they are, do nothing — the user merely crossed an internal sub-component boundary. If they are not, clear the background, show the message-count label, and hide the four hover-action icons.

The screen-space check is what prevents the hover-action icons from flickering off when the cursor moves between the badge and the title (or between the title and the right cluster), because Java's per-component mouse events do not fire in a contained order.

### Row-click model

A single shared click mouse-adapter is installed on the row itself, the badge (or logo label), the title label, the right-cluster panel, and the message-count label. It is **not** installed on any of the four hover-action icon labels.

Each hover-action icon label has its own click mouse-adapter that consumes the event before propagating, so a click on any of the four icons does **not** also fire the row-click.

### Row click (opens an editor tab)

When the user clicks anywhere on the row except one of the four hover-action icons:

1. Resolve the working directory the same way the data load does (main repo root, then project base path). If both are null, do nothing.
2. Construct a virtual file carrying the row's item plus the working directory.
3. Hand the virtual file to the IDE's file-editor manager's open-file call with focus.
4. The open call returns one or more file editors. Iterate them; for any editor of the conversation-editor type, install a save-side callback that re-invokes the panel's refresh method.

The virtual file's equality contract — producer plus session identifier — is what makes the open call surface an existing tab when the user clicks the same row a second time, instead of opening a duplicate.

The panel does not validate that the editor opened successfully; if the open call returns an empty list, the panel just continues and waits for the next refresh trigger.

### Pin-button click

When the user clicks the pin icon:

1. The pin icon's click adapter consumes the event so the row-level click handler does not also fire.
2. The panel resolves the working directory.
3. On a background thread, calls the pin store's "pin this item" entry point with the working directory, a category identifier for conversations, the composite row key (producer and session identifier), the display title, and the producer name.
4. After the pin write returns, marshals to the UI thread and calls refresh on the pinned panel (via the service's panel registry).

The panel does not refresh itself after a pin; the pinned panel is the surface that shows the newly pinned item.

### Resume-button click

When the user clicks the resume icon:

1. The resume icon's click adapter consumes the event so the row-level click handler does not also fire.
2. If the row's producer fails the shared "can resume this source" check (only `claude` and `codex` pass), the handler returns immediately.
3. The panel resolves the working directory.
4. Calls the terminal utilities module's generic resume entry point with the project, the row's source, the session identifier, the working directory, and a tab title constructed from the row's display title.

The terminal utilities module is responsible for choosing the source-appropriate resume command, locating or opening a terminal tab, and sending it; the panel only provides the parameters (including, now, the source itself — previously the entry point was Claude-specific and did not need one). No telemetry is recorded by this panel's resume path.

### Selection-toggle click

When the user clicks the selection-toggle icon (✕ to exclude or ＋ to include):

1. The toggle icon's click adapter consumes the event so the row-level click handler does not also fire.
2. The row's in-memory selected flag flips.
3. The row immediately updates its title font (strikethrough when deselected, normal when selected), title color (gray when deselected, default when selected), and toggle icon (✕ when selected, ＋ when deselected).
4. On a background thread, calls the commit-selection store's write entry point with the working directory, category "conversations", the composite row key, and the new exclusion state (excluded = not selected).

The UI update is immediate and optimistic; the background write may lag by a moment but the display reflects the user's intent without waiting.

### Select-all / deselect-all

The panel exposes a public toggle-select-all method. When called:

1. Checks whether any row in the current conversation list is unchecked (not selected). If any unchecked row exists, the intent is "select all"; otherwise the intent is "deselect all".
2. Resolves the working directory.
3. On a background thread, calls the commit-selection store's batch-exclusion entry point with all composite row keys and the computed exclusion state.
4. After the batch write returns, marshals to the UI thread and calls the panel's full refresh method.

The method does not update individual rows in place; it defers to a full refresh so the display is consistent with the stored state.

### Failure isolation

The panel's only fail-soft boundary is the wholesale aggregator catch (see "Data load"), and that boundary is now **diagnostic rather than silent**: a wholesale failure is reported as "every producer failed", so the user sees the warning banner. Every other failure mode (a genuinely empty `items` list, a partially non-empty `failedSources` list, a row whose transcript can no longer be read on the editor side) is presented through the data the aggregator returns. The panel does not throw and does not propagate exceptions out of its event handlers.

A consequence worth stating plainly: because the round-trip crosses a process boundary, a machine with no usable runtime produces the same display as a machine where all twelve producers genuinely failed — banner plus empty state. The banner names no producer, so the two are indistinguishable from the panel alone.

### Disposal

When the panel is disposed (as part of the IDE's standard component-disposal chain):

1. Stop the 60-second poll timer.
2. Unregister the project-status listener.

The panel does not need to explicitly tear down its child components — the IDE's disposal chain handles them. There is no per-row resource to release.

## State Transitions

```
[constructed]
  build warning banner + row container, add to NORTH slot
  register status listener  ──→ fires immediately if status already cached
  start 60s poll timer (also flushes telemetry on each tick)
  schedule initial load
  state ← idle, items=[], failedSources=[], expanded=false

[load cycle scheduled]
  on background thread:
    cwd ← service.mainRepoRoot ?? project.basePath
    if cwd == null → return (no UI mutation)
    envelope ← delegated aggregator round-trip (cwd, window = 48h)
                catch (any) → envelope = { items: [], failedSources: EVERY producer }
    for each item: read exclusion from commitSelectionStore → set isSelected
    schedule UI update with adjusted envelope

[UI update]
  items ← adjusted envelope.items
  failedSources ← envelope.failedSources
  warning banner.visible ← failedSources.nonEmpty
  remove all row components
  if items.empty → add empty-state label
  else → CappedRows.render(rowsPanel, rows, expanded, onExpand={expanded=true; renderRows()})
  revalidate + repaint

[60s timer fires]
  if panel.isShowing → schedule load cycle + flush telemetry (best-effort)
  else → no-op (timer keeps ticking)

[status listener fires]
  schedule load cycle

[refresh action invoked]
  schedule load cycle

[row clicked]
  cwd ← service.mainRepoRoot ?? project.basePath
  if cwd == null → no-op
  vf ← new ConversationVirtualFile(item, cwd)
  editors ← fileEditorManager.openFile(vf, focus=true)
  for editor in editors:
    if editor is ConversationFileEditor:
      editor.onSaved = { schedule load cycle }

[pin icon clicked]
  consume click (prevents row-click)
  cwd ← service.mainRepoRoot ?? project.basePath
  if cwd == null → no-op
  on background thread:
    PinStore.pin(cwd, "conversations", rowKey, title, producer)
    schedule UI thread → pinnedPanel.refresh()

[resume icon clicked]
  consume click (prevents row-click)
  if !canResumeSource(item.source) → no-op   // passes only claude, codex
  cwd ← service.mainRepoRoot ?? project.basePath
  TerminalUtils.resumeSession(project, item.source, sessionId, cwd, tabTitle)

[selection toggle clicked]
  consume click (prevents row-click)
  row.selected ← !row.selected
  row: update font (strikethrough if deselected), color, toggle icon
  on background thread:
    CommitSelectionStore.setExcluded(cwd, "conversations", rowKey, !selected)

[select-all / deselect-all invoked]
  intent ← if any item has isSelected=false then "select all" else "deselect all"
  cwd ← service.mainRepoRoot ?? project.basePath
  keys ← all composite row keys
  on background thread:
    CommitSelectionStore.setAllExcluded(cwd, "conversations", keys, !intent=="select all")
    schedule UI thread → schedule load cycle

[hover enters any sub-component of a row]
  row.background ← translucent overlay
  countLabel.visible ← false
  pinIcon.visible ← true
  eyeIcon.visible ← true
  resumeIcon.visible ← true
  toggleIcon.visible ← true

[hover leaves a sub-component of a row]
  if mouse screen position ∉ row screen bounds:
    row.background ← default
    countLabel.visible ← true
    pinIcon.visible ← false
    eyeIcon.visible ← false
    resumeIcon.visible ← false
    toggleIcon.visible ← false
  else:
    no-op (still inside row)

[disposed]
  stop poll timer
  unregister status listener
```

## Notable Behavior

- **The 60-second poll only fires when the panel is on screen.** The timer keeps ticking regardless of visibility; each tick checks `isShowing` and skips silently when collapsed in the accordion, minimized in the tool window, or hidden behind another tab. This avoids both an unbounded backlog of refreshes when the panel re-appears and the cost of polling work the user cannot see.
- **The 60-second timer tick also flushes buffered telemetry.** The flush is a best-effort call that swallows all errors and is a no-op when the buffer is empty. It is piggybacked on the poll tick rather than having its own timer, so there is no separate scheduling concern.
- **The status listener is invoked once immediately on registration if status is already cached.** Late-attached panels do not have to wait for the next status change to receive the current value. The contract is owned by the project service; this panel's reliance on it is what makes the panel's first paint match the service's current state without an explicit kickoff call.
- **A wholesale aggregator failure marks every producer as failed, so the banner and the empty state appear together.** The panel substitutes an envelope with no items and the full producer enumeration in the failed list, which surfaces "Some sources failed to load" above the "No active conversations" label. This **matches** the VS Code consumer wrapper — the two surfaces no longer diverge here. The previous behavior (an all-empty envelope, so a crash looked exactly like an idle machine) has been inverted.
- **The failed list is all-or-nothing on a transport failure.** A single producer that fails inside the aggregator contributes one name; a failure of the round-trip itself contributes all twelve. Since the banner names no producer, a user cannot tell a broken runtime from twelve broken producers.
- **The producer enumeration must stay in lockstep with the command-line surface's own list.** The delegated aggregator emits producer names as strings, and the IDE's deserializer maps an unrecognized name to a null producer that then fails a non-null contract at use — crashing the sidebar the moment the user happens to have a session from a producer the IDE does not know. Adding a producer on the command-line side without adding it here is therefore not a graceful-degradation case; it is a crash. (This is the reason the enumeration grew to twelve members even though five of them have no colour and no logo.)
- **The five newly-reachable producers are visually undifferentiated.** Cursor CLI, Cline, Cline CLI, Devin and Antigravity all render the same neutral-gray pill, and two of them carry a label with a lowercase segment after the hyphen (`Cursor-cli`, `Cline-cli`). A user with sessions from several of them sees five identical gray badges distinguished only by text.
- **Each hover-action icon's click is consumed before the row-click fires.** Each icon registers its own mouse-listener that calls `e.consume()`. The row-click listener is not attached to any of the four icon labels, so both the consume and the listener-exclusion are needed: without `consume`, a click on the icon would still bubble; without the listener-attachment selection, `consume` alone would not be enough on certain look-and-feels.
- **Hover state is recomputed via screen-space coordinates, not parent-relative coordinates.** Crossing an internal sub-component boundary fires `mouseExited` on the leaving component before `mouseEntered` on the entering one, so the naive approach would flicker the icons off mid-hover. The screen-space check keeps the row "hot" until the cursor genuinely leaves the row's outer bounds.
- **The resume icon is always present in the row component but silently no-ops for producers that can't be resumed.** The row does not conditionally hide the resume icon based on producer; it renders for all rows but the click handler returns immediately unless the row's source passes the shared "can resume this source" predicate (currently `claude` or `codex` only). This keeps the row layout consistent across producers. A prior version of this spec described this as Claude-only; the underlying mechanism was broadened to also cover Codex, with the same construction-time-always-renders / click-time-gated shape.
- **Selection state is optimistically updated in the row before the background write completes.** The row's strikethrough and toggle icon update immediately on the click; the commit-selection store write happens asynchronously. A rapid re-read before the write flushes could observe a stale value, but the next full refresh (triggered by any other event) will re-read from the store and produce a consistent display.
- **The row-cap and "Show N more" expand are per-panel-instance, not per-session.** The expanded flag is initialized to false on construction and set to true by the "Show N more" click. Subsequent aggregator-driven refreshes use the current value of the flag (so an expanded view stays expanded as new conversations arrive), but the flag resets when the panel is disposed and re-created.
- **Tab reuse depends on the virtual file's equality being `(producer, session identifier)`, not on the tab name.** A subsequent refresh that resolves a different display title for the same session will re-open the same tab (with the same title-frozen-at-first-open) rather than opening a new one. The tab's title therefore reflects the title at first-open, not the current title; closing and re-opening from the panel picks up the new title.
- **Every refresh allocates fresh row components.** There is no in-place row update. Hover state and any cached row geometry are reset on every refresh. Selection state is re-read from the store. The panel does not animate the diff between two snapshots.
- **The warning banner is global, not per-producer.** It surfaces only the fact that the failed-source list is non-empty; the user has to consult the producer's own diagnostics (e.g., the producer's discovery error in the IDE log) to know which producer failed.
- **An empty `items` list with a non-empty `failedSources` list shows both the warning banner and the empty-state label.** This distinguishes "nothing active right now" from "everything failed to load", which would otherwise look identical to the user.
- **The row's `maximumSize` clamps the row's height to its preferred height.** Without this, the box layout would stretch a single row to fill the panel when there are very few rows. The clamp is part of the row's own self-sizing contract.
- **The panel has no internal scroll bar.** The parent section (Current Memory) provides a single shared scroll bar spanning this panel and its sibling panels. The panel's content is placed in a `NORTH` slot so it reports its natural height to the parent layout rather than growing to fill available space.
- **The empty-state label is centered horizontally but not vertically.** It sits at the top of the panel (just below the warning banner if visible) because the empty-state label is added as the only child of a vertical-box-layout container. The label does not center vertically.
- **The refresh action is wired through a public refresh method on the panel.** The action looks up the panel via a project-scoped registry (the tool window's "panel registry" object the project service holds) and calls the method. The panel itself does not register the action; it only exposes the method.
- **The save-side callback on the editor tab is installed per open call, not once at panel construction.** A new callback closure (bound to this panel's `refresh`) is installed every time the row is clicked. If the editor tab was already open when the click happens (tab reuse), the new callback overwrites the previous one. There is no callback chain.
- **The panel does not propagate disposal to the editor tabs it opened.** Closing the tool window or disposing the panel does not close any editor tabs that the panel previously opened. Those tabs are owned by the IDE's editor manager and persist independently.

## Shared Behavior

- **Active session aggregator** — owns the cross-producer fan-out, the recency window, the title cascade, the unread-slice message-count filter, the dedup-by-composite-key rule, the per-row `isEdited` and `isSelected` flags, the sort order, the partial-result envelope, the per-loader and per-row failure isolation, and the producer enumeration. This panel does not re-implement any of it: it invokes **that** aggregator over a delegated round-trip and consumes the envelope. The producer enumeration is mirrored on this surface only as a deserialization target, and that mirror must stay in lockstep.
- **Commit-selection store** — owns the persistence format for per-conversation exclusion flags. This panel reads the stored exclusions at load time to initialize each row's selection state, and writes back via the selection-toggle and select-all/deselect-all actions.
- **Pin store** — owns the persistence format for pinned items. This panel only calls the pin entry point; the pinned panel renders the result.
- **Terminal utilities module** — owns the shared "can resume this source" predicate, the mechanism for opening or locating a terminal tab, and choosing/sending the source-appropriate resume command (Claude or Codex today). This panel only calls the entry point with session metadata, now including the row's source (see spec 212).
- **Conversation editor tab** — owns the editor surface that opens on row click, including its header, message rows, edit/delete affordances, save semantics, and identity-based overlay rules. This panel only opens the tab and installs a save-side callback.
- **Conversation virtual file** — owns the IDE-level virtual-file class, its equality contract (`(producer, session identifier)`), its name format, and its writability flag. This panel only constructs it.
- **Conversation editor provider** — owns the IDE registration that ties the virtual-file class to the editor tab, including the editor type identifier and the "hide default editor" policy. This panel does not interact with the provider directly.
- **Project status listener channel** — owned by the project service; this panel only subscribes and unsubscribes.
- **Current Memory section / tool-window accordion frame** — owns the section header, collapse/expand state, resize bar, gear-menu visibility toggle, single shared scroll bar, and per-section action group anchor (here, `JolliMemory.ConversationsActions`). This panel is the body that sits inside the frame.
- **`JolliMemory.ConversationsActions` action group** — owns the "refresh" action registration in the IDE's action system. This panel exposes the refresh method the action invokes via a project-scoped panel registry.
