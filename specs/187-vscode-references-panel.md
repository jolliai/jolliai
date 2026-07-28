# VS Code External References Panel

## Topic Statement

The sidebar rows that surface every active external reference (issue-tracker tickets, code-host issues, knowledge-base pages, messaging-thread mentions) within the merged Context list (formerly labelled "Plans & Notes") of the sidebar's Branch tab.

## Scope

**In scope:**
- Reading the active reference set from the per-project plans registry and projecting one panel row per registry entry.
- Optional per-source filtering at read time (one provider only); the filter itself is a plain string match against a source id, not bounded to the shared display table's known ids (see "One shared per-source table governs the entire surface" in Notable Behavior).
- The migration-writeback path that re-saves the registry once on first read when load-time normalization purged legacy rows or fields.
- Sort order of the projected rows: newest "last updated" first.
- The per-row icon mapping keyed by source.
- The per-row label, secondary description, and structured hover-card data.
- The trash inline-action that hard-deletes both the registry row and the on-disk per-reference markdown file in that order.
- The checkbox inline-action that toggles the row's per-row commit-exclusion state in the project's commit-selection store, keyed by the same `<source>:<native-id>` mapKey.
- The two distinct row-activation paths: plain row click opens the local markdown file in an editor; the inline "open in browser" affordance and the hover-card "Open in <source>" link both open the upstream URL in the system browser.
- The defense-in-depth URL-scheme re-validation at the open-in-browser sink (http or https only).
- The stale-mapKey resolver run by every reference webview command before it acts.
- The right-click context menu for a reference row.
- The webview-to-host message protocol carrying the mapKey for open-in-browser, open-markdown, hard-delete, and checkbox-toggle.
- The pre-archive vs post-archive mapKey shape and how the resolver tolerates both.

**Boundaries:**
- This spec does NOT cover how references are extracted from agent transcripts (see the transcript-reference-extraction spec).
- This spec does NOT cover the on-disk persistence format of the per-reference markdown file or its frontmatter shape (see the reference-store markdown-persistence spec).
- This spec does NOT cover the commit-exclusion store layout, lock semantics, or how commit-time consumers read the exclusion sets (see the commit-exclusion-store spec).
- This spec does NOT cover the registry-load normalization that decides whether `changed` is true (see the plans-registry spec).
- This spec does NOT cover how a reference is archived into a commit summary or how the registry row is removed at commit time. The panel assumes "every active registry row is shown."
- This spec does NOT cover how plans and notes render in the same merged list; references appear alongside them as a third row type.
- This spec does NOT cover the sidebar's other Branch-tab sections (Changes, Commits, Conversations).
- This spec does NOT cover hover-card timer / positioning behaviour shared with non-reference rows.

## Data Contracts

### Source identifier enumeration

A single shared table drives every per-source display decision on this surface (icon, badge letter, badge color, and display label all come from the same table entry) — a new source is a single table row rather than a hunt across several independent switches. The table's built-in enumeration has **twelve** source ids, each with its own badge letter, row icon, badge background color, and display label:

| Source id | Badge letter | Row icon | Badge color |
| --- | --- | --- | --- |
| An issue-tracker source | `L` | `issues` | `#5e6ad2` |
| A wiki / knowledge-page source | `C` | `book` | `#1868DB` |
| A second issue-tracker source | `J` | `issues` | `#0052cc` |
| A code-host source | `G` | `issues` | `#6e7681` |
| A knowledge-base / page source | `N` | `file-text` | `#787774` |
| A messaging-thread source | `S` | `comment-discussion` | `#4a154b` |
| A video-meeting source | `Z` | `device-camera-video` | `#2D8CFF` |
| A meeting-document source | `Z` | `file` | `#2D8CFF` |
| A task / project source | `A` | `checklist` | `#f06a6a` |
| A work-management board source | `M` | `table` | `#ff3d57` |
| A library-documentation source | `7` | `book` | `#0b7285` |
| The first-party memory source | `J` | `history` | `#9B5CFF` |

Per-source display labels are used in the hover-card "Open in <source>" action and any user-facing source-name surface.

**The two meeting sources share the same badge letter `Z`** (and the same badge color); they are distinguished only by their row/hover icons — the video-meeting source renders a camera glyph, the meeting-document source renders a plain file glyph. A source id is otherwise the unique key; the letter is display-only and need not be unique.

