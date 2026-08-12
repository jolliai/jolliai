# 192. IntelliJ Active Conversations Panel

## Topic Statement

A tool-window section that lists the currently-active AI coding conversations from every supported producer as one row each, refreshes itself on a visibility-gated timer plus on every project-status change, opens an editor tab when the row body is clicked, and exposes two hover-revealed per-row actions — pin the conversation, and toggle whether it is included in the next commit memory.

## Scope

**In scope:**

- The panel's anatomy: a partial-failure warning banner at the top, a vertical list of conversation rows below with a row cap and an expand affordance, and a centred placeholder when the list is empty. The panel has no scroll bar of its own.
- The row's anatomy: a producer lead (a real product logo when one is registered, otherwise a coloured text badge), a **word-wrapping** title that grows the row's height, and a right cluster that shows an unread message count at rest and swaps to the two action icons on hover.
- The delegated round trip that produces the rows, the explicit recency window it carries, and the fact that the panel runs no fan-out of its own.
- The **separate** exclusion read the panel performs alongside that round trip, and the last-known-good fallback that governs it when the read fails.
- The refresh triggers, and which of them are conditional.
- The click semantics on the row body, the pin action, and the selection toggle — including which sub-components carry the body click and which deliberately do not.
- The row cap, the expand affordance, and the lifetime of the expanded state.
- The hover model and the screen-space exit test that keeps it stable across internal component boundaries.
- The failure-isolation rule at the panel boundary: a wholesale failure of the round trip is rendered as "no items and **every** producer failed".
- The threading model, including the one piece of unrelated work that rides the poll tick.
- The row-count signal the panel publishes for its host section header.
- The producer lead table: which producers have a logo, which fall through to a coloured badge, and how a label is composed.

**Out of scope (boundaries):**

- The cross-producer fan-out, the per-producer enabled gate, the recency filter, the title cascade, the unread-slice message count, the dedup rule, the sort order, the per-row edited/selected flags and the partial-result envelope — all owned by the active-session aggregator (spec 155). This panel consumes the envelope.
- The second application of the enabled gate that the adapter beneath this panel performs over both the rows and the failed-producer list — also spec 155.
- The transport that carries the delegated round trip, and everything that can go wrong inside it. This panel only distinguishes "it answered" from "it threw".
- The conversation editor tab that opens on a row click — its layout, per-message affordances, save semantics and overlay rules.
- The virtual file used to open that tab, including its equality contract; this panel only constructs one.
- The section frame that hosts this panel — header, collapse state, resize bar, visibility toggle, the shared scroll bar, and the action-group anchor the explicit refresh is registered under.
- The pin store's persistence, grouping and coercion rules; this panel only writes one entry and asks the pinned list to reload.
- The commit-exclusion store's persistence and lock semantics; this panel reads its sets and writes single-key and batch updates.
- The terminal session-resume affordance. It is **no longer present on this panel** — see spec 212 for the one surface that still carries it.
- The project's repository-root resolution and its status-listener channel.

## Data Contracts

### Inputs

| Input | Source | Meaning |
| --- | --- | --- |
| Project handle | Host | Used to obtain the editor manager, the current checkout path, and a scope for background work. |
| Status-aware project service | Host | A registration channel for status-change listeners whose contract is "fire once immediately if a status is already cached, then on every change", plus the resolved shared-repository root used only as a fallback working directory. |
| Result envelope | Delegated round trip | A list of conversation rows plus a list of producers whose scans failed. |
| Exclusion sets | Delegated round trip | The user's per-kind exclusions for the next commit memory; only the conversation set is consulted here. |

### The delegated call

The panel runs no fan-out in process. It issues one delegated round trip carrying the resolved working directory and an **explicit** recency window of 48 hours; the far side applies the same 48-hour default when no window is supplied, so the two agree.

Because the call crosses a process boundary it can fail for reasons unrelated to any producer — a missing runtime, a spawn failure, a timeout, an unparseable response. All of those land in the same catch as a genuine crash of the aggregation itself and are reported identically.

