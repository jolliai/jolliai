# 215. Memory Bank Migration Engine

## Topic Statement

Copy all summaries, transcripts, plans, notes, and plan-progress from the version-controlled orphan-branch store into the user-pickable on-disk Memory Bank folder, tracking progress so the run is resumable and idempotent, and running an ongoing reconciliation that keeps the visible per-branch layer consistent after the initial copy.

## Scope

**In scope:**
- The three invocation paths: automatic on every host activation (when migration is not yet complete); explicit via the "Migrate to Memory Bank" user action; and out-of-process via a hidden command-line bridge that lets a host which cannot call the engine in-process spawn it instead (see below, and the Memory Bank migration bridge spec for that command's own contract).
- The pre-migration archive step that the explicit action performs before running the copy: collecting every existing folder for this repository, moving all of them into the hidden archive directory under the Memory Bank parent, then targeting the base folder name for the fresh copy.
- The consolidate-onto-base-folder-name rule: the explicit action always migrates into the canonical base name (`<repo>`) rather than any numbered suffix, because the archive step frees the base slot before migration begins.
- What the engine copies, in what order.
- The idempotency rule: entries already present in the folder manifest (matched by commit hash) are skipped; their display title is backfilled when absent.
- The resumability contract and the progress document that tracks it.
- The two-phase visible-layer reconciliation that runs after every copy — and on every activation even when no copy is needed.
- The archive directory: its location, naming convention, and why it is hidden from sync and IDE explorers.
- Migration outcome codes, success and failure cases, and their telemetry.

**Out of scope:**
- The orphan-branch write path (covered by the orphan-branch summary storage spec).
- The folder layout and the file-and-folder contract of the Memory Bank (covered by spec 151).
- The folder-based storage write mechanics, manifest mutations, and branch-mapping registry (covered by the folder-based summary storage spec).
- The dual-write orchestration that routes new commits to both stores after migration (covered by the dual-write summary storage spec).
- The settings webview form, its button states, and its message protocol around the migrate action (covered by spec 110).
- The host activation sequence that invokes migration as a fire-and-forget step (covered by spec 100).
- The schema migration that runs before the copy (orphan-branch v1→v3, flat-index v1→v3, expired v1 cleanup; those are separate migration steps, not the copy engine).

## Data Contracts

### Progress document

Stored inside the per-repository hidden layer at `migration.json`. The document carries:

- `status`: one of `in_progress`, `completed`, `partial`, `failed`.
- `totalEntries`: total count of root entries (entries with no parent commit hash) found in the orphan-branch index.
- `migratedEntries`: count of root entries successfully written by this run.
- `failedHashes` (optional): array of commit hashes that raised an error during the per-root copy pass.
- `lastMigratedHash` (optional): last commit hash processed in the per-root pass; resumption uses the manifest check to skip it rather than this field, so this field is informational.
- `staleChildCleanup` (optional): an object with a single `completedAt` ISO-8601 string, written once when the one-shot phase of the visible-layer reconciliation finishes cleanly. Absent means the one-shot phase has not yet run successfully.
- `leafCleanup` (optional, deprecated): written by a briefly shipped earlier version whose algorithm was inverted under the current storage model; present only on installs that ran that version. Never read or written by current code; preserved through round-trips so pre-existing documents do not lose the field.

### Source: orphan-branch index

The engine reads `index.json` from the orphan-branch store. Root entries are those whose parent commit hash field is absent or null; child entries (those with a parent pointer) are excluded from the per-root pass but are included in the bulk transcript and summary sweeps.

### Destination: Memory Bank folder

The engine writes through the folder-based storage layer into the per-repository hidden layer. The folder-storage layer is responsible for generating visible per-branch Markdown files and updating the manifest; the engine only issues write calls and reads manifest state back for idempotency checks.

### Archive directory

Located at `<parent>/.jolli/archive/<name>-<timestamp>/`, where `<parent>` is the Memory Bank parent folder (the user-configured local folder), and `<name>` is the basename of the folder being archived. A millisecond timestamp ensures each archive is distinct; a collision counter (`-2`, `-3`, …) guards against same-millisecond archives of the same name. The archive directory itself lives under a dot-prefixed segment so it is:

- Never enumerated as a repository by the Memory Bank scanner (which skips dot-prefixed directory names).
- Rejected by the sync path classifier (which refuses dot-prefixed path segments), causing the next sync round to remove any vault-tracked files it previously tracked.
- Excluded from IDE folder explorers (which hide dot-prefixed names).

The archive directory stays inside the Memory Bank parent so it travels with the user's `localFolder` configuration. The orphan branch remains the system of record for recovery.

## Behavior

### Auto-migration (on activation)

Triggered once per host activation, as a fire-and-forget step after the in-process schema migrations complete.

1. Resolve the Memory Bank folder path for the current repository (using the user's configured local folder and the canonical repo name).
2. Check whether the orphan-branch store exists. If it does not, stop — nothing to migrate.
3. Read the progress document. If `status` is `completed`, skip the copy and go directly to the visible-layer reconciliation (step 8).
4. Create the folder structure if absent.
5. Run the copy (see Copy sequence below).
6. After the copy, invalidate the in-process storage read-cache and signal the sidebar to refresh its folder listing.
7. Log the outcome.
8. Run the visible-layer reconciliation (see Visible-layer reconciliation below). Refresh the sidebar only if the reconciliation changed any files.

If the orphan-branch store exists but `status` is not `completed` (including absent progress document — which covers both fresh installs and cases where the user wiped the Memory Bank folder), the copy runs in full.

The auto-migration does not archive any existing folder before running — that is exclusively the explicit action's responsibility.

### Explicit "Migrate to Memory Bank" action

Triggered by the user from the Memory Bank settings panel.

1. Check whether the orphan-branch store exists. If it does not, return a failure with the message "No git storage found — nothing to rebuild."
2. Enumerate every existing folder under the Memory Bank parent whose stored identity matches this repository (base name and all numbered suffixes, up to `-99`). These are the folders to archive.
3. For each enumerated folder, move it into the archive directory. The move is a filesystem rename: the entire directory tree moves atomically. If the move fails, log a warning and continue — a stale visible folder is a lesser evil than aborting the rebuild.
4. After archiving the pile, resolve the target path using the read-only peek resolver. Because step 3 freed the base slot (all same-identity folders were moved), the peek resolver returns the canonical base name. If some folder survived archiving (a move failure), the peek resolver falls back to the next unused numbered suffix.
5. Initialize the target folder with the repository's identity.
6. Run the copy (see Copy sequence below).
7. After the copy, invalidate the in-process storage read-cache, signal the sidebar to refresh its folder listing and repository listing, and, if the Memories panel has been loaded, refresh it.
8. Return `{ ok: true, message: "<N> memories migrated to <path>" }` on `completed` status; `{ ok: false, message: "Rebuild <status>: <N>/<total> entries (<path>)" }` otherwise; `{ ok: false, message: <error message> }` on an unhandled exception.

The "consolidate onto base folder name" rule is a consequence of steps 2–4: archiving all same-identity folders before resolving the target means the base slot is always free when the resolver runs, so migration always lands on `<repo>` rather than on a numbered suffix. Prior to this fix, each re-run would allocate an incrementing suffix because the earlier folder still held the same identity.

### Out-of-process invocation (command-line bridge)

A third entry point exists for hosts that cannot invoke the engine in-process (a JVM-based IDE plugin, which spawns a command instead). It applies the same gate the auto-migration applies, in the same order:

1. No orphan-branch store → nothing to migrate; report an empty completed run without creating folder structure.
2. Progress document absent, or `status` not `completed` → run the copy in full.
3. `status` is `completed` → run the visible-layer reconciliation only.

It performs **no** archive step (that stays exclusive to the explicit user action), requires no product sign-in, and reports the resulting `status`, `totalEntries`, and `migratedEntries` back to its caller. The bridge command's own invocation form, output envelope, and exit-code contract are its own spec; nothing about the engine changes for it.

### Copy sequence

Given an orphan-branch store and a destination folder-storage instance:

1. Read and parse `index.json` from the orphan-branch store. If absent, record `status: completed, totalEntries: 0, migratedEntries: 0` and return. If unparseable, record `status: failed, totalEntries: 0, migratedEntries: 0` and return.
2. Extract root entries (parent commit hash absent or null). Count them as `totalEntries`.
3. Write `status: in_progress` to the progress document.
4. **Per-root pass.** For each root entry in index order:
   - Check whether the commit hash already appears in the folder manifest. If it does, increment the migrated count (counting the skip as migrated for progress purposes), backfill the display title from the orphan-branch summary if the manifest entry has no title, and continue to the next entry.
   - Otherwise, copy the summary JSON for that hash to the folder (which the folder-storage layer uses to generate the visible Markdown). Copy the transcript JSON for that hash if present.
   - On any write error, record the hash in `failedHashes` and continue. Per-root failures do not abort the run.
   - Update the progress document with the current `in_progress` state after each entry.
5. **Bulk summary sweep.** List all paths under `summaries/` in the orphan-branch store. For any path not already present in the folder store, copy it. (This covers child entries whose JSON is referenced by the visible layer but were excluded from the per-root pass.)
6. **Plans copy.** List all paths under `plans/`. Copy each to the folder store, resolving the branch from the hash suffix embedded in the filename against the index (for the visible-layer branch directory placement).
7. **Notes copy.** List all paths under `notes/`. Copy each to the folder store, resolving the branch the same way.
8. **Plan-progress copy.** List all paths under `plan-progress/`. Copy each to the folder store.
9. **Bulk transcript sweep.** List all paths under `transcripts/`. Copy any not already present in the folder store.
10. **Index copy.** Write the full `index.json` to the folder store.
11. Determine final status: `completed` if `failedHashes` is empty; `partial` otherwise.
12. Write the final progress document.
13. Emit a telemetry event with the outcome and a bucketed entry count.
14. Run the visible-layer reconciliation (see below).

At each step, a null content read (path listed but file missing or concurrently deleted) is silently skipped. Each bulk sweep skips paths the folder store already has, so all loops are idempotent at the file level.

### Visible-layer reconciliation

Runs at the tail of every copy and on every activation even when no copy ran. Consists of two phases with different lifecycles:

**Phase 1 — one-shot head-Markdown regeneration** (gated by `staleChildCleanup.completedAt`):

Intended to recover from a briefly shipped version that inverted the deletion semantics and erroneously deleted visible Markdown for head entries (entries with no parent pointer) while keeping Markdown for hoisted child entries. Skipped entirely if `staleChildCleanup.completedAt` is already set. If the gate is absent:

1. Read `index.json` from the folder store. If absent or unparseable, record `regen.failed = 1` (withholds the gate, so the next activation retries) and proceed to phase 2.
2. For each head entry in the index, ask the folder storage to regenerate its visible Markdown from the hidden JSON, if the file is missing. Skip entries whose visible file is already present.
3. Accumulate regenerated, skipped, and failed counts.
4. If `regen.failed > 0`, do not set the gate; the next activation retries phase 1.

The legacy `leafCleanup.completedAt` field, if present on disk, is explicitly ignored when deciding whether to run phase 1. Installs that ran the earlier inverted version must still execute phase 1 once.

**Phase 2 — recurring stale-child sweep** (runs on every invocation, not gated):

For every branch in the folder store, delete the visible Markdown file for any entry whose parent commit hash is not null. These entries are "hoisted children" under the current storage model; their Markdown must not appear as standalone memories in the visible layer. Because the queue worker's tail cleanup only processes the branch of the live git operation, children hoisted on dormant or merged branches would otherwise accumulate indefinitely.

Phase 2 failures (files that cannot be unlinked) are warned individually and do not prevent the rest of the sweep or the phase-1 gate from being recorded.

**Gate and stamp logic:**

After both phases:

- If phase 1 ran cleanly (or was already gated), set `staleChildCleanup.completedAt` to the current ISO-8601 timestamp if no prior stamp exists; preserve any existing stamp verbatim — a recurring phase-2 sweep must not update the timestamp on every activation.
- If phase 1 failed, omit `staleChildCleanup` from the written document, leaving the gate open for the next activation.
- Write the merged progress document, preserving all other fields (`status`, `totalEntries`, `migratedEntries`, `failedHashes`, `lastMigratedHash`, `leafCleanup` if present).

**`swept` return value:**

The reconciliation returns the total count of visible Markdown files actually changed: the count of stale-child files deleted (phase 2) plus the count of head files regenerated (phase 1). The caller uses this to decide whether to invalidate the storage cache and refresh the sidebar — a value of 0 means the visible layer is unchanged and no refresh is needed.

## State Transitions

### Progress document lifecycle

| Status written | When |
| --- | --- |
| `in_progress` | At the start of the per-root pass; updated after each entry. |
| `completed` | Copy finished with no per-root failures. |
| `partial` | Copy finished but one or more root entries failed. |
| `failed` | `index.json` could not be parsed. |

The document is absent before the first run and after the folder is wiped. A wiped folder resets the gate check to "never run", so the auto-migration runs the full copy again on the next activation.

### Visible-layer reconciliation gate

| State | Meaning |
| --- | --- |
| `staleChildCleanup` absent | Phase 1 has not yet run successfully; will run on next activation. |
| `staleChildCleanup.completedAt` set | Phase 1 is permanently retired; only phase 2 runs. |

`leafCleanup.completedAt` (the legacy gate) never transitions to any new state; it is carried through transparently but does not influence execution.

## Notable Behavior

- **Auto-migration is fire-and-forget.** The host activation sequence does not await it, so the sidebar can receive requests for folder listings before migration has written anything. The engine signals the sidebar to refresh only after the copy completes, so the first listing may be empty. (Notable; intentional — migration can take minutes on a large repo.)
- **Wiping the Memory Bank folder re-triggers full migration.** Deleting the folder removes `migration.json`, which causes `readMigrationState()` to return null, which the auto-migration treats identically to a fresh install. The copy re-runs from the orphan branch, which is the system of record. (Notable; intentional design choice — the orphan branch is never modified.)
- **The explicit action always consolidates onto the base folder name.** Before migrating, it archives every folder for this repository, freeing the base `<repo>` slot. The post-archive peek resolver then returns the base name rather than a numbered suffix. Previous behavior (where each re-run allocated an incrementing `-N`) was a bug fixed by archiving up front. (Notable; the correct behavior depends on the archive-before-resolve ordering.)
- **Archiving uses a filesystem move, not an identity rewrite.** An earlier approach rewrote the `config.json` inside the folder to a different identity, leaving the folder visible to both the IDE explorer and the sync vault (which continued to track and upload its contents). The current approach moves the entire directory into a hidden directory that the sync classifier rejects, causing the next sync round to deindex it. (Notable; the old behavior caused 138 files to continue syncing under a "supposedly archived" folder.)
- **The archive directory is hidden but co-located with the Memory Bank.** Placing archives under a dot-prefixed subdirectory inside the Memory Bank parent (rather than outside it) means archives travel with a relocated `localFolder` configuration and remain on the same filesystem for atomic renames. (Notable.)
- **Archive failures are non-fatal.** If a folder cannot be moved (e.g., a file is locked), the engine logs a warning and continues. The migration then lands on a numbered suffix rather than the base name. (Notable; the alternative — aborting the rebuild — was judged worse than a slightly non-canonical folder name.)
- **Phase 1 of the visible-layer reconciliation is permanently gated after one clean run.** A missing head Markdown file after the gate is set is treated as a different concern (handled by a separate heal-missing path in the folder storage), not a reason to re-run the one-shot repair. (Notable; intentional separation.)
- **Phase 2 of the reconciliation runs on every activation regardless of the gate.** The "delete stale child Markdown" sweep is an ongoing invariant enforcement, not a one-shot fix. Children hoisted on dormant branches are never swept by the per-commit queue worker, so this is the only path that guarantees they are eventually removed. (Notable; intentional.)
- **A partial copy does not block activation on the next startup.** If `status` is `partial`, the auto-migration condition (`status !== "completed"`) triggers a re-run. The per-root pass skips already-migrated entries via the manifest check, so only the failed hashes need to be retried. (Notable; same mechanism as full resumability.)
- **The `swept` count drives the sidebar-refresh decision, not a boolean "did anything run."** A no-op reconcile (steady state) reports `swept = 0` and the sidebar is not refreshed. Only actual file mutations (deletions or regenerations) cause a refresh, which prevents the user's expanded folder tree from collapsing on every activation. (Notable; intentional.)
- **The legacy `leafCleanup.completedAt` field is preserved but never consulted.** Installs that ran the 0.99.2 inverted-pass version wrote this field. Current code carries it through all progress-document round-trips so the JSON does not lose fields, but the field has no effect on phase 1 gating — those installs must still run phase 1 to recover from the inverted deletion. (Notable; preserving the field is for round-trip fidelity only.)

## Shared Behavior

- **Orphan-branch store** — the source-of-truth read surface for the copy. Defined by the orphan-branch summary storage spec.
- **Folder-based storage** — the write surface for the copy. Its manifest is the idempotency check for per-root entries. Its branch-directory mechanics govern where visible Markdown lands. Defined by the folder-based summary storage spec.
- **Memory Bank folder layout** — the per-repository hidden layer, visible layer, and path naming conventions the engine writes into. Defined by spec 151.
- **Settings webview** — owns the button state and feedback text for the explicit "Migrate to Memory Bank" action. The webview delegates entirely to this engine via a single command; the engine returns a structured `{ ok, message }` result. Defined by spec 110.
- **Host activation sequence** — invokes auto-migration as a fire-and-forget step. Defined by spec 100.
- **Command-line migration bridge** — the hidden out-of-process entry point that spawns this engine for a host which cannot import it, with its own JSON output and exit-code contract and its explicit no-sign-in rule. Defined by the Memory Bank migration bridge spec.
- **Telemetry** — the engine emits one event at the end of each copy run. The event schema is defined in the telemetry event catalog.