**Two further collisions exist in the table.** The library-documentation source's badge letter `7` is the table's **first non-alphabetic glyph** — it is a digit taken from the source's own name rather than an initial, because its initial would collide with the code-host source's `C`-adjacent set. And the `book` row icon is now shared by two entries: the wiki source and the library-documentation source, distinguished only by badge letter and badge color. Both collisions are tolerated for the same reason as the meeting pair: the source id is the unique key, and letter/icon are display-only.

**A third letter collision arrived with the first-party memory source**, whose `J` is also the second issue-tracker source's letter. Tolerated on the same grounds, plus one more: the badge colors differ, and this is the only first-party brand in the table.

The table's own enumeration is not the outer bound of what this surface can display: a source id outside the twelve falls back to a **neutral projection** rather than an error — a synthesized label equal to the raw id, a badge letter equal to the id's first character uppercased, a generic linking icon (`link`), and a neutral (non-branded) badge color (`#6e7681`, the same hue as the code-host source's color). This fallback is what makes the read-time per-source filter (below) tolerant of a source id the table doesn't yet know about, and is also mirrored independently by the webview-side badge renderer so the two stay visually consistent without a round trip to the host.

The table is also the security boundary for inbound webview messages: the closed set of ids it enumerates is exactly the allow-list an inbound "open this evidence reference" message's source field is checked against before it is trusted. Adding a table row therefore also makes that source's rows openable through that path — the two are the same edit.

The neutral fallback uses an own-property lookup into the table (not a truthy check), so an id colliding with an inherited object member (e.g. `toString`, `constructor`) still resolves to the neutral projection rather than a bogus table entry.

### Registry projection

Reading the project's reference registry yields a list of zero or more entries plus a `changed` flag indicating whether load-time normalization mutated the in-memory snapshot.

For each entry, the panel projects a "reference info" row carrying:

- `source` — one of the table's twelve known source ids, or (in principle) an id outside that set, handled by the neutral fallback described above.
- `nativeId` — the source-native identifier (e.g. ticket key, `<owner>/<repo>#<number>`, page id, or a channel-plus-timestamp identifier for the messaging-thread source).
- `mapKey` — exactly `<source>:<native-id>` for pre-archive rows; the bareId portion of an archived row may carry a content-hash suffix appended by an upstream layer, so the same `<source>:<bareId-with-suffix>` form must still survive the projection unchanged.
- `title`, `url`, `sourcePath` (the absolute path of the per-reference markdown), `addedAt`, `updatedAt`, `lastModified` (initialized to `updatedAt`), and an optional `sourceToolName`. `url` is modeled as optional one layer upstream (a reference can in principle carry no link), but this projection always yields a string: an absent upstream `url` is coerced to the empty string here, so every consumer of this row can treat `url` as always present.
- An optional `fields` list of opaque `{key, label, value, icon?}` records read from the markdown's frontmatter.
- An optional `description` preview cut to the first 200 characters of the markdown body **after** the auto-generated note block has been cut off at its sentinel (see "Frontmatter parsing" step 5), so the explanatory note text never appears in a row tooltip or hover card.

### Display fields per row

| Field          | Source                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| Label          | For the three **native-id-leading tracker sources** (the two issue-tracker sources plus the code-host source): `<native-id> — <title>`. For every other source (the two knowledge-page sources, the messaging-thread source, the two meeting sources, the task/project source, the work-management board source, the library-documentation source, and any source outside the known set): `<title>` only. The tracker set is exactly the three whose nativeId is a human-recognizable key; a new source is title-only by default and opts in only if its nativeId is user-facing. The library-documentation source is title-only, so its row reads as the bare library name rather than repeating the slash-prefixed identifier alongside it. |
| Description    | A short relative-time string derived from `lastModified`.                                                      |
| Row icon       | Per-source, from the shared table (see the enumeration above): `issues` for the three tracker sources; `file-text` for the page source; a comment/discussion glyph for the messaging-thread source; `book` for the wiki source **and** for the library-documentation source; `device-camera-video` for the video-meeting source; `file` for the meeting-document source; `checklist` for the task/project source; `table` for the work-management board source; a generic linking glyph (`link`) for any source outside the known set.              |
| Selection      | A checkbox keyed by `mapKey`; checked iff the per-row commit-exclusion store does NOT carry this mapKey.       |
| Inline actions | One "open in browser" affordance and one "remove" (trash) affordance, both keyed by `mapKey`.                  |
| contextValue   | The literal `"reference"` (uniform across every source).                                                   |

### Hover-card payload

A structured hover-card record:

- `title`: same string as the row label.
- `source`: the source id.
- `fields`: omitted when the registry+frontmatter projection produced an empty field list; otherwise the same opaque `{key, label, value, icon?}` list, rendered as one row each with the field's chosen icon and value text.
- `url`: the upstream URL (already coerced to the empty string when absent, per the registry-projection note above).

The hover-card's title row is prefixed with the same colored square-letter badge used elsewhere on this surface (see "Badge color" below): the letter and background color both come from the shared per-source table (`L` / `C` / `J` / `G` / `N` / `S` / `Z` / `Z` / `A` / `M` / `7`); a source id outside the table falls back to a badge letter equal to the id's first character uppercased, on the neutral background color. The card's "Open in <source>" action falls back to the literal label "Open in Browser" when the source id has no registered display label (the same table lookup miss that drives the badge-letter fallback).

Clicking the "Open in <source>" (or "Open in browser") action dispatches the open-in-browser command through the same scheme-guarded sink that the inline "open in browser" affordance uses.

### Plain-text tooltip (activity-bar fallback)

The native tree-view surface reads a plain-text tooltip composed of:

- The label line (`<native-id> — <title>` for one of the three tracker sources, or `<title>` only for a title-only source — the two knowledge-page sources, the messaging-thread source, the two meeting sources, the task/project source, the work-management board source, the library-documentation source, or a source outside the known set).
- A blank line then one `<label>: <value>` line per field, when fields are present.
- A blank line then the URL.
- A blank line then a 200-character body preview with a trailing ellipsis when the body exceeds 200 characters.

Inside the webview, the row's native `title=` attribute is suppressed so this plain-text tooltip does not double-up with the structured hover-card.

### Webview message protocol

Outbound (webview → host):

- `branch:openReference { mapKey }` — inline affordance, hover-card action, and context-menu "Open in browser".
- `branch:openReferenceMarkdown { mapKey }` — context-menu "Open Markdown" and plain row click.
- `branch:ignoreReference { mapKey }` — inline trash, context-menu "Remove".
- `branch:toggleReferenceSelection { mapKey, selected }` — checkbox change event.

Inbound (host → webview): the panel re-renders from a refreshed projection when the plans store fires its change event, which the reference-delete and the checkbox-toggle paths both trigger after they persist.

### Commit-exclusion store key contract

The mapKey passed in `branch:toggleReferenceSelection` is forwarded verbatim into the commit-exclusion store under a fixed top-level key ("references"). The same `<source>:<native-id>` string keys the exclusion set across the panel's checkbox state and the commit-time consumer.

## Behavior

### Producing the row list

1. Load the project's plans registry. The loader returns the parsed registry and a `changed` flag.
2. If `changed` is true, take the plans lock and re-read inside the lock; if the in-lock re-read also reports `changed`, persist the normalized registry. If a concurrent writer already normalized it (the in-lock re-read reports `changed=false`), skip the save. The display list below is built from the pre-lock snapshot; the writeback is purely a one-shot migration.
3. Iterate the entries in the registry's `references` map. For each entry whose source matches the optional source filter (or every entry when no filter is set):
   - Read the per-reference markdown file at the entry's `sourcePath` and parse its frontmatter. Tolerate any I/O or parse failure by returning an empty parsed result.
   - Build the reference-info row from the registry fields plus the parsed `fields` and `description` (when each is non-empty).
4. Sort the resulting list by `lastModified` descending.

The list returned is the input to the renderer; every entry currently in the registry is by contract an "active, uncommitted" reference because commit-time consumers delete the entry as part of archival. No archive-guard filter runs on this side.

### Frontmatter parsing for the fields bag and description preview

Reading the per-reference markdown is best-effort and tolerant:

1. If the file cannot be read, return empty.
2. If the first non-blank line is not the fenced opening `---`, return empty.
3. Scan forward for a closing `---` line; if missing, return empty.
4. Between the fences, look for a single line whose trimmed text is exactly `fields:`. From that line forward, treat every line matching the pattern `<whitespace>- <text>` as a list item; parse `<text>` as JSON.
   - Skip an item whose JSON parse fails.
   - Skip an item that parses but does not match the `{key: string, label: string, value: string, icon?: string}` shape (including: not an object, missing any required string, icon present and not a string).
   - The first line inside the fields block that is not a list item resets the parser out of "in fields" mode but does not terminate frontmatter scanning; later non-list scalar lines are silently ignored.
5. After the closing fence, read the body, **truncate it at the first occurrence of the auto-generated-note sentinel** (an HTML comment; everything from it onward is discarded), then strip leading and trailing blank lines, and emit the first 200 bytes as the description preview when the result is non-empty. The truncation runs before the blank-line strip and applies regardless of which source the file names. This reader carries its own copy of the sentinel string rather than importing the writer's, so it must stay in lockstep with the persistence layer's own strip (see the reference-store markdown-persistence spec).
6. Return the collected fields (when non-empty) and the description preview (when non-empty).

### Render path (per row)

For each reference info:

1. Choose the row icon from the shared per-source table (see "Source identifier enumeration"): the page source renders `file-text`, the messaging-thread source renders its own comment/discussion glyph, every tracker source renders `issues`, the wiki source and the library-documentation source both render `book`, the video-meeting source renders `device-camera-video`, the meeting-document source renders `file`, the task/project source renders `checklist`, the work-management board source renders `table`, and a source outside the table renders a generic linking glyph (`link`). The row's leading badge (used in the merged-list context rows and the hover card) additionally carries the table's per-source background color, or the neutral fallback color for an unrecognized source — a deliberate reversal of an earlier "no brand tints" design; see "Badge color" in Notable Behavior.
2. Render the leading checkbox; its `checked` state mirrors the row's `isSelected` projection (computed by the upstream serializer against the project's commit-exclusion "references" set, with "not excluded" meaning "checked").
3. Render the label and the short-relative-date description.
4. Render the inline action group: an "open in browser" iconbutton, then a trash iconbutton, both carrying the row's `mapKey` as `data-id`.
5. Set the row's `contextValue` data attribute to `"reference"`; clear the native `title=` so it does not compete with the hover-card.

