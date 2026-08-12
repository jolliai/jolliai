# 337. CLI-Owned Working-Area Context Service

## Topic Statement

The single command-line-owned set of operations over a worktree's working-area context — the plans, notes and external references a worktree carries before a commit claims them — including the two deliberately non-interchangeable visibility rules, the load-time normalization that hard-deletes and strips legacy shapes, and every mutation, so that both IDE hosts read one answer instead of each restating the rules.

## Scope

**In scope:**

- The row shapes for the three working-area kinds, and the fourth kind (skill usage) that shares the same registry file and is deliberately passed through untouched.
- The load-time normalization: which rows are **dropped outright**, which fields are stripped from survivors, and the "did anything change" signal that drives a one-shot write-back.
- The worktree-scoping rule — why no working-area row carries a branch, and what actually attaches a branch.
- The enumerated operation set exposed to a JVM host, and what each one reads or writes.
- The **two** visibility rules — the browsable-list rule and the archive-selection rule — stated side by side, and why neither is a superset of the other.
- The foreign-repository plan fold performed by the archive-selection operation, and its return-value-only nature.
- The whole-unit timestamp truncation on one returned field, which is a wire contract rather than a cosmetic rounding.
- The two-part disable gate on mid-session plan registration, and the asymmetry that the browsable-list write-back gate consults only half of it.
- Which mutations take the registry lock, what they re-read inside it, and what is deliberately done after the lock is released.
- The commit-ownership gate that guards a dissociation-driven delete.

**Out of scope (boundaries):**

- The transport that carries these operations to a JVM host — request framing, the long-lived server process, the daemon fallback, and the rest of the action catalogue this one sits in. This spec covers only what the working-area operations mean.
- The change-notification channel that tells a host when to call them (spec 289), and the escalation rule its debouncers apply (spec 338).
- Discovery of plans from agent transcripts (spec 29) and of references from agent transcripts (spec 153) — those are the upstream producers that insert rows; this spec covers what happens to a row once it exists.
- The commit-time pipeline that archives working-area context onto a commit and deletes the reference rows.
- The on-disk format of a per-reference markdown file, of a snippet body file, and of the summary-storage backend an archive writes through.
- The commit-exclusion store's own persistence and lock semantics; this spec only states which of its sets are read alongside each grouped read and how "nothing excluded" is materialized on the wire.
- Every host-side presentation decision — row layout, icons, dialogs, menus, keyboard handling.
- The transcript-affinity predicate used when registering a newly-appeared plan file (spec 113).

## Data Contracts

### The one registry file

All four kinds live side by side in one per-project file, under sibling maps keyed by each kind's identifier. Every read normalizes the parsed content before any caller sees it; every write re-serializes the whole object, so a legacy field never disappears on its own — the normalization pass is the only thing that removes one.

### Plan row

| Field | Meaning |
| --- | --- |
| slug | Primary key. |
| title | The plan's display name. |
| source path | Absolute path of the markdown on disk. Usually **outside** the worktree — a machine-global agent plan directory, an in-repo document, or an arbitrary file the agent wrote. |
| added-at / updated-at | ISO timestamps. |
| commit hash | Null while unclaimed; the claiming commit's full hash once archived. |
| content hash at commit | Present only on an archived row. Its presence is what puts the row into "archive guard" mode. |

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

### Reference row

| Field | Meaning |
| --- | --- |
| source | The upstream system's identifier. |
| native id | The source-native key. |
| title | Display name. |
| url | Optional — a source may record a purely local lookup with no navigable page. |
| source path | Absolute path of the per-reference markdown, always inside the per-project state directory. |
| added-at / updated-at | ISO timestamps. |
| source tool name | The tool call that surfaced it. |

A reference row has **no** commit-claim fields. A commit deletes the row outright rather than guarding it, so every row present is by construction active and uncommitted.

### Load-time normalization

Pure and idempotent — clean input reports "nothing changed". Per kind:

| Kind | Rows dropped | Fields stripped from survivors |
| --- | --- | --- |
| Plans | Any row carrying the hide flag set to true. | The hide flag, a branch, an edit count. |
| Notes | Any row carrying the hide flag set to true. | The hide flag, a branch. |
| References | Any row carrying the hide flag set to true, **or** a non-null commit hash, **or** a content-hash-at-commit field at all. | The hide flag, a branch, the commit hash, the content hash at commit. |
| Skill usage | None. | None — passed through verbatim. |

Three consequences are load-bearing:

- **The hide flag is a HARD DELETE, not a soft hide.** A row carrying it does not survive the next load, and no surviving row can carry it. Writing it destroys the row.
- **The edit count is never written by anything and is stripped on load**, so a surface that displays one displays a value that can only ever be absent.
- **The reference drop is decided by the presence of the commit-claim fields, deliberately NOT by a key ending in a short hexadecimal suffix** — a live upstream identifier can legitimately end in eight digits, and digits are hexadecimal, so a key-shape test would silently delete active rows.

The skills map's pass-through is equally deliberate: skill rows follow the plan/note archive-guard lifecycle, so a guarded skill row must survive; applying the reference kind's drop to them would delete every skill guard on load. The normalization rebuilds the container field by field, so **omitting a kind's map erases it on every load** — an absent map is preserved as absent, a present one is rebuilt.

### Worktree scoping

Working-area context belongs to the worktree, not to a branch. It follows the user across a checkout exactly like an uncommitted code change, and binds to a branch only when a commit claims it — the branch is then recorded on that commit's stored summary, never on the working-area row. This is why the branch field is on every kind's strip list, why no visibility rule compares a branch, and why the operations that still accept a branch argument ignore it.

### The two visibility rules

Both are owned here and are **not interchangeable**. Neither is a superset of the other.

| | **Browsable-list rule** | **Archive-selection rule** |
| --- | --- | --- |
| Answers | "What should the context panel show?" | "What will the next commit claim?" |
| A row a commit claimed, whose file has since changed again (a *revived guard*) | **Visible** | **Excluded** |
| A row a commit claimed, file unchanged | Hidden | Excluded |
| A row no commit has claimed, file present | Visible | Included |
| A row no commit has claimed, file missing | Hidden | Excluded |
| Also does | A one-shot normalization write-back, plus (plans only) an orphan-row eviction | Nothing — pure read |

A host must pick the rule that matches its question and must **never post-filter either result**. The revived-guard divergence is the whole reason they are separate: a panel that wants to let the user keep iterating on an already-committed plan needs it, and a "what will the next memory contain" preview must not offer a row the commit path will refuse.

#### Browsable-list rule, per kind

**Plans.** A row is hidden when any of the following holds:

1. It carries a content hash at commit **and** its source file is missing, or the file's current content hashes to that stored value.
2. It carries a commit hash **and** carries no content hash at commit.
3. It carries no commit hash **and** its source file is missing.

Survivors are projected with the on-disk source path kept even for a revived guard (the row is visible precisely because that local file changed, so opening it must open that file), a title re-extracted from the file's first heading whenever the file exists, and a last-modified taken from the file's modification time when it can be read, else the row's updated-at. The list is sorted newest-modified first.

**Notes.** The same three gates, with two differences: the content read that feeds the guard hash is whatever bytes the source path points at (and an unreadable source means hidden), and the source-missing gate applies only when a source path is recorded at all. The title is re-extracted from the file only for a **markdown-format, unclaimed** row whose file exists; a snippet's title and a claimed row's title come from the registry. Same sort.

**References.** No rule at all — every row in the map is active by construction, and the grouped read returns the map verbatim.

#### Archive-selection rule, per kind

**Plans.** Keep rows with a null commit hash **and** no content hash at commit **and** a source file that exists on disk. The existence probe is part of the rule, not a caller's optimization: the commit-time archive loop skips a row whose file is gone, so a row failing it is one the commit provably will not claim.

**Notes.** Keep rows with a null commit hash, no content hash at commit, a recorded source path, and a source file that exists.

**References.** Every row, projected to its key, source and source path.

In all three, the cheap registry predicates run before the disk probes, and the probes run concurrently.

### The operation set

