# IntelliJ Tool Window Layout

## Topic Statement

A single tool window in the IDE that, once a Git repository and credentials are present, presents a three-segment view switch (Current Branch / Memory Bank / Knowledge), a repo/branch breadcrumb, a vertical stack of three named collapsible sections — PINNED, WORKING MEMORY, COMMITTED MEMORIES — sharing one scroll bar, and a fixed bottom action bar; carries its window-level controls (agent access, settings, status toggle, cloud sync) in the title bar and per-section show/hide toggles in the gear menu; swaps a full-pane STATUS card in whenever the project is disabled; and falls back to a no-git placeholder or an onboarding card when prerequisites are missing.

## Scope

**In scope:**
- The top-to-bottom order of the Current-Branch view: view switch, breadcrumb, the three collapsible sections in a single shared scroll, and the bottom action bar.
- The fixed order of the three sections (PINNED, WORKING MEMORY, COMMITTED MEMORIES) and the single-scrollbar stacking model that replaced the per-section resize bars.
- The header anatomy (collapse arrow, section title with optional live row-count suffix, action toolbar) and the click-to-toggle gesture.
- The "click anywhere on the header" expand/collapse rule.
- The vertical-space model: each section sizes to its own content height; one outer scroll bar spans the whole stack; trailing glue absorbs slack when the content is short. The PINNED section additionally fits-to-content.
- Per-section persistence of two independent flags: the user's expand/collapse choice and the user's show/hide choice (the latter exposed through the tool window's gear menu).
- The full-pane STATUS card and its continuous auto-show rule, which tracks the project's enabled flag rather than firing once.
- The title-bar action group (agent access, settings, status toggle, cloud sync).
- The view-switch behavior surface (Current Branch / Memory Bank / Knowledge) and the breadcrumb-mode changes it drives.
- The behavior surface when no git repository is detected and when a repository disappears mid-session.
- The behavior surface when the user has neither signed in, saved an API key, set a Jolli API key, set the Anthropic env key, nor paused — the whole main view is replaced by an onboarding card at this layer.
- The foreign-memory mode the breadcrumb can enter, which hides the WORKING MEMORY section and switches the COMMITTED MEMORIES section to read-only.

**Out of scope:**
- The contents of the three sections (PINNED, WORKING MEMORY, COMMITTED MEMORIES) — each owns its own spec; COMMITTED MEMORIES is the commits panel (separate spec).
- The Memory Bank and Knowledge view bodies — the Knowledge view is a "coming soon" placeholder at this layer; Memory Bank's explorer is its own concern.
- The onboarding card's internal layout — its own spec.
- The Settings dialog the gear/settings action opens — its own spec.
- The summary / conversation viewers that open when a row is clicked — their own specs.
- The cloud-sync action's sign-in / sign-out flow — specified as part of the broader auth surface.

## Data Contracts

### The three top-level sections

The Current-Branch view always contains exactly these three sections, in this order:

| Position | Section title       | Sizing                       | Initial expanded |
| -------- | ------------------- | ---------------------------- | ---------------- |
| 1        | PINNED              | Fits to content height       | Expanded         |
| 2        | WORKING MEMORY      | Sizes to content height      | Expanded         |
| 3        | COMMITTED MEMORIES  | Sizes to content height      | Expanded         |

The three are stacked vertically in a width-tracking panel inside a single scroll pane (vertical-as-needed, horizontal never), with trailing vertical glue. There are no resize bars between sections, and no proportional weight redistribution — each section keeps its natural height. Section titles render uppercase exactly as listed.

The PINNED and COMMITTED MEMORIES headers carry a live `(N)` row-count suffix; the count updates as the underlying panel's row count changes.

### Per-section persisted state

Two independent boolean flags per section title, persisted across IDE restarts:

| Flag        | Trigger                                                                 | Default |
| ----------- | ----------------------------------------------------------------------- | ------- |
| `expanded`  | The user clicked the section header to collapse or expand.             | `true`  |
| `visible`   | The user toggled the section in the tool window's gear menu.            | `true`  |

Both flags are keyed by the section title string.

### Header layout contract

Each section header shows, left to right:

1. A collapse/expand triangle (right-pointing when collapsed, down-pointing when expanded).
2. An optional title icon (only the PINNED section carries one — a pin glyph shown before its title).
3. The bold uppercase section title, optionally followed by a live `(N)` row-count.
4. The right-aligned action toolbar populated from a per-section action group identifier.

The header strip is opaque and fully clickable to toggle.

### Section-specific action group identifiers

| Section title       | Action group identifier              |
| ------------------- | ------------------------------------ |
| PINNED              | `JolliMemory.PinnedActions`          |
| WORKING MEMORY      | `JolliMemory.CurrentMemoryActions`   |
| COMMITTED MEMORIES  | `JolliMemory.CommitsActions`         |

These names are part of the contract because external action contributions key off them. (Action groups `JolliMemory.StatusActions`, `JolliMemory.PlansActions`, `JolliMemory.ChangesActions`, and `JolliMemory.ConversationsActions` remain registered; the latter three are consumed by sub-sections folded inside WORKING MEMORY, and the STATUS group is registered but no longer wired into any header.)

### View switch

A persistent three-segment switch above the breadcrumb:

| Segment         | Effect                                                                                  |
| --------------- | --------------------------------------------------------------------------------------- |
| Current Branch  | Shows the accordion card; breadcrumb in branch mode; the bottom action bar is visible.  |
| Memory Bank     | Shows the Memory Bank explorer card; breadcrumb in repo-filter mode; action bar hidden. |
| Knowledge       | Shows the Knowledge "coming soon" placeholder card; breadcrumb in repo-filter mode; action bar hidden. |

The active segment is bold with an accent underline; inactive segments are muted and highlight on hover. Selecting a segment also clears the full-pane status card if it was showing.

### Title-bar actions

The tool window title bar carries the following actions, in order:

1. **Agent Access** — opens an informational "coming soon" message. **Gated behind the unfinished-feature flag**: the action object is still defined, but it is added to the title bar only when that master flag is on, which it is not in shipped builds. So the shipped title bar does **not** carry it (re-enabling is a one-line flag flip).
2. **Settings** — opens the Settings dialog.
3. **Status** — a toggle action that shows / hides the full-pane STATUS card over the current content. **Its icon is not a static glyph**: it reflects overall health as a green / yellow / red status circle (see Health status glyph below), recomputed on the background update thread.
4. **Cloud sync** — opens the sign-in / sign-out popup; its icon reflects the current auth state.

So the shipped title bar carries three actions (Settings, Status, Cloud sync); Agent Access appears only when the unfinished-feature flag is enabled.

### Health status glyph

The title-bar Status toggle's icon is a colored circle chosen by a single shared health function (also used by the separate hover status-indicator, so the two always agree):

| Color  | Condition |
| ------ | --------- |
| Red    | No status snapshot, or the project is not enabled. |
| Yellow | Enabled but degraded — any of: no LLM credential for the selected provider; a recorded last-error; git hooks not fully installed; a detected Claude/Gemini host whose hook is not installed; an OpenCode or Cursor scan error; **Node missing, or present but the bundled-tool MCP/skills integrations not set up**. |
| Green  | Enabled with none of the above. |

The integration clause mirrors the STATUS panel's "MCP & Skills" row (spec 133) and degrades the glyph to yellow rather than red. Note the historical rationale for choosing yellow — "memory generation still runs on native hooks" — no longer holds: the installed hooks execute under the resolved external runtime too, so a missing runtime is not in fact non-blocking. The colour rule is unchanged; only its justification is stale.

### Hover status popup — hooks line

The hover status indicator renders a small HTML summary whose hooks line is a `+`-joined list of the installed hook families, in the same form the STATUS panel's Hooks row uses: `5 Git + 2 Claude + 1 Gemini CLI` when all three families are present, `5 Git` when only the git hooks are, and `none installed` when none are. The bullet beside it is green when the git-hook flag is set and red otherwise. The count in `5 Git` is part of the literal string, not a computed number, and the git-hook flag it keys off is computed from only four of the five installed git hooks (see spec 133) — so a repository missing the push-time hook still shows a green bullet and `5 Git`.

### Gear menu

The tool window's additional-gear menu carries one show/hide toggle action per top-level section (PINNED, WORKING MEMORY, COMMITTED MEMORIES), in stack order. Each toggle flips that section's persisted `visible` flag and re-lays out the stack.

### Cold-start back-fill card

A bare bordered card can render **above** the PINNED section, at the very top of the accordion stack. It is deliberately **not** one of the three top-level sections: it carries no header triangle, no persisted `expanded`/`visible` flags, and no entry in the gear menu's show/hide list above. Its visibility is driven entirely by the project service's cold-start signal (and a repo-wide dismiss marker), not by any user-persisted toggle. Full internals — the signal, the card's own state machine, the dismiss marker, and the shared background runner — are owned by **IntelliJ Cold-start Back-fill Card** (spec 260).

### Full-pane STATUS card

The STATUS panel is registered as its own content card (not as a collapsible section). The Status title-bar toggle swaps it over the accordion; an auto-show rule swaps it in whenever the project is disabled.

### Foreign-memory mode

When the breadcrumb selects a foreign repo + branch, the WORKING MEMORY section is hidden, the bottom action bar enters foreign mode, and the COMMITTED MEMORIES section switches to a read-only view of the foreign memories. Clearing the selection restores the WORKING MEMORY section's persisted visibility, clears the action bar's foreign mode, and returns COMMITTED MEMORIES to workspace mode.

## Behavior

### Initial render

On tool window open the host first checks for a `.git` directory inside the project's base path. If absent, a single placeholder body is shown with a static message instructing the user to run `git init` or enable VCS integration; the host subscribes to a project-level VCS-configuration-change channel and rebuilds the full content the moment a `.git` directory appears.

When `.git` is present, the host resets the service if it is recovering from a prior `.git` removal, initializes the service if needed, then builds the full content. The full content is wrapped in an onboarding-vs-main card: the main card is shown only when the user is "configured" — signed in, OR a saved Anthropic API key, OR the `ANTHROPIC_API_KEY` environment variable, OR a saved Jolli API key, OR a `paused` config flag. Otherwise the onboarding card is shown. The split is re-evaluated on every status change and on every auth change.

### Click-to-toggle

A single click anywhere on a section header flips the section's `expanded` flag. The triangle icon updates immediately. The contained body is added to or removed from the section, and both the section and its parent stack are revalidated so the single scroll re-measures. A collapsed section shrinks to header height.

The flag is persisted per section title at the moment of toggle.

### Single-scroll stacking

The three sections live in a width-tracking content panel inside one scroll pane. The content panel tracks the viewport width (so long rows never trigger a horizontal scrollbar). When the combined content is shorter than the viewport it fills the height (trailing glue absorbs slack, no scrollbar); when taller it keeps its natural height and the single vertical scrollbar covers the whole stack. The COMMITTED MEMORIES section's own token-meter + list render at natural height with no inner scrollbar, so they participate in this single outer scroll.

### Status full-pane toggle and auto-show

The Status title-bar toggle calls the show-status function, which swaps between the STATUS card and the accordion card.

A continuous auto-show rule runs on construction and on every status-listener fire: if the project is **not** enabled, the STATUS card is forced shown; if the project **is** enabled and the status card is currently shown, it is dismissed back to the accordion. (When enabled, the dismissal only fires if the status card was the one showing — it does not disturb the Memory Bank / Knowledge views.) This means the STATUS card appears the moment the project becomes disabled and disappears the moment it is re-enabled.

### View switching

Selecting a view-switch segment swaps the content card, sets the breadcrumb mode, toggles the bottom action bar's visibility, and (for Memory Bank) kicks off a background load of the explorer. Switching any view first clears the full-pane status state.

### Branch / breadcrumb updates

The breadcrumb's current branch is updated from three detection paths: the IDE git-repository-change event, the VCS-configuration-change channel (catching terminal branch operations), and the service's status listener.

### Loss of `.git` mid-session

The host subscribes both to the VCS-configuration channel and to the service's own status listener. If either fires while a `.git` directory has been removed from disk (detected by absence on disk, or by the service flagging git as removed), the entire content is torn down and the no-git placeholder is shown. Re-creating `.git` rebuilds the content via the same path as the initial render. The git-removal switch is guarded so it fires at most once per content lifetime.

### Onboarding ↔ main

When the user is not configured, the onboarding card is shown. Saving an API key (or any of the configured-credential conditions becoming true) flips to the main card. On sign-out, if no other credentials remain, the service is uninstalled and status refreshed on a background pool; the view re-syncs to onboarding.

## State Transitions

```
[tool window opened, no .git]
  show no-git placeholder
  subscribe(VCS_CONFIGURATION_CHANGED)
  on .git appears → tear down placeholder, run [tool window opened, .git present]

[tool window opened, .git present]
  reset service if recovering from .git removal; initialize if needed
  build sections, view switch, breadcrumb, action bar, title-bar actions, gear menu
  subscribe(VCS_CONFIGURATION_CHANGED) + service status listener for .git removal
  if not configured → show onboarding card; else → show main card
  syncStatusCard()  // auto-show STATUS when disabled

[user clicks header on section S]
  S.expanded ← !S.expanded; persist
  revalidate section + stack

[user toggles section S in gear menu]
  S.visible ← !S.visible; persist
  re-layout stack

[user clicks Status title-bar toggle]
  swap STATUS card ↔ accordion card

[status listener fires]
  syncStatusCard(): if !enabled → show STATUS; else if status shown → show accordion
  re-evaluate onboarding-vs-main
  update breadcrumb branch

[user selects a view-switch segment]
  clear status-shown
  swap content card; set breadcrumb mode; toggle action bar; (Memory Bank → load explorer)

[breadcrumb selects a foreign repo/branch]
  hide WORKING MEMORY; action bar → foreign; COMMITTED MEMORIES → read-only foreign

[breadcrumb clears foreign selection]
  restore WORKING MEMORY visibility; action bar → workspace; COMMITTED MEMORIES → workspace

[user signs in or becomes configured]
  flip onboarding card → main card

[user signs out, no credentials remain]
  uninstall + refresh status (background); flip main card → onboarding card

[.git is removed]
  tear down content → show no-git placeholder
```

## Notable Behavior

- **The section order is fixed.** Users cannot reorder; the gear menu only hides/shows.
- **There are no resize bars and no weight redistribution.** The earlier five-section drag-to-resize accordion was replaced by a single shared scroll bar; each section keeps its natural content height and the outer scroll covers the whole stack.
- **The STATUS section is no longer one of the stacked sections.** It is a full-pane card swapped in by the title-bar Status toggle and by the continuous auto-show-when-disabled rule.
- **The auto-show-when-disabled rule is continuous, not one-shot.** Shown when disabled; dismissed when enabled (only if it was the visible card). It re-fires on every status change.
- **Section headers carry a live row count.** PINNED and COMMITTED MEMORIES show `(N)`; the suffix tracks the underlying panel's row count.
- **The configured-vs-onboarding split is at this layer.** When the user lacks every credential path (sign-in / Anthropic key / Anthropic env / Jolli key / paused), the whole main view is hidden behind the onboarding card.
- **The no-git placeholder is reactive.** Running `git init` from any tool brings the content to life without restarting the IDE, because the placeholder subscribes to the IDE's VCS-configuration channel.
- **Persistence keys are keyed by section title.** Renaming a section title would orphan its persisted expand / visible state — section titles are part of the contract.
- **Foreign-memory mode collapses the live-work sections.** Browsing another repo/branch's memories hides WORKING MEMORY and makes COMMITTED MEMORIES read-only, so the destructive bottom-action-bar operations don't apply to memories the user can't act on.
- **The five-section accordion frame from the prior design is gone.** The legacy STATUS/MEMORIES/PLANS & NOTES/CHANGES/COMMITTS accordion, its resize-bar drag model, its STATUS auto-visibility flag, and the MEMORIES-header status-indicator dot are no longer wired into the tool window.
- **The title-bar Status glyph is health-colored, not static.** It renders a green/yellow/red circle from a shared health function (also driving the hover status indicator), recomputed on the background update thread, factoring credentials, last-error, git/Claude/Gemini hook states, OpenCode/Cursor scan errors, and the bundled-tool integration availability/active state. See the Health status glyph contract.
- **Agent Access is gated off in shipped builds.** It lives behind the master unfinished-feature flag; the action object stays defined but is not added to the shipped title bar, so re-enabling is a single flag flip.
- **The tool-window content disposable is hoisted so message-bus connections don't leak.** The content-level disposable is created up front and used both as the content's disposer and as the parent of the branch-update message-bus connection. A message-bus connection created with no parent disposable would keep its plugin-class handler subscribed after a dynamic unload and pin the plugin classloader; parenting it to the real content disposable ensures it is torn down with the content.
- **Dynamic-unload cleanup groundwork exists but is INERT in production (prepared, not live).** An app-level unload listener is registered that, just before a dynamic plugin unload, would release the plugin's static-singleton background resources (auth service, telemetry, log writer) so they don't pin the classloader. However, the plugin manifest declares **require-restart**, so enabling / disabling / uninstalling the plugin always triggers a full IDE restart rather than a hot dynamic unload — and the unload listener therefore never runs in production. It is documented here as prepared-but-not-live groundwork (kept because a future coroutine/lifecycle refactor could make hot-unload clean), explicitly **not** an active code path today. The restart requirement itself is the current, live behavior: enable/disable/uninstall = one clean full reload.

## Shared Behavior

- **PINNED, WORKING MEMORY, COMMITTED MEMORIES sections** — each owns its own body and toolbar action group; this topic owns only their stacking frame, headers, and toggles.
- **STATUS panel** — owns the full-pane card body; this topic owns when it is shown / hidden.
- **Onboarding card** — sibling at this layer, shown when the user is not configured.
- **No-git placeholder** — sibling at this layer, shown when no `.git` directory is present.
- **Memory Bank / Knowledge cards** — sibling content cards selected by the view switch.
- **Project status listener** — drives the status-card auto-show, the onboarding re-sync, and the breadcrumb branch update.
- **Tool window gear menu / title-bar actions** — anchored here; carry the per-section visibility toggles and the agent-access / settings / status / cloud-sync actions.
- **Bottom action bar / breadcrumb** — anchored here; the breadcrumb's foreign-mode selection drives the section visibility and read-only switches.