### Per-row fields and how the row uses them

| Field | Use |
| --- | --- |
| Producer | Selects the lead logo or badge colour and the badge label; forms half of the row's composite identity for the pin and exclusion writes. |
| Session identifier | The other half of the composite identity; forwarded to the editor tab. |
| Display title | Rendered verbatim into a wrapping text area. All title resolution, truncation and placeholder substitution happened upstream. |
| Unread message count | Rendered as a small dim number at rest when greater than zero; an empty string when zero. Hidden while the row is hovered. |
| Last-activity timestamp | Forwarded to the editor tab. Never rendered here; ordering already happened upstream. |
| Transcript locator | Forwarded to the editor tab. Never parsed here. |
| Edited flag | Not rendered. |
| Selected flag | **Overwritten** before the row is built — see the exclusion overlay below. |

### The exclusion overlay

The envelope's selected flag is not what the row uses. On every load cycle the panel performs a **second, independent** read of the exclusion sets and recomputes each row's selected flag as "this row's composite key is absent from the conversation exclusion set".

That read has its own failure policy, and it is deliberately not the obvious one:

- On success, the set is cached in a field shared across load cycles.
- On failure, the **last set successfully read** is reused. Falling back to an empty set would render every row as included — the exact inverse of what a user who excluded rows has on disk — and one glance at that misstates what the next memory will capture.
- Before the first successful read the cache is empty, and there "nothing excluded" is the honest answer rather than a fallback.

### Producer lead

The lead is logo-first: when the product has a registered logo image, a plain icon is shown with the composed label as its tooltip; otherwise a rounded coloured badge carrying that label in bold white.

Every producer in the enumeration has a registered logo **except the most recently added one**, so in normal operation the coloured badge is reached by exactly one producer. The colour table is otherwise a fallback for a logo that fails to load.

| Producer | Lead in practice | Badge colour if the badge is reached |
| --- | --- | --- |
| Claude | Logo | Amber |
| Codex | Logo | Violet |
| Gemini | Logo | Emerald |
| OpenCode | Logo | Cobalt |
| Cursor | Logo | Crimson |
| Cursor CLI | Logo (shared with Cursor) | Crimson |
| Copilot CLI | Logo | Green |
| Copilot Chat | Logo (shared with Copilot CLI) | Green |
| Cline | Logo | *(no colour entry — neutral grey)* |
| Cline CLI | Logo (shared with Cline) | *(no colour entry — neutral grey)* |
| Devin | Logo | Pale grey |
| Antigravity | Logo | Pink |
| Kimi Code | **Badge** — no logo is registered | Lavender |

**Label composition** is a small override table over a generic rule. Copilot CLI, Copilot Chat, OpenCode and Kimi Code have hand-written labels; every other producer's label is its raw name with **only the first character** upper-cased. That is why the two hyphenated producers read as `Cursor-cli` and `Cline-cli` rather than `Cursor CLI` / `Cline CLI`. A producer name outside the enumeration would take the same generic rule and a neutral grey badge.

### Empty state

When the row list is empty a single horizontally-centred dim label reading **`No active conversations`** is shown, with generous uniform padding. It is centred horizontally only; it sits at the top of the list area, directly under the banner when that is visible.

### Warning banner

When the failed-producer list is non-empty, a one-line banner reading **`Some sources failed to load`** appears above the list, on a pale-yellow ground in the light theme and a dim amber ground in the dark one, with correspondingly dark-amber and bright-amber text. It **names no producer**. When the list is empty the banner is hidden and consumes no vertical space.

### Row cap

At most six rows are attached. Beyond that, a link-styled **`Show N more`** row is appended in place of the remainder; clicking it expands the list and re-renders. The expanded state is a field on the panel: it survives every subsequent refresh within the panel's lifetime and resets only when the panel itself is rebuilt.

### Row-count signal

After each populated render the panel records the row count and invokes its registered count callback, so its host section header can show a count. The count is the size of the **full** list, not the number of rows actually attached under the cap.

