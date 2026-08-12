# 114. Plan and Note Archive Guards

## Topic Statement

The content-hash guard that hides a plan or note from the editor extension's context list once a commit has claimed it, and brings the row straight back the moment its source content changes again — together with the three other gates that decide the same row's visibility, and the load-time normalization that silently destroys any row carrying the legacy hide flag.

## Scope

**In scope:**

- The row fields that drive guard behaviour for both kinds, and the fields that no longer exist on a live row.
- What claiming a row for a commit actually writes, and what it deliberately does **not** write.
- The four visibility gates, in the order they are evaluated, for plans and for notes.
- The load-time normalization that drops hide-flagged rows outright and strips dead fields from survivors, and the one-shot write-back it triggers.
- The plans-only orphan eviction that runs as a side effect of listing.
- What the extension's "Remove" action does to a guarded row (it is not a hide).
- The explicit re-add path that discards a guard.
- Why no gate compares a branch.

**Out of scope (boundaries):**

- The full command-line-owned working-area service these gates live in — its whole operation set, its locking discipline, and the archive-selection visibility rule that answers a *different* question (spec 337). This spec covers only the browsable-list side and the guard that shapes it.
- Where the archived bytes go: the summary-storage backend, its system-of-record branch, and its user-browsable layer.
- The commit-time pipeline that claims rows in bulk, and the memory-detail panel's own associate / dissociate affordances.
- Discovery of plans from agent transcripts (spec 29) and cross-project attribution of a newly-appeared plan file (spec 113) — those insert rows; this spec covers what happens to a row once it exists.
- Reference rows, which have no guarded state at all (spec 187), and skill-usage rows.
- Note creation flows (spec 111).
- Row layout, icons, hover cards, menus.

## Data Contracts

### The one registry

Plans and notes live side by side in a single per-project registry file, under sibling maps keyed by each kind's identifier. Every read normalizes the parsed content before any caller sees it; every write re-serializes the whole object, so a legacy field never disappears on its own — normalization is the only thing that removes one.

### Plan row

| Field | Meaning |
| --- | --- |
| slug | Primary key. |
| title | Display name. |
| source path | Absolute path of the markdown on disk. Usually **outside** the worktree — the agent's machine-global plan directory, an in-repo document, or an arbitrary file the agent wrote. |
| added-at / updated-at | ISO timestamps. |
| commit hash | Null while unclaimed; the claiming commit's full hash once archived. |
| content hash at commit | Present only on an archived row whose source file existed at archive time. Its presence is what puts the row into **archive-guard** mode. |

### Note row

| Field | Meaning |
| --- | --- |
| id | Primary key. |
| title | Display name. |
| format | Snippet (body file owned by the product, inside the per-project state directory) or markdown (a file the user picked, referenced in place). |
| source path | Optional. Absolute path of the file holding the body. |
| added-at / updated-at | ISO timestamps. |
| commit hash | Same role as a plan's. |
| content hash at commit | Same role as a plan's. |

### Fields that are NOT on a live row

Three fields appear in legacy data and are purged on every load. None of them is written by anything in the product today.

| Field | What happens to it |
| --- | --- |
| Hide flag | A row carrying it set to true is **dropped from the registry** during normalization. Survivors have the field stripped. |
| Branch | Stripped from every survivor. |
| Edit count (plans only) | Stripped from every survivor. |

- **The hide flag is a HARD DELETE, not a soft hide and not a reversible force-hide.** It reads like "hide this row"; its actual effect is that the row does not survive the next load, and no surviving row can carry it. Writing it destroys the row and everything on it, with no way back short of re-discovery.
- **The edit count is a dead field.** Nothing writes it and it is stripped on load, so any surface still rendering one renders a permanent absence.
- **A branch never persists past a load-then-save.** See "Worktree scoping" below.

### Load-time normalization

Pure and idempotent — clean input reports "nothing changed". For these two kinds it drops any hide-flagged row and strips the dead fields above; the commit hash and the content hash at commit are **kept**, because they are the guard. The "did anything change" signal it returns is what drives the one-shot write-back described under Behavior.

The normalization rebuilds the registry container field by field, so an absent kind's map stays absent and a present one is rebuilt. (Two sibling maps in the same file — external references and skill usage — are normalized by different rules; see spec 337.)

### Claiming a row for a commit

When a plan or note is archived onto a commit:

1. The current source content is read and hashed.
2. The **original** key is written back as the guard row: every field it already had, plus the commit hash, a refreshed updated-at, and the content hash.
3. The content is stored into summary storage under a key formed from the original key plus the commit's short hash.
4. A reference record naming that suffixed key is returned for the caller to attach to the commit's stored memory.

**No sibling registry row is created.** The suffixed key exists only inside summary storage and on the commit's stored memory — never as a second row in the registry.

