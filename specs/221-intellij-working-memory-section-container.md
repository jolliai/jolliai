# 221. IntelliJ WORKING MEMORY Section Container

## Topic Statement

The WORKING MEMORY section body of the tool window — a vertical container that stacks a one-line consequence message, an AI-summary status row, and three labelled input sub-sections (Conversations, Context, Files) each with its own toolbar header and separated by colored dividers, then a bottom row with a primary Commit button and a secondary Review button, reporting its natural height so it shares the sidebar's single scroll bar.

## Scope

**In scope:**

- The top-to-bottom composition: consequence line, status row, the three sub-sections in fixed order (Conversations → Context → Files) each preceded by a header, dividers between sub-sections, then the Commit/Review button row.
- The header it wraps around each injected sub-section body: a bold uppercase title with a live `(N)` count suffix, plus a right-aligned action toolbar built from a per-sub-section action group id.
- The live count wiring: when an injected body advertises a row count, the header subscribes and updates its `(N)` suffix.
- The colored divider drawn between Conversations/Context and Context/Files (none after Files).
- The consequence line text, computed from the number of changed files.
- The AI-summary status row, computed from worker-busy and last-error state, hidden when neither applies.
- The Commit button: runs the same AI-commit action the sidebar's commit path uses.
- The Review button: opens the Working Memory web view editor tab.
- The status listener subscription that refreshes the consequence + status lines on every project-status change, and its teardown on disposal.
- The natural-height sizing model (no internal scroll bar).

**Out of scope (boundaries):**