### Sort behaviour

Single sort: `lastModified` descending. There is no tie-break ordering among references with identical timestamps beyond Object-key iteration order of the underlying registry map.

### Hover-card behaviour

The hover-card opens after the shared mouseover delay (~1s), positions relative to the cursor, and stays open during a short grace period after mouseout to allow the cursor to land on the card itself. Inline-action buttons inside the row dismiss the hover-card immediately so a button tooltip does not stack on top of the card. The card's "Open in <source>" link posts the same open-in-browser command path used by the inline affordance and the context-menu entry.

### Click dispatch

When a click lands on a row with `contextValue="reference"`:

1. If the click landed on the checkbox, route through the checkbox handler (see below) and short-circuit.
2. If the click landed on the trash inline button, post `branch:ignoreReference` with the row's mapKey.
3. If the click landed on the open-in-browser inline button, post `branch:openReference` with the row's mapKey.
4. Otherwise (plain row click), post `branch:openReferenceMarkdown` with the row's mapKey.

### Checkbox change

The checkbox's change event posts `branch:toggleReferenceSelection { mapKey, selected }`. The host:

1. Calls into the commit-exclusion store, setting `(references, mapKey)` excluded when `selected` is false, and clearing the exclusion when `selected` is true.
2. Re-queries the plans store's exclusions so the projected `isSelected` for every row stays current.
3. Re-renders the panel.

