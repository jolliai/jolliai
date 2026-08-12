# 220. IntelliJ PINNED Panel

## Topic Statement

The PINNED section of the tool window — a newest-first list of items the user explicitly pinned, read on every refresh from the shared cross-surface pin store, where each row shows a lead badge and a title, opens its underlying content when the row body is clicked, and offers exactly one hover-revealed action: unpin.

## Scope

**In scope:**

- The single read the panel performs on every refresh, and the fact that the group it reads is resolved on the far side of the round trip from the working directory it supplies.
- The adapter between the store's persisted shape and this panel's row model: the singular↔plural kind names, the identifier rename, the badge fallback chain, and the client-side newest-first sort.
- The per-row anatomy: a lead badge, a word-wrapping title, and a right-edge action revealed on hover.
- The **badge derivation**, which is not uniform across kinds: a reference's letter *and* colour are both re-derived from the shared source-presentation table via the pin's own identifier, while every other kind keeps the letter it was stamped with.
- The open dispatch keyed by the pin's kind, and what each kind resolves to.
- The unpin flow.
- The empty-state placeholder and the row-count signal the panel publishes.
- The fit-to-content sizing model.
- The refresh triggers — and the deliberate decision that this panel subscribes to **no** change-notification list at all.

**Out of scope (boundaries):**

- The pin store's on-disk format, its versioning, its group-key construction, its atomic write, its defensive read coercion and its de-duplication on re-pin — owned by the pin store spec. This panel reads the list and asks for a removal.
- Pin *creation*, which happens on the surfaces the pinned item came from — the live conversations list, the working-context list and the committed-memories list. This panel never writes a new pin.
- The conversation editor tab, the rendered-markdown preview, and the shared single-memory-tab opener — each its own surface. This panel only resolves what to hand each one.
- The active-session aggregation used to re-resolve a conversation pin to a live conversation.
- The working-area registry used to resolve a context pin's file path.
- The shared source-presentation table itself — its rows, its label-composition policy and its neutral fallback (spec 313). This panel consumes it.
- The section frame that hosts this panel — header, count suffix, collapse state, visibility toggle, and the shared scroll bar.
- The terminal session-resume affordance. It is **no longer present on this panel** (spec 212).

## Data Contracts

### The store behind the panel

This panel is not an independent implementation. It reads and removes through the same shared store, in the same format and the same file, as the desktop editor's equivalent surface, over a round trip with three operations — read the current group, add, remove. Two consequences are part of this panel's observable contract:

- **The list is branch-scoped, not project-global.** Pins live in a group keyed by repository and branch, resolved on the far side of the round trip from the directory the panel supplies. Switching branches changes the visible list; switching back restores it. Nothing in the panel says so.
- **Content written by the retired panel-local store is unreadable.** That shape — project-global grouping, a text timestamp, plural kind names — does not survive the shared format's read filter, so pins made before the migration simply do not appear, and are erased from disk by the next write.

### The row model

| Field | Meaning / use |
| --- | --- |
| Kind | One of the five pinnable kinds — conversation, plan, note, reference, memory. Selects the badge style, the open dispatch and the colour source. **Stored singular; the adapter pluralizes it on read, and the far side re-singularizes it on write, rejecting anything it does not recognise.** An unrecognised kind is passed through unchanged by the adapter. |
| Key | The pinned item's opaque identity — the composite conversation key, a plan slug, a note id, a reference registry key, or a commit hash. **Named differently in the store**; renamed by the adapter. Passed back on unpin, and — for references only — parsed for its source prefix. |
| Title | Rendered verbatim. |
| Badge | A short tag mirroring the source row's badge. **Derived as the store's badge field, falling back to its provider field, and to the empty string when neither is present.** Consumed for conversation and plan/note kinds; ignored for references. |
| Pinned-at | An epoch-millisecond number, stamped on the far side at write time. The newest-first sort key. Never rendered. |

The list does not arrive sorted; the adapter sorts it descending by that timestamp on every read, and applies no de-duplication — that happens on the far side at **write** time, where re-pinning an already-pinned artifact replaces the record and re-stamps its timestamp, so it floats back to the top. Two pins sharing a key but differing in kind are two distinct rows, correctly, since removal is keyed on both.

