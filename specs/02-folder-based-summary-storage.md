# 02. Folder-Based Summary Storage

## Topic Statement
Store summaries as plain files inside a user-chosen knowledge-base folder, mirrored from a configurable parent location, with a metadata sidecar tracking AI-generated files and branch-to-folder mappings.

## Scope
**In scope:**
- Resolution of the knowledge-base root directory from a configurable parent path and a derived repository name.
- The three-layer file layout: a hidden subdirectory for machine-oriented data files, visible per-branch subdirectories for human-readable copies, and a reserved generated-topic-wiki subdirectory for derived per-topic Markdown pages.
- The metadata sidecar (manifest of AI-generated files spanning commit, plan, note, and wiki entries, branch-to-folder mapping registry, KB-level configuration, migration progress).
- The atomicity model for individual file writes and deletes.
- How visible markdown copies are produced for summary, plan, and note inputs.
- How the generated topic-wiki layer (per-topic page plus an index page) is rebuilt and registered.
- How the storage-provider contract (read/write batch/list/exists/ensure, plus dirty-flag operations) is satisfied.
- Cleanup of superseded visible copies after squash/amend operations.
- Reconciliation of manifest paths against on-disk locations.

**Out of scope (boundaries):**
- The schema of summary, plan, or note content (covered by "Summary Tree Structure" and downstream consumers).
- The schema of canonical topic pages, the topic-index document, and the slug-safety / orphan-purge semantics that produce the input to the wiki rebuild (covered by "Topic Index and Page Storage").
- The body composition of each per-topic wiki page and the wiki index page, including cross-link resolution against the visible commit-summary layer (covered by "Wiki Markdown Rendering").
- The wider per-repository folder layout: the parent-folder identity registry, the user-placed Markdown classification rules, and the system-reserved-name policy that protects the hidden, visible, and wiki layers (covered by "Memory Bank Folder Layout").
- UI surfaces that badge hand-edited visible or wiki files (covered by "VS Code Memory-File Divergence Decoration" and host-specific equivalents).
- The version-controlled-ref backend that this storage can mirror (covered by "Orphan Branch Summary Storage").
- Combination semantics with the version-controlled-ref backend (covered by "Dual-Write Summary Storage").
- Push-to-cloud or sync to remote services.
- The schema of the summary-index document, plan files, or note files; this storage stores them verbatim and parses only enough to derive routing and titles.

## Data Contracts

### Knowledge-base root
An absolute directory path of the form `<parent>/<repoName>` (with optional numeric suffix on collision).

- `<parent>` is determined by:
  - The user-configured custom parent path, if provided AND it is absolute AND it does not contain `..`. Otherwise the configured value is rejected with a warning.
  - On rejection or absence, the default parent is `<userHome>/Documents/<product-namespace>`.
