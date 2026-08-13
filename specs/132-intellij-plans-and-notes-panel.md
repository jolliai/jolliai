# 132. IntelliJ CONTEXT Panel

## Topic Statement

The CONTEXT section of the JolliMemory tool window — a single newest-first list that merges plans, notes, external references and **one aggregate row standing for every skill captured this session**, rendering each as a coloured letter badge plus a wrapping title, revealing a per-row action cluster on hover, opening a read-only rendered preview on click, and writing the next memory's leave-out set from the row's toggle — where every question about *what the data means* (which rows are visible, what removing one destroys, which skills are still uncommitted, how the skills row is labelled) is answered by a cross-process round trip to the shared implementation rather than by any rule restated in this panel.

## Scope

**In scope:**

- The two round trips a repaint makes: one that returns plans, notes, references and the leave-out set together, and a second for the active-skills projection.
- The merge order (newest-modified first) and the row cap with its "Show N more" expander.
- The four row kinds, their badge letters and accent colours, and the letter collisions across the corpus.
- Title rendering per kind, including the committed short-hash prefix on plan and note rows and the CLI-supplied label on the skills row.
- The per-row hover action cluster (pin, edit, remove, leave-out toggle) and the skills row's reduced cluster.
- The leave-out toggle: which key each kind writes, why the skills row writes every key at once, the struck-through rendering, and the failure dialogs.
- What the leave-out sets this panel reads do **not** contain, and the plan the next memory refuses without saying so.
- Row click → rendered preview; the edit action → the file's source; the right-click menu per kind.
- The delayed hover card per kind, including the skills card's ordering, cap, overflow line, em-dash rule and footnote.
- The remove flow: confirmation, the CLI-side removal, the failure dialog, and the working-context refresh that follows.
- The placeholder states and the refresh sources that drive them, including what a failed refresh renders.
- The paths that exist but cannot be reached: pin / edit / remove on the skills row, and this panel's select-all.

**Out of scope:**

- The visibility rules themselves (which plan or note rows are browsable at all) and the delete semantics (whether removing a row also unlinks its backing file) — both are decided by the shared implementation this panel calls.
- Which skills count as uncommitted, how their counters accumulate, and what an archive snapshot means.
- The aggregate skills table's own rendering — columns, ordering, dashes, markers — and the summary label's format.
- The exclusion file's format, locking and versioning.
- The bridge adapter that serves this panel its skills data (its degrade-vs-throw split and its serialization obligations).
- The section toolbar's "Add" action and the plan/note creation form.
- The letter tags, brand colours and display-title rule for reference sources.
- The commits panel's committed CONTEXT group, which renders its own aggregate skills row.

## Data Contracts

### Row kinds

| Kind | Payload | Sort timestamp |
| --- | --- | --- |
| Plan | The shared display projection of one plan row (slug, filename, file path, title, timestamps, commit hash). | The projection's last-modified value. |
| Note | The shared display projection of one note row (id, title, format, timestamps, commit hash, optional file path). | The projection's last-modified value. |
| Reference | One registry row plus its `<source>:<nativeId>` key. | The row's updated-at value. |
| Skills (aggregate) | The whole active-skills answer: the projected rows, the CLI-supplied summary label, and derived "is empty" / "any inferred" / "exclusion keys" views over them. | The **newest** member's last-modified value, or the empty string when the set is empty. |

There is at most one skills row however many skills were captured. The other three kinds carry exactly one artifact each.

### Badges

| Kind | Letter | Colour |
| --- | --- | --- |
| Plan | `P` | blue |
| Markdown note | `N` | green |
| Snippet note | `S` | amber |
| Reference | from the shared source-presentation table | from that table |
| Skills aggregate | `S` | purple |

**One letter means three different things and is disambiguated by colour alone.** `S` is a snippet note (amber), the skills aggregate (purple), and the Slack reference source (Slack purple). The same table also gives `J` to both Jira and the product's own memory-lookup source, and `Z` to both Zoom kinds. A reader who keys on the letter without the hue cannot tell them apart.

### Titles

| Kind | Rendered title |
| --- | --- |
| Plan | `<first 8 chars of commit hash> · <title>` when the row carries a commit hash; otherwise the plain title (falling back to the slug when the title is blank). |
| Note | `<first 8 chars of commit hash> · <title>` when committed; otherwise the plain title. |
| Reference | The shared display-title rule for that source. |
| Skills aggregate | The **CLI-supplied** summary label, with ` · some inferred` appended when any member was inferred rather than observed. Falls back to the literal `Skills used` when the label arrives blank. |

