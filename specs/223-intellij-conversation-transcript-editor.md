# 223. IntelliJ Conversation Transcript Editor

## Topic Statement

A non-modal editor tab that renders an active AI conversation's transcript as a scrollable list of role-tagged message rows with inline click-to-edit and per-message delete/restore, a bulk "mark all deleted" affordance, and a "Save All" path that persists the pending edits and deletions as an identity-based overlay — auto-hiding and closing the conversation when every message ends up deleted — opened as a reusable per-conversation tab through a dedicated virtual file and editor provider.

## Scope

**In scope:**

- The trigger: a conversation row click (or a pinned conversation) opens this tab; identical conversations reuse the same tab.
- The virtual-file contract: name is a producer-colored circle glyph plus the conversation title; read-only; identity is `(producer, session id)`.
- The provider contract: claims only this virtual-file class, fixed editor-type id, hides the default editor, available during indexing.
- The editor wrapper: display name, validity, a modified flag tied to pending edits/deletions, and a save-side callback others can install to refresh after a save/hide.
- The layout: a header (title + `<producer> · <N> messages`), a scrollable transcript body, and a footer (status text, "Mark All as Deleted", "Cancel", "Save All").
- The transcript load: read the unread transcript for the producer, load the per-session overlay, and compute both a displayed view (overlay applied) and a deletes-only view (used for identity derivation).
- The per-row anatomy: a delete/restore icon, a role label (`human` shown as `You`), an optional right-aligned timestamp, and a wrapping content area.
- The inline edit: clicking a non-deleted row's content swaps it for an editor field; on focus-loss the edited value is captured (or cleared if unchanged) and the row re-renders.
- The delete/restore toggle per row, and the bulk "mark all deleted".
- The footer state machine: enabling/labeling the buttons and composing the status text from pending counts.
- The cancel path: discard all pending edits/deletions and re-render.
- The save path: translate pending display-index edits/deletions into identity-based overlay rules (delete wins over edit), merge into the existing overlay, persist, then either auto-hide+close (if nothing remains) or reload and fire the save callback.
- The threading model: transcript and overlay I/O on a background pool; all UI on the UI thread.
- The scroll-position preservation across re-render.

**Out of scope (boundaries):**

- The overlay store's file format, identity-matching rule, merge precedence, deletes-vs-displayed projection, garbage collection, and the read-only fallback — owned by the conversation-overlay-store spec. This tab only calls load/apply/merge/save and renders the result.
- The hidden-conversations store that the auto-hide path writes to — its own spec; this tab only calls hide.
- The transcript reader / unread-transcript loader that produces raw entries — owned by the per-producer transcript spec and the message-counter spec.
- The active-conversations panel and the pinned panel that open this tab — their own specs; they construct the virtual file and install the save callback.
- The aggregator that resolves a conversation item — its own spec; this tab receives a single item via the virtual file.
- The session-title resolution that produced the title — its own spec.

## Data Contracts

### Trigger and tab reuse

The tab is opened by handing a conversation virtual file to the IDE's open-file mechanism. Two virtual files are equal iff their `(producer, session id)` match, so re-opening the same conversation surfaces the existing tab.

### Virtual-file shape

| Property | Value |
| --- | --- |
| name | a producer color-circle glyph + the conversation title (claude=orange ●, gemini=green ●, codex=purple ●, opencode=blue ●, cursor=red ●, otherwise white □) |
| extension | empty |
| writable | `false` |
| equality | `(producer, session id)` |
| carried payload | the conversation item and the working directory |

### Provider contract

| Field | Value |
| --- | --- |
| editor-type id | `jollimemory-conversation` |
| accept | true only for the conversation virtual-file class |
| policy | hide the default editor |
| available during indexing | yes |

### Editor wrapper

| Trait | Value |
| --- | --- |
| display name | `Conversation` |
| valid | always `true` |
| modified | true iff there are pending edits OR pending deletions |
| set-state | no-op |
| save callback | a settable hook fired after a successful save or an auto-hide so the opener can refresh |
| dispose | no special teardown |

### Loaded data (three projections)