| Operation | Reads | Writes |
| --- | --- | --- |
| List browsable plans | Registry, plan source files | One-shot normalization / orphan-eviction write-back |
| List selectable plan files | The agent's machine-global plan directory | — |
| Add a plan by slug | The agent plan directory | Registry |
| Register newly-appeared plan files | Registry, the agent plan directory, this project's transcripts | Registry |
| Remove a plan | Registry | Registry; conditionally the source file |
| Rename a plan's title | Registry | Registry |
| Archive a plan onto a commit | Registry, plan source file | Registry; summary storage |
| Delete a plan's user-visible archived artifact | — | Summary storage's visible layer |
| List browsable notes | Registry, note source files | One-shot normalization write-back |
| Save a note | Registry | Registry; a snippet body file for a new snippet |
| Remove a note | Registry | Registry; conditionally the source file |
| Remove a reference | Registry | Registry; the per-reference markdown |
| Grouped browsable read | Registry, plan and note source files, exclusion store | Whatever the two browsable listings write |
| Grouped archive-selection read | Registry, plan and note source files, exclusion store, repository identity of each plan's source path | — |

## Behavior

### List browsable plans

1. Load and normalize the registry, keeping the "did normalization change anything" signal.
2. Over a copy of the plans map, evict every row that has a null commit hash, no content hash at commit, and a missing source file — the **orphan eviction**.
3. If anything was evicted **or** normalization changed something, and the in-process disabled mirror is not set: take the registry lock, load and normalize again inside it, re-run the eviction against that fresh snapshot, and save if either the fresh normalization or the fresh eviction produced a change. The display list is built from the *pre-lock* snapshot; the write-back is a convergence step, not the answer.
4. Project the pre-lock snapshot through the browsable-list rule and sort.

The write-back is one-shot convergent: a later call over a clean registry writes nothing.

### List selectable plan files

Enumerate the markdown files in the agent's machine-global plan directory, skipping any slug in the caller-supplied exclude set, and return each survivor's slug, extracted title, and modification timestamp — **truncated to whole milliseconds** — sorted newest first. A missing directory yields an empty list; a file whose modification time cannot be read is still returned, with a zero timestamp.

The truncation is a wire contract. Filesystems this ships on store sub-millisecond precision, so the raw value serializes with a fractional part, and the JVM host's deserializer **rejects a fractional literal for an integral field** rather than truncating it — which failed the entire response and took the whole picker with it. Truncating at the producer keeps the wire integral for every consumer instead of asking each one to be tolerant. The field only orders the list, so the discarded fraction costs nothing.

### Add a plan by slug

Resolve the slug to a file in the agent plan directory; return silently if it is absent. Build a **fresh unclaimed row** — commit hash null, no content hash at commit, title re-extracted, added-at preserved from any prior row and updated-at set to now — then take the lock, re-read, and merge that single row onto the fresh snapshot.

This deliberately discards a prior archive guard even when the source file is unchanged: the user's explicit add supersedes the archive's "we already snapshotted this" memory.

### Register newly-appeared plan files

Input is a burst of **raw directory entry names** from the agent's machine-global plan directory — not slugs. The whole operation short-circuits on an empty burst before any I/O.

1. **Disable gate**, checked before anything else: return immediately if either the in-process disabled mirror is set **or** the durable on-disk disable state says so. Both halves are required. The in-process mirror is inert inside a long-lived server process, which never went through the activation that sets it; the durable state is the only thing that survives a process boundary. The durable check uses the **read-only** probe of that state, never the variant that migrates a pre-split profile — that variant *persists* its decision, and writing into a disabled project is exactly what the gate exists to prevent.
2. Read the registry once, purely as a fast path: collect the set of slugs this project already tracks.
3. For each name in the burst, in order:
   - Drop it unless it is a bare entry name (no path component) ending in the markdown extension, and unless the remaining stem is non-empty. Anything else is either a caller bug or an attempt to escape the directory.
   - Drop it if the stem is already tracked. This check is placed **before** the affinity scan on purpose: the affinity scan reads every active transcript in full, transcripts routinely run to tens of megabytes, and the event source cannot distinguish a create from a content edit — so a user iterating on one plan would otherwise re-scan every transcript on every save, in every open project, because the directory is machine-global.
   - Drop it if the file does not exist — a delete arrives indistinguishably from a create.
   - Drop it if the transcript-affinity predicate says the plan belongs to another project.
   - Register it, then add the stem to the in-burst tracked set so a duplicated event name costs no second lock acquisition.
