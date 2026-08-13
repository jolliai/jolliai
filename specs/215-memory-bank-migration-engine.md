# 215. Memory Bank Migration Engine

## Topic Statement

Copy all summaries, transcripts, plans, notes, and plan-progress from the version-controlled orphan-branch store into the user-pickable on-disk Memory Bank folder, tracking progress so the run is resumable and idempotent, and running an ongoing reconciliation that keeps the visible per-branch layer consistent after the initial copy.

## Scope

**In scope:**
- The invocation paths: automatic on every host activation (when migration is not yet complete); the manual Memory Bank sync command, which runs the same activation-shaped step on every sync before it pushes anything; the explicit "Migrate to Memory Bank" user action, exposed by three surfaces of which two drive one **shared** rebuild routine while the third re-implements the sequence; out-of-process through the shared migration caller, which a host that cannot invoke the engine in-process reaches over the IDE bridge (see below); and the duplicate-folder consolidation's rebuild case, which archives a pile of folders and then drives the copy into a recreated one.
- The pre-migration archive step performed before the copy on the paths that carry one — the shared rebuild routine, the JVM host's own re-implementation of it, and the duplicate-folder consolidation's rebuild case: collecting every existing folder for this repository, moving all of them into the hidden archive directory under the Memory Bank parent, then targeting the base folder name for the fresh copy. The archive step is **not** exclusive to the explicit action, and the paths that carry it do not agree on how the target is chosen.
- The consolidate-onto-base-folder-name rule: the explicit rebuild always migrates into the canonical base name (`<repo>`) rather than any numbered suffix, because the archive step frees the base slot and the target is then **re-resolved** against disk before the copy begins — and the two divergences from that, one implementation computing the base name directly and another re-resolving through the *claiming* resolver instead of the read-only one.
- The three-way source-presence probe that opens the explicit rebuild, its refusal wording per outcome, and why the unknown outcome exits like the empty one.
- The manual-disable refusal that precedes the entire explicit rebuild sequence.
- The boundary between the shared rebuild routine and its hosts: what the routine returns, and what each host does with it afterwards.
- What the engine copies, in what order.
- The idempotency rule: entries already present in the folder manifest (matched by commit hash) are skipped; their display title is backfilled when absent.
- The resumability contract and the progress document that tracks it.
- The two-phase visible-layer reconciliation that runs after every copy — and on every activation even when no copy is needed.
- The archive directory: its location, naming convention, and why it is hidden from sync and IDE explorers.
- Migration outcome codes, success and failure cases, and their telemetry.
- The four manual-disable gates (entry to the copy, entry to the reconciliation, the mid-run re-checks, and the progress writer's own refusal) and why a persisted outcome would be worse than no outcome.

**Out of scope:**
- The orphan-branch write path (covered by the orphan-branch summary storage spec).
- The folder layout and the file-and-folder contract of the Memory Bank (covered by spec 151).
- The folder-based storage write mechanics, manifest mutations, and branch-mapping registry (covered by the folder-based summary storage spec).
- The dual-write orchestration that routes new commits to both stores after migration (covered by the dual-write summary storage spec).
- The settings surfaces' form, button states, and message protocol around the migrate action — the desktop editor's settings webview (spec 110) and the local dashboard's settings page each own their own.
- The duplicate-folder consolidation that drives the copy on its rebuild case: how it detects a duplicate set, how it classifies one, its modal confirmation, and its copy-if-absent merge for the other cases (covered by the Memory Bank duplicate-folder consolidation spec). Only the fact that it archives and then drives this engine is recorded here.
- The host activation sequence that invokes migration as a fire-and-forget step (covered by spec 100).
- The schema migration that runs before the copy (orphan-branch v1→v3, flat-index v1→v3, expired v1 cleanup; those are separate migration steps, not the copy engine).

## Data Contracts

### Progress document

Stored inside the per-repository hidden layer at `migration.json`. The document carries:

- `status`: one of `pending`, `in_progress`, `completed`, `partial`, `failed`, `skipped`.
  - `pending` is part of the vocabulary but is never written by the engine; a document carrying it is treated exactly like an absent one by the "is migration complete?" check (anything other than `completed` runs the full copy).
  - `skipped` is a **transient return value only**, meaning "not attempted because the project is manually disabled". It is **never persisted to disk** — the writer that would persist it refuses on the same condition that produces it (see "Manual-disable gates" below).
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

### Manual-disable gates

A project whose owner has explicitly turned the product off must have nothing written into it. Because the engine's destination writes are individually suppressed at the storage layer when that is the case, an ungated engine would run to completion against a stream of silent no-ops and then record its own success — the single worst outcome, since a persisted `completed` permanently prevents the copy from being re-attempted. The engine therefore carries four gates on the same condition:

1. **Entry to the full migration.** Returns immediately with the `skipped` status and zero total and migrated counts, before reading the source index. Nothing is written, including the progress document.
2. **Entry to the visible-layer reconciliation.** Returns the same `skipped` status and zero counts, plus a zero changed-file count, before reading the progress document. Neither phase runs.
3. **Mid-run re-checks.** The condition is re-read between every entry of the per-root pass, and again before the bulk passes begin. This exists because the disable gesture can land while a first-install copy is still in flight, minutes into the run: the destination writes issued after that moment are silently dropped, so continuing would count silently-dropped writes as migrated entries. The run instead aborts and returns `skipped` with the entries migrated *before* the gesture — an honest partial count, and one that is not persisted.
4. **The progress writer itself.** Every write of the progress document goes through one internal writer that refuses outright on the same condition. This is the backstop that makes gate 3 safe: without it, an abort would still be racing whatever progress write was already queued, and a false `completed` landing on disk would permanently block re-migration. The reconciliation's final merged stamp was re-routed through this same gated writer for exactly that reason — it must not record a phase-1 completion stamp for regeneration work whose writes were dropped.

The explicit rebuild sequence carries a **fifth** refusal that is not one of these four and does not read the same thing: it sits ahead of the entire sequence and reads the **durable** repo-wide opt-out off disk, precisely so it also protects the host that has no in-memory mirror to consult. It is a refusal rather than a suppression because a partially-suppressed rebuild would de-identify the previous folder while migrating nothing.

All four gates inside the engine read the same process-local in-memory manual-disable gate. That gate is set only by the editor host, so it is inert in any separate process that runs the engine, and the engine consults the durable on-disk opt-out nowhere. Consequently the out-of-process path carries **no** manual-disable protection of its own — whether an opted-out project is protected there is entirely up to whatever drives the bridge. Cross-reference: spec 145 for the gate's lifecycle and scope limit, and spec 304 for the destination-write suppression that makes these gates necessary.

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

The auto-migration does not archive any existing folder before running. Three other paths do: the shared explicit rebuild below, the JVM host's own re-implementation of it, and the duplicate-folder consolidation's rebuild case (boundary).

### Invocation from the Memory Bank sync command

The manual "sync my Memory Bank" command runs the activation-shaped step itself, before it builds the sync engine, so the first push carries real folder content rather than an empty tree. It claims the folder for the repository, resolves the system of record by routing state, and stops there if that source does not exist. Otherwise it branches on the recorded migration state exactly as the activation path does: not complete → the full copy; complete → the visible-layer reconciliation only. It archives nothing, and a throw out of the whole step is logged and swallowed so a failed migration does not cost the user the sync.

The consequence worth naming is that the recurring visible-layer reconciliation runs on **every** sync, not only on activation — which is how the ongoing stale-child sweep reaches a user who drives the product from the command line and never opens an editor host.

### Explicit "Migrate to Memory Bank" rebuild

**One shared routine, two hosts.** The sequence below lives in shared core precisely so the desktop editor's command and the local dashboard's settings action drive identical steps; before it was extracted, only the editor had it and a second host could only re-implement it and drift. The routine returns a structured outcome and nothing else — cache invalidation and any user-interface refresh are explicitly the host's job, and the two hosts do different things with it (see "Host-side follow-up" below).

Triggered by the user from either host's Memory Bank settings surface.

1. **Manual-disable refusal, ahead of everything.** If the repository carries the durable repo-wide opt-out, return a failure telling the user the product is disabled for this project and to enable it first. Nothing is read, nothing is resolved, nothing is archived. The refusal is positioned first because the identity write further down is suppressed at the storage layer while the folder creation and the re-point are not — so a partially-suppressed run would de-identify the previous folder while migrating nothing.
2. Resolve the repository's name and remote, load the configuration to find the Memory Bank parent, and resolve the **system of record by routing state** rather than assuming the version-controlled store.
3. **Three-way source-presence probe.** Ask whether that system of record holds at least one stored memory. The answer is one of *some*, *none*, or *unknown*:
   - *some* — continue.
   - *none* — return a failure reading "no stored memories found — nothing to rebuild".
   - *unknown* (the backend could not be read) — return a failure reading "could not read stored memories — leaving the Memory Bank untouched".

   The unknown outcome exits by the same door as the empty one, and that is the whole point of the probe being three-valued rather than a plain existence test. The existence question and the has-any-memories question used to coincide — on the version-controlled store, the store existing *was* the data existing, because nothing created it except writing a memory into it. Past a storage cutover that is no longer true: the database reports itself initialized for every enabled repository, memories or not. Since this path archives the user's existing folders *before* re-copying, a false "initialized" would have archived the lot and migrated nothing, and collapsing a read failure into "none" would reach that same destructive branch for a different reason.
4. Enumerate every existing folder under the Memory Bank parent whose stored identity matches this repository (base name and all numbered suffixes, up to the ladder's cap). These are the folders to archive.
5. For each enumerated folder, move it into the archive directory. The move is a filesystem rename: the entire directory tree moves atomically. If the move fails, log a warning and continue — a stale visible folder is a lesser evil than aborting the rebuild.
6. After archiving the pile, **resolve the target path against disk** using the read-only peek resolver. Because step 5 freed the base slot (all same-identity folders were moved), the peek resolver returns the canonical base name. If some folder survived archiving — a move failure, or a folder at the base name belonging to a *different* repository that shares the basename — the peek resolver falls back to the next unused numbered suffix.
7. Initialize the target folder with the repository's identity.
8. Run the copy (see Copy sequence below).
9. Return a success carrying the migrated count and the target path on a `completed` status, or a failure carrying the status, the migrated-over-total counts and the target path on any other. The target path is reported **only** when a copy actually ran — never on the two source-presence early-outs, and never on the manual-disable refusal.

The routine has **no exception handling of its own**: an unhandled exception anywhere in steps 2–8 propagates to whichever host called it, and the two hosts convert it differently (below). So "a failure carrying the error's message" is a host-level outcome, not something this routine can produce.

The "consolidate onto base folder name" rule is a consequence of steps 4–6 taken **in that order**: archiving all same-identity folders before resolving the target means the base slot is free when the resolver runs, so migration lands on the base name rather than on a numbered suffix. Prior to this, each re-run allocated an incrementing suffix because the earlier folder still held the same identity. The re-resolution in step 6 is what makes the rule safe rather than merely usual — it is the step that declines the base name when something the archive pass did not touch still occupies it.

### Host-side follow-up (not part of the shared routine)

The routine performs no cache invalidation and signals no user interface. Each host does its own, and the two differ:

- **The desktop editor** refreshes only when a target path came back — i.e. only when a copy actually ran, never on the two source-presence early-outs. It then re-resolves its sidebar's Memory Bank root, refreshes the folder listing and the repository listing, invalidates the in-process read cache, and refreshes the Memories panel if it has been loaded. The rebuilt folder usually keeps the same path, so a "did the folder move?" check would report no change; the refresh is issued unconditionally on that branch instead, so the tree picks up the rebuilt contents and the multi-repository aggregate drops entries discovered against the now-archived identities. It also wraps the call, so **this** is the host that turns a propagated exception into a failure carrying that exception's own message — and it carries a manual-disable refusal of its own ahead of the call, reading the in-memory gate rather than the durable flag the routine reads.
- **The local dashboard** invalidates one memoised query result instead: the launch repository's state, which is keyed on the launch directory plus the configured Memory Bank parent and is therefore stale after a rebuild that re-pointed the folder without changing the configured parent. It drops that cache unconditionally on every returned outcome — including the two early-outs, where it is harmless because nothing changed — but **not** when the call threw, because the invalidation sits inside the same guarded block as the call. It then reports a success outcome as such and a failure outcome with the routine's message in the error position, so the client renders the reason rather than a bare request-failed status. A **propagated exception** takes a different door: it becomes a fixed server-error response with a generic "could not migrate the Memory Bank" message, so the routine's own reason never reaches this client — and that is the same guarded block whose cache invalidation was skipped.

### The third surface exposing the same action re-implements the sequence

The explicit action is offered by **three** surfaces, not two: the desktop editor and the local dashboard drive the shared routine, and the JVM IDE's settings dialog carries its own copy of the sequence. It is not a thin wrapper — it repeats the whole shape, and diverges from the shared routine as follows:

- It gates on a plain **existence** check of the backend the bridge serves it — the routed one, not the system of record — rather than the three-way presence probe, and reports "nothing to migrate" on absence. So the false-initialized case the probe exists to prevent is live here: past a storage cutover that backend is the database, whose existence answer is "it opened", which is true for every enabled repository whether or not it holds a memory. The archive pass then runs before the copy finds nothing.
- It holds its own migration mutex for the whole sequence, so it serialises against the background migrations that would otherwise race the progress document.
- It enumerates the same-identity folders and archives them itself, then resolves the freed slot through the **claiming** resolver rather than the read-only peek one — which writes identity into whatever it lands on as a side effect of asking. The peek resolver is not reachable from this host at all: the bridge exposes no operation for it.
- It then initializes the resolved folder and drives the copy **out of process**, through the shared migration caller (which resolves the destination independently from the same configuration), rather than constructing the engine in-process.

Its refusals are user-facing dialogs rather than a returned outcome, and it carries no manual-disable refusal of its own on this path.

### Out-of-process invocation (the shared migration caller)

A separate entry point exists for hosts that cannot invoke the engine in-process (a JVM-based IDE plugin). It is **one shared routine**, and it is the *only* out-of-process entry: the host reaches it through the IDE bridge's migration action rather than through a command of its own (the hidden command that used to wrap it was deleted — see 293). Its own steps, in order:

1. Load the resolved configuration and derive the Memory Bank destination for this repository from the user's configured local folder plus the repository's identity (its canonical name and remote).
2. **Resolve the system of record by the repository's routing state**, rather than assuming the version-controlled orphan store. This is load-bearing rather than tidy: past a storage cutover that store is frozen, and a clone made after one has no such store at all — a hard-coded source reported "nothing to migrate" and produced an empty Memory Bank.
3. **Source-data check.** If the resolved system of record does not exist, return an empty completed result (`completed`, zero total, zero migrated) **without creating any folder structure** and without constructing the engine. Nothing to migrate is a success, not an error.
4. Otherwise create the destination folder structure if absent and construct the engine over the resolved source and that destination.
5. **Three-way branch on the recorded migration state:**
   - Progress document **absent, or `status` anything other than `completed`** (fresh install, a previous partial run, a user who wiped the Memory Bank folder) → run the **full copy**, and report its returned status and counts.
   - **`status` is `completed`** → run the **visible-layer reconciliation** only, and report the status and counts it returns. Those counts come off the existing progress document; they are not a fresh count of anything this invocation copied, so a steady-state caller rendering "N of M migrated" is echoing the original run's totals.

It performs **no** archive step of its own, requires no product sign-in — the local folder migration is on by default and must run for a user who never connected a Space — and reports the resulting `status`, `totalEntries`, and `migratedEntries` back to its caller. It never writes to the source; the source is read-only to it.

### Invocation from the duplicate-folder consolidation's rebuild case

One more caller drives the copy: the folder-tree Refresh's duplicate-folder consolidation, on the one classification where the system of record already holds every memory that every duplicate folder holds. It re-implements the archive-then-rebuild shape rather than calling the explicit rebuild routine, and it does so with one step of that shape missing.

What it does, in order: resolve the system of record by routing state; if it does not exist, abandon the rebuild and fall back to a lossless folder merge instead (boundary); otherwise archive **every** folder for the repository including the base-named one; write the repository's identity into the base-named path; ensure that folder's hidden layer; then construct this engine over the resolved source and that destination and run the full copy.

What it omits is step 6 above: **the target is the base-named path computed directly, not re-resolved against disk after archiving.** The consequences of that omission, and everything else about how the consolidation decides to take this path, belong to its own spec; the divergence is recorded here because this routine is the thing being duplicated.

It also carries no manual-disable refusal of its own. Reached in that state it archives every folder, the identity write is suppressed at the storage layer, and this engine's entry gate returns its transient `skipped` outcome — so nothing is rebuilt and the copy reports zero.

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
| `skipped` | **Never written.** Returned by the entry gate, by a mid-run abort, and by the reconciliation's entry gate when the project is manually disabled. The writer that would persist it refuses on the same condition, so this status exists only in the value handed back to the caller and never appears in the document on disk. |
| `pending` | **Never written by the engine.** Part of the vocabulary only; a document carrying it is treated as not-yet-complete, exactly like an absent document. |

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
- **The explicit rebuild always consolidates onto the base folder name, and the post-archive re-resolution is what makes that safe.** Before migrating, it archives every folder for this repository, freeing the base slot; the peek resolver then runs *against disk* and returns the base name rather than a numbered suffix. Previous behavior (where each re-run allocated an incrementing suffix) was a bug fixed by archiving up front. (Notable; the correct behavior depends on the archive-before-resolve ordering.)
- **Three surfaces expose the explicit action; only two share the routine.** The desktop editor and the local dashboard drive the shared sequence, while the JVM IDE's settings dialog carries a full second copy of it — existence check instead of the three-way probe, its own archive pass, the *claiming* resolver instead of the read-only peek one, then an out-of-process copy. The read-only resolver it would need is not exposed over the bridge at all, so the divergence is not a choice the host could simply reverse. (Surprising; the extraction that removed one re-implementation did not remove this one.)
- **The same rule is re-implemented elsewhere without the re-resolution, and that changes what it does.** The duplicate-folder consolidation's rebuild case archives the pile and then takes the base-named path *directly* instead of asking the resolver what is free. Where the two agree — the archive pass moved everything that occupied the base name — the outcomes are identical. Where they do not, they diverge sharply: a base name held by a **different** repository that happens to share the basename is untouched by an archive pass scoped to this repository's identity, so the resolver would decline it and return a suffix, while the direct computation overwrites that other repository's recorded identity and migrates this repository's memories into its folder. That basename collision is the very reason this repository was carrying a suffix in the first place, so it is the expected shape rather than an exotic one. (Surprising; the safety of this rule lives in a step the second implementation does not have.)
- **The explicit rebuild is one routine with two hosts, and the hosts' follow-up is not symmetric.** The routine deliberately returns only an outcome; the editor refreshes its sidebar and caches when a target path came back, while the dashboard drops one memoised query result on every returned outcome — and drops nothing when the call threw, because the invalidation sits inside the same guarded block as the call. A thrown rebuild therefore leaves the dashboard serving a stale launch-repository state until something else invalidates it. (Notable.)
- **The routine cannot report an exception, so what the user reads on a crash depends entirely on the host.** It has no exception handling at all. The editor's wrapper converts a propagated exception into a failure carrying that exception's own message; the dashboard converts it into a fixed server error with a generic "could not migrate" message, discarding the reason. Reading the routine's own contract as "it returns a failure carrying the error message" attributes an outcome to the wrong layer, and predicts the wrong text on one of the two hosts. (Notable.)
- **The rebuild's source check is a three-valued probe, not an existence test, and the unknown case exits like the empty one.** "Is the backend initialized?" and "does it hold any memories?" used to be the same question on the version-controlled store and are not after a storage cutover, where the database reports itself initialized for every enabled repository. Because this path archives the user's folders before re-copying, an existence test would have archived everything and migrated nothing on a cut-over repository with no memories — and folding a read failure into "none" reaches that same destructive branch for a different reason. (Notable; the third state is the whole safety property.)
- **Archiving uses a filesystem move, not an identity rewrite.** An earlier approach rewrote the `config.json` inside the folder to a different identity, leaving the folder visible to both the IDE explorer and the sync vault (which continued to track and upload its contents). The current approach moves the entire directory into a hidden directory that the sync classifier rejects, causing the next sync round to deindex it. (Notable; the old behavior caused 138 files to continue syncing under a "supposedly archived" folder.)
- **The archive directory is hidden but co-located with the Memory Bank.** Placing archives under a dot-prefixed subdirectory inside the Memory Bank parent (rather than outside it) means archives travel with a relocated `localFolder` configuration and remain on the same filesystem for atomic renames. (Notable.)
- **Archive failures are non-fatal.** If a folder cannot be moved (e.g., a file is locked), the engine logs a warning and continues. The migration then lands on a numbered suffix rather than the base name. (Notable; the alternative — aborting the rebuild — was judged worse than a slightly non-canonical folder name.)
- **Phase 1 of the visible-layer reconciliation is permanently gated after one clean run.** A missing head Markdown file after the gate is set is treated as a different concern (handled by a separate heal-missing path in the folder storage), not a reason to re-run the one-shot repair. (Notable; intentional separation.)
- **Phase 2 of the reconciliation runs on every activation regardless of the gate.** The "delete stale child Markdown" sweep is an ongoing invariant enforcement, not a one-shot fix. Children hoisted on dormant branches are never swept by the per-commit queue worker, so this is the only path that guarantees they are eventually removed. (Notable; intentional.)
- **A partial copy does not block activation on the next startup.** If `status` is `partial`, the auto-migration condition (`status !== "completed"`) triggers a re-run. The per-root pass skips already-migrated entries via the manifest check, so only the failed hashes need to be retried. (Notable; same mechanism as full resumability.)
- **The `swept` count drives the sidebar-refresh decision, not a boolean "did anything run."** A no-op reconcile (steady state) reports `swept = 0` and the sidebar is not refreshed. Only actual file mutations (deletions or regenerations) cause a refresh, which prevents the user's expanded folder tree from collapsing on every activation. (Notable; intentional.)
- **A disable asserted mid-migration abandons the run without recording any progress.** The per-entry and pre-bulk re-checks stop the copy at the next boundary and report the entries migrated before the gesture, but the progress writer refuses that report, so nothing lands on disk. The next activation after a re-enable therefore sees the state it saw before — absent, or the prior status — and re-runs the full copy, which the manifest-based idempotency check makes cheap for entries that did survive. The alternative (persisting the abort) would have recorded silently-dropped writes as completed work and permanently blocked the re-copy. (Surprising; the ordering of the abort and the write-refusal is what makes it safe.)
- **The four manual-disable gates protect only the in-process invocation paths.** They all read a process-local in-memory signal that the editor host sets; the engine never reads the durable on-disk opt-out. So an out-of-process invocation of the engine is entirely ungated at this layer. Whether that matters depends on the driving host applying its own check — nothing in the engine enforces it. (Surprising; a real gap in the layering, documented as-is.)
- **The out-of-process caller resolves its source by routing state, and that is why it survives a storage cutover.** It asks which backend actually holds the truth for this repository rather than naming the version-controlled store, so a frozen or relocated store still migrates. Feeding it the *read* backend instead would be worse than wrong in the ordinary case: before a cutover the read surface is the Memory Bank folder itself, which would turn the run into a copy of the destination onto itself. (Notable; the distinction between "where do I read" and "what is the truth" is load-bearing here.)
- **"No system of record" short-circuits before any folder is created.** The out-of-process path returns its empty completed result without constructing the destination structure, which is what makes an unconditional call safe on a brand-new repository. (Notable.)
- **`skipped` is the one status that is a return value and not a state.** Every other status is both. A caller that renders "status: skipped" is reading something no invocation will ever find in the progress document, including its own next invocation. (Notable; a real source of confusion when reading a status line.)
- **The legacy `leafCleanup.completedAt` field is preserved but never consulted.** Installs that ran the 0.99.2 inverted-pass version wrote this field. Current code carries it through all progress-document round-trips so the JSON does not lose fields, but the field has no effect on phase 1 gating — those installs must still run phase 1 to recover from the inverted deletion. (Notable; preserving the field is for round-trip fidelity only.)

## Shared Behavior

- **Orphan-branch store** — the source-of-truth read surface for the copy. Defined by the orphan-branch summary storage spec.
- **Folder-based storage** — the write surface for the copy. Its manifest is the idempotency check for per-root entries. Its branch-directory mechanics govern where visible Markdown lands. Defined by the folder-based summary storage spec.
- **Memory Bank folder layout** — the per-repository hidden layer, visible layer, and path naming conventions the engine writes into. Defined by spec 151.
- **The two settings surfaces** — the desktop editor's settings webview (spec 110) and the local dashboard's settings page — each own their own button state and feedback text for the explicit "Migrate to Memory Bank" action. Both delegate to the one shared rebuild routine and both consume its structured outcome; neither owns the sequence. The follow-up each performs is recorded here because it is deliberately outside the routine's contract.
- **The duplicate-folder consolidation** — owns its detection, its classification, its modal confirmation, its copy-if-absent merge, and the consequences of computing its rebuild target without re-resolving the freed slot. This spec owns only the archive-then-rebuild shape it duplicates and the fact that it drives this engine on that one case.
- **Host activation sequence** — invokes auto-migration as a fire-and-forget step. Defined by spec 100.
- **The IDE bridge** — the transport the out-of-process caller arrives over: it owns the action dispatch, the response envelope, the error shape, and the daemon-first / one-shot-fallback resolution. This spec owns only what the caller does once dispatched. The retired command that used to wrap it is recorded in 293.
- **Storage routing** — decides which backend is this repository's system of record, and therefore what the out-of-process caller migrates *from*. Owned by spec 344. The freeze that makes a previously-authoritative store unwritable — the condition step 2 exists to survive — is owned by spec 345.
- **Telemetry** — the engine emits one event at the end of each copy run. The event schema is defined in the telemetry event catalog.
- **The manual-disable state** the four gates read, and the destination-write suppression that makes them necessary, are owned by spec 145 and spec 304. This spec owns only the gates' placement and their effect on the outcome vocabulary.