## Behavior

### Construction

1. Build the row container and the placeholder label; build the banner and set it invisible.
2. Stack banner over rows inside a content panel and attach that to the panel's top edge, so the panel reports its natural height rather than growing to fill the section.
3. Register as a project-status listener. Because that channel fires once immediately when a status is already cached, this doubles as an extra initial-load trigger.
4. Start a repeating 60-second timer.
5. Schedule the initial load on a background pool. Construction does not wait for it; the row container is empty until the first load resolves.

### One load cycle (background)

1. Resolve the working directory: the **project's own checkout path first**, the shared repository root only as a fallback. If neither resolves, abort silently — no error, no UI change.
2. Issue the delegated round trip with that directory and the 48-hour window. If it throws, substitute an envelope of **no rows and every producer in the enumeration marked failed**. The exception is swallowed; the substituted envelope is the diagnostic.
3. Read the exclusion sets, applying the last-known-good policy above.
4. Rebuild each row's selected flag from the conversation exclusion set.
5. Marshal to the UI thread with the adjusted envelope.

### UI update

1. Replace the cached row list and failed-producer list.
2. Show the banner exactly when the failed list is non-empty.
3. Publish the row count.
4. If the list is empty, clear the container, attach the placeholder, and stop.
5. Otherwise build a fresh component per row and hand the whole list to the capped renderer with the current expanded state and an expand callback that sets the flag and re-renders.

Row components are never reused across refreshes: hover state is discarded and the selected flag is re-derived from the store every time.

### Row composition

- **Lead**: the producer logo or coloured badge, held in a wrapper that keeps it vertically centred as the row grows.
- **Centre**: the title, in a word-wrapping text area styled to read as a label at one point below the base size. When the row is deselected the title gains a strikethrough and is dimmed.
- **Right**: a cluster holding the count and the two action icons. Its width is **measured in the hover state and then frozen**, so the title's wrap width — and therefore the row's height — does not change when the cluster swaps. The toggle icon is given a placeholder icon before that measurement purely so its width is counted.

The row's height is computed from the wrapped title at the row's actual width, and the row re-measures itself when its width changes. Its maximum height is clamped to its preferred height so a short list does not stretch a row to fill the section.

### Hover

One shared hover handler is installed on the row, both wrappers, the lead, the title, the cluster, the count, and both action icons. Entering any of them tints the row's background, hides the count and reveals both icons. Leaving any of them checks whether the cursor's **screen-space** position is still inside the row's screen-space bounds: if it is, nothing happens — the cursor merely crossed an internal boundary; if it is not, the tint, the count and the icons revert.

The tint is painted rather than set as an opaque background, so the ancestor is always repainted underneath and no stale pixels survive.

### Click routing

The body-click handler is installed on the row itself and on the lead wrapper, the lead, the title, the cluster and the count — and deliberately **not** on either action icon. Each action icon additionally consumes its own click. Both halves are needed: without the consume the click would still bubble, and without the attachment exclusion the consume alone would not be enough on every look and feel.

### Row-body click

1. Resolve the working directory the same way the load does; abort if neither source resolves.
2. Construct a virtual file carrying the row and that directory and hand it to the editor manager with focus.
3. Walk the returned editors and, on any conversation editor, install a save-side callback that re-invokes this panel's refresh.

The virtual file's identity is producer-plus-session, which is what makes a second click on the same row surface the existing tab instead of opening a duplicate. The panel does not check that anything opened.

### Pin

The icon consumes its click, the working directory is resolved the same way the load does, a pin event is recorded, and on a background thread the entry is written with the conversation category, the composite key, the title (falling back to a composed "<producer> conversation" when the title is blank), and the raw producer name as the badge. On completion the panel asks the pinned list to reload; it does not refresh itself.

### Selection toggle

