# 183 — Conversation Overlay Store

## Topic Statement

User-authored edits and deletions to an active AI conversation persist as a per-session sidecar projected over the source transcript through identity-based matching that survives index drift.

## Scope

In scope:

- Per-session storage location for edit/delete records, derived from a project root, a producer identifier, and a session identifier.
- The shape of a delete record, an edit record, and the container that holds both.
- How a record's identity is constructed and compared against a transcript entry, including the lenient rule for missing timestamps.
- How records are projected onto a list of transcript entries to produce a "displayed" view and a "deletes-only" view that are positionally aligned.
- How a save merges a new batch of records into the existing container, including precedence between conflicting records.
- How records that match entries already consumed by the summary pipeline are garbage-collected, and when the sidecar file is removed entirely.
- The interactive surface that lets a viewer add, edit, restore, and bulk-mark records, and the message protocol it uses to talk to the host.
- The save-time decision that promotes a fully-emptied conversation into the list-level hidden state.
- The read-only fallback that applies when no project root is available.

Out of scope (boundaries — referenced, not duplicated):

- Building the unread slice of a transcript that the panel renders — see [184 — Transcript Message Counter].
- Surfacing an "edited" badge or aggregating per-row metadata on the conversations list — see [155 — Active Session Aggregator].
- The list-level hidden-conversations store and what it does with the hide signal emitted on empty-after-save (its data contract is consumed here, but the store's own behavior is its own spec).
- The summary-storage pipeline that consumes a slice of overlay-projected entries and advances a cursor past them.
- Source-specific transcript parsing (how raw entries are produced from the producer's own storage).

## Data Contracts

### Sidecar location

Each session has a single sidecar JSON file at:

```
<projectRoot>/<jollimemory-state-dir>/conversation-edits/<sanitized-producer>--<sanitized-sessionId>.json
```

Both the producer string and the session identifier are passed through a conservative allow-list sanitizer before being used in the filename: alphanumerics, `-`, `.`, `_` are kept verbatim; everything else (path separators, colons, null bytes, control bytes, every other character) is replaced with `_`. An input that sanitizes to the empty string falls back to `_` so the result is never a hidden file or empty path segment.

Sanitization is required because the producer string is statically typed as a closed enum but at runtime arrives from a webview message bus and from a queue worker — a crafted message with a path-traversal producer ("../../foo") must not be able to escape the conversation-edits directory.

### Sidecar file shape

A sidecar is a JSON object with these fields:

- A version stamp set to a fixed integer.
- The producer identifier the file belongs to.
- The session identifier the file belongs to.
- An ISO 8601 timestamp marking when the file was last written.
- An ordered array of delete records.
- An ordered array of edit records.

### Entry identity

The identity tuple used for matching consists of:

- A role, one of two values denoting whether the entry was authored by the human or the assistant.
- A content string.
- An optional ISO timestamp string.

A delete record is exactly an identity tuple. An edit record is an identity tuple plus a replacement content string.

### Identity equality

Two identities compare equal when:

- Roles are equal.
- Content strings are equal.
- And either:
  - Both sides carry a timestamp and the timestamps are equal, or
  - Neither side carries a timestamp, or
  - Exactly one side carries a timestamp (lenient match).

The lenient one-sided-timestamp case exists because some producers do not emit timestamps for every entry; a record saved with a timestamp must still match a later re-read of the same entry that drops the timestamp, and vice versa.

### Input from the interactive surface

When the viewer asks the host to persist a save, the message carries:

- An array of display-list indices marked for deletion. Every value must be a non-negative integer.
- A keyed map from a display-list index (encoded as a string) to a replacement content string.

The host re-derives identity tuples from the indices using the most-recently-rendered list (see Behavior).

### Inter-surface aliases

A consumer that needs to project records onto a session must supply at minimum: a session identifier, optionally a producer (defaulting to the canonical producer when omitted, for legacy callers that pre-date the multi-producer expansion), and a list of transcript entries. The container of records is opaque to that consumer.

## Behavior

### Loading the sidecar

Given a key of `(projectRoot, producer, sessionId)`:

1. Compute the sanitized path.
2. Read the file.
3. If the read fails because the file does not exist, return "no overlay" silently.
4. If the read fails for any other reason, log a warning and return "no overlay". This case can never be silent because a corrupt sidecar that gets silently ignored would let the next summary re-include the entries the viewer had deleted; the warning is the only operator-visible signal of the drift.
5. Parse the JSON. If it is not a JSON object, return "no overlay".
6. Reject the file (return "no overlay" with a warning) when any of the following hold:
   - The version stamp does not match the current value.
   - The producer field is missing, not a string, or not a member of the closed producer enum.
   - The session-identifier field is missing or not a string.
   - The last-written-timestamp field is missing or not a string.
   - The delete or edit arrays are missing or not arrays.
   - The producer or session inside the file disagrees with the lookup key (defensive guard against post-sanitization filename collisions across producer namespaces).
7. Otherwise, walk the records:
   - For each delete record, require a valid role, a string content, and (optionally) a string timestamp. Drop malformed entries silently.
   - For each edit record, same identity requirements plus a string replacement content. Drop malformed entries silently.
8. Return the container with the kept records.

### Saving the sidecar

Given a key and a record batch:

1. Create the conversation-edits directory if it does not exist.
2. Dedupe the delete batch by identity. Order is preserved; duplicates after the first occurrence are dropped.
3. Dedupe the edit batch by identity. When multiple records share an identity, the **last** one wins (later replaces earlier in place).
4. Stamp the payload with the version, the producer and session from the key, and the current wall-clock time as an ISO string.
5. Serialize as pretty-printed JSON to `<path>.tmp`.
6. Rename `<path>.tmp` over the destination path. A successful rename is atomic at the filesystem layer, so any concurrent reader sees either the previous sidecar or the new one — never a half-written file.
7. If the rename fails, attempt to delete the temporary file as best-effort cleanup. A failure of that cleanup is swallowed: the **rename** error is what the caller must observe, not the cleanup failure. (Defensive contract: a viewer holding the destination on a non-POSIX filesystem, a cross-filesystem rename, or a sandboxed user-data directory can each cause the cleanup to fail, and surfacing the wrong error would obscure the root cause.)

### Projecting records onto entries (full view)

Given an input list of transcript entries and an overlay container:

1. If the container is null/absent, return the input unchanged.
2. Iterate the input in order. For each entry:
   - If any delete record's identity matches the entry, skip it.
   - Else if any edit record's identity matches, emit a copy of the entry with its content replaced by the edit's replacement.
   - Else emit the entry unchanged.
3. Preserve order.

When both a delete and an edit could match the same entry, the delete wins. A "deleted-then-edited" row stays gone — an edit never resurrects a deleted row.

When multiple edit records share the same identity (all match the same physical entry), the first-encountered record wins and the rest become inert. The collision is warn-logged because the rest of those records will never apply; the warning leaves a breadcrumb for any future re-keying refactor.

### Projecting records onto entries (deletes-only view)

Same as the full view, but edit records are ignored: the output is the input filtered to drop only entries matched by delete records. Edited entries retain their **original** content.

This view exists to give the interactive surface a way to derive identity tuples for newly-saved records. The deletes-only view is in 1:1 positional correspondence with the full view (same length, same order), so a display-list index against the rendered list also indexes the matching raw entry here. Deriving identities from the full (already-edited) view instead would anchor a new edit's identity to the previous edit's replacement content; that record would never match the still-unchanged source on the next pass, and chained edits would silently disappear after save+reload.

### Merging a new batch into an existing container

Given an existing container (possibly null) and a new batch of delete and edit records:

1. Seed the merged delete list with every existing delete record.
2. For each delete record in the new batch, append it unless an identity-equal record is already present (idempotent).
3. Seed the merged edit list by walking existing edits and **keeping** only those whose identity is not in the merged delete list and not also present in the new edit batch.
4. Append every new edit record whose identity is not in the merged delete list. (New edits for an identity slated for deletion are silently dropped — deletion wins, consistently with the projection precedence.)

Net effect:

- Adding the same delete twice is a no-op.
- A new edit replaces an existing edit at the same identity (chained edits collapse to one record).
- Deleting a row clears any existing or pending edit at the same identity.

### Garbage collection of consumed records

Triggered after the summary pipeline has consumed a slice of session entries (the records that match entries already absorbed into a commit summary will never affect anything again, so they are dead state):

1. For each session in the batch, in parallel:
   1. Load the sidecar (silent skip if absent or malformed).
   2. Drop delete and edit records whose identity matches any entry in the consumed slice.
   3. If no records were dropped, leave the file untouched (preserves mtime — observable as idempotency to operators watching the file).
   4. If at least one record survives, write the trimmed container back through the atomic save path.
   5. If **no** records survive, delete the sidecar entirely. (Leaving a present-but-empty file would cost one extra read per panel-open and per active-conversations refresh; deleting it lets the "missing-file" short-circuit handle those.)
2. Per-session try/catch: a load failure on one session, a write failure on another, never aborts the sweep for the rest of the batch. Errors are warn-logged.
3. If the delete inside step 1.5 fails for any reason other than "file already missing", that error rises to the per-session try/catch and is warn-logged; the sidecar remains on disk.

Identity matching during pruning uses the entry's **original** content for edit records, not the replacement content, because identity always anchors to the unchanged raw entry.

Trade-off documented at the source: the pruning step and the cursor advance it follows are not gated on successful summary storage downstream. If the summary call fails after pruning, both the cursor and the sidecar have moved past the consumed entries, so those records are effectively lost. A transactional "advance cursor and drop records only on success" refactor would fix this, but the pruning call site is itself downstream of the same trade-off — moving it alone would only produce a stale "edited" badge without recovering the data.

### Detail-view panel: opening and re-opening

The interactive surface is a per-session detail panel. Its registry is keyed by the compound key `(producer, sessionId)`; the session identifier alone is not unique because different producers can mint colliding session strings.

- First open for a given key creates a new panel, renders the initial HTML shell, and registers an on-dispose callback that removes the key from the registry.
- A subsequent open for the same key reveals the existing panel, updates its tab title to the freshly-supplied value (so a title resolved late by the producer flows in), and posts a `panelReshown` message to the webview.
- The panel keeps its DOM alive across hide/show, so a stale view would otherwise persist after the conversations list polls fresh content; the `panelReshown` message is the host's nudge to re-fetch. The webview is responsible for skipping the re-fetch if the viewer has unsaved pending edits or deletes, so that a silent refresh does not throw away in-flight work.

### Detail-view panel: read-only mode

When no project root is available, the panel:

- Skips the sidecar lookup entirely (with no project root there is nowhere to persist anything; loading would only invite picking up a stale file).
- Hides the footer and the delete buttons inline with each row.
- Still loads the transcript so the viewer can read it.

A save attempt that arrives in this mode (the buttons are hidden, but the message bus is not closed) is rejected with a save-error message back to the webview.

### Detail-view panel: building the view payload

On a "request transcript" message:

1. Load the unread slice of the transcript via the cursor-aware loader (a slice that matches what the conversations list advertises; entries already absorbed into commit summaries live before the cursor and are intentionally hidden). When no project root is available, the loader's own fallback returns the full transcript.
2. Load the sidecar (or null in read-only mode).
3. Compute the full view by projecting both deletes and edits.
4. Compute the deletes-only view by projecting only deletes. (Both lists are kept for the save path.)
5. Attach a synthetic per-entry display index to each entry of the full view: the entry's position in that list.
6. Post a `transcriptLoaded` message containing the indexed full-view entries plus a flag indicating whether the current sidecar carries any persisted modification.

### Detail-view panel: persisting a save

On a "save overrides" message:

1. Reject the message if its shape is wrong (deleted-indices is not an array of non-negative integers, or edits is not a plain object mapping strings to strings). The webview receives a save-error message.
2. Reject the message if no project root is available, with a save-error message that explains why.
3. Otherwise, reload the deletes-only view to align identity derivation with the same indices the webview emitted. (Treat the view as if no edits were applied — see "Projecting records onto entries (deletes-only view)" for why.)
4. For each deleted index, look up the entry at that position in the deletes-only view; if the position is out of bounds (a race where the source-appended view shrank), skip it; otherwise, capture its identity as a new delete record.
5. For each edit entry, parse the key as an integer; if the parse fails or the position is out of bounds, skip it. Otherwise, capture the entry's identity and pair it with the supplied replacement content as a new edit record.
6. Load the existing sidecar; merge the new batch into it; atomically save.
7. Post an `overridesSaved` message.
8. Reload the panel's view (steps from "building the view payload") and post a fresh `transcriptLoaded` so the panel reflects the persisted state and surfaces any new entries appended by the producer since the last load.
9. If — and only if — the freshly-loaded full view is now empty, write the list-level hide marker for this session, dispose the panel, and invoke the "session changed" callback followed by the "session hidden" callback (in that order, both with the session identifier). The hide marker drops the row from the conversations list on the next refresh; the dispose ends the panel before either callback fires so consumers cannot observe a still-open empty panel.
10. If at least one entry remains, invoke only the "session changed" callback so list surfaces can refresh badges and counts.

A throw at any point in steps 3–8 is caught: the original error message is logged and posted to the webview as a save-error message. The panel stays open and editable.

### Interactive surface: behaviors

Inside the webview, the rendered view is built from the most-recent `transcriptLoaded` payload. State tracked locally:

- A list of "original entries" — the payload from the host, each carrying a display index.
- A keyed map from display index to pending replacement content.
- A set of display indices marked for deletion.
- A keyed map from display index to "the currently-displayed content" (original or the latest pending replacement; allows re-entering edit mode to show the viewer's most recent draft).

Interactions:

- Clicking the per-row delete glyph toggles deletion for that row. The delete glyph changes to a restore glyph when the row is in the deleted set; clicking restore unmarks. Only the affected row is re-rendered, so scroll position is preserved.
- Clicking a row's content opens an inline edit area pre-filled with the currently-displayed content. The edit area auto-resizes to its content. On blur, the new value is captured: if it equals the original content, the pending-edit record is dropped; otherwise, the pending-edit record stores the new value.
- A "Mark all as deleted" button stages every display index into the deleted set in a single click. Pending edits at those indices are not pruned client-side; the host's save path silently drops them when deletion wins. The button disables itself when there are no entries or every entry is already marked.
- A cancel button resets every pending edit, the deleted set, and the displayed-content map back to the loaded state and re-renders.
- A save button is disabled until at least one pending edit or deletion exists. Its label shows the total pending count. Clicking it builds the save payload (deleted indices as an array, edits as a string-keyed map, dropping any edit at an index that is also in the deleted set so the wire payload stays tidy) and posts a save-overrides message.
- An "edited" notice banner is shown when the loaded sidecar carries any persisted modification, hidden otherwise.

The webview reacts to host messages:

- A `transcriptLoaded` payload replaces the loaded entries, sets the "edited" notice from the payload's flag, and resets pending state (so a save-refresh discards any pending state stranded across the save boundary).
- An `overridesSaved` message marks the save button as "Saved" until the follow-up `transcriptLoaded` arrives.
- An `overridesSaveError` message resets the save button to its enabled-with-error state and shows the error in the footer summary.
- A `panelReshown` message triggers a fresh "request transcript" only if there are no pending edits or deletions; otherwise it is ignored, preserving the viewer's unsaved work.

### Forwarding overlays to background consumers

A consumer that needs to project the sidecar over a batch of session transcripts (for example, the post-commit summary pipeline) invokes the per-session batch projector. For each session:

- The producer defaults to the canonical producer when omitted, so legacy callers that pre-date the multi-producer expansion still find their sidecar.
- Loads are fanned out in parallel; the operation depends on no inter-session ordering.
- Sessions with no sidecar pass through unchanged.
- The input list is not mutated; a fresh list of sessions is returned, each with its entries replaced by the projection.

## State Transitions

### Sidecar lifecycle

- **Absent → present**: any save with at least one record creates the file. The directory is created if needed.
- **Present → updated**: any subsequent save (atomic write-then-rename) replaces the file.
- **Present → absent**: garbage collection deletes the file when every record has been consumed; or a manual deletion outside this system (panel falls back to "no overlay" silently on the next load).
- **Stale-tmp → cleaned**: a failed rename always attempts to delete the leftover `<path>.tmp` before propagating the rename error. A double-failure (rename throws, then cleanup throws) propagates the rename error and swallows the cleanup error.

### Detail-view panel lifecycle

- **Closed → open** on request for an unseen `(producer, sessionId)` key.
- **Open → re-revealed** on request for the same key; the panel posts `panelReshown` and updates its tab title.
- **Open → disposed** when the system tears down all panels, when the user closes the panel from the UI, or when a save produces an empty merged view (in that last case the host also writes the list-level hide marker).
- **Disposed → fresh open** on any later request for the same key; the on-dispose hook ensured the key was removed from the registry.

### Conversation hide-on-empty

Entering this transition requires:

1. The viewer issued a save (either piecewise deletion of every visible row, or "Mark all as deleted").
2. The save merged successfully.
3. The follow-up reload of the full view returned zero entries.

Then: the list-level hide marker is written, the panel is disposed, and the "session changed" and "session hidden" callbacks fire (in that order). The conversations list drops the row on its next refresh.

A save that leaves at least one entry visible does **not** trigger this transition, even if every previously-visible entry was deleted but the producer appended new entries in between.

## Notable Behavior

- **Identity, not index, anchors records.** This is the central design choice. The interactive surface and the background summary pipeline view the same transcript through different lenses (full vs. cursor-trimmed slice), so a positional record scheme cannot reconcile both viewpoints. Identity makes a record survive index drift, source-app reorderings, and slice boundary changes.
- **Identity is the *raw* content, never the replacement.** Edits never change the identity tuple — they attach a replacement. This is what lets chained edits collapse correctly: a second edit at the same row matches the same identity as the first, and the merge replaces the older record in place. Deriving identity from the displayed view would key the second record to the first edit's replacement, and the new record would never match again.
- **Lenient timestamp match.** When a record has a timestamp and the live entry does not (or vice versa), it still matches. Strict equality applies only when both sides carry a timestamp. This is necessary because some producers do not consistently emit timestamps and a record saved at one moment must keep working after a re-read.
- **Identity collision is "first wins."** When two physically distinct entries share the same `(role, content, timestamp)` triple (typically a viewer retried the same prompt within the timestamp's resolution), the first matching edit record applies to every duplicate entry and any other matching records become inert. The collision is warn-logged but not rejected.
- **Closed-producer-enum allowlist on load.** Even if a sidecar file's internal producer agrees with the lookup key, the loader refuses to honor it unless the producer string is in the runtime allowlist of known producers. Without this guard a forged or stale (post-rename) file could survive into downstream code that trusts the producer to be one of the known values.
- **Filename collision after sanitization is refused.** Two different `(producer, sessionId)` keys that sanitize to the same filename are detected at load time by comparing the file's internal producer and session against the lookup key; on mismatch the load returns "no overlay" with a warning, so someone else's records cannot be applied to this session.
- **Pruning and cursor advance are not transactional with summary storage.** Records consumed by a slice are deleted from the sidecar before the slice is converted to a stored summary. If the storage step fails after pruning, those records are gone. This is a known trade-off documented at the source — moving the pruning step alone would only delay the data loss without preventing it.
- **The webview must guard `panelReshown` against silent overwrites.** Because the panel preserves its DOM across hide/show, a fresh-load triggered by `panelReshown` would call the reset path and throw away unsaved work. The webview suppresses the re-fetch when any pending edit or deletion exists; the viewer can still cancel or save to clear pending state and then click the row again to pull the latest.
- **The save path drops out-of-bounds indices silently.** A race where the source app appends or rewrites entries between the time the viewer rendered the list and the time the save arrives is treated as a fast-forward, not an error.
- **The `panelReshown` message also resyncs the tab title late.** A producer that resolves a friendly title after the first open (asynchronous title extraction is common for some producers) sees the next click update the tab title verbatim, while the in-panel header keeps its first-render value. The two surfaces are intentionally allowed to diverge for this case.
- **An empty merged view promotes the session to list-level hidden.** Hide-on-empty is exclusively a save-time decision. The list-level hide store is one-way from the panel's perspective; an unhide flow lives elsewhere.
- **Read-only mode is not just visual.** With no project root, the panel suppresses the footer and the delete buttons *and* refuses any save message that arrives via the bus, so even a spoofed message bus cannot silently succeed.
- **A double-failure on save propagates the original error.** When rename fails *and* the temporary-file cleanup also fails, the rename error is what the caller observes. The cleanup error is intentionally discarded so that the *cause* of the save failure is what surfaces.
- **Pruning is idempotent on mtime.** When the sweep finds no records to drop, it does not touch the file, so operators inspecting mtime see a stable signal rather than churn.

## Shared Behavior

- The interactive surface posts the "session changed" and (when applicable) "session hidden" signals to a consumer responsible for refreshing list views — see [155 — Active Session Aggregator] for how the conversations list consumes those signals and renders the "edited" badge from the sidecar's "has any persisted modification" flag.
- The unread-slice loader the panel uses to render the transcript advances the cursor that the summary pipeline reads from — see [184 — Transcript Message Counter].
- The list-level hidden-conversations marker written on empty-after-save is the same marker a separate "hide from list" command writes; the panel's hide-on-empty is one producer of that marker.
- The sidecar's `version` is stamped at the current value on every write; reading rejects any other value. This is a forward-only schema field — the read path has no provision for migrating older versions.