| Projection | Meaning |
| --- | --- |
| raw-with-deletes-only | The raw transcript with the overlay's deletes applied but its edits NOT applied. Used to derive stable identities for save. |
| displayed | The raw transcript with the full overlay (deletes + edits) applied. What the user sees and edits. |
| (raw) | The unread transcript for the producer, re-read at save time for the auto-hide check. |

Each transcript entry carries a role, content, and an optional timestamp.

### Pending-edit / pending-delete state

- Pending edits: a map from display index → new content.
- Pending deletions: a set of display indices.
- Both are keyed by display index (the row position in the displayed view), and both are cleared on load and on cancel.

### Footer state

| Element | Rule |
| --- | --- |
| Save All button | enabled iff pending count (edits + deletes) > 0; label `Save All (<n>)` when pending, else `Save All`. |
| Cancel button | enabled iff pending count > 0 (also force-enabled the moment an inline edit field opens). |
| Mark All as Deleted button | enabled iff the number of pending deletions is less than the displayed entry count. |
| status text | comma-joined: `<n> modified` and/or `<n> deleted`. |

### Save translation rule

For each pending state, an identity-based rule is built from the **raw-with-deletes-only** entry at that index (role, original content, timestamp):

- A pending deletion → a delete rule.
- A pending edit → an edit rule carrying the new content — **unless** the same index is also pending-deleted, in which case the delete wins and no edit rule is emitted.

These new rules are merged into the existing stored overlay and persisted.

## Behavior

### Build

The tab builds a header (bold title; gray `<producer> · <N> messages` subline), a vertically-scrolling transcript area (as-needed vertical scroll bar), and a footer (status label, "Mark All as Deleted", "Cancel", "Save All"; Cancel and Save All start disabled, Mark-All starts enabled). Then it loads the transcript.

### Load

On a background pool: read the unread transcript for the producer at the conversation's transcript locator and working directory; load the per-session overlay; compute the displayed view and the deletes-only view. On the UI thread: store both projections, clear pending edits and deletions, render the rows, refresh the footer, and reset the scroll to the top.

### Render

Capture the current scroll position. Clear the transcript area. If the displayed view is empty, show a gray `No transcript entries.` Otherwise, for each displayed entry build a row and a separator below it. Append trailing vertical glue. Revalidate/repaint, then restore the captured scroll position.

### Per-row

- Role label: `human` renders as `You` (blue); any other role renders title-cased (green). The role color is theme-aware.
- Content: a non-editable, line-wrapping text area showing the edited content if pending, else the entry content. A deleted row's content is grayed and shows the default cursor; a non-deleted row shows a hand cursor and a click opens inline edit.
- Delete/restore icon: toggles the index's membership in the pending-deletion set, then re-renders and refreshes the footer. The icon and tooltip flip between Delete and Restore based on current state.
- Timestamp: if present, parsed (ISO-8601 first, else epoch-millis) and shown right-aligned as local `h:mm a`; on parse failure the raw value is shown.

### Inline edit

Clicking a non-deleted row's content replaces the row body with a multi-line code-editor field pre-filled with the current content and focuses it; Cancel becomes enabled immediately. On focus-loss: if the new value differs from the entry's original content, record it as a pending edit for that index; otherwise clear any pending edit for that index. Then re-render and refresh the footer.

### Bulk mark-all-deleted

Add every displayed index to the pending-deletion set, re-render, refresh the footer.

### Cancel

Clear all pending edits and deletions, re-render, refresh the footer.

### Save

If there are no pending edits and no pending deletions, do nothing. Otherwise: build identity-based delete/edit rules from the deletes-only projection (delete wins over edit per index), disable Save All and label it `Saving…`, then on a background pool: load the existing overlay, merge the new rules into it, persist the merged overlay. Re-read the raw transcript and re-apply the now-updated overlay to compute what remains. On the UI thread:

- If nothing remains, auto-hide: on a background pool mark the conversation hidden in the hidden-conversations store, then on the UI thread close this tab and fire the save callback.
- Otherwise reload the transcript (fresh load cycle) and fire the save callback.

On any exception during save, re-enable Save All, restore its label, and set the status text to `Save failed: <message>`.