### Context menu

On right-click of a reference row, the panel shows a three-item menu with a separator:

1. "Open in browser" → posts `branch:openReference` verbatim.
2. "Open Markdown" → posts `branch:openReferenceMarkdown` verbatim.
3. (separator)
4. "Remove" → posts `branch:ignoreReference` verbatim.

The native browser context menu is always suppressed inside the panel.

### Host-side stale-mapKey resolution

Every reference command on the host (open in browser, open markdown, ignore) first calls a shared resolver:

1. Read the active reference list again.
2. Find the entry whose `mapKey` equals the posted mapKey.
3. If not found, log a warning and surface a user-facing toast saying the reference is no longer in the active panel (likely archived or removed) and instructing a refresh. Return without acting.
4. If found, hand the resolved row to the bridge method for that command.

This guards against a click on a row that the webview rendered before the host store finished a refresh from a commit or a concurrent removal.

### Hard-delete

The "ignore" command:

1. Acquires the plans lock.
2. Re-reads the registry inside the lock.
3. If the mapKey is not present, releases the lock and returns (no-op).
4. Removes the entry from the registry's `references` map.
5. Writes the registry back, preserving the registry version, the `plans` section, and the `notes` section verbatim.
6. Releases the lock.
7. After the lock is released, best-effort deletes the per-reference markdown at the removed entry's `sourcePath`. A delete error is swallowed; the registry row is already gone.
8. Triggers a plans-store refresh so the panel re-renders without the row.

