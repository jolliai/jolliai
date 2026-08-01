# 220. IntelliJ PINNED Panel

## Topic Statement

The PINNED section of the tool window — a single newest-first list of items the user has explicitly pinned (drawn from a per-project pin store), where each row mirrors the badge and title of the row it was pinned from, exposes hover actions to open the underlying content, resume a Claude session, or unpin, and shows a placeholder when nothing is pinned.

## Scope

**In scope:**

- The single source the panel reads on every refresh: the **shared cross-surface pin store**, reached over the IDE bridge, returning a flat list of pinned entries for the current repository-and-branch group.
- The adapter layer between that store's persisted shape and this panel's row model: plural↔singular kind names, `id`↔`key`, the badge fallback, and the client-side newest-first sort.
- The per-row anatomy: a lead badge (a real producer logo for conversation pins, otherwise a colored rounded pill carrying a short tag), the title text, and a right-edge cluster of hover-revealed icon actions.
- The hover-action set per row: an "open" action always present; a "resume in terminal" action present only for Claude conversation pins; an "unpin" action always present.
- The click semantics: clicking the row body opens the pinned content; the per-icon clicks are consumed so they do not also fire the row-body open.
- The open dispatch keyed by the entry's kind: conversation, plan, note, reference, or memory — each resolving to a different viewer.
- The unpin flow: remove the entry from the store on a background thread, then refresh.
- The resume flow: extract the session identifier from the entry key and hand it to the terminal-resume utility with a tab title derived from the pin title.
- The empty-state placeholder.
- The live row-count notification the panel emits so the hosting section header can show a count.
- The fit-to-content sizing model (the panel reports its natural height; it owns no scroll bar).
- The badge color maps for conversation pins (by producer) and context pins (by tag letter), with a neutral fallback.
- The refresh triggers: an explicit refresh call (invoked after another panel records a pin, and after this panel unpins).

**Out of scope (boundaries):**

- The pin store's on-disk format, versioning, group-key construction, atomic-write, defensive read coercion, and de-dup-on-re-pin rules — owned by the pin store spec (246). This panel only reads the list and calls add/remove through the bridge.
- The act of *creating* a pin — performed by the source panels (the conversations sub-panel pins a conversation, the context sub-panel pins a plan/note/reference, the committed-memories panel pins a memory). This panel never writes a new pin; it only reads, opens, and removes.
- The conversation transcript editor tab opened for a conversation pin — its own spec; this panel only constructs the conversation virtual file and hands it to the IDE open-file mechanism.
- The summary/memory editor tab opened for a memory pin — its own spec; this panel only looks up the memory and hands it to the shared single-memory-tab opener. That opener's one-tab-per-project rule and its in-place content swap belong to that spec too.
- The rendered-markdown preview opened for plan/note/reference pins — owned by the markdown-preview utility; this panel only resolves the source path and calls it.
- The terminal-resume utility — its own spec; this panel only supplies the session id, working directory, and tab title.
- The active-session aggregator used to re-resolve a conversation pin to a live conversation item — its own spec.
- The plans/notes/references registry used to resolve a context pin's source path — owned by the registry/plans spec.
- The section frame that hosts this panel (header, collapse state, count suffix, gear-menu visibility toggle, shared scroll bar) — owned by the tool-window layout spec.
- The composite-key construction (`producer` + `session id`, plan slug, note id, reference key, commit hash) — defined by the commit-selection store / source panels; this panel treats the key as opaque except when splitting out a session id for resume.

## Data Contracts

### The store this panel is backed by

This panel is **not** an independent implementation. It reads and writes the same shared pin store, in the same format, in the same file, as the other host surface — reached over the IDE bridge with three operations (read the current group, add, remove). Consequences that are part of this panel's observable contract:

- **The list is branch-scoped, not project-global.** Pins live in a group keyed by repository-and-branch, and the group is resolved on the far side of the bridge from the working directory the panel supplies. The panel never constructs the group key. **Switching branches changes the visible pin list**; switching back restores it.
- **Content written by the retired panel-local store is unreadable.** The old implementation was project-global, stamped its timestamp as an ISO string, and stored plural kind names. That shape does not match the shared format and is coerced away on read, so pins made before the migration simply do not appear.