## State Transitions

```
[opened with conversation item]
  open conversation virtual file (focus)
    [tab with same (producer, session) exists] → bring to front
    [no tab] → provider claims → build editor → load()

[load]
  background: raw ← unreadTranscript(producer, path, cwd)
             overlay ← loadOverlay(cwd, producer, session)
             displayed ← applyOverlay(raw, overlay)
             rawDeletesOnly ← applyDeletes(raw, overlay)
  UI: store projections ; clear pending ; render ; updateFooter ; scrollTop

[click non-deleted row content]
  swap row → editor field ; Cancel enabled
  on focus lost:
    edits[idx] ← newValue (or remove if == original) ; render ; updateFooter

[click delete/restore icon on row idx]
  toggle idx in deletedIndices ; render ; updateFooter

[Mark All as Deleted]
  deletedIndices ← all displayed indices ; render ; updateFooter

[Cancel]
  edits.clear ; deletedIndices.clear ; render ; updateFooter

[Save All]  (no-op if nothing pending)
  rules ← from rawDeletesOnly: deletes + edits (delete wins per idx)
  Save All disabled, label "Saving…"
  background: merge into existing overlay ; save
             remaining ← applyOverlay(reRead raw, updated overlay)
  UI:
    [remaining empty] → hideConversation(...) ; close tab ; onSaved()
    [else] → load() ; onSaved()
  [exception] → re-enable Save All ; status = "Save failed: <msg>"

[disposed]
  (no special teardown)
```

## Notable Behavior

- **Identities for save are derived from the deletes-only projection, not the displayed view.** Edits are intentionally NOT applied when computing identities, so an edit rule carries the *original* content as its match key plus the new content as its replacement — this keeps the overlay matchable against the source transcript across index drift.
- **Delete wins over edit at the same index.** If a row is both edited and marked deleted, only a delete rule is emitted; the edit is dropped at save time.
- **Saving the last remaining content auto-hides and closes the conversation.** After persisting, the tab re-reads the transcript and re-applies the overlay; if nothing remains it marks the conversation hidden and closes its own tab, then fires the save callback. This is how "delete everything" removes the conversation from the active list, not just from the tab.
- **The modified flag is live but the tab is read-only.** The editor reports modified when edits/deletions are pending (so the IDE shows a dirty dot), yet the virtual file is read-only and saving goes through the explicit Save All button, not the IDE's save mechanism.
- **An inline edit equal to the original clears the pending edit.** Editing then reverting a row's text leaves no pending edit for that index.
- **Cancel is force-enabled the instant an edit field opens**, before any change is made, so the user can always back out of an in-progress edit.
- **Mark-All-Deleted is disabled once everything is already pending-deleted.** Its enablement is "pending deletions < displayed count".
- **Scroll position is preserved across every re-render** by capturing and restoring it, but the initial load resets scroll to the top.
- **The tab name's leading glyph encodes the producer by color.** The colored circle (or white square fallback) is part of the user-visible tab title alongside the conversation title.
- **The save callback is fired on both branches** (auto-hide-and-close and reload), so the opener refreshes whether the conversation was hidden or merely edited.
- **Timestamp parsing is dual-format and lenient.** ISO-8601 is tried first, then epoch-millis; an unparseable value is shown verbatim rather than dropped.

## Shared Behavior

- **Conversation overlay store** — owns the overlay file, identity matching, the displayed/deletes-only projections, the merge precedence, and garbage collection; this tab calls load/apply/merge/save.
- **Hidden-conversations store** — the auto-hide target when a conversation is fully emptied; this tab only calls hide.
- **Unread-transcript loader / per-producer transcript reader** — produces the raw entries this tab renders and re-reads at save time.
- **Conversation virtual file** — owns the `(producer, session id)` identity and the tab name glyph; this tab is the body it opens.
- **Conversation editor provider** — ties the virtual-file class to this editor; owns the editor-type id and the hide-default-editor policy.
- **Active-conversations panel / pinned panel** — open this tab and install the save callback to refresh themselves.
- **IDE editor manager** — performs identity-based tab reuse, closes the tab on auto-hide, and routes the editor lifecycle.
