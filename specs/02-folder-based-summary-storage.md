# 02. Folder-Based Summary Storage

## Topic Statement
Store summaries as plain files inside a user-chosen knowledge-base folder, mirrored from a configurable parent location, with a metadata sidecar tracking AI-generated files and branch-to-folder mappings.

## Scope
**In scope:**
- Resolution of the knowledge-base root directory from a configurable parent path and a derived repository name.
- The three-layer file layout: a hidden subdirectory for machine-oriented data files, visible per-branch subdirectories for human-readable copies, and a reserved generated-topic-wiki subdirectory for derived per-topic Markdown pages.
- The metadata sidecar (manifest of AI-generated files spanning commit, plan, note, wiki, and skill entries, branch-to-folder mapping registry, KB-level configuration, migration progress).
- The per-commit skill-usage aggregate in the visible layer: which arm of the write cascade emits it, its namespaced manifest identifier, and the way its delete, regenerate, and heal behavior rides the summary's rather than its own.
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
- The internals of the independent second reader of this storage's hidden layer — the host-side direct read path that bypasses this storage for latency — covered by spec 314. Only the two aggregate documents it consumes, and the read contract it depends on, are stated here. (The larger content-reading path that used to bypass this storage is retired; see 307.)
- The **content** of the per-commit skill-usage table and of the single collapsed skills row in a summary's body (covered by spec 323); this storage owns only where those files land, when they are written, and how they are tracked.
- Combination semantics with the version-controlled-ref backend (covered by "Dual-Write Summary Storage").
- The Memory Bank write boundary that callers must clear before invoking the claiming resolution path — its conditions, refusal reasons, and the effective-state report derived from it (covered by "Memory Bank Write Boundary and Effective-State Reporting").
- The durable repo-wide manual-disable opt-out — how it is set, cleared, and stored, and the full inventory of writes it suppresses (covered by "Manually-Disabled Zero-Write Contract"). Only its position inside this storage's batch write, and which of this storage's other paths lack it, are stated here.
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
- `references/<source>/<sanitizedNativeId>.md` — One file per archived external-entity reference, written verbatim.
- `skills/<source>/<sanitizedSkillId>-<hash8>.md` — One file per archived skill invocation record, written verbatim. Lands here with no code in this storage: it is an ordinary batch-write path, and every batch path is mirrored into the hidden layer unconditionally.
- `plan-progress/<slug>.json` — One file per plan-progress artifact, written verbatim.
- `index.json` — Hidden copy of the summary index document, written verbatim.
- `shadow-status.json` — Optional dirty marker (see below).
- Any other relative path passed to `writeFiles` is created as-is under this hidden directory (notably: canonical topic pages and topic-index, plus the topic-ingest high-water mark; see "Topic Index and Page Storage").

**A second, independent reader of this layer exists, and its read subset is now exactly two aggregate documents.** One host still reads the hidden layer directly off disk, in its own language, bypassing this storage for latency reasons — but only for `manifest.json` and `index.json`, which it deserializes to drive a multi-repository tree's per-repository loop. It never writes anything (write-side consistency remains this storage's sole responsibility) and it fails soft: a missing file yields an empty payload silently, an unparseable one yields the same payload plus a warning. **Nothing in the content directories is read there any more, and neither is the dirty marker**: that host's former direct read path over the per-commit summary documents, plan bodies, note bodies and archived reference bodies — and the per-read dirty-marker gate that governed it — was deleted, and those reads now come back through this storage over a cross-process bridge (see the retired spec 307, and 314 for the surviving reader).

