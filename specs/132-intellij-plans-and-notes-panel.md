# IntelliJ PLANS & NOTES Panel

## Topic Statement

The PLANS & NOTES section of the JolliMemory tool window — a single newest-first list that merges Claude Code plans (auto-recorded by the Stop hook) with user-created notes (markdown files or inline snippets), tags each row with an icon that distinguishes plan from markdown-note from snippet-note and from "committed" (locked), prefixes committed rows with their short commit hash, opens the underlying file in an IDE editor on double-click, and exposes a single per-row trash affordance plus right-click and keyboard delete paths that ask for confirmation before removing.

## Scope

**In scope:**
- The two source registries the panel reads from on every refresh (the plans registry and the notes registry).
- The merge order: newest `lastModified` first.
- The icon set per row (plan-uncommitted, plan-committed, markdown-note-uncommitted, snippet-note-uncommitted, note-committed) and the per-icon meaning.
- The title rendering: plain title when uncommitted; `<8-char short hash> · <title>` when committed.
- The right-side meta label (edit count for plans; format word for notes) and the tooltip text per row.
- The trash icon on the right edge of every row, its 30-pixel click zone, and the hand cursor on hover.
- The double-click action to open the underlying file (plan: home-directory plans folder or project-state-directory plans folder; note: project-state-directory notes folder).
- The right-click context menu with a single `Remove` item.
- The Delete and Backspace key bindings on the focused list, both routed to the same remove flow.
- The remove-confirmation dialog (`Remove plan "X"?` / `Remove note "X"?`).
- The remove semantics that differ between plans (soft delete via `ignored = true`) and notes (full registry removal plus optional source-file deletion for uncommitted snippet notes).
- The visibility filter that hides plans/notes whose source file no longer exists, whose commit is on a different branch, whose archive guard says the file is unchanged from its committed snapshot, or whose entry is the committed-snapshot copy that exists only for storage.
- The empty / disabled / initializing placeholder states.
- The post-action refresh that runs on the project's status listener so the panel re-renders whenever a hook fires or a commit is made.

**Out of scope:**
- The Stop hook that writes the plans registry — separate spec.
- The note-creation form / editor — separate spec.
- The summary viewer that opens for a row's commit hash — this panel does not open it; only the file itself opens.
- The plan-archival logic that promotes a live plan into a committed snapshot — separate spec.
- The cross-branch hashing / archive-guard logic that the visibility filter consults — owned by core; this panel only calls the filter.
- The actual on-disk format of plan or note files.

## Data Contracts

### Two source registries, one merged list

The panel always renders a single flat list whose items are drawn from two registries living in the project state directory:

| Source       | Registry                                       | Item type   |
| ------------ | ---------------------------------------------- | ----------- |
| Plans        | The plans-registry file in the state directory | Plan entry  |
| Notes        | The notes-registry file in the state directory | Note entry  |

Each item is wrapped into a unified row carrying its title and a `lastModified` timestamp. The panel sorts the merged list by `lastModified` descending (newest first). When two rows have identical `lastModified`, plans render before notes.

### Per-row data

| Field          | Plan                                                            | Note                                                         |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| Title          | Plan's title (or its slug if title is blank).                   | Note's title.                                                |
| Last modified  | Plan's `updatedAt`.                                             | Note's `updatedAt`.                                          |
| Commit hash    | Plan's `commitHash` (null when uncommitted).                    | Note's `commitHash` (null when uncommitted).                 |
| Format / count | Edit count from the plan registry (e.g. `3 edits`, `1 edit`).   | Format word: `markdown` or `snippet`.                        |
| Icon           | "lock" when committed; otherwise "file-text" (plan icon).       | "lock" when committed; "comment" for snippet; "note" otherwise. |
| Source path    | Plan's source path (used for open-on-double-click).             | Note's source path (used for open-on-double-click).          |
| Branch         | Plan's branch (used in tooltip).                                | Note's branch (used in tooltip).                             |

### Title rendering

| Condition  | Rendered title                       |
| ---------- | ------------------------------------ |
| Committed  | `<first 8 chars of commitHash> · <title>` |
| Uncommitted | Plain title                          |

The middle dot (`·`) is the Unicode middle-dot. It is part of the contract (downstream styling keys off it).

### Tooltip text

Per-row HTML / multi-line tooltip:

| Row type | Tooltip lines |
| -------- | ------------- |
| Plan     | `<slug>.md` / `Branch: <branch>` / `Updated: <updatedAt>` |
| Note     | `<id>` / `Format: <markdown\|snippet>` / `Branch: <branch>` / `Updated: <updatedAt>` |

### Trash icon zone

