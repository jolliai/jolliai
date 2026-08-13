# 187. External Reference Rows in the Context List

## Topic Statement

The rows that surface every active external reference — issue-tracker tickets, code-host issues, knowledge-base pages, messaging threads, meeting artifacts, documentation lookups, deployment records, design-file lookups, error-monitoring issues — inside the editor extension's merged context list, covering how each registry row is projected into a row, what each affordance on it does, and why no visibility filter runs on this side at all.

## Scope

**In scope:**

- Reading the active reference set from the per-project working-area registry and projecting one row per entry, with no filtering.
- The load-time normalization that **drops** any row carrying commit-claim fields or the legacy hide flag, and the one-shot write-back it triggers.
- The optional read-time per-source narrowing, and how it differs from the closed set used as a security boundary.
- The shared per-source display table — label, badge letter, row icon, badge colour — and the neutral projection for a source outside it.
- The per-row label policy, the sub-text, the structured hover card, and the plain-text tooltip the activity-bar surface uses instead.
- The best-effort read of the per-reference markdown that supplies the field bag and the body preview.
- Every affordance on a row: the include/exclude state, the pin, the edit, the removal, the preview, and the open-in-browser path — including which of them are suppressed for a link-less source.
- The host-side stale-identifier resolver every reference command runs before acting.
- The scheme re-validation at the open-in-browser sink.
- Keeping an already-open preview current when the underlying file changes.

**Out of scope (boundaries):**

- The rendered-preview surface itself — its virtual-document scheme, its restore-after-reload resolution, its tab identity (spec 329). This spec says only which row action opens one and what keeps it fresh.
- How references are extracted from agent transcripts and inserted into the registry (spec 153).
- The on-disk format of a per-reference markdown file, its file-name key, and its frontmatter shape.
- The commit-exclusion store's persistence, locking, and how commit-time consumers read its sets.
- How a reference is archived onto a commit and removed from the registry at commit time; the committed-memory surface that renders archived references.
- How plans, notes and the skill-usage row render in the same merged list (spec 114, spec 111).
- The other sections of the same sidebar tab.
- The hover card's timer, positioning and dismissal, shared with the other row types.

## Data Contracts

### Reference row in the registry

| Field | Meaning |
| --- | --- |
| source | The upstream system's identifier. |
| native id | The source-native key. |
| title | Display name. |
| url | Optional — a source may record a purely local lookup with no navigable page. |
| source path | Absolute path of the per-reference markdown, always inside the per-project state directory. |
| added-at / updated-at | ISO timestamps. |
| source tool name | The tool call that surfaced it. |

**A reference row carries no commit-claim fields.** A commit deletes the row outright rather than guarding it, so every row present is by construction active and uncommitted — which is why nothing on this surface filters.

### Load-time normalization

Every read of the registry normalizes it first, and for this kind the normalization is destructive:

| Rows dropped outright | Fields stripped from survivors |
| --- | --- |
| Any row carrying the legacy hide flag set to true, **or** a non-null commit hash, **or** a content-hash-at-commit field at all. | The hide flag, a branch, the commit hash, the content hash at commit. |

Two consequences:

- **The hide flag is a hard delete, not a soft hide.** A row carrying it does not survive the next load, and no surviving row can carry it. Nothing writes it, so it only ever fires against legacy data.
- **A legacy row that was ever claimed by a commit is destroyed on load.** This is the migration from a world where a reference had a guarded, committed state to one where it does not.

The drop is decided by the **presence of the commit-claim fields, deliberately not by a key that looks archived** — a live upstream identifier can legitimately end in eight digits, and digits are hexadecimal, so a key-shape test would silently delete active rows. A row whose key happens to end that way is therefore an ordinary active row and is projected verbatim.

The normalization also returns a "did anything change" signal, which drives the migration write-back below. It rebuilds the registry container field by field, so the sibling plan, note and skill maps are carried through.

### Row projection

Reading the registry yields the active entries plus the change signal. For each entry the panel projects a row carrying:

- The source id.
- The native id.
- The row identifier, which is exactly the registry key: the source and native id joined by a colon.
- Title, url, source path, added-at, updated-at, a last-modified initialized from updated-at, and an optional source tool name.
- An optional list of opaque `{key, label, value, icon?}` records read from the markdown's frontmatter.
- An optional body preview cut to the first 200 characters, taken **after** the auto-generated note block has been removed at its sentinel — so explanatory boilerplate never reaches a tooltip or hover card.