There is no tombstone: a future re-reference of the same logical entity re-inserts the row and re-creates the file.

### Open-in-browser with scheme re-validation

The open-in-browser handler:

1. Parses the row's `url` through the platform's URI parser.
2. If the parsed scheme is not exactly `http` or `https`, logs a warning identifying the source/nativeId/scheme, surfaces a user-facing warning toast, and returns `false`. The browser is NOT invoked.
3. Otherwise asks the platform to open the URL externally; returns the platform's success boolean.

The rationale is defense-in-depth: each upstream adapter already gates incoming URLs through `^https?://`, but the URL flows through the registry on disk (a user-editable file), so the sink revalidates rather than trusting the saved value.

### Open-markdown

The open-markdown handler resolves the row, then opens the per-reference markdown file at its absolute `sourcePath` in an editor.

## State Transitions

### Panel-level row lifecycle

| From                | Trigger                                            | To                                                              |
| ------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| (absent)            | Upstream extractor inserts a new registry entry    | Row appears at the top of the merged list on next refresh.      |
| Visible             | User toggles checkbox off                          | Row stays visible; commit-exclusion set carries the mapKey.     |
| Visible             | User toggles checkbox on (when previously off)     | Row stays visible; commit-exclusion set drops the mapKey.       |
| Visible             | User clicks trash / Remove                         | Registry row deleted, markdown file deleted, panel re-renders without the row.   |
| Visible             | Upstream consumer deletes the entry at commit time | Row disappears on next refresh; commit-exclusion entry for the mapKey may persist orphaned until garbage-collected by the exclusion store (out of scope here). |

### Stale-mapKey on click

| From               | Trigger                                                                  | To                                                              |
| ------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| User clicks a row  | Webview-cached mapKey is no longer in the registry by the time the host receives the message | Host shows a warning toast and refuses; no side-effect on registry or files. |

### Registry migration writeback

| From                              | Trigger                                                                | To                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Registry on disk has legacy fields | First panel refresh after upgrade; initial load reports `changed=true` | Plans lock taken; in-lock re-read still reports `changed=true` → normalized registry persisted once. |
| Registry on disk has legacy fields | First panel refresh after upgrade, but a concurrent process already normalized | Plans lock taken; in-lock re-read reports `changed=false` → save skipped (idempotency guard). |

## Notable Behavior