- `<repoName>` is derived by a three-layer fallback:
  1. The basename of the configured remote-origin URL of the host repository, with any trailing `.git` suffix stripped.
  2. If no remote URL: the basename of the parent of the resolved common ref-storage directory of the host repository (so a worktree resolves to the main repository's directory name).
  3. If neither is available: the basename of the project path; failing all of the above, the literal `unknown`.

  The git plumbing calls behind layers 1 and 2 (reading the remote-origin URL and resolving the common ref-storage directory) are each bounded by a timeout — a 30-second default, overridable via an environment variable — and are retried once on a timeout, the retry using the smaller of the main timeout and 5 seconds. This timeout was raised from an earlier 5-second cap: under load (a full test-plus-coverage run, or a busy CI runner) the git subprocess can be merely *scheduled late* rather than genuinely hung, and the old cap would trip, be swallowed as "not a git repository", and silently degrade resolution to the last-resort basename layer. For a worktree that basename is the worktree's own directory name rather than the main repository's, which spawns a second, parallel Memory Bank folder for the same repo. The raised timeout plus the single retry keeps a merely-late git call from causing that split.

### Collision handling on resolution
- If the candidate `<parent>/<repoName>` does not exist on disk, it is used as-is.
- If it exists and contains a KB-config file with a `remoteUrl` that normalizes-equal to the host's remote URL (lowercase, trailing slashes and `.git` stripped), it is reused.
- If it exists and contains a KB-config file with no `remoteUrl` AND the host has no remote URL AND the config's `repoName` is null or matches, it is reused.
- Otherwise: try suffixed candidates `<parent>/<repoName>-2`, `-3`, ... up to `-99`. The first candidate that does not exist OR matches by remote URL is returned. If all 99 are used, the result is `<parent>/<repoName>-<unixMillisecondsTimestamp>` as a last resort.

A separate "find fresh path" entry point skips the same-repo reuse step and always returns the next unused suffixed path (used by KB rebuild flows).

### Hidden-layer layout (under `<root>/.<product-namespace>/`)
- `manifest.json` — Manifest document (see below).
- `branches.json` — Branch-to-folder mapping registry (see below).
- `config.json` — KB-level configuration (see below).
- `migration.json` — Migration progress state (see below).
- `summaries/<commitHash>.json` — One file per top-level summary, written verbatim.
- `transcripts/<commitHash>.json` — One file per transcript, written verbatim.
- `plans/<slug>.md` — One file per plan, written verbatim.
- `notes/<id>.md` — One file per note, written verbatim.
- `plan-progress/<slug>.json` — One file per plan-progress artifact, written verbatim.
- `index.json` — Hidden copy of the summary index document, written verbatim.
- `shadow-status.json` — Optional dirty marker (see below).
- Any other relative path passed to `writeFiles` is created as-is under this hidden directory (notably: canonical topic pages and topic-index, plus the topic-ingest high-water mark; see "Topic Index and Page Storage").

### Generated topic-wiki layer (under `<root>/_wiki/`)
A reserved sub-folder, sibling to the hidden layer, containing the derived human-readable topic-knowledge wiki:
- `_wiki/topic--<stableSlug>.md` — one visible Markdown page per canonical topic.
- `_wiki/_index.md` — the wiki index page. Its presence on disk doubles as the cheap "wiki layer exists" probe.

Files in this layer are tracked in `manifest.json` under a dedicated row type (`wiki`) and protected by the same hand-edit-fingerprint contract as the visible commit/plan/note layer. The wiki layer is **regenerated**, never a source of truth: every rebuild is a full wipe of `_wiki/*.md` plus an unregister of every wiki-typed manifest row, followed by re-emission from the canonical topic pages.

### Manifest document
- `version`: integer.
- `files`: array of entries, each with:
  - `path`: relative path of the generated Markdown file from the KB root, slash-separated.
  - `fileId`: a stable identifier:
    - For commit summaries: the commit hash.
    - For plans: the literal string `plan:<slug>`.
    - For notes: the literal string `note:<id>`.
    - For wiki topic pages: the literal string `wiki-topic-<stableSlug>`.
    - For the wiki index page: the literal string `wiki-index`.
  - `type`: one of `commit`, `plan`, `note`, `wiki`.
  - `fingerprint`: a 256-bit cryptographic hash (hex digest) of the generated file's textual content at write time.
  - `source`: object with optional `commitHash`, `branch`, `generatedAt`. For commits all three are populated; for plans and notes, only `branch` is populated when known (empty object otherwise); for wiki entries, only `generatedAt` is populated.
  - `title`: optional human-readable display name.
  - `updatedAt`: optional ISO-8601 last-write time (populated on plan and note writes; used as an ordering key by downstream consumers).

### Branch-mapping registry
- `version`: integer.
- `mappings`: array of entries, each with:
  - `folder`: visible folder name.
  - `branch`: original branch name.
  - `createdAt`: ISO-8601 timestamp.

The folder name is derived from the branch name by a deterministic transcoding:
- Replace each character in the set `/`, `\`, `:`, `*`, `?`, `~`, `^` with `-`.
- Collapse runs of three or more `-` to a single `-`.
- Replace literal `..` with `--`.
- Trim leading and trailing `.` and `-`.
- If the result is empty, use the literal `default`.

### KB-level configuration
- `version`: integer.
- `sortOrder`: enumeration `date` or `name`. Default is `date` on first creation.
- `remoteUrl`: optional string (the host repository's remote-origin URL at KB-init time).
- `repoName`: optional string (the resolved repository name at KB-init time).

### Migration state
- `status`: enumeration `pending`, `in_progress`, `completed`, `partial`, `failed`.
- `totalEntries`: integer.
- `migratedEntries`: integer.
- `failedHashes`: optional array of strings.
- `lastMigratedHash`: optional string.

### Visible-layer layout
Per-branch directories rooted at the KB root:
- `<branchFolder>/<slug>-<hash8>.md` — one visible markdown file per top-level summary, where `<slug>` is a 50-character-cap, lowercase, alphanumeric-and-hyphen slug of the commit message, and `<hash8>` is the first 8 characters of the commit hash.
- `<branchFolder>/plan--<slug>.md` — one visible markdown copy per plan.
- `<branchFolder>/note--<id>.md` — one visible markdown copy per note.

The branch folder is resolved from the branch name via the branch-mapping registry, creating a new mapping on first use. If a write occurs without an explicit branch and the slug embeds a hash suffix (≥7 characters), the branch is recovered by:
1. Searching the manifest for a commit entry whose `source.commitHash` starts with that hash prefix.
2. Falling back to searching the hidden index document for an entry whose `commitHash` starts with that prefix.
3. Falling back to the literal folder name `_shared`.

### Summary visible-file content
The file consists of a YAML-style frontmatter block followed by a body. The frontmatter contains, in order:
- `commitHash`
- `branch`
- `author`
- `date`
- `type: commit`
- `commitType` (only if present in the source)
- `filesChanged`, `insertions`, `deletions` (only if a diff-stats sub-object is present)

### Plan visible-file content
A frontmatter block (`type: plan`, `slug: <slug>`) followed by a blank line and the plan's verbatim source content.

### Note visible-file content
A frontmatter block (`type: note`, `id: <id>`) followed by a blank line and the note's verbatim source content.

### Topic-wiki layer files
The per-topic Markdown page and the wiki index page. The body composition of each (heading, generated-by banner, metadata blockquote, body, optional key-decisions / source-commits / related-branches sections, and link resolution against the visible commit-summary layer) is owned by the wiki-rendering spec. This storage's responsibility is the file layout, the wipe-and-rewrite ordering, the manifest registration, and the hand-edit-fingerprint contract.

### Dirty marker (`shadow-status.json`)
- `dirty`: boolean true.
- `lastFailedAt`: ISO-8601 timestamp.
- `message`: contextual string from the failing batch's commit message.

## Behavior

### Path resolution and KB initialization
- `resolveKBPath(repoName, remoteUrl?, customParent?)` produces the KB root using the parent rules, repo name rules, and collision handling above.
- A separate `findFreshKBPath` skips the reuse step.
- `initializeKBFolder` creates the hidden subdirectory, ensures default sidecar files exist, then writes/updates the KB-level config to record the resolved `remoteUrl` and `repoName`.

### `ensure()`
1. Recursively create the KB root directory.
2. Initialize the hidden subdirectory: create it if missing; write a default `manifest.json` (`{version: 1, files: []}`), default `branches.json` (`{version: 1, mappings: []}`), and default `config.json` (`{version: 1, sortOrder: "date"}`) only if they do not exist.

### `exists()`
Returns whether the KB root directory exists on disk.

### `readFile(path)`
Returns the textual content of `<root>/.<product-namespace>/<path>`, or null if absent or unreadable.

### `writeFiles(files, message)`
1. Run `ensure()`.
2. Initialize counters (written, deleted).
3. For each entry in batch order:
   - If `delete` is true: remove the file at `<root>/.<product-namespace>/<path>`. If the file does not exist or cannot be removed, treat as no-op for the deleted counter.
   - Otherwise:
     1. Atomically write the content to the hidden path (see "Atomic write" below).
     2. If the path is `summaries/<x>.json`, additionally generate a visible summary markdown (see "Summary visible generation").
     3. If the path is `plans/<x>.md`, additionally generate a visible plan markdown.
     4. If the path is `notes/<x>.md`, additionally generate a visible note markdown.
4. Log the counters with the supplied message.

The batch is **not** transactional: failures partway through leave a mix of applied and unapplied operations. Each individual file write is atomic via the rename-from-temp pattern.

### Atomic write (single file)
1. Recursively create the parent directory of the target.
2. Write the content to a sibling path with a `.tmp` suffix.
3. Rename the temp file over the target path.

### Summary visible generation
1. Parse the summary's textual content as JSON. If parsing fails, return without generating a visible copy.
2. Resolve the branch folder for the summary's `branch` via the mapping registry, creating a mapping if needed.
3. Compute the visible file name as `<slugify(commitMessage)>-<commitHash[0..8]>.md`.
4. Build the YAML-style frontmatter listed in Data Contracts.
5. Build the body using the configured visible-summary builder (verbatim — this storage does not define the body shape, only that the frontmatter precedes it with a single newline separator).
6. Compose the visible markdown as `<frontmatter>\n<body>`.
7. Hand-edit guard: look up any existing manifest entry by the target relative path. If a file exists at the target and its on-disk content's fingerprint differs from the manifest entry's recorded fingerprint, log the skip and return without writing.
8. Otherwise atomically write to `<root>/<branchFolder>/<fileName>`.
9. Update the manifest with an entry whose `fileId` is the commit hash, `type` is `commit`, `fingerprint` is the cryptographic hash of the composed markdown, `source` records `commitHash`, `branch`, `generatedAt`, and `title` is the commit message.
10. If the summary node has children, run "superseded-descendant cleanup".

### Superseded-descendant cleanup
Triggered when a newly written summary has a non-empty `children` array (the new node is a squash or amend root that wraps prior root summaries).
1. Recursively collect every descendant `commitHash` from the children array.
2. For each descendant hash:
   - Look up its manifest entry by `fileId`. Skip if absent or its `type` is not `commit`.
   - Defensive: skip if the entry's path equals the path of the just-written new root (would only happen on a hash-prefix collision).
   - If the entry's path no longer exists on disk: drop the entry from the manifest and continue (treats it as already cleaned up by an earlier pass or a manual deletion).
   - Otherwise read the on-disk file's bytes, compute its cryptographic hash, and compare to the manifest entry's `fingerprint`.
   - If the hash differs, log a warning and **keep** the file (treating it as hand-edited content).
   - If the hash matches, delete the file from disk and remove the manifest entry.
   - Catch and log read or delete errors as warnings; do not abort the batch.

### Plan visible generation
1. Recover the slug by stripping `plans/` prefix and `.md` suffix from the entry path.
2. Resolve the branch folder: prefer the entry's `branch` field; otherwise apply the slug-based fallback (search manifest commit entries by `source.commitHash` starting with the trailing hash-suffix of the slug; then search the hidden index by `commitHash`; finally `_shared`).
3. Compose visible markdown as `<frontmatter>\n\n<plan content verbatim>`.
4. Hand-edit guard: same on-disk-fingerprint check as the summary path. Skip write on divergence.
5. Otherwise atomically write to `<root>/<branchFolder>/plan--<slug>.md`.
6. Compute the cryptographic hash of the composed markdown and update the manifest with `fileId = "plan:<slug>"`, `type = "plan"`, `updatedAt` set to the current ISO-8601 instant, `source = { branch }` when a branch was supplied (empty otherwise), and a `title` taken from the first markdown `# ` heading in the source content (falling back to the slug).

### Note visible generation
Symmetric to plan, with prefix `notes/`, file name `note--<id>.md`, manifest `fileId = "note:<id>"`, `type = "note"`, and title taken from the first `# ` heading or the id.

### Topic-wiki rebuild
Triggered by an explicit "rebuild the wiki" call against a snapshot of canonical topic pages (the snapshot's content schema and ordering are defined by "Topic Index and Page Storage"; the per-page rendered Markdown content is defined by "Wiki Markdown Rendering"). This entry point is **not** invoked by `writeFiles`. The visible-wiki surface is optional on the storage-provider contract: implementations without a visible layer (e.g. the version-controlled-ref backend) omit it; the dual-write composite delegates to the folder-backed shadow.
1. Compute the wiki directory path `<root>/_wiki`.
2. Wipe the wiki: in a single atomic manifest mutation, drop every manifest row of `type = "wiki"`. Then iterate `<root>/_wiki/*.md` and unlink each one (errors during unlink are warned, not fatal). If the wiki directory does not exist, the unlink phase is skipped.
3. Build a render context joining the KB-level repository display name (from `config.json`), the branch-mapping registry, and a manifest projection over commit-typed rows keyed by their first 8 hash characters.
4. Recreate the wiki directory.
5. For each canonical topic page in the input set: render the per-topic Markdown via the wiki renderer, atomically write to `_wiki/topic--<stableSlug>.md`, and register a manifest entry with `fileId = "wiki-topic-<stableSlug>"`, `type = "wiki"`, the fingerprint of the rendered Markdown, `source = { generatedAt: <page's last-updated instant> }`, and `title = <topic title>`. A single topic that throws during render is logged and skipped without aborting the rebuild.
6. Render the wiki index page via the renderer, atomically write to `_wiki/_index.md`, and register a manifest entry with `fileId = "wiki-index"`, `type = "wiki"`, the fingerprint of the rendered index, `source = { generatedAt: <current ISO-8601 instant> }`, and `title = "<repoName> Knowledge Wiki"`. An index render failure is logged and swallowed; the per-topic pages still land on disk.

A "wiki layer exists" probe is provided as an inspection-only entry point and returns whether `<root>/_wiki/_index.md` exists on disk.

### `listFiles(prefix)`
1. Compute `<root>/.<product-namespace>/<prefix>`. If absent, return empty list.
2. Recursively walk that directory, collecting paths relative to the hidden directory (so the returned paths are usable verbatim with `readFile` and `writeFiles`).
3. Return them sorted lexicographically.

### Dirty-flag operations
- `markDirty(message)`: best-effort atomic-write of `<hiddenDir>/shadow-status.json` with `{dirty: true, lastFailedAt, message}`. Errors are swallowed silently.
- `clearDirty()`: best-effort delete of that file. Errors are swallowed silently.
- `isDirty()`: returns whether that file currently exists.

### Manifest reconciliation (used by the metadata-management surface, not by writeFiles)
Triggered by an explicit reconcile call against the KB root.
1. Load the manifest. If empty, return 0.
2. Walk the KB root recursively (skipping any directory or file whose name starts with `.`), collecting `fingerprint -> relativePath` for every `.md` file.
3. For each manifest entry:
   - If the entry's path exists on disk: keep the entry unchanged.
   - Otherwise: look up the entry's `fingerprint` in the walk map. If a match is found at a different path, replace the entry's path with the new path and increment the fix counter.
   - If no fingerprint match is found: log a warning and **keep the entry as-is** (data-loss avoidance).
4. If any fixes were applied, atomically rewrite the manifest.
5. Return the fix count.

### Slug derivation (`slugify`)
1. Lowercase the input.
2. Drop any character that is not alphanumeric, whitespace, or hyphen.
3. Replace runs of whitespace with a single hyphen.
4. Collapse runs of two or more hyphens to a single hyphen.
5. Trim leading and trailing hyphens.
6. If the result is longer than 50 characters, truncate to 50 and re-trim trailing hyphens.
7. If the result is empty, return the literal `untitled`.

## State Transitions

The KB folder progresses through four observable states:
- **Absent**: directory does not exist; `exists()` is false.
- **Present-uninitialized**: directory exists but the hidden subdirectory or its sidecars are missing or partial.
- **Present-initialized**: hidden subdirectory exists with the four sidecars and a possibly empty set of summary/transcript/plan/note files.
- **Dirty**: a `shadow-status.json` file exists in addition to Present-initialized.

Transitions:
- Absent → Present-initialized: `ensure()` (or implicit on first `writeFiles`).
- Present-initialized → Dirty: `markDirty(message)`.
- Dirty → Present-initialized: `clearDirty()`.
- Present-initialized → Absent: not implemented by this storage.

The manifest, branches registry, KB-config, and migration state are independently mutable while in any Present-* state.

The topic-wiki layer (`<root>/_wiki/`) has no explicit state transitions tracked here: every rebuild call wipes and re-emits both `_wiki/*.md` and every wiki-typed manifest row, and the layer's presence is observable solely via the existence of `_wiki/_index.md`. A crash mid-rebuild leaves the wiki layer empty (the manifest unregister precedes the disk rewrite); recovery is via the next rebuild call.

## Notable Behavior

- **Two layers, one storage-provider surface.** Read/list operations apply only to the hidden layer; writes to the hidden layer additionally derive visible markdown for three known prefixes (`summaries/`, `plans/`, `notes/`). The hidden layer is the source of truth for `readFile` and `listFiles`. (Notable.)
- **Per-file atomicity, not batch atomicity.** Each entry in a `writeFiles` batch is atomic on its own (rename-from-temp), but a partial batch can leave the KB in a half-applied state. (Surprising; documented in the storage-provider contract.)
- **Visible markdown invisibly updates the manifest.** Each visible-file write recomputes a content fingerprint and overwrites the manifest entry for that `fileId`. There is no separate "register file" step. (Notable.)
- **Hand-edit detection by fingerprint.** Cleanup never deletes a visible file whose on-disk content no longer hashes to the recorded fingerprint; the assumption is that a human modified it and the change must be preserved. (Surprising; intentional.)
- **Cleanup tolerates ghost manifest entries.** If a superseded file is already gone from disk at cleanup time, the manifest entry is silently removed without error. (Notable.)
- **Reconciliation never deletes manifest entries.** A manifest entry whose path is missing AND whose fingerprint is not found anywhere on disk is **kept** (with a warning) rather than removed, to avoid losing the only record of an AI-generated file. (Surprising; intentional.)
- **Custom-parent validation is silent on accept, warning on reject.** A non-absolute or `..`-containing custom path is logged at warning level and silently replaced by the default. (Notable.)
- **Repo-name worktree fix.** The repo-name resolver explicitly walks past a worktree pointer to the main repository's directory, so a worktree and its main checkout share one KB folder rather than getting parallel KBs under the worktree's own basename. (Notable; intentional.)
- **Same-repo reuse on collision.** When a candidate KB root already exists, the resolver reuses it only if its KB-config records a remote URL (or absent-remote with matching repo name) that matches the host. Otherwise it skips to a numeric suffix. (Notable.)
- **Last-resort timestamp suffix.** If 99 numbered suffix candidates are all in use and none match the host, the resolver returns a Unix-millisecond-suffixed path. (Surprising; data-preservation fallback.)
- **Dirty-flag write swallows errors.** `markDirty` and `clearDirty` use a `try { ... } catch { /* best effort */ }` pattern; a failure to write the marker is silent. (Notable.)
- **Slug fallback.** A commit message that produces an empty slug becomes `untitled`. (Notable.)
- **Hidden listing skips dotfiles during reconciliation.** The reconciliation walk skips entries whose names begin with `.` so it does not descend into the hidden subdirectory itself. (Notable.)
- **Plan/note slug-based branch fallback.** When a plan or note write does not specify a branch, the storage attempts to recover the branch from a hash suffix embedded in the slug; if recovery fails, the visible copy lands in the literal folder `_shared`. (Surprising.)
- **Shared in-process metadata-manager.** The manifest, branches registry, config, and migration state are all mediated by a single sidecar manager with deterministic atomic-rewrite-from-temp behavior on every mutation. Concurrent processes will race on these rewrites with last-writer-wins semantics. (Notable.)
- **Sort-order config lives at the KB level.** The default value `date` is written at first initialization and is otherwise never modified by this storage; it is only read/written via the explicit config-save surface. (Notable.)
- **Branch-rename ripple.** Renaming a branch's folder name in the registry also rewrites every manifest entry whose path starts with the old folder name, in a single atomic-rewrite of the manifest. (Notable.)
- **Branch-folder removal ripple.** Removing a branch-mapping also drops every manifest entry whose path starts with that folder name. (Notable.)
- **Three generated layers, one manifest.** The visible commit/plan/note layer and the generated topic-wiki layer share `manifest.json` and the same hand-edit-fingerprint contract. The wiki layer's rebuild path wipes only wiki-typed rows; the commit/plan/note paths leave wiki rows alone. (Notable.)
- **Wiki rebuild unregisters manifest rows before wiping disk.** The order is intentional: even if the disk wipe fails partway, surviving `_wiki/*.md` files are reclassified as user content (recoverable) rather than ghost generated entries (incoherent). (Notable; intentional ordering.)
- **Wiki rebuild is a write-only entry point.** Wiki pages are never produced as a side effect of `writeFiles`; they are produced only by an explicit rebuild call against a snapshot of canonical topic pages. The canonical topic pages themselves are written through `writeFiles` like any other content (under the hidden layer; "Topic Index and Page Storage" specifies their schema and routing). (Notable.)
- **Hand-edit guard is dual-pathed on writes.** Each summary, plan, and note write looks up the existing manifest row by target path and compares the on-disk fingerprint before overwriting. A divergence skips the write (preserves the user's edits) and leaves the manifest row unchanged. Force-regenerate entry points exist (out of scope here) to validate the hidden source, unlink, then re-emit. (Notable.)

## Shared Behavior
- The schema and interpretation of summary content (the JSON written under `summaries/`) are defined by **Summary Tree Structure**.
- The wider per-repository folder layout, including the parent-folder identity registry, the system-reserved-name policy for the hidden / visible / wiki layers, and user-placed-Markdown classification, is defined by **Memory Bank Folder Layout**.
- The schema of canonical topic pages, the topic-index document, the slug-safety guard, and the orphan-purge cycle that produces the input to the wiki rebuild are defined by **Topic Index and Page Storage**.
- The body composition of the per-topic wiki page and the wiki index page, and the cross-link resolution against the visible commit-summary layer, are defined by **Wiki Markdown Rendering**.
- The UI surfaces that badge hand-edited visible or wiki files (using the same fingerprint comparison this storage records) are defined by **VS Code Memory-File Divergence Decoration** and host-specific equivalents.
- The version-controlled-ref backend that this folder mirrors when paired in dual-write mode is defined by **Orphan Branch Summary Storage**.
- The conditional combination of this folder mirror with that backend is defined by **Dual-Write Summary Storage**.