`url` is optional one layer upstream and an absent one is coerced to an empty string here, so every consumer can treat it as always present, with emptiness meaning "this source has no navigable page".

Rows are sorted by last-modified, newest first. There is no tie-break beyond the registry map's own key iteration order.

### The shared per-source display table

One table drives every per-source display decision on this surface — icon, badge letter, badge colour and display label are all one lookup — so a new source is one table row rather than a hunt across independent switches.

| Source | Badge letter | Row icon | Badge colour |
| --- | --- | --- | --- |
| First issue-tracker source | `L` | `issues` | `#5e6ad2` |
| Wiki / knowledge-page source | `C` | `book` | `#1868DB` |
| Second issue-tracker source | `J` | `issues` | `#0052cc` |
| Code-host source | `G` | `issues` | `#6e7681` |
| Knowledge-base page source | `N` | `file-text` | `#787774` |
| Messaging-thread source | `S` | `comment-discussion` | `#4a154b` |
| Video-meeting source | `Z` | `device-camera-video` | `#2D8CFF` |
| Meeting-document source | `Z` | `file` | `#2D8CFF` |
| Task / project source | `A` | `checklist` | `#f06a6a` |
| Work-management board source | `M` | `table` | `#ff3d57` |
| Library-documentation source | `7` | `book` | `#0b7285` |
| First-party memory source | `J` | `history` | `#9B5CFF` |
| Deployment source | `V` | `rocket` | `#4d4d4d` |
| Design-file source | `F` | `symbol-color` | `#F24E1E` |
| Error-monitoring source | `S` | `bug` | `#6559C6` |

Collisions are tolerated throughout, because the source id is the unique key and letter and icon are display-only: the two meeting sources share both letter and colour and differ only by icon; the wiki and library-documentation sources share the `book` icon; the second issue-tracker source and the first-party memory source share the letter `J` on different colours; the error-monitoring source and the messaging-thread source share the letter `S` on different colours. The library-documentation source's badge glyph is a **digit** rather than a letter.

Some colour choices are deliberate rather than incidental. The code-host source and the deployment source are both monochrome brands, and the deployment source's hue is explicitly **not** pure black: the value is emitted as a chip background, and a high-contrast theme paints the panel behind it black too, which would render the chip invisible and leave a bare floating letter. It is also kept distinct from the code-host source's lighter, blue-tinted grey so the two do not read as one source. The design-file source's own mark is multicolour, so the table commits to a single recognizable hue from it rather than trying to represent the mark.

A source id outside the table falls back to a **neutral projection**: the label is the raw id, the badge letter is the id's first character upper-cased, the row icon is a generic link glyph, and the badge colour is a neutral grey — the same hue the code-host source happens to carry. That lookup is an own-property check rather than a truthiness test, so an id colliding with an inherited object member still resolves to the neutral projection instead of a bogus entry.

The neutral colour must be the same value in three places — this fallback and the kind-marker rule in each of the two webviews that render context rows — because a webview routes an unknown source to the kind marker's class (its per-source siblings are generated from the table, so an unknown id matches none), making that rule the actually-rendered fallback.

The per-source class token used by those generated rules is derived from the source id with every byte outside the legal identifier set folded to a dash, because a source id is an open string read from disk: a raw one could otherwise end the token early and inject a second class or break the selector. The generated rules **must** be emitted after the kind marker's rule — the two selectors have equal specificity, so source order decides.

### Display fields per row

| Field | Value |
| --- | --- |
| Label | For the three **native-id-leading tracker sources** (the two issue trackers plus the code host): the native id, an em dash, then the title. For every other source, including one outside the table: the title alone. |
| Sub-text | A short relative-time string derived from last-modified — except for the accumulating sources, the first-party memory source and the design-file source; see below. |
| Row icon | Per-source, from the shared table; the generic link glyph for a source outside it. |
| Inclusion state | Keyed by the row identifier; included exactly when the per-row commit-exclusion set does **not** carry that identifier. |
| Inline actions | Pin, edit, remove, and the include/exclude toggle. |
| Row kind marker | The literal reference marker, uniform across every source. |

The label policy is defined once in a shared display module reused by this surface, the committed-memory view and the command line's own markdown renderers, so the three cannot drift.