- **Active-by-construction.** The panel never filters references; every entry currently in the registry is shown. The "active" semantics are upheld upstream by removing the registry entry at commit-archive time.
- **Hard delete, not tombstone.** Removing a reference leaves no trace in the registry or on disk, which intentionally allows a later re-mention of the same entity to re-discover and re-insert it cleanly.
- **Markdown delete happens after lock release.** The registry write is the critical step; the markdown delete is best-effort and swallowed on error so a permission/lock issue can never strand the panel with an orphaned row. The inverse order (file first, then registry) would risk leaving a row pointing at a missing file on failure.
- **The webview row dispatches by `contextValue` only.** Every source collapses to the same `"reference"` contextValue; the only places that branch on the per-source table are the row label (tracker-style vs title-only), the row icon, the badge letter, the badge color, and the hover-card action label.
- **Badge color.** An earlier design rejected per-source brand tints outright (monochrome badge, default-color row icon). That rejection has been reversed: the row badge and the hover-card title badge now render with a per-source background color pulled from the same shared table that supplies the icon and letter — matching the pinned-context rows, so those surfaces read identically. A source outside the table's known set still renders, but on a neutral (non-branded) background rather than one of the twelve per-source colors.
- **The committed-memory reference rows reached that agreement late, and via a wrong default.** Their badge previously hardcoded a single hue — the *first* issue-tracker source's brand color, a leftover from when it was the only reference source — so every other source rendered in that source's colors with only the letter differing. They now generate per-source rules from the same shared table, with the kind marker carrying only the unknown-source neutral fallback. The generated per-source rules must be emitted **after** the kind marker's rule: the two selectors have equal specificity, so source order is what decides. The class token is derived from the source id with every byte outside the CSS-identifier set folded to `-`, because a source id is an open string read from disk and a raw one could otherwise end the class token early.
- **Description preview not in row, except for an accumulating source.** The description appears only in the activity-bar tooltip and (when implemented) the hover-card; the row description column is the short relative date, never the body text. Status / labels / priority drift after capture (the host does not poll), so the row stays date-only and the tooltip / hover-card carries the captured snapshot. The exception is the accumulating case described above, where the body is not a drifting snapshot but a bounded list of immutable queries, and the row would otherwise carry no distinguishing information at all.
- **`fields` is opaque end-to-end.** The renderer iterates the fields list generically (icon + value), never names a source-specific field. Adding a new field to a source requires no panel change.
- **mapKey survives post-archive suffix.** The mapKey is `<source>:<native-id>`; when the upstream registry has appended a short content-hash suffix to disambiguate post-archive variants of the same entity, the panel forwards the suffixed form verbatim. The commit-exclusion store, the registry, and the panel checkbox state all key on the identical mapKey form.
- **Scheme guard refuses non-http(s).** A hand-edited registry URL using `javascript:`, `data:`, `file:`, or any other scheme triggers a warning toast and a refusal at the open sink, even though the extractor adapters already gate their inputs. This is a "URL came from a local user-editable file → re-validate at the sink" pattern.
- **Stale-mapKey produces a toast, not silence.** Without the resolver, the underlying hard-delete would silently return when the mapKey is absent, and the open commands would no-op on a missing entry. The resolver surfaces the staleness as a refresh hint instead.
- **Single hover-card surface for plan, note, and reference rows.** The dispatcher reads a per-row `referenceHover` (or `planHover` / `noteHover`) projection off the serialized item and routes to the right renderer; the timer dance and positioning are shared across all three row types.
- **Inline-actions group differs from plans/notes.** Plan and note rows expose edit + remove; reference rows expose open-in-browser + remove (the row click already opens the markdown for editing) — except that the open-in-browser affordance is **omitted entirely** for a source with no link, see below.
- **An open-in-browser affordance is offered only when the row actually has a link.** A source may have no external destination at all (the first-party memory source records a local lookup, not a navigable artifact — spec 153). Every surface that offers the action keys off the projected `url` being non-empty: the row's inline button, the hover card's action row, and the row context menu's entry are each suppressed when it is empty. Suppression is the *only* correct handling — the sink's scheme validation would reject an empty url and raise a warning worded for a tampered link, which would read as a defect rather than as an intentionally link-less source. The sink keeps that validation regardless; this is a UI-level omission, not a replacement for it.
- **Suppression requires a RESOLVED empty url, not merely an unresolved projection.** The context menu reads the url off the serialized hover projection, looked up by row id. That lookup can come back empty for a row it cannot find — which is ignorance, not an absent link, and treating the two alike would hide the action for every source including ones with perfectly good links. So the action is withheld only when a reference projection resolved *and* carried an empty url; an unresolvable lookup keeps the action and leaves the final word to the sink's own validation. (This is the opposite default from the extraction-side server check in spec 153, and deliberately so: there, mis-attributing is worse than missing; here, hiding a working action is worse than offering one that a guard will reject.)
- **The hover card's separator rule is conditional on something following it.** The card's tail — an AI-exclusion reason block, then the action row — is assembled before the rule is emitted, and the rule is emitted only if that tail is non-empty. With no action row (a link-less source) and no exclusion reason, an unconditional rule would leave a bare line dangling under the fields with nothing beneath it. The reason block's own trailing rule, which assumes an action row follows, is likewise dropped when none does.
- **Reference rows carry a relative-date chip, in the same slot as plan rows.** The chip reads as "when this was last consulted"; for an accumulating source that is the most recent lookup rather than a creation date. The projected timestamp is required on the archived row shape, so there is no absent case.
- **An accumulating source's row sub-text carries its newest query, not just the date.** For every entity-shaped source the sub-text is the relative date alone, because captured status drifts and stale status is worse than none. An accumulating source inverts the calculation: its title is the *tool* label, identical on every row and every commit, so the date alone leaves the row carrying nothing about what happened — while the query, being a record of what was asked, cannot drift. The newest query is read back out of the body through the same entry format the persistence layer writes (spec 179), never by re-deriving that format at the display site. The gate ("does this source accumulate at all?") is part of that shared helper too, so no display site decides it independently.
- **The committed view shows the same query, from a snapshot rather than a derivation.** The uncommitted row derives the newest query from the body it can still read on disk. After commit that body lives only on the orphan branch, and the per-commit row shape is a *value snapshot* that does not carry it — so the newest query is frozen onto that snapshot at archive time, using the same shared helper, and the committed row renders it. Without this the two views contradict each other: the same reference reads as `<query> · <date>` before the commit and as a bare, commit-indistinguishable date after it. Only the newest query is snapshotted, not the body — the full list stays on the orphan branch, reachable from the row's preview action. The row's own date chip is unaffected; the query claims the sub-line slot, which is unused for a non-tracker source. The query is user-typed text and is HTML-escaped like every other untrusted string on the row.
- **One shared per-source table governs the entire surface, with an open-ended read filter.** The icon mapping, the badge-letter mapping, the badge-color mapping, and the display-label mapping are all one lookup into the same table (falling back to the neutral projection for an unrecognized id). The read-time source filter, by contrast, is a plain string-equality comparison against whatever source id a caller passes — it is not itself bounded by the table's twelve known ids, so a future source can be filtered on before it ever earns a table entry. A closed check against the table's known id set is used only where a security boundary is needed (validating an inbound webview message's source field before trusting it), not for filtering or display.
- **The table lagged the upstream catalog, and one row is still a distinct kind of glyph.** Two entries were absent from this table while their sources already existed upstream — the work-management board source and, more recently, the library-documentation source. A missing row is not an error (the neutral projection renders it), but it renders unbranded and, until added, is also excluded from the inbound-message allow-list. The library-documentation row is also the first whose badge glyph is a digit rather than a letter, and the first to reuse an icon (`book`) already claimed by another source.
- **The description preview never contains the auto-generated note.** The persistence layer appends an explanatory note block to references from sources declaring the track-only or arguments-derived flags; this panel's frontmatter reader cuts the body at that note's sentinel before taking its 200-character preview, so neither the row tooltip nor the hover card ever shows the note text. The sentinel string is duplicated here rather than imported, so it must be kept in lockstep with the persistence layer.
- **The GitHub badge letter was previously inconsistent, now unified.** One surface on this panel used to render a two-letter badge for the code-host source while every other surface rendered one letter; the shared table now standardizes on the single-letter form everywhere on this panel (and everywhere else that reads the same table).

## Shared Behavior

- The per-reference markdown's on-disk format, the sanitized filename key, and the frontmatter shape are owned by the reference-store markdown-persistence spec; this panel only reads / deletes those files.
- The plans registry and the lock that serializes its read-modify-write are shared with the plans and notes panel surfaces; this panel uses the same lock for the migration-writeback path and the hard-delete path.
- The commit-exclusion store (separate spec) owns the persistence and read semantics for the "references" exclusion set; this panel only writes one entry on each checkbox toggle and reads the set to project the row's `isSelected`.
- The transcript-reference-extraction pipeline (separate spec) is the upstream producer that inserts registry entries; this panel does not invoke it. The messaging-thread source's own capture and link-resolution behavior — including the rule that a thread with no resolvable link is never turned into a stored reference at all — is owned entirely upstream by spec 256; by the time a messaging-thread reference reaches this surface it is an ordinary registry entry, indistinguishable in shape from any other source's row. This panel's own `url`-to-empty-string coercion (see "Registry projection" above) is a general defensive default for the shared optional-`url` model, not something this messaging-thread source specifically relies on.
- The label-leads-with-native-id policy (which sources show `<native-id> — <title>` vs `<title>` alone) is defined once in a shared display-policy module reused by this panel, the committed-memory HTML view, and the CLI's own PR/commit markdown renderer, so the three surfaces cannot drift from each other.
- The merged Context section ordering with plans, notes, and references in the same list is owned by the merge-ordering helper (separate concern); this spec describes the reference row's contribution to that merge: one row per active reference, sorted with the others by `lastModified` descending, tied-break-rank "reference" last.
- The hover-card timer / positioning / dismiss logic is shared with other Branch-tab row types; this spec describes only the reference-specific renderer that fills the card body.