### Pinned entry (consumed)

Each entry the panel renders carries:

| Field | Meaning / use |
| --- | --- |
| kind | One of `conversations`, `plans`, `notes`, `references`, `memories`. Selects the badge style, the open dispatch, and whether resume is offered. **Stored singular; the adapter pluralizes it on read and the bridge re-singularizes it on write.** An unrecognized kind is passed through unchanged by the adapter and rejected with an error by the bridge. |
| key | The opaque identity of the pinned item (composite conversation key, plan slug, note id, reference key, or commit hash). **Named `id` in the store.** Passed to unpin; for conversation pins the substring after the first `:` is the session id used by resume and used to re-match the live conversation. |
| title | Rendered verbatim as the row's title; also used to build the resume tab title (`Claude – <title>`). |
| badge | A short tag mirroring the source row's badge — a producer name for conversation pins, or a letter tag for context pins. Drives the lead badge (logo lookup or pill color). **Derived as the store's `badge` field, falling back to its `source` field when `badge` is absent, and to the empty string when neither is present.** |
| pinned-at | The newest-first sort key (descending). Not rendered. **An epoch-millisecond number**, stamped on the far side of the bridge at add time — the panel never supplies it. |

The list does **not** arrive sorted: the adapter sorts it newest-first by the epoch timestamp, client-side, on every read.

### Lead badge rule

- **Conversation pins**: if the producer (the badge value, lowercased) has a registered logo, a plain logo icon is shown with the producer name as tooltip; otherwise a colored pill with the producer name.
- **All other kinds**: a colored pill carrying the letter tag.

Pill color is chosen by:

| Pin kind | Color source |
| --- | --- |
| conversations | Producer color map (claude=amber, gemini=emerald, codex=violet, opencode=cobalt, cursor=crimson), neutral gray otherwise. |
| plans / notes / references / memories | Tag color map keyed by the letter tag (P=blue, N=green, S=amber, L=violet, GH=gray, J=blue, No=gray), neutral gray otherwise. **Two of those keys are now unreachable** — see "Two dead keys in the tag color map" under Notable Behavior. |

The pill is a rounded rectangle with bold white text, a minimum width, and a fixed small height.

### Hover-action set

| Action | Present when | Effect |
| --- | --- | --- |
| Open (eye icon) | Always | Opens the pinned content (see open dispatch). |
| Resume (play/execute icon) | Only when kind is `conversations` and the producer is Claude | Resumes the Claude session in a terminal. |
| Unpin (close icon) | Always | Removes the entry and refreshes. |

Icons are hidden by default and revealed on hover; each carries a tooltip. The icon order is Open, then Resume (if present), then Unpin.

### Empty-state contract

When the list is empty, a single left-aligned gray label reading **`Nothing pinned.`** is shown with uniform padding.

### Row-count contract

After each render the panel records the row count and invokes its registered count-changed callback with the new value, so the hosting section header can display `PINNED (N)`. The empty-state render reports nothing was explicitly counted via the callback; the count is updated only inside the data render path (zero entries report `0`).

### Sizing contract

The panel reports its maximum height as its preferred height (fit-to-content) and is placed so it never stretches; it has no internal scroll bar. The hosting section provides the shared scroll bar.

## Behavior

### Construction

1. Build the rows container with a vertical layout and a small border.
2. Build (but reuse) the empty-state label.
3. Render the empty state immediately (before any data load).

The panel does not auto-load on construction; the first populated render happens when an external refresh is triggered.

### Refresh (one cycle)

1. Resolve the working directory: prefer the service's main repo root, else the project base path; if both are null, abort silently.
2. On a background thread, read the current group's pin list over the bridge and sort it newest-first.
3. Marshal to the UI thread and render the list.

### Render

1. Set the row count to the list size and fire the count-changed callback.
2. Clear the rows container.
3. If the list is empty, attach the empty-state label.
4. Otherwise build one row per entry and attach them in order.
5. Revalidate and repaint the whole panel so the hosting section re-lays out to the new content height.

### Row composition