### Hover card

A structured record carrying the same string as the row label, the source id, the field list when non-empty, and the url. The card's title row is prefixed with the same coloured square-letter badge used elsewhere on this surface, from the same table, with the same neutral fallback. Its action row offers "Open in *source*", falling back to a generic "Open in Browser" label when the source id has no registered display label; activating it dispatches through the same scheme-guarded sink the other open paths use.

**The card's separator rule is conditional on something following it.** The tail — an exclusion-reason block, then the action row — is assembled before the rule is emitted, and the rule is emitted only if that tail is non-empty; otherwise a link-less source with no exclusion reason would show a bare line with nothing beneath it. The reason block's own trailing rule, which assumes an action row follows, is likewise dropped when none does.

### Plain-text tooltip

The native tree surface reads a plain-text tooltip instead: the label line, then a blank line and one `label: value` line per field when fields are present, then a blank line and the url, then a blank line and a 200-character body preview with a trailing ellipsis when the body is longer. Inside the webview the row's native tooltip attribute is suppressed so this does not double up with the structured card.

### Message protocol

Outbound, from the webview:

- **Open in browser**, carrying the row identifier — the hover card's action and the context menu's entry.
- **Open the markdown in an editor**, carrying the row identifier — the inline edit button and the context menu's edit entry.
- **Open the rendered preview**, carrying the row identifier — a plain row click and the context menu's preview entry.
- **Remove**, carrying the row identifier — the inline trash and the context menu's remove entry.
- **Toggle inclusion**, carrying the row identifier and the new state.

Inbound: the panel re-renders from a refreshed projection whenever the working-area store fires its change event, which both the removal and the inclusion toggle trigger after they persist.

### Commit-exclusion key contract

The row identifier is forwarded verbatim into the commit-exclusion store under its references key. The same string keys the exclusion set across the row's inclusion state and the commit-time consumer.

## Behavior

### Producing the row list

1. Load the working-area registry. The loader returns the normalized registry and the change signal.
2. If the signal is set **and** the in-process disabled mirror is not, take the registry lock and re-read inside it; persist only if the in-lock re-read also reports a change. If a concurrent writer already normalized it, the save is skipped. The display list is built from the **pre-lock** snapshot; the write-back is purely a one-shot migration.
3. Iterate the registry's reference entries. For each entry whose source matches the optional per-source narrowing (or every entry when none is set):
   - Read the per-reference markdown at the entry's source path and parse its frontmatter, tolerating any read or parse failure by returning an empty result.
   - Build the row from the registry fields plus the parsed field list and body preview, each included only when non-empty.
4. Sort by last-modified, descending.

No archive-guard filter runs on this side, because there is no guarded state to filter.

### Frontmatter parsing

Best-effort and tolerant:

1. An unreadable file yields nothing.
2. If the first non-blank line is not the opening fence, yield nothing.
3. Scan forward for a closing fence; if missing, yield nothing.
4. Between the fences, find a line whose trimmed text is exactly the field-list key. From there, treat every line matching "whitespace, dash, space, text" as a list item and parse the text as structured data. Skip an item that fails to parse, and skip one that parses but does not match the `{key, label, value, icon?}` shape — including a non-object, a missing required string, or a non-string icon. Already-collected items are kept. The first line inside the block that is not a list item takes the parser out of list mode but does not stop scanning; later non-list lines are ignored.
5. After the closing fence, read the body, **truncate it at the first occurrence of the auto-generated-note sentinel**, strip leading and trailing blank lines, and emit the first 200 characters as the preview when the result is non-empty. The truncation runs before the blank-line strip and applies regardless of source. This reader carries its own copy of the sentinel rather than importing the writer's, so the two must be kept in lockstep.

### Row rendering

1. Choose the row icon from the shared table, or the generic link glyph for an unknown source. The leading badge additionally carries the table's per-source background colour, or the neutral fallback.
2. Render the inclusion state. The checkbox element remains in the document as the state holder for the change handler, but the visible affordance is a strikethrough include/exclude toggle in the hover action cluster, which flips the checkbox and redispatches its change event — so the wire protocol is unchanged. The toggle's glyph reads **both** strike axes: any struck row (user-excluded or soft-excluded by the summarizer) offers "add back"; only a fully normal row offers "leave out".
3. Render the label and the sub-text.
4. Render the inline action cluster: pin, edit, remove, then the include/exclude toggle, each carrying the row identifier.
5. Set the row's kind marker and clear the native tooltip attribute so it does not compete with the hover card.

