# VS Code Note Editor Webview

## Topic Statement

The note workflows that produce two kinds of notes — text snippets created in a dedicated webview that captures a title and inline body, and markdown-file notes created via a file picker that links to an existing `.md` file on disk without copying it — both persisted to the per-repository note registry and surfaced in any per-commit summary they get associated with.

## Scope

**In scope:**
- The dedicated webview that creates a new text snippet (title plus content textarea, save button).
- The non-webview file-picker path that registers a user-selected markdown file as a note from the summary panel.
- The shared note-registry data the two paths both write to: `id`, `title`, `format` (`snippet` or `markdown`), `sourcePath`, timestamps, branch, optional `commitHash`, optional `ignored` flag, optional `contentHashAtCommit` archive guard.
- How the two formats differ in storage: snippet bodies are written to a per-repository notes folder as a `.md` file owned by the product, markdown notes reference an arbitrary `.md` file the user picks (no copy is made).
- The save flow for snippets in the dedicated webview (title required, content required, Ctrl/Cmd-Enter shortcut, post-save behavior of opening the saved file in an editor and disposing the webview).
- The save flow for markdown notes invoked from the summary panel (file picker, registration, archive into the orphan branch, association with the summary's commit).
- Delete behavior: deleting a snippet removes the registry entry and the snippet's source `.md` file from disk if no commit has archived it; deleting a markdown note removes the registry entry but never touches the user's source file.
- Branch-aware visibility: a note is hidden from the sidebar when the current branch differs from the branch the note was created on.
- The archive-guard behavior that hides a note after it has been associated with a commit unless its current content has diverged from the snapshot taken at archive time.
- Singleton lifecycle of the dedicated snippet webview.

**Out of scope:**
- The on-orphan-branch storage of associated note content — covered by the orphan-branch storage topic.
- The summary panel's note section UI (translation, preview, editing, association/dissociation flows beyond add/remove) — covered by the summary panel topic.
- Plans (the parallel plan registry has its own topic).
- Cross-branch listing or merging behavior of notes when commits move across branches (out of scope for the current product).

## Data Contracts

### Note formats

| Format | What it stores | Where the body lives |
| --- | --- | --- |
| `snippet` | Title and inline body. | A `.md` file the product creates inside the repository's per-repository notes folder. The registry's `sourcePath` points at that file. |
| `markdown` | Title and a reference to a markdown file the user picked. | The user's original file (anywhere on disk). The registry's `sourcePath` points at that file; no copy is made. |

### Registry entry

A registry entry is keyed by an opaque slug-like `id`. Each entry carries:

| Field | Meaning |
| --- | --- |
| `id` | Unique identifier; for new entries derived from the title via slug-cased lowercasing plus a 4-character random suffix; for entries archived to a commit, `<original-id>-<short-hash>`. |
| `title` | Display title. For markdown notes that have a source file, the title is re-extracted from the file's first `# ` heading on every read. |
| `format` | `snippet` or `markdown`. |
| `sourcePath` | Absolute path to the file the body lives in (snippet: product-owned; markdown: user-owned). |
| `addedAt` | First creation timestamp. |
| `updatedAt` | Last modification timestamp. |
| `branch` | Branch name at creation time. |
| `commitHash` | `null` while the note is unassociated; set to the commit hash once archived; the archive process also creates a sibling `<id>-<short-hash>` entry whose `commitHash` is set, while the original entry is kept as an "archive guard". |
| `ignored` | Optional flag set by the remove-from-commit and ignore actions; entries with this flag are hidden from the sidebar. |
| `contentHashAtCommit` | Optional SHA-256 of the body at archive time. Used as the archive guard. |

### Snippet save (dedicated webview)

The webview gathers exactly two fields:

| Field | Constraint |
| --- | --- |
| Title | Required (non-whitespace). Save is disabled until non-empty. |
| Content | Required (non-whitespace). Save is disabled until non-empty. |

On save, the webview posts a `saveNote` message with the trimmed title and content. The host then:

1. Generates a slug-based id.
2. Writes the content to `<id>.md` in the per-repository notes folder.
3. Creates the registry entry with `format=snippet`, `sourcePath` pointing at the new file, `commitHash=null`, `branch` set to the current branch.
4. Opens the new file in an editor.
5. Disposes the webview.

The webview supports Ctrl/Cmd-Enter as a save shortcut equivalent to clicking Save. While a save is in flight, the Save button is disabled and re-enabled only on `noteSaved` or `noteError` from the host.

### Markdown-note save (file picker, from summary panel)

Invoked by the summary panel's "Add markdown note" button. The host:

1. Opens a file picker filtered to `.md` files.
2. On selection, registers the file as a note with `format=markdown`, `sourcePath` pointing at the user's file, `title` extracted from the file's first heading (or the basename when there is no heading).
3. Archives the note into the orphan branch and associates it with the summary's commit.
4. If association fails, marks the new entry as `ignored` so it does not linger in the sidebar.
5. Updates the summary's note list and re-renders the panel.

### Delete semantics

| Action | Snippet | Markdown |
| --- | --- | --- |
| Delete-from-registry (e.g. unassociated note removed) | Source `.md` in the notes folder is unlinked **iff** the entry has never been archived (`commitHash === null`). The registry entry is removed. | Registry entry is removed. The user's source file is **never** touched. |
| Remove-from-commit | The entry is unassociated from the commit and marked `ignored` so it does not reappear in the sidebar; the source file is preserved (the orphan branch retains its archived copy). | Same as snippet for the registry; user's file untouched. |

### Branch-aware listing

The sidebar's "detect notes" pass filters out:

- Entries with `ignored = true`.
- Entries whose `branch` field is set and differs from the current branch.
- Archive-guard entries whose current body still hashes to `contentHashAtCommit` (i.e. unchanged since archive — no need to re-show the user a frozen note).
- Archive-guard entries whose body is unreadable.
- Sibling entries with `commitHash` set but no `contentHashAtCommit` (these are the per-commit snapshot copies; they exist only for orphan-branch storage and the summary panel, not for the sidebar).
- Entries with `commitHash === null` whose `sourcePath` no longer exists on disk.

The remaining entries are sorted newest-first by their `lastModified` time (the source file's mtime when present, else the registry's `updatedAt`).

### Archive guard

When a note is associated with a commit:

1. The current body is read and hashed (SHA-256).
2. The original registry entry is kept; `contentHashAtCommit` is set to the hash, `commitHash` is set to the commit, and `ignored` is cleared.
3. A sibling entry `<id>-<short-hash>` is written with `commitHash` set and no `contentHashAtCommit`. This is the entry the summary references.
4. For snippets, the original `<id>.md` body file is unlinked (its content lives on the orphan branch under the new sibling id from now on).

Subsequent listings hide the original entry as long as the body hashes to `contentHashAtCommit`. As soon as the body diverges (the snippet was edited via the summary panel; the markdown file's content drifted), the entry reappears in the sidebar so the user can decide whether to re-archive.

## Behavior

### Opening the snippet webview

1. If a snippet webview already exists, reveal it in the active editor column and (if a new post-save callback was passed) update the callback. Return.
2. Otherwise create a singleton panel in the active editor column with view-type `jollimemory.noteEditor` and title "Add Text Snippet".
3. Generate a per-render nonce; build the HTML with a CSP gating inline styles and scripts on that nonce. Set the panel's HTML.
4. Install dispose and message handlers. The dispose handler clears the singleton entry.

### Snippet save

1. The webview reads the trimmed title and content.
2. If either is empty, set the inline error and return without sending.
3. Disable the Save button.
4. Post `saveNote` with the trimmed values.
5. The host generates the id, writes the body file, creates the registry entry, and posts `noteSaved` back.
6. The webview shows the brief "Note saved" green feedback, re-enables the Save button.
7. The host opens the new file in the active editor and disposes the panel.

If the save throws, the host posts `noteError` with a message; the webview shows it inline and re-enables the Save button.

### Markdown-note save

1. The summary panel invokes the file picker filtered to `.md`.
2. On selection, the host registers the note with `format=markdown` and the picked path as `sourcePath`.
3. The host archives the note into the orphan branch and associates it with the summary's commit.
4. On archive failure, the host marks the new entry as `ignored` and surfaces an error toast.
5. On success, the host adds a `NoteReference` to the summary's note list, persists the updated summary, and triggers a full panel re-render.

### Delete

1. For "remove from commit" (summary panel), confirm with a modal.
2. Update the summary to drop the note from the list; persist.
3. Mark the registry entry as `ignored` so it does not reappear in the sidebar.
4. The orphan-branch archive copy is **not** removed by this action — it lives with the commit.

For the standalone "delete" path (sidebar-driven removal of an unassociated note):

1. If the entry's `commitHash === null` AND the format is `snippet` AND the `sourcePath` exists, unlink the file.
2. Markdown notes never get their source file touched.
3. Remove the registry entry entirely (not just `ignored`).

### Branch switch

The note registry is not migrated on branch switch. Listing simply filters by `branch`, so notes created on a different branch disappear from the sidebar without being deleted; switching back makes them reappear.

## State Transitions

Per registry entry:

| From | Trigger | To |
| --- | --- | --- |
| Nonexistent | New snippet save / new markdown-note registration | Unassociated (`commitHash = null`) |
| Unassociated | Source file deleted from disk (snippet) | Hidden (filtered out by listing) |
| Unassociated | Associated with a commit | Two entries: the original kept as archive guard with `contentHashAtCommit`; a sibling `<id>-<short-hash>` with `commitHash` set; snippet body file unlinked |
| Archive-guard entry | Current body hashes equal to `contentHashAtCommit` | Hidden from sidebar |
| Archive-guard entry | Current body diverges (or for markdown, the user's file changed) | Visible in sidebar; user can re-archive |
| Sibling commit-hash entry | Always | Hidden from sidebar (used only by the orphan-branch archive and summary panel) |
| Any | Marked `ignored` | Hidden from sidebar |
| Unassociated | Standalone delete | Removed from registry; for snippets, source file unlinked |

## Notable Behavior

- **Two creation paths, one registry.** A snippet goes through a dedicated webview; a markdown note goes through a file picker invoked from the summary panel. Both end up writing the same registry entry shape; the only persistence difference is who owns the body file. (Notable.)
- **Markdown notes are references, not copies.** Picking a `.md` file does not duplicate it into the product's notes folder. The registry stores the absolute path; reads resolve through it. The trade-off: moving or deleting the user's file orphans the note, but the user retains full control over the canonical document. (Surprising; intentional.)
- **The snippet webview opens the saved file before disposing.** After the registry is written, the user is dropped into the canonical file in an editor — so further edits go through the regular file editor, not the webview. The webview's job ends at "create a snippet"; ongoing editing is the editor's job. (Notable.)
- **Branch-aware listing is filter-only.** Notes created on `feature/foo` do not appear on `main` even though their entries are physically present. Switching back makes them reappear without any sidebar refresh. (Notable.)
- **The archive guard hides notes that have not changed since being committed.** A note that was associated with a commit and has not been touched since is "done" — re-showing it in the sidebar would invite the user to re-attach it to a different commit unnecessarily. The instant the body diverges from the archive snapshot, the entry reappears. (Surprising; intentional.)
- **Snippet body files are unlinked on archive; the orphan branch becomes the canonical source.** Once a snippet is associated with a commit, its body file in the notes folder is gone; reads of "what does this note say?" go through the orphan-branch reader (whose look-up keys on the new sibling id `<original-id>-<short-hash>`). (Surprising; intentional.)
- **Markdown notes never get their source file deleted.** Deleting a markdown note from the registry, removing it from a commit, even fully unlinking the registry entry — none of these touch the user's `.md` file. The product is a non-destructive note manager for markdown files. (Notable.)
- **Title for markdown notes is re-extracted on every read.** If the user edits the file's `# ` heading, the next sidebar refresh reflects the new title without needing a re-registration. The registry's `title` field is a fallback for files whose heading has been removed. (Notable.)
- **Slug generation has a 4-hex-character random suffix.** Two notes with the same title get different ids (e.g. `my-note-3a1c` vs. `my-note-9be0`). Without the suffix, retitling would silently collide and the second save would either lose data or overwrite the first. (Notable.)
- **The dedicated webview is a singleton.** The user cannot have two snippet editors open simultaneously; opening "Add Text Snippet" while one is open reveals the existing panel. (Notable.)
- **Save in the snippet webview requires both title AND content.** Empty content with a title is rejected client-side; empty title with content is rejected client-side; both empty disables the Save button. (Notable.)
- **Ctrl/Cmd-Enter is a save shortcut.** While the Save button is enabled (both fields non-empty), the keyboard shortcut clicks it. While disabled, the shortcut is a no-op. (Notable.)
- **`ignored` entries are hidden but not deleted.** Marking an entry `ignored` keeps it in the registry forever — it reappears only if a future operation (e.g. re-association with a different commit) clears the flag. The intent is to make remove-from-commit a "stop reminding me about this" rather than a destructive action. (Notable.)
- **The sibling commit-hash entry exists for storage, not the sidebar.** Listing the sidebar deliberately filters those out so the user does not see two rows per archived note (the original / archive-guard and the sibling). (Notable.)
- **Per-commit snippet content lives in the summary's note reference.** When a snippet is associated with a commit, the snippet's body is also stored inline on the `NoteReference` carried by the summary. This is what lets the summary panel render the snippet without reading the orphan branch. (Notable.)

## Shared Behavior

- **Note registry file** — the same per-repository registry the plans subsystem uses (notes and plans coexist; their fields are mostly parallel).
- **Orphan-branch storage** — the archive into the orphan branch uses the same primitives as plan archiving.
- **Per-repository jollimemory state directory** — hosts the snippet body files (`<id>.md`) and the registry.
- **Summary panel** — the consumer surface for note references; the host of the markdown-note file-picker action; the editor of inline note content for snippets.
- **Plans** — a sibling concept with its own creation flows, registry section, and association semantics; the two share the registry file but operate independently.
- **Branch detection** — the same current-branch read used elsewhere drives the branch-aware listing filter.