The practical consequence is that the two-language boundary **inverted**, with one exception that survived the move. The schemas of `manifest.json` and `index.json`, and their locations, cannot change without a coordinated change in two languages. The content directories as *this layer's* on-disk layout, and the dirty marker's semantics, can now evolve here for as long as nothing reads them there. The exception is the archived-reference path: that host still re-implements the sanitize rule that turns a reference's native identifier into a filename stem, and still composes `references/<source>/<stem>.md` — but it now hands that relative path to this storage over the bridge instead of opening a file itself. The rule therefore remains a two-language contract; what changed is that it binds the storage-provider path namespace, which this layer mirrors verbatim, rather than this layer's own layout — and a drift in it still returns nothing for every archived reference, silently and uniformly (spec 317).

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
    - For the per-commit skill aggregate: the literal string `skill:<commitHash>` — **namespaced, not the bare hash**. Entries are keyed on `fileId` and a write replaces any entry sharing one, so a bare hash here would evict the summary's own entry; the superseded-descendant cleanup, which looks an entry up by hash and skips anything whose `type` is not `commit`, would then silently stop cleaning up the superseded summary. Plans namespace for the same reason.
  - `type`: one of `commit`, `plan`, `note`, `wiki`, `skill`.
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
- `<branchFolder>/skills--<hash8>.md` — the per-commit skill-usage table, one file per commit (not one per skill), emitted as a sibling of the summary markdown that shares its `<hash8>`.

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

The standard resolution entry point is **not** a pure read despite its name: it **claims** the root it returns — creating the directory, seeding the default sidecars, and writing the repository identity — so that the returned path is already fully claimed on return and no caller needs a follow-up initialize step (the atomicity contract, defined by **Memory Bank Folder Layout**). Two consequences:

- **It carries a caller-side write-boundary precondition.** Any caller whose repository name is derived from an ambient working directory must first clear the Memory Bank write boundary, because resolving from a directory that is not a real project permanently materializes a folder named after that directory. The predicate and its refusal reasons are defined by **Memory Bank Write Boundary and Effective-State Reporting**; this spec states only that the precondition exists and is the caller's to satisfy.
- **A read-only peek sibling exists for callers that must not claim.** It computes the same answer as the standard entry point — same reuse, adoption, and suffix-ladder selection — while omitting every filesystem mutation: no directory creation, no identity write. It is what lets a caller distinguish "this repository has no folder yet" from "this repository's folder exists and would be reused" without creating one, and it is the path the effective-Memory-Bank-state report resolves through, so *displaying* where memories will land cannot be what brings the folder into existence.

### `ensure()`
1. Recursively create the KB root directory.
2. Initialize the hidden subdirectory: create it if missing; write a default `manifest.json` (`{version: 1, files: []}`), default `branches.json` (`{version: 1, mappings: []}`), and default `config.json` (`{version: 1, sortOrder: "date"}`) only if they do not exist.

### `exists()`
Returns whether the KB root directory exists on disk.

### `readFile(path)`
Reads `<root>/.<product-namespace>/<path>` **directly**, with no existence pre-probe, and classifies any failure by its filesystem error code:
- "no such entry" and "a path segment above the target is not a directory" are the routine nothing-here outcomes. They return null silently — absence is expected on a fresh repository, and equally expected when a cross-repository sweep touches a sibling repository that has none.
- Everything else — a refused permission, an I/O failure, a busy file, the target turning out to be a directory, a concurrent truncation — is a genuine failure that the null return hides. It is logged at **production-visible warning level**, naming the path and the underlying cause, and then returns null.

Both branches return null: the contract has no third state, so the reporting obligation sits here (see "Orphan Branch Summary Storage" for the contract wording).

The removal of the existence pre-probe is load-bearing in two ways. First, correctness: the probe reports "does not exist" for an entry it merely cannot inspect, so a refused permission on a parent directory was previously indistinguishable from absence and fell through to a silent null — precisely the failure class the caller-side signal used to be the last line of defence for. Second, cost: reading first halves the syscalls per read, which matters on the index-heavy sweep paths (a cross-repository scan probing one index document per sibling repository).

### `writeFiles(files, message)`
0. If the project is **manually disabled**, return immediately. The refusal sits **before** the `ensure()` in step 1, so a disabled project never has its folder tree created: neither the KB root, nor the hidden subdirectory, nor any default sidecar comes into existence as a side effect of a batch write.
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
10. Generate the per-commit skill aggregate (see below).
11. If the summary node has children, run "superseded-descendant cleanup".

### Skill-aggregate generation

`<branchFolder>/skills--<hash8>.md` is emitted from the **`summaries/` arm** of the visible cascade — deliberately, rather than from a fourth `skills/` arm:

- The cascade runs once per written file, so a `skills/` arm would rewrite the aggregate once per archived skill (a read-modify-write repeated N times) and would acquire an ordering dependency on whether the skill batch was written before or after the summary batch.
- The summary payload already carries the commit's skill references, so the summary arm has one trigger, complete data, and an inherently correct commit hash.

One file per commit rather than one per skill: the visible layer exists to be browsed by a human, and skills are auto-captured metadata arriving several per commit — at three per commit, a hundred commits would bury the handful of memory documents a user actually opens under three hundred files.

The steps:

1. If the summary carries no skill references, or an empty array, return without writing. There is no empty-table file.
2. Compute the relative path from the summary's own resolved branch folder and its `<hash8>`.
3. Hand-edit guard: look up the manifest entry by that relative path. If the file exists and its on-disk fingerprint differs from the recorded fingerprint, log the skip and return **without writing** — the aggregate is protected exactly like the summary markdown it sits beside.
4. Otherwise render the table and atomically write it.
5. Update the manifest with `fileId = "skill:<commitHash>"`, `type = "skill"`, and the fingerprint of the rendered markdown.

Because its lifecycle is the summary's rather than its own, the aggregate needs no storage-provider method pair of its own: the delete and regenerate entry points already take a summary-index entry and extend to this sibling.

The aggregate is where the **per-skill** breakdown lives. The summary markdown beside it carries at most a single collapsed "skills used" row in its context section — a shape decided by the visible-summary body builder, whose content is out of scope here (see the boundaries) but whose split with this file is the reason the aggregate exists at all.

The hidden-layer counterpart (`skills/<source>/<stem>-<hash8>.md`) needs no code in this storage: those paths arrive through the ordinary batch write and are mirrored into the hidden layer unconditionally, before the visible cascade runs. The batch that carries them is a dedicated write entry point that no-ops on an empty file list, refuses while the project is manually disabled (checked **before** it takes the write lock, mirroring the summary write), and then writes under the required parallel-ref write lock.

### Deleting and regenerating the aggregate alongside its summary

**Delete.** The per-entry visible-markdown delete removes the skills sibling **first**, then the summary markdown. The ordering means a failure to delete the summary cannot leave an orphaned aggregate claiming a memory that is gone. The sibling delete is additionally wrapped in its own error containment, because the underlying artifact delete rethrows anything that is not a missing-file condition: an unwritable sibling (permissions, an editor lock) would otherwise abort the deletion of the memory itself — trading the orphan the ordering avoids for a strictly worse failure. A sibling failure is logged and swallowed, so it does not count toward the caller's failure tally and does not block the ghost-branch prune that follows (see the stale-child cleanup spec).

**Regenerate.** The regenerate path has two branches and both touch the aggregate:

- **Summary markdown already on disk** — this is not a regeneration, but the generated sibling may still be missing, and reporting the memory healthy while leaving that gap makes "heal" only partly true. So a missing aggregate is re-emitted from the hidden summary document, best-effort: every failure on this arm is silent and **does not affect the return value**, because the subject of the call — the memory — is already intact and nothing here may downgrade that outcome.
- **Summary markdown missing** — after re-emitting the summary markdown and updating its manifest row, the aggregate is generated by the same routine the write path uses (including its own empty-input and hand-edit guards).

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
- `markDirty(message)`: best-effort atomic-write of `<hiddenDir>/shadow-status.json` with `{dirty: true, lastFailedAt, message}`. A failure is **suppressed but logged at production-visible warning level** — the call never throws at its surface, but the suppressed marker update is named in the log, because a silently-dropped marker write turns a real shadow-write failure into a completely invisible one (the marker is the only trace that failure leaves).
- `clearDirty()`: best-effort delete of that file. Errors are swallowed silently, with no log line.
- `isDirty()`: returns whether that file currently exists. **Presence alone is the signal — the document body is never parsed by any consumer.** The marker used to double as a per-device *read* switch, because the second reader of this layer gated every one of its reads on it; that reader is gone, so the marker is now only a record of a failed shadow write and an input to the surfaces that badge a mirror as behind. It remains an existence-signalling file of its own rather than a field inside one of the aggregate documents.

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
- **Dirty**: a `shadow-status.json` file exists in addition to Present-initialized. The state records that the most recent shadow write failed and was suppressed. It no longer gates any read: the second reader that refused to serve while the marker was present has been retired (307), and the surviving direct reader of this layer never consults it.