The icon consumes its click. The row flips its own flag and immediately restyles itself — strikethrough and dimmed when deselected, normal when selected, with the icon and tooltip alternating between "exclude from next memory" and "include in next memory". On a background thread the exclusion is written for that single key, and a selection-changed notification is emitted for the surfaces that preview the next memory. The visual update is optimistic and does not wait for the write.

### Select all / deselect all

The panel exposes one toggle for the whole list. The intent is "select all" when **any** row is currently unselected, otherwise "deselect all". The corresponding batch exclusion write happens on a background thread over every composite key, followed by a selection-changed notification and a full refresh — the rows are not updated in place, so the display always ends up consistent with what was stored.

### The poll tick

The timer fires every 60 seconds regardless of visibility, and each tick checks whether the panel is actually on screen. When it is not, the tick does nothing. When it is, the tick schedules a load **and** rides a second, unrelated job: a best-effort flush of buffered telemetry, dispatched to a background pool rather than run inline. That dispatch is load-bearing — the timer fires on the UI thread and the flush performs a blocking network send, so running it inline would freeze the UI on a slow name lookup. It is skipped when the project has no base path, and it swallows its own failures.

### Disposal

Stop the timer and unregister the status listener. Child components are released by the host's own disposal chain, and editor tabs the panel opened are not closed.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Constructed, empty | Initial load resolves | Rendered list, or placeholder |
| Rendered | Poll tick while on screen | Fresh load cycle |
| Rendered | Poll tick while off screen | Unchanged (timer keeps ticking) |
| Rendered | Status listener fires, explicit refresh action, editor save callback, or select-all batch completing | Fresh load cycle |
| Rendered | Round trip throws | Banner shown, placeholder shown, every producer listed as failed |
| Rendered | Exclusion read throws | Rows keep the last successfully-read exclusion set |
| Collapsed at the cap | Expand affordance clicked | Expanded for the rest of the panel's lifetime |
| Row selected | Toggle clicked | Struck through and dimmed immediately; exclusion written asynchronously |

## Notable Behavior