The middle dot is the Unicode middle dot. The skills row is the only one whose text is composed elsewhere: the same label must read identically here, in the sibling desktop editor, and in the committed aggregate document, so this panel appends a suffix and otherwise passes it through.

### Leave-out keys

| Kind | Kind name written | Key written |
| --- | --- | --- |
| Plan | plans | the plan's slug |
| Note | notes | the note's id |
| Reference | references | the `<source>:<nativeId>` key |
| Skills aggregate | skills | **every** captured skill's `<source>:<skill>` key, in one bulk write |

The skills row resolves to **no single key at all**. Every code path that maps a row to one key returns nothing for it, and each such path either refuses the row up front or is unreachable for it.

### Placeholders

| Condition | Body |
| --- | --- |
| No status snapshot yet | "Initializing Jolli Memory..." |
| Status present but the repository is not enabled | "Jolli Memory is not enabled for this repository." then, on a second line, "Open the Status panel to install hooks and enable it." |
| Enabled, and the merged list is empty | "No plans or notes yet." then "Plans appear when Claude Code creates plan files." then "Notes can be added with the + button." |

The not-yet-loaded and not-enabled bodies are distinct: a repository that will never initialize because nothing is installed must not look like a slow load. All three are centred HTML.

## Behavior

### Construction

1. Subscribe to the project status channel **and** to the working-context channel. Both are needed and neither is redundant: the refresh gates on the status snapshot's enabled flag, while a plan / note / reference moving does not go through a status recompute. The two are fired by different service methods, so one event never arrives twice.
2. Schedule the first refresh on a pooled thread.

### Refresh

Runs off the UI thread, on every fire of either channel.

1. Read the status snapshot. No snapshot → the initializing placeholder. Not enabled → the not-enabled placeholder.
2. **One round trip** returns the visible plans, the visible notes, the reference rows keyed by their map key, and all five leave-out sets at once. The panel applies no filter of its own: archive guards, committed-snapshot copies and orphaned rows are already dropped, and no branch comparison is performed anywhere — working-area context belongs to the worktree and binds to a branch only when a commit claims it. Reference rows carry no committed state at all (a commit deletes the row), so every returned reference is active.

   **All five leave-out sets arrive exactly as stored.** This round trip applies no classification of any kind on the way out — no containment check on a plan's source file, no derivation of any sort — and the panel adds none. So a row is struck through only because the user's own stored set holds its key, never because anything decided the next memory would refuse it. The sibling round trip a host uses to ask "what would the next memory claim?" does apply such a classification and marks a plan whose file belongs to another repository excluded in the set *it* answers with; that is a different operation, deliberately kept separate, and this panel does not call it. See the Notable section for what that costs here.
3. **A second round trip** returns the active skills — the rows no commit has claimed — together with their summary label. This is deliberately not a read of the raw skill registry: a skill row survives archival, so the raw map would list every skill ever used as if it were fresh working state. This call **degrades to an empty answer** rather than failing, so a skills hiccup costs one row instead of the whole repaint.
4. Wrap each item, merge all four kinds into one list, and sort by the row's timestamp descending.
5. Hand the list to the UI thread and re-render.

**A failure of the first round trip re-renders the rows already held, not an empty list.** The stored leave-out sets are only reassigned on success, so the surviving rows stay consistent with the strike-through state they were drawn with. Because the re-render works from the held list — empty until the first success — a failure on the very first refresh still lands on the real empty-state body instead of leaving the panel stuck on "Initializing". That ordering is not hypothetical: the first enabled refresh is exactly when the cross-process channel is least likely to be ready.

### Rendering

At most six rows are shown; when more exist and the section has not been expanded, a "Show N more" row is appended that expands the list permanently for the session. Each row is a wrapping panel: badge on the left, a word-wrapping title in the middle that grows the row taller as the window narrows, and a right-hand action strip that **reserves width only while hovered**, so short titles stay on one line at rest.

A row whose item is currently left out renders its title struck through and greyed.

### Hover

Entering a row tints it, reveals its action icons, and starts a one-second timer that opens the hover card below the row. Leaving it clears the tint and starts a 200 ms dismissal grace period; a mouse-exit whose source is no longer on screen clears unconditionally rather than testing whether the cursor is still inside the row. Entering the card itself cancels the dismissal.