### Lead badge

- **Conversation pins** whose producer has a registered logo render that logo, with the raw badge value as the tooltip.
- **Everything else** renders a rounded pill: bold white text on a solid colour, with a minimum width and a fixed small height.

### Badge letter, by kind

| Kind | Letter |
| --- | --- |
| Reference | **Re-derived** from the shared source-presentation table, resolved from the source prefix of the pin's own key. |
| Plan, note, memory, conversation | The stored badge, verbatim. |

### Badge colour, by kind

| Kind | Colour |
| --- | --- |
| Conversation | A producer colour map covering the five earliest producers, keyed on the lower-cased badge; neutral grey for anything else. |
| Reference | **Re-derived** from the shared source-presentation table, resolved from the same source prefix. |
| Plan, note, memory | This panel's own tag map, which holds exactly three letters — plan, note and snippet — with neutral grey for anything else. |

A memory pin's stamped letter is not one of those three, so **every memory pin renders neutral grey**.

**Both halves of a reference badge are derived rather than read, and that is the whole point.** A letter is not a unique key: two sources share one letter in two separate cases in the shared table, so a letter-keyed colour lookup cannot be right for both members of such a pair. Worse, two of those letters collide with the note and snippet letters this panel owns outright — so a letter-keyed lookup painted one source's pins in the colour reserved for notes and another's in the colour reserved for snippets. And the *letter itself* cannot be trusted either: it is whatever alphabet the plugin version that created the pin was using, and that alphabet has changed — pins predating the single-letter scheme carry two-character tags, and a pin written before the badge field existed at all falls back to the raw source name. Deriving only the colour would render those forever as a stale letter over a correct hue.

Because a reference pin's key *is* the registry key, and that key leads with the source's wire name, the source is recoverable with no change to the stored shape. An unparseable wire name lands on the shared table's **neutral unknown** — its placeholder letter together with its neutral grey — which is exactly how the reference rows themselves render an unrecognised source, and is deliberately *not* the plain grey the conversation branch falls back to.

### Empty state

A single left-aligned dim label reading **`Nothing pinned.`** with uniform padding.

### Row-count signal

The populated render path records the list size and invokes the registered count callback, so the hosting header can show a count — including for a zero-length list. The standalone placeholder render used at construction does not fire it.

### Sizing

The panel reports its maximum height as its preferred height and owns no scroll bar; the hosting section provides the shared one.

## Behavior

### Construction

Build the row container and the placeholder, render the placeholder immediately, and stop. **The panel does not load on construction** — the first populated render happens only when something triggers a refresh.

### Refresh

1. Resolve the working directory: the shared repository root first, the project's base path as fallback. If neither resolves, abandon silently.
2. On a background thread, read the current group's pins and sort them newest-first.
3. Marshal to the UI thread and render.

### Render

Publish the count, clear the container, attach either the placeholder or one row per pin in order, then revalidate and repaint the **whole panel** so the hosting section re-measures to the new content height.

### Row composition

- **Lead**: logo or pill, held in a cell that keeps it naturally sized and vertically centred as the row grows.
- **Centre**: the title, in a word-wrapping text area styled as a label.
- **Right**: the unpin action, hidden at rest. Its width is measured while visible and then **reserved**, so the title's wrap width — and the row's height — do not change when the action appears.

The row's height is computed from the wrapped title at the row's actual width and re-computed whenever the row's width changes, so resizing the tool window reflows the list. The row's maximum height is clamped to its preferred height. The hover tint is *painted* rather than set as an opaque background, so the ancestor is always repainted underneath.

### Hover

One shared handler is installed on the row, the lead cell, the lead, the title and the action. Entering tints the row and reveals the action; leaving tests the cursor's **screen-space** position against the row's screen-space bounds and reverts only when it is genuinely outside, so moving onto the action does not flicker it away. The handler short-circuits when the state is unchanged.

### Click routing

The body-click handler is installed on the row, the lead cell, the lead and the title — and **not** on the action, which consumes its own click. The right-hand cell is likewise not a click target, so the strip of empty space the reserved action width creates is inert.

### Open dispatch (row body)

Resolve the working directory; abandon if it does not resolve. Then, by kind:

| Kind | Behavior |
| --- | --- |
| Conversation | On a background thread, list the currently-active conversations and find the one whose composite key equals the pin's. If found, open it as an editor tab on the UI thread. If not found, nothing opens. A failure of that listing is caught and logged as a transport problem rather than silently treated as "not found". |
| Plan | Look the slug up in the working-area registry, take its recorded file path, and open it as **rendered markdown**. |
| Note | Same, against the notes map. |
| Reference | Same, against the references map. |
| Memory | On a background thread, fetch the memory by commit hash; if found, hand it on the UI thread to the shared single-memory-tab opener — the full memory surface, identical to the committed-memories view. |

For plan, note and reference a null or blank path is a no-op, and a path that cannot be resolved to a file opens nothing. The dispatch has no catch-all arm, so a kind outside the five — which the adapter passes through unchanged rather than rejecting — silently does nothing.

The click is not restricted to the primary mouse button, so any button over the row body opens the pin.

### Unpin

The action consumes its click, the working directory is resolved, an unpin event tagged with the kind is recorded, and on a background thread the entry is removed by kind-and-key, followed by a refresh.

### Refresh triggers

There are exactly two ways this panel reloads, and both are explicit calls:

1. The tool window's own initial background load when its content is built.
2. Whoever writes a pin, immediately after the write — the live conversations list, the working-context list, the committed-memories list, and this panel's own unpin.

**The panel subscribes to no change-notification list.** That is a decision, not an omission: every value a row paints — its title and its badge — was snapshotted at pin time, and the only other file the panel touches is read once, inside a click, purely to resolve a target. So no context-change event can alter what this panel paints, and subscribing to one bought a round trip plus a full row rebuild (which also discards hover state) on every mid-session working-area edit in every open project on the machine. If pinned titles are ever made to resolve live out of the registry, that is when this changes.

### Disposal

Nothing to release — the panel holds no timer and no external registration.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Constructed | — | Placeholder shown, no count published, no data read |
| Any | Explicit refresh with a resolvable directory | Background read, then a populated or empty render with a published count |
| Any | Explicit refresh with no resolvable directory | Unchanged, silently |
| Rendered | Cursor enters a row | Row tinted, unpin revealed |
| Rendered | Cursor leaves the row's screen-space bounds | Reverted |
| Rendered | Row body clicked | Dispatch by kind |
| Rendered | Unpin clicked | Event recorded; entry removed; refresh |
| Rendered | Branch changed underneath | Unchanged until something triggers a refresh, then a different group's list |

## Notable Behavior

