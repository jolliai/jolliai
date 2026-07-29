# VS Code Plan and Note Archive Guards

## Topic Statement

The content-hash guard the plans-and-notes registry uses to hide a plan or note from the sidebar after it's been associated with a commit, while keeping it visible the moment its source content changes again, so users see "this is now archived; if you edit it, it's a new artifact" without losing the ability to keep iterating on the same file.

## Scope

**In scope:**
- The shape of a registry entry, including the fields that drive guard behavior: `slug` / `id`, `sourcePath`, `commitHash`, `editCount`, `addedAt`, `updatedAt`, `contentHashAtCommit`, `ignored`, plus the `format` discriminant for notes (snippet vs markdown).
- What "archive" does to the entry: writes `commitHash`, writes `contentHashAtCommit` (SHA-256 of current source content), clears `ignored`, and creates a sibling `<slug>-<shortHash>` snapshot entry the orphan branch / Summary WebView consume.
- The sidebar visibility rule: an entry whose `contentHashAtCommit` is set is hidden when the live source content still hashes to the guard value, and shown again when it differs.
- The user-hide rule (`ignored = true`): hides from the sidebar regardless of any other field.
- The interaction between the two: an explicit user-hide trumps content-hash logic; clearing `ignored` (via the panel's "Add" / Associate flow) restores the content-hash decision.
- The "snapshot copy" rule: entries with `commitHash` set AND no `contentHashAtCommit` are hidden from the sidebar (they exist for orphan-branch storage / Summary WebView only).
- The orphan-source-file rule: an uncommitted entry whose source file no longer exists is hidden; for plans only, the next sidebar load also evicts that entry from the registry as a one-shot cleanup.

**Out of scope:**
- The orphan-branch storage that holds the snapshot (where the bytes go on the special branch).
- The Summary WebView's UI for picking a plan/note to associate with a commit.
- The post-commit hook pipeline that writes the archive entries from the CLI side. This spec covers the registry's *visibility* model, agnostic of which code path called the archive.
- Cross-project plan attribution (covered in its own spec); guards apply once the entry is in the registry.
- Slug / ID generation rules (a slug is a filename minus `.md` for plans; for notes it's a kebab-cased title plus a 4-char random suffix). The format is opaque to this spec.

## Data Contracts

### Plan registry entry

| Field | Type | Meaning |
| --- | --- | --- |
| `slug` | string | Stable identifier; matches the markdown filename's stem in the global plans directory. |
| `title` | string | First `#` heading of the source file, falling back to the filename. |
| `sourcePath` | absolute path | Where the plan markdown lives on disk (under the global plans directory for fresh entries; archive snapshots reference the same path). |
| `addedAt` | ISO 8601 | First time the plan was registered. |
| `updatedAt` | ISO 8601 | Last registry mutation. |
| `commitHash` | string \| null | Null while uncommitted; the commit's full hash once associated. |
| `editCount` | number | Times the source file has been edited (maintained by the agent stop-hook, not the guard logic). |
| `contentHashAtCommit` | string \| undefined | SHA-256 of the source content captured at archive time. Presence of this field flips the entry into "archive guard" mode. |
| `ignored` | boolean \| undefined | When true, the entry is force-hidden from the sidebar regardless of any other field. |

### Note registry entry

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable identifier (kebab-cased title + 4-char random suffix). |
| `title` | string | Display title (first `#` heading for markdown, or the user-given title). |
| `format` | `"snippet"` \| `"markdown"` | Snippet notes are stored as a file inside the per-repo notes directory; markdown notes reference an arbitrary user file. |
| `sourcePath` | absolute path \| undefined | The file on disk that holds the content. |
| `addedAt` / `updatedAt` | ISO 8601 | Same as plans. |
| `commitHash` | string \| null | Same role as plans. |
| `contentHashAtCommit` | string \| undefined | Same role as plans — SHA-256 of the current content captured at archive time. |
| `ignored` | boolean \| undefined | Same force-hide semantics. |

The plan registry and the note registry live side-by-side in a single per-repo file: `<workspaceRoot>/.jolli/jollimemory/plans.json` (notes are stored under a `notes` map alongside the `plans` map).

### Archive operation

When a plan or note is associated with a commit (from the Summary WebView's "+ Associate" affordance, or the post-commit hook):

1. Compute `contentHashAtCommit = SHA-256(current source bytes)`.
2. Update the original entry in place: set `commitHash` to the new commit's full hash, set `contentHashAtCommit` to the value above, clear `ignored`, set `updatedAt` to now.
3. Create a sibling registry entry whose key is `<slug>-<shortHash8>` (or `<id>-<shortHash8>` for notes); this snapshot copy carries `commitHash` but has no `contentHashAtCommit`.
4. Write the source content into the orphan branch under the snapshot key.

After step 4, two entries exist in the registry for the same source artifact:

- The original key, with `contentHashAtCommit` set — the **archive guard**.
- The `-<shortHash8>` key, without `contentHashAtCommit` — the **snapshot copy**.

Each plays a distinct visibility role.

### Sidebar visibility rule

The sidebar (PLANS panel for plans; the merged Plans-and-Notes view) renders only entries where every gate below passes. Entries are evaluated independently — there is no global "hide all archived" flag.

| Gate | Pass condition |
| --- | --- |
| Ignored guard | `ignored !== true`. |
| Archive guard | If `contentHashAtCommit` is set: source file must exist AND its current SHA-256 must differ from `contentHashAtCommit`. If `contentHashAtCommit` is unset: pass. |
| Snapshot-copy guard | If `commitHash !== null` AND `contentHashAtCommit` is unset: hide (it's a snapshot copy intended for orphan-branch / Summary WebView). |
| Source-file-deleted guard | If `commitHash === null` AND source file does not exist: hide (uncommitted artifact whose file the user removed). |

For notes, the archive guard has one extra wrinkle: the source content read can be either the snippet file (for snippet notes) or the user's referenced file (for markdown notes). The hash compared is over whichever current bytes are present. If the source file cannot be read at all, the entry is hidden.

### Orphan cleanup (plans only)

On every panel-load pass, plan entries that are uncommitted (`commitHash === null`), have no archive guard (`contentHashAtCommit` is unset), are not user-hidden (`ignored !== true`), AND whose source file does not exist are evicted from the registry. The pass is one-shot convergent: a subsequent load with no orphans performs no writes.

The note registry has no analogous cleanup pass — notes whose source file is missing are simply hidden by the source-file-deleted guard.

## Behavior

### Associating a plan or note with a commit

1. Read the source bytes; compute `contentHashAtCommit`.
2. Update the original registry entry: set `commitHash`, `contentHashAtCommit`, `updatedAt`; clear `ignored`.
3. Create the snapshot-copy entry under `<slug>-<shortHash8>` / `<id>-<shortHash8>` with `commitHash` set and no `contentHashAtCommit`.
4. Write the source content to the orphan branch under the snapshot key.

After this completes:
- The original entry is hidden from the sidebar (archive guard fires because the live content still hashes to `contentHashAtCommit`).
- The snapshot-copy entry is hidden from the sidebar (snapshot-copy guard fires).
- Both entries are visible to the Summary WebView and orphan-branch consumers.

### Editing the source after archiving

1. The user opens the plan / note source file and edits it.
2. The next sidebar refresh re-evaluates each entry.
3. The original entry's archive guard now compares a different live hash to `contentHashAtCommit`; the entry passes the archive guard and re-appears in the sidebar.
4. The original entry's `commitHash` remains set (it's still associated with the commit), but the user can iterate on it as a fresh uncommitted-feeling artifact and re-associate it with a later commit if desired.

### User explicitly hiding a plan or note

1. The user invokes the panel's "Remove from list" action on an entry.
2. The entry's `ignored` field is set to `true` (no other fields change).
3. All subsequent sidebar evaluations hide the entry by the ignored guard, ahead of any other gate.

For notes, "Remove" on an uncommitted snippet is destructive — it deletes the snippet file *and* removes the registry entry entirely (not just sets `ignored`). For uncommitted markdown notes (which reference a user file), "Remove" only removes the registry entry; the user file is not touched.

### Restoring a previously-hidden plan

1. The user invokes the panel's "Add Plan" action and picks the slug from the list.
2. The registry entry is rewritten as a fresh uncommitted entry: `commitHash` is null, `contentHashAtCommit` is undefined, `ignored` is undefined, `editCount` is preserved if previously set.
3. The entry now passes every guard and shows in the sidebar.

This deliberately drops a previous archive guard's `contentHashAtCommit` even when the source file is unchanged — the user's explicit "Add" intent supersedes the archive's "we already snapshotted this" memory.

## State Transitions

For a plan/note registry entry, the visibility-relevant transitions are:

| From | Trigger | To |
| --- | --- | --- |
| Uncommitted (no `commitHash`, no `contentHashAtCommit`, not ignored) | Source file edited | Uncommitted (still visible) |
| Uncommitted | Source file deleted | Uncommitted-orphan (hidden; for plans, evicted on next load) |
| Uncommitted | User clicks "Remove" | Ignored (hidden) — for note snippets, file deleted and entry erased |
| Uncommitted | Associate with commit | Archive-guarded (hidden); sibling snapshot-copy entry created (also hidden in sidebar) |
| Archive-guarded | Source file unchanged | Hidden (live hash equals `contentHashAtCommit`) |
| Archive-guarded | Source file edited | Visible again (live hash differs from `contentHashAtCommit`) |
| Archive-guarded | User clicks "Remove" | Ignored (hidden) |
| Ignored | User clicks "Add" / "Associate" | Fresh uncommitted (visible) |
| Snapshot-copy (`commitHash` set, no `contentHashAtCommit`) | Anything | Hidden (snapshot-copy guard) |

No transition is branch-sensitive. The entry shape has no branch field, the loader that feeds the sidebar strips any branch value it finds on a row, and none of the gates compares one — a pending plan or note belongs to the worktree, so switching branches neither hides nor reveals anything. A branch is attached to the artifact only once a commit archives it, and it is that commit's branch, recorded on the commit's stored summary.

## Notable Behavior

- **Two entries per archived artifact.** After associating a plan with a commit, the registry contains both the original-slug entry (acting as the visibility guard) and a `<slug>-<shortHash8>` snapshot-copy entry (referenced by the Summary WebView and orphan-branch storage). The sidebar hides both, but for different reasons: the original by the content hash matching, the snapshot-copy by the snapshot-copy guard. (Surprising; intentional.)
- **Editing an archived plan reincarnates it in the sidebar.** The archive guard does not require the user to do anything explicit to "un-archive" — touching the source file is sufficient. This is intentional: it means iterating on a plan after the first commit is frictionless. (Surprising; intentional.)
- **The user-hide flag wins against all other rules.** A user who clicks "Remove" gets their wish even if the source content later changes back; only an explicit "Add" / "Associate" can reverse it. The system never decides on its own that an ignored entry should reappear. (Notable.)
- **"Remove" on a note has different physical effects depending on format.** For snippet notes, removing also deletes the local snippet file (the orphan branch holds the archive copy if any). For markdown notes referencing a user file, removing only erases the registry entry — the user's file is untouched. The plan equivalent ("Remove from list") merely sets `ignored`; the plan markdown file is never deleted. (Surprising; intentional.)
- **There is no branch gate.** The sidebar never compares a branch. A pending plan or note is worktree-scoped and stays listed across branch switches, exactly like uncommitted code; the artifact acquires a branch only when a commit archives it, and it is the commit's branch, not anything the registry held. (Notable.)
- **Plan source files live outside the workspace.** Plans live under a per-user global directory (the agent's plans directory). When the source file is deleted, the orphan-cleanup pass evicts the registry entry; this is the only place in the visibility logic that mutates the registry as a side-effect of rendering. (Notable.)
- **Note source files live in two different places.** Snippet notes are written by the panel itself into a per-repo notes directory; markdown notes can reference any path the user picks. The visibility rule treats both uniformly — it just hashes whatever bytes the `sourcePath` points to. (Notable.)
- **The snapshot-copy guard is an opaque rule, not a UI flag.** The reason `<slug>-<shortHash8>` entries don't show up is that they have `commitHash` set without `contentHashAtCommit` — which the visibility rule reads as "this is the orphan-branch shadow, not a sidebar artifact". A future field added to mark these explicitly would not change behavior. (Notable.)
- **`addedAt` is preserved across archive / re-add cycles.** When a previously-archived plan is re-added to the registry as fresh uncommitted, the original `addedAt` is kept; only `updatedAt` advances. The sidebar's sort order (by `lastModified` derived from `updatedAt` or the source file's mtime) therefore behaves as the user expects — re-adding bumps a plan to the top, but its "discovered on" timestamp is unchanged. (Notable.)
- **Orphan cleanup writes the registry only when something changed.** The plan-load pass collects deletions in memory and only writes plans.json if at least one entry was evicted. A clean pass is a strict no-op on disk. (Notable.)

## Shared Behavior

- **One registry file holds plans and notes.** A single `plans.json` per repo with sibling `plans` and `notes` maps; readers and writers (sidebar, post-commit hook, Summary WebView) all consume the same file with atomic writes.
- **SHA-256 over UTF-8 source bytes.** The same hashing primitive is used everywhere a content guard is evaluated — both at archive-time and at sidebar-render time — so guard checks always agree across surfaces.
- **First-`#`-heading title extraction.** The same rule that drives plan attribution (cross-project guard) and the panel's display titles is used here for both plans and notes.
- **Atomic write via tmpfile + rename.** All registry writes use the shared tmpfile-then-rename primitive used by every per-repo state file (`sessions.json`, `cursors.json`, `plans.json`, …), with the same Windows EPERM fallback.