### Action cluster

| Icon | Tooltip | Effect |
| --- | --- | --- |
| Pin | `Pin` | Records the row in the pinned section with the same badge letter the row shows. |
| Edit | `Edit Plan` / `Edit Note` / `Edit Markdown` | Opens the backing file's **source**, editable. |
| Remove | `Remove` | Enters the remove flow. |
| Leave-out toggle | `Leave out of this memory` / `Add back to this memory` | Flips the row's exclusion. |

**The skills row's cluster is the leave-out toggle alone.** It has no single document to pin, edit or remove, and pinning addresses one artifact by key.

### The leave-out toggle

1. Compute the target state as the negation of the row's current one. The skills row reads as excluded **only when its key set is non-empty and every one of those keys is excluded** — so a partially-excluded set renders as included, and the next click excludes the remainder rather than re-including what was already out.
2. Off the UI thread, write: one key for a plan / note / reference, or **every captured skill's key in a single bulk write** for the aggregate row. Leaving any skill key untouched would strand it in a state the user has no affordance to see or change.
3. A write failure logs and opens an error dialog ("Could not update whether this item is left out of the next memory"). This is a cross-process round trip, so a stopped daemon, a missing runtime or a cold-start timeout all land here; without the dialog the click would be indistinguishable from a dead control, because the row keeps its old state.
4. On success, notify the selection-changed channel, then re-read all five sets and re-render. **The re-read is best-effort**: the write has already landed, so a failure here costs a stale checkbox until the next refresh, not a lost change.

**The toggle is a plain flip for every row kind, including a plan the next memory will refuse.** The write lands, and the re-read in step 4 returns the stored sets verbatim — the read path behind it classifies nothing either — so both directions stick and both directions look the same on every kind of row. Nothing on this surface can mark a row that the commit path will drop on its own.

### Opening and editing

- **Row click** opens a read-only rendered preview, never the editor. A plan and a note open their resolved file; a reference opens a synthesised copy whose YAML frontmatter has been turned into a leading Markdown table; the skills row opens the rendered aggregate table.
- **Edit** opens the file's raw source instead, so a reference's frontmatter stays visible.
- **Right-click** offers, for a plan / note / reference: Preview, the per-kind edit entry, "Open in Browser" for a reference carrying an http(s) URL, a separator, and Remove. **For the skills row it offers Preview alone** — the row is a record of what ran, so entries that silently did nothing would be worse than their absence.

Only http and https URLs are opened externally; anything else is refused with a dialog.

### Opening the uncommitted skills table

There is no file to open: on disk each skill is its own working-area document, and the aggregate becomes a real file only once the work is committed. So the table is **rendered** through the CLI and shown as a read-only in-memory document titled `Skills used — uncommitted.md` — the same name the sibling desktop editor gives it and the same wording as the table's own heading, so the before-commit and after-commit tabs read as one pair.

Two outcomes are kept apart on purpose:

- **The render call fails** → "Could not render the skills table: …". An unreachable back end is not evidence about what was captured, and saying otherwise would point the user at the wrong problem.
- **The render call answers "nothing"** → "These skills are now archived on your latest memory — nothing new has been captured for the current working session." This is the normal state right after a commit; it is worded as where the skills *went* rather than as their absence, because the row was on screen a moment ago and "none captured" would read as a loss.

### The hover card

| Kind | Card content |
| --- | --- |
| Plan | Bold title, then the plan's filename. |
| Note | Bold title, then `Format: markdown` or `Format: snippet`. |
| Reference | Bold plain title, then `Source:`, `Tool:` and (when non-blank) `Updated:`; then, when the backing file is readable and the source declares fields, a separator and the field list; then an "Open in <source>" link when the row carries a URL. |
| Skills aggregate | Bold summary label, then one line per skill, then an overflow line, then the footnote. |

The skills card names the skills the row can only count. Members are ordered **heaviest total first, then by skill id**, matching the aggregate table's own ordering so the card and the document one click away cannot disagree about what dominated the work; the comparison is deliberately not locale-aware. At most **eight** members are listed; when more exist, a final line reads `+N more — click to open the table`. Each line reads `<skill>[ †] — <N>× · <tokens>`, where the token figure is compact (`93.8k`, `~12.3k` for an estimate) and an **em dash when the member attributed nothing** — never a zero, because a rendered zero reads as a measurement rather than as its absence. A member whose confidence is anything other than the attributed value carries the estimate marker. When any member was inferred, a trailing line explains the dagger: "† inferred from a file read, not an observed call".

