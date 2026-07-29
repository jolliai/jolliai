# 151. Memory Bank Folder Layout

## Topic Statement
Mirror the canonical memory store onto a user-pickable on-disk parent folder that holds many repositories' memories side-by-side, each with a hidden machine-readable layer, a visible human-readable layer, and a generated topic-wiki layer.

## Scope

**In scope:**
- The role of the user-pickable parent folder as a multi-repository container.
- The shape of each repository's subdirectory under the parent: the hidden machine-readable layer, the visible per-branch human-readable layer, and the generated topic-wiki layer.
- The cross-repository identity registry stored directly under the parent (separate from any individual repository's subdirectory).
- The shape of each per-repository hidden layer's aggregate documents and content directories.
- The shape of each per-repository visible layer's per-branch directories and file naming.
- The shape of the generated topic-wiki layer (per-topic pages plus an index page).
- The user-driven enumeration of repositories under the parent.
- The classification of user-placed Markdown files (files not produced by the system) by scope: parent-wide, per-repository, or per-branch.
- The deterministic ordering of repositories returned to UI consumers.
- The validation policy applied to a user-configured parent path.
- The collision-handling and adoption policy when a repository's intended subdirectory name is already in use.
- The caller-side write-boundary precondition on the claiming resolution mode: which callers carry it, which are exempt, and why it cannot be enforced inside the resolver — but not the predicate itself.
- The semantics of the per-device "shadow dirty" marker at the per-repository layer.
- Which subdirectories of a repository's hidden layer are treated as system reserved (never scanned as user content).
- Hand-edit detection: how the visible and wiki layers protect user-modified files from being overwritten or cleaned up.

**Out of scope (boundaries):**
- The canonical, version-controlled-ref source of truth that this folder mirrors (covered by the orphan-branch summary storage spec).
- The write-path orchestration of the parallel ref backend with the per-repository folder mirror (covered by the dual-write summary storage spec).
- The per-file atomic-write mechanics, manifest mutations, branch-mapping registry mutations, and superseded-descendant cleanup of the per-repository folder mirror (covered by the folder-based summary storage spec).
- The schema of summary, plan, note, transcript, catalog, or topic-page documents (covered by their respective schema specs).
- The sync engine that uploads the parent folder to a remote service and merges peer writes (covered by the sync engine spec).
- The bootstrap process that downloads a remote vault into a fresh parent folder (covered by the sync engine spec).
- The classifier that decides which paths are eligible for sync staging (covered by the sync engine spec).
- The format of the parent-folder-rooted gitignore document or per-device sync-bootstrap state file (covered by the sync engine spec).
- The summary-tree, summary-index, summary-catalog, summary-schema-migration, topic-page-rendering, and related document-content semantics (covered by their respective specs).
- The write-boundary decision itself — the conditions under which a working directory may not claim a subdirectory here, the vocabulary of refusal reasons, their evaluation order, and the effective-state record and user-facing wording derived from them (covered by the memory-bank write-boundary and effective-state-reporting spec).
- The durable repo-wide manual-disable opt-out — how it is set, cleared, and stored, and the full inventory of writes it suppresses (covered by the manually-disabled zero-write-contract spec).
- Hook installation, queue worker mechanics, and any consumer that writes into this layout (covered by their respective specs).
- The UI surfaces (sidebar tree, decoration provider) that visualize the folder (covered by their respective specs); only the file-and-folder contract those surfaces consume is defined here.

## Data Contracts

### Parent folder
An absolute on-disk directory chosen by the user (the "parent folder"). May reside in a cloud-synced location (cloud-drive, network share, or similar) — this spec makes no assumption about backing media.

Default location, when the user has not picked one: a deterministic per-user path beneath the host operating system's user-home directory (a fixed product-namespaced subdirectory under the standard "Documents" location).

**Validation policy** (applied at every read of the configured value):
- An empty or absent configured value resolves to the default location with no warning.
- A configured value that is absolute and contains no parent-directory traversal segment (`..`) is honored as-is.
- Any other configured value is rejected with a warning and the resolution falls back to the default. A strict-mode variant of the same check, used by sync write paths, raises a typed error instead of falling back, so a misconfigured value never silently splits state across two locations.

The parent folder is the unit of cross-repository grouping. All repositories the user wants mirrored locally appear as direct children of this folder.

**Placement consequence.** For every caller that carries the write-boundary precondition (see Resolving a repository's subdirectory, step 0), a parent folder whose placement the Memory Bank write boundary refuses for a given repository yields **no per-repository subdirectory for that repository at all** — not an empty one, not a stub. The observed case is a parent configured at, or nested inside, a repository's own working tree: before the boundary existed, such a repository still received a subdirectory, created nested inside its own checkout (a parent that is itself a checkout claimed a same-named subdirectory one level inside itself). The refusal is a degradation, not an error — nothing on disk records it, which is why it is reported separately. The conditions under which a placement is refused, and the vocabulary of refusal reasons, are defined by **Memory Bank Write Boundary and Effective-State Reporting**.

The consequence is scoped to those callers, not to the layout as a whole: an ungated caller reaching the claiming mode against the same refused placement still creates the nested subdirectory (see step 0's exempt set).

### Cross-repository identity registry
A single file directly under the parent folder, inside a dot-prefixed subdirectory shared by no individual repository:

- `<parent>/<dot-namespace>/repos.json`

This document, when present, maps stable repository identities (e.g. a normalized clone URL) to subdirectory basenames under the parent. It exists so that:

- A peer device that pulls the parent folder learns which subdirectory holds the memories for a given repository identity, even if that subdirectory carries a collision suffix it would not have chosen itself.
- A local enumeration of repositories can attach the identity label to each discovered subdirectory.

**Document shape:**
- `version`: integer (currently 1).
- `mappings`: array of entries, each with `repoIdentity` (string) and `folder` (string). Both fields are required; rows missing either are dropped at read time.

**Read semantics:**
- A missing file is treated as an empty registry.
- A parse error is treated as an empty registry.
- A row whose shape is invalid (wrong types, missing fields) invalidates the **entire document**: the whole registry is treated as empty. (See the repo-identity-and-folder-naming spec for the full read-time validation policy, including the rationale.)
- The registry is **not** consulted to determine **which** subdirectories are repositories — it is consulted only to attach identity labels to subdirectories that are independently determined to be repositories (see Repository discovery below).

### Per-repository subdirectory
Each repository the user mirrors locally occupies one direct subdirectory of the parent folder, whose basename is the repository name (with optional numeric collision suffix). The basename is determined by a three-layer fallback:

1. The repository's configured remote-origin URL basename, with any trailing `.git` suffix stripped (the canonical name; survives folder renames and is identical across worktrees).
2. When no remote URL is set, the basename of the parent of the resolved canonical repository control directory (so a worktree resolves to the main checkout's directory name rather than the worktree's own basename).
3. When neither is available, the basename of the host directory path; failing that, the literal `unknown`.

**Collision and adoption policy** when the chosen basename already exists at the parent:

- **Fresh** (subdirectory absent): create it; write the repository's identity into the per-repository configuration document (see Hidden layer below).
- **Same repository** (subdirectory present, holds a configuration document whose recorded remote URL normalizes-equal to the host's remote URL — normalization is lowercase, trailing-slash and `.git` stripped — or where both remote URLs are absent and the recorded name matches or is unset): reuse in place.
- **Unclaimed stub** (subdirectory present, holds a configuration document with neither a remote URL nor a name recorded): adopt in place; overwrite the configuration document with the host's identity. This adoption proceeds regardless of whether other content is already present in the subdirectory, on the basis that refusing to adopt would orphan that content forever.
- **Different repository** (subdirectory present, holds a configuration document recording a different identity that does not normalize-equal): allocate the next available suffixed basename `<name>-2`, `<name>-3`, ..., up to `<name>-99`. Each candidate is itself subject to the same reuse / adoption checks. If the first 99 suffixes are all in use by other repositories, fall back to `<name>-<unix-millisecond-timestamp>` as a last-resort unique name.

A second resolution mode (the "fresh" / rebuild path) skips the same-repository reuse step and always returns the next unused suffixed candidate, used when the caller explicitly wants a new subdirectory rather than reuse.

A third resolution mode (the "peek" / read-only path) computes the same answer as the standard path but performs no filesystem mutations — no directory creation, no configuration write. Used by callers that need to know which subdirectory a repository would resolve to without claiming one (notably the rebuild flow, which must distinguish "subdirectory does not yet exist" from "subdirectory exists and would be reused").

**Atomicity contract for the standard resolution mode:** the returned path is guaranteed to have its configuration document fully populated with the caller's identity (remote URL and name) on return. Callers do not need a follow-up "initialize" call. This contract closes a recurring class of regressions where a follow-up step was skipped and the same repository was re-resolved to a `<name>-2` on the next call.

The contract has exactly one exception: while the project is **manually disabled**, the claim step writes nothing, so the returned path may be unclaimed and — when it was a fresh candidate — may not exist on disk at all. Nothing else about the selection changes: the same candidate is chosen, and re-enabling and resolving again claims it. See **Manually-Disabled Zero-Write Contract**.

### Per-repository hidden layer
Under each per-repository subdirectory, a dot-prefixed subdirectory holds machine-readable state. This layer is the source of truth for programmatic reads (the visible and wiki layers are derived).

**Aggregate documents** (single files):
- `manifest.json` — registry of every file the system has emitted into the visible or wiki layer, keyed by a stable identifier; carries a content fingerprint per row to support hand-edit detection and a human-readable display title. (Document shape and mutation semantics: see folder-based summary storage spec.)
- `branches.json` — branch-name → on-disk-folder-name mapping registry for the visible layer's per-branch directories. The folder name is a deterministic transcoding of the branch name (separator and shell-unsafe characters replaced with hyphens; empty result becomes the literal `default`).
- `config.json` — per-repository identity (recorded remote URL and recorded repository name) plus per-repository preferences (e.g. sort order).
- `migration.json` — progress state of any one-shot data migration the system runs on activation.
- `index.json` — projection of the per-repository summary index (heads and hoisted children, by branch and parent-pointer); written as a copy of the orphan-branch source of truth.
- `catalog.json` — cold-path enrichment data joined with the summary index by some surfaces (search, ticket-id projection); may be absent on legacy installs or installs written by surfaces that do not maintain it.
- `shadow-status.json` — **per-device** dirty marker. Present only when the most recent shadow-write into this repository's hidden layer failed and was suppressed; absent otherwise. Carries `dirty: true`, an ISO-8601 timestamp, and the message of the failing batch. This document is **not** synced across devices — it represents recovery state local to one device's mirror operations.

**Content directories** (one file per artifact, written verbatim from the source of truth):
- `summaries/<commitHash>.json` — one per top-level summary.
- `transcripts/<commitHash>.json` — one per captured transcript.
- `plans/<slug>.md` — one per plan.
- `notes/<id>.md` — one per note.
- `plan-progress/<slug>.json` — one per plan-progress artifact.
- `topics/<stableSlug>.json` — one canonical topic-page document plus a sibling `topics/index.json` projecting the topic set.
- Any other relative path written via the storage-provider surface lands as-is inside the hidden layer.

**Quarantine directories** (engine-managed, never synced, never scanned as user content):
- `quarantine-summaries/<basename>` — destination for files placed into `summaries/` whose basename does not match the canonical content-addressed naming.
- Any other dot-prefixed sibling quarantine directory the engine writes.

### Per-repository visible layer
Per-branch directories live directly under each per-repository subdirectory (siblings of the hidden layer):

- `<branch-folder>/<slug>-<hash8>.md` — visible Markdown rendering of a top-level summary. The slug is a normalized, length-capped, lowercase-alphanumeric-and-hyphen transcoding of the summary's commit message (empty result becomes the literal `untitled`, length cap is 50 characters with trailing hyphens re-trimmed). The hash suffix is the first 8 characters of the commit hash.
- `<branch-folder>/plan--<slug>.md` — visible Markdown copy of a plan.
- `<branch-folder>/note--<id>.md` — visible Markdown copy of a note.
- `<branch-folder>/` itself is the mapped name from the per-repository branch registry; on first use the mapping is created from a deterministic transcoding of the branch name; subsequent uses honor any rename recorded in the registry.

When the visible layer's writer cannot determine the originating branch (e.g. for a plan or note write where the source content does not embed a branch), the writer recovers the branch by extracting a trailing 7-or-more-character hash suffix from the slug and looking it up in the per-repository manifest (then the hidden index) for a matching commit's branch; if no match, the visible copy lands in the literal folder `_shared`.

Files in this layer are content-addressed by fingerprint in the manifest so that any subsequent system-driven overwrite or cleanup operation can compare the on-disk content against the recorded fingerprint and refuse to mutate a file whose content no longer matches (hand-edit protection).

### Per-repository generated topic-wiki layer
A reserved sub-folder directly under each per-repository subdirectory holds derived topic pages:

- `_wiki/topic--<stableSlug>.md` — one per canonical topic page.
- `_wiki/_index.md` — the wiki's index page. Its presence on disk doubles as the cheap "the wiki exists" probe.

This layer is **regenerated** from the hidden layer's canonical topic pages on every wiki render. A render is a full wipe-and-rewrite of `_wiki/*.md` plus an unregister of all manifest rows of the wiki type, followed by the new render. A crash mid-render can leave the wiki layer empty; this is recoverable because the next ingest re-renders from the canonical source.

Files in this layer are tracked in the same per-repository manifest as the visible layer, under a dedicated row type, so they are independently policed for hand-edit protection.

### System-reserved subdirectories
Within each per-repository subdirectory, two names are reserved by the system and are never treated as branch folders or as user content:
- the dot-prefixed hidden-layer name.
- the wiki layer name `_wiki/`.

A scan of "user-placed content" inside a per-repository subdirectory must skip these two names at the top level. Quarantine subdirectories beneath the hidden layer are likewise never scanned.

### User-placed content
The parent folder is also a place users may drop their own Markdown files (the folder doubles as an Obsidian-style knowledge dump). Such files are classified by scope according to where they sit:

- **Parent-wide scope**: a Markdown file at the parent folder's top level (`<parent>/*.md`), not inside any repository's subdirectory. These files are visible across all repositories.
- **Per-repository scope**: a Markdown file at a per-repository subdirectory's top level (`<repo>/*.md`), excluding the hidden layer and the wiki layer.
- **Per-branch scope**: a Markdown file inside a per-branch directory (`<repo>/<branch-folder>/*.md`), excluding any file that is also tracked by the per-repository manifest, excluding any file whose basename matches the system-generated naming patterns (the `-<8-hex>.md` suffix, or the `plan--`, `note--`, `topic--` prefixes).

**Classification rule** (AND of two checks, applied to per-repository and per-branch scope only; parent-wide scope skips the manifest check because files there can never appear in any per-repository manifest):
1. The file path (relative to the per-repository subdirectory) is **not** present in that subdirectory's manifest entries' path set.
2. The filename does **not** match the system-generated naming patterns.

A missing or unreadable per-repository manifest degrades to "secondary rule only" with a warning — the filename-pattern check alone determines classification.

A user-placed file's fingerprint is computed by the same algorithm used for the manifest's fingerprint, so user files and system files can be compared and de-duplicated downstream.

### Repository discovery
Two discovery surfaces enumerate repositories under the parent folder. Both operate from the same source of truth: a direct child subdirectory of the parent is a repository if and only if it contains the file `<dot-namespace>/index.json` at its top level. Configuration-file presence is a sufficient secondary signal in one of the two surfaces (see below).

The cross-repository identity registry (`repos.json`) is **not** used to determine which subdirectories are repositories — it is consulted only to attach identity labels to subdirectories that are independently discovered. This is deliberate: the registry is incomplete for purely local repositories that have never been synced.

**Surface A** (multi-repo sweep / compile target enumeration):
- Iterates direct child entries of the parent folder.
- Skips any entry that is not a directory or whose name begins with a dot.
- Skips any entry whose name matches a caller-supplied exclude pattern (exact match, or `*`-wildcarded glob).
- Includes any remaining entry that contains `<dot-namespace>/index.json` at its top level.
- Attaches the identity label from the cross-repository registry when present; leaves it unset otherwise.
- Returns the set sorted ascending by basename.

**Surface B** (sidebar / breadcrumb enumeration):
- Iterates direct child entries of the parent folder.
- Skips any entry that is not a directory or where the per-repository configuration document cannot be read.
- Treats the configuration document's recorded repository name (or, if absent, the directory basename) as the display label.
- Records the directory basename separately so the UI can disambiguate when two repositories share the same display name (e.g. via collision suffix).
- Sorts the result with the active host repository first (matched by remote URL when both sides have one; otherwise by name), then the rest alphabetically.

A missing or unreadable parent folder yields an empty enumeration in both surfaces (this is the normal state for a fresh install, or when a user has reconfigured the parent to a path that has not yet been created).

### Per-device sync-bootstrap state
A per-device state file directly under the parent folder, used by the sync engine's bootstrap (out of scope here; mentioned for inventory completeness): `<parent>/.memorybank-state.json`. Begins with a dot so it is never synced and never scanned as user content.

## Behavior

### Resolving a repository's subdirectory
0. **Precondition (caller-side).** A caller whose repository name is derived from an *ambient* working directory must first clear the Memory Bank write boundary and, on a refusal, choose a different storage backend instead of calling this resolution mode at all. The reason is that this mode is a claiming mode, not a lookup: it creates directories and writes identity (step 4 and the claim step below). Invoked from a working directory that is not a real project, it therefore permanently materializes a subdirectory named after that directory's basename — junk only the user can clean up. The predicate itself, its refusal reasons, and their evaluation order are defined by **Memory Bank Write Boundary and Effective-State Reporting**; this step defines only that the precondition is the caller's obligation and which callers carry it.

   **Callers that carry the precondition** are the three whose repository name comes from whatever working directory the process happens to have: write-side storage construction, read-side storage resolution (which reaches this mode through its folder-backend construction), and the user-knowledge scanner's root resolution.

   **Exempt callers** are the flows a user invokes deliberately against a project they already have open, where the resolution is the point of the command rather than an incidental side effect: the sync round's mirror initialization and the one-shot back-fill migration into the parent folder. The exemption is about the *invocation* being deliberate, not about the inputs being different — both still derive the repository name from a working directory exactly as the gated callers do. (The desktop editor's folder re-target flow is exempt for a different reason: it never reaches this mode at all, resolving through the peek mode and then claiming the chosen path explicitly.)

   The exempt set is wider than that list in practice: the desktop editor's activation-time mirror initialization, and the resolution adapter the JetBrains host reaches, both call the claiming mode with no boundary consultation. So a refused placement is closed only on the three gated seams, not on every surface. (See the boundary spec for the cross-host asymmetry.)
1. Compute the parent folder by applying the validation policy to the configured value.
2. Compute the repository basename via the three-layer fallback.
3. Compute the candidate path `<parent>/<basename>`.
4. If the candidate does not exist on disk: create it, write the per-repository identity into its hidden layer's configuration document, return the candidate path.
5. Otherwise read the candidate's per-repository configuration document.
6. If the document records the same repository (normalize-equal remote URL, or both absent and the recorded name matches or is unset): return the candidate path as-is. No write.
7. Otherwise, if the document is an "unclaimed stub" (recorded remote URL absent and recorded name absent): overwrite it with the caller's identity and return the candidate path. This adoption proceeds regardless of any other content already present in the subdirectory.
8. Otherwise (the document records a different repository): allocate the next available suffix. For `suffix = 2, 3, ..., 99`:
   - If `<parent>/<basename>-<suffix>` does not exist: create it, claim it, return.
   - If it exists and records the same repository: return as-is.
   - If it exists and is an unclaimed stub: claim it, return.
   - Otherwise continue.
9. If all 99 suffixes are taken by other repositories: allocate `<parent>/<basename>-<unix-millisecond-timestamp>`, claim it, return.

The "claim" step writes the per-repository configuration document with the supplied identity (atomic rewrite) and ensures the hidden-layer aggregate documents exist with their default content.

### Resolving without claiming (read-only / peek mode)
Identical to the above except every step omits filesystem mutation: no directory creation, no configuration write. Returns the path that **would** be claimed.

### Forcing a fresh subdirectory (rebuild mode)
Identical to the standard mode except step 6 (same-repository reuse) is skipped: even when the base candidate would be reusable, the resolver allocates the next unused suffix instead. Used when the caller deliberately wants a new subdirectory rather than reuse.

### Initializing the hidden layer
On first creation of a per-repository subdirectory's hidden layer:
1. Create the dot-prefixed hidden-layer directory.
2. On platforms where the dot prefix does not auto-hide (e.g. NTFS), set the platform-specific hidden attribute on the directory once at creation.
3. Seed default aggregate documents only if absent:
   - manifest: `{ version: 1, files: [] }`.
   - branches: `{ version: 1, mappings: [] }`.
   - config: `{ version: 1, sortOrder: "date" }`.
4. The default configuration document is then overwritten (in the standard / fresh / rebuild resolution paths) with one that additionally carries the recorded remote URL and recorded repository name.

### Enumerating repositories (multi-repo sweep)
1. If the parent folder does not exist on disk: return an empty list.
2. Read `<parent>/<dot-namespace>/repos.json` for identity labels; treat missing or unparseable as empty.
3. Iterate direct child entries of the parent folder. For each entry:
   - Skip if not a directory.
   - Skip if the name begins with a dot.
   - Skip if the name matches any caller-supplied exclude pattern.
   - Skip if `<entry>/<dot-namespace>/index.json` does not exist.
   - Include with attached identity label (or unset label).
4. Sort ascending by basename.
5. Return.

### Enumerating repositories (UI / sidebar)
1. Resolve the parent folder via the validation policy.
2. List direct children. ENOENT on the parent is silently treated as an empty list.
3. For each child directory whose per-repository configuration document is readable, project a discovered-repository row with:
   - the recorded repository name (or directory basename when absent) as the display name.
   - the directory basename recorded separately.
   - the recorded remote URL (or unset).
   - an "is current repository" flag set when the recorded identity matches the host's identity (URL match takes precedence; falls back to name match when either side has no URL).
4. Sort: the row with the "is current repository" flag set comes first; remaining rows alphabetical by display name.
5. Return.

### Classifying user-placed Markdown files
Triggered with a parent folder and (optionally) a branch:
1. Locate the per-repository subdirectory's hidden layer; if absent, return an empty result.
2. Read the per-repository manifest into a set of recorded paths (relative to the per-repository subdirectory); a missing or unreadable manifest degrades to an empty set with a warning.
3. **Parent-wide scope:** iterate `<parent>/*.md` (top level only). For each file: skip if the basename matches a system-generated naming pattern. Otherwise emit a record (the manifest check is skipped here because parent-wide files can never appear in any per-repository manifest).
4. **Per-repository scope:** iterate `<repo>/*.md` (top level only). For each file: skip if the basename matches a system-generated naming pattern; skip if its repository-relative path is in the manifest set. Otherwise emit a record.
5. **Per-branch scope:** if a branch was supplied, resolve the branch's folder name via the per-repository branch registry (falling back to the deterministic transcoding when no mapping exists), then iterate `<repo>/<branch-folder>/*.md` with the same per-file filter as the per-repository scope.
6. For each emitted record, compute:
   - the path relative to the parent folder (forward-slash separated).
   - the absolute path.
   - the scope (parent-wide, per-repository, per-branch).
   - the branch (only when scope is per-branch).
   - the content fingerprint (same algorithm used by the manifest).
   - the file content.
   - the file mtime in ISO-8601.

A "scan every branch on disk" variant exists for ingestion pipelines that need to enumerate user content without a known branch list. It enumerates direct subdirectories of each per-repository subdirectory, excludes the system-reserved names (the hidden-layer directory name, `_wiki`), reverse-maps each remaining subdirectory's name to a branch via the per-repository branch registry (falling back to the subdirectory's name when no mapping exists), and emits per-branch records for every contained Markdown file.

### Hand-edit protection on the visible and wiki layers
Every system-driven write to the visible layer or the wiki layer follows the same protection contract:

1. The path-to-write is computed from the source-of-truth document.
2. The current manifest entry for that file ID is looked up.
3. If the destination file exists on disk AND the manifest entry carries a recorded fingerprint AND the on-disk fingerprint differs from the recorded fingerprint: log the skip at info level and do **not** overwrite. The user's hand-edited content is preserved.
4. Otherwise write atomically (rename-from-temp) and update the manifest entry with the new fingerprint.

The same fingerprint check guards cleanup of superseded descendants and any "regenerate" path that unlinks before re-emitting:
- A missing fingerprint baseline (legacy entries written before fingerprint tracking) is treated as "do not delete" / "do not overwrite" — the system cannot prove it wrote the file.
- A file whose on-disk fingerprint no longer matches the recorded fingerprint is preserved with a warning.
- A read error while computing the on-disk fingerprint is conservative: treat as edited (preserve).

Force-regenerate paths (used by explicit "discard my edits" user actions) validate the hidden-layer source first, then unlink, then re-emit. The hidden-layer validation happens before any unlink so that a missing or malformed hidden source does not destroy the user's only remaining copy.

### Per-device shadow-dirty marker
- The marker file `<repo>/<dot-namespace>/shadow-status.json` is written, atomically, after a shadow-side write failure has been suppressed by the dual-write orchestrator.
- It is deleted after a subsequent successful shadow-side write.
- A presence check `exists?` is the only consumer-visible read; downstream code uses it to decide whether to surface a "your mirror is behind" UI indicator.
- The marker is per-device (it represents local recovery state) and is intentionally excluded from sync.

### Topic-wiki regeneration
1. Compute the wiki directory path `<repo>/_wiki`.
2. Wipe the wiki: in a single atomic manifest mutation, drop every manifest row of the wiki type. Then iterate `<repo>/_wiki/*.md` and unlink each one. Errors during unlink are warned, not fatal.
3. Recreate the wiki directory.
4. For each canonical topic page in the input set: render the per-topic Markdown, atomically write to `_wiki/topic--<stableSlug>.md`, register a manifest row of the wiki type with the new fingerprint.
5. Render the index page, atomically write to `_wiki/_index.md`, register a manifest row.
6. A crash mid-render leaves the wiki layer empty (the manifest unregister already happened); recoverable on the next ingest.
7. The presence of `_wiki/_index.md` is the cheap probe for "the wiki layer exists".

### Symlink-safe writes
Every system-driven write under any per-repository subdirectory routes through a vault-aware safe-write helper. The helper, given the parent folder as the safety root:
- Walks the path chain from the parent down to the target's parent directory and refuses if any intermediate segment is a symlink.
- Opens the temporary write target with no-follow flags so a pre-placed symlink at the leaf cannot redirect the write.
- Renames the temporary file over the target atomically.

A best-effort write (e.g. the shadow-dirty marker) catches the safety-helper's throw, logs a one-line warning naming the call site, and otherwise swallows; this preserves the helper's loud signal in operator logs while keeping the operation non-fatal at the call surface.

## State Transitions

The parent folder progresses through observable states:

- **Absent**: parent directory does not exist; all enumerations return empty.
- **Present, no repositories**: parent exists but contains no per-repository subdirectory with a hidden-layer `index.json`; cross-repository registry may or may not exist.
- **Present, with repositories**: one or more per-repository subdirectories satisfy the discovery criterion.

Each per-repository subdirectory has its own states:

- **Absent**: subdirectory does not exist under the parent.
- **Stub** (post-`ensure`, pre-claim): hidden layer exists with default aggregate documents but the configuration document records no identity. Eligible for in-place adoption.
- **Claimed**: configuration document records a remote URL and/or repository name. The standard resolution path always returns subdirectories in this state.
- **Dirty** (mirror-recovery state): in any of the above states except Absent, additionally carries the per-device shadow-dirty marker.

Allowed transitions (from this layer's perspective; orchestration is in dual-write spec):
- Absent → Stub: implicit on first ensure of the hidden layer.
- Stub → Claimed: write of the per-repository identity into the configuration document.
- Claimed → Dirty: shadow-side write failure suppressed by the orchestrator.
- Dirty → Claimed: subsequent successful shadow-side write.

The visible and wiki layers have no explicit state; their presence is a function of which manifest rows exist and which corresponding files are on disk. Hand-editing a visible or wiki file does not change its manifest row (the row still records the system's last-written fingerprint), but every subsequent system attempt to overwrite or clean up that file will detect the divergence and preserve the file.

## Notable Behavior

- **Parent folder doubles as user knowledge dump.** Users may drop arbitrary Markdown files at the parent's top level, at any per-repository subdirectory's top level, or inside any per-branch directory. The system reads these as scoped user knowledge and feeds them into downstream ingestion; the user is **not** required to invoke any command to "import" content — placing the file on disk is the import. (Notable; intentional design choice.)
- **Discovery is filesystem-driven, not registry-driven.** The cross-repository identity registry (`repos.json`) is **not** consulted to determine which subdirectories are repositories. The registry is a label source only — it would be incomplete for any locally-only repository. (Notable; this caused real bugs in earlier iterations that tried to use the registry as the discovery source.)
- **Unclaimed-stub adoption preserves user data.** When a per-repository subdirectory exists with a default-stub configuration (no recorded identity) but with real data already in its hidden-layer content directories, the standard resolution path adopts that subdirectory in place rather than spawning a fresh `-N` sibling. The reverse policy would orphan the user's accumulated data on every relaunch. (Surprising; intentional regression-closer.)
- **Atomic claim contract on every resolve.** The standard resolution path is documented to always return a subdirectory whose configuration document carries the caller's identity. Callers do not need a follow-up initialize step. Earlier iterations of this layer required a separate initialize call; forgetting it was a recurring cause of phantom `-N` subdirectories. (Notable; intentional.)
- **Read-only peek mode is separate from the claiming mode.** A pure-read sibling of the resolver exists for callers that need to know which subdirectory would be used without creating one — needed by the rebuild flow, which must distinguish "no prior subdirectory" from "prior subdirectory exists and would be reused", and by the effective-Memory-Bank-state report, which must be able to say where writes will land without that answer being what creates the destination. (Notable.)
- **The claiming resolver is gated from outside, not defensive from within.** The write-boundary precondition is enforced at each caller rather than inside the resolver, and deliberately so: the only useful response to a refusal is "use a different storage backend", and the resolver cannot choose a backend — only its caller can. A resolver-internal check would have to either throw (turning a routine non-project working directory into a failed command) or return a path it refuses to claim (which the atomicity contract above forbids). The cost of the choice is that the precondition is enforced socially: a new caller that derives its repository name from an ambient working directory and forgets the gate re-opens the junk-folder class of bug, and no automated check catches it. (Notable; intentional, with a known enforcement gap.)
- **No silent relocation: any repository that resolved to a given subdirectory before still resolves to the same one.** The write-boundary precondition is a pure precondition — when it allows, resolution proceeds under exactly the naming rule, the reuse / adoption / suffix-ladder policy, the peek mode's mirroring of that selection, the fresh-mode allocator, the archive destination, and the remote-URL normalization documented above, all unchanged; when it refuses, nothing is created. No previously-resolved per-repository subdirectory moves, is renamed, or is re-numbered as a consequence. This is load-bearing for anyone auditing the change: the only observable difference is *whether* a subdirectory is claimed, never *which*. (Notable; load-bearing.)
- **99-suffix cap with timestamp fallback.** If 99 numbered suffixes are all in use, the resolver falls back to a unix-millisecond-suffixed name rather than refusing. Data preservation wins over uniqueness aesthetics. (Surprising; intentional.)
- **Worktree-aware repository naming.** When a host repository is a git worktree, the second fallback layer of the naming rule deliberately walks past the worktree pointer to the main checkout's directory name, so a worktree and its main checkout share one per-repository subdirectory rather than getting parallel mirrors under the worktree's own basename. (Notable; intentional.)
- **Generated naming patterns are duplicated in two places.** The visible layer's `-<8-hex>.md` suffix and `plan--`/`note--`/`topic--` prefixes are recognized as system-generated by both the writer (which uses them) and the user-content scanner (which excludes them). Changing the convention in one place without updating the other would either let generated files leak through as "user knowledge" (double-folding their content) or hide newly-renamed visible files from the system. (Notable; intentional duplication is called out at both ends.)
- **`_wiki/` is always regenerable, never source-of-truth.** A crash mid-wiki-render can leave `_wiki/` empty. This is documented as a recoverable state — the next ingest re-renders from the canonical topic pages in the hidden layer. The presence of `_wiki/_index.md` is the cheap "wiki layer exists" probe. (Notable.)
- **Wiki manifest unregister happens before disk wipe.** The order is intentional: even if the disk wipe fails partway, surviving `_wiki/*.md` files become orphan user-content (recoverable) rather than ghost generated entries (incoherent). (Notable; intentional ordering.)
- **`shadow-status.json` is per-device and never synced.** This marker represents local recovery state from a suppressed shadow-write failure. It is excluded from sync because peers' mirror state is independent. The marker's name is duplicated in three places (hidden-layer reserved name, sync classifier rejection list, bootstrap untrack list) so that one of the three catching it is sufficient. (Notable; intentional defense-in-depth duplication.)
- **Hand-edit detection is conservative.** Every system-driven write to the visible or wiki layer checks the on-disk fingerprint against the manifest fingerprint and refuses to overwrite when they differ. A missing baseline (legacy row) is also treated as "do not touch". A read error while computing the on-disk fingerprint is treated as "assume edited". The net effect: the user cannot lose their visible-file edits by virtue of a system write — but the visible file may diverge indefinitely from the system view. UI surfaces are expected to expose a divergence badge. (Notable; intentional.)
- **Force-regenerate validates the source before unlinking.** The path that exists to explicitly discard a user's hand-edits validates the hidden-layer source content first, then unlinks the visible copy, then re-emits. The validation-before-unlink ordering exists because the visible file is the user's only copy of their edits — destroying it before knowing the hidden source can produce a replacement would turn the safety command into a data-loss path. (Notable; intentional.)
- **Plan/note slug-based branch fallback.** When a plan or note write does not specify a branch, the writer attempts to recover the branch from a hash suffix embedded in the slug (looking it up in the manifest and then in the hidden index); if recovery fails, the visible copy lands in the literal folder `_shared`. (Surprising.)
- **Branch-folder removal on last hoist.** When a queue operation hoists the last live head off a branch (cross-branch amend / cherry-pick / rebase), the branch is left with only hoisted-child entries in the index and no surviving visible file. A cleanup tail step drops the branch-mapping row and (best-effort) removes the on-disk per-branch directory if empty, so the UI does not list a branch with zero visible content. The on-disk directory removal is no-op if non-empty (preserves any user-dropped files in that directory). (Notable; intentional.)
- **Per-repository subdirectory's top-level files are user content, not system content.** The system never writes `.md` files directly to `<repo>/`'s top level — that scope is reserved for user-placed per-repository notes. The classifier consequently does not need a manifest check for parent-wide-scope files. (Notable.)
- **A single malformed cross-repository registry row poisons the whole document.** When any row has a non-string `repoIdentity` or non-string `folder` (a missing `folder` field is also non-string), the entire registry is treated as empty rather than the bad row being dropped while the rest survive. The registry is treated as a labelling hint, never as a determinant of correctness, so an empty-on-parse-error fallback never compromises discovery. (Notable; see the repo-identity-and-folder-naming spec for the canonical rule.)
- **Folder enumeration silent on missing parent.** A parent folder that does not exist on disk yields an empty enumeration in both surfaces, rather than an error. This matches the "fresh install" and "reconfigured to a path that has not been created yet" paths. (Notable.)
- **Quarantine subdirectories beneath the hidden layer are reserved.** The user-content classifier skips them, the sync classifier rejects them, and the bootstrap process's `.gitignore` denies them. The classification is duplicated so that one layer's bug cannot cause quarantined files to leak. (Notable; defense-in-depth.)
- **Default configuration document overwritten on every claim.** A hidden layer ensures default aggregate documents only when absent (idempotent), but every standard / fresh / rebuild resolution explicitly rewrites the configuration document with the caller's identity. The reverse policy — "preserve existing config" — was the cause of the recurring "subdirectory exists but config records no identity" stub bug. (Notable; intentional.)
- **Symlink-safe writes refuse to follow intermediate symlinks.** A per-write helper walks the path chain from the parent folder down to the target's parent and throws if any intermediate segment is a symlink. The leaf is opened with no-follow flags so a pre-placed symlink at the leaf cannot redirect the write. Best-effort callers (e.g. the dirty marker) catch the throw, log, and swallow; non-best-effort callers (every system write under the per-repository subdirectory) propagate. (Notable; intentional.)
- **Per-repository directory names may carry collision suffixes the user did not choose.** Two distinct repositories whose chosen basename collides will resolve to `<name>` and `<name>-2` (or further). UI surfaces are expected to display the directory basename alongside the recorded repository name when they differ. (Notable; intentional disambiguation aid.)
- **Same-repository reuse is normalized.** URL comparison is case-insensitive and strips trailing slashes and `.git` suffixes before comparing. This means `https://Example.com/Foo.git/`, `https://example.com/Foo`, and `https://example.com/foo.git` all normalize to the same identity and reuse the same subdirectory. (Notable.)

## Shared Behavior

- The canonical, version-controlled-ref source of truth that this folder mirrors, including ref naming, write-batch semantics, and plumbing primitives, is defined by the orphan-branch summary storage spec.
- The atomic-write mechanics, per-file write contract, manifest mutation semantics, branch-mapping registry mutation semantics, superseded-descendant cleanup, manifest reconciliation, and the per-file shape of the visible layer are defined by the folder-based summary storage spec.
- The orchestration of the version-controlled-ref backend with the per-repository folder mirror (which gets the primary read role, when each is written, and how dirty-flag state is set or cleared) is defined by the dual-write summary storage spec.
- The write-boundary predicate that gates the claiming resolution mode, its refusal reasons and evaluation order, the three consumers that consult it and how each degrades, and the effective-state record and wording that make a refusal visible to the user are defined by the memory-bank write-boundary and effective-state-reporting spec. This spec defines the naming, reuse, adoption, and suffix rules that a resolution applies *after* the boundary allows, and the peek mode that report resolves through.
- The durable repo-wide manual-disable opt-out, which suppresses the claim step's identity write, is defined by the manually-disabled zero-write-contract spec.
- The schema of summary, plan, note, transcript, catalog, topic-page, and index documents is defined by their respective schema specs.
- The cross-device synchronization of the parent folder (clone, fetch, merge, allowlist staging, conflict resolution, the parent-rooted gitignore, the per-device bootstrap state file, the per-device transcript-sync toggle, and quarantine of non-content-addressed summaries) is defined by the sync engine spec.
- The user-facing UI for picking the parent folder, displaying the per-repository tree, badging hand-edited files, and surfacing cross-repository registry conflicts is defined by the respective host-specific UI specs.
