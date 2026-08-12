# 111. Creating a Note in the Editor Extension

## Topic Statement

How a note comes into existence in the per-project working-area registry from the editor extension — the dedicated snippet-composer webview whose body the product owns and writes to disk, and the markdown file-picker path that references a file the user already has without copying it — including what each entry point does after the row is written, and what removing a note destroys.

## Scope

**In scope:**

- The two note formats and the one thing that actually differs between them: who owns the body file.
- The dedicated snippet-composer webview: its fields, its validation, its keyboard shortcut, its singleton lifecycle, and what happens after a successful save.
- The two markdown file-picker entry points and how they diverge after registration.
- The two snippet entry points and how they diverge after registration.
- Identifier generation for a new note.
- Title resolution at save time and at display time.
- What removal destroys, and the rule that decides whether the body file goes with the row.
- The fields a note row does **not** carry, and what the loader does to them.

**Out of scope (boundaries):**

- The visibility gates that decide whether an existing note row is listed, including the content-hash archive guard (spec 114).
- The full command-line-owned working-area service that owns the save, remove and archive operations (spec 337).
- Where an archived note's bytes go: the summary-storage backend and its layers.
- The memory-detail panel as a surface — its layout, its inline note editor, its translation affordance, and everything it does that is not "bring a new note into being".
- Plans (spec 114, spec 29) and external references (spec 187), which share the same registry file but have their own lifecycles.
- Row layout, icons, hover cards and menus in the context list.

## Data Contracts

### The two formats

| Format | What the row means | Who owns the body file |
| --- | --- | --- |
| Snippet | A block of text the user composed inside the product. | The product. The body is written to a file named after the note's identifier, inside the per-project state directory's notes folder. |
| Markdown | A pointer to a markdown file the user already has. | The user. The file is referenced **in place**; no copy is ever made. |

Both formats are file-backed, and every read of a note's content goes through its recorded source path. The format discriminant is validated on save and any other value is rejected.

### Note row

| Field | Meaning |
| --- | --- |
| id | Primary key. |
| title | Display name. |
| format | Snippet or markdown. |
| source path | Absolute path of the file holding the body. |
| added-at / updated-at | ISO timestamps. |
| commit hash | Null while unclaimed; the claiming commit's full hash once archived. |
| content hash at commit | Written when a commit claims the row; drives the archive guard (spec 114). |

### Fields a note row does NOT carry

| Field | What happens to it |
| --- | --- |
| Hide flag | A row carrying it set to true is **dropped from the registry** on the next load. Survivors have the field stripped. Nothing in the product writes it. |
| Branch | Stripped from every survivor. A note belongs to the worktree, follows the user across a checkout, and binds to a branch only when a commit claims it — the branch is recorded on that commit's stored memory, never on the row. |

**The hide flag is a hard delete, not a "stop reminding me about this".** Setting it does not hide the row and does not leave it recoverable; the row and everything on it are gone at the next load. Every place that once marked a note hidden now removes it outright instead.

### Identifier generation

A new note's identifier is derived from its title — lower-cased, non-alphanumeric runs collapsed to a separator, leading and trailing separators trimmed, capped at forty characters — plus a four-hexadecimal-character random suffix. A title that yields nothing after that reduction falls back to a bare prefix plus the same suffix. Two notes with the same title therefore get different identifiers.

### Title resolution

- **At save:** the caller's title if it is non-empty, else the body file's first heading, else the file's base name.
- **At display:** re-extracted from the file's first heading only for a **markdown-format, unclaimed** note whose file exists. A snippet's title and a claimed note's title come from the registry.

## Behavior

### Saving a note

1. Read the registry; ensure the per-project notes folder exists.
2. Resolve the body location: an existing row's recorded source path wins; otherwise a markdown-format save takes the caller's content **as a path** and references it in place; otherwise (a new snippet) the content is written to a file named after the generated identifier inside the notes folder.
3. Resolve the title.
4. Build the row over any existing one, preserving that row's added-at and commit hash.
5. Under the registry lock, re-read and merge the single row — preferring the **fresh** row's added-at if one appeared since the pre-lock read, because a concurrent claim may have created it.

