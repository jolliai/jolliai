# 118. IntelliJ Tool Window Layout

## Topic Statement

A single tool window in the IDE whose content is chosen by a stack of nested card switches — two hard pre-gates, then a three-way route between an onboarding card, a dedicated **disabled** card and the main card, then a two-way route between the normal sidebar and a full-pane **status overlay**, then a three-way route between the accordion, the Memory Bank explorer and a Knowledge placeholder — where the accordion itself is a view switch, a breadcrumb, a vertical stack of three named collapsible sections sharing one scroll bar, and a fixed bottom action bar, with a **two-icon** title-bar strip and per-section show/hide toggles in the gear menu.

## Scope

**In scope:**

- The two hard pre-gates ahead of every card: the absent-repository placeholder and the absent-runtime blocking panel.
- The three-way root route (onboarding / disabled / main), its exact predicate, and the state that predicate does not cover.
- The status **overlay**: that it is a card above the entire normal layout rather than a section, what toggles it, and the continuous synchronisation rule that shows, hides and collapses it.
- The two-icon title-bar strip, and the health-coloured toggle icon.
- The view switch (Current Branch / Memory Bank / Knowledge), which segment is reachable, and the breadcrumb modes it drives.
- The accordion's fixed contents and order, the single-scrollbar stacking model, header anatomy, and the click-to-toggle gesture.
- Per-section persistence of two independent flags, and the gear menu that exposes one of them.
- The cold-start card that renders above the stack without being one of the sections.
- The behaviour surface when the repository disappears mid-session.
- The foreign-memory mode the breadcrumb can enter.
- Which registered action groups are wired to a header, which are registered but reach nothing, and which action classes are registered nowhere and therefore unreachable.

**Out of scope:**

- The contents of the three sections — each owns its own spec.
- The status overlay's header actions and row list — spec 133.
- What the disable and enable gestures actually do, the cached verdict they flip, and the roll-backs — spec 332.
- The onboarding card's internal layout, the disabled card's internal layout (it is a stateless label-and-button panel; all sequencing lives in the frame), and the Settings dialog.
- The Memory Bank explorer body and the runtime-detection subsystem behind the absent-runtime panel — spec 284.
- The summary and conversation viewers opened by a row click.
- The sign-in flow, which is no longer reachable from this frame at all.

## Data Contracts

### The card stack

Four nested switches, evaluated outermost first:

| Level | Choices | Selected by |
| --- | --- | --- |
| Pre-gate 1 | Absent-repository placeholder, or continue | Whether a repository marker exists under the project base path |
| Pre-gate 2 | Absent-runtime blocking panel, or continue | Whether a verified external runtime is already cached (a non-blocking check, safe on the interface thread) |
| Root | Onboarding / **Disabled** / Main | The predicate below |
| Main | Normal sidebar / **Status overlay** | The title-bar toggle and the synchronisation rule below |
| Content | Accordion / Memory Bank explorer / Knowledge placeholder | The view switch |

### The root predicate

```
disabled AND configured   → the disabled card
configured                → the main card
otherwise                 → the onboarding card
```

*Configured* means any one of: the local-agent provider is selected, an assistant API key is saved, that key's environment variable is set, or a product API key is saved.

Two consequences are load-bearing:

- **The disable verdict wins over being configured, but not over being unconfigured.** A repository the user turned off *and* whose credentials were then all removed renders the **onboarding** card, with nothing anywhere stating that it is opted out.
- A legacy machine-wide "paused" preference is **no longer** one of the configured conditions. It participates only in the startup projection owned by spec 332.

The verdict is seeded once when the content is built and re-read on every status fire; the view is re-routed only when it changed. It is also flipped optimistically by the disabled card's enable button and rolled back on failure — spec 332 owns that lifecycle.

### Title-bar actions — exactly two

| Position | Action | Icon |
| --- | --- | --- |
| 1 | **Settings** — opens the Settings dialog | A static gear |
| 2 | **Status** — a toggle that shows and hides the full-pane status overlay | **Not static**: a health-coloured circle, re-resolved on every action update, computed on the background update thread |

Both are constructed inline; neither is a registered action class.

**The cloud-sync action is gone.** The title bar previously carried a third action whose popup held sign-in, sign-out and manual sync; those three moved into the status overlay (its header carries sign-in/out, and its row list carries manual sync — spec 133), leaving a two-icon strip. **The "agent access" placeholder is gone too**; the unfinished-feature master flag that used to gate it still exists but no longer gates any title-bar action.

### Health status glyph

The status toggle's icon is chosen by a single shared health function, also used by the separate hover indicator so the two always agree:

| Colour | Condition |
| --- | --- |
| Red | No status snapshot, or the repository is not enabled |
| Yellow | Enabled but degraded — any of: no credential for the *selected* provider; a recorded last error; git hooks not fully installed; a detected assistant host whose hook is not installed; a reported scan failure from either of the two embedded-store integrations the function checks; the runtime missing, or present with the integrations not set up |
| Green | Enabled with none of the above |

The credential clause is provider-aware: the assistant provider requires its own key or environment variable, the hosted provider requires the product key, and every other provider setting requires *some* credential.

The integrations clause mirrors the corresponding overlay row and degrades to yellow rather than red. The historical justification for that choice — "memory generation still runs on native in-IDE hooks" — no longer holds, since the installed hooks execute under the external runtime; the colour rule is unchanged, only its justification is stale.

**The scan-failure clause is narrower than the overlay's row set.** The health function checks two integrations' scan failures; the overlay renders failure rows for considerably more. A failure from any integration the health function does not check leaves the glyph green while the overlay shows a warning row. (Notable.)

### The three accordion sections

| Position | Title | Sizing | Initially |
| --- | --- | --- | --- |
| 1 | PINNED | Fits to content height | Expanded |
| 2 | WORKING MEMORY | Sizes to content height | Expanded |
| 3 | COMMITTED MEMORIES | Sizes to content height | Expanded |

Stacked vertically in a width-tracking panel inside a single scroll pane (vertical as needed, horizontal never), with trailing glue. There are no resize bars and no proportional weight redistribution. Titles render uppercase exactly as listed. The first and third headers carry a live row-count suffix that tracks the underlying panel.

### Per-section persisted state

Two independent booleans per section title, persisted across restarts, both defaulting to true: whether the user expanded it (toggled by clicking the header) and whether the user made it visible (toggled from the gear menu). Both are keyed by the section **title string**, so renaming a title orphans its state.

### Header layout

Left to right: a collapse/expand triangle; an optional title icon (only the first section carries one); the bold uppercase title with its optional row-count suffix; and a right-aligned toolbar populated from a per-section action group identifier. The whole strip is opaque and clickable to toggle.

### Action group identifiers

The three section headers, the three sub-section headers folded inside the second section, and two standalone actions are all resolved by registered identifier, which is why the identifiers are part of the contract.

**One registered group reaches nothing.** The status action group and the refresh action inside it are still declared, but the status surface is a hand-rolled overlay with no toolbar, so no header consumes them.

**Five named action classes are reachable from nowhere at all**, alongside an unused sign-in bar component. They appear in neither the plugin manifest nor any programmatic construction, and nothing in the source names them, so no gesture anywhere can invoke them — they are unreachable code, not behaviour. One of the five is a **standalone settings action**: a complete second implementation of the same gesture the title bar's inline gear performs, opening the same dialog by the same route. Nothing distinguishes the two at runtime, because only the inline one exists at runtime. (Re-derived at HEAD: the manifest registers seven action classes by name, one more is constructed directly by the gear menu's per-section toggles, and the remaining five are named nowhere.)

### View switch

A persistent segmented switch above the breadcrumb:

| Segment | Effect |
| --- | --- |
| Current Branch | Accordion card; breadcrumb in branch mode; bottom action bar visible |
| Memory Bank | Explorer card; breadcrumb in repository-filter mode; action bar hidden |
| Knowledge | Placeholder card; breadcrumb in repository-filter mode; action bar hidden |

**The Knowledge segment is not reachable.** Its tab is added only when the unfinished-feature master flag is on, which it is not in shipped builds; the segment and its handler remain so that re-enabling is a flag flip. Its content card is therefore dead in shipped builds.

The active segment is bold with an accent underline; inactive segments are muted and highlight on hover.

### Cold-start card

A bare bordered card can render **above** the first section, at the very top of the stack. It is deliberately not one of the three sections: no header triangle, no persisted flags, no gear-menu entry. Its visibility is driven by the project service's cold-start signal and a repository-wide dismiss marker. It is constructed defensively — a construction failure omits it entirely rather than failing the content. Full internals are owned by spec 260.

## Behavior

### Initial render

The frame checks for a repository marker under the project base path. If absent, a single placeholder body is shown instructing the user to initialise a repository or enable version-control integration, and the frame subscribes to the project's version-control-configuration channel so the content is rebuilt the moment the marker appears.

Otherwise the runtime gate runs: a cached verified runtime lets the full content build; otherwise a blocking panel is shown instead. That panel re-probes in the background without forcing (so a probe already running in the startup activity is shared) and swaps itself out for the full content once a runtime is found; its retry control forces a fresh probe and completes the startup sequence the gate skipped. Nothing else of the frame is reachable behind it, and the project service's own initialisation is gated on the same check.