- The three injected sub-section bodies themselves — the Conversations body is the active-conversations panel (its own spec); the Context body is the plans-and-notes panel (its own spec); the Files body is the changes panel (its own spec). This container only wraps them with a header + toolbar + divider and stacks them. The per-row strikethrough select toggle, capping, "Show N more", and row actions live in those body specs.
- The AI-commit action's pipeline (staging, message generation, memory write) — its own spec; this container only invokes the action.
- The Working Memory web view editor tab opened by Review — its own spec; this container only constructs the web-view virtual file and opens it.
- The action-group registration for each sub-section toolbar — owned by the IDE action system; this container only resolves a group by id and builds a toolbar from it.
- The section frame around this body (collapse arrow, the section's own title `WORKING MEMORY`, count, gear-menu visibility, shared scroll bar) — owned by the tool-window layout spec.
- The changed-files list and the worker-busy / last-error state — owned by the project service and the changes panel; this container only reads them to format two lines of text.

## Data Contracts

### Inputs (injected at construction)

The container is constructed with three sub-section bodies and their action-group ids, plus the project handle and the project service:

| Injected pair | Body | Action-group id used for the header toolbar |
| --- | --- | --- |
| Conversations | the active-conversations panel | the conversations action group |
| Context | the plans-and-notes panel | the plans action group |
| Files | the changes panel | the changes action group |

The container does not know the internals of these bodies; it only stacks them and, if a body advertises a row count, wires the count into the header.

### Sub-section header

Each header shows, left to right:

1. A bold uppercase title (`CONVERSATIONS`, `CONTEXT`, `FILES`).
2. A live `(N)` suffix appended to the title whenever the injected body advertises a row count (initial value read at build time, then updated on change).
3. A right-aligned, horizontally-oriented action toolbar built from the sub-section's action-group id, targeting the injected body. If the resolved action is not a group, no toolbar is added.

The header height is clamped to its preferred height after children are added.

### Divider

A thin (≈2px) opaque horizontal bar in a light-blue color (theme-aware: pale blue in light, dark slate-blue in dark) is inserted after Conversations and after Context, but not after Files.

### Consequence line

A single label whose text is computed from the count of changed files:

| Condition | Text |
| --- | --- |
| changed files > 0 | `Commit Memory will commit <N> changed file(s) with an AI-written message.` |
| changed files == 0 | `No changes staged — nothing will be committed yet.` |

The changed-files count is read preferentially from the changes panel's current file list; if that is unavailable it falls back to the service's changed-files query.

### Status row

A single label with an icon, shown only when one of two states applies (busy takes precedence over error):

| State (in priority order) | Icon | Text | Visible |
| --- | --- | --- | --- |
| The queue worker is busy for the current repo | a step/progress icon | `Summarizing the last commit…` | yes |
| Otherwise, the service reports a last error | a warning icon | `Summary failed — open Status for details.` | yes |
| Otherwise | — | — | no (hidden) |

Worker-busy is determined per-repo from the main repo root; when the main repo root is null, busy is treated as false.

### Commit / Review button row

A bottom row containing:

- A **Commit** primary button (filling the row width, with a sparkle icon) whose tooltip explains it commits the checked files with an AI-written message and saves a memory. Clicking it resolves and executes the AI-commit action.
- A **Review** secondary button (eye icon) on the right, tooltip explaining it reviews the current memory's included items before committing. Clicking it opens the Working Memory web view editor tab.

### Sizing contract

The container reports its maximum height as its preferred height; it owns no scroll bar and participates in the section's single shared scroll bar.

## Behavior

### Construction

1. Use a vertical stacking layout.
2. Add the consequence label, then the status label (both left-aligned).
3. Add the Conversations header + body, then a divider.
4. Add the Context header + body, then a divider.
5. Add the Files header + body (no trailing divider).
6. Add the Commit/Review button row.
7. Compute the initial consequence + status lines.
8. Subscribe to the project-status listener; each fire recomputes the consequence + status lines on the UI thread.

### Header build (per sub-section)

1. Create the bold title label.
2. If the injected body advertises a row count, set the initial `(N)` suffix and register a change callback that updates the suffix on the UI thread.
3. Resolve the action-group id; if it resolves to a group, build a horizontal toolbar from it (targeting the body, not reserving auto-popup space, transparent) and place it at the header's east edge.
4. Clamp the header's max height to its preferred height.

### Consequence + status refresh

Invoked on construction and on every status-listener fire:

1. Compute the changed-file count (changes-panel list size, else service query size).
2. Set the consequence text accordingly.
3. Compute busy (worker busy for the main repo root) and last-error.
4. If busy → show the busy status row; else if last-error present → show the error status row; else hide the status row.

### Commit

Resolve the AI-commit action by id; if absent, do nothing. Otherwise execute it through the action system using this button's component as context.

### Review

Construct the Working Memory web view virtual file and hand it to the IDE's open-file mechanism with focus (which reuses the single existing Working Memory tab if already open).

### Disposal

Remove the project-status listener.

## State Transitions

```
[constructed]
  stack: consequence, status, CONVERSATIONS+body, divider,
         CONTEXT+body, divider, FILES+body, commit/review row
  for each body advertising a count → header (N) subscribes
  updateHeader()  // consequence + status
  service.addStatusListener(refresh)

[status listener fires]
  on UI: updateHeader()
    files ← changesPanel.files.size ?? service.changedFiles.size
    consequence ← (files>0) ? "...commit <files>..." : "No changes staged..."
    busy ← mainRepoRoot != null && worker busy
    if busy → status = "Summarizing the last commit…" (visible)
    elif lastError != null → status = "Summary failed…" (visible)
    else → status hidden

[Commit clicked]
  action ← lookup AI-commit ; if null → no-op ; else execute via action system

[Review clicked]
  open Working-Memory web-view virtual file as editor tab (reuse if open)

[body row count changes]
  header title ← "<TITLE> (N)"

[disposed]
  service.removeStatusListener(refresh)
```

## Notable Behavior

- **The Context sub-section body is the plans-and-notes panel, and the Files sub-section body is the changes panel.** The labels `CONTEXT` / `FILES` are this container's wrapping; the row content, the per-row strikethrough ✕/＋ select toggle, capping, and row actions belong to those body specs, not here.
- **The three sub-sections are no longer top-level sections.** They were folded inside WORKING MEMORY in the redesign; each keeps its own action toolbar (resolved by id) but is now a labelled strip within this container.
- **The header count suffix is live and pulled, not pushed by this container.** This container subscribes to whatever count an injected body advertises; a body that advertises no count gets a plain title with no `(N)`.
- **The status row hides itself when idle.** It only appears for worker-busy or last-error; otherwise it consumes no visible space.
- **Worker-busy is gated on a resolved main repo root.** With no main repo root, busy is false regardless of any worker activity elsewhere.
- **Commit and the web view's Commit Memory button run the same action.** This container's Commit button and the Review-opened web view both invoke the one AI-commit action; the only difference is the data context each supplies.
- **The container reports natural height and owns no scroll bar.** It contributes its full stacked height to the section's single shared scroll bar.
- **Dividers are theme-aware light-blue and appear only between sub-sections.** There is no divider above Conversations or below Files.

## Shared Behavior

- **Active-conversations panel** — the Conversations sub-section body; its own spec.
- **Plans-and-notes panel** — the Context sub-section body; its own spec.
- **Changes panel** — the Files sub-section body; its own spec, and the source of the changed-files count.
- **AI-commit action** — invoked by the Commit button; its own spec.
- **Working Memory web view editor tab** — opened by the Review button; its own spec.
- **Project service** — provides the status listener, the main repo root, the worker-busy query, the last-error, and the changed-files fallback.
- **Tool-window section frame** — owns the `WORKING MEMORY` section header, collapse, count, gear-menu visibility, and the shared scroll bar this body reports its height into.