Pin is suppressed while viewing another repository's memories read-only.

### Click dispatch

When a click lands on a reference row:

1. A click on the inclusion checkbox routes to the inclusion handler and short-circuits, so selecting never also opens anything.
2. A click on an inline button routes by that button's action — pin, edit (open the markdown in an editor), or remove.
3. **Any other click on the row opens the rendered preview.** This is the change from the earlier behaviour, where a plain row click opened the raw markdown file: every context row now previews on click, and reaching the real file is an explicit action.

### Context menu

Right-clicking a reference row shows: **Preview**, then **Edit Markdown**, then **Open in Browser** — included only when the row's url resolved and is non-empty — then a separator, then **Remove**. The native browser menu is always suppressed inside the panel.

### Inclusion toggle

The toggle posts the row identifier and the new state. The host sets the identifier excluded when the new state is "not included" and clears the exclusion otherwise, re-queries the exclusion sets so every row's projected state stays current, and re-renders.

### Stale-identifier resolution

Every reference command on the host first runs a shared resolver: re-read the active reference list, find the entry whose identifier equals the posted one, and — if it is absent — log a warning, surface a toast saying the reference is no longer in the active panel (likely archived or removed) with an instruction to refresh, and return without acting. Only a resolved row is handed to the action.

This guards a click on a row the webview rendered before the host finished refreshing after a commit or a concurrent removal. Without it the removal path would silently return and the open paths would silently do nothing.

### Removal

Removal is a **rule owned by the command line and shared by both IDE hosts**, not a per-host implementation.

1. Take the registry lock.
2. Re-read the registry inside it.
3. If the identifier is absent, release and return.
4. Delete the entry and write the registry back, rebuilt field by field so the plan map, the note map **and the skill map** are carried through — removing one reference must not erase the skill registry.
5. Release the lock.
6. After the lock is released, best-effort delete the per-reference markdown. A missing file is tolerated and any error is swallowed, because the row is already gone.
7. Refresh the working-area store so the panel re-renders without the row.

Reference markdown always lives inside the per-project state directory, so — unlike plan and note removal — no internal-versus-external location test is needed. No tombstone is written: a later re-mention of the same entity re-discovers the row and re-creates the file.

### Open in browser

1. Parse the row's url through the platform's parser.
2. If the scheme is not exactly one of the two web schemes, log a warning naming the source, native id and scheme, surface a warning toast, and return without invoking the browser.
3. Otherwise ask the platform to open it externally and return the platform's result.

This is defence in depth: each upstream adapter already gates incoming urls, but the url flows through a user-editable registry on disk, so the sink re-validates rather than trusting the saved value.

### Opening the markdown

The resolved row's markdown file is opened at its absolute path in a text editor, editable.

### Keeping an open preview current

A reference preview is a rendered virtual document, so unlike the plan and note previews — which hand a real file to the built-in preview and get re-rendering for free — the body it was opened with is the body it keeps. Two paths push a change at it, both ending in the same lookup: re-read the active reference list, find the row whose source path is the changed file, and refresh that preview.

1. **A document save.** Every markdown save in the workspace reaches this handler. It returns early unless the saved path is under the references tree, and again unless a reference preview is actually open.
2. **A watcher over the references tree**, on create and change, matching all descendants rather than only the current one-directory-deep layout so a future deeper layout does not silently stop matching. It applies the same open-preview gate before the lookup.

Both gates exist for the same reason: listing active references costs a registry parse plus one synchronous file read per active row, and with no preview open the refresh is a guaranteed no-op — so the lookup behind it would buy nothing. An out-of-band rewrite (an agent re-observing the same tool call) produces no save event at all, which is the half the watcher covers.

### The activity-bar surface