Every row carries a trash icon glued to the right edge of the cell. The clickable zone is 30 pixels wide (icon width 16 + a 6-pixel left inset + the cell's 8-pixel right padding). The cursor switches to a hand pointer the moment the mouse enters this zone and reverts the moment it leaves.

### Empty / placeholder states

| Condition                         | Body                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Project status not yet loaded     | "Initializing Jolli Memory..."                                                              |
| Status loaded but the repository is not enabled | "Jolli Memory is not enabled for this repository." then, on a second line, "Open the Status panel to install hooks and enable it." |
| Both registries yield zero rows   | "No plans or notes yet. / Plans appear when Claude Code creates plan files. / Notes can be added with the + button." |

The not-yet-loaded and not-enabled states are **distinct**, and the not-enabled copy replaced a bare "Jolli Memory is disabled." It names the situation and points at the Status panel, so a repository that will never initialize because nothing is installed does not look like a slow load.

The empty and not-enabled bodies are centered HTML; the initializing body is plain centered text.

### Visibility filter contract

A row is included only when **all** of the following are true:

1. `ignored` is not `true`.
2. The entry is not a "committed-snapshot copy" of an already-committed item (committed-snapshot copies are filtered out — they exist only for storage and are not surfaced in the panel).
3. If the entry has an "archive guard" hash recording the file's contents at commit time, the source file still differs from that recorded hash (otherwise the file is "unchanged from committed snapshot" and is hidden).
4. If the entry is committed, its commit is reachable from `HEAD` on the current branch.
5. If the entry is uncommitted, the source file still exists on disk.

The same five rules apply to plans and notes (each with its own source-path field and its own archive-guard mechanism).

## Behavior

### Initial render

On panel construction:

1. The panel registers a project-status listener that triggers a refresh on every status change.
2. It schedules a background refresh that reads both registries and applies the visibility filter.
3. It shows the "Initializing Jolli Memory..." placeholder until the first refresh completes.

### Refresh

Each refresh runs on a background thread:

1. Read the project status. If status is null → show the initializing placeholder; if not enabled → show the not-enabled placeholder.
2. Read the plans registry — a cross-process round-trip to the shared registry loader, not a local file read.
3. Read the notes registry. The notes **directory** is likewise resolved over a round-trip rather than computed locally.
4. Apply the visibility filter to each set.
5. Wrap surviving entries into row models and merge them.
6. Sort by `lastModified` descending; on ties, plans before notes.
7. Hand off to the UI thread, which clears and rebuilds the list model. If the merged list is empty, the empty-state body is shown instead.

### Per-row rendering

The cell renderer composes each row as:

| Position | Element                       |
| -------- | ----------------------------- |
| Far left | Icon (per the icon table above) |
| Middle   | Title label (per the title-rendering table above) |
| Right of title | Meta label (edit count for plans; format word for notes), in gray |
| Far right | Trash icon, hand cursor, "Remove" tooltip |

Selection is single-row only.

### Click semantics

Three mouse handlers are attached to the list:

| Click                                              | Action                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| Single click anywhere in the trash zone of a row   | Select that row and run the remove flow.                              |
| Double click anywhere outside the trash zone        | Open the underlying file in the IDE editor.                           |
| Right click (popup trigger) on a row                | Select that row and show a single-item context menu: `Remove`.        |

The trash-zone click runs even before any selection — it implicitly selects the clicked row first.

### Keyboard semantics

The list registers two when-focused key bindings, both routed to the remove flow:

- `DELETE`
- `BACK_SPACE`

### Remove flow

The remove flow runs on every entry path (trash click, right-click `Remove`, Delete key, Backspace key):

1. Read the selected row. If none, return.
2. Compute `<itemType>` (`plan` / `note`) and `<itemName>` (the title).
3. Show a yes/no confirmation dialog: "Remove `<itemType>` \"`<itemName>`\" from the list?". Title: `Remove <Plan|Note>`.
4. On `No`, return.
5. On `Yes`, run the type-specific delete on a background thread, then ask the project's status listener to refresh.

### Plan delete

Soft delete: load the plans registry; locate the entry by slug; clone it with `ignored = true`; save the registry. The plan file on disk is **not** touched.

### Note delete

Hard delete: load the notes registry; locate the entry by id; remove it from the registry; save the registry.

Side effect: when the note was uncommitted **and** is a snippet **and** has a `sourcePath`, that source file is also deleted from disk (best-effort — IO errors are silently swallowed). Markdown notes' source files are never deleted, even on hard delete, because they may reference user content the user wants to keep. Committed notes' source files are never deleted because the note is preserved in storage by hash.

### Open-on-double-click

| Row type | Candidate paths, in order of preference                                                       |
| -------- | --------------------------------------------------------------------------------------------- |
| Plan     | The plan's stored source path; `~/.claude/plans/<slug>.md`; `<state-dir>/plans/<slug>.md`.   |
| Note     | The note's stored source path; `<state-dir>/notes/<id>.md`.                                   |

The first candidate that exists on disk is opened in the IDE editor as a normal text file. If none exists, an information dialog announces "Plan file not found: `<slug>.md`" or "Note file not found: `<id>`".

### Status-listener-driven refresh

The panel registers a status listener at construction. Every time the project status changes (hook fires, install completes, commit lands, sign-in changes), the panel re-runs the refresh. This is what causes a brand-new plan to appear in the list within milliseconds of the Stop hook writing it.

## State Transitions

```
[panel constructed]
  add status listener
  background: refreshFromDisk()

[status changes]
  background: refreshFromDisk()

[refreshFromDisk()]
  status = service.getStatus()
  if status == null → initializing placeholder
  else if !status.enabled → not-enabled placeholder
  else:
    plans = registry.plans filtered by visibility filter
    notes = registry.notes filtered by visibility filter
    items = merge(plans, notes), sort by lastModified desc, plans-before-notes on ties
    UI thread: updateList(items)

[user double-clicks a row outside trash zone]
  if PlanItem → open plan file from candidate paths
  if NoteItem → open note file from candidate paths

[user clicks trash zone, or right-click Remove, or Delete, or Backspace]
  selected = list.selected
  if none → return
  confirm = dialog("Remove <plan|note> \"<title>\"?")
  if confirm == YES:
    if plan → mark ignored=true in plans registry
    if note → remove from notes registry
              if uncommitted snippet w/ sourcePath → delete source file (best-effort)
    refresh status listener (triggers refreshFromDisk)

[panel disposed]
  remove status listener
```

## Notable Behavior

- **The list is one merged stream, not two tabs.** The user sees plans and notes intermixed in time order — there is no plans-only or notes-only filter.
- **Newest first; plans win ties.** When a plan and a note share the exact same `lastModified` timestamp (rare, but possible when both are written by the same hook tick), the plan renders above the note.
- **Trash click zone is the right 30 pixels of the row, regardless of icon position.** The hit-test is geometric, not by hovering the icon component itself, which is what makes the trash icon clickable on rows where the title is long enough to crowd it.
- **Plan delete is soft; note delete is hard.** A "removed" plan can be unmarked by editing the registry; a "removed" note is gone from the registry. This asymmetry is intentional — plans are auto-generated by the hook and can be regenerated; notes are user-authored and removing them must be definitive.
- **Snippet note delete also removes the file from disk.** Only when the note is (a) uncommitted, (b) a snippet, and (c) has a `sourcePath`. This is the only path in this panel that touches the filesystem outside of the registry files.
- **Markdown note source files are never deleted on remove.** Even when hard-deleting the registry entry — markdown notes can be user-authored documents whose loss would be data loss.
- **Committed entries hide automatically when their file equals the archived snapshot.** The archive-guard hash is what prevents a committed plan or note from re-appearing in the panel after its content is committed; the moment the user edits it again, the hash diverges and it reappears.
- **The committed-snapshot copies are deliberately invisible.** They exist in the registry only because storage needs them. Surfacing them would show a duplicate row for every committed plan.
- **Cross-branch commits are filtered.** A plan or note committed on branch `feature-A` is hidden when the user is on branch `feature-B` — the entry survives in the registry, but the panel doesn't list it.
- **No plan ever enters the registry from this surface.** Plan discovery is not performed here at all: rows appear only because another surface's transcript discovery wrote them. This panel reads, filters, renders, soft-deletes and hard-deletes; it never registers a plan. (The retired IDE-side plan discovery is recorded in its own spec.)
- **The registry read is a cross-process round-trip, but the archived bodies are not.** Enumeration goes through the shared registry loader while the archived plan/note text is read directly off the memory ref in process. So which rows exist and what a row's committed body says come from two different mechanisms and can, in principle, disagree.
- **Registry writes serialize against other surfaces' writers, best-effort.** This panel's soft-delete and hard-delete take the registry's cross-process lock through the bridge before their load-modify-save. A failed acquire does not abort the write — it proceeds unlocked — so a delete racing a concurrent discovery write can lose one side's change.
- **The double-click open path searches three candidates for plans and two for notes.** This is what makes the panel resilient to the plan file having moved between the live `~/.claude/plans` and the project's archived `<state-dir>/plans/` after a commit.
- **Right-click and Delete/Backspace are equivalent paths to the trash icon.** All four converge on the same confirmation dialog and the same per-type delete branch.
- **The empty body is informative, not minimal.** It tells the user where plans come from (Claude Code) and how to add notes (the `+` button on the section toolbar).

## Shared Behavior

- **Plans registry** — the source of plan rows; written by the agent stop hook's plan discovery and the plan-archival flow, both of which live outside this surface. This panel reaches the registry over a bridge round-trip and, for its own load-modify-save operations, takes the registry's cross-process lock through the same bridge so it serializes against those writers. **A failed lock acquisition is treated as "write without the lock"**, so a contended soft-delete can still clobber a concurrent writer.
- **Notes registry** — the source of note rows; written by the note creation/edit flow and the note-archival flow. Reached over a bridge round-trip; the notes directory path is resolved the same way.
- **Archived plan and note bodies** — read natively in process off the memory ref (a direct show-at-revision), not through the shared storage layer. Reference markdown is likewise read natively.
- **Project status listener** — drives every refresh; flips between `enabled` placeholders and the actual list.
- **Visibility filter** — shared with the VS Code Plans/Notes provider; this panel re-implements the same five rules so both surfaces show identical sets.
- **IDE editor** — the destination for double-click opens; the panel uses the standard "open file" entry point.
- **Section toolbar** — owns the `+` action that opens the note-creation form (separate spec).
- **Plan-archival flow** — the writer of the archive-guard hash that hides unchanged committed plans.