Full content then builds the sections, the view switch, the breadcrumb, the action bar, the title-bar actions and the gear menu, subscribes for repository-removal detection, seeds the disable verdict, routes the root card, and runs the status synchronisation once.

### Click-to-toggle

A single click anywhere on a section header flips that section's expanded flag and persists it. The triangle updates, the body is added or removed, and both the section and the stack are revalidated so the single scroll re-measures. A collapsed section shrinks to header height.

### Single-scroll stacking

The sections live in a width-tracking panel inside one scroll pane, which tracks the viewport width so long rows never produce a horizontal scrollbar. Shorter-than-viewport content is absorbed by trailing glue with no scrollbar; taller content keeps its natural height and one vertical scrollbar covers the whole stack. The third section's own meter and list render at natural height with no inner scrollbar, so they participate in the outer scroll.

### The status overlay

It is a card **above the entire normal sidebar layout**, so showing it hides the view switch, the breadcrumb, the accordion and the action bar together. It is not a section and it is not the disabled card.

Because it is constructed before the switch that drives it exists, the toggle is wired to a forward-declared placeholder and the real implementation is pushed through once, so the toggle's own state cannot desynchronise from the card actually shown.

**The synchronisation rule**, run on construction and on every status fire:

```
if the disable verdict is set:
      collapse the overlay if it is showing, and RETURN
if the repository is not enabled:
      force the overlay shown
else if the overlay is showing:
      dismiss it back to the normal layout
```

The first branch is deliberately **not** a plain early return. The card holding the overlay survives underneath the disabled card, so an overlay left open would still be open when the user clicks Enable — and the click would land back on the status page instead of the sidebar. This branch is what covers every route into the disabled state the frame did not itself initiate: a disable typed in a terminal, one performed in another window, or the Settings dialog auto-disabling after the last credential is removed. The frame's own disable gesture collapses the overlay inline, without waiting for the asynchronous refresh (spec 332).

Selecting any view-switch segment also collapses the overlay first — through the same setter the toggle uses, rather than by flipping a raw flag, so the toggle button cannot desynchronise.

### Branch and breadcrumb updates

The breadcrumb's current branch is refreshed from three detection paths: the IDE's repository-change event, the version-control-configuration channel (which catches branch operations performed in a terminal), and the service's status listener.

### Loss of the repository mid-session

The frame subscribes both to the version-control-configuration channel and to the service's status listener. If either fires while the repository marker has been removed from disk — detected by absence, or by the service flagging removal — the whole content is torn down and the placeholder is shown. Re-creating the marker rebuilds the content by the same path as the initial render. The teardown is guarded so it fires at most once per content lifetime.

### Foreign-memory mode

When the breadcrumb selects a foreign repository and branch, the second section is hidden, the bottom action bar enters foreign mode, and the third section switches to a read-only view of the foreign memories. Clearing the selection restores the second section's persisted visibility, clears the action bar's foreign mode, and returns the third section to workspace mode.

## State Transitions

```
[tool window opened, no repository marker]
  show placeholder; subscribe to the VCS-configuration channel
  marker appears → tear down, run the branch below

[tool window opened, marker present, no cached runtime]
  show the blocking runtime panel; probe in the background
  runtime found → swap in the full content

[tool window opened, marker present, runtime cached]
  build sections, view switch, breadcrumb, action bar, title actions, gear menu
  subscribe for repository removal; seed the disable verdict
  route the root card; run the status synchronisation

[user clicks a section header]      → flip + persist expanded; revalidate
[user toggles a section in the gear menu] → flip + persist visible; re-lay out
[user clicks the Status toggle]     → swap overlay ↔ normal layout

[status listener fires]
  re-read the disable verdict; re-route the root card only if it changed
  run the status synchronisation (collapse-and-return when disabled)
  update the breadcrumb branch

[user selects a view-switch segment]
  collapse the overlay; swap the content card; set breadcrumb mode;
  toggle the action bar; (Memory Bank → load the explorer in the background)

[breadcrumb selects a foreign repository/branch]
  hide WORKING MEMORY; action bar → foreign; COMMITTED MEMORIES → read-only
[breadcrumb clears the selection]
  restore WORKING MEMORY visibility; action bar → workspace; COMMITTED MEMORIES → workspace

[user becomes configured]           → onboarding card → main card
[user signs out with no credentials left] → uninstall + refresh on a pool; → onboarding card
[repository marker removed]         → tear down → placeholder
```

## Notable Behavior