The native tree row is a separate surface with the same per-source icon and the plain-text tooltip above, and its **click still opens the raw markdown file** rather than the preview. It has no inline actions and no hover card.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Absent | Upstream extraction inserts a registry row | Row appears in the merged list on the next refresh |
| Present, on disk with commit-claim fields | Any load | **Gone** — the row is dropped during normalization and the cleaned registry is written back once |
| Present, carrying the hide flag on disk | Any load | **Gone** — dropped during normalization |
| Visible, included | Toggle off | Still visible, struck through; the exclusion set carries the identifier |
| Visible, excluded | Toggle on | Still visible, unstruck; the exclusion set drops the identifier |
| Visible | Remove | Registry row deleted, markdown file deleted, panel re-renders without it |
| Visible | A commit claims it | Row disappears on the next refresh; a stale exclusion entry may outlive it |
| Rendered in the webview, gone from the registry | Any command clicked on it | Warning toast; no change to the registry or to any file |

## Notable Behavior

- **Active by construction; nothing here filters.** Every row in the registry is shown. The "active" semantics are upheld upstream by deleting the row at commit time, and reinforced at load time by dropping any row that still carries commit-claim fields. (Notable.)
- **The hide flag is a hard delete, not a soft hide.** A row carrying it is destroyed at the next load rather than being hidden and recoverable. Nothing writes it. (Surprising; reality.)
- **A legacy claimed row is destroyed on load, silently.** The migration has no report and no undo; the row's archived copy in summary storage is what survives. (Surprising; reality.)
- **The drop predicate is field-based, never key-shaped.** A live upstream identifier can end in eight digits, and digits are hexadecimal, so a "looks archived" key test would delete active rows. Consequently a row whose identifier ends that way is an ordinary active row here. (Notable.)
- **Removal is one command-line rule, run by both hosts.** It hard-deletes the row and its markdown with no tombstone, which is what lets a later re-mention re-discover the entity cleanly. (Notable.)
- **The markdown is deleted after the lock is released.** The registry write is the critical step; the file delete is best-effort and swallowed, so a permission or lock problem can never strand the panel with a row it cannot remove. The reverse order would risk a row pointing at a missing file. (Notable.)
- **The registry rebuild carries every sibling map.** Removing one reference must not erase the plan, note or skill maps — each is optional, so a rebuild that forgets one erases it with nothing failing to compile. (Notable.)
- **A plain row click previews; reaching the real file is explicit.** This inverts the earlier behaviour, and it is what makes every context row — plan, note, reference — behave the same way on click. The raw file is reachable from the inline edit button and the context menu's edit entry. (Notable.)
- **The activity-bar row did not follow.** Its click still opens the raw markdown, so the same reference behaves differently depending on which of the two surfaces it is clicked in. (Surprising; reality.)
- **An open preview does not refresh itself, so two mechanisms push at it.** A rendered virtual document keeps the body it was opened with; a save handler and a tree watcher each re-resolve the row and refresh it. Both are gated on a preview actually being open, because the lookup is expensive and otherwise buys nothing. (Notable.)
- **There is no inline open-in-browser affordance any more.** The inline cluster is pin, edit, remove and the include/exclude toggle; the browser lives in the hover card's action row and the context menu. (Notable.)
- **The open-in-browser entry is offered only when the row actually has a link.** A source may record a purely local lookup with no navigable page. Suppression is the correct handling: the sink's scheme validation would reject an empty url and raise a warning worded for a tampered link, which reads as a defect rather than as an intentionally link-less source. The sink keeps that validation regardless — this is a presentation-level omission, not a replacement for it. (Notable.)
- **Suppression requires a RESOLVED empty url, not merely an unresolved projection.** The menu reads the url off the serialized hover projection by row identifier, and that lookup comes back empty for a row it cannot find — which is ignorance, not absence. Treating the two alike would hide the action for every source. So the action is withheld only when a projection resolved *and* carried an empty url; an unresolvable lookup keeps the action and leaves the last word to the sink. (Deliberately the opposite default from the extraction-side check in spec 153: there, mis-attributing is worse than missing; here, hiding a working action is worse than offering one a guard will reject.) (Notable.)
- **The scheme guard refuses anything but the two web schemes.** A hand-edited registry url using a script, data or file scheme produces a warning toast and a refusal at the sink, even though the extractors already gate their inputs — the url passed through a user-editable file on the way. (Notable.)
- **A stale identifier produces a toast, not silence.** Without the resolver the removal would silently return and the open commands would silently no-op. (Notable.)
- **The visible inclusion affordance is a strikethrough toggle, but the checkbox is still the state holder.** The toggle flips the hidden checkbox and redispatches its change event, so the host round trip is unchanged. Its glyph reads both the user's own exclusion and the summarizer's soft exclusion. (Notable.)
- **The read-time per-source narrowing is an open string comparison; the closed set is used only as a security boundary.** Display always falls back to the neutral projection, so a source can be narrowed on before it ever earns a table row — while an inbound "open this evidence reference" message's source field is checked against the table's enumerated ids before being trusted. Adding a table row therefore also makes that source openable through that path. (Notable.)
- **The table is permitted to lag the upstream catalogue, by design tolerance rather than by contract.** Sources have existed upstream while absent here, and nothing fails when one does; a missing row is not an error, but it renders unbranded and is excluded from the inbound-message allow list until added. The table carries a row for every catalogued source today, which is a fact about today and not a guarantee. (Notable.)
- **The deployment source's badge hue is deliberately not black.** It is emitted as a chip background and a high-contrast theme paints the panel black behind it, which would leave a bare floating letter with no chip silhouette. (Surprising; intentional.)
- **The generated per-source colour rules must follow the kind marker's rule.** Equal specificity means source order decides which wins. (Notable.)
- **The field list is opaque end to end.** The renderer iterates it generically and never names a source-specific field, so adding a field to a source needs no change here. (Notable.)
- **The body preview never contains the auto-generated note.** The persistence layer appends an explanatory block to references from sources declaring the track-only or arguments-derived flags; this reader cuts the body at that block's sentinel before taking the preview. The sentinel is duplicated here rather than imported, so it must be kept in lockstep. (Notable.)
- **An accumulating source's sub-text carries its newest query, not just a date.** The first-party memory source and the design-file source both accumulate; every other source is entity-shaped. For an entity-shaped source the sub-text is the relative date alone, because captured status drifts and stale status is worse than none. An accumulating source inverts that: its title is the *tool* label, identical on every row and every commit, so a date alone leaves the row saying nothing about what happened — while the query, being a record of what was asked, cannot drift. The newest query is read back out of the body through the same entry format the persistence layer writes, never by re-deriving that format here, and the "does this source accumulate at all?" gate is part of that same shared helper. (Notable.)
- **The committed view shows the same query from a snapshot rather than a derivation.** After a commit the body lives only in summary storage and the per-commit row shape does not carry it, so the newest query is frozen onto that shape at archive time using the same helper. Without this the same reference would read as query-plus-date before the commit and as a bare date after it. Only the newest query is snapshotted; the full list stays in storage, reachable from the preview action. The query is user-typed text and is escaped like every other untrusted string on the row. (Notable.)
- **The migration write-back is skipped only on the in-process disabled mirror.** Nothing here consults the durable on-disk disable state, so inside a long-lived server process the write-back still runs against a durably disabled project. (Notable.)