The merge is per-key: a concurrent writer touching a different note, plan or reference survives.

### The dedicated snippet composer

**Opening.** If a composer is already open, it is revealed in the active editor column (and any newly supplied post-save callback replaces the old one); no second one is created. Otherwise a singleton panel is created in the active editor column, its markup is built with a fresh per-render nonce gating inline styles and scripts, and dispose / message handlers are installed. The dispose handler clears the singleton slot.

**Fields.** Exactly two: a title and a content area. **Both are required.** The Save control stays disabled until both are non-whitespace, and a click with either empty sets an inline error naming the missing one and sends nothing. Ctrl/Cmd-Enter activates Save while it is enabled, and is a no-op while it is disabled.

**Saving.** Save is disabled for the duration of the request, and the trimmed title and content are posted to the host. The host writes a snippet-format note, then:

1. Posts a saved acknowledgement, which shows a brief confirmation and re-enables Save.
2. Invokes the post-save callback the opener supplied.
3. Opens the newly written body file in an editor.
4. Disposes the panel.

A failure posts an error message instead, which is shown inline and re-enables Save; the panel stays open.

### The markdown file picker — sidebar entry point

1. Open a file dialog filtered to markdown, single selection. A cancelled dialog ends the flow.
2. Save the picked path as a markdown-format note with an empty title, so the title falls back to the file's first heading and then its base name.
3. Refresh the context list.
4. Open the user's file in an editor.

Nothing is archived and no commit is involved.

### The markdown file picker — memory-detail entry point

1. Verify the commit this panel is showing has not been rewritten. This check runs **before** the picker, so the user is never asked to choose a note that would be bound to an orphaned commit.
2. Open the same filtered file dialog.
3. Verify the commit again — an amend can land while the dialog is open.
4. Save the picked path as a markdown-format note.
5. Archive the note onto this commit and attach the returned reference to the commit's stored memory, then persist and re-render.

**If the archive step fails, the just-created row is hard-removed** and an error is surfaced. This is a genuine delete, not a hide: the row and (per the removal rule below) any product-owned body file are gone.

### The snippet composer — memory-detail entry point

The memory-detail panel carries its own inline snippet form. It rejects empty content, re-verifies the commit, writes a snippet-format note, archives it onto the commit, attaches the reference, persists, re-renders, and acknowledges to its webview. **The same hard-remove-on-archive-failure rule applies.**

### Claiming a note for a commit

The **original** key is written back as the guard row — same fields plus the commit hash, a refreshed updated-at and a content hash. No sibling registry row is created; the short-hash-suffixed key exists only inside summary storage and on the commit's stored memory. After storage, a **snippet's** body file is unlinked, because its content now lives in summary storage; a markdown note's user-owned file is untouched.

A note whose content cannot be read is not claimed at all — the operation returns nothing and the registry is left alone.

### Removing a note

One fresh read inside the registry lock resolves the key, gates it, and deletes it.