Transitions:
- Absent → Present-initialized: `ensure()` (or implicit on first `writeFiles`).
- Present-initialized → Dirty: `markDirty(message)`.
- Dirty → Present-initialized: `clearDirty()`.
- Present-initialized → Absent: not implemented by this storage.

The manifest, branches registry, KB-config, and migration state are independently mutable while in any Present-* state.

The topic-wiki layer (`<root>/_wiki/`) has no explicit state transitions tracked here: every rebuild call wipes and re-emits both `_wiki/*.md` and every wiki-typed manifest row, and the layer's presence is observable solely via the existence of `_wiki/_index.md`. A crash mid-rebuild leaves the wiki layer empty (the manifest unregister precedes the disk rewrite); recovery is via the next rebuild call.

## Notable Behavior

- **The manual-disable gate sits on the batch write only.** Of this storage's mutating entry points, only the batch write refuses while the project is manually disabled. The initialization routine, the visible-markdown delete and regenerate paths, the plan-and-note visible deletes, the branch-mapping prune, the heal-missing-visible-markdown pass, the topic-wiki rebuild, the manifest reconciliation, and the dirty-marker write and clear all run normally. A disabled project therefore accumulates no new content through the batch write, but a repair, cleanup, or rebuild call that reaches this storage directly still touches disk. Whether such a call can be reached at all while disabled is decided by its own callers upstream, not here. (Surprising; the gate is per-entry-point, not per-storage-instance.)
- **Two layers, one storage-provider surface.** Read/list operations apply only to the hidden layer; writes to the hidden layer additionally derive visible markdown for three known prefixes (`summaries/`, `plans/`, `notes/`). The hidden layer is the source of truth for `readFile` and `listFiles`. (Notable.)
- **The skill aggregate is emitted from the `summaries/` arm, not from a fourth arm — and that is not a shortcut.** A `skills/` arm would fire once per archived skill, rewriting the same per-commit file N times, and would make the result depend on whether the skill batch or the summary batch was written first. The summary payload already names the commit's skills, so the summary arm is the one place with a single trigger, complete data, and a guaranteed-correct hash. (Surprising; intentional.)
- **A skills sibling is never *overwritten* on divergence, only skipped.** It carries the same hand-edit fingerprint guard as the summary markdown, so a user-modified skill table survives every later write. (Notable.)
- **The sibling is deleted first, and its failure is contained separately.** Removing the aggregate before the summary means a failed summary delete cannot strand an aggregate pointing at a memory that is gone; wrapping that removal separately means a locked or unwritable aggregate cannot abort the deletion of the memory itself. The two together are what make "delete the memory" robust in both directions. A swallowed sibling failure does not increment the caller's failure count, so it does not suppress the ghost-branch prune downstream. (Surprising; intentional pairing.)
- **Regenerate heals a missing aggregate even on the "nothing to regenerate" branch, silently.** When the memory's own markdown is intact the call is not a regeneration at all — but the generated sibling may still be gone, and reporting the memory healthy while leaving that gap makes the heal only partly true. The repair is therefore attempted anyway and every failure in it is swallowed without touching the return value, because the call's subject is already intact and nothing here may downgrade that. (Notable.)
- **The hidden `skills/` files need no code in this storage.** They arrive through the ordinary batch write and are mirrored into the hidden layer unconditionally before the visible cascade, so the only skill-specific code here is the visible aggregate. Their own write entry point no-ops on empty input and refuses while the project is manually disabled *before* taking the write lock. (Notable.)
- **A null read means absent; anything else is warned here, not upstream.** This backend reads without an existence pre-probe and classifies the failure by error code, warning on everything that is not a routine missing-entry outcome. The reason the warning belongs at this depth is that the error code is still in hand here: the caller receives a bare null and is reduced to guessing between "fresh repository" and "the backend's read failed". The pre-probe was removed rather than kept alongside the classification because it actively produced the wrong answer — it reports absence for an entry it merely cannot inspect. (Notable; the reporting obligation is part of the storage-provider contract.)
- **A second reader of the hidden layer exists, in another language, and it is read-only — but the names it reads are now the opposite ones.** It reads `manifest.json` and `index.json` and nothing else, to avoid a per-repository process hop while building a multi-repository tree. Those two documents — plus their locations and their schemas — are consequently the two-language contract; the content directories and the dirty marker, which it used to read and no longer does, are not. The lockstep obligation is still exactly the set of names actually consumed; that set simply inverted when the content-reading path was retired (307). One coupling survived the inversion: that host still re-derives the archived-reference filename stem and composes the same relative path, it just sends it to this storage over the bridge now. (Notable.)
- **This backend declares its identity as data.** Like every backend on the contract, it carries an optional identity value used only for diagnostics, because the shipped bundles are minified and a runtime type name would reach production mangled. (Notable.)
- **Per-file atomicity, not batch atomicity.** Each entry in a `writeFiles` batch is atomic on its own (rename-from-temp), but a partial batch can leave the KB in a half-applied state. (Surprising; documented in the storage-provider contract.)
- **Visible markdown invisibly updates the manifest.** Each visible-file write recomputes a content fingerprint and overwrites the manifest entry for that `fileId`. There is no separate "register file" step. (Notable.)
- **Hand-edit detection by fingerprint.** Cleanup never deletes a visible file whose on-disk content no longer hashes to the recorded fingerprint; the assumption is that a human modified it and the change must be preserved. (Surprising; intentional.)
- **Cleanup tolerates ghost manifest entries.** If a superseded file is already gone from disk at cleanup time, the manifest entry is silently removed without error. (Notable.)
- **Reconciliation never deletes manifest entries.** A manifest entry whose path is missing AND whose fingerprint is not found anywhere on disk is **kept** (with a warning) rather than removed, to avoid losing the only record of an AI-generated file. (Surprising; intentional.)
- **Custom-parent validation is silent on accept, warning on reject.** A non-absolute or `..`-containing custom path is logged at warning level and silently replaced by the default. (Notable.)
- **Repo-name worktree fix.** The repo-name resolver explicitly walks past a worktree pointer to the main repository's directory, so a worktree and its main checkout share one KB folder rather than getting parallel KBs under the worktree's own basename. (Notable; intentional.)
- **Same-repo reuse on collision.** When a candidate KB root already exists, the resolver reuses it only if its KB-config records a remote URL (or absent-remote with matching repo name) that matches the host. Otherwise it skips to a numeric suffix. (Notable.)
- **Last-resort timestamp suffix.** If 99 numbered suffix candidates are all in use and none match the host, the resolver returns a Unix-millisecond-suffixed path. (Surprising; data-preservation fallback.)
- **Dirty-flag writes are suppressed, but the marker write is not silent.** Both `markDirty` and `clearDirty` swallow their failures rather than propagating them. They differ in visibility on purpose: a failed `markDirty` is logged at production-visible warning level, because the marker is the *only* observable trace a suppressed shadow-write failure leaves, so losing the marker too would make a real failure invisible everywhere. A failed `clearDirty` is genuinely silent — its worst outcome is a stale marker, which degrades reads to the version-controlled ref rather than hiding anything. (Notable; asymmetric on purpose.)
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
- The version-controlled-ref backend that this folder can be paired with, and the storage-provider contract's read semantics (a null means absent; the failing backend reports) and optional backend-identity value, are defined by **Orphan Branch Summary Storage**.
- The independent second reader of this storage's hidden layer — its two read entry points, its fail-soft error policy, and its deliberate absence of a dirty-marker gate — is defined by spec 314. Only the contract that reader depends on is stated here; the retired content-reading path it is often confused with is recorded in 307.
- The combination of this folder mirror with whichever backend is the system of record is defined by **Dual-Write Summary Storage**. **This storage is constructed in every writable routing state, not under one configured storage mode; the only thing that omits it is a working directory that may not claim a per-repository folder** (that routing is owned by spec 344).
- The write-boundary predicate that callers of the claiming resolution path must clear first, and the effective-state report that resolves through the peek path, are defined by **Memory Bank Write Boundary and Effective-State Reporting**.
- The durable repo-wide manual-disable opt-out that suppresses this storage's batch write is defined by **Manually-Disabled Zero-Write Contract**.