4. Return the list of names that passed every filter and were handed to registration. This is deliberately *accepted*, not *registered*: registration re-reads under the lock and may find the slug already present, so claiming a write happened would be a guess.

Registration itself re-applies the same two-part disable gate, confirms the file exists, then under the lock re-reads and inserts a fresh unclaimed row **only if the slug is not already present** — preserving an existing row's claimed/guard state rather than resetting it.

Registration is serial across the burst, not concurrent: each call is a load-modify-save under one lock, so concurrent calls would queue on it anyway.

**The fast path has a known, deliberately-unclosed limit:** it only covers slugs *this* project has registered. A plan owned by another project never enters this registry, so every edit to one does reach the full transcript scan. It is bounded rather than unbounded — the session list prunes stale entries, so a project with no live session returns nothing and the affinity predicate exits before reading anything.

### Remove a plan

One fresh read inside the lock resolves the key, gates it, and deletes it, so the gate is checked against the same snapshot the delete lands on.

- **Without an expected commit hash** (the panel's own "remove this row"): the exact key is deleted unconditionally if present.
- **With an expected commit hash** (a commit dissociating its context): delete the exact key only if that row still carries that commit hash; otherwise split an archived-looking key into its base and delete the base only if *that* row still carries it. A registry key is a single time-evolving slot — an archived-looking key can later become a live row, and a base can be revived and re-claimed elsewhere — so gating on ownership stops a dissociation from an *old* commit wiping a row that has moved on.

An unknown key is a no-op. After the lock is released, the source file is unlinked **only when it lives inside the per-project state directory**; plan source files are almost always external, so in practice the file is preserved and only the row goes. A failed unlink is swallowed — the row is already gone, so it cannot strand state.

No tombstone is written, so a later re-registration of the same file revives the plan.

### Rename a plan's title

Under the lock, re-read and write back the single row with the caller-supplied title. An unknown slug is a no-op. The caller passes the title it already extracted, because the edited buffer may not have been written to disk yet.

### Archive a plan onto a commit

1. Read the registry. If the slug is unknown, synthesize a row from the agent plan directory; if no such file exists either, return nothing.
2. Hash the source file's current content, when it exists.
3. Under the lock, re-read and write the **original** key back as the guard row: same fields, plus the commit hash, a refreshed updated-at, and the content hash. **No sibling short-hash row is written** — the stored snapshot plus the reference recorded on the commit's summary are the system of record.
4. If the source file exists, store its content into summary storage under a key of the slug plus the commit's short hash, with no branch supplied (the storage layer resolves the branch from the hash embedded in that key).
5. Return a reference record — the suffixed key, the title, and the timestamps — for the caller to attach to the commit's summary.

The storage handle is **optional on the operation and threaded in by every live caller** — both hosts resolve one and pass it. This is the only working-area operation that writes through summary storage, and the un-threaded path is a latent trap rather than an observed one (**currently unreachable**: no caller omits the handle). Were it taken, the storage resolver fails *safe* rather than loud — it falls back to whichever backend is the system of record, dropping the dual-write layout's second half, so a user configured for it would silently lose both the canonical archived record and the user-visible archived markdown, with nothing but a log line to show for it; reads still come from the system of record, so the panel would look correct and the gap would surface only later as a phantom missing file.

### Delete a plan's user-visible archived artifact

Delete the user-browsable archived markdown for a slug under a commit's branch folder, so the browsable tree stops showing a ghost after a dissociation. A no-op when the active storage backend has no visible layer. Kept separate from plan removal because that operation is also the panel's "remove this live row" path, where there is no commit and therefore no branch folder to clean, and its callers pass no branch at all. Same storage-threading requirement, for the same reason.

### List browsable notes

Load and normalize; if normalization changed something and the in-process disabled mirror is not set, take the lock, re-load, and save if the fresh load also reports a change. Then project every row through the browsable-list rule and sort. There is **no** orphan-eviction pass for notes — a note whose file vanished is hidden, not evicted.

### Save a note

Only the two known format values are accepted; anything else is rejected before the operation runs (the check sits at the request boundary, not inside the operation, which trusts its type).

1. Read the registry; ensure the per-project notes directory exists.
2. Resolve the body location: an existing row's recorded source path wins; otherwise a markdown-format save takes the caller's content **as a path** and references it in place with no copy; otherwise (a new snippet) the content is written to a file named after the generated id inside the notes directory.
3. Resolve the title: the caller's title if non-empty, else the file's first heading, else its base name.
4. Build the row over any existing one, preserving that row's added-at and commit hash.
5. Under the lock, re-read and merge the single row, preferring the **fresh** row's added-at if one appeared since the pre-lock read (a concurrent archival may have created it).

A new id is derived from the title — lower-cased, non-alphanumeric runs collapsed to a separator, trimmed, capped at forty characters — plus a four-hexadecimal-character random suffix, falling back to a bare prefix-plus-suffix when the title yields nothing. Two notes with the same title therefore get different ids.

### Remove a note

Identical shape to plan removal, including the commit-ownership gate and the archived-key base fallback, and the same "delete the backing file only when it lives inside the per-project state directory" rule — which is why a snippet's body file is unlinked and a markdown note's user-owned file never is. An unknown id is a no-op; a claimed note whose snippet file was already cleaned up at archive time simply skips the file delete.

### Remove a reference

Under the lock: re-read, return null if the key is absent, delete the row, and save a registry rebuilt field by field so the plans map, the notes map **and the skills map** are carried through — dropping one reference must not erase the skill registry. After the lock, best-effort delete the per-reference markdown; a missing file is tolerated and any error is swallowed, because the row is already gone. Reference markdown always lives inside the per-project state directory, so no internal/external test is needed. No tombstone: a later re-mention re-discovers and re-inserts the row and re-creates the file.

### Grouped browsable read

Returns, in one round trip, everything a browsable context panel paints: the browsable plans, the browsable notes, the reference map verbatim, and the user's exclusion sets.

The two browsable listings run **serially, not concurrently**: each performs its own one-shot normalizing write-back on the first refresh after an upgrade, and racing them would have each build its payload from a snapshot the other is about to replace. The registry read for references and the exclusion-store read then run together.

Every exclusion set is **materialized into an explicit list**, including the one that is optional on disk. The JVM host's deserializer turns an absent key into a null collection that throws on first use, so "nothing excluded" has to arrive as an empty list rather than as an absent key.

This is deliberately **not** merged with the archive-selection read. They are the two visibility rules, and a single payload would let a caller take the wrong half.

### Grouped archive-selection read

Returns everything the next commit would claim, plus the exclusion sets that decide what is struck through.

1. The branch argument is accepted and ignored by all three selections — working-area context is not branch-scoped.
2. Concurrently: the archive-selection plans, the archive-selection notes, the archive-selection reference triples, the exclusion sets, and one registry read used only to join reference titles.
3. Each reference triple is widened with the title from the registry, falling back to its own key when no row is found — so a host has no reason to re-read the registry to label a row.
4. Classify every selected plan's source path against the current repository (see below) and fold every **foreign** plan's slug into the *returned* plan-exclusion set.
5. Materialize every exclusion set into an explicit list, as above.

**The foreign fold is return-value only.** The user's on-disk manual exclusion set is untouched — the foreign slugs are added to the copy that goes out on the wire, so the panel strikes them through with the render path it already has, keeping them **visible-but-unselectable** rather than silently includable. The commit-time archive chokepoint drops the same plans by the same classifier, so the pre-commit preview and the commit agree.

**Four independent registry reads in one call.** Each of the three selections loads the registry itself, and the title join loads it a fourth time, so a write landing mid-flight can leave them on different snapshots. (The exclusion read alongside them touches a different file and does not add a fifth.) This is known and accepted: it is display-only and self-healing on the next refresh — a reference whose row the registry read missed falls back to its bare key for one paint, and the plan and note lists can momentarily disagree about a row that was just added. Nothing is written from any of them, so no data is at risk.

### Repository classification of a plan's source path

A plan's source path is classified as belonging to this repository, to a foreign one, or to neither. The discriminator is **git repository identity, not directory containment**, because plan-mode plans legitimately live outside the worktree.

1. No source path at all → **neither** (do not drop on uncertainty).
2. Inside the current worktree → **this repository** (resolved with no repository query at all).
3. Inside a canonical machine-global agent plan directory → **this repository**, by whitelist, independently of any repository that happens to enclose the user's home directory.
4. Otherwise compare the enclosing repository's shared directory with the current one's: equal → this repository (which is what makes a sibling worktree of the same repository classify correctly), different → **foreign**, unresolvable on either side → **neither**.

The comparison resolves symbolic links on both spellings first: the shared directory comes back relative for a main worktree and absolute-and-already-resolved for a linked one, so under a symlinked prefix the two spellings diverge and a sibling worktree of the *same* repository would otherwise read as foreign. Resolution is memoized per directory as an in-flight promise, so a burst of concurrent classifications sharing a directory costs one repository query rather than one each. The classifier is single-run scoped.

## State Transitions

For one plan or note row:

| From | Trigger | To |
| --- | --- | --- |
| Absent | Discovery, registration, or an explicit add | Unclaimed (visible in the browsable list; included in the archive selection) |
| Unclaimed | Source file edited | Unclaimed |
| Unclaimed | Source file deleted | Hidden from the browsable list and excluded from the archive selection; for plans, evicted from the registry on the next browsable listing |
| Unclaimed | Archived onto a commit | Guard row: commit hash and content hash written onto the **same** key; no sibling row created |
| Guard row | File still matches the stored hash | Hidden from the browsable list; excluded from the archive selection |
| Guard row | File edited | **Revived**: visible in the browsable list, still excluded from the archive selection |
| Guard row | Explicit add | Fresh unclaimed row (guard discarded, added-at preserved) |
| Any | Removal | Gone — no tombstone, so re-registration revives it |
| Any | Carried the hide flag on disk | **Gone on the next load** |

For one reference row: absent → present (upstream extraction) → gone (removal, or a commit claiming it). There is no guarded state; a row that arrives carrying commit-claim fields is dropped on load.

## Notable Behavior

- **The hide flag destroys data.** It reads like a soft hide and behaves like a hard delete: any row carrying it is dropped during normalization, and the field is stripped from every survivor. Nothing in the product writes it. (Surprising; reality.)
- **The edit count is a dead field.** It is stripped on load and written by nothing, so any surface still rendering it renders a permanent absence. (Notable.)
- **Archiving writes no sibling row.** The claimed key stays the *original* key and becomes the guard; the short-hash-suffixed key exists only in summary storage and on the commit's summary, never as a second registry row. (Notable.)
- **A revived guard is visible but not selectable.** Editing a plan after its commit brings the row back into the browsable panel with no explicit un-archive step — and the archive-selection rule still excludes it, because it already carries a commit hash. Both are correct answers to different questions. (Surprising; intentional.)
- **The two visibility rules are separate operations on purpose.** Merging them into one payload would let a host take the wrong half; post-filtering either one host-side re-creates exactly the drift the whole service exists to remove. (Notable.)
- **The disable gate is two checks, and only one of them is on the browsable write-back.** Mid-session registration checks the in-process mirror *and* the durable on-disk state, because the mirror is inert in a long-lived server process. The browsable listings' normalization write-back checks **only the in-process mirror** — so inside such a process that write-back still runs against a durably-disabled project. (Notable.)
- **The durable check must be the read-only probe.** The other reader of the same state migrates a pre-split profile and *persists* the migrated value; using it inside a gate whose purpose is "write nothing here" would perform the write it exists to prevent. (Notable.)
- **A timestamp is truncated to whole units as a wire contract.** The JVM host's deserializer rejects a fractional literal for an integral field outright — not by truncating — so the raw sub-millisecond value failed the whole response and disabled the picker that consumed it. (Surprising; reality.)
- **The registration burst carries filenames, not slugs.** Deriving a slug, skipping non-markdown, and deciding project affinity are rules, and a host-side restatement of them is the drift this service exists to prevent. The host contributes only what it alone has: the names the operating system reported. (Notable.)
- **A create and an edit are indistinguishable at the registration entry point.** The host that feeds it cannot tell them apart, so an edit to an existing file arrives as a registration request. This is invisible for a tracked slug (the fast path drops it) and for a foreign one (affinity says no). (Notable — see spec 113 for the one case where it is visible.)
- **The archive-selection existence probe is part of the rule, not an optimization.** The commit-time archive loop skips a row whose file is gone, so leaving such a row in the selection makes every consumer of "what will the next memory contain" wrong in the same way — which is what drove one host to grow its own compensating existence filter. (Notable.)
- **The foreign fold touches the wire only.** The user's saved exclusions are never mutated by a read. (Notable.)
- **The archive path would fail safe rather than loud if storage were not threaded through** — falling back to a system-of-record-only backend, leaving the panel looking correct while the user-visible archived artifact is never written. **Unreachable today**: every live caller threads a handle. (Notable; a latent trap, not observed behavior.)
- **The reference drop predicate is field-based, never key-shaped.** A live upstream identifier can end in eight digits, and digits are hexadecimal, so a "looks archived" key test would delete active rows. (Notable.)
- **Skill rows are passed through untouched, and the container is rebuilt field by field.** Applying the reference kind's drop to skills would delete every skill archive guard on load; omitting a kind's map from the rebuild would erase it on every load. (Notable.)
- **Backing-file deletion is decided by location, never by state.** Both removals unlink the source file only when it sits inside the per-project state directory. A host that instead keyed on "unclaimed and snippet-format" deleted a different set of files than the other host did for the same user action. (Notable.)
- **A dissociation-driven delete is gated on commit ownership; a panel-driven one is not.** The panel is the user explicitly removing a live row; a dissociation is an old commit letting go, and a registry key is a single time-evolving slot that may since have been revived or re-claimed. (Notable.)
- **Every mutation re-reads inside the lock and merges only its own key.** The pre-lock read is used to compute the change, never to decide the write, so a concurrent writer touching a different row survives. (Notable.)
- **Every backing-file deletion happens after the lock is released.** The row is persisted as gone first; a failed unlink then cannot strand a row whose file was already destroyed. (Notable.)
- **Nothing here writes a tombstone.** Removal of a plan, note or reference leaves no trace, which is what makes re-discovery clean — and is also why a removed plan can be revived by a later registration. (Notable.)
- **Absent optional collections are materialized as empty ones.** The JVM host's deserializer turns an absent key into a null collection that throws on first use, so a grouped read spells out every set. (Notable.)
- **Every branch-scoped-looking selection ignores its branch argument entirely.** All three archive selections, the skills selection and the reference-entry read still accept one and none reads it; the parameter is vestigial, because working-area context is not branch-scoped. The one operation that genuinely uses a branch is the visible-artifact deletion, which needs it to name a folder. (Notable.)

## Shared Behavior

- The registry file's location, its atomic-write primitive, and the lock that serializes read-modify-write cycles over it are shared with every other writer of that file — the discovery scans, the commit-time pipeline, and both IDE hosts.
- The first-heading-else-filename title extraction is the same rule used by plan discovery, note saving, and every surface that needs a markdown file's display title.
- The content guard is a hash over the source file's bytes, computed identically at archive time and at visibility-evaluation time, so the two can never disagree.
- The repository-identity classifier is shared with the commit-time archive chokepoint, which is what makes the pre-commit preview and the commit itself agree about which plans are foreign.
- The exclusion sets returned by both grouped reads are owned by the commit-exclusion store (separate spec); these operations only read them and materialize them for the wire.
- The archived-key split (a base key plus a short commit-hash suffix) used by the commit-ownership fallback in both removals is shared with the commit pipeline's own key handling.
- The location helper for the agent's machine-global plan directory is deliberately kept in a dependency-free leaf so that a cold one-shot invocation of the bridge does not pay for the whole working-area dependency graph before reading its first request; a source-shape test pins that constraint, because a new eager dependency would typecheck, lint, and leave every test green while silently costing the cold path its budget. That directory is **one agent's plan-mode directory, not "where all plans live"** — every other discovered plan keeps its real path on its row and is never copied there.