- **Without an expected commit hash** (the context list's own "Remove", and the archive-failure cleanup above): the exact key is deleted unconditionally if present.
- **With an expected commit hash** (a memory dissociating its context, behind a modal confirmation): delete the exact key only if that row still carries that commit hash; otherwise split an archived-looking key into its base and delete the base only if *that* row still carries it. A registry key is a single time-evolving slot, so gating on ownership stops a dissociation from an *old* commit wiping a row that has since moved on.

An unknown key is a no-op. After the lock is released, the backing file is unlinked **only when it lives inside the per-project state directory**. A failed unlink is swallowed — the row is already gone, so it cannot strand state.

No tombstone is written, so nothing prevents the same file being registered again later.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Absent | Snippet composer save / markdown pick | Unclaimed row; for a snippet, a product-owned body file exists |
| Absent | Memory-detail snippet or markdown pick | Unclaimed row, then immediately claimed by that commit |
| Absent | Memory-detail pick whose archive step fails | Absent again — the row is hard-removed |
| Unclaimed | Body content changes | Unclaimed; a markdown note's title is re-read from the file on the next listing |
| Unclaimed | Claimed by a commit | Guard row on the **same** key; a snippet's body file is unlinked |
| Guard row | Content still matches the stored hash | Hidden from the context list (spec 114) |
| Guard row | Content diverges | Visible again, commit hash retained |
| Any | "Remove" from the context list | Gone; body file deleted only if it lives in the per-project state directory |
| Any | Dissociated from the commit that owns it | Gone, gated on that ownership; the archived copy in summary storage is preserved |
| Any | Carried the hide flag on disk | **Gone on the next load** |

## Notable Behavior

- **The hide flag is a hard delete.** It reads like a reversible "stop showing me this" and behaves like destruction: any row carrying it is dropped during normalization, and the field is stripped from every survivor. Nothing writes it, so it only ever fires against legacy data — silently. Every flow that used to set it now removes the row outright. (Surprising; reality.)
- **Markdown notes are references, not copies.** Picking a file does not duplicate it into the product's own folder; the row stores the absolute path and every read resolves through it. Moving or deleting the user's file orphans the note, and that trade is deliberate — the user keeps a single canonical document. (Surprising; intentional.)
- **A snippet's body file is deleted the moment a commit claims it.** From then on the content lives in summary storage under the suffixed key, and the row's recorded source path points at a file that no longer exists. (Surprising; intentional.)
- **Removal is decided by LOCATION, never by format or state.** The backing file is unlinked only when it sits inside the per-project state directory. Snippets are there and markdown notes usually are not, which is why the rule *looks* like "snippets only" — but a markdown note the user aimed at a file inside that directory would have that file deleted on remove. A host that instead keyed on "unclaimed and snippet-format" deleted a different set of files than the other host did for the same user action. (Notable.)
- **Claiming writes no sibling registry row.** The claimed key stays the original key and becomes the guard; the short-hash-suffixed key exists only in summary storage and on the commit's stored memory. (Notable.)
- **An archive failure destroys the note that was just created.** Both memory-detail entry points create the row first and archive second, so a failure leaves nothing behind rather than a stranded unclaimed note. There is no retry and no draft. (Notable.)
- **The composer requires BOTH a title and content.** Neither field is optional, the Save control is disabled until both are filled, and the keyboard shortcut inherits that disabled state. (Notable.)
- **The composer hands the user off to the real editor and closes.** Its job ends at "create a snippet"; every subsequent edit goes through the ordinary file editor. (Notable.)
- **Only one composer can be open at a time.** Asking for a second reveals the first, and — if the new request carried its own post-save callback — silently replaces the callback the first one was created with. (Notable.)
- **Identifiers carry a random suffix, so two notes titled the same never collide.** Without it, the second save would overwrite the first. (Notable.)
- **A markdown note's title is re-read from its file on every listing, but only while it is unclaimed.** Editing the file's heading changes the displayed title with no re-registration; once a commit claims the row, the registry's stored title is what shows. (Notable.)
- **There is no branch anywhere in this flow.** A note belongs to the worktree and stays listed across a checkout exactly like uncommitted code; the loader strips any branch it finds. (Notable.)
- **The memory-detail entry points check twice that the commit has not been rewritten** — once before opening the picker or the confirmation, once after — because an amend can land while a modal is open and would otherwise bind the note to an orphaned commit. (Notable.)

## Shared Behavior

- The registry file, its atomic-write primitive, and the lock that serializes read-modify-write cycles over it are shared with plans, external references, skill usage, the discovery scans, the commit-time pipeline, and both IDE hosts.
- The save, remove and archive operations are owned by the command-line working-area service (spec 337) and reached identically by both IDE hosts; the visibility gates that decide whether a saved note is listed are described in spec 114.
- The first-heading-else-filename title extraction is the same rule used for plans and everywhere else a markdown file needs a display title.
- The content guard hash is computed over the source file's bytes identically at claim time and at visibility-evaluation time.
- The archived-key split (a base key plus a short commit-hash suffix) used by the ownership-gated removal is shared with the commit pipeline's own key handling.