1. **Lead**: producer logo (conversation pins with a registered logo) or colored pill.
2. **Title**: the entry title.
3. **Right cluster**: the hover-action icons in order (Open, optional Resume, Unpin), all initially hidden.
4. A shared hover adapter and a shared body-click adapter are installed on the row, the lead container, and the title; the body-click adapter opens the pinned content. Each action icon has its own click adapter that consumes the event so the body-click does not also fire.

### Hover model

- On mouse-enter (from the row, lead, or title): all action icons become visible.
- On mouse-exit: if the exited component is no longer showing, or the row is no longer showing, hide the icons; otherwise compute the cursor's screen-space position and hide the icons only if it falls outside the row's screen-space bounds (so crossing an internal child boundary keeps the row "hot").

### Open dispatch (row body click or Open icon)

Resolve the working directory; if null, do nothing. Then by kind:

| Kind | Open behavior |
| --- | --- |
| conversations | On a background thread, re-resolve the entry to a live conversation by matching its composite key against the active-session aggregator's current list; if found, open the conversation virtual file as an editor tab on the UI thread. If not found, nothing opens. |
| plans | Look up the plan in the plans registry by key, resolve its source path, and open it as rendered markdown. |
| notes | Look up the note in the notes map by key, resolve its source path, open as rendered markdown. |
| references | Look up the reference in the references map by key, resolve its source path, open as rendered markdown. |
| memories | On a background thread, fetch the memory by commit hash; if found, hand it on the UI thread to the **shared single-memory-tab opener** (the full memory UI, identical to the committed-memories view). That opener allows at most one memory tab per project, so if one is already open it swaps that tab's content to this memory and re-activates it rather than opening a second tab — **whatever memory the tab was showing is replaced**. This panel never constructs the memory's virtual file itself. |

For plan/note/reference, a null or blank source path is a no-op; the path is resolved to a virtual file and, if that resolution fails, nothing opens.

### Unpin

1. The unpin icon's click is consumed (no body open).
2. Resolve the working directory; if null, no-op.
3. On a background thread, remove the entry by `(kind, key)` from the store, then trigger a refresh.

### Resume (Claude conversation pins only)

1. The resume icon's click is consumed.
2. Resolve the working directory; if null, no-op.
3. Extract the session id as the substring of the key after the first `:`.
4. If that session id is non-blank, call the terminal-resume utility with the project, session id, working directory, and a tab title of the form `Claude – <title>`.

### Disposal

The panel holds no timers or external listeners and releases nothing special on disposal.

## State Transitions

```
[constructed]
  build rows container + empty label
  render empty state
  (no auto-load)

[refresh invoked]
  cwd ← mainRepoRoot ?? basePath ; if null → abort
  on background: pins ← bridge pins-read(cwd)   // group resolved remotely from cwd
                 pins ← pins.sortedByDescending(pinnedAt)
  on UI: render(pins)

[render(pins)]
  rowCount ← pins.size ; fire count callback
  clear rows
  if empty → add empty label
  else → add one row per pin (in store order, newest-first)
  revalidate + repaint

[hover enters row/lead/title]
  show all action icons

[hover leaves]
  if cursor screen-pos ∉ row screen bounds (or row not showing) → hide icons
  else → keep shown

[row body / Open clicked]
  dispatch by kind → open conversation tab / markdown preview / memory tab

[Unpin clicked]  (event consumed)
  on background: store.unpin(cwd, kind, key) ; refresh()

[Resume clicked]  (event consumed, Claude conversation pins only)
  sessionId ← key after first ':' ; if non-blank → terminal.resume(...)
```

## Notable Behavior