The compact number is formatted with a fixed decimal separator rather than the ambient one, so a comma-decimal IDE cannot render `93,8k` here while the table one click away says `93.8k`.

**No card carries a branch line.** An uncommitted plan or note belongs to the worktree, follows the user across a checkout, and gains a branch only when a commit claims it; labelling it with whichever branch happened to be current would state something the model does not guarantee.

### Remove

1. The skills row **returns before the dialog** — it is a record of what ran, not a document the user curates; leaving it out of the next memory is the toggle's job.
2. Confirm: `Remove <plan|note|reference> "<title>" from the list?`, titled `Remove <Plan|Note|Reference>`.
3. On confirmation, off the UI thread, hand the removal to the shared implementation. **All three kinds are hard removals** — the registry row is deleted, leaving no tombstone, so re-adding the same plan or note, or re-referencing the same entity, revives it. Whether the backing file is also unlinked is decided there, not here: this panel touches no file on any removal path.
4. A failure logs and opens "Could not remove <kind>: …".
5. On success, fire the **working-context** refresh rather than a full status recompute: removing a row moves working-area state only, and this panel is on both channels so it repaints either way.

### Disposal

Dismiss any open hover card and unsubscribe from both channels.

## State Transitions

```
[panel constructed]
  subscribe status channel + working-context channel
  pooled: refresh

[either channel fires]
  pooled: refresh

[refresh]
  status == null            → "Initializing Jolli Memory..."
  status not enabled        → "not enabled for this repository"
  else:
    round trip 1 → plans, notes, references, all five leave-out sets
                   (every set exactly as stored — nothing on this path
                    classifies a row or derives an exclusion)
    round trip 2 → active skills + their summary label (empty on failure)
    merge all four kinds, sort by timestamp descending
    UI thread: render (cap 6, "Show N more" beyond)
  [round trip 1 threw] → re-render the rows already held, leave-out sets untouched

[cursor enters a row]      tint, reveal actions, start 1 s card timer
[cursor leaves a row]      clear tint, start 200 ms dismissal
[card entered]             cancel dismissal

[row clicked]              rendered read-only preview for that kind
[edit icon]                the file's raw source, editable
[right-click]              per-kind menu; skills row → Preview only

[leave-out toggle]
  target = NOT current
  pooled: plan/note/reference → write one key
          skills              → write EVERY captured key in one bulk write
    [write threw]  → dialog, stop
  notify selection changed
  re-read all five sets  [threw → stop; checkbox stays stale until next refresh]
                         (stored sets verbatim — the flip sticks on every kind)
  UI thread: re-render

[remove]
  skills row → return before the dialog
  confirm → pooled: CLI removal
    [threw] → dialog
    [ok]    → working-context refresh

[disposed]  dismiss card; unsubscribe both channels
```

## Notable Behavior