For a note, one extra step runs after storage: a **snippet's** body file is unlinked, because its content now lives in summary storage. A markdown note's user-owned file is left alone.

Two asymmetries between the kinds at claim time:

- A plan whose source file is **missing** is still claimed — the commit hash is written, the content hash is not (there is nothing to hash), and no content is stored. The resulting row is a commit-hash-without-content-hash row, which the second visibility gate hides forever.
- A note whose content cannot be read is **not** claimed at all: the operation returns nothing and the registry is untouched.

### Visibility gates

A row is shown only if it passes every gate. Gates are evaluated in this order, per row, independently — there is no global "hide everything archived" switch.

| Order | Gate | A plan fails it when… | A note fails it when… |
| --- | --- | --- | --- |
| 1 | **Archive guard** | It carries a content hash at commit **and** its source file is missing, or the file's current content hashes to that stored value. | It carries a content hash at commit **and** its content is unreadable, or the current content hashes to that stored value. |
| 2 | **Claimed-without-guard** | It carries a commit hash and no content hash at commit. | Same. |
| 3 | **Missing source** | It carries no commit hash and its source file is missing. | It carries no commit hash, records a source path, and that file is missing. |
| 4 | *(none)* | — | — |

Gate 2 is what makes a claim-with-a-missing-file permanent for plans: the row can never satisfy gate 1 (it has no stored hash to diverge from) and never satisfy gate 2 (it has a commit hash and no stored hash), so it is invisible until something rewrites it. For notes this shape is unreachable through the claim path and can only arrive as legacy data.

A note with no source path at all skips gate 3 entirely — nothing is checked, so it is visible.

### Projection of a survivor

**Plans.** The on-disk source path is kept even for a revived guard — the row is visible precisely because that local file changed, so opening it must open that file. The title is re-extracted from the file's first heading whenever the file exists. The last-modified is the file's modification time when it can be read, else the row's updated-at. The list is sorted newest-modified first.

**Notes.** Same last-modified rule and same sort. The title is re-extracted from the file only for a **markdown-format, unclaimed** row whose file exists; a snippet's title and a claimed row's title come from the registry.

### Worktree scoping

Working-area context belongs to the worktree, not to a branch. It follows the user across a checkout exactly like an uncommitted code change, and binds to a branch only when a commit claims it — the branch is then recorded on that commit's stored memory, never on the working-area row. This is why the branch field is on the strip list, why no gate compares a branch, and why switching branches neither hides nor reveals a row.

## Behavior

### Listing browsable plans

1. Load and normalize the registry, keeping the "did normalization change anything" signal.
2. Over a copy of the plans map, evict every row that has a null commit hash, no content hash at commit, and a missing source file — the **orphan eviction**. (Note that this is strictly narrower than gate 3: a row failing gate 3 is hidden, and only an *unguarded* one is also deleted.)
3. If anything was evicted **or** normalization changed something, and the in-process disabled mirror is not set: take the registry lock, load and normalize again inside it, re-run the eviction against that fresh snapshot, and save if either the fresh normalization or the fresh eviction produced a change.
4. Build the display list from the **pre-lock** snapshot, through the gates above, and sort.

The write-back is a convergence step, not the answer: a later call over a clean registry writes nothing.

### Listing browsable notes

Load and normalize; if normalization changed something and the in-process disabled mirror is not set, take the lock, re-load, and save if the fresh load also reports a change. Then project every row through the gates and sort.

There is **no** orphan-eviction pass for notes — a note whose file vanished is hidden by gate 3, and stays in the registry.

### Editing the source after a claim

The next refresh re-evaluates the row. Its stored hash no longer matches the file's content, so gate 1 passes and the row re-appears — with its commit hash still set. No explicit un-archive step exists, and none is needed: touching the file is the whole gesture.

### Removing a row from the list

The extension's "Remove" is a **hard delete**, not a hide, and it runs with no confirmation prompt: the registry row is deleted outright, and the backing file is unlinked **only when it lives inside the per-project state directory**. Because plan source files are almost always external, in practice a plan's file survives and only the row goes; a snippet note's body file is deleted and a markdown note's user-owned file is not.

No tombstone is written, so a later re-discovery or re-registration of the same file revives the row.

### Re-adding a plan explicitly

Picking a plan from the machine-global plan directory rebuilds a **fresh unclaimed row**: commit hash null, no content hash at commit, title re-extracted, added-at preserved from any prior row, updated-at set to now. This deliberately discards an existing archive guard even when the source file is unchanged — the user's explicit add supersedes the archive's "we already snapshotted this" memory.

## State Transitions

For one plan or note row:

| From | Trigger | To |
| --- | --- | --- |
| Absent | Discovery, registration, or an explicit add | Unclaimed — visible |
| Unclaimed | Source file edited | Unclaimed — visible |
| Unclaimed | Source file deleted | Hidden (gate 3); for plans, evicted from the registry on the next listing |
| Unclaimed | Claimed by a commit, source readable | **Guard row** on the same key — hidden while the content matches |
| Unclaimed | Claimed by a commit, plan source file missing | Claimed-without-guard row — hidden permanently (gate 2) |
| Guard row | Source content still matches | Hidden (gate 1) |
| Guard row | Source content diverges | **Revived** — visible again, commit hash retained |
| Guard row | Source file deleted | Hidden (gate 1's missing-file arm); not evicted, because it carries a guard |
| Guard row | Explicit re-add (plans) | Fresh unclaimed row; guard discarded, added-at preserved |
| Any | "Remove" | Gone from the registry — no tombstone, so re-discovery revives it |
| Any | Carried the hide flag on disk | **Gone on the next load** |

## Notable Behavior

- **The hide flag destroys data.** It is named like a soft hide and behaves like a hard delete: any row carrying it is dropped during normalization and the field is stripped from every survivor. Nothing in the product writes it, so this only ever fires against legacy data or a hand-edited registry — silently, and with no record that a row was ever there. (Surprising; reality.)
- **The edit count is dead.** It is written by nothing and stripped on load, so a surface that renders one renders a value that can only be absent. (Notable.)
- **Claiming a row writes no sibling row.** The claimed key stays the *original* key and becomes the guard; the short-hash-suffixed key exists only in summary storage and on the commit's stored memory. A registry that shows two rows per archived artifact is legacy data, not something this path produces. (Notable.)
- **Editing an archived plan reincarnates it.** No explicit un-archive exists; touching the source file is sufficient, and the row returns still carrying its commit hash. This is what makes iterating on a plan after the first commit frictionless — and it is also why the *other* visibility rule (the one answering "what will the next commit claim?", spec 337) still excludes the same row. Both are correct answers to different questions. (Surprising; intentional.)
- **A plan claimed while its source file was missing is hidden forever.** It ends up with a commit hash and no content hash, which fails gate 2 unconditionally. Nothing re-writes such a row, so it sits in the registry invisible. The note path cannot reach this shape — it refuses to claim an unreadable note at all. (Surprising; reality.)
- **"Remove" is destructive and unconfirmed.** It deletes the row rather than hiding it, and for a row whose file lives in the per-project state directory it deletes the file too. There is no undo and no tombstone. (Notable.)
- **Backing-file deletion is decided by LOCATION, never by state.** Both removals unlink the source file only when it sits inside the per-project state directory — not by "is this a snippet", not by "is this unclaimed". A markdown note the user pointed at a file inside that directory would therefore have that file deleted on remove. (Notable.)
- **The orphan eviction is the only place rendering mutates the registry**, and it is plans-only. Notes are hidden but never evicted, so the two kinds diverge in what a deleted source file leaves behind. (Notable.)
- **The eviction and the write-back are skipped while the project is disabled in-process, but nothing checks the durable on-disk disable state here.** In a long-lived server process — which never goes through the activation that sets the in-process mirror — the write-back still runs against a durably disabled project. (Notable.)
- **No gate compares a branch, and none can.** The row shape carries no branch, the loader strips any it finds, and a pending plan or note stays listed across a checkout exactly like uncommitted code. A branch attaches only when a commit claims the row, and it is that commit's branch, recorded on the commit's stored memory. (Notable.)
- **Added-at survives an archive-and-re-add cycle.** Only updated-at advances, so re-adding bumps a row to the top of the list while its "discovered on" timestamp is unchanged. (Notable.)
- **The archive path can silently lose the stored copy.** The storage handle is threaded in by the caller and the resolver fails *safe* rather than loud: with nothing supplied it falls back to a system-of-record-only backend, so a user configured for the dual-write layout loses the user-visible archived artifact with only a log line. Reads still come from the system of record, so the list looks correct and the gap surfaces later as a phantom missing file. (Surprising; reality.)

## Shared Behavior

- The registry file's location, its atomic-write primitive, and the lock that serializes read-modify-write cycles over it are shared with every other writer of that file — the discovery scans, the commit-time pipeline, and both IDE hosts.
- The content guard is a hash over the source file's bytes, computed identically at claim time and at visibility-evaluation time, so the two can never disagree.
- The first-heading-else-filename title extraction is the same rule used by plan discovery, note saving, and every surface that needs a markdown file's display title.
- Every gate, every mutation and the normalization itself are owned by the command-line working-area service (spec 337) and reached identically by both IDE hosts — one imports them in process, the other calls them over a bridge. A host-side restatement of any of them is the drift that service exists to remove.
- The second, non-interchangeable visibility rule — "what will the next commit claim?" — lives in the same service and deliberately answers differently for a revived guard (spec 337).