- **The pin store is shared, not panel-local.** This panel is one of three consumers of one store and one file. A pin made here is visible to the other host surface and vice versa; there is no per-IDE pin format any more.
- **The list is branch-scoped, so switching branches changes what is pinned.** A user who pins several conversations on a feature branch, checks out the trunk, and opens the tool window sees an empty PINNED section — the pins are not gone, they are in the other branch's group. Nothing in the panel explains this.
- **Pins written before the migration are silently invisible.** The retired panel-local store's shape (project-global grouping, ISO-string timestamp, plural kinds) does not survive the shared format's read filter. Those entries are dropped on read and erased from disk by the next add or remove.
- **The panel never creates a pin.** Pins are written by the source panels; this panel only reads, opens, removes. It is the read/act surface of the pin store.
- **The display badge falls back to the transcript-provider field.** When a stored entry carries no explicit badge, the panel uses the store's `source` value as the badge — which is why conversation pins keep their producer pill even though the badge and the provider are two separate persisted fields. An entry with neither yields an empty badge string, which renders as an empty pill (not a missing lead).
- **Conversation pins re-resolve to live conversations at open time.** Because a pin stores only a key and a title snapshot, opening a conversation pin requires matching the key against the *current* active-session list. If the conversation is no longer active (outside the recency window, hidden, etc.), the Open action silently does nothing — the row stays, but cannot open.
- **Resume is offered only for Claude conversation pins.** The eligibility test is kind `conversations` AND producer (badge, lowercased) `claude`. A pinned conversation from any other producer shows only Open and Unpin.
- **The session id for resume is parsed from the composite key.** It is the substring after the first `:`; a malformed key with no `:` or an empty session id makes resume a no-op.
- **Plan/note/reference pins open as rendered markdown, not raw text** — consistent with the design intent that these are human-readable documents.
- **Memory pins open the full memory editor**, the same surface as the committed-memories list (with its own actions such as Create PR), not a read-only snippet.
- **Opening a memory pin replaces whatever memory was already showing.** Memory opening goes through the shared single-memory-tab opener, which allows at most one memory tab per project. Clicking through several memory pins in a row therefore reuses one tab rather than accumulating tabs, and there is no way to keep two pinned memories open side by side. (Notable; the list's "several pinned memories" framing does not suggest it.)
- **The panel fits to content and owns no scroll bar.** It participates in the section's single shared scroll bar; every render revalidates the whole panel so the section re-measures.
- **The lead is logo-first for conversation pins only.** Context-kind pins always render a colored letter pill, never a logo.
- **Two dead keys in the tag color map, and one wrong colour, because the producer side moved and this map did not.** The map itself is unchanged, but the badges written into the store changed underneath it. The context panel that creates reference pins used to stamp its own letters; it now stamps the letter from the shared source-presentation table (spec 313), which is single-letter across all twelve sources. A GitHub reference is therefore pinned as `"G"` and a Notion reference as `"N"`. The map's `GH` and `No` entries can no longer be produced by any writer — they are dead keys — and the two affected pins resolve elsewhere: `G` misses the map entirely and falls through to the neutral gray fallback (which happens to be close to the intended GitHub gray), while `N` **hits the notes entry and paints a Notion reference pin green**, the colour reserved for notes. Nothing distinguishes the two on screen. This is observed behavior, not intent: the drift was introduced by the producer-side change and the consumer map was never updated. (Surprising.)
- **The empty-state render path does not fire the count callback.** The count callback is fired from the data render path (which reports `0` for an empty list); the standalone empty-state render used at construction simply shows the label.

## Shared Behavior

- **Pin store (spec 246)** — the single shared store behind all three surfaces. It owns the persisted list, the versioned format, the repository-and-branch group key, the atomic write, the defensive read coercion, and the upsert-on-re-pin semantics. This panel reads and unpins through the bridge, and applies the newest-first sort itself.
- **Active-session aggregator** — re-resolves a conversation pin's key to a live conversation item at open time.
- **Plans/notes/references registry** — resolves a context pin's source path by key.
- **Conversation transcript editor tab / conversation virtual file** — the surface a conversation pin opens; this panel only constructs the virtual file.
- **Memory editor tab / memory virtual file** — the surface a memory pin opens; this panel only looks up the memory and hands it to the shared single-memory-tab opener, which decides between swapping the one existing memory tab and opening a new one.
- **Markdown preview utility** — renders plan/note/reference markdown.
- **Terminal-resume utility** — resumes a Claude session; this panel only supplies session metadata.
- **Tool-window section frame** — owns the PINNED header, count suffix, collapse, gear-menu visibility, and the shared scroll bar.
- **Source panels (conversations / context / committed memories)** — own pin creation; this panel is the consumer surface. The letter a reference pin carries is decided there, from the shared source-presentation table (spec 313); this panel only looks that letter up in its own colour map.