## Shared Behavior

- The working-area registry, its atomic-write primitive, and the lock that serializes read-modify-write cycles over it are shared with plans, notes, skill usage, the discovery scans, the commit-time pipeline and both IDE hosts.
- The removal rule, and the load-time normalization that drops claimed rows, are owned by the command-line working-area service (spec 337) and reached identically by both hosts.
- The per-reference markdown's on-disk format, its sanitized file-name key and its frontmatter shape are owned elsewhere; this surface only reads and deletes those files.
- The commit-exclusion store owns the persistence and read semantics of the references exclusion set; this surface writes one entry per toggle and reads the set to project each row's inclusion state.
- The transcript-reference extraction pipeline (spec 153) is the upstream producer. The messaging-thread source's own capture and link-resolution behaviour — including the rule that a thread with no resolvable link never becomes a stored reference at all — is owned there; by the time such a reference reaches this surface it is an ordinary row. This surface's own empty-url coercion is a general defensive default for the shared optional-url model, not something that source relies on.
- The label policy (which sources lead with a native id) is defined once in a shared display module reused by this surface, the committed-memory view and the command line's own markdown renderers.
- The rendered-preview surface, its virtual-document identity and its restore-after-reload resolution are owned by spec 329; this surface only opens one and pushes refreshes at it.
- The merged ordering of plan, note, reference and skill rows in one list is owned by the merge helper; this spec describes only the reference row's contribution — one row per active reference, sorted with the others by last-modified descending, and — on an exact timestamp tie — ranked after plan and note rows and ahead of the single aggregate skill row.
- The hover card's timer, positioning and dismissal are shared with the other row types; this spec describes only the renderer that fills the card body.