- **The hover cluster is one action.** Unpin only. A dedicated open action was redundant with the row-body click, and the terminal session-resume action was dropped for parity with the desktop editor, which has neither. (Notable — an earlier shape of this row carried three.)
- **A reference pin's letter and colour are BOTH re-derived, and neither is read from what was stored.** This closes a drift that shipped in both directions at once: a letter-keyed colour map cannot serve two sources that share a letter, it collided with the note and snippet letters this panel owns, and the stored letter itself belongs to whatever alphabet the writing plugin version used. Deriving only the colour would have left a stale two-character tag sitting over the correct hue forever. The key already carries the source, so nothing about the stored shape had to change. (Notable; a closed defect, documented as the current rule.)
- **An unrecognised reference source lands on the shared table's neutral unknown, not on the panel's own grey.** The two are different fallbacks that happen to look similar; taking the shared one is what makes a pinned row and a live reference row render an unknown source identically. (Notable.)
- **The pin store is shared, not panel-local.** A pin made here is visible on the desktop editor's surface and the reverse; there is no per-host pin format. (Notable.)
- **The list is branch-scoped, so switching branches changes what is pinned.** Pinning several conversations on a feature branch and then checking out the trunk shows an empty section. The pins are not gone — they are in the other branch's group — and nothing on screen explains that. (Surprising.)
- **Pins written before the migration are silently invisible.** The retired panel-local shape does not survive the shared format's read filter; those entries are dropped on read and erased by the next write. (Notable.)
- **The panel never creates a pin.** It is the read-and-act surface of a store four other surfaces write into. (Notable.)
- **The badge falls back to the provider field when no badge was stored**, which is why a conversation pin keeps its producer identity even though badge and provider are two separate persisted fields. An entry with neither yields an empty pill rather than a missing lead — and for a reference that fallback is irrelevant, since the letter is derived anyway. (Notable.)
- **A conversation pin re-resolves to a live conversation at open time.** Because a pin stores only a key and a snapshotted title, opening one requires matching that key against the *current* active list. A conversation that has aged out of the recency window, or been dismissed, cannot be opened — the row stays, and the click does nothing. A failure of the listing itself is logged, so a user report can be traced to a transport failure rather than a missing session; the click is silent either way. (Notable.)
- **Opening a memory pin replaces whatever memory was already showing.** Memory opening goes through the shared single-memory-tab opener, which allows at most one memory tab per project. Clicking through several memory pins reuses one tab, and two pinned memories cannot be open side by side — which the phrase "several pinned memories" does not suggest. (Surprising.)
- **The panel is on neither change-notification list, deliberately.** Every painted value was snapshotted at pin time, so no context event can change the render; subscribing cost a round trip and a full rebuild on every unrelated working-area edit machine-wide. (Notable.)
- **The panel does not load on construction.** Until something calls refresh, the section shows the placeholder even when pins exist. (Notable.)
- **The working directory here prefers the shared repository root and falls back to the checkout path** — the opposite order to the live conversations list, which prefers the checkout precisely because its inputs are per-checkout. The pin file is per project directory, so in a linked checkout the two surfaces can be reading and writing different files. (Surprising; the two surfaces do not agree.)
- **The placeholder render at construction publishes no count, but the populated path publishes zero for an empty list.** The header can therefore be uninitialised until the first real render. (Notable.)
- **The reserved action width creates an inert right-hand strip.** The right cell is neither a click target nor an open target, so clicking the empty space where the action will appear does nothing. (Notable.)
- **The panel fits to content and owns no scroll bar**, and every render revalidates the whole panel so the hosting section re-measures. (Notable.)
- **Only conversation pins can render a logo.** Every other kind always renders a coloured letter pill. (Notable.)
- **The aggregate skill row cannot be pinned.** The working-context surface gives it no pin affordance, because a pin addresses one artifact by key and that row stands for every captured skill at once. (Notable.)
- **Memory pins are always neutral grey.** The letter stamped for a memory has no entry in this panel's tag map, so every memory pin takes the fallback hue while its plan, note and reference neighbours are coloured. (Surprising; an unfixed gap.)
- **A source the panel's own source enumeration does not carry paints as an unrecognised reference.** That enumeration lags the reference-source catalogue, and at least one shipping source is currently absent from it — so a pin of that source renders with the placeholder letter and the neutral hue here, while the desktop editor renders its real brand letter and colour from identical stored data. (Surprising; see spec 313 for where the drift sits.)
- **The section header carries no toolbar.** Its action group is registered with no actions, so there is no header-level refresh or clear affordance; every reload is an explicit call from elsewhere. (Notable.)
- **The click target excludes the right-hand cell but the hover target includes the action.** Both are deliberate: the action must keep the row "hot" while the cursor is over it, and must not double as an open. (Notable.)
- **The panel exposes an "is this pinned?" query that nothing calls.** (Unreachable.)

## Shared Behavior

- **Pin store** — the single shared store behind every surface. It owns the persisted list, the versioned format, the repository-and-branch group key, the atomic write, the defensive read coercion and the upsert-on-re-pin semantics. This panel reads and removes through it, and applies the newest-first sort itself.
- **Source presentation table (spec 313)** — owns the per-source letter, colour and label, plus the neutral unknown this panel's reference rows fall back to. This panel consumes it for both halves of a reference badge.
- **Active session aggregation (spec 155)** — re-resolves a conversation pin's key to a live conversation at open time.
- **Working-area context registry** — resolves a plan, note or reference pin's file path by key.
- **Conversation editor tab, rendered-markdown preview, and the shared single-memory-tab opener** — the three surfaces the open dispatch hands off to.
- **The hosting section frame** — owns the header, the count suffix, collapse state, the visibility toggle and the shared scroll bar.
- **The pin-creating surfaces** — the live conversations list (spec 192), the working-context list, and the committed-memories list. Each decides the badge it stamps and calls this panel's refresh after writing.