- **A disabled repository routes to a dedicated card, not to the status surface.** The status surface is a user-toggled overlay that is additionally force-shown while the repository is configured but *not installed*. Conflating the two is easy and wrong: they are different cards at different levels of the stack, chosen by different predicates. (Notable; this reverses the previous arrangement, in which a disabled project swapped the status panel in as full content.)
- **The disabled card requires being configured as well as disabled.** Remove every credential from a disabled repository and the frame shows onboarding instead, with no statement anywhere that the repository is opted out. (Surprising; observable gap.)
- **The title bar is a two-icon strip.** The cloud-sync popup that used to carry sign-in, sign-out and manual sync was deleted and its three gestures moved into the status overlay, and the agent-access placeholder was deleted with it. The unfinished-feature flag survives but no longer gates anything in the title bar.
- **The status toggle's icon is health-coloured, not a static glyph**, and its scan-failure clause covers fewer integrations than the overlay's row set does — so a scan failure from an integration outside that clause shows a warning row while the glyph stays green.
- **The overlay's disabled branch collapses rather than returning early, and that is the whole point of it.** The card beneath survives the route to the disabled card, so an overlay left showing would be what the user lands on after clicking Enable.
- **The overlay is collapsed through its setter, never by flipping a flag.** The toggle button's own state is derived from the same setter, so a raw flip would leave the button claiming the overlay is shown while the normal layout is on screen.
- **One registered action group reaches nothing.** The status group and its refresh action are still declared, but the status surface is a hand-rolled overlay with no toolbar.
- **Five named action classes and one panel component are unreachable code.** None is declared in the manifest, none is constructed anywhere, and nothing names them, so no gesture can reach them; they are not behaviour and nothing on this surface changes if they are read as such. **The one worth calling out is a standalone settings action** — a whole second implementation of the title bar's settings gesture, opening the same dialog, that cannot be invoked because nothing registers or constructs it. A reader auditing "how many ways can settings be opened from this frame?" will find two and must count one. (Notable; unreachable.)
- **The Knowledge segment is dead in shipped builds.** Its tab is added only behind the unfinished-feature flag; its content card and handler remain so re-enabling is a one-line change.
- **The section order is fixed.** Users cannot reorder; the gear menu only hides and shows.
- **There are no resize bars and no weight redistribution.** Each section keeps its natural content height and one outer scroll bar covers the whole stack.
- **Persistence keys are the section titles.** Renaming a title orphans its persisted expand and visibility state, so titles are part of the contract.
- **The absent-repository placeholder is reactive.** Initialising a repository from any tool brings the content to life without restarting the IDE, because the placeholder subscribes to the IDE's version-control-configuration channel.
- **The runtime gate is a hard gate, not a warning.** Behind it nothing of the frame is reachable and the project service does not initialise. It self-heals: a tool window opened before the first probe finished swaps itself into the full content when the probe lands.
- **Foreign-memory mode collapses the live-work sections**, so the destructive bottom-action-bar operations cannot apply to memories the user cannot act on.
- **The cold-start card is constructed defensively** and omitted entirely if its construction fails, rather than taking the whole content down with it.
- **The content disposable is hoisted so message-bus connections do not leak.** It is created up front and used both as the content's disposer and as the parent of the branch-update connection; an unparented connection would keep its handler subscribed after a dynamic unload and pin the plugin's classloader.
- **Dynamic-unload cleanup groundwork exists but is inert.** An application-level unload listener would release the plugin's static background resources just before a hot unload, but the manifest declares a restart requirement, so enable / disable / uninstall of the plugin always triggers a full IDE restart and the listener never runs in production. The restart requirement itself is the live behaviour.

## Shared Behavior

- **The three sections** — each owns its own body and toolbar action group; this topic owns only the stacking frame, headers and toggles.
- **The status overlay (133)** — owns the overlay's header actions and its row list; this topic owns where the overlay sits and when it is shown, hidden or collapsed.
- **The enable/disable surface (332)** — owns the disable verdict this topic routes on, the optimistic flips and roll-backs that move it, and what the overlay's disable action does.
- **The onboarding card, the disabled card, the Memory Bank explorer and the Knowledge placeholder** — sibling content cards at their respective levels.
- **The runtime detection subsystem (284)** — owns the probe behind the second pre-gate.
- **The cold-start card (260)** — owns the signal, state machine and dismiss marker behind the card that renders above the stack.
- **The project status listener** — drives the status synchronisation, the root re-route, and the breadcrumb branch update.
- **The bottom action bar and breadcrumb** — anchored here; the breadcrumb's foreign selection drives the section visibility and read-only switches.