- **The row's hover cluster is two actions, not four.** Pin and the selection toggle. A dedicated open action was redundant with the row-body click, and the terminal session-resume action was removed from this panel entirely. (Notable — an earlier shape of this row carried both.)
- **The panel re-reads the exclusion sets itself instead of trusting the envelope's selected flag.** The two come from different reads of the same underlying store, and this one wins. (Notable.)
- **A failed exclusion read reuses the last good set rather than defaulting to empty.** Defaulting to empty renders every row as included, which is the *inverse* of a user's stored intent and silently misstates what the next commit memory will capture — a worse outcome than showing a slightly stale set. Only the very first load has nothing to fall back to, and there the empty set is true. (Surprising; the defensive default is the dangerous one here.)
- **The working directory prefers the current checkout, and that ordering is a fix.** Every input this panel depends on is written per checkout: the recorded sessions the aggregation reads, the per-row include/exclude choices, and the pinned set. Preferring the shared repository root made a linked checkout read the *main* checkout's records, find nothing inside the recency window, and render "No active conversations" while a conversation was live in that very checkout. Nothing here needs to pre-resolve the shared root — the surface being called resolves it itself for the things that genuinely are repository-wide. (Notable.)
- **Every working-directory resolution in this panel uses the same order.** The load, the row-body open, the pin write, the single-key exclusion write and the batch write all prefer the checkout path and fall back to the shared root, so no action can land against a different directory than the rows were read from. (Notable — the pinned list it writes into does *not* share that order; see spec 220.)
- **A wholesale failure of the round trip is reported as "every producer failed", so the banner and the placeholder appear together.** Reporting an empty failed list instead would make a broken transport indistinguishable from an idle machine. (Notable; matches the desktop-editor consumer.)
- **The banner names no producer, so a broken runtime and a genuinely universal failure look identical.** A single producer failing inside the aggregation contributes one name; a failure of the round trip contributes every name. From the panel alone the two cannot be told apart. (Notable.)
- **The producer enumeration this panel deserializes into must stay in lockstep with the producing side.** An unrecognised producer name deserializes to a null that then fails a non-null contract at use — so adding a producer upstream without adding it here is a crash, not a graceful degradation. (Notable.)
- **Exactly one producer renders as a coloured badge in normal operation.** Every other producer has a registered logo, so the colour table is otherwise only reachable when a logo fails to load — and two producers that do have logos have no colour entry at all, so that fallback would paint them neutral grey. (Notable.)
- **Two labels read with a lower-case tail.** The generic label rule upper-cases only the first character of the raw producer name, so the two hyphenated producers render as `Cursor-cli` and `Cline-cli` while their hand-labelled neighbours read properly. (Surprising; cosmetic.)
- **The right cluster's width is frozen at its widest state.** It is measured with the action icons visible and the count hidden, then fixed, so the title's wrap width and the row's height do not shift when the cluster swaps on hover. The toggle icon is pre-loaded with a placeholder icon purely so it contributes to that measurement. (Notable.)
- **Rows wrap rather than truncate.** A long title grows the row's height, and the row re-measures itself whenever its width changes, so resizing the tool window reflows the whole list. (Notable.)
- **Hover is resolved in screen space, not parent-relative coordinates.** Crossing an internal boundary fires an exit on the component being left before the enter on the one being entered, so a naive test flickers the icons off mid-hover. (Notable.)
- **Each action icon both consumes its click and is excluded from the body-click handler.** Either one alone is insufficient across look-and-feels. (Notable.)
- **The row count published to the host header is the full list size, not the number of rows on screen.** Under the cap the header therefore reports more rows than are attached. (Notable.)
- **The expanded state outlives every refresh but not the panel.** An expanded list stays expanded as new conversations arrive, and collapses only when the panel is rebuilt. (Notable.)
- **The empty-state render path does not publish a count, but the populated path does — including for a zero-length list.** The placeholder attached during a load cycle reports zero; the placeholder is also reachable without a count being published. (Notable.)
- **Telemetry flushing rides the poll tick and is dispatched off the UI thread.** The timer fires on the UI thread and the flush is a blocking network send, so dispatching it is what keeps a slow network from freezing the tool window. It is skipped entirely when the project has no base path. (Notable.)
- **The save-side callback is installed per open, not once.** Every row click installs a fresh callback, overwriting any previous one on a reused tab. There is no chain. (Notable.)
- **The tab's title is frozen at first open.** Because tab reuse is keyed on producer-plus-session, a later refresh that resolves a different title re-opens the same tab under the old name; only closing and re-opening picks up the new one. (Notable.)
- **The panel has no scroll bar and reports its natural height.** Its content sits in a top-anchored slot so the hosting section's single shared scroll bar spans it and its siblings. (Notable.)
- **Disposal does not close the editor tabs this panel opened.** Those belong to the editor manager and outlive the tool window. (Notable.)

## Shared Behavior

- **Active session aggregator (spec 155)** — owns the fan-out, the per-producer enabled gate, the recency window, the title cascade, the unread-slice count, the dedup rule, the sort, the partial-result envelope, and the producer enumeration. The adapter beneath this panel additionally re-applies the enabled gate to both the rows and the failed-producer list before this panel sees them.
- **Commit-exclusion store** — owns the persisted exclusion sets. This panel reads them on every load, writes a single key on a toggle, and writes a batch on select-all.
- **Pin store** — owns the persisted pin list, its grouping and its coercion rules. This panel writes one entry and triggers the pinned list's reload; the pinned list itself is spec 220.
- **Conversation editor tab and its virtual file** — own the surface a row click opens, including the producer-plus-session identity that drives tab reuse.
- **Project status listener channel** — owned by the project service; this panel only subscribes and unsubscribes.
- **The hosting section frame** — owns the header, the count suffix, collapse state, the shared scroll bar, and the action-group anchor the explicit refresh is registered under.
- **Terminal session resume (spec 212)** — no longer reachable from this panel; the one surface that still offers it is the committed-memories conversation row.