- **The skills row's pin, edit and remove paths are unreachable by construction, not dead code.** The row is never given a pin or edit icon, and its remove path returns before the confirmation dialog. The branches inside each of those functions still exist and must: narrowing on the row's absent key does not narrow its type, so the compiler requires every kind to be accounted for. (Unreachable-by-construction.)
- **This panel's select-all has no caller.** It flips every **reference** row (and only references: plans, notes and the skills row are ignored), reading "if any is excluded, include them all; otherwise exclude them all", and writes the whole set in one bulk call. Nothing in the plugin invokes it — the toolbar's select-all action targets the commits panel. (Declared-but-unreachable.)
- **Nothing here is filtered by branch, and nothing here stamps a branch.** No card carries a branch line, no row is hidden by a branch comparison, and the panel does not read the current branch at all. Working-area context is worktree-scoped and binds to a branch only at commit.
- **Removal is hard, and the panel does not decide what else it destroys.** All three removable kinds delete the registry row outright; whether the backing file is unlinked is answered by the shared implementation. This panel deletes no file on any path. (The earlier behaviour that marked a plan row with a hide flag instead of removing it is gone; nothing on this surface writes such a field.)
- **A row's title is the only thing it shows.** There is no right-hand meta label — no edit count for a plan, no format word for a note. Format survives only inside the note's hover card.
- **The skills row's label is fetched, not composed.** The count and token figure come from the CLI; this panel appends only ` · some inferred`, because the aggregate table spells the same caveat as a dagger footnote instead. A blank label degrades to the words `Skills used`.
- **A per-skill token figure is formatted here, and that is a second copy of a shared format.** The round trip returns the aggregate label, not per-row text, so the card re-derives the compact form for each member. It is pinned to a fixed decimal separator for exactly that reason; the two roundings must not disagree across one click.
- **An absent confidence marks the figure as an estimate.** The card marks anything that is not the attributed value, so a member arriving without a confidence renders with the estimate marker rather than as a measurement.
- **A partially-excluded skill set reads as included.** The aggregate reads as excluded only when every member is, so one click after a partial exclusion excludes the remainder instead of re-including what was already out. An empty key set can never read as excluded.
- **A plan whose source file lives in a different repository is shown as an ordinary, included row, and the next memory refuses it with no indication anywhere.** Neither read behind this panel classifies anything: the context round trip returns the stored leave-out sets verbatim, and so does the toggle's re-read. So such a plan is drawn un-struck, its toggle reads "leave out of this memory", and every affordance says it will be claimed. The commit-time archive step classifies the same file, drops it, and records that only in the debug log — so after a commit the row is still there, still uncommitted, with nothing on screen having changed and no warning at any point. The panel cannot notice: it never asks the question, and the answer is not in anything it receives. (Surprising.)
- **The one surface that does mark such a plan is a different round trip, which this panel does not call.** The archive-selection read folds every foreign plan's slug into the leave-out set it answers with, so a host asking "what would the next memory claim?" sees the row marked excluded while this panel, asking "what is browsable?", sees it included. The two operations are deliberately separate and answer different questions; the cost is that the same plan reads two ways depending on which one a surface asked.
- **Both the write and the re-read after a toggle can fail, and only one of them is loud.** The write opens a dialog because a silent failure leaves a control that looks dead. The re-read only logs, because the change has already landed and the cost is a stale checkbox.
- **The panel subscribes to two refresh channels deliberately.** The status channel because the refresh gates on the enabled flag; the working-context channel because a plan, note or reference moving never triggers a status recompute. They are fired separately, so an event is never delivered twice.
- **A failed repaint keeps the previous rows on screen.** What used to be a local file read is now a cross-process round trip, and the working-context channel repaints this panel whenever a plan file is saved anywhere on the machine — so one hiccup must not read as "the user has no context".
- **The skills read degrades where the context read does not.** An unavailable skills answer costs exactly the aggregate row; an unavailable context answer keeps the whole previous list.
- **Plan file resolution restates the shared layout and is knowingly left that way.** The authoritative path the CLI just supplied is tried first, and only when that file is already gone do two hard-coded fallbacks run; the whole thing returns nothing rather than guessing, so a layout change degrades to "file not found" instead of opening the wrong document. The note path asks for its directory over the bridge instead, which is the shape this one would converge on.
- **Reference previews are synthesised, not opened.** The desktop sibling's Markdown preview renders YAML frontmatter as a table automatically while this IDE's hides it, so the panel builds that table itself and opens a decorated in-memory copy; a failure to parse falls back to opening the real file unchanged. The parser handles only the flat key-value and field-list subset the writer emits.

## Shared Behavior

- **Working-area context services** — own which plans and notes are browsable, what removing any row destroys, and the reference registry; this panel calls them and re-implements none of them. They also own the plan source-file classification that decides which plans a commit will claim — applied at the commit-time archive step and on the archive-selection read, neither of which is on this panel's path.
- **Active-skills projection** — owns which skills are still uncommitted and which figures a row reports; reached here through the plugin's bridge adapter.
- **Aggregate skills rendering** — owns the summary label this panel displays and the table its preview opens (spec 323).
- **Skill capture and archival** (specs 319, 322) — own the records behind the aggregate row: what is measured, when a row is written, and what a commit freezes.
- **Exclusion selection store** (spec 188) — owns the file this panel's toggle writes, including the skills set's optional shape on disk.
- **Source presentation table** (spec 313) — owns every reference row's letter, colour and display title; this panel holds no letter table for references.
- **Pinned section** — the destination of the pin action, which addresses one artifact by key and therefore cannot serve the aggregate row.
- **Project status and working-context channels** — the two refresh sources.
- **Section toolbar** — owns the single "Add" action that opens the creation form.
